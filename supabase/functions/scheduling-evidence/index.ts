import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  CalendarAvailability,
  CalendarEntry,
  Coordinates,
  IntegrationSuite,
  RoutePlan,
  TimeWindow,
  WeatherForecast,
} from '../../../src/core/integrations/contracts.ts';
import { resolveLiveProviderActivation } from '../../../src/core/integrations/configuration.ts';
import { createServerIntegrationSuite } from '../../../src/core/integrations/liveServer.ts';
import { consumeOperationBudget } from '../../../src/core/integrations/operationBudget.ts';
import { sha256TextHex } from '../../../src/core/integrations/webhooks.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import { assertProviderInvocation } from '../_shared/provider-authorization.ts';
import {
  SCHEDULING_EVIDENCE_INPUT_SCHEMA_VERSION,
  calendarBookingAttemptSchema,
  capacityEvidencePayloadSchema,
  companyWeatherPolicySchema,
  evaluateWeatherForecast,
  resolveSchedulingEvidenceActivation,
  schedulingCanonicalSha256,
  schedulingEvidenceReceiptSchema,
  schedulingEvidenceRequestSchema,
  schedulingEvidenceResponseSchema,
  windowContains,
  type SchedulingEvidenceReceipt,
  type SchedulingEvidenceRequest,
  type SchedulingEvidenceResponse,
} from './contracts.ts';
import {
  MAX_COMMITTED_ROUTE_VISITS,
  candidateRoutingJobId,
  committedVisitRoutingJob,
  crewDayRouteViolations,
  exactCrewRouteViolations,
  targetRoutingJob,
  visitRoutingJobId,
  type CommittedVisitRouteContext,
} from './routeContext.ts';

type Row = Record<string, unknown>;
type MembershipRole = 'owner' | 'dispatcher';

const LIVE_PROVIDER_SWITCHES = [
  ['GOOGLE_CALENDAR_LIVE_ENABLED', 'GOOGLE_CALENDAR_MODE'],
  ['MAPS_LIVE_ENABLED', 'MAPS_MODE'],
  ['NWS_LIVE_ENABLED', 'WEATHER_MODE'],
  ['VROOM_LIVE_ENABLED', 'ROUTING_MODE'],
] as const;
const REQUIRED_CONFIGURATION_PROVIDERS = ['google_calendar', 'maps', 'nws', 'vroom'] as const;
const REVIEWED_COORDINATE_CONFIDENCE = 0.8;

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new HttpError(`Server configuration ${name} is missing.`, 503, 'MISCONFIGURED');
  }
  return value;
}

function record(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(`${label} is invalid.`, 503, 'AUTHORITATIVE_DATA_INVALID');
  }
  return value as Row;
}

function records(value: unknown, label: string): Row[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
  ) {
    throw new HttpError(`${label} is invalid.`, 503, 'AUTHORITATIVE_DATA_INVALID');
  }
  return value as Row[];
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function exactStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HttpError(`${label} is invalid.`, 503, 'AUTHORITATIVE_DATA_INVALID');
  }
  return value;
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function dateTimeParts(instant: string | Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
  }).formatToParts(typeof instant === 'string' ? new Date(instant) : instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    hour: Number(value('hour')),
    minute: Number(value('minute')),
    weekday: value('weekday').toLowerCase(),
  };
}

function localDate(parts: ReturnType<typeof dateTimeParts>): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function zonedDateTimeToIso(date: string, time: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const represented = dateTimeParts(new Date(guess), timeZone);
    const representedUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
    );
    guess += target - representedUtc;
  }
  return new Date(guess).toISOString();
}

function notBookable(
  input: SchedulingEvidenceRequest,
  mode: SchedulingEvidenceResponse['mode'],
  reasonCode: string,
  message: string,
  crewId?: string,
): SchedulingEvidenceResponse {
  return schedulingEvidenceResponseSchema.parse({
    operation: 'scheduling.evidence',
    mode,
    status: 'not_bookable',
    bookable: false,
    reasonCode,
    message,
    companyId: input.companyId,
    jobId: input.jobId,
    jobVersion: input.expectedJobVersion,
    window: {
      start: new Date(input.window.start).toISOString(),
      end: new Date(input.window.end).toISOString(),
    },
    ...(crewId ? { crewId } : {}),
  });
}

async function authenticate(
  client: SupabaseClient,
  authorization: string | null,
  companyId: string,
): Promise<{ userId: string; role: MembershipRole }> {
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
  }
  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser(authorization.slice('Bearer '.length));
  if (authError || !user) {
    throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
  }
  const { data, error } = await client.rpc('load_storyops_edge_actor', {
    p_company_id: companyId,
    p_actor_user_id: user.id,
  });
  if (error) {
    throw new HttpError('Company membership could not be verified.', 503, 'MEMBERSHIP_UNAVAILABLE');
  }
  const actor = record(data, 'Company membership');
  if (
    actor.company_id !== companyId ||
    actor.user_id !== user.id ||
    actor.active !== true ||
    (actor.role !== 'owner' && actor.role !== 'dispatcher')
  ) {
    throw new HttpError(
      'Only an active owner or dispatcher may refresh scheduling evidence.',
      403,
      'ROLE_FORBIDDEN',
    );
  }
  return { userId: user.id, role: actor.role };
}

function mapReceipt(row: Row, replayed: boolean): SchedulingEvidenceReceipt {
  return schedulingEvidenceReceiptSchema.parse({
    schemaVersion: row.schema_version,
    receiptId: row.id,
    companyId: row.company_id,
    jobId: row.job_id,
    jobVersion: row.job_version,
    propertyId: row.property_id,
    crewId: row.crew_id,
    crewVersion: row.crew_version,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    evidenceMode: row.evidence_mode,
    configurationRevision: row.configuration_revision,
    operatingBaselinePublicationId: row.operating_baseline_publication_id,
    capacityDisposition: row.capacity_disposition,
    routeDisposition: row.route_disposition,
    weatherDisposition: row.weather_disposition,
    calendarEventId: row.calendar_event_id,
    routeCheckId: row.route_check_id,
    weatherCheckId: row.weather_check_id,
    unknowns: row.unknowns,
    conflicts: row.conflicts,
    expiresAt: row.expires_at,
    evidenceHash: row.evidence_hash,
    requestHash: row.request_hash,
    createdAt: row.created_at,
    replayed,
  });
}

function loadExistingReceipt(
  input: SchedulingEvidenceRequest,
  value: unknown,
  now: Date,
):
  | {
      receipt: SchedulingEvidenceReceipt;
      expired: boolean;
    }
  | undefined {
  if (value === null || value === undefined) return undefined;
  const row = record(value, 'Existing scheduling evidence');
  if (
    row.job_id !== input.jobId ||
    Number(row.job_version) !== input.expectedJobVersion ||
    !sameInstant(textValue(row, 'starts_at'), input.window.start) ||
    !sameInstant(textValue(row, 'ends_at'), input.window.end) ||
    (input.crewId !== undefined && row.crew_id !== input.crewId)
  ) {
    throw new HttpError(
      'The idempotency key was already used for different scheduling facts.',
      409,
      'IDEMPOTENCY_CONFLICT',
    );
  }
  if (
    row.evidence_mode !== 'live' ||
    row.capacity_disposition !== 'eligible' ||
    row.route_disposition !== 'eligible' ||
    row.weather_disposition !== 'eligible'
  ) {
    throw new HttpError(
      'The prior scheduling evidence is not a promotable live receipt.',
      409,
      'EVIDENCE_NOT_PROMOTABLE',
    );
  }
  return {
    receipt: mapReceipt(row, true),
    expired: Date.parse(textValue(row, 'expires_at')) <= now.getTime(),
  };
}

