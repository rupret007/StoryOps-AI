import { z } from 'zod';
import type {
  TimeWindow,
  WeatherForecast,
  WeatherPeriod,
} from '../../../src/core/integrations/contracts.ts';
import {
  resolveLiveProviderActivation,
  type EnvironmentReader,
  type LiveProviderActivation,
} from '../../../src/core/integrations/configuration.ts';

export const SCHEDULING_EVIDENCE_ENABLE_FLAG = 'SCHEDULING_EVIDENCE_LIVE_ENABLED';
export const SCHEDULING_EVIDENCE_MODE_SETTING = 'SCHEDULING_EVIDENCE_MODE';
export const SCHEDULING_EVIDENCE_INPUT_SCHEMA_VERSION = 'storyops-scheduling-evidence-input-v1';

const uuidSchema = z.string().uuid();
const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const dateTimeSchema = z.string().datetime({ offset: true });
const finitePolicyNumber = z.union([
  z.number().finite(),
  z
    .string()
    .trim()
    .regex(/^-?(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/u)
    .transform(Number),
]);

export const schedulingEvidenceRequestSchema = z
  .object({
    companyId: uuidSchema,
    jobId: uuidSchema,
    expectedJobVersion: z.number().int().positive(),
    crewId: uuidSchema.optional(),
    window: z
      .object({
        start: dateTimeSchema,
        end: dateTimeSchema,
      })
      .strict(),
    idempotencyKey: idempotencyKeySchema,
    traceId: z.string().trim().min(1).max(160).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const startsAt = Date.parse(request.window.start);
    const endsAt = Date.parse(request.window.end);
    if (endsAt <= startsAt) {
      context.addIssue({
        code: 'custom',
        path: ['window', 'end'],
        message: 'Scheduling window end must be after its start.',
      });
    }
    if (endsAt - startsAt > 12 * 60 * 60 * 1_000) {
      context.addIssue({
        code: 'custom',
        path: ['window'],
        message: 'A scheduling evidence window cannot exceed 12 hours.',
      });
    }
  });

export type SchedulingEvidenceRequest = z.infer<typeof schedulingEvidenceRequestSchema>;

export const calendarBookingAttemptSchema = z
  .object({
    schemaVersion: z.literal('storyops-calendar-booking-attempt-v1'),
    attemptId: uuidSchema,
    companyId: uuidSchema,
    jobId: uuidSchema,
    jobVersion: z.number().int().positive(),
    propertyId: uuidSchema,
    crewId: uuidSchema,
    schedulingIdempotencyKey: z.string().min(8).max(200),
    providerIdempotencyKey: z.string().min(8).max(220),
    calendarId: z.string().min(1).max(500),
    eventId: z.string().regex(/^storyops[a-f0-9]{40}$/u),
    eventEtag: z.string().min(1).max(500).optional(),
    startsAt: dateTimeSchema,
    endsAt: dateTimeSchema,
    status: z.enum([
      'prepared',
      'provider_unknown',
      'confirmed',
      'receipt_linked',
      'cancelled',
      'manual_required',
    ]),
    receiptId: uuidSchema.optional(),
    reconcileAfter: dateTimeSchema,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    replayed: z.boolean(),
  })
  .strict();
export type CalendarBookingAttempt = z.infer<typeof calendarBookingAttemptSchema>;

export const schedulingEvidenceReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-scheduling-evidence-v1'),
    receiptId: uuidSchema,
    companyId: uuidSchema,
    jobId: uuidSchema,
    jobVersion: z.number().int().positive(),
    propertyId: uuidSchema,
    crewId: uuidSchema,
    crewVersion: z.number().int().positive(),
    startsAt: dateTimeSchema,
    endsAt: dateTimeSchema,
    evidenceMode: z.literal('live'),
    configurationRevision: z.number().int().positive(),
    operatingBaselinePublicationId: uuidSchema,
    capacityDisposition: z.literal('eligible'),
    routeDisposition: z.literal('eligible'),
    weatherDisposition: z.literal('eligible'),
    calendarEventId: z.string().min(1).max(500),
    routeCheckId: uuidSchema,
    weatherCheckId: uuidSchema,
    unknowns: z.array(z.string()).max(20),
    conflicts: z.array(z.unknown()).max(20),
    expiresAt: dateTimeSchema,
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: dateTimeSchema,
    replayed: z.boolean(),
  })
  .strict();

