import {
  capacityEvidencePayloadSchema,
  companyWeatherPolicySchema,
  evaluateWeatherForecast,
  resolveSchedulingEvidenceActivation,
  schedulingEvidenceRequestSchema,
  schedulingEvidenceResponseSchema,
} from './contracts.ts';
import type { WeatherForecast } from '../../../src/core/integrations/contracts.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
}

const companyId = '10000000-0000-4000-8000-000000000001';
const jobId = '10000000-0000-4000-8000-000000000501';
const crewId = '10000000-0000-4000-8000-000000000601';
const request = {
  companyId,
  jobId,
  expectedJobVersion: 3,
  window: {
    start: '2026-07-30T14:00:00.000Z',
    end: '2026-07-30T16:00:00.000Z',
  },
  idempotencyKey: 'schedule:job-501:v3',
};

Deno.test('scheduling request is finite and permits authoritative crew selection', () => {
  assert(schedulingEvidenceRequestSchema.safeParse(request).success);
  assert(schedulingEvidenceRequestSchema.safeParse({ ...request, crewId }).success);
  assert(
    !schedulingEvidenceRequestSchema.safeParse({
      ...request,
      price: '1.00',
    }).success,
  );
  assert(
    !schedulingEvidenceRequestSchema.safeParse({
      ...request,
      window: {
        start: request.window.start,
        end: '2026-07-31T15:00:00.000Z',
      },
    }).success,
  );
});

Deno.test('scheduling worker requires two exact activation switches', () => {
  assert(
    resolveSchedulingEvidenceActivation({
      SCHEDULING_EVIDENCE_MODE: 'live',
      SCHEDULING_EVIDENCE_LIVE_ENABLED: 'true',
    }).runtimeMode === 'live',
  );
  for (const environment of [
    {},
    {
      SCHEDULING_EVIDENCE_MODE: 'live',
      SCHEDULING_EVIDENCE_LIVE_ENABLED: 'false',
    },
    {
      SCHEDULING_EVIDENCE_MODE: 'sandbox',
      SCHEDULING_EVIDENCE_LIVE_ENABLED: 'true',
    },
    {
      SCHEDULING_EVIDENCE_MODE: 'production',
      SCHEDULING_EVIDENCE_LIVE_ENABLED: 'true',
    },
  ]) {
    assert(resolveSchedulingEvidenceActivation(environment).runtimeMode !== 'live');
  }
});

const policy = companyWeatherPolicySchema.parse({
  minimumTemperatureF: '40',
  maximumTemperatureF: '105',
  maximumWindSpeedMph: '20',
  maximumPrecipitationProbability: '0.50',
  prohibitedLightningRisks: ['elevated', 'severe', 'unknown'],
});

Deno.test('weather evaluation normalizes NWS percentages and requires complete facts', () => {
  const forecast: WeatherForecast = {
    provider: 'nws',
    mode: 'live',
    office: 'FWD',
    issuedAt: '2026-07-29T12:00:00.000Z',
    observedAt: '2026-07-29T12:05:00.000Z',
    periods: [
      {
        start: '2026-07-30T14:00:00.000Z',
        end: '2026-07-30T15:00:00.000Z',
        temperatureF: 78,
        precipitationProbability: 20,
        windMph: 8,
        shortForecast: 'Mostly Sunny',
      },
      {
        start: '2026-07-30T15:00:00.000Z',
        end: '2026-07-30T16:00:00.000Z',
        temperatureF: 81,
        precipitationProbability: 30,
        windMph: 10,
        shortForecast: 'Partly Cloudy',
      },
    ],
    alerts: [],
    unknowns: [],
  };
  const eligible = evaluateWeatherForecast(forecast, policy, request.window);
  assert(eligible.disposition === 'eligible');
  assert(eligible.precipitationProbability === 0.3);
  assert(eligible.conditionCodes.includes('mostly_sunny'));

  const unknown = evaluateWeatherForecast(
    {
      ...forecast,
      periods: [{ ...forecast.periods[0], windMph: null }],
    },
    policy,
    request.window,
  );
  assert(unknown.disposition === 'unknown');
  assert(unknown.unknowns.length > 0);

  const approval = evaluateWeatherForecast(
    {
      ...forecast,
      periods: forecast.periods.map((period) => ({
        ...period,
        precipitationProbability: 80,
      })),
    },
    policy,
    request.window,
  );
  assert(approval.disposition === 'requires_approval');
});

Deno.test('only a reconciled live receipt can be reported bookable', () => {
  const common = {
    operation: 'scheduling.evidence',
    mode: 'live',
    status: 'ready_to_book',
    bookable: true,
    reasonCode: 'LIVE_EVIDENCE_READY',
    message: 'Ready.',
    companyId,
    jobId,
    jobVersion: 3,
    window: request.window,
    crewId,
  };
  assert(!schedulingEvidenceResponseSchema.safeParse(common).success);
  assert(
    !schedulingEvidenceResponseSchema.safeParse({
      ...common,
      mode: 'sandbox',
      receipt: {},
    }).success,
  );
  assert(
    schedulingEvidenceResponseSchema.safeParse({
      ...common,
      mode: 'sandbox',
      status: 'not_bookable',
      bookable: false,
      reasonCode: 'LIVE_SCHEDULING_DISABLED',
      message: 'No provider or scheduling mutation was attempted.',
      receipt: undefined,
    }).success,
  );
});

Deno.test('capacity payload matches the scheduling-evidence migration contract', () => {
  const valid = {
    schemaVersion: 'storyops-capacity-evidence-v1',
    companyId,
    jobId,
    propertyId: '10000000-0000-4000-8000-000000000401',
    crewId,
    mode: 'live',
    startsAt: request.window.start,
    endsAt: request.window.end,
    bufferedStartsAt: '2026-07-30T13:30:00.000Z',
    bufferedEndsAt: '2026-07-30T16:30:00.000Z',
    busy: false,
    readBackConfirmed: true,
    eventId: 'storyops-event',
    eventStatus: 'confirmed',
    eventEtag: '"etag-v1"',
    freeBusyObservedAt: '2026-07-29T12:00:00.000Z',
    capacity: {
      disposition: 'eligible',
      eligibleCrewIds: [crewId],
      requiredSkills: ['exterior-cleaning'],
      requiredEquipment: ['pressure-washer'],
      appointmentBufferMinutes: 30,
      unknowns: [],
      conflicts: [],
    },
    freeBusy: {
      provider: 'google_calendar',
      disposition: 'eligible',
      observedAt: '2026-07-29T12:00:00.000Z',
      requestedWindow: {
        start: '2026-07-30T13:30:00.000Z',
        end: '2026-07-30T16:30:00.000Z',
      },
      freeWindows: [
        {
          start: '2026-07-30T13:30:00.000Z',
          end: '2026-07-30T16:30:00.000Z',
        },
      ],
      sourceCalendarIds: ['operations@example.test'],
      unknowns: [],
      conflicts: [],
    },
  };
  assert(capacityEvidencePayloadSchema.safeParse(valid).success);
  assert(
    !capacityEvidencePayloadSchema.safeParse({
      ...valid,
      freeBusy: { ...valid.freeBusy, disposition: 'unknown' },
    }).success,
  );
  assert(
    !capacityEvidencePayloadSchema.safeParse({
      ...valid,
      capacity: { ...valid.capacity, eligibleCrewIds: [] },
    }).success,
  );
});
