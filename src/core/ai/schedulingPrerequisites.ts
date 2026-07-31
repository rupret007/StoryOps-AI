import { z } from 'zod';
import type {
  ActionProposal,
  OfficeAgentName,
  OfficeRunRequest,
  TrustedFact,
} from './contracts.ts';

export const SCHEDULING_PREREQUISITE_POLICY_RULE = 'AI-004-scheduling-prerequisites';
export const SCHEDULING_PREREQUISITE_SCHEMA_VERSION = 'storyops-scheduling-prerequisite-v1';
export const SCHEDULING_BOOKING_CONFIRMATION_SCHEMA_VERSION = 'storyops-booking-confirmation-v1';
export const schedulingBookingConfirmationFactName = 'scheduling.booking_confirmation';

export const schedulingPrerequisiteFactNames = {
  capacity: 'scheduling.capacity_eligibility',
  weather: 'scheduling.weather_eligibility',
  route: 'scheduling.route_eligibility',
} as const;

const CLOCK_SKEW_MS = 60_000;
const CAPACITY_MAX_AGE_MS = 5 * 60_000;
const ROUTE_MAX_AGE_MS = 30 * 60_000;
const WEATHER_MAX_AGE_MS = 60 * 60_000;
const WEATHER_FORECAST_MAX_AGE_MS = 6 * 60 * 60_000;

const isoDateTimeSchema = z.string().datetime({ offset: true });
const timeWindowSchema = z
  .object({
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
  })
  .strict();

const schedulingTargetSchema = z
  .object({
    jobId: z.string().min(1).max(128),
    window: timeWindowSchema,
  })
  .strict();

const schedulingMessageContextSchema = schedulingTargetSchema
  .extend({
    intent: z.literal('booking_confirmation'),
  })
  .strict();

const bookingConfirmationFactSchema = z
  .object({
    schemaVersion: z.literal(SCHEDULING_BOOKING_CONFIRMATION_SCHEMA_VERSION),
    receiptId: z.string().min(1).max(128),
    companyId: z.string().min(1).max(128),
    jobId: z.string().min(1).max(128),
    visitId: z.string().min(1).max(128),
    window: timeWindowSchema,
    crewId: z.string().min(1).max(128),
    evidenceMode: z.enum(['live', 'sandbox']),
    consumedAt: isoDateTimeSchema,
    jobStatus: z.literal('scheduled'),
    visitStatus: z.enum(['planned', 'confirmed']),
  })
  .strict();

const commonPrerequisiteShape = {
  schemaVersion: z.literal(SCHEDULING_PREREQUISITE_SCHEMA_VERSION),
  receiptId: z.string().min(1).max(128),
  companyId: z.string().min(1).max(128),
  jobId: z.string().min(1).max(128),
  window: timeWindowSchema,
  checkedAt: isoDateTimeSchema,
  validUntil: isoDateTimeSchema,
  evidenceMode: z.enum(['live', 'sandbox']),
  eligibility: z.enum(['eligible', 'ineligible', 'unknown']),
  unknowns: z.array(z.string().min(1).max(500)).max(100),
  conflicts: z.array(z.string().min(1).max(500)).max(100),
};

const capacityPrerequisiteSchema = z
  .object({
    ...commonPrerequisiteShape,
    kind: z.literal('capacity_availability'),
    capacityCheckId: z.string().min(1).max(128),
    provider: z.enum(['google_calendar', 'mock']),
    capacityDisposition: z.enum(['eligible', 'ineligible', 'unknown']),
    freeBusyDisposition: z.enum(['eligible', 'ineligible', 'unknown']),
    availableCrewId: z.string().min(1).max(128),
    sourceCalendarIds: z.array(z.string().min(1).max(256)).min(1).max(50),
  })
  .strict();

const weatherPrerequisiteSchema = z
  .object({
    ...commonPrerequisiteShape,
    kind: z.literal('weather_policy'),
    weatherCheckId: z.string().min(1).max(128),
    provider: z.enum(['nws', 'mock']),
    forecastIssuedAt: isoDateTimeSchema,
    policyVersion: z.string().min(1).max(128),
    policyDisposition: z.enum(['eligible', 'requires_approval', 'unavailable', 'unknown']),
  })
  .strict();

