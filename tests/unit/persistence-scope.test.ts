import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoState } from '@/state/demoSeed';
import {
  clearPersistedState,
  loadPersistedState,
  purgeClientPersistence,
  removeLiveWorkspacePersistence,
  savePersistedState,
  type PersistenceScope,
} from '@/state/persistence';
import type { DemoState } from '@/state/model';

const scopeA: PersistenceScope = {
  companyId: '10000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000101',
};
const scopeB: PersistenceScope = {
  companyId: '20000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000101',
};

function liveState(scope: PersistenceScope, marker: string): DemoState {
  return {
    ...createDemoState(),
    hydrated: true,
    dataMode: 'supabase',
    authStatus: 'signed_in',
    setupComplete: true,
    live: {
      userId: scope.userId,
      companyId: scope.companyId,
      companyName: `Company ${marker}`,
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-29T12:00:00.000Z',
      invoiceVersions: {},
      leadVersions: {},
      checklistItems: {},
      checklistDefinitions: {},
      incidentVersions: {},
      notificationVersions: {},
      approvalVersions: {},
      materials: [],
      customers: [],
      properties: [],
    },
    offlineQueue: [
      {
        id: `media-${marker}`,
        idempotencyKey: `media-upload:${marker}`,
        action: 'media.upload',
        entityId: `asset-${marker}`,
        createdAt: '2026-07-29T12:00:00.000Z',
        status: 'queued',
        kind: 'media_upload',
        attemptCount: 0,
        mediaUpload: {
          assetId: `asset-${marker}`,
          visitId: `visit-${marker}`,
          purpose: 'before',
          blob: new Blob([`offline-${marker}`], { type: 'image/png' }),
          filename: `${marker}.png`,
          contentType: 'image/png',
          objectPath: `${scope.companyId}/visits/visit-${marker}/${marker}.png`,
          checksumSha256: 'a'.repeat(64),
          byteSize: 9 + marker.length,
          capturedAt: '2026-07-29T12:00:00.000Z',
        },
      },
    ],
  };
}

afterEach(async () => {
  await purgeClientPersistence();
});

describe('tenant- and user-scoped offline persistence', () => {
  it('survives cache-only cleanup and restores the same exact scope', async () => {
    expect(await savePersistedState(liveState(scopeA, 'a'))).toBe(true);

    await purgeClientPersistence({ preserveScopedAppState: true });
    const restored = await loadPersistedState(scopeA);

    expect(restored?.offlineQueue).toHaveLength(1);
    expect(restored?.offlineQueue[0]?.mediaUpload?.assetId).toBe('asset-a');
    expect(restored?.offlineQueue[0]?.mediaUpload?.blob).toBeDefined();
    expect(restored?.offlineQueue[0]?.mediaUpload?.contentType).toBe('image/png');
  });

  it('never exposes one company/user device packet to another scope', async () => {
    await savePersistedState(liveState(scopeA, 'a'));
    expect(await loadPersistedState(scopeB)).toBeUndefined();

    await savePersistedState(liveState(scopeB, 'b'));
    expect((await loadPersistedState(scopeA))?.live?.companyId).toBe(scopeA.companyId);
    expect((await loadPersistedState(scopeB))?.live?.companyId).toBe(scopeB.companyId);
  });

  it('clears only the explicitly selected device scope', async () => {
    await savePersistedState(liveState(scopeA, 'a'));
    await savePersistedState(liveState(scopeB, 'b'));

    await clearPersistedState(scopeA);

    expect(await loadPersistedState(scopeA)).toBeUndefined();
    expect((await loadPersistedState(scopeB))?.offlineQueue[0]?.id).toBe('media-b');
  });

  it('removes signed-out PII and offline mutations for the exact live scope', async () => {
    await savePersistedState(liveState(scopeA, 'a'));
    await savePersistedState(liveState(scopeB, 'b'));

    await removeLiveWorkspacePersistence(scopeA);

    expect(await loadPersistedState(scopeA)).toBeUndefined();
    expect((await loadPersistedState(scopeB))?.offlineQueue[0]?.id).toBe('media-b');
  });
});
