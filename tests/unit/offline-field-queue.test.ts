import { describe, expect, it, vi } from 'vitest';
import {
  commandMutation,
  mediaUploadMutation,
  normalizeOfflineQueueAfterHydration,
  replayOfflineQueue,
} from '@/state/offlineFieldQueue';
import {
  blobArrayBuffer,
  buildStoryOpsCommand,
  sha256Hex,
  type PreparedVisitMedia,
} from '@/state/liveRepository';

const visitId = '10000000-0000-4000-8000-000000000641';
const assetId = '96000000-0000-4000-8000-000000000811';

async function media(): Promise<PreparedVisitMedia> {
  const blob = new Blob(['offline bytes'], { type: 'image/png' });
  const checksumSha256 = await sha256Hex(await blobArrayBuffer(blob));
  return {
    assetId,
    visitId,
    blob,
    filename: 'before.png',
    contentType: 'image/png',
    objectPath: `10000000-0000-4000-8000-000000000001/visits/${visitId}/${assetId}-${checksumSha256.slice(0, 16)}-before.png`,
    checksumSha256,
    byteSize: blob.size,
    capturedAt: '2026-07-28T12:00:00.000Z',
  };
}

describe('live offline field queue', () => {
  it('replays media upload, registration, signature, and completion in dependency order', async () => {
    const captured = await media();
    const uploadId = '96000000-0000-4000-8000-000000000901';
    const register = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000902',
      commandType: 'media.register',
      expectedVersion: 0,
      payload: {
        entityId: assetId,
        visitId,
        objectPath: captured.objectPath,
        checksumSha256: captured.checksumSha256,
      },
    });
    const signature = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000903',
      commandType: 'signature.capture',
      expectedVersion: 0,
      payload: { entityId: '96000000-0000-4000-8000-000000000813', visitId },
    });
    const completion = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000904',
      commandType: 'visit.transition',
      expectedVersion: 7,
      payload: { entityId: visitId, status: 'completed' },
    });
    const queue = [
      mediaUploadMutation(uploadId, captured, captured.capturedAt),
      commandMutation(register, captured.capturedAt, [uploadId]),
      commandMutation(signature, captured.capturedAt, [register.commandId]),
      commandMutation(completion, captured.capturedAt, [signature.commandId]),
    ];
    const order: string[] = [];

    const result = await replayOfflineQueue(queue, {
      uploadMedia: vi.fn(async () => {
        order.push('upload');
      }),
      executeCommand: vi.fn(async (command) => {
        order.push(command.commandType);
      }),
    });

    expect(result).toMatchObject({ queue: [], confirmed: 4 });
    expect(result.failure).toBeUndefined();
    expect(order).toEqual(['upload', 'media.register', 'signature.capture', 'visit.transition']);
  });

  it('retains confirmed dependencies and the exact conflicting command for safe retry', async () => {
    const captured = await media();
    const uploadId = '96000000-0000-4000-8000-000000000905';
    const register = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000906',
      commandType: 'media.register',
      expectedVersion: 0,
      payload: { entityId: assetId, visitId, checksumSha256: captured.checksumSha256 },
    });
    const queue = [
      mediaUploadMutation(uploadId, captured, captured.capturedAt),
      commandMutation(register, captured.capturedAt, [uploadId]),
    ];
    const first = await replayOfflineQueue(queue, {
      uploadMedia: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockRejectedValue(new Error('Media version conflict')),
    });

    expect(first.confirmed).toBe(1);
    expect(first.queue.map((item) => item.status)).toEqual(['synced', 'failed']);
    expect(first.queue[1]?.command).toEqual(register);

    const uploadMedia = vi.fn();
    const retry = await replayOfflineQueue(first.queue, {
      uploadMedia,
      executeCommand: vi.fn().mockResolvedValue(undefined),
    });
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(retry).toMatchObject({ queue: [], confirmed: 1 });
  });

  it('recovers an interrupted syncing marker after reload and fails closed on missing dependencies', async () => {
    const command = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000907',
      commandType: 'visit.notes.update',
      expectedVersion: 4,
      payload: { entityId: visitId, notes: 'Exact offline note.' },
    });
    const [hydrated] = normalizeOfflineQueueAfterHydration([
      {
        ...commandMutation(command, '2026-07-28T12:00:00.000Z', [
          '96000000-0000-4000-8000-000000000999',
        ]),
        status: 'syncing',
      },
    ]);
    expect(hydrated?.status).toBe('queued');

    const result = await replayOfflineQueue(hydrated ? [hydrated] : [], {
      uploadMedia: vi.fn(),
      executeCommand: vi.fn(),
    });
    expect(result.failure?.message).toMatch(/missing dependency/u);
    expect(result.queue[0]).toMatchObject({
      status: 'failed',
      command,
    });
  });
});
