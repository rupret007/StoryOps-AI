import type {
  RoutePlan,
  RoutingJob,
  WeatherForecast,
} from '../../../src/core/integrations/contracts.ts';
import {
  dispatchCanonicalSha256,
  dispatchClearanceReceiptSchema,
  dispatchClearanceRequestSchema,
  dispatchClearanceResponseSchema,
  dispatchReceiptMatchesRequest,
  dispatchRoutingJobId,
  evaluateDispatchRoute,
  evaluateDispatchWeather,
  resolveDispatchClearanceMode,
} from './contracts.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
}

const companyId = '10000000-0000-4000-8000-000000000001';
const visitId = '10000000-0000-4000-8000-000000000701';
const crewId = '10000000-0000-4000-8000-000000000601';
const request = dispatchClearanceRequestSchema.parse({
  companyId,
  visitId,
  expectedVisitVersion: 4,
  currentOrigin: {
    schemaVersion: 'storyops-dispatch-current-origin-v1',
    readingId: '10000000-0000-4000-8000-000000000801',
    source: 'device_geolocation',
    coordinates: { latitude: 32.781, longitude: -96.81 },
    observedAt: '2026-07-30T14:59:55.000Z',
    accuracyMeters: 18,
    consent: {
      kind: 'explicit_user_action',
      disclosureVersion: 'storyops-dispatch-origin-consent-v1',
      capturedAt: '2026-07-30T15:00:00.000Z',
    },
  },
  idempotencyKey: `dispatch:${visitId}:v4:origin:10000000-0000-4000-8000-000000000801`,
});

Deno.test('dispatch clearance request and activation are finite and dual-switched', () => {
  assert(dispatchClearanceRequestSchema.safeParse(request).success);
  assert(
    !dispatchClearanceRequestSchema.safeParse({
      ...request,
      claimedWeather: 'clear',
    }).success,
  );
  assert(
    !dispatchClearanceRequestSchema.safeParse({
      ...request,
      currentOrigin: {
        ...request.currentOrigin,
        accuracyMeters: 100.01,
      },
    }).success,
  );
  assert(
    resolveDispatchClearanceMode({
      DISPATCH_CLEARANCE_MODE: 'live',
      DISPATCH_CLEARANCE_LIVE_ENABLED: 'true',
    }) === 'live',
  );
  for (const environment of [
    {},
    {
      DISPATCH_CLEARANCE_MODE: 'live',
      DISPATCH_CLEARANCE_LIVE_ENABLED: 'false',
    },
    {
      DISPATCH_CLEARANCE_MODE: 'sandbox',
      DISPATCH_CLEARANCE_LIVE_ENABLED: 'true',
    },
  ]) {
    assert(resolveDispatchClearanceMode(environment) !== 'live');
  }
});

Deno.test('sandbox, disabled, and receipt-free success can never claim clearance', () => {
  const blocked = {
    operation: 'visit.dispatch_clearance.refresh',
    mode: 'sandbox',
    status: 'blocked',
    cleared: false,
    reasonCode: 'LIVE_DISPATCH_CLEARANCE_DISABLED',
    message: 'No live provider evidence was created.',
    companyId,
    visitId,
    visitVersion: 4,
  };
  assert(dispatchClearanceResponseSchema.safeParse(blocked).success);
  assert(
    !dispatchClearanceResponseSchema.safeParse({
      ...blocked,
      status: 'cleared',
      cleared: true,
      reasonCode: 'LIVE_DISPATCH_CLEARANCE_READY',
    }).success,
  );
});

Deno.test(
  'fresh and replay paths accept opaque DB verifiers but require the exact origin envelope',
  async () => {
    const rawOriginHash = await dispatchCanonicalSha256(request.currentOrigin);
    const opaqueOriginMac = 'f'.repeat(64);
    const opaqueRequestMac = 'e'.repeat(64);
    assert(rawOriginHash !== opaqueOriginMac);
    const receipt = dispatchClearanceReceiptSchema.parse({
      schemaVersion: 'storyops-dispatch-clearance-v2',
      receiptId: '10000000-0000-4000-8000-000000000901',
      companyId,
      visitId,
      visitVersion: 4,
      jobId: '10000000-0000-4000-8000-000000000702',
      jobVersion: 2,
      propertyId: '10000000-0000-4000-8000-000000000703',
      propertyVersion: 3,
      crewId,
      crewVersion: 2,
      startsAt: '2026-07-30T15:00:00.000Z',
      endsAt: '2026-07-30T16:00:00.000Z',
      evidenceMode: 'live',
      configurationRevision: 5,
      configurationHash: 'a'.repeat(64),
      operatingBaselinePublicationId: '10000000-0000-4000-8000-000000000704',
      operatingBaselineHash: 'b'.repeat(64),
      schedulingEvidenceReceiptId: '10000000-0000-4000-8000-000000000705',
      providerSnapshotHash: 'c'.repeat(64),
      currentOrigin: request.currentOrigin,
      currentOriginHash: opaqueOriginMac,
      currentOriginExpiresAt: '2026-07-30T15:01:55.000Z',
      routeCheckId: '10000000-0000-4000-8000-000000000706',
      routeDisposition: 'eligible',
      routeObservedAt: '2026-07-30T15:00:00.000Z',
      routeExpiresAt: '2026-07-30T15:10:00.000Z',
      weatherCheckId: '10000000-0000-4000-8000-000000000707',
      weatherDisposition: 'eligible',
      weatherObservedAt: '2026-07-30T15:00:00.000Z',
      weatherExpiresAt: '2026-07-30T15:20:00.000Z',
      unknowns: [],
      conflicts: [],
      expiresAt: '2026-07-30T15:01:55.000Z',
      evidenceHash: 'd'.repeat(64),
      requestHash: opaqueRequestMac,
      createdAt: '2026-07-30T15:00:00.000Z',
      replayed: false,
    });

    for (const replayed of [false, true]) {
      assert(
        dispatchReceiptMatchesRequest({
          receipt: { ...receipt, replayed },
          companyId,
          visitId,
          visitVersion: 4,
          currentOrigin: request.currentOrigin,
        }),
      );
    }
    assert(
      !dispatchReceiptMatchesRequest({
        receipt,
        companyId,
        visitId,
        visitVersion: 4,
        currentOrigin: {
          ...request.currentOrigin,
          coordinates: {
            ...request.currentOrigin.coordinates,
            longitude: -96.8101,
          },
        },
      }),
    );
  },
);