type SchedulingReconciliationState = {
  existingReceipt: unknown;
  staleReceipts: Row[];
  hasOtherActiveUnconsumed: boolean;
};

async function loadSchedulingReconciliationState(
  client: SupabaseClient,
  input: SchedulingEvidenceRequest,
  actorUserId: string,
  now: Date,
): Promise<SchedulingReconciliationState> {
  const { data, error } = await client.rpc('load_storyops_scheduling_reconciliation_state', {
    p_company_id: input.companyId,
    p_actor_user_id: actorUserId,
    p_job_id: input.jobId,
    p_idempotency_key: input.idempotencyKey,
    p_now: now.toISOString(),
  });
  if (error) {
    throw new HttpError(
      'Scheduling evidence state could not be reconciled.',
      503,
      'EVIDENCE_REPLAY_UNAVAILABLE',
    );
  }
  const state = record(data, 'Scheduling evidence reconciliation state');
  if (
    !Object.hasOwn(state, 'existing_receipt') ||
    typeof state.has_other_active_unconsumed !== 'boolean'
  ) {
    throw new HttpError(
      'Scheduling evidence reconciliation state is incomplete.',
      503,
      'AUTHORITATIVE_DATA_INVALID',
    );
  }
  return {
    existingReceipt: state.existing_receipt,
    staleReceipts: records(state.stale_receipts, 'Expired scheduling evidence'),
    hasOtherActiveUnconsumed: state.has_other_active_unconsumed,
  };
}

async function cancelCalendarBooking(
  suite: IntegrationSuite,
  booking: {
    calendarId: string;
    eventId: string;
    etag: string;
    idempotencyKey: string;
  },
): Promise<void> {
  await suite.calendar.cancelBooking({
    calendarId: booking.calendarId,
    providerId: booking.eventId,
    etag: booking.etag,
    idempotencyKey: booking.idempotencyKey,
  });
}

async function cancelStaleUnconsumedBookings(suite: IntegrationSuite, stale: Row[]): Promise<void> {
  if (stale.length > 20) {
    throw new HttpError(
      'More than twenty expired calendar events require manual reconciliation.',
      409,
      'STALE_CALENDAR_RECONCILIATION_REQUIRED',
    );
  }
  if (stale.length === 0) return;
  for (const row of stale) {
    if (row.consumed === true) continue;
    if (row.consumed !== false) {
      throw new HttpError(
        'Scheduling receipt consumption could not be reconciled.',
        503,
        'STALE_CALENDAR_RECONCILIATION_UNAVAILABLE',
      );
    }
    await cancelCalendarBooking(suite, {
      calendarId: textValue(row, 'capacity_reference'),
      eventId: textValue(row, 'calendar_event_id'),
      etag: textValue(row, 'calendar_event_etag'),
      idempotencyKey: `${textValue(row, 'idempotency_key')}:calendar`,
    });
  }
}

function requiredSnapshotRecord(value: unknown, missingCode: string, message: string): Row {
  if (value === null || value === undefined) {
    throw new HttpError(message, 409, missingCode);
  }
  return record(value, message);
}

function reviewedProviderConfiguration(configuration: Row): boolean {
  const integrations = record(configuration.integrations, 'Integration configuration');
  const providers = records(integrations.providers, 'Provider configuration');
  return REQUIRED_CONFIGURATION_PROVIDERS.every((requiredProvider) =>
    providers.some(
      (provider) =>
        provider.provider === requiredProvider &&
        provider.requestedMode === 'live' &&
        provider.environmentEnabled === true &&
        provider.ownerEnabled === true &&
        provider.health === 'healthy',
    ),
  );
}

function validateRequestedWindow(
  input: SchedulingEvidenceRequest,
  configuration: Row,
  timeZone: string,
  now: Date,
): { operatingWindow: TimeWindow; localServiceDate: string; bufferMinutes: number } {
  const schedule = record(configuration.schedule, 'Scheduling configuration');
  const start = new Date(input.window.start);
  const end = new Date(input.window.end);
  const startParts = dateTimeParts(start, timeZone);
  const endParts = dateTimeParts(end, timeZone);
  const serviceDate = localDate(startParts);
  if (localDate(endParts) !== serviceDate) {
    throw new HttpError(
      'A scheduling evidence window must remain within one local service day.',
      422,
      'WINDOW_OUTSIDE_BUSINESS_HOURS',
    );
  }
  const leadTimeHours = numberValue(schedule, 'minimumLeadTimeHours');
  const maximumBookingDays = numberValue(schedule, 'maximumBookingDays');
  if (start.getTime() < now.getTime() + leadTimeHours * 60 * 60 * 1_000) {
    throw new HttpError(
      'The requested start is inside the configured minimum lead time.',
      422,
      'MINIMUM_LEAD_TIME_REQUIRED',
    );
  }
  if (start.getTime() > now.getTime() + maximumBookingDays * 24 * 60 * 60 * 1_000) {
    throw new HttpError(
      'The requested start is outside the configured booking horizon.',
      422,
      'BOOKING_HORIZON_EXCEEDED',
    );
  }
  const businessHours = records(schedule.businessHours, 'Business hours');
  const day = businessHours.find((entry) => entry.day === startParts.weekday);
  if (!day || day.closed === true) {
    throw new HttpError(
      'The company is closed during the requested service day.',
      422,
      'WINDOW_OUTSIDE_BUSINESS_HOURS',
    );
  }
  const opensAt = textValue(day, 'opensAt');
  const closesAt = textValue(day, 'closesAt');
  const operatingWindow = {
    start: zonedDateTimeToIso(serviceDate, opensAt, timeZone),
    end: zonedDateTimeToIso(serviceDate, closesAt, timeZone),
  };
  if (!windowContains(operatingWindow, input.window)) {
    throw new HttpError(
      'The requested window is outside reviewed business hours.',
      422,
      'WINDOW_OUTSIDE_BUSINESS_HOURS',
    );
  }
  return {
    operatingWindow,
    localServiceDate: serviceDate,
    bufferMinutes: numberValue(schedule, 'appointmentBufferMinutes'),
  };
}

function eligibleEquipment(
  equipment: Row[],
  requiredTypes: string[],
  crewId: string,
  serviceDate: string,
  reservedEquipmentIds: Set<string>,
): boolean {
  return requiredTypes.every((equipmentType) =>
    equipment.some(
      (item) =>
        item.equipment_type === equipmentType &&
        !reservedEquipmentIds.has(textValue(item, 'id')) &&
        (item.status === 'available' || item.status === 'assigned') &&
        (item.assigned_crew_id === null ||
          item.assigned_crew_id === undefined ||
          item.assigned_crew_id === crewId) &&
        (item.next_inspection_due === null ||
          item.next_inspection_due === undefined ||
          String(item.next_inspection_due) >= serviceDate),
    ),
  );
}

