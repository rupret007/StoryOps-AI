import { z } from 'zod';
import type {
  RoutePlan,
  RoutingJob,
  TimeWindow,
  WeatherForecast,
} from '../../../src/core/integrations/contracts.ts';
import {
  companyWeatherPolicySchema,
  evaluateWeatherForecast,
  schedulingCanonicalSha256,
} from '../scheduling-evidence/contracts.ts';
import { exactCrewRouteViolations } from '../scheduling-evidence/routeContext.ts';
import {
  dispatchCurrentOriginSchema,
  type DispatchCurrentOrigin,
} from '../../../src/core/scheduling/dispatchOrigin.ts';

export const DISPATCH_CLEARANCE_ENABLE_FLAG = 'DISPATCH_CLEARANCE_LIVE_ENABLED';
export const DISPATCH_CLEARANCE_MODE_SETTING = 'DISPATCH_CLEARANCE_MODE';
export const DISPATCH_CLEARANCE_REQUEST_SCHEMA_VERSION = 'storyops-dispatch-clearance-request-v2';
export const DISPATCH_CLEARANCE_EVIDENCE_SCHEMA_VERSION = 'storyops-dispatch-clearance-evidence-v2';

const uuidSchema = z.string().uuid();
const dateTimeSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const dispatchClearanceRequestSchema = z
  .object({
    companyId: uuidSchema,
    visitId: uuidSchema,
    expectedVisitVersion: z.number().int().positive(),
    currentOrigin: dispatchCurrentOriginSchema,
    idempotencyKey: idempotencyKeySchema,
    traceId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export type DispatchClearanceRequest = z.infer<typeof dispatchClearanceRequestSchema>;

export const dispatchClearanceReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-dispatch-clearance-v2'),
    receiptId: uuidSchema,
    companyId: uuidSchema,
    visitId: uuidSchema,
    visitVersion: z.number().int().positive(),
    jobId: uuidSchema,
    jobVersion: z.number().int().positive(),
    propertyId: uuidSchema,
    propertyVersion: z.number().int().positive(),
    crewId: uuidSchema,
    crewVersion: z.number().int().positive(),
    startsAt: dateTimeSchema,
    endsAt: dateTimeSchema,
    evidenceMode: z.literal('live'),
    configurationRevision: z.number().int().positive(),
    configurationHash: sha256Schema,
    operatingBaselinePublicationId: uuidSchema,
    operatingBaselineHash: sha256Schema,
    schedulingEvidenceReceiptId: uuidSchema,
    providerSnapshotHash: sha256Schema,
    currentOrigin: dispatchCurrentOriginSchema,
    currentOriginHash: sha256Schema,
    currentOriginExpiresAt: dateTimeSchema,
    routeCheckId: uuidSchema,
    routeDisposition: z.literal('eligible'),
    routeObservedAt: dateTimeSchema,
    routeExpiresAt: dateTimeSchema,
    weatherCheckId: uuidSchema,
    weatherDisposition: z.literal('eligible'),
    weatherObservedAt: dateTimeSchema,
    weatherExpiresAt: dateTimeSchema,
    unknowns: z.array(z.string().trim().min(1).max(240)).max(20),
    conflicts: z.array(z.unknown()).max(20),
    expiresAt: dateTimeSchema,
    evidenceHash: sha256Schema,
    requestHash: sha256Schema,
    createdAt: dateTimeSchema,
    replayed: z.boolean(),
  })
  .strict();

export type DispatchClearanceReceipt = z.infer<typeof dispatchClearanceReceiptSchema>;

export function dispatchReceiptMatchesRequest(options: {
  receipt: DispatchClearanceReceipt;
  companyId: string;
  visitId: string;
  visitVersion: number;
  currentOrigin: DispatchCurrentOrigin;
}): boolean {
  const receiptOrigin = options.receipt.currentOrigin;
  const expectedOrigin = options.currentOrigin;
  return (
    options.receipt.companyId === options.companyId &&
    options.receipt.visitId === options.visitId &&
    options.receipt.visitVersion === options.visitVersion &&
    receiptOrigin.schemaVersion === expectedOrigin.schemaVersion &&
    receiptOrigin.readingId === expectedOrigin.readingId &&
    receiptOrigin.source === expectedOrigin.source &&
    receiptOrigin.coordinates.latitude === expectedOrigin.coordinates.latitude &&
    receiptOrigin.coordinates.longitude === expectedOrigin.coordinates.longitude &&
    receiptOrigin.observedAt === expectedOrigin.observedAt &&
    receiptOrigin.accuracyMeters === expectedOrigin.accuracyMeters &&
    receiptOrigin.consent.kind === expectedOrigin.consent.kind &&
    receiptOrigin.consent.disclosureVersion === expectedOrigin.consent.disclosureVersion &&
    receiptOrigin.consent.capturedAt === expectedOrigin.consent.capturedAt
  );
}

