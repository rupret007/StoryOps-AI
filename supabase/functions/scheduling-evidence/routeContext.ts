import type {
  Coordinates,
  RoutePlan,
  RoutingJob,
  TimeWindow,
} from '../../../src/core/integrations/contracts.ts';

export const MAX_COMMITTED_ROUTE_VISITS = 50;

export type CommittedVisitRouteContext = {
  routingJobId: string;
  visitId: string;
  visitVersion: number;
  visitStatus: string;
  jobId: string;
  jobVersion: number;
  propertyId: string;
  propertyVersion: number;
  startsAt: string;
  endsAt: string;
  location: Coordinates;
  geocodedAt: string;
};

export function candidateRoutingJobId(jobId: string): string {
  return `candidate:${jobId}`;
}

export function visitRoutingJobId(visitId: string): string {
  return `visit:${visitId}`;
}

function serviceSeconds(window: TimeWindow): number {
  return Math.round((Date.parse(window.end) - Date.parse(window.start)) / 1_000);
}

export function committedVisitRoutingJob(visit: CommittedVisitRouteContext): RoutingJob {
  return {
    id: visit.routingJobId,
    location: visit.location,
    serviceSeconds: serviceSeconds({
      start: visit.startsAt,
      end: visit.endsAt,
    }),
    // Existing visits are immutable route anchors for this decision. VROOM
    // must start their service at the committed instant, not merely somewhere
    // inside the visit duration.
    timeWindows: [{ start: visit.startsAt, end: visit.startsAt }],
  };
}

export function targetRoutingJob(options: {
  jobId: string;
  location: Coordinates;
  window: TimeWindow;
}): RoutingJob {
  return {
    id: candidateRoutingJobId(options.jobId),
    location: options.location,
    serviceSeconds: serviceSeconds(options.window),
    timeWindows: [{ start: options.window.start, end: options.window.start }],
  };
}

export function exactCrewRouteViolations(options: {
  routePlan: RoutePlan;
  crewId: string;
  expectedJobs: RoutingJob[];
  requiredRoutingJobId?: string;
}): string[] {
  const { routePlan, crewId, expectedJobs, requiredRoutingJobId } = options;
  const violations: string[] = [];
  const route = routePlan.routes.find((candidate) => candidate.vehicleId === crewId);
  const expectedIds = expectedJobs.map((job) => job.id);
  const expectedIdSet = new Set(expectedIds);
  const routedIds = route?.jobIds ?? [];

  if (routePlan.provider !== 'vroom' || routePlan.mode !== 'live') {
    violations.push('Routing evidence did not come from live VROOM.');
  }
  if (!route || routePlan.routes.length !== 1) {
    violations.push('VROOM did not return exactly one selected-crew route.');
  }
  if (requiredRoutingJobId && !route?.jobIds.includes(requiredRoutingJobId)) {
    violations.push('VROOM did not assign the target job to the selected crew.');
  }
  if (routePlan.unassignedJobIds.length > 0) {
    violations.push('VROOM could not assign every committed crew-day stop.');
  }
  if (
    routedIds.length !== expectedIds.length ||
    new Set(routedIds).size !== expectedIds.length ||
    routedIds.some((id) => !expectedIdSet.has(id))
  ) {
    violations.push('VROOM did not preserve the exact committed crew-day route set.');
  }
  const expectedServiceSeconds = expectedJobs.reduce((total, job) => total + job.serviceSeconds, 0);
  if (
    route &&
    (route.serviceSeconds !== expectedServiceSeconds ||
      routePlan.summary.serviceSeconds !== expectedServiceSeconds)
  ) {
    violations.push('VROOM changed deterministic visit service durations.');
  }
  return violations;
}

export function crewDayRouteViolations(options: {
  routePlan: RoutePlan;
  crewId: string;
  expectedJobs: RoutingJob[];
  targetJobId: string;
}): string[] {
  return exactCrewRouteViolations({
    routePlan: options.routePlan,
    crewId: options.crewId,
    expectedJobs: options.expectedJobs,
    requiredRoutingJobId: candidateRoutingJobId(options.targetJobId),
  });
}
