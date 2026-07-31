import type { OfflineMutation } from './model';
import type { PreparedVisitMedia, StoryOpsCommand } from './liveRepository';

const offlineFieldCommandTypes = new Set<StoryOpsCommand['commandType']>([
  'visit.notes.update',
  'checklist.record',
  'time.start',
  'time.stop',
  'material.record',
  'field.change_request',
  'signature.capture',
  'incident.report_pause',
]);

const offlineVisitTransitions = new Set(['on_site', 'paused', 'completed']);

/**
 * Offline replay is a field-continuity boundary, not a general delayed command
 * bus. Commercial, approval, customer, lead, incident-closure, and
 * notification decisions require a current online server decision.
 */
export function isOfflineFieldCommand(command: StoryOpsCommand): boolean {
  if (offlineFieldCommandTypes.has(command.commandType)) return true;
  return (
    command.commandType === 'visit.transition' &&
    typeof command.payload.status === 'string' &&
    offlineVisitTransitions.has(command.payload.status)
  );
}

type OfflineReplayHandlers = {
  executeCommand(command: StoryOpsCommand): Promise<unknown>;
  uploadMedia(media: PreparedVisitMedia): Promise<unknown>;
};

export interface OfflineReplayResult {
  queue: OfflineMutation[];
  confirmed: number;
  failure?: Error;
}

export function commandVisitScopeId(command: StoryOpsCommand): string | undefined {
  if (
    command.commandType === 'visit.transition' ||
    command.commandType === 'visit.notes.update' ||
    command.commandType === 'field.change_request'
  ) {
    return typeof command.payload.entityId === 'string' ? command.payload.entityId : undefined;
  }
  return typeof command.payload.visitId === 'string' ? command.payload.visitId : undefined;
}

export function commandMutation(
  command: StoryOpsCommand,
  createdAt: string,
  dependsOn: readonly string[] = [],
  scopeVisitId = commandVisitScopeId(command),
): OfflineMutation {
  return {
    id: command.commandId,
    idempotencyKey: command.commandId,
    action: command.commandType,
    entityId:
      typeof command.payload.entityId === 'string' ? command.payload.entityId : command.commandId,
    scopeVisitId,
    createdAt,
    status: 'queued',
    kind: 'command',
    dependsOn: [...dependsOn],
    attemptCount: 0,
    command,
  };
}

export function mediaUploadMutation(
  id: string,
  media: PreparedVisitMedia,
  createdAt: string,
  dependsOn: readonly string[] = [],
): OfflineMutation {
  return {
    id,
    idempotencyKey: `media-upload:${media.assetId}:${media.checksumSha256}`,
    action: 'media.upload',
    entityId: media.assetId,
    scopeVisitId: media.visitId,
    createdAt,
    status: 'queued',
    kind: 'media_upload',
    dependsOn: [...dependsOn],
    attemptCount: 0,
    mediaUpload: media,
  };
}

export function normalizeOfflineQueueAfterHydration(
  queue: readonly OfflineMutation[],
): OfflineMutation[] {
  return queue.map((mutation) => ({
    ...mutation,
    status: mutation.status === 'syncing' ? 'queued' : mutation.status,
    kind: mutation.kind ?? (mutation.command ? 'command' : undefined),
    dependsOn: Array.isArray(mutation.dependsOn) ? [...mutation.dependsOn] : [],
    attemptCount:
      Number.isInteger(mutation.attemptCount) && (mutation.attemptCount ?? 0) >= 0
        ? mutation.attemptCount
        : 0,
    scopeVisitId:
      mutation.scopeVisitId ??
      mutation.mediaUpload?.visitId ??
      (mutation.command ? commandVisitScopeId(mutation.command) : undefined),
  }));
}

export function chainOfflineMutationsByVisit(
  existing: readonly OfflineMutation[],
  additions: readonly OfflineMutation[],
): OfflineMutation[] {
  const previousByVisit = new Map<string, string>();
  for (const mutation of existing) {
    if (mutation.scopeVisitId) {
      previousByVisit.set(mutation.scopeVisitId, mutation.id);
    }
  }
  return additions.map((mutation) => {
    const dependencies = new Set(mutation.dependsOn ?? []);
    const previousId = mutation.scopeVisitId
      ? previousByVisit.get(mutation.scopeVisitId)
      : undefined;
    if (previousId) dependencies.add(previousId);
    const chained = { ...mutation, dependsOn: [...dependencies] };
    if (mutation.scopeVisitId) {
      previousByVisit.set(mutation.scopeVisitId, mutation.id);
    }
    return chained;
  });
}