const routingJob: RoutingJob = {
  id: dispatchRoutingJobId(visitId),
  location: { latitude: 32.7767, longitude: -96.797 },
  serviceSeconds: 3_600,
  timeWindows: [
    {
      start: '2026-07-30T15:00:00.000Z',
      end: '2026-07-30T15:00:00.000Z',
    },
  ],
};

function liveRoutePlan(): RoutePlan {
  return {
    provider: 'vroom',
    mode: 'live',
    routes: [
      {
        vehicleId: crewId,
        jobIds: [routingJob.id],
        travelSeconds: 900,
        serviceSeconds: 3_600,
        distanceMeters: 12_500,
      },
    ],
    unassignedJobIds: [],
    summary: {
      travelSeconds: 900,
      serviceSeconds: 3_600,
      distanceMeters: 12_500,
    },
  };
}

Deno.test('only an exact all-assigned live VROOM route is eligible', () => {
  assert(
    evaluateDispatchRoute({
      routePlan: liveRoutePlan(),
      crewId,
      routingJob,
    }).eligible,
  );
  assert(
    !evaluateDispatchRoute({
      routePlan: { ...liveRoutePlan(), mode: 'sandbox' },
      crewId,
      routingJob,
    }).eligible,
  );
  assert(
    !evaluateDispatchRoute({
      routePlan: {
        ...liveRoutePlan(),
        routes: [],
        unassignedJobIds: [routingJob.id],
      },
      crewId,
      routingJob,
    }).eligible,
  );
});

const now = new Date('2026-07-30T14:45:00.000Z');
const window = {
  start: '2026-07-30T15:00:00.000Z',
  end: '2026-07-30T16:00:00.000Z',
};
const policy = {
  minimumTemperatureF: 40,
  maximumTemperatureF: 105,
  maximumWindSpeedMph: 20,
  maximumPrecipitationProbability: 0.5,
  prohibitedLightningRisks: ['elevated', 'severe', 'unknown'],
};

function liveForecast(): WeatherForecast {
  return {
    provider: 'nws',
    mode: 'live',
    office: 'FWD',
    issuedAt: '2026-07-30T13:30:00.000Z',
    observedAt: '2026-07-30T14:44:00.000Z',
    periods: [
      {
        start: window.start,
        end: window.end,
        temperatureF: 82,
        precipitationProbability: 10,
        windMph: 8,
        shortForecast: 'Mostly Sunny',
      },
    ],
    alerts: [],
    unknowns: [],
  };
}

Deno.test('NWS evidence must be current, complete, known, and policy-eligible', () => {
  assert(
    evaluateDispatchWeather({
      forecast: liveForecast(),
      policy,
      window,
      now,
    }).eligible,
  );
  assert(
    !evaluateDispatchWeather({
      forecast: {
        ...liveForecast(),
        observedAt: '2026-07-30T14:30:00.000Z',
      },
      policy,
      window,
      now,
    }).eligible,
  );
  assert(
    !evaluateDispatchWeather({
      forecast: {
        ...liveForecast(),
        periods: [{ ...liveForecast().periods[0], windMph: null }],
      },
      policy,
      window,
      now,
    }).eligible,
  );
  const hold = evaluateDispatchWeather({
    forecast: {
      ...liveForecast(),
      alerts: [
        {
          severity: 'Severe',
          event: 'Severe Thunderstorm Warning',
          headline: 'Lightning and severe winds expected',
        },
      ],
    },
    policy,
    window,
    now,
  });
  assert(!hold.eligible);
  assert(hold.reasonCode === 'WEATHER_POLICY_HOLD');
});
