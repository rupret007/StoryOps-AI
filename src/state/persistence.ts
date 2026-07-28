import { openDB } from 'idb';
import type { DemoState, SandboxSetupProfile } from './model';
import { normalizeOfflineQueueAfterHydration } from './offlineFieldQueue';

const DATABASE_NAME = 'storyops-ai';
const DATABASE_VERSION = 1;
const STORE_NAME = 'app-state';
const STATE_KEY = 'current';

export type PersistenceScope = {
  userId: string;
  companyId: string;
};

type PersistedEnvelope = {
  envelopeVersion: 2;
  scope?: PersistenceScope;
  state: DemoState;
};

const getDatabase = () => {
  if (typeof indexedDB === 'undefined') {
    return undefined;
  }
  return openDB(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    },
  });
};

export async function loadPersistedState(
  expectedScope?: PersistenceScope,
): Promise<DemoState | undefined> {
  try {
    const databasePromise = getDatabase();
    if (!databasePromise) return undefined;
    const database = await databasePromise;
    const stored: unknown = await database.get(STORE_NAME, STATE_KEY);
    const envelope = isPersistedEnvelope(stored)
      ? stored
      : isCompatibleState(stored)
        ? { envelopeVersion: 2 as const, state: stored }
        : undefined;
    if (!envelope) return undefined;
    const state = envelope.state;
    if (expectedScope) {
      if (
        envelope.scope?.userId !== expectedScope.userId ||
        envelope.scope.companyId !== expectedScope.companyId ||
        state.dataMode !== 'supabase'
      ) {
        await database.delete(STORE_NAME, STATE_KEY);
        return undefined;
      }
    } else if (state.dataMode !== 'sandbox') {
      return undefined;
    }
    if (isCompatibleState(state)) {
      return {
        ...state,
        dataMode: state.dataMode === 'supabase' ? 'supabase' : 'sandbox',
        setupComplete:
          state.dataMode === 'supabase'
            ? true
            : state.setupComplete === true && isSandboxSetupProfile(state.setupProfile),
        setupProfile: isSandboxSetupProfile(state.setupProfile) ? state.setupProfile : undefined,
        authStatus:
          state.dataMode === 'supabase' && state.authStatus ? state.authStatus : 'disabled',
        incidents: Array.isArray(state.incidents) ? state.incidents : [],
        remindedInvoiceIds: Array.isArray(state.remindedInvoiceIds) ? state.remindedInvoiceIds : [],
        offlineQueue: normalizeOfflineQueueAfterHydration(
          Array.isArray(state.offlineQueue) ? state.offlineQueue : [],
        ),
        depositPaid: state.depositPaid === true,
        referralInvited: state.referralInvited === true,
        visits: state.visits.map((visit) => ({
          ...visit,
          elapsedSeconds:
            typeof visit.elapsedSeconds === 'number'
              ? visit.elapsedSeconds
              : visit.elapsedMinutes * 60,
        })),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function savePersistedState(state: DemoState): Promise<boolean> {
  try {
    const databasePromise = getDatabase();
    if (!databasePromise) return false;
    const database = await databasePromise;
    if (
      state.dataMode === 'supabase' &&
      (!state.live || state.authStatus !== 'signed_in' || !state.setupComplete)
    ) {
      await database.delete(STORE_NAME, STATE_KEY);
      return true;
    }
    const envelope: PersistedEnvelope = {
      envelopeVersion: 2,
      state,
      ...(state.dataMode === 'supabase' && state.live
        ? {
            scope: {
              userId: state.live.userId,
              companyId: state.live.companyId,
            },
          }
        : {}),
    };
    await database.put(STORE_NAME, envelope, STATE_KEY);
    return true;
  } catch {
    // The app remains functional in memory when private browsing blocks IndexedDB.
    return false;
  }
}

export async function clearPersistedState(): Promise<void> {
  try {
    const databasePromise = getDatabase();
    if (!databasePromise) return;
    const database = await databasePromise;
    await database.delete(STORE_NAME, STATE_KEY);
  } catch {
    // Resetting the in-memory state is sufficient when persistence is unavailable.
  }
}

export async function purgeClientPersistence(): Promise<void> {
  await clearPersistedState();
  if (typeof caches === 'undefined') return;
  try {
    await Promise.all((await caches.keys()).map((cacheName) => caches.delete(cacheName)));
  } catch {
    // A signed-out in-memory state still prevents reuse when CacheStorage is unavailable.
  }
}

function isSandboxSetupProfile(value: unknown): value is SandboxSetupProfile {
  const allowedServices = new Set(['pressure-wash-flatwork', 'soft-wash-house', 'gutter-cleaning']);
  return (
    typeof value === 'object' &&
    value !== null &&
    'businessName' in value &&
    typeof value.businessName === 'string' &&
    value.businessName.trim().length >= 2 &&
    value.businessName.trim().length <= 80 &&
    'ownerName' in value &&
    typeof value.ownerName === 'string' &&
    value.ownerName.trim().length >= 2 &&
    value.ownerName.trim().length <= 80 &&
    'homePostalCode' in value &&
    typeof value.homePostalCode === 'string' &&
    /^\d{5}$/u.test(value.homePostalCode) &&
    'timezone' in value &&
    value.timezone === 'America/Chicago' &&
    'enabledServiceCodes' in value &&
    Array.isArray(value.enabledServiceCodes) &&
    value.enabledServiceCodes.length > 0 &&
    value.enabledServiceCodes.every(
      (service) => typeof service === 'string' && allowedServices.has(service),
    ) &&
    'policyAcknowledged' in value &&
    value.policyAcknowledged === true &&
    'configuredAt' in value &&
    typeof value.configuredAt === 'string' &&
    Number.isFinite(Date.parse(value.configuredAt))
  );
}

function isPersistedEnvelope(value: unknown): value is PersistedEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'envelopeVersion' in value &&
    value.envelopeVersion === 2 &&
    'state' in value &&
    isCompatibleState(value.state)
  );
}

function isCompatibleState(value: unknown): value is DemoState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 1 &&
    'leads' in value &&
    Array.isArray(value.leads)
  );
}
