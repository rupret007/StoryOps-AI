import 'fake-indexeddb/auto';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '@/state/demoSeed';
import type { DemoState } from '@/state/model';
import {
  loadPersistedState,
  purgeClientPersistence,
  savePersistedState,
  type PersistenceScope,
} from '@/state/persistence';

type AuthObserver = (event: AuthChangeEvent, session: Session | null) => void;

const authHarness = vi.hoisted(() => ({
  repository: undefined as unknown,
  observer: undefined as AuthObserver | undefined,
}));

vi.mock('@/state/liveRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state/liveRepository')>();
  return {
    ...actual,
    readLiveRepositoryConfig: () => ({
      requested: true,
      mode: 'supabase' as const,
      url: 'https://storyops-auth-loss.test',
      anonKey: 'test-anon-key',
      companyId: '10000000-0000-4000-8000-000000000001',
    }),
    getLiveStoryOpsRepository: () => authHarness.repository,
  };
});

import { StoryOpsProvider, useStoryOps } from '@/state/StoryOpsProvider';

const scope: PersistenceScope = {
  companyId: '10000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000103',
};
const session = { user: { id: scope.userId } } as Session;

async function persistedLiveState(withOfflinePacket: boolean): Promise<DemoState> {
  const base = createDemoState();
  const payload = await new Response('unsynced-field-photo', {
    headers: { 'content-type': 'image/png' },
  }).blob();
  return {
    ...base,
    hydrated: true,
    dataMode: 'supabase',
    authStatus: 'signed_in',
    setupComplete: true,
    role: 'technician',
    online: false,
    serverVerifiedAt: undefined,
    live: {
      userId: scope.userId,
      companyId: scope.companyId,
      companyName: 'Live Exterior Co',
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-30T12:00:00.000Z',
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
    offlineQueue: withOfflinePacket
      ? [
          {
            id: 'offline-photo-1',
            idempotencyKey: 'media-upload:offline-photo-1',
            action: 'media.upload',
            entityId: '10000000-0000-4000-8000-000000000901',
            createdAt: '2026-07-30T12:00:00.000Z',
            status: 'queued',
            kind: 'media_upload',
            attemptCount: 0,
            mediaUpload: {
              assetId: '10000000-0000-4000-8000-000000000901',
              visitId: '10000000-0000-4000-8000-000000000641',
              purpose: 'before',
              blob: payload,
              filename: 'before.png',
              contentType: 'image/png',
              objectPath: `${scope.companyId}/visits/10000000-0000-4000-8000-000000000641/before.png`,
              checksumSha256: 'a'.repeat(64),
              byteSize: payload.size,
              capturedAt: '2026-07-30T12:00:00.000Z',
            },
          },
        ]
      : [],
  };
}

function fakeRepository(initialSession: Session | null) {
  const unsubscribe = vi.fn();
  const repository = {
    companyId: scope.companyId,
    getSession: vi.fn().mockResolvedValue(initialSession),
    onAuthStateChange: vi.fn((observer: AuthObserver) => {
      authHarness.observer = observer;
      return unsubscribe;
    }),
    signOut: vi.fn().mockResolvedValue(undefined),
  };
  authHarness.repository = repository;
  return repository;
}

function AuthBoundaryProbe() {
  const { state, actions } = useStoryOps();
  return (
    <>
      <output data-testid="auth-status">{state.authStatus}</output>
      <output data-testid="offline-count">{state.offlineQueue.length}</output>
      <output data-testid="live-user">{state.live?.userId ?? 'hidden'}</output>
      <output data-testid="toast-title">{state.toasts.at(-1)?.title ?? ''}</output>
      <button type="button" onClick={() => void actions.signOut()}>
        Sign out
      </button>
    </>
  );
}

function renderBoundary() {
  return render(
    <StoryOpsProvider>
      <AuthBoundaryProbe />
    </StoryOpsProvider>,
  );
}

let originalOnlineDescriptor: PropertyDescriptor | undefined;

beforeEach(async () => {
  originalOnlineDescriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value: false,
  });
  authHarness.observer = undefined;
  authHarness.repository = undefined;
  await purgeClientPersistence();
});