export const dispatchClearanceResponseSchema = z
  .object({
    operation: z.literal('visit.dispatch_clearance.refresh'),
    mode: z.enum(['live', 'sandbox', 'disabled']),
    status: z.enum(['cleared', 'blocked']),
    cleared: z.boolean(),
    reasonCode: z.string().regex(/^[A-Z0-9_]{3,100}$/u),
    message: z.string().trim().min(1).max(500),
    companyId: uuidSchema,
    visitId: uuidSchema,
    visitVersion: z.number().int().positive(),
    receipt: dispatchClearanceReceiptSchema.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    const exactClearedShape =
      response.cleared &&
      response.status === 'cleared' &&
      response.mode === 'live' &&
      response.reasonCode === 'LIVE_DISPATCH_CLEARANCE_READY' &&
      response.receipt !== undefined;
    const exactBlockedShape =
      !response.cleared && response.status === 'blocked' && response.receipt === undefined;
    if (!exactClearedShape && !exactBlockedShape) {
      context.addIssue({
        code: 'custom',
        message: 'Dispatch clearance response state is internally inconsistent.',
      });
    }
  });

export type DispatchClearanceResponse = z.infer<typeof dispatchClearanceResponseSchema>;

const coordinatesSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();

export const dispatchRouteRequestSchema = z
  .object({
    schemaVersion: z.literal('storyops-dispatch-route-request-v2'),
    companyId: uuidSchema,
    visitId: uuidSchema,
    visitVersion: z.number().int().positive(),
    jobId: uuidSchema,
    jobVersion: z.number().int().positive(),
    propertyId: uuidSchema,
    propertyVersion: z.number().int().positive(),
    crewId: uuidSchema,
    crewVersion: z.number().int().positive(),
    currentOriginHash: sha256Schema,
    origin: coordinatesSchema,
    destination: coordinatesSchema,
    departureAt: dateTimeSchema,
    arrivalDeadline: dateTimeSchema,
    visitWindow: z
      .object({
        start: dateTimeSchema,
        end: dateTimeSchema,
      })
      .strict(),
    routingJobId: z.string().regex(/^dispatch:[0-9a-f-]{36}$/u),
  })
  .strict();

