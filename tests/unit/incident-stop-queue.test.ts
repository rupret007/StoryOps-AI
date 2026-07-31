import { describe, expect, it, vi } from 'vitest';
import type { IncidentPauseReceipt } from '@/core/incidents/contracts';
import {
  durableIncidentStopForVisit,
  hasDurableIncidentStopLock,
  incidentStopMatchesIntent,
  reconcileDurableIncidentStop,
  type IncidentStopAuthoritativeReadback,
} from '@/state/incidentStopQueue';
import { commandMutation, normalizeOfflineQueueAfterHydration } from '@/state/offlineFieldQueue';
import { buildStoryOpsCommand, type StoryOpsCommand } from '@/state/liveRepository';
import type { OfflineMutation } from '@/state/model';

const companyId = '10000000-0000-4000-8000-000000000001';
const actorUserId = '10000000-0000-4000-8000-000000000103';
const visitId = '10000000-0000-4000-8000-000000000641';
const jobId = '10000000-0000-4000-8000-000000000631';
const propertyId = '10000000-0000-4000-8000-000000000211';
const incidentId = '95000000-0000-4000-8000-000000000521';

async function incidentCommand(): Promise<StoryOpsCommand> {
  return buildStoryOpsCommand({
    commandId: '95000000-0000-4000-8000-000000000511',
    commandType: 'incident.report_pause',
    expectedVersion: 9,
    payload: {
      schemaVersion: 'storyops-incident-pause-v1',
      action: 'incident.report_pause',
      actorUserId,
      entityId: incidentId,
      incidentNumber: 'INC-95000000',
      visitId,
      jobId,
      propertyId,
      severity: 'minor',
      category: 'property_damage',
      occurredAt: '2026-07-30T12:00:00.000Z',
      requestedAt: '2026-07-30T12:00:01.000Z',
      summary: 'A fixture moved beside the directly observed active work area.',
      immediateActions: 'Stopped work and isolated the affected area.',
      requiresLegalReview: false,
    },
  });
}

function receipt(command: StoryOpsCommand): IncidentPauseReceipt {
  return {
    schemaVersion: 'storyops-incident-pause-receipt-v1',
    action: 'incident.report_pause',
    commandId: command.commandId,
    commandType: 'incident.report_pause',
    status: 'applied',
    companyId,
    actorUserId,
    requestHash: command.requestHash,
    replayed: false,
    entityId: incidentId,
    version: 1,
    incident: {
      id: incidentId,
      incidentNumber: 'INC-95000000',
      status: 'open',
      version: 1,
    },
    visit: {
      id: visitId,
      jobId,
      propertyId,
      previousStatus: 'paused',
      currentStatus: 'paused',
      submittedExpectedVersion: 9,
      previousVersion: 10,
      currentVersion: 10,
    },
    stoppedTimeEntries: [],
    serverTime: '2026-07-30T12:00:02.000Z',
  };
}

function readback(overrides?: {
  incidentStatus?: string;
  visitStatus?: string;
  activeTimeEntryId?: string;
}): IncidentStopAuthoritativeReadback {
  return {
    companyId,
    incident: {
      id: incidentId,
      incidentNumber: 'INC-95000000',
      status: overrides?.incidentStatus ?? 'open',
      version: 1,
    },
    visit: {
      id: visitId,
      jobId,
      propertyId,
      status: overrides?.visitStatus ?? 'paused',
      version: 10,
      activeTimeEntryId: overrides?.activeTimeEntryId,
    },
  };
}