function selectCrew(
  snapshot: Row,
  input: SchedulingEvidenceRequest,
  requiredSkills: string[],
  requiredEquipment: string[],
  serviceDate: string,
): Row {
  const crews = records(snapshot.crews, 'Crews');
  const members = records(snapshot.crew_members, 'Crew members');
  const activeFieldWorkerIds = new Set(
    records(snapshot.technician_memberships, 'Field worker memberships').map((membership) =>
      textValue(membership, 'user_id'),
    ),
  );
  const equipment = records(snapshot.equipment, 'Equipment');
  const reservedEquipmentIds = new Set(
    records(snapshot.equipment_reservations, 'Equipment reservations').map((reservation) =>
      textValue(reservation, 'equipment_id'),
    ),
  );
  const visits = records(snapshot.visits, 'Visits');
  if (crews.some((crew) => textValue(crew, 'company_id') !== input.companyId)) {
    throw new HttpError(
      'Scheduling crew facts escaped the requested company.',
      503,
      'AUTHORITATIVE_DATA_INVALID',
    );
  }
  const selected = crews.find((crew) => {
    const crewId = textValue(crew, 'id');
    const skills = stringArray(crew.skill_codes);
    const scheduledMembers = members.filter(
      (member) =>
        member.crew_id === crewId &&
        String(member.starts_on) <= serviceDate &&
        (member.ends_on === null ||
          member.ends_on === undefined ||
          String(member.ends_on) >= serviceDate),
    );
    return (
      requiredSkills.every((skill) => skills.includes(skill)) &&
      scheduledMembers.length > 0 &&
      scheduledMembers.every((member) => activeFieldWorkerIds.has(textValue(member, 'user_id'))) &&
      eligibleEquipment(equipment, requiredEquipment, crewId, serviceDate, reservedEquipmentIds) &&
      !visits.some((visit) => visit.crew_id === crewId)
    );
  });
  if (!selected) {
    throw new HttpError(
      input.crewId
        ? 'The selected crew lacks a required skill, member, equipment item, inspection, or open window.'
        : 'No active crew satisfies the exact service, equipment, membership, and open-window requirements.',
      422,
      'NO_ELIGIBLE_CREW',
    );
  }
  return selected;
}

function reviewedCoordinates(property: Row): Coordinates {
  const latitude = numberValue(property, 'latitude', 'Property latitude');
  const longitude = numberValue(property, 'longitude', 'Property longitude');
  const confidence = numberValue(property, 'geocode_confidence', 'Property geocode confidence');
  if (
    property.reviewed_geocode !== true ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    confidence < REVIEWED_COORDINATE_CONFIDENCE ||
    typeof property.geocoded_at !== 'string'
  ) {
    throw new HttpError(
      'A confirmed live-provider geocode for the exact current address is required before routing or weather checks.',
      422,
      'COORDINATES_NOT_REVIEWED',
    );
  }
  return { latitude, longitude };
}

async function committedCrewRouteContext(
  client: SupabaseClient,
  companyId: string,
  actorUserId: string,
  crewId: string,
  operatingWindow: TimeWindow,
): Promise<CommittedVisitRouteContext[]> {
  const { data, error } = await client.rpc('load_storyops_scheduling_route_context', {
    p_company_id: companyId,
    p_actor_user_id: actorUserId,
    p_crew_id: crewId,
    p_window_start: operatingWindow.start,
    p_window_end: operatingWindow.end,
    p_limit: MAX_COMMITTED_ROUTE_VISITS + 1,
  });
  if (error) {
    throw new HttpError(
      'Committed crew visits could not be loaded for route verification.',
      503,
      'ROUTE_CONTEXT_UNAVAILABLE',
    );
  }
  const snapshot = record(data, 'Committed route context');
  const visits = records(snapshot.visits, 'Committed crew visits');
  if (visits.length > MAX_COMMITTED_ROUTE_VISITS) {
    throw new HttpError(
      'The crew day exceeds the bounded automatic routing limit and requires dispatcher review.',
      422,
      'ROUTE_CONTEXT_REVIEW_REQUIRED',
    );
  }
  if (visits.length === 0) return [];

  const jobIds = [...new Set(visits.map((visit) => textValue(visit, 'job_id')))];
  const jobs = records(snapshot.jobs, 'Committed visit jobs');
  if (jobs.length !== jobIds.length) {
    throw new HttpError(
      'A committed visit no longer has an authoritative job.',
      422,
      'ROUTE_CONTEXT_REVIEW_REQUIRED',
    );
  }
  const jobsById = new Map(jobs.map((job) => [textValue(job, 'id'), job]));
  const properties = records(snapshot.properties, 'Committed visit properties');
  const propertiesById = new Map(
    properties.map((property) => [textValue(property, 'id'), property]),
  );

  return visits.map((visit) => {
    const visitId = textValue(visit, 'id');
    const jobId = textValue(visit, 'job_id');
    const job = jobsById.get(jobId);
    if (!job) {
      throw new HttpError(
        'A committed visit no longer has an authoritative job.',
        422,
        'ROUTE_CONTEXT_REVIEW_REQUIRED',
      );
    }
    const propertyId = textValue(job, 'property_id');
    const property = propertiesById.get(propertyId);
    if (!property) {
      throw new HttpError(
        'A committed visit no longer has an authoritative property.',
        422,
        'ROUTE_CONTEXT_REVIEW_REQUIRED',
      );
    }
    const startsAt = new Date(textValue(visit, 'starts_at')).toISOString();
    const endsAt = new Date(textValue(visit, 'ends_at')).toISOString();
    const visitVersion = numberValue(visit, 'version', 'Visit version');
    const jobVersion = numberValue(job, 'version', 'Visit job version');
    const propertyVersion = numberValue(property, 'version', 'Visit property version');
    const geocodedAt = textValue(property, 'geocoded_at', 'Visit property geocode timestamp');
    if (
      !Number.isSafeInteger(visitVersion) ||
      visitVersion < 1 ||
      !Number.isSafeInteger(jobVersion) ||
      jobVersion < 1 ||
      !Number.isSafeInteger(propertyVersion) ||
      propertyVersion < 1 ||
      Date.parse(endsAt) <= Date.parse(startsAt) ||
      !Number.isFinite(Date.parse(geocodedAt))
    ) {
      throw new HttpError(
        'A committed visit has incomplete version, window, or location evidence.',
        422,
        'ROUTE_CONTEXT_REVIEW_REQUIRED',
      );
    }
    return {
      routingJobId: visitRoutingJobId(visitId),
      visitId,
      visitVersion,
      visitStatus: textValue(visit, 'status'),
      jobId,
      jobVersion,
      propertyId,
      propertyVersion,
      startsAt,
      endsAt,
      location: reviewedCoordinates(property),
      geocodedAt: new Date(geocodedAt).toISOString(),
    };
  });
}

function addressText(configuration: Row): string {
  const territory = record(configuration.territory, 'Territory configuration');
  const address = record(territory.serviceAddress, 'Reviewed service address');
  return [
    textValue(address, 'line1'),
    typeof address.line2 === 'string' ? address.line2 : '',
    textValue(address, 'city'),
    textValue(address, 'region'),
    textValue(address, 'postalCode'),
    textValue(address, 'country'),
  ]
    .filter(Boolean)
    .join(', ');
}

