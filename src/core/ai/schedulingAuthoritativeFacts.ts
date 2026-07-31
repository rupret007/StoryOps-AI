import { z } from 'zod';
import type { TrustedFact } from './contracts.ts';
import {
  SCHEDULING_BOOKING_CONFIRMATION_SCHEMA_VERSION,
  SCHEDULING_PREREQUISITE_SCHEMA_VERSION,
  schedulingBookingConfirmationFactName,
  schedulingPrerequisiteFactNames,
} from './schedulingPrerequisites.ts';

const isoDateTimeSchema = z.string().datetime({ offset: true });

const capacityPayloadSchema = z.object({
  schemaVersion: z.literal('storyops-capacity-evidence-v1'),
  companyId: z.string().min(1),
  jobId: z.string().min(1),
  propertyId: z.string().min(1),
  crewId: z.string().min(1),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  mode: z.enum(['live', 'sandbox']),
  capacity: z.object({
    disposition: z.string().min(1),
    eligibleCrewIds: z.array(z.string().min(1)),
    requiredSkillCodes: z.array(z.string()),
    requiredEquipmentTypes: z.array(z.string()),
    unknowns: z.array(z.string()),
    conflicts: z.array(z.unknown()),
  }),
  freeBusy: z.object({
    disposition: z.string().min(1),
    sourceCalendarIds: z.array(z.string().min(1)),
    busyWindows: z.array(z.unknown()),
    unknowns: z.array(z.string()),
    conflicts: z.array(z.unknown()),
  }),
});

const schedulingReceiptRowSchema = z.object({
  id: z.string().min(1),
  company_id: z.string().min(1),
  job_id: z.string().min(1),
  property_id: z.string().min(1),
  crew_id: z.string().min(1),
  starts_at: isoDateTimeSchema,
  ends_at: isoDateTimeSchema,
  evidence_mode: z.enum(['live', 'sandbox']),
  capacity_provider: z.enum(['google_calendar', 'mock']),
  capacity_reference: z.string().min(1),
  capacity_disposition: z.string().min(1),
  capacity_observed_at: isoDateTimeSchema,
  capacity_expires_at: isoDateTimeSchema,
  capacity_payload: capacityPayloadSchema,
  route_check_id: z.string().min(1),
  route_disposition: z.string().min(1),
  route_observed_at: isoDateTimeSchema,
  route_expires_at: isoDateTimeSchema,
  weather_check_id: z.string().min(1),
  weather_disposition: z.string().min(1),
  weather_observed_at: isoDateTimeSchema,
  weather_expires_at: isoDateTimeSchema,
  weather_policy_version: z.string().min(1),
  unknowns: z.array(z.string()).default([]),
  conflicts: z.array(z.unknown()).default([]),
  expires_at: isoDateTimeSchema,
});

const routeCheckRowSchema = z.object({
  id: z.string().min(1),
  company_id: z.string().min(1),
  provider: z.enum(['vroom', 'mock']),
  route_feasible: z.boolean(),
  violations: z.array(z.string()),
});

const weatherCheckRowSchema = z.object({
  id: z.string().min(1),
  company_id: z.string().min(1),
  provider: z.enum(['nws', 'mock']),
  forecast_issued_at: isoDateTimeSchema,
  policy_disposition: z.string().min(1),
});

const schedulingConsumptionRowSchema = z.object({
  company_id: z.string().min(1),
  evidence_receipt_id: z.string().min(1),
  visit_id: z.string().min(1),
  consumed_at: isoDateTimeSchema,
});

const schedulingJobRowSchema = z.object({
  id: z.string().min(1),
  company_id: z.string().min(1),
  assigned_crew_id: z.string().min(1),
  status: z.string().min(1),
});

const schedulingVisitRowSchema = z.object({
  id: z.string().min(1),
  company_id: z.string().min(1),
  job_id: z.string().min(1),
  crew_id: z.string().min(1),
  starts_at: isoDateTimeSchema,
  ends_at: isoDateTimeSchema,
  status: z.string().min(1),
  scheduling_evidence_receipt_id: z.string().min(1),
});

export type SchedulingReceiptRow = z.input<typeof schedulingReceiptRowSchema>;
export type SchedulingRouteCheckRow = z.input<typeof routeCheckRowSchema>;
export type SchedulingWeatherCheckRow = z.input<typeof weatherCheckRowSchema>;
export type SchedulingConsumptionRow = z.input<typeof schedulingConsumptionRowSchema>;
export type SchedulingJobRow = z.input<typeof schedulingJobRowSchema>;
export type SchedulingVisitRow = z.input<typeof schedulingVisitRowSchema>;