describe('durable incident stop-work queue', () => {
  it('recovers a crash during syncing with the exact command and a local stop lock', async () => {
    const command = await incidentCommand();
    const queued = commandMutation(command, '2026-07-30T12:00:01.000Z');
    const [hydrated] = normalizeOfflineQueueAfterHydration([
      { ...queued, status: 'syncing', attemptCount: 1 },
    ]);

    expect(hydrated).toMatchObject({
      id: command.commandId,
      status: 'queued',
      attemptCount: 1,
      command,
    });
    expect(hasDurableIncidentStopLock(hydrated ? [hydrated] : [], visitId)).toBe(true);
    expect(durableIncidentStopForVisit(hydrated ? [hydrated] : [], visitId)?.command).toEqual(
      command,
    );
    expect(
      incidentStopMatchesIntent(hydrated!, {
        actorUserId,
        visitId,
        jobId,
        propertyId,
        severity: 'minor',
        category: 'property_damage',
        summary: 'A fixture moved beside the directly observed active work area.',
        immediateActions: 'Stopped work and isolated the affected area.',
        requiresLegalReview: false,
      }),
    ).toBe(true);
  });

  it('retains an ambiguous first response and replays the byte-identical command before removal', async () => {
    const command = await incidentCommand();
    let durable: OfflineMutation[] = [commandMutation(command, '2026-07-30T12:00:01.000Z')];
    const persistedBeforeSend: StoryOpsCommand[] = [];
    const persistQueue = vi.fn(async (queue: OfflineMutation[]) => {
      durable = queue.map((mutation) => ({ ...mutation }));
      return true;
    });
    const send = vi
      .fn<(command: StoryOpsCommand) => Promise<unknown>>()
      .mockImplementationOnce(async (_submitted) => {
        persistedBeforeSend.push(durable[0]!.command!);
        throw new Error('Failed to fetch after request submission.');
      })
      .mockImplementationOnce(async (submitted) => receipt(submitted));

    const first = await reconcileDurableIncidentStop({
      queue: durable,
      mutationId: command.commandId,
      persistQueue,
      send,
      loadAuthoritativeReadback: vi.fn(),
      isAmbiguousFailure: () => true,
    });
    expect(first.outcome).toBe('retryable');
    expect(first.queue).toHaveLength(1);
    expect(first.queue[0]).toMatchObject({ status: 'queued', command });
    expect(persistedBeforeSend[0]).toEqual(command);

    const second = await reconcileDurableIncidentStop({
      queue: first.queue,
      mutationId: command.commandId,
      persistQueue,
      send,
      loadAuthoritativeReadback: async () => readback(),
      isAmbiguousFailure: () => true,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toEqual(command);
    expect(send.mock.calls[1]?.[0]).toEqual(command);
    expect(second).toMatchObject({ outcome: 'confirmed', queue: [] });
    expect(durable).toEqual([]);
  });

  it('persists a matching receipt but retains the command when authoritative readback fails', async () => {
    const command = await incidentCommand();
    const original = commandMutation(command, '2026-07-30T12:00:01.000Z');
    let durable: OfflineMutation[] = [original];
    const persistQueue = vi.fn(async (queue: OfflineMutation[]) => {
      durable = queue.map((mutation) => ({ ...mutation }));
      return true;
    });
    const send = vi.fn(async () => receipt(command));

    const first = await reconcileDurableIncidentStop({
      queue: durable,
      mutationId: command.commandId,
      persistQueue,
      send,
      loadAuthoritativeReadback: async () => {
        throw new Error('Workspace refresh failed after RPC success.');
      },
      isAmbiguousFailure: () => true,
    });
    expect(first.outcome).toBe('retryable');
    expect(first.queue[0]).toMatchObject({
      status: 'queued',
      command,
      incidentPauseReceipt: receipt(command),
    });

    const second = await reconcileDurableIncidentStop({
      queue: first.queue,
      mutationId: command.commandId,
      persistQueue,
      send,
      loadAuthoritativeReadback: async () => readback(),
      isAmbiguousFailure: () => true,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ outcome: 'confirmed', queue: [] });
  });

  it('does not remove a receipt-backed command while an exact timer or scope fact disagrees', async () => {
    const command = await incidentCommand();
    const queued: OfflineMutation = {
      ...commandMutation(command, '2026-07-30T12:00:01.000Z'),
      incidentPauseReceipt: receipt(command),
    };
    const result = await reconcileDurableIncidentStop({
      queue: [queued],
      mutationId: command.commandId,
      persistQueue: async () => true,
      send: vi.fn(),
      loadAuthoritativeReadback: async () =>
        readback({ activeTimeEntryId: '95000000-0000-4000-8000-000000000599' }),
      isAmbiguousFailure: () => true,
    });
    expect(result.outcome).toBe('retryable');
    expect(result.queue).toHaveLength(1);
    expect(result.error?.message).toMatch(/stopped timer/u);
  });

  it.each(['investigating', 'corrective_action'])(
    'accepts authoritative progressed-but-unresolved status %s without resending',
    async (incidentStatus) => {
      const command = await incidentCommand();
      const queued: OfflineMutation = {
        ...commandMutation(command, '2026-07-30T12:00:01.000Z'),
        incidentPauseReceipt: receipt(command),
      };
      const send = vi.fn();
      const result = await reconcileDurableIncidentStop({
        queue: [queued],
        mutationId: command.commandId,
        persistQueue: async () => true,
        send,
        loadAuthoritativeReadback: async () => readback({ incidentStatus }),
        isAmbiguousFailure: () => true,
      });

      expect(send).not.toHaveBeenCalled();
      expect(result).toMatchObject({ outcome: 'confirmed', queue: [] });
    },
  );
});
