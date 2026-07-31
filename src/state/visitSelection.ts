import type { DemoState, LiveFieldVisitReference } from './model';

export interface RoleScopedVisitCandidate {
  id: string;
  status: string;
  startsAt?: string;
  endsAt?: string;
}

export interface ReadyDispatchJobCandidate {
  id: string;
  status: string;
}

const activeVisitStatusPriority = new Map([
  ['on_site', 0],
  ['paused', 1],
  ['en_route', 2],
]);

const unavailableVisitStatuses = new Set(['cancelled', 'completed', 'complete']);

function timestamp(value?: string): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

function localDateKey(value: string, timeZone: string): string | undefined {
  const parsed = timestamp(value);
  if (!Number.isFinite(parsed)) return undefined;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(parsed));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  return year && month && day ? `${year}-${month}-${day}` : undefined;
}

function byStartThenId(left: RoleScopedVisitCandidate, right: RoleScopedVisitCandidate): number {
  const leftStart = timestamp(left.startsAt);
  const rightStart = timestamp(right.startsAt);
  if (Number.isFinite(leftStart) && Number.isFinite(rightStart) && leftStart !== rightStart) {
    return leftStart - rightStart;
  }
  if (Number.isFinite(leftStart) !== Number.isFinite(rightStart)) {
    return Number.isFinite(leftStart) ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Chooses one visit only from the already role/assignment-scoped server
 * projection. An explicit visible selection survives refresh; otherwise active
 * field work wins, followed by today's work and the next future visit.
 */
export function selectRoleScopedVisitId(
  candidates: readonly RoleScopedVisitCandidate[],
  input: {
    preferredVisitId?: string;
    serverTime: string;
    timeZone: string;
  },
): string | undefined {
  const visibleById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  if (input.preferredVisitId && visibleById.has(input.preferredVisitId)) {
    return input.preferredVisitId;
  }
  if (candidates.length === 0) return undefined;

  const active = candidates
    .filter((candidate) => activeVisitStatusPriority.has(candidate.status))
    .sort((left, right) => {
      const priority =
        (activeVisitStatusPriority.get(left.status) ?? 99) -
        (activeVisitStatusPriority.get(right.status) ?? 99);
      return priority || byStartThenId(left, right);
    });
  if (active[0]) return active[0].id;

  const serverTimestamp = timestamp(input.serverTime);
  const todayKey = localDateKey(input.serverTime, input.timeZone);
  const available = candidates.filter(
    (candidate) => !unavailableVisitStatuses.has(candidate.status),
  );
  const today = available
    .filter(
      (candidate) =>
        todayKey !== undefined &&
        candidate.startsAt !== undefined &&
        localDateKey(candidate.startsAt, input.timeZone) === todayKey,
    )
    .sort(byStartThenId);
  if (today[0]) return today[0].id;

  const upcoming = available
    .filter((candidate) => {
      const start = timestamp(candidate.startsAt);
      return Number.isFinite(start) && Number.isFinite(serverTimestamp) && start >= serverTimestamp;
    })
    .sort(byStartThenId);
  if (upcoming[0]) return upcoming[0].id;

  return [...candidates]
    .sort((left, right) => {
      const order = byStartThenId(right, left);
      return order || right.id.localeCompare(left.id);
    })
    .at(0)?.id;
}

export function selectReadyDispatchJobId(
  candidates: readonly ReadyDispatchJobCandidate[],
  preferredJobId?: string,
): string | undefined {
  const ready = candidates.filter((candidate) => candidate.status === 'ready_to_schedule');
  if (preferredJobId && ready.some((candidate) => candidate.id === preferredJobId)) {
    return preferredJobId;
  }
  return ready[0]?.id;
}

function sameChecklistScope(
  references: LiveFieldVisitReference['checklistItems'],
  visitId: string,
): boolean {
  return Object.values(references).every(
    (reference) => reference.id.length > 0 && reference.visitId === visitId,
  );
}

function snapshotCurrentReference(
  state: DemoState,
): Record<string, LiveFieldVisitReference> | undefined {
  const live = state.live;
  const selectedVisitId = state.selectedVisitId;
  const references = live?.fieldVisitReferences;
  const existing = selectedVisitId ? references?.[selectedVisitId] : undefined;
  if (
    !live ||
    !references ||
    !selectedVisitId ||
    !existing ||
    live.fieldPacketVisitId !== selectedVisitId ||
    live.visit?.id !== selectedVisitId ||
    !live.job ||
    live.jobId !== live.job.id ||
    existing.jobId !== live.job.id ||
    !live.propertyId ||
    existing.propertyId !== live.propertyId ||
    !sameChecklistScope(live.checklistItems, selectedVisitId)
  ) {
    return references;
  }
  return {
    ...references,
    [selectedVisitId]: {
      ...existing,
      visit: live.visit,
      visitStatus: live.visitStatus ?? existing.visitStatus,
      visitStartsAt: live.visitStartsAt,
      visitEndsAt: live.visitEndsAt,
      job: live.job,
      jobId: live.job.id,
      jobStatus: live.jobStatus,
      jobEstimatedDurationMinutes: live.jobEstimatedDurationMinutes,
      jobAssignedCrewId: live.jobAssignedCrewId,
      customerId: live.customerId,
      propertyId: live.propertyId,
      activeTimeEntry: live.activeTimeEntry,
      checklistItems: live.checklistItems,
      onMyWayDelivery: live.onMyWayDelivery,
    },
  };
}

/**
 * Switches an already cached, role-scoped field workspace to one exact visit.
 * The direct mutation references are replaced as a unit, while the visit's
 * media and material packet are selected through `DemoState.selectedVisitId`.
 */
export function applyCachedRoleScopedVisitSelection(
  state: DemoState,
  visitId: string,
): DemoState | undefined {
  const visit = state.visits.find((candidate) => candidate.id === visitId);
  const live = state.live;
  const references = snapshotCurrentReference(state);
  const reference = references?.[visitId];
  if (
    !visit ||
    !live ||
    !reference ||
    reference.visit.id !== visitId ||
    reference.job.id !== reference.jobId ||
    !reference.propertyId ||
    !sameChecklistScope(reference.checklistItems, visitId)
  ) {
    return undefined;
  }

  return {
    ...state,
    selectedVisitId: visitId,
    live: {
      ...live,
      fieldVisitReferences: references,
      visit: reference.visit,
      fieldPacketVisitId: visitId,
      visitStatus: reference.visitStatus,
      visitStartsAt: reference.visitStartsAt,
      visitEndsAt: reference.visitEndsAt,
      onMyWayDelivery: reference.onMyWayDelivery,
      job: reference.job,
      jobStatus: reference.jobStatus,
      jobId: reference.jobId,
      jobEstimatedDurationMinutes: reference.jobEstimatedDurationMinutes,
      jobAssignedCrewId: reference.jobAssignedCrewId,
      customerId: reference.customerId,
      propertyId: reference.propertyId,
      activeTimeEntry: reference.activeTimeEntry,
      checklistItems: reference.checklistItems,
    },
  };
}