export function prioritizeIncidentStopMutation(
  existing: readonly OfflineMutation[],
  incidentStop: OfflineMutation,
): OfflineMutation[] {
  if (incidentStop.command?.commandType !== 'incident.report_pause' || !incidentStop.scopeVisitId) {
    throw new Error('Safety priority requires one visit-scoped incident.report_pause command.');
  }
  const conflictingStop = existing.find(
    (mutation) =>
      mutation.scopeVisitId === incidentStop.scopeVisitId &&
      mutation.status !== 'synced' &&
      mutation.command?.commandType === 'incident.report_pause' &&
      mutation.id !== incidentStop.id,
  );
  if (conflictingStop) {
    throw new Error(
      'Another unconfirmed incident stop-work command already owns this visit queue.',
    );
  }
  if (existing.some((mutation) => mutation.id === incidentStop.id)) {
    return existing.map((mutation) => ({ ...mutation }));
  }

  const prioritizedStop = { ...incidentStop, dependsOn: [] };
  const retained = existing.map((mutation) => {
    if (mutation.scopeVisitId !== incidentStop.scopeVisitId || mutation.status === 'synced') {
      return { ...mutation };
    }
    return {
      ...mutation,
      dependsOn: [
        incidentStop.id,
        ...(mutation.dependsOn ?? []).filter((dependency) => dependency !== incidentStop.id),
      ],
    };
  });
  return [prioritizedStop, ...retained];
}

export function prioritizeIncidentEvidenceMutations(
  existing: readonly OfflineMutation[],
  additions: readonly OfflineMutation[],
): OfflineMutation[] {
  const upload = additions.find((mutation) => mutation.kind === 'media_upload');
  const registration = additions.find(
    (mutation) => mutation.command?.commandType === 'media.register',
  );
  const purpose = registration?.command?.payload.purpose;
  const incidentId = registration?.command?.payload.incidentId;
  if (
    additions.length !== 2 ||
    !upload?.mediaUpload ||
    !registration?.command ||
    !['incident', 'safety', 'damage'].includes(String(purpose)) ||
    typeof incidentId !== 'string' ||
    upload.mediaUpload.incidentId !== incidentId ||
    upload.scopeVisitId !== registration.scopeVisitId ||
    !registration.dependsOn?.includes(upload.id)
  ) {
    throw new Error(
      'Safety evidence priority requires one exact incident upload/finalizer packet.',
    );
  }
  const stopIndex = existing.findIndex(
    (mutation) =>
      mutation.scopeVisitId === upload.scopeVisitId &&
      mutation.status !== 'synced' &&
      mutation.command?.commandType === 'incident.report_pause',
  );
  if (stopIndex >= 0 && !upload.dependsOn?.includes(existing[stopIndex]!.id)) {
    throw new Error('Queued incident evidence must depend on the exact stop-work command.');
  }
  const firstVisitIndex = existing.findIndex(
    (mutation) => mutation.scopeVisitId === upload.scopeVisitId,
  );
  const insertionIndex =
    stopIndex >= 0 ? stopIndex + 1 : firstVisitIndex >= 0 ? firstVisitIndex : existing.length;
  return [
    ...existing.slice(0, insertionIndex).map((mutation) => ({ ...mutation })),
    ...additions.map((mutation) => ({ ...mutation })),
    ...existing.slice(insertionIndex).map((mutation) => ({ ...mutation })),
  ];
}

function trustedIncidentEvidencePurpose(value: unknown): boolean {
  return ['incident', 'safety', 'damage'].includes(String(value));
}

export function selectIncidentEvidenceReplayQueue(
  queue: readonly OfflineMutation[],
  visitId: string,
  allowedIncidentIds: ReadonlySet<string>,
): OfflineMutation[] {
  const selectedIds = new Set<string>();
  for (const registration of queue) {
    const command = registration.command;
    if (
      registration.scopeVisitId !== visitId ||
      command?.commandType !== 'media.register' ||
      command.payload.visitId !== visitId ||
      typeof command.payload.incidentId !== 'string' ||
      !allowedIncidentIds.has(command.payload.incidentId) ||
      !trustedIncidentEvidencePurpose(command.payload.purpose) ||
      command.payload.customerVisible !== false ||
      typeof command.payload.entityId !== 'string' ||
      typeof command.payload.objectPath !== 'string' ||
      typeof command.payload.checksumSha256 !== 'string'
    ) {
      continue;
    }
    const uploadDependencies = (registration.dependsOn ?? [])
      .map((dependency) => queue.find((mutation) => mutation.id === dependency))
      .filter((mutation): mutation is OfflineMutation => Boolean(mutation));
    if (uploadDependencies.length !== 1) continue;
    const upload = uploadDependencies[0]!;
    const media = upload.mediaUpload;
    if (
      upload.kind !== 'media_upload' ||
      upload.scopeVisitId !== visitId ||
      !media ||
      media.visitId !== visitId ||
      media.incidentId !== command.payload.incidentId ||
      media.assetId !== command.payload.entityId ||
      media.purpose !== command.payload.purpose ||
      media.objectPath !== command.payload.objectPath ||
      media.checksumSha256 !== command.payload.checksumSha256 ||
      media.contentType !== command.payload.contentType ||
      media.byteSize !== command.payload.byteSize ||
      media.capturedAt !== command.payload.capturedAt
    ) {
      continue;
    }
    selectedIds.add(upload.id);
    selectedIds.add(registration.id);
  }
  return queue
    .filter((mutation) => selectedIds.has(mutation.id))
    .map((mutation) => ({
      ...mutation,
      dependsOn: (mutation.dependsOn ?? []).filter((dependency) => selectedIds.has(dependency)),
    }));
}