const routePrerequisiteSchema = z
  .object({
    ...commonPrerequisiteShape,
    kind: z.literal('route'),
    routeCheckId: z.string().min(1).max(128),
    provider: z.enum(['vroom', 'mock']),
    routeDisposition: z.enum(['eligible', 'ineligible', 'unknown']),
    routeFeasible: z.boolean(),
    violations: z.array(z.string().min(1).max(500)).max(100),
  })
  .strict();

type SchedulingTarget = z.infer<typeof schedulingTargetSchema>;
type CapacityPrerequisite = z.infer<typeof capacityPrerequisiteSchema>;
type WeatherPrerequisite = z.infer<typeof weatherPrerequisiteSchema>;
type RoutePrerequisite = z.infer<typeof routePrerequisiteSchema>;
type ParsedPrerequisite = CapacityPrerequisite | WeatherPrerequisite | RoutePrerequisite;

type PrerequisiteDefinition = {
  name: (typeof schedulingPrerequisiteFactNames)[keyof typeof schedulingPrerequisiteFactNames];
  label: string;
  maxAgeMs: number;
  schema:
    | typeof capacityPrerequisiteSchema
    | typeof weatherPrerequisiteSchema
    | typeof routePrerequisiteSchema;
};

const prerequisiteDefinitions: readonly PrerequisiteDefinition[] = [
  {
    name: schedulingPrerequisiteFactNames.capacity,
    label: 'capacity and provider free/busy',
    maxAgeMs: CAPACITY_MAX_AGE_MS,
    schema: capacityPrerequisiteSchema,
  },
  {
    name: schedulingPrerequisiteFactNames.weather,
    label: 'weather policy',
    maxAgeMs: WEATHER_MAX_AGE_MS,
    schema: weatherPrerequisiteSchema,
  },
  {
    name: schedulingPrerequisiteFactNames.route,
    label: 'route eligibility',
    maxAgeMs: ROUTE_MAX_AGE_MS,
    schema: routePrerequisiteSchema,
  },
];

export type SchedulingPrerequisiteDecision =
  | { required: false; eligible: true }
  | {
      required: true;
      eligible: true;
      target: SchedulingTarget;
      evidenceFactIds: string[];
      evidenceMode: 'live' | 'sandbox';
    }
  | {
      required: true;
      eligible: false;
      reason: string;
    };

function deny(reason: string): SchedulingPrerequisiteDecision {
  return { required: true, eligible: false, reason };
}

function timestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function windowsMatch(
  left: SchedulingTarget['window'],
  right: SchedulingTarget['window'],
): boolean {
  return (
    timestamp(left.start) === timestamp(right.start) && timestamp(left.end) === timestamp(right.end)
  );
}

function targetFor(
  agent: OfficeAgentName,
  proposal: ActionProposal,
):
  | { required: false }
  | {
      required: true;
      target?: SchedulingTarget;
      reason?: string;
      proof: 'eligibility' | 'confirmed_booking';
    } {
  if (proposal.toolName === 'calendar.create_booking') {
    const parsed = schedulingTargetSchema.safeParse({
      jobId: proposal.payload.jobId,
      window: proposal.payload.window,
    });
    return parsed.success
      ? { required: true, target: parsed.data, proof: 'eligibility' }
      : {
          required: true,
          proof: 'eligibility',
          reason: 'A booking must declare one typed job and exact time window.',
        };
  }

  if (
    proposal.toolName === 'communications.send_sms' ||
    proposal.toolName === 'communications.send_email'
  ) {
    const parsed = schedulingMessageContextSchema.safeParse(proposal.payload.schedulingContext);
    if (parsed.success) {
      return {
        required: true,
        proof: 'confirmed_booking',
        target: { jobId: parsed.data.jobId, window: parsed.data.window },
      };
    }
    if (agent === 'scheduling') {
      return {
        required: true,
        proof: 'confirmed_booking',
        reason:
          'Scheduling-agent outbound messages must declare a typed booking-confirmation job and exact window.',
      };
    }
  }

  return { required: false };
}