export type SchedulingEvidenceReceipt = z.infer<typeof schedulingEvidenceReceiptSchema>;

export const schedulingEvidenceResponseSchema = z
  .object({
    operation: z.literal('scheduling.evidence'),
    mode: z.enum(['live', 'sandbox', 'disabled']),
    status: z.enum(['ready_to_book', 'not_bookable']),
    bookable: z.boolean(),
    reasonCode: z.string().regex(/^[A-Z0-9_]{3,100}$/u),
    message: z.string().min(1).max(500),
    companyId: uuidSchema,
    jobId: uuidSchema,
    jobVersion: z.number().int().positive(),
    window: z
      .object({
        start: dateTimeSchema,
        end: dateTimeSchema,
      })
      .strict(),
    crewId: uuidSchema.optional(),
    receipt: schedulingEvidenceReceiptSchema.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    if (
      response.status === 'ready_to_book' &&
      (!response.bookable || response.mode !== 'live' || !response.receipt || !response.crewId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A bookable response requires one live scheduling receipt and exact crew.',
      });
    }
    if (response.status === 'not_bookable' && (response.bookable || response.receipt)) {
      context.addIssue({
        code: 'custom',
        message: 'A non-bookable response cannot include a promotable receipt.',
      });
    }
  });

export type SchedulingEvidenceResponse = z.infer<typeof schedulingEvidenceResponseSchema>;

export const capacityEvidencePayloadSchema = z
  .object({
    schemaVersion: z.literal('storyops-capacity-evidence-v1'),
    companyId: uuidSchema,
    jobId: uuidSchema,
    propertyId: uuidSchema,
    crewId: uuidSchema,
    mode: z.literal('live'),
    startsAt: dateTimeSchema,
    endsAt: dateTimeSchema,
    bufferedStartsAt: dateTimeSchema,
    bufferedEndsAt: dateTimeSchema,
    busy: z.literal(false),
    readBackConfirmed: z.literal(true),
    eventId: z.string().min(1).max(500),
    eventStatus: z.literal('confirmed'),
    eventEtag: z.string().min(1).max(500),
    freeBusyObservedAt: dateTimeSchema,
    capacity: z
      .object({
        disposition: z.literal('eligible'),
        eligibleCrewIds: z.array(uuidSchema).min(1).max(50),
        requiredSkills: z.array(z.string().min(1).max(100)).max(100),
        requiredEquipment: z.array(z.string().min(1).max(100)).max(100),
        appointmentBufferMinutes: z.number().int().min(0).max(240),
        unknowns: z.tuple([]),
        conflicts: z.tuple([]),
      })
      .strict(),
    freeBusy: z
      .object({
        provider: z.literal('google_calendar'),
        disposition: z.literal('eligible'),
        observedAt: dateTimeSchema,
        requestedWindow: z.object({ start: dateTimeSchema, end: dateTimeSchema }).strict(),
        freeWindows: z
          .array(z.object({ start: dateTimeSchema, end: dateTimeSchema }).strict())
          .max(100),
        sourceCalendarIds: z.array(z.string().min(1).max(500)).min(1).max(20),
        unknowns: z.tuple([]),
        conflicts: z.tuple([]),
      })
      .strict(),
  })
  .strict();