function eligibility(value: string): 'eligible' | 'ineligible' | 'unknown' {
  if (value === 'eligible') return 'eligible';
  if (value === 'unknown') return 'unknown';
  return 'ineligible';
}

function weatherDisposition(
  value: string,
): 'eligible' | 'requires_approval' | 'unavailable' | 'unknown' {
  if (
    value === 'eligible' ||
    value === 'requires_approval' ||
    value === 'unavailable' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'unavailable';
}

function conflictText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 500) || 'unspecified conflict';
  try {
    return JSON.stringify(value).slice(0, 500) || 'unspecified conflict';
  } catch {
    return 'unserializable conflict';
  }
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

export function schedulingTrustedFactsFromRows(options: {
  receipts: SchedulingReceiptRow[];
  routeChecks: SchedulingRouteCheckRow[];
  weatherChecks: SchedulingWeatherCheckRow[];
}): TrustedFact[] {
  const receipts = options.receipts.map((row) => schedulingReceiptRowSchema.parse(row));
  const routeChecks = new Map(
    options.routeChecks.map((row) => {
      const parsed = routeCheckRowSchema.parse(row);
      return [parsed.id, parsed] as const;
    }),
  );
  const weatherChecks = new Map(
    options.weatherChecks.map((row) => {
      const parsed = weatherCheckRowSchema.parse(row);
      return [parsed.id, parsed] as const;
    }),
  );

  return receipts.flatMap((receipt): TrustedFact[] => {
    const route = routeChecks.get(receipt.route_check_id);
    const weather = weatherChecks.get(receipt.weather_check_id);
    if (
      !route ||
      !weather ||
      route.company_id !== receipt.company_id ||
      weather.company_id !== receipt.company_id
    ) {
      throw new Error(
        `Scheduling receipt ${receipt.id} has missing or cross-company provider evidence.`,
      );
    }
    const payload = receipt.capacity_payload;
    if (
      payload.companyId !== receipt.company_id ||
      payload.jobId !== receipt.job_id ||
      payload.propertyId !== receipt.property_id ||
      payload.crewId !== receipt.crew_id ||
      !sameInstant(payload.startsAt, receipt.starts_at) ||
      !sameInstant(payload.endsAt, receipt.ends_at) ||
      payload.mode !== receipt.evidence_mode
    ) {
      throw new Error(`Scheduling receipt ${receipt.id} capacity binding conflicts.`);
    }

    const window = { start: receipt.starts_at, end: receipt.ends_at };
    const receiptConflicts = receipt.conflicts.map(conflictText);
    const capacityUnknowns = [
      ...receipt.unknowns,
      ...payload.capacity.unknowns,
      ...payload.freeBusy.unknowns,
    ];
    const capacityConflicts = [
      ...receiptConflicts,
      ...payload.capacity.conflicts.map(conflictText),
      ...payload.freeBusy.conflicts.map(conflictText),
    ];
    const factPrefix = `scheduling_receipt:${receipt.id}`;

    return [
      {
        id: `${factPrefix}:capacity`,
        name: schedulingPrerequisiteFactNames.capacity,
        source: 'database',
        observedAt: receipt.capacity_observed_at,
        value: {
          schemaVersion: SCHEDULING_PREREQUISITE_SCHEMA_VERSION,
          receiptId: receipt.id,
          kind: 'capacity_availability',
          companyId: receipt.company_id,
          jobId: receipt.job_id,
          window,
          checkedAt: receipt.capacity_observed_at,
          validUntil: receipt.capacity_expires_at,
          evidenceMode: receipt.evidence_mode,
          eligibility: eligibility(receipt.capacity_disposition),
          unknowns: capacityUnknowns,
          conflicts: capacityConflicts,
          capacityCheckId: receipt.capacity_reference,
          provider: receipt.capacity_provider,
          capacityDisposition: eligibility(payload.capacity.disposition),
          freeBusyDisposition: eligibility(payload.freeBusy.disposition),
          availableCrewId: receipt.crew_id,
          sourceCalendarIds: payload.freeBusy.sourceCalendarIds,
        },
      },
      {
        id: `${factPrefix}:weather`,
        name: schedulingPrerequisiteFactNames.weather,
        source: 'database',
        observedAt: receipt.weather_observed_at,
        value: {
          schemaVersion: SCHEDULING_PREREQUISITE_SCHEMA_VERSION,
          receiptId: receipt.id,
          kind: 'weather_policy',
          companyId: receipt.company_id,
          jobId: receipt.job_id,
          window,
          checkedAt: receipt.weather_observed_at,
          validUntil: receipt.weather_expires_at,
          evidenceMode: receipt.evidence_mode,
          eligibility: eligibility(receipt.weather_disposition),
          unknowns: receipt.unknowns,
          conflicts: receiptConflicts,
          weatherCheckId: receipt.weather_check_id,
          provider: weather.provider,
          forecastIssuedAt: weather.forecast_issued_at,
          policyVersion: receipt.weather_policy_version,
          policyDisposition: weatherDisposition(weather.policy_disposition),
        },
      },
      {
        id: `${factPrefix}:route`,
        name: schedulingPrerequisiteFactNames.route,
        source: 'database',
        observedAt: receipt.route_observed_at,
        value: {
          schemaVersion: SCHEDULING_PREREQUISITE_SCHEMA_VERSION,
          receiptId: receipt.id,
          kind: 'route',
          companyId: receipt.company_id,
          jobId: receipt.job_id,
          window,
          checkedAt: receipt.route_observed_at,
          validUntil: receipt.route_expires_at,
          evidenceMode: receipt.evidence_mode,
          eligibility: eligibility(receipt.route_disposition),
          unknowns: receipt.unknowns,
          conflicts: receiptConflicts,
          routeCheckId: receipt.route_check_id,
          provider: route.provider,
          routeDisposition: eligibility(receipt.route_disposition),
          routeFeasible: route.route_feasible,
          violations: route.violations,
        },
      },
    ];
  });
}