async function routeOrigin(suite: IntegrationSuite, configuration: Row): Promise<Coordinates> {
  const candidates = await suite.maps.geocode(addressText(configuration));
  const selected = candidates.find(
    (candidate) =>
      (candidate.precision === 'rooftop' || candidate.precision === 'parcel') &&
      candidate.confidence >= REVIEWED_COORDINATE_CONFIDENCE,
  );
  if (!selected) {
    throw new HttpError(
      'The reviewed company service address did not resolve to high-confidence route coordinates.',
      422,
      'ROUTING_ORIGIN_UNRESOLVED',
    );
  }
  return selected.coordinates;
}

function providerEnvironmentReady(environment: Record<string, string | undefined>): boolean {
  return LIVE_PROVIDER_SWITCHES.every(
    ([enableFlag, modeSetting]) =>
      resolveLiveProviderActivation(environment, enableFlag, modeSetting).enabled,
  );
}

function providerSuiteReady(suite: IntegrationSuite): boolean {
  return (
    suite.calendar.mode === 'live' &&
    suite.maps.mode === 'live' &&
    suite.weather.mode === 'live' &&
    suite.routing.mode === 'live'
  );
}

function safeProviderMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  return 'A live scheduling provider did not return complete authoritative evidence.';
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }

  try {
    const rawBody = await readTextBody(request, 16_384);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = schedulingEvidenceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        'Request must contain only company, job version, optional crew, exact window, trace, and idempotency facts.',
        400,
        'INVALID_REQUEST',
      );
    }
    const input = parsed.data;
    const environment = Deno.env.toObject();
    const serviceClient = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const actor = await authenticate(
      serviceClient,
      request.headers.get('authorization'),
      input.companyId,
    );
    const workerActivation = resolveSchedulingEvidenceActivation(environment);
    if (workerActivation.runtimeMode !== 'live') {
      return jsonResponse(
        notBookable(
          input,
          workerActivation.runtimeMode,
          'LIVE_SCHEDULING_DISABLED',
          'Scheduling evidence is not live-enabled. No provider call, calendar event, route/weather record, or scheduling receipt was created.',
        ),
      );
    }
    await Promise.all([
      assertProviderInvocation(serviceClient, {
        companyId: input.companyId,
        provider: 'google_calendar',
        capability: 'calendar',
        operationClass: 'launch_start',
      }),
      assertProviderInvocation(serviceClient, {
        companyId: input.companyId,
        provider: 'maps',
        capability: 'geocoding',
        operationClass: 'launch_start',
      }),
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

    const reconciliationNow = new Date();
    const reconciliation = await loadSchedulingReconciliationState(
      serviceClient,
      input,
      actor.userId,
      reconciliationNow,
    );
    const existing = loadExistingReceipt(input, reconciliation.existingReceipt, reconciliationNow);
    if (existing && !existing.expired) {
      return jsonResponse(
        schedulingEvidenceResponseSchema.parse({
          operation: 'scheduling.evidence',
          mode: 'live',
          status: 'ready_to_book',
          bookable: true,
          reasonCode: 'LIVE_EVIDENCE_READY',
          message: 'The existing immutable scheduling receipt is still fresh and bookable.',
          companyId: input.companyId,
          jobId: input.jobId,
          jobVersion: input.expectedJobVersion,
          window: {
            start: new Date(input.window.start).toISOString(),
            end: new Date(input.window.end).toISOString(),
          },
          crewId: existing.receipt.crewId,
          receipt: existing.receipt,
        }),
      );
    }
    if (reconciliation.hasOtherActiveUnconsumed) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'ACTIVE_SCHEDULING_RECEIPT_EXISTS',
          'This job already has a fresh unconsumed scheduling receipt. Use that exact candidate or wait for its bounded expiry before evaluating another window.',
        ),
        409,
      );
    }

    if (!providerEnvironmentReady(environment)) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'LIVE_PROVIDERS_NOT_ENABLED',
          'Calendar, maps, NWS, and VROOM must each pass their independent live mode and enable switch. No provider or scheduling mutation was attempted.',
        ),
        503,
      );
    }

    let suite: IntegrationSuite;
    try {
      suite = createServerIntegrationSuite(environment);
    } catch {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'LIVE_PROVIDERS_NOT_CONFIGURED',
          'A required live scheduling provider credential is missing or invalid. No provider or scheduling mutation was attempted.',
        ),
        503,
      );
    }
    if (!providerSuiteReady(suite)) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'LIVE_PROVIDERS_NOT_CONFIGURED',
          'The live provider suite is incomplete. No provider or scheduling mutation was attempted.',
        ),
        503,
      );
    }
    try {
      await cancelStaleUnconsumedBookings(suite, reconciliation.staleReceipts);
    } catch {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'STALE_CALENDAR_RECONCILIATION_REQUIRED',
          'An expired unconsumed Google Calendar event could not be safely reconciled. No new calendar event was created.',
          existing?.receipt.crewId,
        ),
        503,
      );
    }
    if (existing?.expired) {
      throw new HttpError(
        'The prior receipt expired and its calendar event was reconciled; retry with a new idempotency key.',
        409,
        'EVIDENCE_EXPIRED',
      );
    }

    const budget = await consumeOperationBudget({
      client: serviceClient,
      companyId: input.companyId,
      scope: 'scheduling-evidence:user:hour',
      subject: actor.userId,
      limit: 30,
      windowSeconds: 3_600,
    });
    if (!budget.allowed) {
      throw new HttpError(
        `Scheduling evidence refresh limit reached; retry after ${budget.reset_at}.`,
        429,
        'RATE_LIMITED',
      );
    }

    const normalizedWindow = {
      start: new Date(input.window.start).toISOString(),
      end: new Date(input.window.end).toISOString(),
    };
    const { data: candidateData, error: candidateError } = await serviceClient.rpc(
      'load_storyops_scheduling_candidate',
      {
        p_company_id: input.companyId,
        p_actor_user_id: actor.userId,
        p_job_id: input.jobId,
        p_window_start: normalizedWindow.start,
        p_window_end: normalizedWindow.end,
        p_crew_id: input.crewId ?? null,
      },
    );
    if (candidateError) {
      throw new HttpError(
        'Scheduling candidate facts could not be verified.',
        503,
        'CAPACITY_UNAVAILABLE',
      );
    }
    const candidate = record(candidateData, 'Scheduling candidate facts');
    const job = requiredSnapshotRecord(
      candidate.job,
      'JOB_NOT_FOUND',
      'The requested job is not company-owned.',
    );
    if (
      job.status !== 'ready_to_schedule' ||
      numberValue(job, 'version') !== input.expectedJobVersion
    ) {
      throw new HttpError(
        'The job is not ready to schedule at the requested version.',
        409,
        'JOB_VERSION_OR_STATUS_CONFLICT',
      );
    }
    const quote = requiredSnapshotRecord(
      candidate.quote,
      'QUOTE_NOT_FOUND',
      'The job quote could not be loaded.',
    );
    const property = requiredSnapshotRecord(
      candidate.property,
      'PROPERTY_NOT_FOUND',
      'The job property could not be loaded.',
    );
    const company = requiredSnapshotRecord(
      candidate.company,
      'COMPANY_NOT_FOUND',
      'The company could not be loaded.',
    );
    const configuration = requiredSnapshotRecord(
      candidate.configuration,
      'LIVE_CONFIGURATION_REQUIRED',
      'One current live-published company configuration is required.',
    );
    if (
      textValue(quote, 'id') !== textValue(job, 'quote_id') ||
      textValue(property, 'id') !== textValue(job, 'property_id') ||
      textValue(job, 'company_id') !== input.companyId ||
      textValue(quote, 'company_id') !== input.companyId ||
      textValue(property, 'company_id') !== input.companyId ||
      textValue(company, 'id') !== input.companyId
    ) {
      throw new HttpError(
        'Scheduling candidate relationships escaped the requested company and job.',
        503,
        'AUTHORITATIVE_DATA_INVALID',
      );
    }
    if (company.status !== 'active') {
      throw new HttpError(
        'The company is not active for live scheduling.',
        409,
        'COMPANY_NOT_ACTIVE',
      );
    }
    const estimate = requiredSnapshotRecord(
      candidate.estimate,
      'ESTIMATE_NOT_FOUND',
      'The deterministic estimate could not be loaded.',
    );
    if (
      textValue(estimate, 'id') !== textValue(quote, 'estimate_id') ||
      textValue(estimate, 'company_id') !== input.companyId
    ) {
      throw new HttpError(
        'The deterministic estimate does not match the job quote.',
        503,
        'AUTHORITATIVE_DATA_INVALID',
      );
    }
    const durationMinutes = numberValue(estimate, 'duration_minutes');
    if (
      durationMinutes <= 0 ||
      Date.parse(normalizedWindow.end) - Date.parse(normalizedWindow.start) !==
        durationMinutes * 60_000
    ) {
      throw new HttpError(
        'The requested window does not equal the deterministic estimate duration.',
        422,
        'DURATION_MISMATCH',
      );
    }

    const configurationPayload = record(configuration.configuration, 'Company configuration');
    if (
      configuration.status !== 'published' ||
      configuration.publication_mode !== 'live' ||
      !reviewedProviderConfiguration(configurationPayload) ||
      record(
        record(configurationPayload.policies, 'Policy configuration').safetyReview,
        'Safety review',
      ).status !== 'approved'
    ) {
      throw new HttpError(
        'Reviewed safety policy and owner-approved live scheduling providers are required.',
        409,
        'LIVE_CONFIGURATION_NOT_REVIEWED',
      );
    }
    const baseline = requiredSnapshotRecord(
      candidate.baseline,
      'ACTIVE_BASELINE_REQUIRED',
      'The live configuration needs one matching active operating baseline.',
    );
    if (
      baseline.status !== 'active' ||
      numberValue(baseline, 'configuration_revision') !== numberValue(configuration, 'revision')
    ) {
      throw new HttpError(
        'The operating baseline does not match the live configuration.',
        409,
        'ACTIVE_BASELINE_REQUIRED',
      );
    }
    const timeZone = textValue(company, 'timezone');
    const scheduleWindow = validateRequestedWindow(
      { ...input, window: normalizedWindow },
      configurationPayload,
      timeZone,
      new Date(),
    );
    const serviceCodes = stringArray(job.service_codes);
    if (serviceCodes.length === 0) {
      throw new HttpError(
        'The job has no authoritative service codes.',
        422,
        'SERVICE_REQUIREMENTS_MISSING',
      );
    }
    const catalog = records(candidate.catalog, 'Service requirements');
    if (new Set(catalog.map((service) => service.code)).size !== new Set(serviceCodes).size) {
      throw new HttpError(
        'Every job service must resolve to an active catalog requirement.',
        422,
        'SERVICE_REQUIREMENTS_MISSING',
      );
    }
    const requiredSkills = [
      ...new Set(catalog.flatMap((service) => stringArray(service.required_skills))),
    ].sort();
    const requiredEquipment = [
      ...new Set(catalog.flatMap((service) => stringArray(service.required_equipment_types))),
    ].sort();
    const crew = selectCrew(
      candidate,
      { ...input, window: normalizedWindow },
      requiredSkills,
      requiredEquipment,
      scheduleWindow.localServiceDate,
    );
    const crewId = textValue(crew, 'id');
    const propertyCoordinates = reviewedCoordinates(property);
    let committedRouteVisits: CommittedVisitRouteContext[];
    try {
      committedRouteVisits = await committedCrewRouteContext(
        serviceClient,
        input.companyId,
        actor.userId,
        crewId,
        scheduleWindow.operatingWindow,
      );
    } catch (error) {
      const unavailable = error instanceof HttpError && error.code === 'ROUTE_CONTEXT_UNAVAILABLE';
      return jsonResponse(
        notBookable(
          input,
          'live',
          unavailable ? 'ROUTE_CONTEXT_UNAVAILABLE' : 'ROUTE_CONTEXT_REVIEW_REQUIRED',
          error instanceof Error
            ? error.message
            : 'Committed crew route facts are uncertain and require dispatcher review.',
          crewId,
        ),
        unavailable ? 503 : 422,
      );
    }
    const settings = record(company.settings, 'Company settings');
    const weatherPolicy = companyWeatherPolicySchema.safeParse(settings.weatherPolicy);
    if (!weatherPolicy.success) {
      throw new HttpError(
        'A complete reviewed company weather policy is required before live scheduling.',
        409,
        'WEATHER_POLICY_NOT_REVIEWED',
      );
    }
    const safetyReview = record(
      record(configurationPayload.policies, 'Policy configuration').safetyReview,
      'Safety review',
    );
    const weatherPolicyEnvelope = {
      ...weatherPolicy.data,
      reviewReference: textValue(safetyReview, 'evidenceReference'),
      reviewedAt: textValue(safetyReview, 'reviewedAt'),
      configurationRevision: numberValue(configuration, 'revision'),
    };
    const weatherPolicyHash = await schedulingCanonicalSha256(weatherPolicyEnvelope);
    const weatherPolicyVersion =
      weatherPolicy.data.version ?? `weather-policy-${weatherPolicyHash.slice(0, 32)}`;
    const bufferedWindow = {
      start: new Date(
        Date.parse(normalizedWindow.start) - scheduleWindow.bufferMinutes * 60_000,
      ).toISOString(),
      end: new Date(
        Date.parse(normalizedWindow.end) + scheduleWindow.bufferMinutes * 60_000,
      ).toISOString(),
    };

    let availability: CalendarAvailability;
    let forecast: WeatherForecast;
    let origin: Coordinates;
    try {
      [availability, forecast, origin] = await Promise.all([
        suite.calendar.readAvailability({
          calendarIds: [...suite.calendar.allowedCalendarIds],
          window: bufferedWindow,
          durationMinutes: durationMinutes + scheduleWindow.bufferMinutes * 2,
          timeZone,
        }),
        suite.weather.forecast({ coordinates: propertyCoordinates, window: normalizedWindow }),
        routeOrigin(suite, configurationPayload),
      ]);
    } catch (error) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'AUTHORITATIVE_PROVIDER_EVIDENCE_UNAVAILABLE',
          safeProviderMessage(error),
          crewId,
        ),
        503,
      );
    }
    const providerNow = Date.now();
    const expectedCalendarIds = [...suite.calendar.allowedCalendarIds];
    if (
      availability.provider !== 'google_calendar' ||
      availability.mode !== 'live' ||
      expectedCalendarIds.length !== 1 ||
      expectedCalendarIds[0]!.length > 500 ||
      availability.sourceCalendarIds.length !== expectedCalendarIds.length ||
      availability.sourceCalendarIds.some(
        (calendarId) => !expectedCalendarIds.includes(calendarId),
      ) ||
      !Number.isFinite(Date.parse(availability.observedAt)) ||
      Date.parse(availability.observedAt) < providerNow - 10 * 60_000 ||
      Date.parse(availability.observedAt) > providerNow + 2 * 60_000
    ) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'CALENDAR_EVIDENCE_INVALID',
          'Google Calendar did not return one fresh authoritative free/busy result for the configured calendar.',
          crewId,
        ),
        503,
      );
    }
    if (
      forecast.provider !== 'nws' ||
      forecast.mode !== 'live' ||
      !Number.isFinite(Date.parse(forecast.observedAt)) ||
      Date.parse(forecast.observedAt) < providerNow - 60 * 60_000 ||
      Date.parse(forecast.observedAt) > providerNow + 2 * 60_000
    ) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'WEATHER_EVIDENCE_INVALID',
          'NWS did not return a fresh authoritative observation timestamp.',
          crewId,
        ),
        503,
      );
    }
    const capacityAvailable = availability.free.some((window) =>
      windowContains(window, bufferedWindow),
    );
    if (!capacityAvailable) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'CALENDAR_WINDOW_BUSY',
          'Google Calendar free/busy does not show the complete buffered window as available.',
          crewId,
        ),
      );
    }
    if (
      !Number.isFinite(Date.parse(forecast.issuedAt)) ||
      Date.parse(forecast.issuedAt) < Date.now() - 6 * 60 * 60 * 1_000 ||
      Date.parse(forecast.issuedAt) > Date.now() + 2 * 60 * 1_000
    ) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'WEATHER_FORECAST_STALE',
          'NWS did not provide a fresh authoritative forecast issuance timestamp.',
          crewId,
        ),
      );
    }
    const weather = evaluateWeatherForecast(forecast, weatherPolicy.data, normalizedWindow);
    if (weather.disposition !== 'eligible') {
      return jsonResponse(
        notBookable(
          input,
          'live',
          weather.disposition === 'requires_approval'
            ? 'WEATHER_APPROVAL_REQUIRED'
            : weather.disposition === 'unknown'
              ? 'WEATHER_FACTS_UNKNOWN'
              : 'WEATHER_POLICY_BLOCKED',
          [...weather.reasons, ...weather.unknowns].join(' ').slice(0, 500) ||
            'Weather evidence is not eligible for automatic scheduling.',
          crewId,
        ),
      );
    }

    let routePlan: RoutePlan;
    let baselineRoutePlan: RoutePlan | undefined;
    const routeIdempotencyKey = `${input.idempotencyKey}:route`;
    const committedRouteJobs = committedRouteVisits.map(committedVisitRoutingJob);
    const routeJobs = [
      ...committedRouteJobs,
      targetRoutingJob({
        jobId: input.jobId,
        location: propertyCoordinates,
        window: normalizedWindow,
      }),
    ];
    try {
      if (committedRouteJobs.length > 0) {
        baselineRoutePlan = await suite.routing.optimize({
          jobs: committedRouteJobs,
          vehicles: [
            {
              id: crewId,
              start: origin,
              end: origin,
              availability: scheduleWindow.operatingWindow,
            },
          ],
          idempotencyKey: `${routeIdempotencyKey}:baseline`,
        });
      }
      routePlan = await suite.routing.optimize({
        jobs: routeJobs,
        vehicles: [
          {
            id: crewId,
            start: origin,
            end: origin,
            availability: scheduleWindow.operatingWindow,
          },
        ],
        idempotencyKey: routeIdempotencyKey,
      });
    } catch (error) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'ROUTE_EVIDENCE_UNAVAILABLE',
          safeProviderMessage(error),
          crewId,
        ),
        503,
      );
    }
    const baselineRoute = baselineRoutePlan?.routes.find(
      (candidate) => candidate.vehicleId === crewId,
    );
    const baselineViolations = baselineRoutePlan
      ? exactCrewRouteViolations({
          routePlan: baselineRoutePlan,
          crewId,
          expectedJobs: committedRouteJobs,
        })
      : [];
    if (baselineViolations.length > 0 || (baselineRoutePlan && !baselineRoute)) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'ROUTE_CONTEXT_REVIEW_REQUIRED',
          baselineViolations.join(' ').slice(0, 500),
          crewId,
        ),
        422,
      );
    }
    const route = routePlan.routes.find((candidate) => candidate.vehicleId === crewId);
    const routeViolations = crewDayRouteViolations({
      routePlan,
      crewId,
      expectedJobs: routeJobs,
      targetJobId: input.jobId,
    });
    if (routeViolations.length > 0 || !route) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'ROUTE_NOT_FEASIBLE',
          routeViolations.join(' ').slice(0, 500),
          crewId,
        ),
      );
    }
    const baselineTravelSeconds = baselineRoute?.travelSeconds ?? 0;
    const baselineDistanceMeters = baselineRoute?.distanceMeters ?? 0;
    if (
      route.travelSeconds < baselineTravelSeconds ||
      route.distanceMeters < baselineDistanceMeters
    ) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'ROUTE_EVIDENCE_INVALID',
          'VROOM candidate-route totals were below the committed baseline, so incremental travel could not be proven.',
          crewId,
        ),
        503,
      );
    }
    const addedTravelSeconds = route.travelSeconds - baselineTravelSeconds;
    const addedDistanceMeters = route.distanceMeters - baselineDistanceMeters;

    const { data: capacityRecheckData, error: capacityRecheckError } = await serviceClient.rpc(
      'recheck_storyops_scheduling_capacity',
      {
        p_company_id: input.companyId,
        p_actor_user_id: actor.userId,
        p_job_id: input.jobId,
        p_crew_id: crewId,
        p_window_start: bufferedWindow.start,
        p_window_end: bufferedWindow.end,
      },
    );
    const capacityRecheck =
      capacityRecheckError || !capacityRecheckData
        ? undefined
        : record(capacityRecheckData, 'Scheduling capacity recheck');
    const currentJob =
      capacityRecheck?.job === null || capacityRecheck?.job === undefined
        ? undefined
        : record(capacityRecheck.job, 'Scheduling job recheck');
    const conflictingVisitIds = capacityRecheck
      ? exactStringArray(capacityRecheck.conflicting_visit_ids, 'Scheduling capacity conflicts')
      : [];
    if (
      capacityRecheckError ||
      !capacityRecheck ||
      !currentJob ||
      Number(currentJob.version) !== input.expectedJobVersion ||
      currentJob.status !== 'ready_to_schedule' ||
      conflictingVisitIds.length > 0
    ) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'CAPACITY_CHANGED',
          'Job or crew capacity changed while evidence was being refreshed.',
          crewId,
        ),
        409,
      );
    }

    const providerIdempotencyKey = `${input.idempotencyKey}:calendar`;
    const expectedCalendarEventId = `storyops${(await sha256TextHex(providerIdempotencyKey)).slice(
      0,
      40,
    )}`;
    const calendarAttemptEnvelope = {
      schemaVersion: 'storyops-calendar-booking-attempt-input-v1',
      jobId: input.jobId,
      jobVersion: input.expectedJobVersion,
      propertyId: textValue(property, 'id'),
      crewId,
      calendarId: suite.calendar.allowedCalendarIds[0]!,
      eventId: expectedCalendarEventId,
      providerIdempotencyKey,
      startsAt: normalizedWindow.start,
      endsAt: normalizedWindow.end,
      ...(input.traceId ? { traceId: input.traceId } : {}),
    };
    const calendarAttemptRequestHash = await schedulingCanonicalSha256({
      actorUserId: actor.userId,
      companyId: input.companyId,
      schedulingIdempotencyKey: input.idempotencyKey,
      attempt: calendarAttemptEnvelope,
    });
    const { data: preparedAttemptData, error: preparedAttemptError } = await serviceClient.rpc(
      'prepare_storyops_calendar_booking_attempt',
      {
        p_company_id: input.companyId,
        p_actor_user_id: actor.userId,
        p_scheduling_idempotency_key: input.idempotencyKey,
        p_request_hash: calendarAttemptRequestHash,
        p_attempt: calendarAttemptEnvelope,
      },
    );
    if (preparedAttemptError) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'CALENDAR_ATTEMPT_PERSISTENCE_UNAVAILABLE',
          'The durable pre-provider calendar attempt could not be prepared. No calendar provider mutation was attempted.',
          crewId,
        ),
        503,
      );
    }
    const preparedAttempt = calendarBookingAttemptSchema.parse(preparedAttemptData);
    if (
      preparedAttempt.companyId !== input.companyId ||
      preparedAttempt.jobId !== input.jobId ||
      preparedAttempt.jobVersion !== input.expectedJobVersion ||
      preparedAttempt.propertyId !== textValue(property, 'id') ||
      preparedAttempt.crewId !== crewId ||
      preparedAttempt.schedulingIdempotencyKey !== input.idempotencyKey ||
      preparedAttempt.providerIdempotencyKey !== providerIdempotencyKey ||
      preparedAttempt.eventId !== expectedCalendarEventId ||
      preparedAttempt.calendarId !== suite.calendar.allowedCalendarIds[0] ||
      !sameInstant(preparedAttempt.startsAt, normalizedWindow.start) ||
      !sameInstant(preparedAttempt.endsAt, normalizedWindow.end)
    ) {
      throw new HttpError(
        'The durable calendar attempt did not preserve the exact scheduling identity.',
        503,
        'CALENDAR_ATTEMPT_BINDING_CONFLICT',
      );
    }
    if (preparedAttempt.status !== 'prepared') {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'CALENDAR_ATTEMPT_RECONCILIATION_REQUIRED',
          'This idempotency key already has a durable calendar attempt. No repeated provider mutation was attempted; wait for autonomous reconciliation or use the linked booking receipt.',
          crewId,
        ),
        409,
      );
    }
    const { data: begunAttemptData, error: begunAttemptError } = await serviceClient.rpc(
      'begin_storyops_calendar_booking_provider_call',
      {
        p_attempt_id: preparedAttempt.attemptId,
      },
    );
    if (begunAttemptError) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'CALENDAR_ATTEMPT_RECONCILIATION_REQUIRED',
          'The durable provider-call boundary could not be acquired. No calendar provider mutation was attempted.',
          crewId,
        ),
        503,
      );
    }
    const begunAttempt = calendarBookingAttemptSchema.parse(begunAttemptData);
    if (
      begunAttempt.attemptId !== preparedAttempt.attemptId ||
      begunAttempt.status !== 'provider_unknown'
    ) {
      throw new HttpError(
        'The durable calendar provider-call boundary returned an invalid state.',
        503,
        'CALENDAR_ATTEMPT_BINDING_CONFLICT',
      );
    }

    let calendarEntry: CalendarEntry;
    try {
      calendarEntry = await suite.calendar.createBooking({
        calendarId: suite.calendar.allowedCalendarIds[0]!,
        title: `StoryOps ${textValue(job, 'job_number')}`,
        window: normalizedWindow,
        timeZone,
        jobId: input.jobId,
        idempotencyKey: providerIdempotencyKey,
      });
    } catch (error) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'CALENDAR_BOOKING_NOT_RECONCILED',
          `${safeProviderMessage(error)} The durable attempt remains provider-unknown and is queued for exact autonomous read-back.`,
          crewId,
        ),
        503,
      );
    }

    if (
      calendarEntry.provider !== 'google_calendar' ||
      calendarEntry.mode !== 'live' ||
      calendarEntry.kind !== 'booking' ||
      calendarEntry.status !== 'confirmed' ||
      !calendarEntry.readBackConfirmed ||
      !calendarEntry.etag ||
      calendarEntry.providerId !== expectedCalendarEventId ||
      calendarEntry.idempotencyKey !== providerIdempotencyKey ||
      calendarEntry.providerId.length > 500 ||
      calendarEntry.etag.length > 500 ||
      !Number.isFinite(Date.parse(calendarEntry.reconciledAt)) ||
      Date.parse(calendarEntry.reconciledAt) < Date.now() - 10 * 60_000 ||
      Date.parse(calendarEntry.reconciledAt) > Date.now() + 2 * 60_000 ||
      !sameInstant(calendarEntry.window.start, normalizedWindow.start) ||
      !sameInstant(calendarEntry.window.end, normalizedWindow.end)
    ) {
      return jsonResponse(
        notBookable(
          input,
          'live',
          'CALENDAR_BOOKING_NOT_RECONCILED',
          'Google Calendar did not read back the exact deterministic booking.',
          crewId,
        ),
        503,
      );
    }

    const { data: confirmedAttemptData, error: confirmedAttemptError } = await serviceClient.rpc(
      'confirm_storyops_calendar_booking_attempt',
      {
        p_attempt_id: preparedAttempt.attemptId,
        p_event_id: calendarEntry.providerId,
        p_event_etag: calendarEntry.etag,
      },
    );
    if (confirmedAttemptError) {
      throw new HttpError(
        'The provider booking was read back, but its durable attempt could not be confirmed. Autonomous reconciliation is required before another provider call.',
        503,
        'CALENDAR_ATTEMPT_CONFIRMATION_UNAVAILABLE',
      );
    }
    const confirmedAttempt = calendarBookingAttemptSchema.parse(confirmedAttemptData);
    if (
      confirmedAttempt.attemptId !== preparedAttempt.attemptId ||
      confirmedAttempt.status !== 'confirmed' ||
      confirmedAttempt.eventId !== calendarEntry.providerId ||
      confirmedAttempt.eventEtag !== calendarEntry.etag
    ) {
      throw new HttpError(
        'The durable calendar attempt confirmation did not match provider read-back.',
        503,
        'CALENDAR_ATTEMPT_BINDING_CONFLICT',
      );
    }

    const capacityObservedAt = new Date(availability.observedAt).toISOString();
    const routeObservedAt = new Date().toISOString();
    const weatherObservedAt = new Date(forecast.observedAt).toISOString();
    const capacityExpiresAt = new Date(Date.parse(capacityObservedAt) + 10 * 60_000).toISOString();
    const routeExpiresAt = new Date(Date.parse(routeObservedAt) + 20 * 60_000).toISOString();
    const weatherExpiresAt = new Date(Date.parse(weatherObservedAt) + 40 * 60_000).toISOString();
    const driveMinutes = Math.ceil(addedTravelSeconds / 60);
    const addedDistanceMiles = Number((addedDistanceMeters / 1609.344).toFixed(2));
    const routeRequestPayload = {
      schemaVersion: 'storyops-route-context-v1',
      jobId: input.jobId,
      targetRoutingJobId: candidateRoutingJobId(input.jobId),
      propertyId: textValue(property, 'id'),
      propertyVersion: numberValue(property, 'version'),
      crewId,
      startsAt: normalizedWindow.start,
      endsAt: normalizedWindow.end,
      origin,
      destination: propertyCoordinates,
      operatingWindow: scheduleWindow.operatingWindow,
      committedVisits: committedRouteVisits,
      requiredSkills,
      requiredEquipment,
    };
    const routeResponsePayload = {
      provider: routePlan.provider,
      vehicleId: route.vehicleId,
      jobIds: route.jobIds,
      travelSeconds: route.travelSeconds,
      serviceSeconds: route.serviceSeconds,
      distanceMeters: route.distanceMeters,
      summary: routePlan.summary,
      unassignedJobIds: routePlan.unassignedJobIds,
      baseline: {
        vehicleId: crewId,
        jobIds: baselineRoute?.jobIds ?? [],
        travelSeconds: baselineTravelSeconds,
        serviceSeconds: baselineRoute?.serviceSeconds ?? 0,
        distanceMeters: baselineDistanceMeters,
        unassignedJobIds: baselineRoutePlan?.unassignedJobIds ?? [],
      },
      incremental: {
        travelSeconds: addedTravelSeconds,
        distanceMeters: addedDistanceMeters,
      },
    };
    const capacityPayload = capacityEvidencePayloadSchema.parse({
      schemaVersion: 'storyops-capacity-evidence-v1',
      companyId: input.companyId,
      jobId: input.jobId,
      propertyId: textValue(property, 'id'),
      crewId,
      mode: 'live',
      startsAt: normalizedWindow.start,
      endsAt: normalizedWindow.end,
      bufferedStartsAt: bufferedWindow.start,
      bufferedEndsAt: bufferedWindow.end,
      busy: false,
      readBackConfirmed: calendarEntry.readBackConfirmed,
      eventId: calendarEntry.providerId,
      eventStatus: calendarEntry.status,
      eventEtag: calendarEntry.etag,
      freeBusyObservedAt: capacityObservedAt,
      capacity: {
        disposition: 'eligible',
        eligibleCrewIds: [crewId],
        requiredSkills,
        requiredEquipment,
        appointmentBufferMinutes: scheduleWindow.bufferMinutes,
        unknowns: [],
        conflicts: [],
      },
      freeBusy: {
        provider: availability.provider,
        disposition: 'eligible',
        observedAt: capacityObservedAt,
        requestedWindow: bufferedWindow,
        freeWindows: availability.free,
        sourceCalendarIds: availability.sourceCalendarIds,
        unknowns: [],
        conflicts: [],
      },
    });
    const evidence = {
      schemaVersion: SCHEDULING_EVIDENCE_INPUT_SCHEMA_VERSION,
      evidenceMode: 'live',
      jobId: input.jobId,
      jobVersion: input.expectedJobVersion,
      propertyId: textValue(property, 'id'),
      crewId,
      crewVersion: numberValue(crew, 'version'),
      startsAt: normalizedWindow.start,
      endsAt: normalizedWindow.end,
      configurationRevision: numberValue(configuration, 'revision'),
      operatingBaselinePublicationId: textValue(baseline, 'id'),
      capacity: {
        provider: 'google_calendar',
        reference: suite.calendar.allowedCalendarIds[0]!,
        disposition: 'eligible',
        observedAt: capacityObservedAt,
        expiresAt: capacityExpiresAt,
        calendarEventId: calendarEntry.providerId,
        calendarEventStatus: calendarEntry.status,
        calendarEventEtag: calendarEntry.etag,
        calendarReconciledAt: calendarEntry.reconciledAt,
        payload: capacityPayload,
        calendarPayload: {
          eventId: calendarEntry.providerId,
          status: calendarEntry.status,
          etag: calendarEntry.etag,
          window: calendarEntry.window,
          reconciledAt: calendarEntry.reconciledAt,
          idempotencyKey: calendarEntry.idempotencyKey,
        },
      },
      route: {
        provider: 'vroom',
        disposition: 'eligible',
        observedAt: routeObservedAt,
        expiresAt: routeExpiresAt,
        routeFeasible: true,
        driveMinutes,
        addedDistanceMiles,
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
        periodStartsAt: weather.periodStartsAt,
        periodEndsAt: weather.periodEndsAt,
        temperatureF: weather.temperatureF,
        precipitationProbability: weather.precipitationProbability,
        windSpeedMph: weather.windSpeedMph,
        lightningRisk: weather.lightningRisk,
        conditionCodes: weather.conditionCodes,
        policyVersion: weatherPolicyVersion,
        policy: weatherPolicyEnvelope,
        payload: weather.payload,
      },
      unknowns: [],
      conflicts: [],
      ...(input.traceId ? { traceId: input.traceId } : {}),
    };
    const requestHash = await schedulingCanonicalSha256({
      actorUserId: actor.userId,
      companyId: input.companyId,
      evidence,
      idempotencyKey: input.idempotencyKey,
    });
    const { data: receiptData, error: receiptError } = await serviceClient.rpc(
      'record_storyops_scheduling_evidence',
      {
        p_company_id: input.companyId,
        p_actor_user_id: actor.userId,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: requestHash,
        p_evidence: evidence,
      },
    );
    if (receiptError) {
      const commitReconciliationNow = new Date();
      const commitReconciliation = await loadSchedulingReconciliationState(
        serviceClient,
        input,
        actor.userId,
        commitReconciliationNow,
      );
      const committed = loadExistingReceipt(
        input,
        commitReconciliation.existingReceipt,
        commitReconciliationNow,
      );
      if (committed && !committed.expired) {
        return jsonResponse(
          schedulingEvidenceResponseSchema.parse({
            operation: 'scheduling.evidence',
            mode: 'live',
            status: 'ready_to_book',
            bookable: true,
            reasonCode: 'LIVE_EVIDENCE_READY',
            message: 'The immutable receipt was reconciled after an ambiguous commit response.',
            companyId: input.companyId,
            jobId: input.jobId,
            jobVersion: input.expectedJobVersion,
            window: normalizedWindow,
            crewId: committed.receipt.crewId,
            receipt: committed.receipt,
          }),
        );
      }
      throw new HttpError(
        'The receipt commit could not be proven. The durable calendar attempt remains queued for autonomous exact read-back; do not repeat the provider call.',
        503,
        'EVIDENCE_COMMIT_RECONCILIATION_PENDING',
      );
    }
    const receipt = schedulingEvidenceReceiptSchema.parse(receiptData);
    return jsonResponse(
      schedulingEvidenceResponseSchema.parse({
        operation: 'scheduling.evidence',
        mode: 'live',
        status: 'ready_to_book',
        bookable: true,
        reasonCode: 'LIVE_EVIDENCE_READY',
        message:
          'Live calendar, route, weather, policy, and crew evidence is reconciled and ready for the finite booking command.',
        companyId: input.companyId,
        jobId: input.jobId,
        jobVersion: input.expectedJobVersion,
        window: normalizedWindow,
        crewId,
        receipt,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
});