export function resolveSchedulingEvidenceActivation(
  environment: EnvironmentReader,
): LiveProviderActivation {
  return resolveLiveProviderActivation(
    environment,
    SCHEDULING_EVIDENCE_ENABLE_FLAG,
    SCHEDULING_EVIDENCE_MODE_SETTING,
  );
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('Canonical scheduling hashes require finite JSON numbers.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  throw new TypeError('Canonical scheduling hashes accept JSON-compatible values only.');
}

/**
 * Mirrors the canonical JSON SHA-256 contract in
 * 20260728160000_scheduling_evidence_boundary.sql.
 */
export async function schedulingCanonicalSha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const companyWeatherPolicySchema = z
  .object({
    version: z.string().trim().min(1).max(100).optional(),
    minimumTemperatureF: finitePolicyNumber.pipe(z.number().min(-40).max(120)),
    maximumTemperatureF: finitePolicyNumber.pipe(z.number().min(-20).max(140)),
    maximumWindSpeedMph: finitePolicyNumber.pipe(z.number().min(0).max(100)),
    maximumPrecipitationProbability: finitePolicyNumber.pipe(z.number().min(0).max(1)),
    prohibitedLightningRisks: z
      .array(z.enum(['none', 'low', 'elevated', 'severe', 'unknown']))
      .min(1)
      .max(5),
    prohibitedConditionCodes: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  })
  .strict()
  .refine(
    (policy) => policy.maximumTemperatureF > policy.minimumTemperatureF,
    'Weather policy maximum temperature must exceed its minimum.',
  );

export type CompanyWeatherPolicy = z.infer<typeof companyWeatherPolicySchema>;

export type WeatherEvidenceEvaluation = {
  disposition: 'eligible' | 'requires_approval' | 'unavailable' | 'unknown';
  periodStartsAt: string;
  periodEndsAt: string;
  temperatureF: number;
  precipitationProbability: number;
  windSpeedMph: number;
  lightningRisk: 'none' | 'low' | 'elevated' | 'severe' | 'unknown';
  conditionCodes: string[];
  unknowns: string[];
  reasons: string[];
  payload: Record<string, unknown>;
};

function normalizedCondition(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '_')
      .replace(/^_+|_+$/gu, '')
      .slice(0, 80) || 'unknown'
  );
}

function overlap(period: WeatherPeriod, window: TimeWindow): boolean {
  return (
    Date.parse(period.start) < Date.parse(window.end) &&
    Date.parse(window.start) < Date.parse(period.end)
  );
}

function lightningRisk(
  alerts: WeatherForecast['alerts'],
): WeatherEvidenceEvaluation['lightningRisk'] {
  const matching = alerts.filter((alert) =>
    /lightning|thunderstorm/iu.test(`${alert.event} ${alert.headline}`),
  );
  if (matching.length === 0) return 'none';
  if (
    matching.some(
      (alert) =>
        /extreme|severe/iu.test(alert.severity) ||
        /severe thunderstorm/iu.test(`${alert.event} ${alert.headline}`),
    )
  ) {
    return 'severe';
  }
  return 'elevated';
}

/**
 * Converts provider percentages into the database's 0..1 probability scale,
 * requires complete period coverage, and treats every missing fact as unknown.
 */