export const dispatchRouteResponseSchema = z
  .object({
    provider: z.literal('vroom'),
    mode: z.literal('live'),
    vehicleId: uuidSchema,
    jobIds: z.array(z.string()).length(1),
    unassignedJobIds: z.array(z.string()).length(0),
    travelSeconds: z.number().int().nonnegative(),
    serviceSeconds: z.number().int().nonnegative(),
    distanceMeters: z.number().nonnegative(),
    summary: z
      .object({
        travelSeconds: z.number().int().nonnegative(),
        serviceSeconds: z.number().int().nonnegative(),
        distanceMeters: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const dispatchWeatherEvidenceSchema = z
  .object({
    provider: z.literal('nws'),
    disposition: z.literal('eligible'),
    observedAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
    forecastIssuedAt: dateTimeSchema,
    periodStartsAt: dateTimeSchema,
    periodEndsAt: dateTimeSchema,
    temperatureF: z.number().finite(),
    precipitationProbability: z.number().min(0).max(1),
    windSpeedMph: z.number().nonnegative(),
    lightningRisk: z.enum(['none', 'low', 'elevated', 'severe', 'unknown']),
    conditionCodes: z.array(z.string().min(1).max(80)).max(40),
    policyVersion: z.string().min(1).max(128),
    policyHash: sha256Schema,
    policy: z.record(z.string(), z.unknown()),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const dispatchClearanceEvidenceSchema = z
  .object({
    schemaVersion: z.literal(DISPATCH_CLEARANCE_EVIDENCE_SCHEMA_VERSION),
    evidenceMode: z.literal('live'),
    visitId: uuidSchema,
    visitVersion: z.number().int().positive(),
    jobId: uuidSchema,
    jobVersion: z.number().int().positive(),
    propertyId: uuidSchema,
    propertyVersion: z.number().int().positive(),
    propertyGeocodedAt: dateTimeSchema,
    crewId: uuidSchema,
    crewVersion: z.number().int().positive(),
    startsAt: dateTimeSchema,
    endsAt: dateTimeSchema,
    configurationRevision: z.number().int().positive(),
    configurationHash: sha256Schema,
    operatingBaselinePublicationId: uuidSchema,
    operatingBaselineHash: sha256Schema,
    schedulingEvidenceReceiptId: uuidSchema,
    providerSnapshotHash: sha256Schema,
    currentOrigin: dispatchCurrentOriginSchema,
    route: z
      .object({
        provider: z.literal('vroom'),
        disposition: z.literal('eligible'),
        observedAt: dateTimeSchema,
        expiresAt: dateTimeSchema,
        routeFeasible: z.literal(true),
        driveMinutes: z.number().int().nonnegative(),
        distanceMiles: z.number().nonnegative(),
        violations: z.array(z.string().min(1).max(240)).length(0),
        requestPayload: dispatchRouteRequestSchema,
        responsePayload: dispatchRouteResponseSchema,
      })
      .strict(),
    weather: dispatchWeatherEvidenceSchema,
    unknowns: z.array(z.string().min(1).max(240)).length(0),
    conflicts: z.array(z.unknown()).length(0),
    traceId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export type DispatchClearanceEvidence = z.infer<typeof dispatchClearanceEvidenceSchema>;
export type { DispatchCurrentOrigin };

export function resolveDispatchClearanceMode(
  environment: Readonly<Record<string, string | undefined>>,
): 'live' | 'sandbox' | 'disabled' {
  const mode = environment[DISPATCH_CLEARANCE_MODE_SETTING]?.trim().toLowerCase();
  const enabled = environment[DISPATCH_CLEARANCE_ENABLE_FLAG]?.trim().toLowerCase() === 'true';
  if (mode === 'disabled') return 'disabled';
  return mode === 'live' && enabled ? 'live' : 'sandbox';
}

export function dispatchRoutingJobId(visitId: string): string {
  return `dispatch:${visitId}`;
}

export function evaluateDispatchWeather(options: {
  forecast: WeatherForecast;
  policy: unknown;
  window: TimeWindow;
  now: Date;
}) {
  if (
    options.forecast.provider !== 'nws' ||
    options.forecast.mode !== 'live' ||
    !Number.isFinite(Date.parse(options.forecast.observedAt)) ||
    Date.parse(options.forecast.observedAt) < options.now.getTime() - 10 * 60_000 ||
    Date.parse(options.forecast.observedAt) > options.now.getTime() + 2 * 60_000 ||
    !Number.isFinite(Date.parse(options.forecast.issuedAt)) ||
    Date.parse(options.forecast.issuedAt) < options.now.getTime() - 6 * 60 * 60_000 ||
    Date.parse(options.forecast.issuedAt) > options.now.getTime() + 2 * 60_000
  ) {
    return {
      eligible: false as const,
      reasonCode: 'WEATHER_EVIDENCE_STALE_OR_INVALID',
      message: 'NWS did not return a current live forecast with authoritative timestamps.',
    };
  }
  const policy = companyWeatherPolicySchema.safeParse(options.policy);
  if (!policy.success) {
    return {
      eligible: false as const,
      reasonCode: 'WEATHER_POLICY_NOT_REVIEWED',
      message: 'The current company weather policy is incomplete.',
    };
  }
  const evaluation = evaluateWeatherForecast(options.forecast, policy.data, options.window);
  if (evaluation.disposition !== 'eligible' || evaluation.unknowns.length > 0) {
    return {
      eligible: false as const,
      reasonCode:
        evaluation.disposition === 'requires_approval'
          ? 'WEATHER_APPROVAL_REQUIRED'
          : evaluation.disposition === 'unknown'
            ? 'WEATHER_FACTS_UNKNOWN'
            : 'WEATHER_POLICY_HOLD',
      message:
        [...evaluation.reasons, ...evaluation.unknowns].join(' ').slice(0, 500) ||
        'Current NWS evidence is not eligible under the reviewed weather policy.',
    };
  }
  return { eligible: true as const, policy: policy.data, evaluation };
}

export function evaluateDispatchRoute(options: {
  routePlan: RoutePlan;
  crewId: string;
  routingJob: RoutingJob;
}) {
  const violations = exactCrewRouteViolations({
    routePlan: options.routePlan,
    crewId: options.crewId,
    expectedJobs: [options.routingJob],
    requiredRoutingJobId: options.routingJob.id,
  });
  const route = options.routePlan.routes.find(
    (candidate) => candidate.vehicleId === options.crewId,
  );
  if (!route || violations.length > 0) {
    return {
      eligible: false as const,
      reasonCode: 'ROUTE_NOT_FEASIBLE',
      message:
        violations.join(' ').slice(0, 500) ||
        'VROOM did not return one exact feasible route for the assigned crew and visit.',
    };
  }
  return { eligible: true as const, route };
}

export function dispatchCanonicalSha256(value: unknown): Promise<string> {
  return schedulingCanonicalSha256(value);
}