afterEach(async () => {
  cleanup();
  await purgeClientPersistence();
  if (originalOnlineDescriptor) {
    Object.defineProperty(navigator, 'onLine', originalOnlineDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'onLine');
  }
  vi.clearAllMocks();
});

describe('offline packet quarantine across auth loss', () => {
  it('hides but preserves a scoped packet on remote sign-out and restores it for the same user', async () => {
    await savePersistedState(await persistedLiveState(true));
    fakeRepository(session);
    renderBoundary();

    await waitFor(() => {
      expect(screen.getByTestId('auth-status')).toHaveTextContent('signed_in');
      expect(screen.getByTestId('offline-count')).toHaveTextContent('1');
    });

    act(() => {
      authHarness.observer?.('SIGNED_OUT', null);
    });

    expect(screen.getByTestId('auth-status')).toHaveTextContent('error');
    expect(screen.getByTestId('offline-count')).toHaveTextContent('0');
    expect(screen.getByTestId('live-user')).toHaveTextContent('hidden');
    expect(await loadPersistedState()).toBeUndefined();
    const quarantined = await loadPersistedState(scope);
    expect(quarantined?.offlineQueue).toHaveLength(1);
    expect(quarantined?.offlineQueue[0]?.mediaUpload?.blob).toBeDefined();
    expect(quarantined?.offlineQueue[0]?.mediaUpload?.blob.size).toBe(20);
    expect(quarantined?.offlineQueue[0]?.mediaUpload?.blob.type).toBe('image/png');

    act(() => {
      authHarness.observer?.('SIGNED_IN', session);
    });

    await waitFor(() => {
      expect(screen.getByTestId('auth-status')).toHaveTextContent('signed_in');
      expect(screen.getByTestId('offline-count')).toHaveTextContent('1');
      expect(screen.getByTestId('live-user')).toHaveTextContent(scope.userId);
    });
  });

  it('keeps a scoped packet quarantined when startup session recovery returns null', async () => {
    await savePersistedState(await persistedLiveState(true));
    fakeRepository(null);
    renderBoundary();

    await waitFor(() => {
      expect(screen.getByTestId('auth-status')).toHaveTextContent('signed_out');
      expect(screen.getByTestId('offline-count')).toHaveTextContent('0');
      expect(screen.getByTestId('live-user')).toHaveTextContent('hidden');
    });

    expect(await loadPersistedState()).toBeUndefined();
    expect((await loadPersistedState(scope))?.offlineQueue).toHaveLength(1);

    act(() => {
      authHarness.observer?.('SIGNED_IN', session);
    });

    await waitFor(() => {
      expect(screen.getByTestId('auth-status')).toHaveTextContent('signed_in');
      expect(screen.getByTestId('offline-count')).toHaveTextContent('1');
    });
  });

  it('blocks explicit sign-out while unsynced work exists', async () => {
    await savePersistedState(await persistedLiveState(true));
    const repository = fakeRepository(session);
    renderBoundary();

    await waitFor(() => expect(screen.getByTestId('auth-status')).toHaveTextContent('signed_in'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() =>
      expect(screen.getByTestId('toast-title')).toHaveTextContent('Sign out blocked'),
    );
    expect(repository.signOut).not.toHaveBeenCalled();
    expect((await loadPersistedState(scope))?.offlineQueue).toHaveLength(1);
  });

  it('deletes the exact scoped workspace only after confirmed explicit sign-out', async () => {
    await savePersistedState(await persistedLiveState(false));
    const repository = fakeRepository(session);
    repository.signOut.mockImplementation(async () => {
      authHarness.observer?.('SIGNED_OUT', null);
    });
    renderBoundary();

    await waitFor(() => expect(screen.getByTestId('auth-status')).toHaveTextContent('signed_in'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(async () => {
      expect(await loadPersistedState(scope)).toBeUndefined();
    });
    expect(repository.signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('auth-status')).toHaveTextContent('signed_out');
  });
});