export function evaluateWeatherForecast(
  forecast: WeatherForecast,
  policy: CompanyWeatherPolicy,
  window: TimeWindow,
): WeatherEvidenceEvaluation {
  const periods = forecast.periods
    .filter((period) => overlap(period, window))
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  const unknowns = [...forecast.unknowns.map((value) => value.trim()).filter(Boolean)];
  const reasons: string[] = [];
  const requestedStart = Date.parse(window.start);
  const requestedEnd = Date.parse(window.end);
  let coverageCursor = requestedStart;
  for (const period of periods) {
    const periodStart = Date.parse(period.start);
    const periodEnd = Date.parse(period.end);
    if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) || periodEnd <= periodStart) {
      unknowns.push('NWS returned an invalid forecast period.');
      continue;
    }
    if (periodStart > coverageCursor + 1_000) {
      unknowns.push('NWS forecast periods do not completely cover the requested window.');
    }
    coverageCursor = Math.max(coverageCursor, periodEnd);
  }
  if (periods.length === 0 || coverageCursor < requestedEnd) {
    unknowns.push('NWS forecast does not cover the complete requested window.');
  }

  const temperatures = periods.map((period) => period.temperatureF);
  const precipitationPercentages = periods.map((period) => period.precipitationProbability);
  const winds = periods.map((period) => period.windMph);
  if (temperatures.some((value) => value === null)) {
    unknowns.push('NWS temperature is unknown for part of the requested window.');
  }
  if (precipitationPercentages.some((value) => value === null)) {
    unknowns.push('NWS precipitation probability is unknown for part of the requested window.');
  }
  if (winds.some((value) => value === null)) {
    unknowns.push('NWS wind speed is unknown for part of the requested window.');
  }
  if (precipitationPercentages.some((value) => value !== null && (value < 0 || value > 100))) {
    unknowns.push('NWS precipitation probability is outside the provider scale.');
  }
  if (winds.some((value) => value !== null && value < 0)) {
    unknowns.push('NWS wind speed is outside the provider scale.');
  }

  const knownTemperatures = temperatures.filter((value): value is number => value !== null);
  const knownPrecipitation = precipitationPercentages.filter(
    (value): value is number => value !== null,
  );
  const knownWinds = winds.filter((value): value is number => value !== null);
  const minimumTemperature = knownTemperatures.length > 0 ? Math.min(...knownTemperatures) : 0;
  const maximumTemperature = knownTemperatures.length > 0 ? Math.max(...knownTemperatures) : 0;
  const precipitationProbability =
    knownPrecipitation.length > 0 ? Math.max(...knownPrecipitation) / 100 : 0;
  const windSpeedMph = knownWinds.length > 0 ? Math.max(...knownWinds) : 0;
  const currentLightningRisk = lightningRisk(forecast.alerts);
  const conditionCodes = [
    ...new Set(periods.map((period) => normalizedCondition(period.shortForecast))),
  ].sort();

  if (
    minimumTemperature < policy.minimumTemperatureF ||
    maximumTemperature > policy.maximumTemperatureF
  ) {
    reasons.push('Forecast temperature is outside the reviewed operating range.');
  }
  if (windSpeedMph > policy.maximumWindSpeedMph) {
    reasons.push('Forecast wind exceeds the reviewed operating limit.');
  }
  if (policy.prohibitedLightningRisks.includes(currentLightningRisk)) {
    reasons.push('Forecast lightning risk is prohibited by the reviewed policy.');
  }
  if (
    conditionCodes.some((condition) =>
      policy.prohibitedConditionCodes.map(normalizedCondition).includes(condition),
    )
  ) {
    reasons.push('Forecast contains a condition prohibited by the reviewed policy.');
  }
  const precipitationNeedsApproval =
    precipitationProbability > policy.maximumPrecipitationProbability;
  if (precipitationNeedsApproval) {
    reasons.push('Forecast precipitation exceeds the automatic scheduling threshold.');
  }

  const uniqueUnknowns = [...new Set(unknowns)].slice(0, 20);
  const disposition =
    uniqueUnknowns.length > 0
      ? 'unknown'
      : reasons.some((reason) => !reason.includes('precipitation'))
        ? 'unavailable'
        : precipitationNeedsApproval
          ? 'requires_approval'
          : 'eligible';
  return {
    disposition,
    periodStartsAt:
      periods.length > 0
        ? new Date(Math.min(...periods.map((period) => Date.parse(period.start)))).toISOString()
        : window.start,
    periodEndsAt:
      periods.length > 0
        ? new Date(Math.max(...periods.map((period) => Date.parse(period.end)))).toISOString()
        : window.end,
    temperatureF: minimumTemperature,
    precipitationProbability,
    windSpeedMph,
    lightningRisk: currentLightningRisk,
    conditionCodes,
    unknowns: uniqueUnknowns,
    reasons,
    payload: {
      office: forecast.office,
      issuedAt: forecast.issuedAt,
      observedAt: forecast.observedAt,
      periods: periods.slice(0, 24),
      alerts: forecast.alerts.slice(0, 10),
    },
  };
}

export function windowContains(container: TimeWindow, requested: TimeWindow): boolean {
  return (
    Date.parse(container.start) <= Date.parse(requested.start) &&
    Date.parse(container.end) >= Date.parse(requested.end)
  );
}
