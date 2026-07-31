import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  Coordinates,
  RoutePlan,
  RoutingJob,
  WeatherForecast,
} from '../../../src/core/integrations/contracts.ts';
import { resolveLiveProviderActivation } from '../../../src/core/integrations/configuration.ts';
import { createServerIntegrationSuite } from '../../../src/core/integrations/liveServer.ts';
import { consumeOperationBudget } from '../../../src/core/integrations/operationBudget.ts';
import {
  assertDispatchCurrentOriginFresh,
  type DispatchCurrentOrigin,
} from '../../../src/core/scheduling/dispatchOrigin.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import { assertProviderInvocation } from '../_shared/provider-authorization.ts';
import {
  dispatchCanonicalSha256,
  dispatchClearanceEvidenceSchema,
  dispatchClearanceReceiptSchema,
  dispatchClearanceRequestSchema,
  dispatchClearanceResponseSchema,
  dispatchReceiptMatchesRequest,
  dispatchRouteRequestSchema,
  dispatchRouteResponseSchema,
  dispatchRoutingJobId,
  evaluateDispatchRoute,
  evaluateDispatchWeather,
  resolveDispatchClearanceMode,
  type DispatchClearanceRequest,
  type DispatchClearanceResponse,
} from './contracts.ts';

type Row = Record<string, unknown>;

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new HttpError(`Server configuration ${name} is missing.`, 503, 'MISCONFIGURED');
  }
  return value;
}

function record(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(`${label} is unavailable.`, 503, 'AUTHORITATIVE_DATA_INVALID');
  }
  return value as Row;
}

function nullableRecord(value: unknown, label: string): Row | undefined {
  return value === null || value === undefined ? undefined : record(value, label);
}

function textValue(row: Row, key: string, label = key): string {
  const value = row[key];
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  throw new HttpError(`${label} is missing.`, 503, 'AUTHORITATIVE_DATA_INVALID');
}

function numberValue(row: Row, key: string, label = key): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) {
    throw new HttpError(`${label} is invalid.`, 503, 'AUTHORITATIVE_DATA_INVALID');
  }
  return value;
}

function reviewedCoordinates(property: Row): Coordinates {
  const latitude = numberValue(property, 'latitude', 'Property latitude');
  const longitude = numberValue(property, 'longitude', 'Property longitude');
  const confidence = numberValue(property, 'geocode_confidence', 'Geocode confidence');
  const geocodedAt = textValue(property, 'geocoded_at', 'Geocode review timestamp');
  if (
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    confidence < 0.8 ||
    !Number.isFinite(Date.parse(geocodedAt))
  ) {
    throw new HttpError(
      'Reviewed high-confidence property coordinates are required.',
      422,
      'COORDINATES_NOT_REVIEWED',
    );
  }
  return { latitude, longitude };
}

function verifiedCurrentOrigin(input: DispatchClearanceRequest, now: Date): DispatchCurrentOrigin {
  const expectedIdempotencyKey = `dispatch:${input.visitId}:v${input.expectedVisitVersion}:origin:${input.currentOrigin.readingId}`;
  if (input.idempotencyKey !== expectedIdempotencyKey) {
    throw new HttpError(
      'The dispatch idempotency key is not bound to this exact departure reading.',
      409,
      'CURRENT_ORIGIN_IDEMPOTENCY_CONFLICT',
    );
  }
  try {
    return assertDispatchCurrentOriginFresh(input.currentOrigin, now.getTime());
  } catch {
    throw new HttpError(
      'Share a device location observed within two minutes and accurate to 100 meters before departure.',
      422,
      'CURRENT_ORIGIN_STALE_OR_INACCURATE',
    );
  }
}

function blocked(
  input: DispatchClearanceRequest,
  mode: DispatchClearanceResponse['mode'],
  reasonCode: string,
  message: string,
): DispatchClearanceResponse {
  return dispatchClearanceResponseSchema.parse({
    operation: 'visit.dispatch_clearance.refresh',
    mode,
    status: 'blocked',
    cleared: false,
    reasonCode,
    message,
    companyId: input.companyId,
    visitId: input.visitId,
    visitVersion: input.expectedVisitVersion,
  });
}

