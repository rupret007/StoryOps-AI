import type { RoutePlan } from '../../../src/core/integrations/contracts.ts';
import {
  committedVisitRoutingJob,
  crewDayRouteViolations,
  targetRoutingJob,
  type CommittedVisitRouteContext,
} from './routeContext.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
}

const crewId = '10000000-0000-4000-8000-000000000601';
const targetJobId = '10000000-0000-4000-8000-000000000631';
const location = { latitude: 32.7767, longitude: -96.797 };
const prior: CommittedVisitRouteContext = {
  routingJobId: 'visit:prior',
  visitId: 'prior',
  visitVersion: 3,
  visitStatus: 'confirmed',
  jobId: 'job-prior',
  jobVersion: 5,
  propertyId: 'property-prior',
  propertyVersion: 2,
  startsAt: '2026-08-03T13:00:00.000Z',
  endsAt: '2026-08-03T14:00:00.000Z',
  location,
  geocodedAt: '2026-07-29T12:00:00.000Z',
};
const following: CommittedVisitRouteContext = {
  ...prior,
  routingJobId: 'visit:following',
  visitId: 'following',
  jobId: 'job-following',
  propertyId: 'property-following',
  startsAt: '2026-08-03T15:00:00.000Z',
  endsAt: '2026-08-03T16:00:00.000Z',
};
const expectedJobs = [
  committedVisitRoutingJob(prior),
  targetRoutingJob({
    jobId: targetJobId,
    location: { latitude: 33.749, longitude: -84.388 },
    window: {
      start: '2026-08-03T14:15:00.000Z',
      end: '2026-08-03T14:45:00.000Z',
    },
  }),
  committedVisitRoutingJob(following),
];

Deno.test('a free time slot that cannot fit travel between adjacent visits fails closed', () => {
  const plan: RoutePlan = {
    provider: 'vroom',
    mode: 'live',
    routes: [
      {
        vehicleId: crewId,
        jobIds: ['visit:prior', 'visit:following'],
        travelSeconds: 1_200,
        serviceSeconds: 7_200,
        distanceMeters: 20_000,
      },
    ],
    unassignedJobIds: [`candidate:${targetJobId}`],
    summary: {
      travelSeconds: 1_200,
      serviceSeconds: 7_200,
      distanceMeters: 20_000,
    },
  };

  const violations = crewDayRouteViolations({
    routePlan: plan,
    crewId,
    expectedJobs,
    targetJobId,
  });
  assert(violations.length > 0);
  assert(violations.some((violation) => violation.includes('every committed crew-day stop')));
});

Deno.test('the exact full crew-day route is accepted', () => {
  const ids = expectedJobs.map((job) => job.id);
  const serviceSeconds = expectedJobs.reduce((total, job) => total + job.serviceSeconds, 0);
  const plan: RoutePlan = {
    provider: 'vroom',
    mode: 'live',
    routes: [
      {
        vehicleId: crewId,
        jobIds: ids,
        travelSeconds: 1_200,
        serviceSeconds,
        distanceMeters: 20_000,
      },
    ],
    unassignedJobIds: [],
    summary: {
      travelSeconds: 1_200,
      serviceSeconds,
      distanceMeters: 20_000,
    },
  };

  assert(
    crewDayRouteViolations({
      routePlan: plan,
      crewId,
      expectedJobs,
      targetJobId,
    }).length === 0,
  );
});