export function schedulingBookingFactsFromRows(options: {
  receipts: SchedulingReceiptRow[];
  consumptions: SchedulingConsumptionRow[];
  jobs: SchedulingJobRow[];
  visits: SchedulingVisitRow[];
}): TrustedFact[] {
  const receipts = new Map(
    options.receipts.map((row) => {
      const parsed = schedulingReceiptRowSchema.parse(row);
      return [parsed.id, parsed] as const;
    }),
  );
  const jobs = new Map(
    options.jobs.map((row) => {
      const parsed = schedulingJobRowSchema.parse(row);
      return [parsed.id, parsed] as const;
    }),
  );
  const visits = new Map(
    options.visits.map((row) => {
      const parsed = schedulingVisitRowSchema.parse(row);
      return [parsed.id, parsed] as const;
    }),
  );

  return options.consumptions.flatMap((row): TrustedFact[] => {
    const consumption = schedulingConsumptionRowSchema.parse(row);
    const receipt = receipts.get(consumption.evidence_receipt_id);
    const visit = visits.get(consumption.visit_id);
    const job = visit ? jobs.get(visit.job_id) : undefined;
    if (!receipt || !visit || !job) return [];
    if (
      consumption.company_id !== receipt.company_id ||
      visit.company_id !== receipt.company_id ||
      job.company_id !== receipt.company_id ||
      visit.job_id !== receipt.job_id ||
      visit.scheduling_evidence_receipt_id !== receipt.id ||
      visit.crew_id !== receipt.crew_id ||
      job.assigned_crew_id !== receipt.crew_id ||
      !sameInstant(visit.starts_at, receipt.starts_at) ||
      !sameInstant(visit.ends_at, receipt.ends_at) ||
      job.status !== 'scheduled' ||
      !['planned', 'confirmed'].includes(visit.status)
    ) {
      return [];
    }
    return [
      {
        id: `scheduling_receipt:${receipt.id}:booking_confirmation`,
        name: schedulingBookingConfirmationFactName,
        source: 'database',
        observedAt: consumption.consumed_at,
        value: {
          schemaVersion: SCHEDULING_BOOKING_CONFIRMATION_SCHEMA_VERSION,
          receiptId: receipt.id,
          companyId: receipt.company_id,
          jobId: receipt.job_id,
          visitId: visit.id,
          window: { start: receipt.starts_at, end: receipt.ends_at },
          crewId: receipt.crew_id,
          evidenceMode: receipt.evidence_mode,
          consumedAt: consumption.consumed_at,
          jobStatus: 'scheduled',
          visitStatus: visit.status,
        },
      },
    ];
  });
}