async function authenticate(client: SupabaseClient, authorization: string | null): Promise<string> {
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
  }
  const {
    data: { user },
    error,
  } = await client.auth.getUser(authorization.slice('Bearer '.length));
  if (error || !user) {
    throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
  }
  return user.id;
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function validateSnapshot(input: DispatchClearanceRequest, snapshot: Row, now: Date) {
  const company = record(snapshot.company, 'Company');
  const visit = record(snapshot.visit, 'Visit');
  const job = record(snapshot.job, 'Job');
  const property = record(snapshot.property, 'Property');
  const crew = record(snapshot.crew, 'Crew');
  const configuration = nullableRecord(snapshot.configuration, 'Company configuration');
  const baseline = nullableRecord(snapshot.baseline, 'Operating baseline');
  const schedulingReceipt = nullableRecord(
    snapshot.scheduling_receipt,
    'Scheduling evidence receipt',
  );
  const schedulingRoute = nullableRecord(snapshot.scheduling_route, 'Scheduling route');

  if (
    company.status !== 'active' ||
    snapshot.launch_authorized !== true ||
    textValue(company, 'id') !== input.companyId ||
    textValue(visit, 'id') !== input.visitId ||
    numberValue(visit, 'version') !== input.expectedVisitVersion ||
    visit.status !== 'confirmed'
  ) {
    throw new HttpError(
      'The visit is no longer confirmed at the requested version.',
      409,
      'VISIT_STATUS_OR_VERSION_CONFLICT',
    );
  }
  if (
    textValue(visit, 'company_id') !== input.companyId ||
    textValue(job, 'company_id') !== input.companyId ||
    textValue(property, 'company_id') !== input.companyId ||
    textValue(crew, 'company_id') !== input.companyId ||
    textValue(visit, 'job_id') !== textValue(job, 'id') ||
    textValue(job, 'property_id') !== textValue(property, 'id') ||
    textValue(visit, 'crew_id') !== textValue(crew, 'id') ||
    job.assigned_crew_id !== visit.crew_id
  ) {
    throw new HttpError(
      'Visit, job, property, and crew relationships do not match.',
      409,
      'DISPATCH_SCOPE_CONFLICT',
    );
  }
  if (
    !configuration ||
    configuration.status !== 'published' ||
    configuration.publication_mode !== 'live' ||
    !baseline ||
    baseline.status !== 'active' ||
    numberValue(baseline, 'configuration_revision') !== numberValue(configuration, 'revision') ||
    textValue(baseline, 'configuration_hash') !== textValue(configuration, 'configuration_hash')
  ) {
    throw new HttpError(
      'One current live configuration and matching active operating baseline are required.',
      409,
      'CURRENT_OPERATING_BASELINE_REQUIRED',
    );
  }
  if (
    !schedulingReceipt ||
    !schedulingRoute ||
    schedulingReceipt.evidence_mode !== 'live' ||
    schedulingReceipt.route_disposition !== 'eligible' ||
    schedulingReceipt.weather_disposition !== 'eligible' ||
    textValue(schedulingReceipt, 'id') !== textValue(visit, 'scheduling_evidence_receipt_id') ||
    textValue(schedulingReceipt, 'job_id') !== textValue(job, 'id') ||
    textValue(schedulingReceipt, 'property_id') !== textValue(property, 'id') ||
    textValue(schedulingReceipt, 'crew_id') !== textValue(crew, 'id') ||
    !sameInstant(textValue(schedulingReceipt, 'starts_at'), textValue(visit, 'starts_at')) ||
    !sameInstant(textValue(schedulingReceipt, 'ends_at'), textValue(visit, 'ends_at'))
  ) {
    throw new HttpError(
      'The confirmed visit lacks an exact immutable live booking route.',
      409,
      'LIVE_BOOKING_EVIDENCE_REQUIRED',
    );
  }

  const startsAt = new Date(textValue(visit, 'starts_at')).toISOString();
  const endsAt = new Date(textValue(visit, 'ends_at')).toISOString();
  if (
    !Number.isFinite(Date.parse(startsAt)) ||
    !Number.isFinite(Date.parse(endsAt)) ||
    Date.parse(endsAt) <= Date.parse(startsAt)
  ) {
    throw new HttpError('The visit window is invalid.', 409, 'VISIT_WINDOW_INVALID');
  }
  if (now.getTime() < Date.parse(startsAt) - 4 * 60 * 60_000) {
    throw new HttpError(
      'Dispatch clearance opens four hours before the confirmed visit.',
      422,
      'DISPATCH_CLEARANCE_TOO_EARLY',
    );
  }
  if (now.getTime() >= Date.parse(startsAt)) {
    throw new HttpError(
      'The confirmed arrival deadline has passed; dispatch must review and reschedule the visit.',
      409,
      'VISIT_ARRIVAL_DEADLINE_PASSED',
    );
  }

  const settings = record(company.settings, 'Company settings');
  const configurationPayload = record(configuration.configuration, 'Company configuration');
  const policies = record(configurationPayload.policies, 'Configuration policies');
  const safetyReview = record(policies.safetyReview, 'Safety review');
  if (safetyReview.status !== 'approved') {
    throw new HttpError(
      'The live safety review is not approved.',
      409,
      'SAFETY_REVIEW_NOT_APPROVED',
    );
  }

  return {
    company,
    visit,
    job,
    property,
    crew,
    configuration,
    baseline,
    schedulingReceipt,
    schedulingRoute,
    startsAt,
    endsAt,
    propertyCoordinates: reviewedCoordinates(property),
    currentOrigin: verifiedCurrentOrigin(input, now),
    weatherPolicy: settings.weatherPolicy,
    weatherPolicyEnvelope: {
      ...record(settings.weatherPolicy, 'Company weather policy'),
      reviewReference: textValue(safetyReview, 'evidenceReference'),
      reviewedAt: textValue(safetyReview, 'reviewedAt'),
      configurationRevision: numberValue(configuration, 'revision'),
    },
    providerSnapshotHash: textValue(snapshot, 'provider_snapshot_hash', 'Provider snapshot hash'),
  };
}

