import { describe, expect, it, vi } from 'vitest';
import {
  chainOfflineMutationsByVisit,
  commandMutation,
  isOfflineFieldCommand,
  mediaUploadMutation,
  mergeVisitReplayQueue,
  normalizeOfflineQueueAfterHydration,
  prioritizeIncidentEvidenceMutations,
  prioritizeIncidentStopMutation,
  replayOfflineQueue,
  selectIncidentEvidenceReplayQueue,
} from '@/state/offlineFieldQueue';
import {
  blobArrayBuffer,
  buildStoryOpsCommand,
  sha256Hex,
  type PreparedVisitMedia,
  type StoryOpsCommand,
} from '@/state/liveRepository';

const visitId = '10000000-0000-4000-8000-000000000641';
const assetId = '96000000-0000-4000-8000-000000000811';

async function media(): Promise<PreparedVisitMedia> {
  const blob = new Blob(['offline bytes'], { type: 'image/png' });
  const checksumSha256 = await sha256Hex(await blobArrayBuffer(blob));
  return {
    assetId,
    visitId,
    purpose: 'before',
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
  it('allows only bounded field-continuity commands offline', async () => {
    const build = async (
      commandType: StoryOpsCommand['commandType'],
      payload: Record<string, unknown> = { entityId: crypto.randomUUID() },
    ) =>
      buildStoryOpsCommand({
        commandId: crypto.randomUUID(),
        commandType,
        expectedVersion: 1,
        payload,
      });

    for (const commandType of [
      'visit.notes.update',
      'checklist.record',
      'time.start',
      'time.stop',
      'material.record',
      'signature.capture',
      'incident.report_pause',
    ] as const) {
      expect(isOfflineFieldCommand(await build(commandType))).toBe(true);
    }
    expect(isOfflineFieldCommand(await build('incident.report'))).toBe(false);
    expect(
      isOfflineFieldCommand(
        await build('visit.transition', {
          entityId: crypto.randomUUID(),
          status: 'completed',
        }),
      ),
    ).toBe(true);
    expect(
      isOfflineFieldCommand(
        await build('visit.transition', {
          entityId: crypto.randomUUID(),
          status: 'en_route',
        }),
      ),
    ).toBe(false);

    for (const commandType of [
      'approval.decide',
      'quote.send',
      'quote.accept',
      'lead.qualify',
      'incident.close',
      'notification.read',
    ] as const) {
      expect(isOfflineFieldCommand(await build(commandType))).toBe(false);
    }
    expect(
      isOfflineFieldCommand(
        await build('visit.transition', {
          entityId: crypto.randomUUID(),
          status: 'weather_hold',
        }),
      ),
    ).toBe(false);
  });

  it('never replays a legacy offline en-route intent through the generic command bus', async () => {
    const legacyEnRoute = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000920',
      commandType: 'visit.transition',
      expectedVersion: 4,
      payload: { entityId: visitId, status: 'en_route' },
    });
    const executeCommand = vi.fn();
    const result = await replayOfflineQueue(
      [commandMutation(legacyEnRoute, '2026-07-28T12:00:00.000Z')],
      {
        uploadMedia: vi.fn(),
        executeCommand,
      },
    );

    expect(executeCommand).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(0);
    expect(result.failure?.message).toMatch(/fresh online NWS\/VROOM dispatch-clearance/u);
    expect(result.queue[0]).toMatchObject({
      status: 'failed',
      command: legacyEnRoute,
    });
  });

  it('moves atomic incident stop-work ahead of a prior completion intent and gates retained work', async () => {
    const completion = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000930',
      commandType: 'visit.transition',
      expectedVersion: 7,
      payload: { entityId: visitId, status: 'completed' },
    });
    const incidentStop = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000931',
      commandType: 'incident.report_pause',
      expectedVersion: 7,
      payload: {
        schemaVersion: 'storyops-incident-pause-v1',
        action: 'incident.report_pause',
        actorUserId: '10000000-0000-4000-8000-000000000103',
        entityId: '96000000-0000-4000-8000-000000000932',
        incidentNumber: 'INC-96000000',
        visitId,
        jobId: '10000000-0000-4000-8000-000000000631',
        propertyId: '10000000-0000-4000-8000-000000000211',
        severity: 'minor',
        category: 'other',
        occurredAt: '2026-07-30T12:00:00.000Z',
        requestedAt: '2026-07-30T12:00:01.000Z',
        summary: 'Observed a stop-work incident before queued completion reconciled.',
        immediateActions: 'Stopped work and isolated the affected area.',
        requiresLegalReview: false,
      },
    });
    const prioritized = prioritizeIncidentStopMutation(
      [commandMutation(completion, '2026-07-30T11:59:00.000Z')],
      commandMutation(incidentStop, '2026-07-30T12:00:01.000Z'),
    );

    expect(prioritized.map((mutation) => mutation.command?.commandType)).toEqual([
      'incident.report_pause',
      'visit.transition',
    ]);
    expect(prioritized[0]?.dependsOn).toEqual([]);
    expect(prioritized[1]?.dependsOn).toContain(incidentStop.commandId);

    const order: string[] = [];
    const result = await replayOfflineQueue(prioritized, {
      uploadMedia: vi.fn(),
      executeCommand: vi.fn(async (command) => {
        order.push(command.commandType);
        if (command.commandType === 'visit.transition') {
          throw new Error('OPEN_INCIDENT_STOPS_FIELD_WORK');
        }
      }),
    });

    expect(order).toEqual(['incident.report_pause', 'visit.transition']);
    expect(result.confirmed).toBe(1);
    expect(result.failure?.message).toMatch(/OPEN_INCIDENT_STOPS_FIELD_WORK/u);
    expect(result.queue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: incidentStop.commandId, status: 'synced' }),
        expect.objectContaining({ id: completion.commandId, status: 'failed' }),
      ]),
    );
  });

  it('places private incident evidence after stop-work but before blocked ordinary work', async () => {
    const incidentId = '95000000-0000-4000-8000-000000000521';
    const stop = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000934',
      commandType: 'incident.report_pause',
      expectedVersion: 7,
      payload: {
        schemaVersion: 'storyops-incident-pause-v1',
        action: 'incident.report_pause',
        actorUserId: '10000000-0000-4000-8000-000000000103',
        entityId: incidentId,
        incidentNumber: 'INC-95000000',
        visitId,
        jobId: '10000000-0000-4000-8000-000000000631',
        propertyId: '10000000-0000-4000-8000-000000000211',
        severity: 'minor',
        category: 'property_damage',
        occurredAt: '2026-07-30T12:00:00.000Z',
        requestedAt: '2026-07-30T12:00:01.000Z',
        summary: 'Observed exact incident evidence before queued ordinary work.',
        immediateActions: 'Stopped work and isolated the affected area.',
        requiresLegalReview: false,
      },
    });
    const completion = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000935',
      commandType: 'visit.transition',
      expectedVersion: 7,
      payload: { entityId: visitId, status: 'completed' },
    });
    const evidenceBlob = new Blob(['incident bytes'], { type: 'image/png' });
    const checksumSha256 = await sha256Hex(await blobArrayBuffer(evidenceBlob));
    const evidence: PreparedVisitMedia = {
      assetId: '96000000-0000-4000-8000-000000000936',
      visitId,
      incidentId,
      purpose: 'incident',
      blob: evidenceBlob,
      filename: 'incident.png',
      contentType: 'image/png',
      objectPath: `10000000-0000-4000-8000-000000000001/incidents/${incidentId}/visits/${visitId}/96000000-0000-4000-8000-000000000936-${checksumSha256.slice(0, 16)}-incident.png`,
      checksumSha256,
      byteSize: evidenceBlob.size,
      capturedAt: '2026-07-30T12:00:02.000Z',
    };
    const upload = mediaUploadMutation(
      '96000000-0000-4000-8000-000000000937',
      evidence,
      evidence.capturedAt,
      [stop.commandId],
    );
    const register = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000938',
      commandType: 'media.register',
      expectedVersion: 0,
      payload: {
        entityId: evidence.assetId,
        incidentId,
        visitId,
        jobId: '10000000-0000-4000-8000-000000000631',
        propertyId: '10000000-0000-4000-8000-000000000211',
        purpose: 'incident',
        objectPath: evidence.objectPath,
        contentType: evidence.contentType,
        byteSize: evidence.byteSize,
        checksumSha256,
        capturedAt: evidence.capturedAt,
        customerVisible: false,
      },
    });
    const registration = commandMutation(register, evidence.capturedAt, [upload.id], visitId);
    const existing = prioritizeIncidentStopMutation(
      [commandMutation(completion, '2026-07-30T11:59:00.000Z')],
      commandMutation(stop, '2026-07-30T12:00:01.000Z'),
    );
    const prioritized = prioritizeIncidentEvidenceMutations(existing, [upload, registration]);

    expect(prioritized.map((mutation) => mutation.id)).toEqual([
      stop.commandId,
      upload.id,
      register.commandId,
      completion.commandId,
    ]);
    expect(prioritized[1]?.dependsOn).toEqual([stop.commandId]);
    expect(prioritized[2]?.dependsOn).toEqual([upload.id]);

    const afterStopReadback = prioritized
      .filter((mutation) => mutation.id !== stop.commandId)
      .map((mutation) => ({
        ...mutation,
        dependsOn: (mutation.dependsOn ?? []).filter((dependency) => dependency !== stop.commandId),
      }));
    const evidenceOnly = selectIncidentEvidenceReplayQueue(
      afterStopReadback,
      visitId,
      new Set([incidentId]),
    );
    expect(evidenceOnly.map((mutation) => mutation.id)).toEqual([upload.id, register.commandId]);
    expect(
      mergeVisitReplayQueue(
        afterStopReadback,
        visitId,
        [],
        new Set(evidenceOnly.map((mutation) => mutation.id)),
      ),
    ).toEqual([
      expect.objectContaining({
        id: completion.commandId,
        command: completion,
      }),
    ]);
  });

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

  it('keeps dependency chains and replay cleanup isolated to each selected visit', async () => {
    const otherVisitId = '10000000-0000-4000-8000-000000000642';
    const first = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000911',
      commandType: 'visit.notes.update',
      expectedVersion: 4,
      payload: { entityId: visitId, notes: 'First visit note.' },
    });
    const other = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000912',
      commandType: 'visit.notes.update',
      expectedVersion: 2,
      payload: { entityId: otherVisitId, notes: 'Other visit note.' },
    });
    const second = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000913',
      commandType: 'visit.notes.update',
      expectedVersion: 4,
      payload: { entityId: visitId, notes: 'Second visit note.' },
    });
    const existing = [commandMutation(first, '2026-07-28T12:00:00.000Z')];
    const additions = chainOfflineMutationsByVisit(existing, [
      commandMutation(other, '2026-07-28T12:01:00.000Z'),
      commandMutation(second, '2026-07-28T12:02:00.000Z'),
    ]);

    expect(additions[0]?.dependsOn).toEqual([]);
    expect(additions[1]?.dependsOn).toEqual([first.commandId]);

    const combined = [...existing, ...additions];
    expect(mergeVisitReplayQueue(combined, visitId, [])).toEqual([additions[0]]);
    expect(
      mergeVisitReplayQueue(combined, visitId, [
        { ...existing[0]!, status: 'failed', lastError: 'Version conflict' },
      ]),
    ).toEqual([{ ...existing[0]!, status: 'failed', lastError: 'Version conflict' }, additions[0]]);
  });
});