function commonProblem(options: {
  request: OfficeRunRequest;
  fact: TrustedFact;
  value: ParsedPrerequisite;
  target: SchedulingTarget;
  maxAgeMs: number;
  nowMs: number;
}): string | undefined {
  const { request, fact, value, target, maxAgeMs, nowMs } = options;
  const checkedAt = timestamp(value.checkedAt);
  const observedAt = timestamp(fact.observedAt);
  const validUntil = timestamp(value.validUntil);
  if (checkedAt === undefined || observedAt === undefined || validUntil === undefined) {
    return 'Evidence timestamps are invalid.';
  }
  if (value.companyId !== request.companyId) {
    return 'Evidence is not owned by the requesting company.';
  }
  if (value.jobId !== target.jobId || !windowsMatch(value.window, target.window)) {
    return 'Evidence does not bind the proposed job and exact time window.';
  }
  if (Math.abs(checkedAt - observedAt) > 1_000) {
    return 'Evidence observation time conflicts with its signed payload.';
  }
  if (checkedAt > nowMs + CLOCK_SKEW_MS) {
    return 'Evidence observation time is in the future.';
  }
  if (nowMs - checkedAt > maxAgeMs || validUntil <= nowMs) {
    return 'Evidence is stale.';
  }
  if (validUntil > checkedAt + maxAgeMs + CLOCK_SKEW_MS) {
    return 'Evidence validity exceeds the permitted freshness ceiling.';
  }
  if (value.eligibility !== 'eligible') {
    return 'Evidence is not explicitly eligible.';
  }
  if (value.unknowns.length > 0) {
    return 'Evidence contains unresolved unknowns.';
  }
  if (value.conflicts.length > 0) {
    return 'Evidence contains conflicts.';
  }
  if (value.kind === 'weather_policy') {
    const forecastIssuedAt = timestamp(value.forecastIssuedAt);
    if (
      forecastIssuedAt === undefined ||
      forecastIssuedAt > nowMs + CLOCK_SKEW_MS ||
      nowMs - forecastIssuedAt > WEATHER_FORECAST_MAX_AGE_MS
    ) {
      return 'Weather evidence is based on a stale or invalid provider forecast.';
    }
  }
  if (fact.source === 'human') {
    return 'Scheduling eligibility must come from a provider, database, or deterministic evaluator.';
  }
  return undefined;
}

function providerProblem(value: ParsedPrerequisite): string | undefined {
  const expectedProvider =
    value.evidenceMode === 'sandbox'
      ? 'mock'
      : value.kind === 'capacity_availability'
        ? 'google_calendar'
        : value.kind === 'weather_policy'
          ? 'nws'
          : 'vroom';
  if (value.provider !== expectedProvider) {
    return 'Evidence provider conflicts with its declared live or sandbox mode.';
  }
  if (
    value.kind === 'capacity_availability' &&
    (value.capacityDisposition !== 'eligible' || value.freeBusyDisposition !== 'eligible')
  ) {
    return 'Capacity or provider free/busy is not explicitly eligible.';
  }
  if (value.kind === 'weather_policy') {
    if (value.policyDisposition !== 'eligible') {
      return 'Weather policy is not explicitly eligible.';
    }
  }
  if (
    value.kind === 'route' &&
    (value.routeDisposition !== 'eligible' || !value.routeFeasible || value.violations.length > 0)
  ) {
    return 'Route evidence is infeasible, ineligible, or has violations.';
  }
  return undefined;
}

function isCurrentlyRelevant(
  value: ParsedPrerequisite,
  request: OfficeRunRequest,
  target: SchedulingTarget,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  const checkedAt = timestamp(value.checkedAt);
  const validUntil = timestamp(value.validUntil);
  return (
    value.companyId === request.companyId &&
    value.jobId === target.jobId &&
    windowsMatch(value.window, target.window) &&
    checkedAt !== undefined &&
    validUntil !== undefined &&
    checkedAt <= nowMs + CLOCK_SKEW_MS &&
    nowMs - checkedAt <= maxAgeMs &&
    validUntil > nowMs
  );
}