export function mergeVisitReplayQueue(
  original: readonly OfflineMutation[],
  visitId: string,
  replayed: readonly OfflineMutation[],
  selectedMutationIds?: ReadonlySet<string>,
): OfflineMutation[] {
  const replayedById = new Map(replayed.map((mutation) => [mutation.id, mutation]));
  const merged = original.flatMap((mutation) => {
    if (
      mutation.scopeVisitId !== visitId ||
      (selectedMutationIds && !selectedMutationIds.has(mutation.id))
    ) {
      return [mutation];
    }
    const replacement = replayedById.get(mutation.id);
    return replacement ? [replacement] : [];
  });
  const originalIds = new Set(original.map((mutation) => mutation.id));
  return [...merged, ...replayed.filter((mutation) => !originalIds.has(mutation.id))];
}

function mutationError(mutation: OfflineMutation, message: string): Error {
  return new Error(`${mutation.action} (${mutation.id}) ${message}`);
}

export async function replayOfflineQueue(
  input: readonly OfflineMutation[],
  handlers: OfflineReplayHandlers,
  onProgress?: (queue: OfflineMutation[]) => void,
): Promise<OfflineReplayResult> {
  let queue = normalizeOfflineQueueAfterHydration(input);
  const knownIds = new Set(queue.map((mutation) => mutation.id));
  const confirmedIds = new Set(
    queue.filter((mutation) => mutation.status === 'synced').map((mutation) => mutation.id),
  );
  let confirmed = 0;

  for (const mutation of queue) {
    if (mutation.status === 'synced') continue;
    const missingDependency = (mutation.dependsOn ?? []).find(
      (dependency) => !knownIds.has(dependency),
    );
    const pendingDependency = (mutation.dependsOn ?? []).find(
      (dependency) => !confirmedIds.has(dependency),
    );
    if (missingDependency || pendingDependency) {
      const failure = mutationError(
        mutation,
        missingDependency
          ? `references missing dependency ${missingDependency}.`
          : `was reached before dependency ${pendingDependency} was durably confirmed.`,
      );
      queue = queue.map((item) =>
        item.id === mutation.id
          ? {
              ...item,
              status: 'failed',
              lastError: failure.message,
            }
          : item,
      );
      onProgress?.(queue);
      return { queue, confirmed, failure };
    }

    queue = queue.map((item) =>
      item.id === mutation.id
        ? {
            ...item,
            status: 'syncing',
            attemptCount: (item.attemptCount ?? 0) + 1,
            lastError: undefined,
          }
        : item,
    );
    onProgress?.(queue);
    try {
      const current = queue.find((item) => item.id === mutation.id);
      if (current?.kind === 'media_upload' && current.mediaUpload) {
        await handlers.uploadMedia(current.mediaUpload);
      } else if (current?.command) {
        if (
          current.command.commandType === 'visit.transition' &&
          current.command.payload.status === 'en_route'
        ) {
          throw mutationError(
            current,
            'requires a fresh online NWS/VROOM dispatch-clearance receipt and cannot replay from offline storage.',
          );
        }
        await handlers.executeCommand(current.command);
      } else {
        throw mutationError(current ?? mutation, 'does not contain a replayable payload.');
      }
      confirmed += 1;
      confirmedIds.add(mutation.id);
      queue = queue.map((item) =>
        item.id === mutation.id
          ? {
              ...item,
              status: 'synced',
              lastError: undefined,
            }
          : item,
      );
      onProgress?.(queue);
    } catch (error) {
      const failure = error instanceof Error ? error : mutationError(mutation, 'failed.');
      queue = queue.map((item) =>
        item.id === mutation.id
          ? {
              ...item,
              status: 'failed',
              lastError: failure.message,
            }
          : item,
      );
      onProgress?.(queue);
      return { queue, confirmed, failure };
    }
  }

  return { queue: [], confirmed };
}