function safeProviderMessage(error: unknown): string {
  return error instanceof HttpError
    ? error.message
    : 'A live dispatch provider did not return complete authoritative evidence.';
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }

  try {
    const rawBody = await readTextBody(request, 8_192);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = dispatchClearanceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        'Request must contain only company, exact visit version, current consented departure origin, idempotency, and optional trace facts.',
        400,
        'INVALID_REQUEST',
      );
    }
    const input = parsed.data;
    const environment = Deno.env.toObject();
    const mode = resolveDispatchClearanceMode(environment);
    if (mode !== 'live') {
      return jsonResponse(
        blocked(
          input,
          mode,
          'LIVE_DISPATCH_CLEARANCE_DISABLED',
          'Dispatch clearance is not live-enabled. Sandbox or disabled evidence can never authorize departure.',
        ),
      );
    }
    const nwsActivation = resolveLiveProviderActivation(
      environment,
      'NWS_LIVE_ENABLED',
      'WEATHER_MODE',
    );
    const vroomActivation = resolveLiveProviderActivation(
      environment,
      'VROOM_LIVE_ENABLED',
      'ROUTING_MODE',
    );
    if (!nwsActivation.enabled || !vroomActivation.enabled) {
      return jsonResponse(
        blocked(
          input,
          'live',
          'LIVE_DISPATCH_PROVIDERS_DISABLED',
          'NWS and VROOM each require independent live mode and enable switches.',
        ),
        503,
      );
    }

    const serviceClient = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const actorUserId = await authenticate(serviceClient, request.headers.get('authorization'));
    await Promise.all([
      assertProviderInvocation(serviceClient, {
        companyId: input.companyId,
        provider: 'nws',
        capability: 'weather',
        operationClass: 'launch_start',
      }),
      assertProviderInvocation(serviceClient, {
        companyId: input.companyId,
        provider: 'vroom',
        capability: 'routing',
        operationClass: 'launch_start',
      }),
    ]);

    const requestHash = await dispatchCanonicalSha256({
      actorUserId,
      companyId: input.companyId,
      currentOrigin: input.currentOrigin,
      expectedVisitVersion: input.expectedVisitVersion,
      idempotencyKey: input.idempotencyKey,
      schemaVersion: 'storyops-dispatch-clearance-request-v2',
      visitId: input.visitId,
    });
    const { data: snapshotData, error: snapshotError } = await serviceClient.rpc(
      'load_storyops_dispatch_clearance_candidate',
      {
        p_company_id: input.companyId,
        p_actor_user_id: actorUserId,
        p_visit_id: input.visitId,
        p_expected_visit_version: input.expectedVisitVersion,
        p_idempotency_key: input.idempotencyKey,
      },
    );
    if (snapshotError) {
      throw new HttpError(
        'The exact dispatch candidate could not be verified.',
        409,
        'DISPATCH_CANDIDATE_UNAVAILABLE',
      );
    }
    const snapshot = record(snapshotData, 'Dispatch candidate');
    const existingReceipt = nullableRecord(snapshot.existing_receipt, 'Existing clearance receipt');
    if (existingReceipt) {
      const existingExpiresAt = textValue(
        existingReceipt,
        'expiresAt',
        'Existing clearance expiry',
      );
      if (Date.parse(existingExpiresAt) <= Date.now()) {
        return jsonResponse(
          blocked(
            input,
            'live',
            'DISPATCH_CLEARANCE_EXPIRED',
            'The prior dispatch clearance expired. Retry with a new bounded idempotency key.',
          ),
          409,
        );
      }
      const { data: replayData, error: replayError } = await serviceClient.rpc(
        'replay_storyops_dispatch_clearance',
        {
          p_company_id: input.companyId,
          p_actor_user_id: actorUserId,
          p_visit_id: input.visitId,
          p_expected_visit_version: input.expectedVisitVersion,
          p_idempotency_key: input.idempotencyKey,
          p_request_hash: requestHash,
          p_current_origin: input.currentOrigin,
        },
      );
      if (replayError) {
        throw new HttpError(
          'The idempotency key belongs to another dispatch request.',
          409,
          'IDEMPOTENCY_CONFLICT',
        );
      }
      const receipt = dispatchClearanceReceiptSchema.parse(replayData);
      if (
        !dispatchReceiptMatchesRequest({
          receipt,
          companyId: input.companyId,
          visitId: input.visitId,
          visitVersion: input.expectedVisitVersion,
          currentOrigin: input.currentOrigin,
        })
      ) {
        throw new HttpError(
          'The replayed dispatch receipt did not match the exact request.',
          503,
          'DISPATCH_CLEARANCE_RECEIPT_INVALID',
        );
      }
      return jsonResponse(
        dispatchClearanceResponseSchema.parse({
          operation: 'visit.dispatch_clearance.refresh',
          mode: 'live',
          status: 'cleared',
          cleared: true,
          reasonCode: 'LIVE_DISPATCH_CLEARANCE_READY',
          message: 'The existing immutable dispatch clearance is still fresh.',
          companyId: input.companyId,
          visitId: input.visitId,
          visitVersion: input.expectedVisitVersion,
          receipt,
        }),
      );
    }

    const now = new Date();
    const candidate = validateSnapshot(input, snapshot, now);
    const budget = await consumeOperationBudget({
      client: serviceClient,
      companyId: input.companyId,
      scope: 'dispatch-clearance:user:hour',
      subject: actorUserId,
      limit: 30,
      windowSeconds: 3_600,
    });
    if (!budget.allowed) {
      throw new HttpError(
        `Dispatch clearance refresh limit reached; retry after ${budget.reset_at}.`,
        429,
        'RATE_LIMITED',
      );
    }

    let suite: ReturnType<typeof createServerIntegrationSuite>;
    try {
      suite = createServerIntegrationSuite(environment);
    } catch {
      return jsonResponse(
        blocked(
          input,
          'live',
          'LIVE_DISPATCH_PROVIDERS_NOT_CONFIGURED',
          'NWS or VROOM is missing required live server configuration.',
        ),
        503,
      );
    }
    if (suite.weather.mode !== 'live' || suite.routing.mode !== 'live') {
      return jsonResponse(
        blocked(
          input,
          'live',
          'LIVE_DISPATCH_PROVIDERS_NOT_CONFIGURED',
          'The server did not construct both NWS and VROOM in live mode.',
        ),
        503,
      );
    }

    const departureAt = new Date().toISOString();
    const durationSeconds = Math.round(
      (Date.parse(candidate.endsAt) - Date.parse(candidate.startsAt)) / 1_000,
    );
    const routingJob: RoutingJob = {
      id: dispatchRoutingJobId(input.visitId),
      location: candidate.propertyCoordinates,
      serviceSeconds: durationSeconds,
      timeWindows: [{ start: candidate.startsAt, end: candidate.startsAt }],
    };
    let forecast: WeatherForecast;
    let routePlan: RoutePlan;
    try {
      [forecast, routePlan] = await Promise.all([
        suite.weather.forecast({
          coordinates: candidate.propertyCoordinates,
          window: { start: candidate.startsAt, end: candidate.endsAt },
        }),
        suite.routing.optimize({
          jobs: [routingJob],
          vehicles: [
            {
              id: textValue(candidate.crew, 'id'),
              start: candidate.currentOrigin.coordinates,
              availability: { start: departureAt, end: candidate.endsAt },
            },
          ],
          idempotencyKey: `${input.idempotencyKey}:route`,
        }),
      ]);
    } catch (error) {
      return jsonResponse(
        blocked(
          input,
          'live',
          'AUTHORITATIVE_DISPATCH_EVIDENCE_UNAVAILABLE',
          safeProviderMessage(error),
        ),
        503,
      );
    }

    const weatherResult = evaluateDispatchWeather({
      forecast,
      policy: candidate.weatherPolicy,
      window: { start: candidate.startsAt, end: candidate.endsAt },
      now: new Date(),
    });
    if (!weatherResult.eligible) {
      return jsonResponse(blocked(input, 'live', weatherResult.reasonCode, weatherResult.message));
    }
    const routeResult = evaluateDispatchRoute({
      routePlan,
      crewId: textValue(candidate.crew, 'id'),
      routingJob,
    });
    if (!routeResult.eligible) {
      return jsonResponse(blocked(input, 'live', routeResult.reasonCode, routeResult.message));
    }

    const routeObservedAt = departureAt;
    const routeExpiresAt = new Date(Date.parse(routeObservedAt) + 10 * 60_000).toISOString();
    const weatherObservedAt = new Date(forecast.observedAt).toISOString();
    const weatherExpiresAt = new Date(Date.parse(weatherObservedAt) + 20 * 60_000).toISOString();
    const weatherPolicyHash = await dispatchCanonicalSha256(candidate.weatherPolicyEnvelope);
    const weatherPolicyVersion =
      weatherResult.policy.version ?? `weather-policy-${weatherPolicyHash.slice(0, 32)}`;
    const crewId = textValue(candidate.crew, 'id');
    const currentOriginHash = await dispatchCanonicalSha256(candidate.currentOrigin);
    const routeRequestPayload = dispatchRouteRequestSchema.parse({
      schemaVersion: 'storyops-dispatch-route-request-v2',
      companyId: input.companyId,
      visitId: input.visitId,
      visitVersion: input.expectedVisitVersion,
      jobId: textValue(candidate.job, 'id'),
      jobVersion: numberValue(candidate.job, 'version'),
      propertyId: textValue(candidate.property, 'id'),
      propertyVersion: numberValue(candidate.property, 'version'),
      crewId,
      crewVersion: numberValue(candidate.crew, 'version'),
      currentOriginHash,
      origin: candidate.currentOrigin.coordinates,
      destination: candidate.propertyCoordinates,
      departureAt: routeObservedAt,
      arrivalDeadline: candidate.startsAt,
      visitWindow: { start: candidate.startsAt, end: candidate.endsAt },
      routingJobId: routingJob.id,
    });
    const routeResponsePayload = dispatchRouteResponseSchema.parse({
      provider: routePlan.provider,
      mode: routePlan.mode,
      vehicleId: routeResult.route.vehicleId,
      jobIds: routeResult.route.jobIds,
      unassignedJobIds: routePlan.unassignedJobIds,
      travelSeconds: routeResult.route.travelSeconds,
      serviceSeconds: routeResult.route.serviceSeconds,
      distanceMeters: routeResult.route.distanceMeters,
      summary: routePlan.summary,
    });
    const evidence = dispatchClearanceEvidenceSchema.parse({
      schemaVersion: 'storyops-dispatch-clearance-evidence-v2',
      evidenceMode: 'live',
      visitId: input.visitId,
      visitVersion: input.expectedVisitVersion,
      jobId: textValue(candidate.job, 'id'),
      jobVersion: numberValue(candidate.job, 'version'),
      propertyId: textValue(candidate.property, 'id'),
      propertyVersion: numberValue(candidate.property, 'version'),
      propertyGeocodedAt: new Date(textValue(candidate.property, 'geocoded_at')).toISOString(),
      crewId,
      crewVersion: numberValue(candidate.crew, 'version'),
      startsAt: candidate.startsAt,
      endsAt: candidate.endsAt,
      configurationRevision: numberValue(candidate.configuration, 'revision'),
      configurationHash: textValue(candidate.configuration, 'configuration_hash'),
      operatingBaselinePublicationId: textValue(candidate.baseline, 'id'),
      operatingBaselineHash: textValue(candidate.baseline, 'baseline_hash'),
      schedulingEvidenceReceiptId: textValue(candidate.schedulingReceipt, 'id'),
      providerSnapshotHash: candidate.providerSnapshotHash,
      currentOrigin: candidate.currentOrigin,
      route: {
        provider: 'vroom',
        disposition: 'eligible',
        observedAt: routeObservedAt,
        expiresAt: routeExpiresAt,
        routeFeasible: true,
        driveMinutes: Math.ceil(routeResult.route.travelSeconds / 60),
        distanceMiles: Number((routeResult.route.distanceMeters / 1609.344).toFixed(2)),
        violations: [],
        requestPayload: routeRequestPayload,
        responsePayload: routeResponsePayload,
      },
      weather: {
        provider: 'nws',
        disposition: 'eligible',
        observedAt: weatherObservedAt,
        expiresAt: weatherExpiresAt,
        forecastIssuedAt: new Date(forecast.issuedAt).toISOString(),
        periodStartsAt: weatherResult.evaluation.periodStartsAt,
        periodEndsAt: weatherResult.evaluation.periodEndsAt,
        temperatureF: weatherResult.evaluation.temperatureF,
        precipitationProbability: weatherResult.evaluation.precipitationProbability,
        windSpeedMph: weatherResult.evaluation.windSpeedMph,
        lightningRisk: weatherResult.evaluation.lightningRisk,
        conditionCodes: weatherResult.evaluation.conditionCodes,
        policyVersion: weatherPolicyVersion,
        policyHash: weatherPolicyHash,
        policy: candidate.weatherPolicyEnvelope,
        payload: weatherResult.evaluation.payload,
      },
      unknowns: [],
      conflicts: [],
      ...(input.traceId ? { traceId: input.traceId } : {}),
    });

    const { data: receiptData, error: receiptError } = await serviceClient.rpc(
      'record_storyops_dispatch_clearance',
      {
        p_company_id: input.companyId,
        p_actor_user_id: actorUserId,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: requestHash,
        p_evidence: evidence,
      },
    );
    if (receiptError) {
      throw new HttpError(
        'Current dispatch facts changed before the clearance could be committed.',
        409,
        'DISPATCH_CLEARANCE_COMMIT_CONFLICT',
      );
    }
    const receipt = dispatchClearanceReceiptSchema.parse(receiptData);
    if (
      !dispatchReceiptMatchesRequest({
        receipt,
        companyId: input.companyId,
        visitId: input.visitId,
        visitVersion: input.expectedVisitVersion,
        currentOrigin: candidate.currentOrigin,
      }) ||
      receipt.evidenceMode !== 'live' ||
      receipt.routeDisposition !== 'eligible' ||
      receipt.weatherDisposition !== 'eligible' ||
      receipt.unknowns.length > 0 ||
      receipt.conflicts.length > 0 ||
      Date.parse(receipt.expiresAt) <= Date.now()
    ) {
      throw new HttpError(
        'The committed dispatch receipt did not match the exact live request.',
        503,
        'DISPATCH_CLEARANCE_RECEIPT_INVALID',
      );
    }
    return jsonResponse(
      dispatchClearanceResponseSchema.parse({
        operation: 'visit.dispatch_clearance.refresh',
        mode: 'live',
        status: 'cleared',
        cleared: true,
        reasonCode: 'LIVE_DISPATCH_CLEARANCE_READY',
        message:
          'Current NWS and VROOM evidence is eligible. This exact receipt is short-lived and single-use.',
        companyId: input.companyId,
        visitId: input.visitId,
        visitVersion: input.expectedVisitVersion,
        receipt,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
});