export function evaluateSchedulingPrerequisites(options: {
  request: OfficeRunRequest;
  proposal: ActionProposal;
  now?: Date;
}): SchedulingPrerequisiteDecision {
  const requirement = targetFor(options.request.agent, options.proposal);
  if (!requirement.required) return { required: false, eligible: true };
  if (!requirement.target) {
    return deny(requirement.reason ?? 'Scheduling target is unknown.');
  }

  const nowMs = (options.now ?? new Date()).getTime();
  const targetStart = timestamp(requirement.target.window.start);
  const targetEnd = timestamp(requirement.target.window.end);
  if (
    targetStart === undefined ||
    targetEnd === undefined ||
    targetStart <= nowMs ||
    targetEnd <= targetStart
  ) {
    return deny('The proposed booking window must be valid and in the future.');
  }

  if (requirement.proof === 'confirmed_booking') {
    const bookingFacts = options.request.trustedFacts.filter(
      (fact) => fact.name === schedulingBookingConfirmationFactName,
    );
    const citedIds = new Set(options.proposal.sourceFactIds);
    const cited = bookingFacts.filter((fact) => citedIds.has(fact.id));
    if (cited.length !== 1) {
      return deny(
        'A booking confirmation must cite exactly one consumed receipt and current local visit.',
      );
    }
    const fact = cited[0];
    if (!fact || fact.source !== 'database') {
      return deny('Booking confirmation state must come from the current database projection.');
    }
    const parsed = bookingConfirmationFactSchema.safeParse(fact.value);
    if (!parsed.success) {
      return deny('Booking confirmation state is malformed or not locally scheduled.');
    }
    const value = parsed.data;
    if (
      value.companyId !== options.request.companyId ||
      value.jobId !== requirement.target.jobId ||
      !windowsMatch(value.window, requirement.target.window)
    ) {
      return deny('Booking confirmation state does not bind the exact company, job, and window.');
    }
    if (
      bookingFacts.some((candidate) => {
        if (candidate.id === fact.id) return false;
        const other = bookingConfirmationFactSchema.safeParse(candidate.value);
        return other.success && other.data.jobId === requirement.target?.jobId;
      })
    ) {
      return deny('The job has conflicting current booking confirmation facts.');
    }
    return {
      required: true,
      eligible: true,
      target: requirement.target,
      evidenceFactIds: [fact.id],
      evidenceMode: value.evidenceMode,
    };
  }

  const citedIds = new Set(options.proposal.sourceFactIds);
  const accepted: Array<{ fact: TrustedFact; value: ParsedPrerequisite }> = [];

  for (const definition of prerequisiteDefinitions) {
    const namedFacts = options.request.trustedFacts.filter((fact) => fact.name === definition.name);
    const citedFacts = namedFacts.filter((fact) => citedIds.has(fact.id));
    if (citedFacts.length !== 1) {
      return deny(`The action must cite exactly one ${definition.label} eligibility receipt.`);
    }
    const fact = citedFacts[0];
    if (!fact) return deny(`${definition.label} evidence is missing.`);
    const parsed = definition.schema.safeParse(fact.value);
    if (!parsed.success) {
      return deny(`${definition.label} evidence is malformed or has an unknown state.`);
    }
    const value = parsed.data as ParsedPrerequisite;
    const problem =
      commonProblem({
        request: options.request,
        fact,
        value,
        target: requirement.target,
        maxAgeMs: definition.maxAgeMs,
        nowMs,
      }) ?? providerProblem(value);
    if (problem) return deny(`${definition.label}: ${problem}`);

    for (const candidateFact of namedFacts) {
      const candidate = definition.schema.safeParse(candidateFact.value);
      if (
        !candidate.success ||
        !isCurrentlyRelevant(
          candidate.data as ParsedPrerequisite,
          options.request,
          requirement.target,
          nowMs,
          definition.maxAgeMs,
        )
      ) {
        continue;
      }
      const candidateValue = candidate.data as ParsedPrerequisite;
      if (
        candidateValue.eligibility !== 'eligible' ||
        candidateValue.unknowns.length > 0 ||
        candidateValue.conflicts.length > 0 ||
        candidateValue.evidenceMode !== value.evidenceMode ||
        providerProblem(candidateValue)
      ) {
        return deny(`${definition.label} evidence has a fresh conflicting receipt.`);
      }
    }
    accepted.push({ fact, value });
  }

  const evidenceModes = new Set(accepted.map(({ value }) => value.evidenceMode));
  if (evidenceModes.size !== 1) {
    return deny('Scheduling evidence mixes live-provider and sandbox receipts.');
  }
  if (new Set(accepted.map(({ value }) => value.receiptId)).size !== 1) {
    return deny('Scheduling evidence does not come from one exact persisted receipt.');
  }
  const evidenceMode = accepted[0]?.value.evidenceMode;
  if (!evidenceMode) return deny('Scheduling evidence is incomplete.');

  return {
    required: true,
    eligible: true,
    target: requirement.target,
    evidenceFactIds: accepted.map(({ fact }) => fact.id),
    evidenceMode,
  };
}
