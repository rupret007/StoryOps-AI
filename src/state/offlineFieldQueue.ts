import type { OfflineMutation } from './model';
import type { PreparedVisitMedia, StoryOpsCommand } from './liveRepository';

type OfflineReplayHandlers = {
  executeCommand(command: StoryOpsCommand): Promise<unknown>;
  uploadMedia(media: PreparedVisitMedia): Promise<unknown>;
};

export interface OfflineReplayResult {
  queue: OfflineMutation[];
  confirmed: number;
  failure?: Error;
}

export function commandMutation(
  command: StoryOpsCommand,
  createdAt: string,
  dependsOn: readonly string[] = [],
): OfflineMutation {
  return {
    id: command.commandId,
    idempotencyKey: command.commandId,
    action: command.commandType,
    entityId:
      typeof command.payload.entityId === 'string' ? command.payload.entityId : command.commandId,
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
  }));
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
