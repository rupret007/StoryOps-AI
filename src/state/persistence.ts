import { openDB } from 'idb';
import { companyConfigurationRecordSchema } from '@/domain/companyConfiguration';
import type { DemoState, SandboxSetupProfile } from './model';
import { normalizeOfflineQueueAfterHydration } from './offlineFieldQueue';
import { operatingBaselineStateSchema } from './operatingBaseline';
import { companyControlStateSchema } from './companyControl';
import { pilotReleaseEvidenceStateSchema } from '@/core/pilot/releaseEvidence';
import { recurringDueWorkStateSchema } from '@/core/recurring/dueWork';

const DATABASE_NAME = 'storyops-ai';
const DATABASE_VERSION = 1;
const STORE_NAME = 'app-state';
const LEGACY_STATE_KEY = 'current';
const SANDBOX_STATE_KEY = 'sandbox';

export type PersistenceScope = {
  userId: string;
  companyId: string;
};

type PersistedEnvelope = {
  envelopeVersion: 2;
  scope?: PersistenceScope;
  state: DemoState;
};

function scopedStateKey(scope: PersistenceScope): string {
  return `supabase:${scope.companyId}:${scope.userId}`;
}

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
    const stateKey = expectedScope ? scopedStateKey(expectedScope) : SANDBOX_STATE_KEY;
    let stored: unknown = await database.get(STORE_NAME, stateKey);
    if (stored === undefined) {
      const legacy: unknown = await database.get(STORE_NAME, LEGACY_STATE_KEY);
      const legacyEnvelope = isPersistedEnvelope(legacy)
        ? legacy
        : isCompatibleState(legacy)
          ? { envelopeVersion: 2 as const, state: legacy }
          : undefined;
      const legacyMatches = expectedScope
        ? legacyEnvelope?.scope?.userId === expectedScope.userId &&
          legacyEnvelope.scope.companyId === expectedScope.companyId &&
          legacyEnvelope.state.dataMode === 'supabase'
        : legacyEnvelope?.state.dataMode === 'sandbox';
      if (legacyEnvelope && legacyMatches) {
        stored = legacyEnvelope;
        await database.put(STORE_NAME, legacyEnvelope, stateKey);
        await database.delete(STORE_NAME, LEGACY_STATE_KEY);
      }
    }
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
        return undefined;
      }
    } else if (state.dataMode !== 'sandbox') {
      return undefined;
    }
    if (isCompatibleState(state)) {
      const companyControlState = companyControlStateSchema.safeParse(
        state.companyControlState,
      ).data;
      return {
        ...state,
        dataMode: state.dataMode === 'supabase' ? 'supabase' : 'sandbox',
        setupComplete:
          state.dataMode === 'supabase'
            ? true
            : state.setupComplete === true && isSandboxSetupProfile(state.setupProfile),
        setupProfile: isSandboxSetupProfile(state.setupProfile) ? state.setupProfile : undefined,
        companyConfiguration: companyConfigurationRecordSchema.safeParse(state.companyConfiguration)
          .data,
        operatingBaseline: operatingBaselineStateSchema.safeParse(state.operatingBaseline).data,
        pilotReleaseEvidence: pilotReleaseEvidenceStateSchema.safeParse(state.pilotReleaseEvidence)
          .data,
        recurringDueWork: recurringDueWorkStateSchema.safeParse(state.recurringDueWork).data,
        companyControlState,
        companyControlRecovery:
          state.dataMode === 'supabase' &&
          state.role === 'owner' &&
          state.companyControlRecovery === true &&
          companyControlState !== undefined,
        authStatus:
          state.dataMode === 'supabase' && state.authStatus ? state.authStatus : 'disabled',
        incidents: Array.isArray(state.incidents) ? state.incidents : [],
        remindedInvoiceIds: Array.isArray(state.remindedInvoiceIds) ? state.remindedInvoiceIds : [],
        customerPortalRequests: Array.isArray(state.customerPortalRequests)
          ? state.customerPortalRequests
          : [],
        customerCommunicationPreferences:
          state.customerCommunicationPreferences &&
          typeof state.customerCommunicationPreferences === 'object'
            ? state.customerCommunicationPreferences
            : {
                transactionalSms: false,
                transactionalEmail: false,
                marketingSms: false,
                marketingEmail: false,
                globalOptOut: false,
                disclosureVersion: 'customer-portal-consent-v1',
                version: 0,
              },
        customerPortalServiceOptions: Array.isArray(state.customerPortalServiceOptions)
          ? state.customerPortalServiceOptions
          : [],
        offlineQueue: normalizeOfflineQueueAfterHydration(
          Array.isArray(state.offlineQueue) ? state.offlineQueue : [],
        ),
        selectedVisitId: state.visits.some((visit) => visit.id === state.selectedVisitId)
          ? state.selectedVisitId
          : state.live?.visit?.id &&
              state.visits.some((visit) => visit.id === state.live?.visit?.id)
            ? state.live.visit.id
            : state.visits[0]?.id,
        selectedDispatchJobId: state.live?.readyToScheduleJobs?.some(
          (job) => job.id === state.selectedDispatchJobId,
        )
          ? state.selectedDispatchJobId
          : state.live?.readyToScheduleJobs?.some((job) => job.id === state.live?.dispatchJob?.id)
            ? state.live?.dispatchJob?.id
            : state.live?.readyToScheduleJobs?.[0]?.id,
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
    const stateKey =
      state.dataMode === 'supabase' && state.live
        ? scopedStateKey({
            userId: state.live.userId,
            companyId: state.live.companyId,
          })
        : SANDBOX_STATE_KEY;
    await database.put(STORE_NAME, envelope, stateKey);
    return true;
  } catch {
    // The app remains functional in memory when private browsing blocks IndexedDB.
    return false;
  }
}

export async function clearPersistedState(scope?: PersistenceScope): Promise<void> {
  try {
    const databasePromise = getDatabase();
    if (!databasePromise) return;
    const database = await databasePromise;
    if (scope) {
      await database.delete(STORE_NAME, scopedStateKey(scope));
      return;
    }
    await Promise.all([
      database.delete(STORE_NAME, SANDBOX_STATE_KEY),
      database.delete(STORE_NAME, LEGACY_STATE_KEY),
    ]);
  } catch {
    // Resetting the in-memory state is sufficient when persistence is unavailable.
  }
}

export async function purgeClientPersistence(options?: {
  preserveScopedAppState?: boolean;
}): Promise<void> {
  if (!options?.preserveScopedAppState) {
    try {
      const databasePromise = getDatabase();
      if (databasePromise) {
        const database = await databasePromise;
        await database.clear(STORE_NAME);
      }
    } catch {
      // The signed-out in-memory boundary remains authoritative.
    }
  }
  if (typeof caches === 'undefined') return;
  try {
    await Promise.all((await caches.keys()).map((cacheName) => caches.delete(cacheName)));
  } catch {
    // A signed-out in-memory state still prevents reuse when CacheStorage is unavailable.
  }
}

export async function removeLiveWorkspacePersistence(scope: PersistenceScope): Promise<void> {
  await clearPersistedState(scope);
  await purgeClientPersistence({ preserveScopedAppState: true });
}

function isSandboxSetupProfile(value: unknown): value is SandboxSetupProfile {
  const allowedServices = new Set([
    'pressure-wash-flatwork',
    'soft-wash-house',
    'gutter-cleaning',
    'roof-washing',
    'window-cleaning',
  ]);
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
