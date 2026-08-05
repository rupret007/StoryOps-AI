import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { calculateDemoPrice, mergeDemoPrice } from '@/data/priceBook';
import { hasPermission, type Permission } from '@/domain';
import {
  assessCompanyConfiguration,
  hashCompanyConfiguration,
  parseCompanyConfiguration,
  type CompanyConfiguration,
  type CompanyConfigurationPublicationMode,
} from '@/domain/companyConfiguration';
import { createDemoState } from './demoSeed';
import {
  buildStoryOpsCommand,
  buildStoryOpsGoldenPathCommand,
  classifyLiveRepositoryFailure,
  getLiveStoryOpsRepository,
  mayUsePersistedLiveWorkspace,
  mutationOutcomeRequiresReconciliation,
  readLiveRepositoryConfig,
  type PreparedVisitMedia,
  type PostServiceActionInput,
  type StoryOpsCommand,
  type StoryOpsCommandType,
} from './liveRepository';
import {
  chainOfflineMutationsByVisit,
  commandVisitScopeId,
  commandMutation,
  isOfflineFieldCommand,
  mediaUploadMutation,
  mergeVisitReplayQueue,
  prioritizeIncidentEvidenceMutations,
  prioritizeIncidentStopMutation,
  replayOfflineQueue,
  selectIncidentEvidenceReplayQueue,
} from './offlineFieldQueue';
import {
  durableIncidentStopForVisit,
  incidentStopMatchesIntent,
  reconcileDurableIncidentStop,
  type IncidentStopAuthoritativeReadback,
} from './incidentStopQueue';
import { incidentAffectsVisit, unresolvedIncidentForVisit } from './incidentScope';
import {
  createCompanyControlRecoveryState,
  createLiveSetupRequiredState,
  createPausedCompanyRecoveryState,
  createSignedOutLiveState,
  mapLiveWorkspace,
} from './liveWorkspaceMapper';
import { applyCachedRoleScopedVisitSelection } from './visitSelection';
import type {
  LiveEstimateContext,
  LiveEstimateReceipt,
  LiveEstimateRequest,
} from './liveEstimating';
import type {
  AppRole,
  CustomerCommunicationPreferencesInput,
  CustomerPortalRequest,
  CustomerPortalRequestInput,
  DemoApproval,
  DemoAuditEvent,
  DemoEstimate,
  DemoShowcaseBadge,
  DemoIncident,
  DemoState,
  DemoShowcaseState,
  DemoToast,
  DemoTrace,
  DemoVisit,
  LiveSchedulingEvidenceResult,
  OfflineMutation,
  SandboxSetupInput,
  SandboxServiceCode,
  StoryOpsActions,
} from './model';
import type { CompanyControlState, CompanyOperationalStatusCommandInput } from './companyControl';
import type { CompanyConfigurationReceipt } from './companyConfiguration';
import type { OperatingBaselineReceipt } from './operatingBaseline';
import type {
  AuthoritativeProvider,
  CompanyLaunchAuthorizationReceipt,
  ProviderActivationMode,
  ProviderActivationReceipt,
  ProviderLaunchState,
} from './providerLaunch';
import type {
  PilotReleaseEvidenceInput,
  PilotReleaseEvidenceReceipt,
} from '@/core/pilot/releaseEvidence';
import type {
  AttachRecurringDueEstimateInput,
  CreateRecurringDueWorkInput,
  RecurringDueEstimateReceipt,
  RecurringDueWorkReceipt,
} from '@/core/recurring/dueWork';
import type {
  FinalizedSdsRegistrationReceipt,
  RegisterMaterialSdsInput,
} from '@/core/materials/sdsRegistry';
import { sandboxGoldenPathConfigurationIssue } from '@/core/pilot/sandboxConfiguration';
import type { DispatchCurrentOrigin } from '@/core/scheduling/dispatchOrigin';
import type { SchedulingSuggestionsResponse } from '@/core/scheduling/suggestions';
import { createCustomerPropertyInputSchema } from '@/core/properties/contracts';
import {
  clearPersistedState,
  loadPersistedState,
  purgeClientPersistence,
  removeLiveWorkspacePersistence,
  savePersistedState,
} from './persistence';
import { createCompletionSignaturePng } from './completionSignature';
import { deriveShowcaseManifest } from '@/core/pilot/showcase';

interface StoryOpsContextValue {
  state: DemoState;
  actions: StoryOpsActions;
  can(permission: Permission): boolean;
}

const StoryOpsContext = createContext<StoryOpsContextValue | undefined>(undefined);

const isoNow = (): string => new Date().toISOString();
const shortTime = (): string =>
  new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date());
const uniqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function removeLiveWorkspaceFromDevice(state: DemoState): Promise<void> {
  if (!state.live) {
    await purgeClientPersistence({ preserveScopedAppState: true });
    return;
  }
  await removeLiveWorkspacePersistence({
    userId: state.live.userId,
    companyId: state.live.companyId,
  });
}

type LiveWorkspaceScope = {
  userId: string;
  companyId: string;
};

type LiveWorkspaceReloadOptions = {
  expectedAuthGeneration?: number;
  recoveredState?: DemoState;
};

function stateMatchesLiveScope(
  state: DemoState | undefined,
  scope: LiveWorkspaceScope | undefined,
): state is DemoState {
  return Boolean(
    state?.dataMode === 'supabase' &&
    state.live &&
    scope &&
    state.live.userId === scope.userId &&
    state.live.companyId === scope.companyId,
  );
}

function sessionLossMessage(event: AuthChangeEvent): string {
  return event === 'SIGNED_OUT'
    ? 'The session ended. Scoped offline work remains quarantined on this device and is available only after the same user signs in again.'
    : 'Session recovery was interrupted. Scoped offline work remains quarantined until the same user signs in again.';
}

const sandboxServiceCodes = new Set<SandboxServiceCode>([
  'pressure-wash-flatwork',
  'soft-wash-house',
  'gutter-cleaning',
  'roof-washing',
  'window-cleaning',
]);
const containsControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
const hasCurrentServerVerification = (state: DemoState): boolean =>
  state.online && Boolean(state.serverVerifiedAt);

function selectedVisit(state: DemoState): DemoVisit | undefined {
  if (!state.selectedVisitId) return undefined;
  return state.visits.find((visit) => visit.id === state.selectedVisitId);
}

function selectedLiveVisitScope(state: DemoState):
  | {
      visit: DemoVisit;
      visitReference: NonNullable<NonNullable<DemoState['live']>['visit']>;
      jobReference: NonNullable<NonNullable<DemoState['live']>['job']>;
      jobId: string;
      propertyId: string;
    }
  | undefined {
  const visit = selectedVisit(state);
  const live = state.live;
  const fieldReference = visit ? live?.fieldVisitReferences?.[visit.id] : undefined;
  const checklistIds = Object.keys(live?.checklistItems ?? {}).sort();
  const fieldChecklistIds = Object.keys(fieldReference?.checklistItems ?? {}).sort();
  if (
    !visit ||
    !live?.visit ||
    live.visit.id !== visit.id ||
    live.fieldPacketVisitId !== visit.id ||
    !fieldReference ||
    fieldReference.visit.id !== visit.id ||
    !live.job ||
    !live.jobId ||
    live.job.id !== live.jobId ||
    fieldReference.job.id !== live.job.id ||
    fieldReference.jobId !== live.jobId ||
    !live.propertyId ||
    fieldReference.propertyId !== live.propertyId ||
    checklistIds.length !== fieldChecklistIds.length ||
    checklistIds.some((id, index) => id !== fieldChecklistIds[index]) ||
    Object.values(live.checklistItems).some((reference) => reference.visitId !== visit.id)
  ) {
    return undefined;
  }
  return {
    visit,
    visitReference: live.visit,
    jobReference: live.job,
    jobId: live.jobId,
    propertyId: live.propertyId,
  };
}

function semiannualDueDate(reference: string): string {
  const parsed = new Date(reference);
  const date = Number.isNaN(parsed.valueOf()) ? new Date() : parsed;
  date.setUTCMonth(date.getUTCMonth() + 6);
  return date.toISOString().slice(0, 10);
}

function withToast(state: DemoState, title: string, detail: string): DemoState {
  const toast: DemoToast = { id: uniqueId('toast'), title, detail };
  return { ...state, toasts: [...state.toasts.slice(-2), toast] };
}

function withEvidence(
  state: DemoState,
  traceInput: Omit<DemoTrace, 'id' | 'time' | 'traceId'>,
  auditInput: Omit<DemoAuditEvent, 'id' | 'time' | 'requestId' | 'immutable'>,
): DemoState {
  const requestId = `req_${Math.random().toString(16).slice(2, 9)}`;
  return {
    ...state,
    traces: [
      {
        id: uniqueId('trace'),
        time: shortTime(),
        traceId: `tr_${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        ...traceInput,
      },
      ...state.traces,
    ],
    auditEvents: [
      {
        id: uniqueId('audit'),
        time: shortTime(),
        requestId,
        immutable: true,
        ...auditInput,
      },
      ...state.auditEvents,
    ],
  };
}

function calculateAndMerge(
  estimate: DemoEstimate,
  publishedConfiguration?: CompanyConfiguration,
): DemoEstimate {
  return mergeDemoPrice(estimate, publishedConfiguration);
}

const sandboxEstimateServiceCodes = [
  'pressure-wash-flatwork',
  'gutter-cleaning',
] as const satisfies readonly SandboxServiceCode[];
// The seeded Morgan pilot is intentionally one bounded exterior-services slice.
// Its calculations still consume the operator's exact published rules.

function sandboxConfigurationBlock(
  state: DemoState,
  requiredServiceCodes: readonly string[] = [],
): DemoState | undefined {
  const issue = sandboxGoldenPathConfigurationIssue(state, requiredServiceCodes);
  return issue ? withToast(state, 'Company configuration required', issue) : undefined;
}

function preserveVerifiedOfflineSds(next: DemoState, previous?: DemoState): DemoState {
  if (
    !next.live ||
    !previous?.live ||
    next.live.userId !== previous.live.userId ||
    next.live.companyId !== previous.live.companyId
  ) {
    return next;
  }
  const cachedById = new Map(
    previous.live.materials
      .map((material) => material.sdsDocument)
      .filter(
        (document) =>
          document?.offlineStatus === 'available' &&
          typeof Blob !== 'undefined' &&
          document.cachedFile instanceof Blob,
      )
      .map((document) => [document!.id, document!] as const),
  );
  return {
    ...next,
    live: {
      ...next.live,
      materials: next.live.materials.map((material) => {
        const document = material.sdsDocument;
        const cached = document ? cachedById.get(document.id) : undefined;
        if (
          !document ||
          !cached ||
          cached.checksumSha256 !== document.checksumSha256 ||
          cached.version !== document.version
        ) {
          return material;
        }
        return {
          ...material,
          sdsDocument: {
            ...document,
            cachedFile: cached.cachedFile,
            cachedAt: cached.cachedAt,
            offlineStatus: 'available',
          },
        };
      }),
    },
  };
}

interface PreparedLiveMediaPacket {
  media: PreparedVisitMedia;
  mutations: OfflineMutation[];
}

export function StoryOpsProvider({ children }: { children: ReactNode }) {
  const liveConfigRef = useRef(readLiveRepositoryConfig());
  const liveRepositoryRef = useRef(getLiveStoryOpsRepository(liveConfigRef.current));
  const [state, setState] = useState<DemoState>(() => {
    if (!liveConfigRef.current.requested) return createDemoState();
    return {
      ...createSignedOutLiveState(liveConfigRef.current.configurationError),
      hydrated: Boolean(liveConfigRef.current.configurationError),
      authStatus: liveConfigRef.current.configurationError ? 'error' : 'checking',
    };
  });
  const stateRef = useRef(state);
  const portalCustomerIdRef = useRef<string | undefined>(undefined);
  const selectedVisitIdRef = useRef<string | undefined>(state.selectedVisitId);
  const selectedDispatchJobIdRef = useRef<string | undefined>(state.selectedDispatchJobId);
  const persistenceTimerRef = useRef<number | undefined>(undefined);
  const authGenerationRef = useRef(0);
  const offlineCommitTailRef = useRef<Promise<void>>(Promise.resolve());
  const pendingCustomerPropertyRef = useRef<
    | {
        fingerprint: string;
        identifiers: { operationId: string; customerId: string; propertyId: string };
        outcomeUnknown?: boolean;
      }
    | undefined
  >(undefined);
  const pendingPropertyGeocodeLookupRef = useRef<
    { fingerprint: string; operationId: string } | undefined
  >(undefined);
  const pendingPropertyGeocodeConfirmationRef = useRef<
    { fingerprint: string; commandId: string; outcomeUnknown?: boolean } | undefined
  >(undefined);
  const pendingDispatchConsumeRef = useRef<
    | {
        visitId: string;
        expectedVisitVersion: number;
        clearanceReceiptId: string;
        commandId: string;
        outcomeUnknown?: boolean;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const reloadLiveWorkspace = useCallback(async (options?: LiveWorkspaceReloadOptions) => {
    const authGenerationIsCurrent = () =>
      options?.expectedAuthGeneration === undefined ||
      authGenerationRef.current === options.expectedAuthGeneration;
    const repository = liveRepositoryRef.current;
    if (!repository || !authGenerationIsCurrent()) {
      if (!authGenerationIsCurrent()) return;
      const error =
        liveConfigRef.current.configurationError ?? 'The live repository is not configured.';
      setState(createSignedOutLiveState(error));
      return;
    }
    if (!navigator.onLine) {
      setState((current) =>
        withToast(
          { ...current, online: false, serverVerifiedAt: undefined },
          'Workspace is offline',
          'The last role-scoped workspace remains available. Queued commands have not been sent.',
        ),
      );
      return;
    }
    let confirmedControlState: CompanyControlState | undefined;
    try {
      const setupState = await repository.loadSetupState();
      if (!authGenerationIsCurrent()) return;
      if (setupState.status === 'required') {
        const setupRequired = createLiveSetupRequiredState(setupState);
        setState((current) => ({
          ...setupRequired,
          online: true,
          serverVerifiedAt: isoNow(),
          toasts: current.toasts,
        }));
        return;
      }
      confirmedControlState =
        setupState.role === 'owner' ? await repository.loadCompanyControlState() : undefined;
      if (!authGenerationIsCurrent()) return;
      if (confirmedControlState?.status === 'paused') {
        const pausedControlState = confirmedControlState;
        let providerLaunch: ProviderLaunchState | undefined;
        let providerAuthorityError: string | undefined;
        try {
          providerLaunch = await repository.loadProviderLaunchState();
        } catch (error) {
          providerAuthorityError =
            error instanceof Error
              ? `Provider/launch recovery readback failed: ${error.message}`
              : 'Provider/launch recovery readback failed.';
        }
        if (!authGenerationIsCurrent()) return;
        const recoveryScope = {
          userId: pausedControlState.userId,
          companyId: pausedControlState.companyId,
        };
        const recoveredState = stateMatchesLiveScope(options?.recoveredState, recoveryScope)
          ? options.recoveredState
          : undefined;
        setState((current) => ({
          ...createPausedCompanyRecoveryState(pausedControlState),
          providerLaunch,
          liveError: providerAuthorityError,
          offlineQueue:
            recoveredState?.offlineQueue ??
            (stateMatchesLiveScope(current, recoveryScope) ? current.offlineQueue : []),
          toasts: current.toasts,
        }));
        return;
      }
      const workspace = await repository.loadWorkspace();
      if (!authGenerationIsCurrent()) return;
      const mappedWorkspace = mapLiveWorkspace(workspace, {
        portalCustomerId:
          portalCustomerIdRef.current ??
          options?.recoveredState?.live?.selectedPortalCustomerId ??
          stateRef.current.live?.selectedPortalCustomerId,
        selectedVisitId:
          selectedVisitIdRef.current ??
          options?.recoveredState?.selectedVisitId ??
          stateRef.current.selectedVisitId,
        selectedDispatchJobId:
          selectedDispatchJobIdRef.current ??
          options?.recoveredState?.selectedDispatchJobId ??
          stateRef.current.selectedDispatchJobId,
      });
      const mappedScope = mappedWorkspace.live
        ? {
            userId: mappedWorkspace.live.userId,
            companyId: mappedWorkspace.live.companyId,
          }
        : undefined;
      const recoveredState = stateMatchesLiveScope(options?.recoveredState, mappedScope)
        ? options.recoveredState
        : undefined;
      const currentScopedState = stateMatchesLiveScope(stateRef.current, mappedScope)
        ? stateRef.current
        : undefined;
      const previousScopedState = recoveredState ?? currentScopedState;
      const mapped = preserveVerifiedOfflineSds(mappedWorkspace, previousScopedState);
      portalCustomerIdRef.current = mapped.live?.selectedPortalCustomerId;
      selectedVisitIdRef.current = mapped.selectedVisitId;
      selectedDispatchJobIdRef.current = mapped.selectedDispatchJobId;
      pendingCustomerPropertyRef.current = undefined;
      pendingPropertyGeocodeConfirmationRef.current = undefined;
      pendingDispatchConsumeRef.current = undefined;
      setState((current) => ({
        ...mapped,
        companyControlState: confirmedControlState,
        companyControlRecovery: false,
        online: true,
        offlineQueue: previousScopedState?.offlineQueue ?? mapped.offlineQueue,
        toasts: current.toasts,
      }));
    } catch (error) {
      if (!authGenerationIsCurrent()) return;
      const detail = error instanceof Error ? error.message : 'Workspace load failed.';
      const failureKind = classifyLiveRepositoryFailure(error);
      const currentLive = stateRef.current.live;
      if (
        confirmedControlState &&
        confirmedControlState.status !== 'setup' &&
        stateRef.current.companyControlRecovery
      ) {
        const recoveryControlState = confirmedControlState;
        setState((current) => ({
          ...createCompanyControlRecoveryState(recoveryControlState, detail),
          offlineQueue: current.offlineQueue,
          toasts: current.toasts,
        }));
        return;
      }
      if (failureKind === 'authorization_revoked') {
        await purgeClientPersistence({ preserveScopedAppState: true });
        if (!authGenerationIsCurrent()) return;
        setState(
          createSignedOutLiveState(
            'Company access is no longer authorized. Scoped offline work remains quarantined and inaccessible unless the same access is restored or this device is explicitly cleared.',
          ),
        );
        return;
      }
      const fallbackState =
        options?.recoveredState?.dataMode === 'supabase'
          ? options.recoveredState
          : currentLive
            ? stateRef.current
            : undefined;
      if (mayUsePersistedLiveWorkspace(error) && fallbackState?.live) {
        setState({
          ...fallbackState,
          hydrated: true,
          authStatus: 'signed_in',
          online: false,
          serverVerifiedAt: undefined,
          liveError: `${detail} Showing the last scoped field workspace.`,
          toasts: stateRef.current.toasts,
        });
        return;
      }
      setState(createSignedOutLiveState(detail));
    }
  }, []);

  const selectCustomerPortalAccount = useCallback(async (customerId: string): Promise<boolean> => {
    const current = stateRef.current;
    const repository = liveRepositoryRef.current;
    const account = current.live?.portalAccounts?.find(
      (candidate) => candidate.customerId === customerId,
    );
    if (
      current.dataMode !== 'supabase' ||
      current.authStatus !== 'signed_in' ||
      current.role !== 'customer' ||
      !repository ||
      !current.online ||
      !hasCurrentServerVerification(current) ||
      !account
    ) {
      setState((latest) =>
        withToast(
          latest,
          'Customer account unchanged',
          'Choose an account from the current authenticated portal projection while online.',
        ),
      );
      return false;
    }
    if (current.live?.selectedPortalCustomerId === account.customerId) return true;
    try {
      const workspace = await repository.loadWorkspace();
      const mapped = preserveVerifiedOfflineSds(
        mapLiveWorkspace(workspace, {
          portalCustomerId: account.customerId,
          selectedVisitId: selectedVisitIdRef.current ?? current.selectedVisitId,
          selectedDispatchJobId: selectedDispatchJobIdRef.current ?? current.selectedDispatchJobId,
        }),
        current,
      );
      if (
        mapped.role !== 'customer' ||
        mapped.live?.selectedPortalCustomerId !== account.customerId ||
        mapped.live.customerId !== account.customerId
      ) {
        throw new Error(
          'The refreshed portal projection did not bind the selected customer account.',
        );
      }
      portalCustomerIdRef.current = account.customerId;
      selectedVisitIdRef.current = mapped.selectedVisitId;
      selectedDispatchJobIdRef.current = mapped.selectedDispatchJobId;
      setState((latest) =>
        withToast(
          {
            ...mapped,
            companyControlState: latest.companyControlState,
            companyControlRecovery: false,
            online: true,
            offlineQueue: latest.offlineQueue,
            toasts: latest.toasts,
          },
          'Customer account changed',
          `${account.displayName} is now the exact account context for quotes, visits, invoices, completed work, requests, and payment actions.`,
        ),
      );
      return true;
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : 'The selected customer account could not be refreshed.';
      setState((latest) =>
        withToast({ ...latest, liveError: detail }, 'Customer account unchanged', detail),
      );
      return false;
    }
  }, []);

  const selectVisit = useCallback(async (visitId: string): Promise<boolean> => {
    const current = stateRef.current;
    const requested = current.visits.find((visit) => visit.id === visitId);
    if (
      !requested ||
      (!hasPermission(current.role, 'field.execute') &&
        current.role !== 'owner' &&
        current.role !== 'dispatcher')
    ) {
      setState((latest) =>
        withToast(
          latest,
          'Visit unchanged',
          'Choose a visit from the current role and assignment-scoped field projection.',
        ),
      );
      return false;
    }
    if (current.selectedVisitId === requested.id) return true;
    if (current.dataMode === 'sandbox') {
      const next = { ...current, selectedVisitId: requested.id };
      selectedVisitIdRef.current = requested.id;
      stateRef.current = next;
      setState(next);
      return true;
    }
    if (!current.online && current.authStatus === 'signed_in') {
      const cached = applyCachedRoleScopedVisitSelection(current, requested.id);
      if (!cached || selectedLiveVisitScope(cached)?.visit.id !== requested.id) {
        setState((latest) =>
          withToast(
            latest,
            'Visit unchanged',
            'This exact role-scoped field packet is not available in the durable offline cache.',
          ),
        );
        return false;
      }
      selectedVisitIdRef.current = requested.id;
      const next = withToast(
        cached,
        'Cached field visit selected',
        `${requested.jobNumber} now supplies the exact cached visit, job, property, checklist, media, time, and material packet. Mutations remain queued until server revalidation.`,
      );
      stateRef.current = next;
      setState(next);
      return true;
    }
    const repository = liveRepositoryRef.current;
    if (
      !repository ||
      current.authStatus !== 'signed_in' ||
      !current.online ||
      !hasCurrentServerVerification(current)
    ) {
      setState((latest) =>
        withToast(
          latest,
          'Visit unchanged',
          'Changing field packets requires a current online role-scoped server refresh.',
        ),
      );
      return false;
    }
    try {
      const workspace = await repository.loadWorkspace();
      const mapped = preserveVerifiedOfflineSds(
        mapLiveWorkspace(workspace, {
          portalCustomerId: portalCustomerIdRef.current ?? current.live?.selectedPortalCustomerId,
          selectedVisitId: requested.id,
          selectedDispatchJobId: selectedDispatchJobIdRef.current ?? current.selectedDispatchJobId,
        }),
        current,
      );
      const selectedScope = selectedLiveVisitScope(mapped);
      if (
        mapped.role !== current.role ||
        mapped.selectedVisitId !== requested.id ||
        selectedScope?.visit.id !== requested.id ||
        selectedScope.visitReference.id !== requested.id
      ) {
        throw new Error(
          'The refreshed field projection did not bind the exact selected visit packet.',
        );
      }
      selectedVisitIdRef.current = requested.id;
      selectedDispatchJobIdRef.current = mapped.selectedDispatchJobId;
      const next = withToast(
        {
          ...mapped,
          companyControlState: current.companyControlState,
          companyControlRecovery: false,
          online: true,
          offlineQueue: current.offlineQueue,
          toasts: current.toasts,
        },
        'Field visit selected',
        `${selectedScope.visit.jobNumber} now supplies the exact visit, job, property, checklist, media, time, and material packet.`,
      );
      stateRef.current = next;
      setState(next);
      return true;
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : 'The selected visit packet could not be refreshed.';
      setState((latest) => withToast({ ...latest, liveError: detail }, 'Visit unchanged', detail));
      return false;
    }
  }, []);

  const selectDispatchJob = useCallback((jobId: string) => {
    const current = stateRef.current;
    const job = current.live?.readyToScheduleJobs?.find((candidate) => candidate.id === jobId);
    if (
      current.dataMode !== 'supabase' ||
      !hasPermission(current.role, 'dispatch.manage') ||
      !job
    ) {
      setState((latest) =>
        withToast(
          latest,
          'Booking job unchanged',
          'Choose ready-to-schedule work from the current owner/dispatcher queue.',
        ),
      );
      return;
    }
    selectedDispatchJobIdRef.current = job.id;
    const next: DemoState = {
      ...current,
      selectedDispatchJobId: job.id,
      live: current.live ? { ...current.live, dispatchJob: job } : current.live,
    };
    stateRef.current = next;
    setState(next);
  }, []);

  const setCompanyOperationalStatus = useCallback(
    async (input: CompanyOperationalStatusCommandInput): Promise<boolean> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const controlState = current.companyControlState;
      if (
        current.dataMode !== 'supabase' ||
        current.authStatus !== 'signed_in' ||
        current.role !== 'owner' ||
        !repository ||
        !controlState ||
        !current.online ||
        !hasCurrentServerVerification(current)
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Company status unchanged',
            'A signed-in owner, current server verification, and the exact company control state are required.',
          ),
        );
        return false;
      }
      if (
        controlState.status !== input.expectedStatus ||
        (input.targetStatus === 'paused' && !controlState.canPause) ||
        (input.targetStatus === 'active' && !controlState.canReactivate)
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Company status changed elsewhere',
            'Refresh the owner control state before submitting another lifecycle command.',
          ),
        );
        return false;
      }
      try {
        const receipt = await repository.setCompanyOperationalStatus(input);
        let refreshed: CompanyControlState;
        try {
          refreshed = await repository.loadCompanyControlState();
        } catch (readbackError) {
          const detail =
            readbackError instanceof Error
              ? readbackError.message
              : 'Owner control readback could not be refreshed.';
          const receiptConfirmedState: CompanyControlState = {
            ...controlState,
            status: receipt.status,
            canPause: receipt.status === 'active',
            canReactivate: receipt.status === 'paused',
            serverTime: receipt.changedAt,
            recentEvents: [
              {
                commandId: receipt.commandId,
                previousStatus: receipt.previousStatus,
                status: receipt.status,
                reason: receipt.reason,
                changedAt: receipt.changedAt,
                changedByCurrentOwner: true,
                requestHash: receipt.requestHash,
              },
              ...controlState.recentEvents.filter((event) => event.commandId !== receipt.commandId),
            ].slice(0, 20),
          };
          setState((latest) =>
            withToast(
              {
                ...createCompanyControlRecoveryState(
                  receiptConfirmedState,
                  `The lifecycle command was confirmed, but current owner readback failed: ${detail}`,
                ),
                offlineQueue: latest.offlineQueue,
              },
              receipt.status === 'paused'
                ? 'Company operations paused'
                : 'Company operations reactivated',
              'The server confirmed the lifecycle command. Refresh owner state before any further operation.',
            ),
          );
          return true;
        }
        const matchingEvent = refreshed.recentEvents.find(
          (event) => event.commandId === receipt.commandId,
        );
        if (
          !matchingEvent ||
          matchingEvent.status !== receipt.status ||
          matchingEvent.requestHash !== receipt.requestHash
        ) {
          throw new Error('The lifecycle receipt did not reconcile with owner control readback.');
        }
        if (refreshed.status === 'paused') {
          setState((latest) =>
            withToast(
              {
                ...createPausedCompanyRecoveryState(refreshed),
                offlineQueue: latest.offlineQueue,
              },
              'Company operations paused',
              'Operational writes are blocked. Owner recovery and lifecycle history remain available.',
            ),
          );
          return true;
        }
        try {
          const workspace = await repository.loadWorkspace();
          const mapped = preserveVerifiedOfflineSds(
            mapLiveWorkspace(workspace, {
              portalCustomerId:
                portalCustomerIdRef.current ?? stateRef.current.live?.selectedPortalCustomerId,
              selectedVisitId: selectedVisitIdRef.current ?? stateRef.current.selectedVisitId,
              selectedDispatchJobId:
                selectedDispatchJobIdRef.current ?? stateRef.current.selectedDispatchJobId,
            }),
            stateRef.current,
          );
          portalCustomerIdRef.current = mapped.live?.selectedPortalCustomerId;
          selectedVisitIdRef.current = mapped.selectedVisitId;
          selectedDispatchJobIdRef.current = mapped.selectedDispatchJobId;
          setState((latest) =>
            withToast(
              {
                ...mapped,
                companyControlState: refreshed,
                companyControlRecovery: false,
                online: true,
                offlineQueue: latest.offlineQueue,
              },
              'Company operations reactivated',
              'The active owner workspace was reloaded from the server.',
            ),
          );
        } catch (workspaceError) {
          const detail =
            workspaceError instanceof Error
              ? workspaceError.message
              : 'The active workspace could not be reloaded.';
          setState((latest) =>
            withToast(
              {
                ...createCompanyControlRecoveryState(refreshed, detail),
                offlineQueue: latest.offlineQueue,
              },
              'Company reactivated; workspace reload needed',
              'The lifecycle command succeeded. Retry the server workspace load before operating.',
            ),
          );
        }
        return true;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'The company lifecycle command failed.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Company status unchanged', detail),
        );
        return false;
      }
    },
    [],
  );

  const recordPilotReleaseEvidence = useCallback(
    async (input: PilotReleaseEvidenceInput): Promise<PilotReleaseEvidenceReceipt | undefined> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      if (
        current.dataMode !== 'supabase' ||
        current.authStatus !== 'signed_in' ||
        current.role !== 'owner' ||
        !repository ||
        !current.online ||
        !hasCurrentServerVerification(current)
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Release evidence not recorded',
            'A signed-in owner and a current online workspace read are required. Sandbox evidence cannot authorize a live pilot.',
          ),
        );
        return undefined;
      }
      try {
        const receipt = await repository.recordPilotReleaseEvidence(input);
        await reloadLiveWorkspace();
        setState((latest) =>
          withToast(
            latest,
            receipt.replayed ? 'Release evidence confirmed' : 'Release evidence recorded',
            `${receipt.record.kind.replaceAll('_', ' ')} is recorded as an owner attestation (${receipt.record.outcome}) until ${receipt.record.expiresAt}. Owner attestations remain a manual gate and never authorize launch.`,
          ),
        );
        return receipt;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'The release evidence record was rejected.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Release evidence not recorded', detail),
        );
        return undefined;
      }
    },
    [reloadLiveWorkspace],
  );

  const createRecurringDueWork = useCallback(
    async (input: CreateRecurringDueWorkInput): Promise<RecurringDueWorkReceipt | undefined> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const projectedPlan = current.recurringDueWork?.plans.find(
        (plan) =>
          plan.planId === input.planId &&
          plan.planVersion === input.planVersion &&
          plan.nextDueDate === input.dueDate,
      );
      if (
        current.dataMode !== 'supabase' ||
        current.authStatus !== 'signed_in' ||
        !['owner', 'dispatcher'].includes(current.role) ||
        !hasPermission(current.role, 'campaigns.manage') ||
        !repository ||
        !current.online ||
        !hasCurrentServerVerification(current) ||
        !projectedPlan ||
        !projectedPlan.dueNow ||
        projectedPlan.generationAction !== 'create_fresh_estimate_work_item'
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Due-work item not created',
            'A currently due, server-projected maintenance plan and an online owner or dispatcher are required.',
          ),
        );
        return undefined;
      }
      try {
        const receipt = await repository.createRecurringDueWork(input);
        await reloadLiveWorkspace();
        setState((latest) =>
          withToast(
            latest,
            receipt.replayed || receipt.alreadyExisted
              ? 'Fresh-estimate work item confirmed'
              : 'Fresh-estimate work item created',
            'No price, quote, customer contact, availability, booking, or visit was created. Capture current measurements and use the normal deterministic estimate flow next.',
          ),
        );
        return receipt;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'The recurring due-work command was rejected.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Due-work item not created', detail),
        );
        return undefined;
      }
    },
    [reloadLiveWorkspace],
  );

  const attachRecurringDueEstimate = useCallback(
    async (
      input: AttachRecurringDueEstimateInput,
    ): Promise<RecurringDueEstimateReceipt | undefined> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const workItem = current.recurringDueWork?.workItems.find(
        (item) =>
          item.id === input.workItemId &&
          item.version === input.workItemVersion &&
          item.status === 'fresh_estimate_required' &&
          !item.estimateCreated,
      );
      if (
        current.dataMode !== 'supabase' ||
        current.authStatus !== 'signed_in' ||
        !['owner', 'dispatcher'].includes(current.role) ||
        !hasPermission(current.role, 'estimates.write') ||
        !repository ||
        !current.online ||
        !hasCurrentServerVerification(current) ||
        !workItem
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Recurring estimate not associated',
            'An exact open recurring work item and current online owner or dispatcher context are required.',
          ),
        );
        return undefined;
      }
      try {
        const receipt = await repository.attachRecurringDueEstimate(input);
        await reloadLiveWorkspace();
        setState((latest) =>
          withToast(
            latest,
            receipt.replayed || receipt.alreadyAttached
              ? 'Recurring estimate association confirmed'
              : 'Recurring estimate associated',
            'The new deterministic estimate is recorded. Quote publication and acceptance, deposit verification, live scheduling evidence, and job.book remain required.',
          ),
        );
        return receipt;
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : 'The recurring estimate association was rejected.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Recurring estimate not associated', detail),
        );
        return undefined;
      }
    },
    [reloadLiveWorkspace],
  );

  const registerMaterialSds = useCallback(
    async (
      input: RegisterMaterialSdsInput,
    ): Promise<FinalizedSdsRegistrationReceipt | undefined> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const configuredMaterial = current.materialSdsRegistry?.materials.find(
        (material) =>
          material.configurationKey === input.materialConfigurationKey &&
          material.requiresSds &&
          material.registrationStatus === 'registration_required',
      );
      if (
        current.dataMode !== 'supabase' ||
        current.authStatus !== 'signed_in' ||
        current.role !== 'owner' ||
        !repository ||
        !current.online ||
        !hasCurrentServerVerification(current) ||
        !configuredMaterial
      ) {
        setState((latest) =>
          withToast(
            latest,
            'SDS not registered',
            'A current saved configuration, online owner session, and exact material requiring SDS registration are required.',
          ),
        );
        return undefined;
      }
      try {
        const receipt = await repository.registerMaterialSds(input);
        await reloadLiveWorkspace();
        setState((latest) =>
          withToast(
            latest,
            'SDS version registered',
            `Immutable SDS version ${receipt.documentVersion} is bound to configuration revision ${receipt.configurationRevision}. No chemical or safety instructions were generated.`,
          ),
        );
        return receipt;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'The SDS registration was rejected.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'SDS not registered', detail),
        );
        return undefined;
      }
    },
    [reloadLiveWorkspace],
  );

  const loadMoreAuditEvents = useCallback(async (): Promise<void> => {
    const current = stateRef.current;
    const repository = liveRepositoryRef.current;
    const feed = current.liveAuditFeed;
    if (
      current.dataMode !== 'supabase' ||
      current.role !== 'owner' ||
      !repository ||
      !hasCurrentServerVerification(current) ||
      !feed?.hasMore ||
      !feed.nextCursor
    ) {
      setState((latest) =>
        withToast(
          latest,
          'Audit page not loaded',
          'Owner access, a current server refresh, and an exact next-page cursor are required.',
        ),
      );
      return;
    }
    try {
      const nextPage = await repository.loadAuditFeed({
        cursor: feed.nextCursor,
        limit: feed.pageLimit,
      });
      setState((latest) => {
        const existing = new Set(latest.liveAuditFeed?.events.map((event) => event.id) ?? []);
        return {
          ...latest,
          serverVerifiedAt: nextPage.serverTime,
          liveAuditFeed: {
            ...nextPage,
            events: [
              ...(latest.liveAuditFeed?.events ?? []),
              ...nextPage.events.filter((event) => !existing.has(event.id)),
            ],
          },
        };
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The audit page was not loaded.';
      setState((latest) =>
        withToast({ ...latest, liveError: detail }, 'Audit page not loaded', detail),
      );
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (!liveConfigRef.current.requested) {
      void loadPersistedState().then((persisted) => {
        if (!active) return;
        const sandboxState = persisted?.dataMode === 'sandbox' ? persisted : undefined;
        setState((current) => ({
          ...(sandboxState ?? current),
          hydrated: true,
          dataMode: 'sandbox',
          authStatus: 'disabled',
          online: navigator.onLine && (sandboxState?.online ?? true),
          toasts: [],
        }));
      });
      return () => {
        active = false;
      };
    }

    const repository = liveRepositoryRef.current;
    if (!repository || liveConfigRef.current.configurationError) {
      setState(createSignedOutLiveState(liveConfigRef.current.configurationError));
      return () => {
        active = false;
      };
    }

    const initializationAuthGeneration = authGenerationRef.current;
    const initializationIsCurrent = () =>
      active && authGenerationRef.current === initializationAuthGeneration;

    void repository
      .getSession()
      .then(async (session) => {
        if (!initializationIsCurrent()) return;
        if (!session) {
          await purgeClientPersistence({ preserveScopedAppState: true });
          if (!initializationIsCurrent()) return;
          setState(createSignedOutLiveState());
          return;
        }
        const persisted = await loadPersistedState({
          userId: session.user.id,
          companyId: repository.companyId,
        });
        if (!initializationIsCurrent()) return;
        if (!navigator.onLine && persisted?.dataMode === 'supabase') {
          setState({
            ...persisted,
            hydrated: true,
            authStatus: 'signed_in',
            online: false,
            serverVerifiedAt: undefined,
            toasts: [],
          });
          selectedVisitIdRef.current = persisted.selectedVisitId;
          selectedDispatchJobIdRef.current = persisted.selectedDispatchJobId;
          return;
        }
        let workspace;
        let companyControlState: CompanyControlState | undefined;
        try {
          const setupState = await repository.loadSetupState();
          if (!initializationIsCurrent()) return;
          if (setupState.userId !== session.user.id) {
            throw new Error('Setup-state user identity did not match the authenticated session.');
          }
          if (setupState.status === 'required') {
            setState(createLiveSetupRequiredState(setupState));
            return;
          }
          companyControlState =
            setupState.role === 'owner' ? await repository.loadCompanyControlState() : undefined;
          if (!initializationIsCurrent()) return;
          if (companyControlState?.status === 'paused') {
            setState({
              ...createPausedCompanyRecoveryState(companyControlState),
              offlineQueue: persisted?.dataMode === 'supabase' ? persisted.offlineQueue : [],
            });
            return;
          }
          workspace = await repository.loadWorkspace();
          if (!initializationIsCurrent()) return;
        } catch (error) {
          if (!initializationIsCurrent()) return;
          const failureKind = classifyLiveRepositoryFailure(error);
          if (mayUsePersistedLiveWorkspace(error) && persisted?.dataMode === 'supabase') {
            selectedVisitIdRef.current = persisted.selectedVisitId;
            selectedDispatchJobIdRef.current = persisted.selectedDispatchJobId;
            setState({
              ...persisted,
              hydrated: true,
              authStatus: 'signed_in',
              online: false,
              serverVerifiedAt: undefined,
              liveError:
                error instanceof Error
                  ? `${error.message} Showing the last scoped field workspace.`
                  : 'Workspace refresh failed. Showing the last scoped field workspace.',
              toasts: [],
            });
            return;
          }
          if (failureKind === 'authorization_revoked') {
            await purgeClientPersistence({ preserveScopedAppState: true });
            if (!initializationIsCurrent()) return;
            throw new Error(
              'Company access is no longer authorized. Scoped offline work remains quarantined and inaccessible unless the same access is restored or this device is explicitly cleared.',
              { cause: error },
            );
          }
          throw error;
        }
        if (!initializationIsCurrent()) return;
        const mapped = preserveVerifiedOfflineSds(
          mapLiveWorkspace(workspace, {
            portalCustomerId:
              portalCustomerIdRef.current ??
              (persisted?.dataMode === 'supabase'
                ? persisted.live?.selectedPortalCustomerId
                : undefined),
            selectedVisitId:
              selectedVisitIdRef.current ??
              (persisted?.dataMode === 'supabase' ? persisted.selectedVisitId : undefined),
            selectedDispatchJobId:
              selectedDispatchJobIdRef.current ??
              (persisted?.dataMode === 'supabase' ? persisted.selectedDispatchJobId : undefined),
          }),
          persisted?.dataMode === 'supabase' ? persisted : undefined,
        );
        portalCustomerIdRef.current = mapped.live?.selectedPortalCustomerId;
        selectedVisitIdRef.current = mapped.selectedVisitId;
        selectedDispatchJobIdRef.current = mapped.selectedDispatchJobId;
        setState({
          ...mapped,
          companyControlState,
          companyControlRecovery: false,
          offlineQueue: persisted?.dataMode === 'supabase' ? persisted.offlineQueue : [],
          online: navigator.onLine,
        });
      })
      .catch((error: unknown) => {
        if (!initializationIsCurrent()) return;
        setState(
          createSignedOutLiveState(
            error instanceof Error ? error.message : 'Live workspace initialization failed.',
          ),
        );
      });

    const unsubscribe = repository.onAuthStateChange(
      (event: AuthChangeEvent, session: Session | null) => {
        if (!active || event === 'INITIAL_SESSION') return;
        const authGeneration = authGenerationRef.current + 1;
        authGenerationRef.current = authGeneration;
        if (!session) {
          const signedOut = createSignedOutLiveState(sessionLossMessage(event));
          portalCustomerIdRef.current = undefined;
          selectedVisitIdRef.current = undefined;
          selectedDispatchJobIdRef.current = undefined;
          pendingCustomerPropertyRef.current = undefined;
          pendingPropertyGeocodeLookupRef.current = undefined;
          pendingPropertyGeocodeConfirmationRef.current = undefined;
          pendingDispatchConsumeRef.current = undefined;
          stateRef.current = signedOut;
          setState(signedOut);
          void purgeClientPersistence({ preserveScopedAppState: true });
          return;
        }

        const currentLive = stateRef.current.live;
        if (
          currentLive &&
          (currentLive.userId !== session.user.id || currentLive.companyId !== repository.companyId)
        ) {
          const signedOut = createSignedOutLiveState(
            'A different authenticated scope is loading. Previously stored offline work remains quarantined under its original user and company.',
          );
          portalCustomerIdRef.current = undefined;
          selectedVisitIdRef.current = undefined;
          selectedDispatchJobIdRef.current = undefined;
          pendingCustomerPropertyRef.current = undefined;
          pendingPropertyGeocodeLookupRef.current = undefined;
          pendingPropertyGeocodeConfirmationRef.current = undefined;
          pendingDispatchConsumeRef.current = undefined;
          stateRef.current = signedOut;
          setState(signedOut);
          void purgeClientPersistence({ preserveScopedAppState: true });
        }

        void loadPersistedState({
          userId: session.user.id,
          companyId: repository.companyId,
        }).then((persisted) => {
          if (!active || authGenerationRef.current !== authGeneration) return;
          if (!navigator.onLine && persisted?.dataMode === 'supabase') {
            const recovered = {
              ...persisted,
              hydrated: true,
              authStatus: 'signed_in' as const,
              online: false,
              serverVerifiedAt: undefined,
              liveError: undefined,
              toasts: [],
            };
            selectedVisitIdRef.current = recovered.selectedVisitId;
            selectedDispatchJobIdRef.current = recovered.selectedDispatchJobId;
            stateRef.current = recovered;
            setState(recovered);
            return;
          }
          window.setTimeout(() => {
            if (active && authGenerationRef.current === authGeneration) {
              void reloadLiveWorkspace({
                expectedAuthGeneration: authGeneration,
                recoveredState: persisted?.dataMode === 'supabase' ? persisted : undefined,
              });
            }
          }, 0);
        });
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [reloadLiveWorkspace]);

  useEffect(() => {
    if (!state.hydrated) return;
    persistenceTimerRef.current = window.setTimeout(() => {
      persistenceTimerRef.current = undefined;
      void savePersistedState({ ...state, toasts: [] });
    }, 80);
    return () => {
      if (persistenceTimerRef.current !== undefined) {
        window.clearTimeout(persistenceTimerRef.current);
        persistenceTimerRef.current = undefined;
      }
    };
  }, [state]);

  const requestMagicLink = useCallback(async (email: string) => {
    const repository = liveRepositoryRef.current;
    if (!repository) {
      setState((current) => ({
        ...current,
        authStatus: 'error',
        liveError:
          liveConfigRef.current.configurationError ?? 'The live repository is not configured.',
      }));
      return;
    }
    try {
      await repository.requestMagicLink(email);
      setState((current) => ({
        ...current,
        authStatus: 'link_sent',
        authEmail: email.trim().toLowerCase(),
        liveError: undefined,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        authStatus: 'error',
        liveError: error instanceof Error ? error.message : 'Magic-link request failed.',
      }));
    }
  }, []);

  const signOut = useCallback(async () => {
    const repository = liveRepositoryRef.current;
    if (!repository) return;
    const current = stateRef.current;
    if (current.offlineQueue.length > 0) {
      setState(
        withToast(
          current,
          'Sign out blocked',
          'Sync every queued field change before signing out so photos, checklists, notes, and signatures are not lost.',
        ),
      );
      return;
    }
    try {
      await repository.signOut();
      if (persistenceTimerRef.current !== undefined) {
        window.clearTimeout(persistenceTimerRef.current);
        persistenceTimerRef.current = undefined;
      }
      await removeLiveWorkspaceFromDevice(current);
      const signedOut = createSignedOutLiveState();
      stateRef.current = signedOut;
      setState(signedOut);
    } catch (error) {
      setState((current) =>
        withToast(
          current,
          'Sign out failed',
          error instanceof Error ? error.message : 'Try again.',
        ),
      );
    }
  }, []);

  const clearThisDevice = useCallback(async () => {
    const current = stateRef.current;
    if (current.offlineQueue.length > 0) {
      setState(
        withToast(
          current,
          'Device clear blocked',
          'Sync every queued field change before removing this device copy.',
        ),
      );
      return;
    }
    const repository = liveRepositoryRef.current;
    if (!repository) return;
    try {
      await repository.signOut();
      if (persistenceTimerRef.current !== undefined) {
        window.clearTimeout(persistenceTimerRef.current);
        persistenceTimerRef.current = undefined;
      }
      await purgeClientPersistence();
      const cleared = {
        ...createSignedOutLiveState(),
        toasts: [
          {
            id: uniqueId('toast'),
            title: 'Device copy cleared',
            detail: 'Synced StoryOps workspace data and caches were removed from this device.',
          },
        ],
      };
      stateRef.current = cleared;
      setState(cleared);
    } catch (error) {
      setState((latest) =>
        withToast(
          latest,
          'Device clear failed',
          error instanceof Error ? error.message : 'Try again while online.',
        ),
      );
    }
  }, []);

  const persistLiveOfflineMutations = useCallback(
    (
      mutations: readonly OfflineMutation[],
      optimistic: ((current: DemoState) => DemoState) | undefined,
      success: { title: string; detail: string },
      options?: { incidentStopFirst?: boolean; incidentEvidenceFirst?: boolean },
    ): Promise<boolean> => {
      const commit = offlineCommitTailRef.current.then(async () => {
        const current = stateRef.current;
        const scopedVisitIds = new Set(
          mutations.map((mutation) => mutation.scopeVisitId).filter(Boolean),
        );
        if (
          scopedVisitIds.size !== 1 ||
          selectedLiveVisitScope(current)?.visit.id !== [...scopedVisitIds][0]
        ) {
          setState((latest) =>
            withToast(
              latest,
              'Offline save blocked',
              'The mutation batch did not match the exact selected role-visible visit packet.',
            ),
          );
          return false;
        }
        const optimisticState = optimistic ? optimistic(current) : current;
        const chained = options?.incidentEvidenceFirst
          ? mutations.map((mutation) => ({ ...mutation }))
          : chainOfflineMutationsByVisit(optimisticState.offlineQueue, mutations);
        const offlineQueue = options?.incidentEvidenceFirst
          ? prioritizeIncidentEvidenceMutations(optimisticState.offlineQueue, chained)
          : options?.incidentStopFirst && chained.length === 1
            ? prioritizeIncidentStopMutation(optimisticState.offlineQueue, chained[0]!)
            : [...optimisticState.offlineQueue, ...chained];
        const next = {
          ...optimisticState,
          offlineQueue,
        };
        if (persistenceTimerRef.current !== undefined) {
          window.clearTimeout(persistenceTimerRef.current);
          persistenceTimerRef.current = undefined;
        }
        const persisted = await savePersistedState({ ...next, toasts: [] });
        if (!persisted) {
          setState((state) =>
            withToast(
              state,
              'Offline save blocked',
              'This device did not confirm durable IndexedDB storage. No field evidence or completion state was accepted.',
            ),
          );
          return false;
        }
        stateRef.current = next;
        setState(
          withToast(
            next,
            success.title,
            `${success.detail} The exact packet was confirmed in device storage.`,
          ),
        );
        return true;
      });
      offlineCommitTailRef.current = commit.then(
        () => undefined,
        () => undefined,
      );
      return commit;
    },
    [],
  );

  const persistIncidentStopQueueUpdate = useCallback(
    (mutationId: string, desiredQueue: readonly OfflineMutation[]): Promise<boolean> => {
      const commit = offlineCommitTailRef.current.then(async () => {
        const current = stateRef.current;
        const desired = desiredQueue.find((mutation) => mutation.id === mutationId);
        const currentHasMutation = current.offlineQueue.some(
          (mutation) => mutation.id === mutationId,
        );
        const offlineQueue = desired
          ? currentHasMutation
            ? current.offlineQueue.map((mutation) =>
                mutation.id === mutationId ? { ...desired } : mutation,
              )
            : [desired, ...current.offlineQueue]
          : current.offlineQueue
              .filter((mutation) => mutation.id !== mutationId)
              .map((mutation) => ({
                ...mutation,
                dependsOn: (mutation.dependsOn ?? []).filter(
                  (dependency) => dependency !== mutationId,
                ),
              }));
        const next = { ...current, offlineQueue };
        if (persistenceTimerRef.current !== undefined) {
          window.clearTimeout(persistenceTimerRef.current);
          persistenceTimerRef.current = undefined;
        }
        if (!(await savePersistedState({ ...next, toasts: [] }))) return false;
        stateRef.current = next;
        setState(next);
        return true;
      });
      offlineCommitTailRef.current = commit.then(
        () => undefined,
        () => undefined,
      );
      return commit;
    },
    [],
  );

  const persistOfflineMutationBatchUpdate = useCallback(
    (
      mutationIds: readonly string[],
      desiredMutations: readonly OfflineMutation[],
    ): Promise<boolean> => {
      const commit = offlineCommitTailRef.current.then(async () => {
        const current = stateRef.current;
        const targetIds = new Set(mutationIds);
        const desiredById = new Map(
          desiredMutations
            .filter((mutation) => targetIds.has(mutation.id))
            .map((mutation) => [mutation.id, mutation]),
        );
        const removedIds = new Set(
          mutationIds.filter((mutationId) => !desiredById.has(mutationId)),
        );
        const offlineQueue = current.offlineQueue.flatMap((mutation) => {
          if (targetIds.has(mutation.id)) {
            const desired = desiredById.get(mutation.id);
            return desired ? [{ ...desired }] : [];
          }
          return [
            {
              ...mutation,
              dependsOn: (mutation.dependsOn ?? []).filter(
                (dependency) => !removedIds.has(dependency),
              ),
            },
          ];
        });
        const next = { ...current, offlineQueue };
        if (persistenceTimerRef.current !== undefined) {
          window.clearTimeout(persistenceTimerRef.current);
          persistenceTimerRef.current = undefined;
        }
        if (!(await savePersistedState({ ...next, toasts: [] }))) return false;
        stateRef.current = next;
        setState(next);
        return true;
      });
      offlineCommitTailRef.current = commit.then(
        () => undefined,
        () => undefined,
      );
      return commit;
    },
    [],
  );

  const loadAuthoritativeIncidentStop = useCallback(
    async (
      command: StoryOpsCommand,
    ): Promise<{ readback: IncidentStopAuthoritativeReadback; mapped: DemoState }> => {
      const repository = liveRepositoryRef.current;
      const current = stateRef.current;
      const visitId =
        typeof command.payload.visitId === 'string' ? command.payload.visitId : undefined;
      const incidentId =
        typeof command.payload.entityId === 'string' ? command.payload.entityId : undefined;
      if (!repository || !visitId || !incidentId) {
        throw new Error('Authoritative incident readback requires the exact durable command.');
      }
      const workspace = await repository.loadWorkspace();
      const authoritativeIncident =
        Array.isArray(workspace.fieldIncidents) &&
        workspace.fieldIncidents.find(
          (candidate) =>
            typeof candidate === 'object' &&
            candidate !== null &&
            'id' in candidate &&
            candidate.id === incidentId,
        );
      const mapped = preserveVerifiedOfflineSds(
        mapLiveWorkspace(workspace, {
          portalCustomerId: portalCustomerIdRef.current ?? current.live?.selectedPortalCustomerId,
          selectedVisitId: visitId,
          selectedDispatchJobId: selectedDispatchJobIdRef.current ?? current.selectedDispatchJobId,
        }),
        current,
      );
      const incident = mapped.incidents.find((candidate) => candidate.id === incidentId);
      const visit = mapped.visits.find((candidate) => candidate.id === visitId);
      const fieldReference = mapped.live?.fieldVisitReferences?.[visitId];
      const jobId = fieldReference?.jobId ?? mapped.live?.jobId;
      const propertyId = fieldReference?.propertyId ?? mapped.live?.propertyId;
      const incidentVersion = mapped.live?.incidentVersions[incidentId];
      if (
        !mapped.live ||
        !authoritativeIncident ||
        !incident ||
        !visit ||
        !fieldReference ||
        !jobId ||
        !propertyId ||
        !incidentVersion
      ) {
        throw new Error(
          'Authoritative workspace did not return the exact incident and visit projection.',
        );
      }
      return {
        mapped,
        readback: {
          companyId: mapped.live.companyId,
          incident: {
            id: incident.id,
            incidentNumber:
              'incidentNumber' in authoritativeIncident &&
              typeof authoritativeIncident.incidentNumber === 'string'
                ? authoritativeIncident.incidentNumber
                : '',
            status:
              'status' in authoritativeIncident && typeof authoritativeIncident.status === 'string'
                ? authoritativeIncident.status
                : '',
            version:
              'version' in authoritativeIncident &&
              typeof authoritativeIncident.version === 'number'
                ? authoritativeIncident.version
                : incidentVersion,
          },
          visit: {
            id: visit.id,
            jobId,
            propertyId,
            status: fieldReference.visitStatus,
            version: fieldReference.visit.version,
            activeTimeEntryId:
              fieldReference.activeTimeEntry?.id ?? mapped.live.activeTimeEntry?.id,
          },
        },
      };
    },
    [],
  );

  const runLiveCommands = useCallback(
    async (
      inputs: Array<{
        commandType: StoryOpsCommandType;
        expectedVersion: number;
        payload: Record<string, unknown>;
        commandId?: string;
      }>,
      success: { title: string; detail: string },
      optimistic?: (current: DemoState) => DemoState,
      fieldVisitId?: string,
    ) => {
      const repository = liveRepositoryRef.current;
      if (!repository) {
        setState((current) =>
          withToast(
            current,
            'Live command blocked',
            liveConfigRef.current.configurationError ??
              'The authenticated repository is not available.',
          ),
        );
        return false;
      }
      try {
        const commands = await Promise.all(inputs.map(buildStoryOpsCommand));
        if (fieldVisitId) {
          const scope = selectedLiveVisitScope(stateRef.current);
          if (
            !scope ||
            scope.visit.id !== fieldVisitId ||
            commands.some((command) => {
              const commandVisitId = commandVisitScopeId(command);
              return commandVisitId !== undefined && commandVisitId !== fieldVisitId;
            })
          ) {
            throw new Error(
              'The field command no longer matches the exact selected visit packet. Refresh and retry.',
            );
          }
        }
        if (!stateRef.current.online) {
          const disallowed = commands.filter((command) => !isOfflineFieldCommand(command));
          if (disallowed.length > 0) {
            setState((current) =>
              withToast(
                current,
                'Online verification required',
                `Offline storage is limited to the assigned field packet. ${[
                  ...new Set(disallowed.map((command) => command.commandType)),
                ].join(', ')} requires a current server decision and was not queued.`,
              ),
            );
            return false;
          }
          const queuedAt = isoNow();
          const mutations = commands.map((command) =>
            commandMutation(command, queuedAt, [], fieldVisitId),
          );
          const completionRequested = commands.some(
            (command) =>
              command.commandType === 'visit.transition' && command.payload.status === 'completed',
          );
          return persistLiveOfflineMutations(mutations, optimistic, {
            title: completionRequested ? 'Completion pending sync' : 'Saved offline',
            detail: completionRequested
              ? 'The completion intent and timer stop are queued, but the visit remains incomplete until Storage and every prerequisite RPC are durably reconciled.'
              : `${commands.length} command${commands.length === 1 ? '' : 's'} queued with stable UUIDs, request hashes, expected versions, and dependency order.`,
          });
        }
        if (!stateRef.current.serverVerifiedAt) {
          setState((current) =>
            withToast(
              current,
              'Server refresh required',
              'The browser network is available, but this workspace has not been re-verified. Refresh before changing commercial or back-office records.',
            ),
          );
          return false;
        }
        if (fieldVisitId && selectedLiveVisitScope(stateRef.current)?.visit.id !== fieldVisitId) {
          throw new Error('The selected visit changed before the field command was submitted.');
        }
        let replayed = false;
        for (const command of commands) {
          const result = await repository.executeCommand(command);
          replayed ||= result.replayed;
        }
        await reloadLiveWorkspace();
        setState((current) =>
          withToast(
            current,
            success.title,
            replayed
              ? `${success.detail} The server confirmed an idempotent replay.`
              : success.detail,
          ),
        );
        return true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'The command was not applied.';
        if (stateRef.current.online) {
          try {
            await reloadLiveWorkspace();
          } catch {
            // The command error remains the primary user-facing failure.
          }
        }
        setState((current) =>
          withToast({ ...current, liveError: detail }, 'Server rejected the command', detail),
        );
        return false;
      }
    },
    [persistLiveOfflineMutations, reloadLiveWorkspace],
  );

  const runLiveCommand = useCallback(
    (
      input: {
        commandType: StoryOpsCommandType;
        expectedVersion: number;
        payload: Record<string, unknown>;
        commandId?: string;
      },
      success: { title: string; detail: string },
      optimistic?: (current: DemoState) => DemoState,
      fieldVisitId?: string,
    ) => runLiveCommands([input], success, optimistic, fieldVisitId),
    [runLiveCommands],
  );

  const runLiveGoldenPathCommand = useCallback(
    async (
      input: {
        commandType: 'job.book' | 'invoice.issue';
        expectedVersion: number;
        payload: Record<string, unknown>;
        commandId: string;
      },
      success: { title: string; detail: string },
    ) => {
      const repository = liveRepositoryRef.current;
      if (!repository || !hasCurrentServerVerification(stateRef.current)) {
        setState((current) =>
          withToast(
            current,
            'Online verification required',
            'Booking and invoice issuance require a current scoped server refresh and cannot be queued offline.',
          ),
        );
        return;
      }
      try {
        const command = await buildStoryOpsGoldenPathCommand(input);
        const result = await repository.executeGoldenPathCommand(command);
        await reloadLiveWorkspace();
        setState((current) =>
          withToast(
            current,
            success.title,
            result.replayed
              ? `${success.detail} The server returned the original idempotent receipt.`
              : success.detail,
          ),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'The command was not applied.';
        await reloadLiveWorkspace().catch(() => undefined);
        setState((current) =>
          withToast({ ...current, liveError: detail }, 'Server rejected the command', detail),
        );
      }
    },
    [reloadLiveWorkspace],
  );

  const prepareLiveMediaPacket = useCallback(
    async (
      selectedVisitId: string,
      purpose: 'before' | 'after' | 'signature' | 'incident' | 'safety' | 'damage',
      blob: Blob,
      filename: string,
      contentType: string,
      incidentId?: string,
      dependsOn: readonly string[] = [],
    ): Promise<PreparedLiveMediaPacket> => {
      const repository = liveRepositoryRef.current;
      const scope = selectedLiveVisitScope(stateRef.current);
      if (!repository || !scope || scope.visit.id !== selectedVisitId) {
        throw new Error('The live visit, property, and job scope must be loaded before upload.');
      }
      const incidentEvidence = ['incident', 'safety', 'damage'].includes(purpose);
      const activeIncident = stateRef.current.incidents.find(
        (candidate) =>
          candidate.id === incidentId &&
          candidate.status !== 'closed' &&
          incidentAffectsVisit(candidate, {
            visitId: selectedVisitId,
            jobId: scope.jobId,
            propertyId: scope.propertyId,
          }),
      );
      const pendingIncident = durableIncidentStopForVisit(
        stateRef.current.offlineQueue,
        selectedVisitId,
      );
      if (
        incidentEvidence !== Boolean(incidentId) ||
        (incidentEvidence &&
          !activeIncident &&
          pendingIncident?.command?.payload.entityId !== incidentId)
      ) {
        throw new Error(
          'Incident evidence requires the exact unresolved incident or durable stop-work command for this visit.',
        );
      }
      const assetId = crypto.randomUUID();
      const prepared = await repository.prepareVisitMedia({
        visitId: selectedVisitId,
        assetId,
        incidentId,
        purpose,
        blob,
        filename,
        contentType,
        capturedAt: isoNow(),
      });
      if (selectedLiveVisitScope(stateRef.current)?.visit.id !== selectedVisitId) {
        throw new Error('The selected visit changed while the evidence packet was prepared.');
      }
      const uploadId = crypto.randomUUID();
      const registerCommand = await buildStoryOpsCommand({
        commandType: 'media.register',
        expectedVersion: 0,
        payload: {
          entityId: assetId,
          visitId: selectedVisitId,
          jobId: scope.jobId,
          propertyId: scope.propertyId,
          ...(incidentId ? { incidentId } : {}),
          purpose,
          objectPath: prepared.objectPath,
          contentType: prepared.contentType,
          byteSize: prepared.byteSize,
          checksumSha256: prepared.checksumSha256,
          capturedAt: prepared.capturedAt,
          customerVisible: false,
        },
      });
      return {
        media: prepared,
        mutations: [
          mediaUploadMutation(uploadId, prepared, prepared.capturedAt, dependsOn),
          commandMutation(registerCommand, prepared.capturedAt, [uploadId], selectedVisitId),
        ],
      };
    },
    [],
  );

  const reconcileLiveMediaPacket = useCallback(
    async (packet: PreparedLiveMediaPacket): Promise<string> => {
      const repository = liveRepositoryRef.current;
      if (!repository) throw new Error('The live repository is unavailable.');
      if (selectedLiveVisitScope(stateRef.current)?.visit.id !== packet.media.visitId) {
        throw new Error('The evidence packet no longer matches the exact selected visit.');
      }
      const upload = packet.mutations.find((mutation) => mutation.kind === 'media_upload');
      const registration = packet.mutations.find(
        (mutation) => mutation.command?.commandType === 'media.register',
      );
      if (!upload?.mediaUpload || !registration?.command) {
        throw new Error('The prepared media packet is incomplete.');
      }
      await repository.uploadPreparedVisitMedia(upload.mediaUpload);
      if (selectedLiveVisitScope(stateRef.current)?.visit.id !== packet.media.visitId) {
        throw new Error('The selected visit changed before evidence registration.');
      }
      await repository.finalizeVisitMedia(registration.command);
      return packet.media.assetId;
    },
    [],
  );

  const setRole = useCallback((role: AppRole) => {
    setState((current) => {
      if (current.dataMode === 'supabase') {
        return withToast(
          current,
          'Role is server controlled',
          'Live access comes from your active company membership and cannot be previewed.',
        );
      }
      return withToast(
        { ...current, role },
        'View changed',
        `You are now viewing StoryOps as ${role}.`,
      );
    });
  }, []);

  const setOnline = useCallback((online: boolean) => {
    setState((current) =>
      withToast(
        { ...current, online, serverVerifiedAt: undefined },
        online ? 'Connection restored' : 'Offline field mode',
        online
          ? `Browser network is available. ${current.offlineQueue.length} queued change${current.offlineQueue.length === 1 ? '' : 's'} remains unconfirmed until a scoped server refresh and replay succeed.`
          : 'Field updates will be stored on this device with idempotency keys.',
      ),
    );
  }, []);

  const submitCustomerPortalRequest = useCallback(
    async (input: CustomerPortalRequestInput): Promise<boolean> => {
      const current = stateRef.current;
      if (!hasPermission(current.role, 'portal.self.write')) {
        setState((latest) =>
          withToast(
            latest,
            'Customer access required',
            'Only the authenticated customer can submit a portal request.',
          ),
        );
        return false;
      }
      if (current.dataMode === 'supabase') {
        const repository = liveRepositoryRef.current;
        if (!repository || !hasCurrentServerVerification(current)) {
          setState((latest) =>
            withToast(
              latest,
              'Request not submitted',
              'Refresh the authenticated portal before submitting. No visit or lead was changed.',
            ),
          );
          return false;
        }
        try {
          const receipt = await repository.submitCustomerPortalRequest(input);
          await reloadLiveWorkspace();
          setState((latest) =>
            withToast(
              latest,
              input.requestType === 'reschedule'
                ? 'Reschedule request received'
                : 'Service request received',
              input.requestType === 'reschedule'
                ? 'The current visit is unchanged until the office reviews and confirms a new window.'
                : `A linked intake lead was created for office qualification (${receipt.normalizedLeadId ?? 'receipt pending projection'}).`,
            ),
          );
          return true;
        } catch (error) {
          setState((latest) =>
            withToast(
              latest,
              'Request not submitted',
              error instanceof Error ? error.message : 'The request could not be stored.',
            ),
          );
          return false;
        }
      }

      const submittedAt = isoNow();
      const request: CustomerPortalRequest = {
        id: uniqueId('portal-request'),
        customerId: input.customerId,
        propertyId: input.propertyId,
        requestType: input.requestType,
        status: 'submitted',
        visitId: input.requestType === 'reschedule' ? input.visitId : undefined,
        normalizedLeadId:
          input.requestType === 'additional_service' ? uniqueId('lead-portal') : undefined,
        preferredStartDate:
          input.requestType === 'reschedule' ? input.preferredStartDate : undefined,
        preferredEndDate: input.requestType === 'reschedule' ? input.preferredEndDate : undefined,
        requestedServiceCodes:
          input.requestType === 'additional_service'
            ? [...new Set(input.requestedServiceCodes)].sort()
            : [],
        requestNotes: input.requestNotes.trim(),
        createdAt: submittedAt,
        updatedAt: submittedAt,
        version: 1,
      };
      setState((latest) => {
        let next: DemoState = {
          ...latest,
          customerPortalRequests: [request, ...latest.customerPortalRequests],
        };
        if (input.requestType === 'additional_service' && request.normalizedLeadId) {
          const customerLead =
            latest.leads.find((lead) => lead.id === latest.estimate.leadId) ?? latest.leads[0];
          const serviceNames = input.requestedServiceCodes.map(
            (code) =>
              latest.customerPortalServiceOptions.find((option) => option.code === code)?.name ??
              code,
          );
          next = {
            ...next,
            leads: [
              {
                id: request.normalizedLeadId,
                customerId: input.customerId,
                propertyId: input.propertyId,
                name: customerLead?.name ?? 'Portal customer',
                initials: customerLead?.initials ?? 'PC',
                source: 'Web',
                service: serviceNames.join(', '),
                address: customerLead?.address ?? '',
                city: customerLead?.city ?? '',
                stage: 'new',
                value: '$0',
                age: 'less than a minute',
                phone: customerLead?.phone ?? '',
                email: customerLead?.email ?? '',
                priority: 'normal',
                consent: false,
                note: input.requestNotes.trim(),
              },
              ...latest.leads,
            ],
          };
        }
        return withToast(
          withEvidence(
            next,
            {
              agent: 'Portal intake',
              action: input.requestType,
              result: 'succeeded',
              detail:
                input.requestType === 'reschedule'
                  ? 'Stored a local request fixture without changing the sandbox visit.'
                  : 'Stored a local request and normalized local lead fixture.',
              promptVersion: 'deterministic-portal-v1',
            },
            {
              actor: 'Sandbox customer',
              action: `portal.${input.requestType}.submitted`,
              entity: request.id,
              outcome: 'Local sandbox fixture only',
            },
          ),
          input.requestType === 'reschedule'
            ? 'Sandbox reschedule request stored'
            : 'Sandbox service request stored',
          input.requestType === 'reschedule'
            ? 'The appointment fixture was not changed and no customer or provider was contacted.'
            : 'A local intake fixture was created; no provider or customer was contacted.',
        );
      });
      return true;
    },
    [reloadLiveWorkspace],
  );

  const updateCustomerCommunicationPreferences = useCallback(
    async (input: CustomerCommunicationPreferencesInput): Promise<boolean> => {
      const current = stateRef.current;
      if (!hasPermission(current.role, 'portal.self.write')) {
        setState((latest) =>
          withToast(
            latest,
            'Customer access required',
            'Only the authenticated customer can update these communication choices.',
          ),
        );
        return false;
      }
      if (current.dataMode === 'supabase') {
        const repository = liveRepositoryRef.current;
        if (!repository || !hasCurrentServerVerification(current)) {
          setState((latest) =>
            withToast(
              latest,
              'Preferences not saved',
              'Refresh the authenticated portal before saving; the server consent record is unchanged.',
            ),
          );
          return false;
        }
        try {
          await repository.updateCustomerCommunicationPreferences(input);
          await reloadLiveWorkspace();
          setState((latest) =>
            withToast(
              latest,
              'Communication choices saved',
              input.globalOptOut
                ? 'All email and SMS purposes are withdrawn and contact-level suppression is active.'
                : 'The server recorded four purpose-specific consent decisions from this authenticated form.',
            ),
          );
          return true;
        } catch (error) {
          setState((latest) =>
            withToast(
              latest,
              'Preferences not saved',
              error instanceof Error ? error.message : 'The consent update could not be stored.',
            ),
          );
          return false;
        }
      }

      const normalized = {
        customerId: input.customerId,
        transactionalSms: input.globalOptOut ? false : input.transactionalSms,
        transactionalEmail: input.globalOptOut ? false : input.transactionalEmail,
        marketingSms: input.globalOptOut ? false : input.marketingSms,
        marketingEmail: input.globalOptOut ? false : input.marketingEmail,
        globalOptOut: input.globalOptOut,
        disclosureVersion: input.disclosureVersion,
        updatedAt: isoNow(),
        version: current.customerCommunicationPreferences.version + 1,
      };
      setState((latest) =>
        withToast(
          withEvidence(
            { ...latest, customerCommunicationPreferences: normalized },
            {
              agent: 'Consent policy',
              action: 'communication_preferences.update',
              result: 'succeeded',
              detail: 'Recorded four synthetic purpose decisions and the global opt-out fixture.',
              promptVersion: 'deterministic-consent-v1',
            },
            {
              actor: 'Sandbox customer',
              action: 'portal.communication_preferences.updated',
              entity: input.customerId,
              outcome: 'Local sandbox fixture only',
            },
          ),
          'Sandbox preferences stored',
          'No provider or customer was contacted; live suppression state was not changed.',
        ),
      );
      return true;
    },
    [reloadLiveWorkspace],
  );

  useEffect(() => {
    const online = () => setOnline(true);
    const offline = () => setOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [setOnline]);

  const completeSetup = useCallback(
    async (input: SandboxSetupInput): Promise<boolean> => {
      const current = stateRef.current;
      if (current.dataMode === 'supabase') {
        const repository = liveRepositoryRef.current;
        if (
          !repository ||
          current.authStatus !== 'signed_in' ||
          current.setupComplete ||
          !current.online
        ) {
          setState(
            withToast(
              current,
              'Live setup blocked',
              !current.online
                ? 'Authenticated company provisioning requires a current server connection.'
                : 'Live setup requires a signed-in, setup-required owner scope.',
            ),
          );
          return false;
        }
        try {
          const receipt = await repository.completeSetup(input);
          await reloadLiveWorkspace();
          setState((latest) =>
            withToast(
              latest,
              receipt.replayed ? 'Workspace setup confirmed' : 'Protected workspace provisioned',
              'The owner membership, five inactive service drafts, review-required pricing/terms/retention drafts, and eleven disabled integrations are durable. Company status remains setup; launch is not authorized.',
            ),
          );
          return true;
        } catch (error) {
          setState((latest) =>
            withToast(
              { ...latest, liveError: error instanceof Error ? error.message : 'Setup failed.' },
              'Live setup not completed',
              error instanceof Error ? error.message : 'The server rejected company provisioning.',
            ),
          );
          return false;
        }
      }
      const businessName = input.businessName.trim();
      const ownerName = input.ownerName.trim();
      const homePostalCode = input.homePostalCode.trim();
      const enabledServiceCodes = [...new Set(input.enabledServiceCodes)];
      const invalid =
        businessName.length < 2 ||
        businessName.length > 80 ||
        containsControlCharacters(businessName) ||
        ownerName.length < 2 ||
        ownerName.length > 80 ||
        containsControlCharacters(ownerName) ||
        !/^\d{5}$/u.test(homePostalCode) ||
        input.timezone !== 'America/Chicago' ||
        input.policyAcknowledged !== true ||
        enabledServiceCodes.length === 0 ||
        enabledServiceCodes.some((code) => !sandboxServiceCodes.has(code));
      if (invalid) {
        setState(
          withToast(
            current,
            'Setup not saved',
            'Enter valid business details, select a supported service, and acknowledge the sandbox policy.',
          ),
        );
        return false;
      }
      const configured = withEvidence(
        {
          ...current,
          setupComplete: true,
          setupProfile: {
            businessName,
            ownerName,
            homePostalCode,
            timezone: input.timezone,
            enabledServiceCodes,
            policyAcknowledged: true,
            configuredAt: isoNow(),
          },
        },
        {
          agent: 'Owner setup',
          action: 'Applied sandbox workspace guardrails',
          result: 'succeeded',
          detail: `${enabledServiceCodes.length} owner-selected service${enabledServiceCodes.length === 1 ? '' : 's'} enabled; live providers unchanged.`,
          promptVersion: 'deterministic-setup-v1',
        },
        {
          actor: 'user:owner',
          action: current.setupComplete ? 'workspace.setup_updated' : 'workspace.setup_completed',
          entity: 'sandbox-workspace',
          outcome: 'saved_local',
        },
      );
      const next = withToast(
        configured,
        'Workspace ready',
        'Your sandbox profile and service guardrails were applied locally. Live providers remain disabled.',
      );
      stateRef.current = next;
      setState(next);
      await savePersistedState({ ...next, toasts: [] });
      return true;
    },
    [reloadLiveWorkspace],
  );

  const saveCompanyConfigurationDraft = useCallback(
    async (input: CompanyConfiguration): Promise<CompanyConfigurationReceipt | undefined> => {
      const current = stateRef.current;
      if (!hasPermission(current.role, 'company.manage')) {
        setState(
          withToast(
            current,
            'Configuration change blocked',
            'Only the company owner can change operational configuration.',
          ),
        );
        return undefined;
      }
      if (current.dataMode === 'supabase' && !hasCurrentServerVerification(current)) {
        setState(
          withToast(
            current,
            'Configuration save blocked',
            'Policy-impacting configuration requires a current scoped server refresh.',
          ),
        );
        return undefined;
      }
      let configuration: CompanyConfiguration;
      try {
        configuration = parseCompanyConfiguration(input);
      } catch (error) {
        setState(
          withToast(
            current,
            'Configuration is invalid',
            error instanceof Error ? error.message : 'Correct the configuration fields.',
          ),
        );
        return undefined;
      }
      const readiness = assessCompanyConfiguration(configuration, 'sandbox');

      if (current.dataMode === 'supabase') {
        const repository = liveRepositoryRef.current;
        if (!repository || current.authStatus !== 'signed_in') {
          setState(
            withToast(
              current,
              'Configuration save blocked',
              'An authenticated owner scope is required.',
            ),
          );
          return undefined;
        }
        try {
          const receipt = await repository.saveCompanyConfigurationDraft({
            expectedRevision: current.companyConfiguration?.revision ?? 0,
            configuration,
          });
          await reloadLiveWorkspace();
          setState((latest) =>
            withToast(
              latest,
              receipt.replayed ? 'Configuration draft confirmed' : 'Configuration draft saved',
              `Revision ${receipt.revision} is review-only. It did not publish prices, terms, providers, or launch authorization.`,
            ),
          );
          return receipt;
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : 'The server rejected the configuration draft.';
          setState((latest) =>
            withToast({ ...latest, liveError: detail }, 'Configuration draft not saved', detail),
          );
          return undefined;
        }
      }

      const now = isoNow();
      const nextRevision = (current.companyConfiguration?.revision ?? 0) + 1;
      const configurationHash = await hashCompanyConfiguration(configuration);
      const receipt: CompanyConfigurationReceipt = {
        schemaVersion: 'storyops-company-config-receipt-v1',
        commandType: 'company.configuration.save',
        status: 'draft',
        companyId: '99000000-0000-4000-8000-000000000001',
        revision: nextRevision,
        configurationHash,
        issues: readiness.issues,
        replayed: false,
        commandId: crypto.randomUUID(),
        serverTime: now,
      };
      const configured = withEvidence(
        {
          ...current,
          companyConfiguration: {
            schemaVersion: 'storyops-company-config-record-v1',
            status: 'draft',
            revision: nextRevision,
            draft: configuration,
            published: current.companyConfiguration?.published,
            updatedAt: now,
            publishedAt: current.companyConfiguration?.publishedAt,
            publicationMode: current.companyConfiguration?.publicationMode,
            publicationReceipt: current.companyConfiguration?.publicationReceipt,
          },
        },
        {
          agent: 'Owner setup',
          action: 'Saved company configuration draft',
          result: 'succeeded',
          detail: `Revision ${nextRevision} passed deterministic schema validation; ${
            readiness.issues.filter((issue) => issue.severity === 'blocking').length
          } publication blocker(s) remain for owner review.`,
          promptVersion: 'company-configuration-v1',
        },
        {
          actor: 'user:owner',
          action: 'company.configuration_draft_saved',
          entity: 'sandbox-company-configuration',
          outcome: `revision_${nextRevision}`,
        },
      );
      const next = withToast(
        configured,
        'Configuration draft saved',
        `Revision ${nextRevision} is local and review-only until you explicitly publish it.`,
      );
      stateRef.current = next;
      setState(next);
      await savePersistedState({ ...next, toasts: [] });
      return receipt;
    },
    [reloadLiveWorkspace],
  );

  const publishCompanyConfiguration = useCallback(
    async (input: {
      publicationMode: CompanyConfigurationPublicationMode;
      reviewReference: string;
    }): Promise<CompanyConfigurationReceipt | undefined> => {
      const current = stateRef.current;
      const record = current.companyConfiguration;
      if (!hasPermission(current.role, 'company.manage') || !record) {
        setState(
          withToast(
            current,
            'Configuration publication blocked',
            'An owner-visible saved configuration draft is required.',
          ),
        );
        return undefined;
      }
      if (current.dataMode === 'supabase' && !hasCurrentServerVerification(current)) {
        setState(
          withToast(
            current,
            'Configuration publication blocked',
            'Publication requires a current scoped server policy and evidence check.',
          ),
        );
        return undefined;
      }
      const reviewReference = input.reviewReference.trim();
      if (reviewReference.length < 5 || reviewReference.length > 240) {
        setState(
          withToast(
            current,
            'Review evidence required',
            'Enter a 5–240 character review evidence reference before publication.',
          ),
        );
        return undefined;
      }
      const requiredMode = current.dataMode === 'supabase' ? 'live' : 'sandbox';
      if (input.publicationMode !== requiredMode) {
        setState(
          withToast(
            current,
            'Publication mode mismatch',
            current.dataMode === 'supabase'
              ? 'Authenticated workspaces can publish only after every live review is satisfied.'
              : 'The local workspace can publish sandbox evidence only; it cannot authorize live operation.',
          ),
        );
        return undefined;
      }
      const readiness = assessCompanyConfiguration(record.draft, input.publicationMode);
      if (!readiness.publishable) {
        setState(
          withToast(
            current,
            'Configuration publication blocked',
            readiness.issues
              .filter((issue) => issue.severity === 'blocking')
              .map((issue) => issue.message)
              .join(' '),
          ),
        );
        return undefined;
      }

      if (current.dataMode === 'supabase') {
        const repository = liveRepositoryRef.current;
        if (!repository || current.authStatus !== 'signed_in') {
          setState(
            withToast(
              current,
              'Configuration publication blocked',
              'An authenticated owner scope is required.',
            ),
          );
          return undefined;
        }
        try {
          const receipt = await repository.publishCompanyConfiguration({
            expectedRevision: record.revision,
            publicationMode: input.publicationMode,
            reviewReference,
          });
          await reloadLiveWorkspace();
          setState((latest) =>
            withToast(
              latest,
              receipt.replayed
                ? 'Configuration publication confirmed'
                : 'Configuration snapshot published',
              `Revision ${receipt.revision} is immutable. Company launch and every provider remain separately disabled.`,
            ),
          );
          return receipt;
        } catch (error) {
          const detail =
            error instanceof Error
              ? error.message
              : 'The server rejected configuration publication.';
          setState((latest) =>
            withToast({ ...latest, liveError: detail }, 'Configuration not published', detail),
          );
          return undefined;
        }
      }

      const now = isoNow();
      const configurationHash = await hashCompanyConfiguration(record.draft);
      const commandId = crypto.randomUUID();
      const receipt: CompanyConfigurationReceipt = {
        schemaVersion: 'storyops-company-config-receipt-v1',
        commandType: 'company.configuration.publish',
        status: 'published',
        companyId: '99000000-0000-4000-8000-000000000001',
        revision: record.revision,
        publicationMode: 'sandbox',
        configurationHash,
        reviewReference,
        issues: readiness.issues,
        replayed: false,
        commandId,
        serverTime: now,
      };
      const published = withEvidence(
        {
          ...current,
          companyConfiguration: {
            ...record,
            status: 'published',
            published: record.draft,
            updatedAt: now,
            publishedAt: now,
            publicationMode: 'sandbox',
            publicationReceipt: {
              commandId,
              configurationHash,
              reviewReference,
              replayed: false,
            },
          },
        },
        {
          agent: 'Owner setup',
          action: 'Published sandbox configuration snapshot',
          result: 'succeeded',
          detail: `Revision ${record.revision} was frozen for synthetic rehearsal only.`,
          promptVersion: 'company-configuration-v1',
        },
        {
          actor: 'user:owner',
          action: 'company.configuration_published',
          entity: 'sandbox-company-configuration',
          outcome: 'sandbox_only',
        },
      );
      const next = withToast(
        published,
        'Sandbox configuration published',
        'The immutable local snapshot can drive rehearsal. It is not live authorization.',
      );
      stateRef.current = next;
      setState(next);
      await savePersistedState({ ...next, toasts: [] });
      return receipt;
    },
    [reloadLiveWorkspace],
  );

  const publishOperatingBaseline = useCallback(
    async (input: { reviewReference: string }): Promise<OperatingBaselineReceipt | undefined> => {
      const current = stateRef.current;
      const configuration = current.companyConfiguration;
      if (
        current.dataMode !== 'supabase' ||
        current.authStatus !== 'signed_in' ||
        !hasPermission(current.role, 'company.manage')
      ) {
        setState(
          withToast(
            current,
            'Operating baseline blocked',
            'Only an authenticated live-workspace owner can publish an operating baseline.',
          ),
        );
        return undefined;
      }
      if (!hasCurrentServerVerification(current)) {
        setState(
          withToast(
            current,
            'Operating baseline blocked',
            'This policy-impacting publication requires a current online server check.',
          ),
        );
        return undefined;
      }
      if (
        !configuration?.published ||
        configuration.status !== 'published' ||
        configuration.publicationMode !== 'live'
      ) {
        setState(
          withToast(
            current,
            'Operating baseline blocked',
            'Publish the exact company configuration through the live review gate first.',
          ),
        );
        return undefined;
      }
      if (
        current.operatingBaseline?.configurationRevision === configuration.revision &&
        current.operatingBaseline.configurationHash ===
          configuration.publicationReceipt?.configurationHash
      ) {
        setState(
          withToast(
            current,
            'Operating baseline already active',
            `Configuration revision ${configuration.revision} already drives the active price book, terms, and retention policy.`,
          ),
        );
        return undefined;
      }
      const reviewReference = input.reviewReference.trim();
      if (reviewReference.length < 5 || reviewReference.length > 240) {
        setState(
          withToast(
            current,
            'Operating review evidence required',
            'Enter a 5–240 character owner review reference for this separate activation.',
          ),
        );
        return undefined;
      }
      const repository = liveRepositoryRef.current;
      if (!repository) {
        setState(
          withToast(
            current,
            'Operating baseline blocked',
            'The authenticated repository is unavailable.',
          ),
        );
        return undefined;
      }
      try {
        const receipt = await repository.publishOperatingBaseline({
          configurationRevision: configuration.revision,
          reviewReference,
        });
        await reloadLiveWorkspace();
        setState((latest) =>
          withToast(
            latest,
            receipt.replayed ? 'Operating baseline confirmed' : 'Operating baseline published',
            `${receipt.priceBookVersion} now governs ${receipt.serviceCount} service${receipt.serviceCount === 1 ? '' : 's'} and ${receipt.packageCount} packages. No provider or outbound channel was enabled.`,
          ),
        );
        return receipt;
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : 'The server rejected operating-baseline publication.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Operating baseline not published', detail),
        );
        return undefined;
      }
    },
    [reloadLiveWorkspace],
  );

  const setProviderActivation = useCallback(
    async (input: {
      provider: AuthoritativeProvider;
      targetMode: ProviderActivationMode;
    }): Promise<ProviderActivationReceipt | undefined> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const authority = current.providerLaunch;
      if (
        current.dataMode !== 'supabase' ||
        current.authStatus !== 'signed_in' ||
        current.role !== 'owner' ||
        !repository ||
        !authority ||
        authority.role !== 'owner' ||
        !current.online ||
        !hasCurrentServerVerification(current)
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Provider activation unchanged',
            current.dataMode === 'sandbox'
              ? 'Sandbox adapters are local rehearsal only. They have no production activation switch.'
              : 'A current authenticated owner readback is required before changing provider activation.',
          ),
        );
        return undefined;
      }
      const connection = authority.connections.find(
        (candidate) => candidate.provider === input.provider,
      );
      if (!connection) {
        setState((latest) =>
          withToast(
            latest,
            'Provider activation unchanged',
            'The authoritative provider connection is not present. Run the deployment health probe and refresh.',
          ),
        );
        return undefined;
      }
      if (input.targetMode !== 'disabled' && current.companyControlState?.status !== 'active') {
        setState((latest) =>
          withToast(
            latest,
            'Provider activation blocked',
            'A paused company may disable providers, but it cannot activate a provider.',
          ),
        );
        return undefined;
      }
      const environmentReady =
        input.targetMode === 'live'
          ? connection.canActivateLive
          : input.targetMode === 'sandbox'
            ? connection.canActivateSandbox
            : true;
      if (!environmentReady) {
        setState((latest) =>
          withToast(
            latest,
            'Provider activation blocked',
            `The deployment has no current healthy ${input.targetMode} environment proof for ${connection.provider}. Owners cannot change deployment switches or credentials from the browser.`,
          ),
        );
        return undefined;
      }
      if (
        connection.mode === input.targetMode &&
        connection.ownerEnabled === (input.targetMode !== 'disabled')
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Provider activation already current',
            `${connection.provider.replaceAll('_', ' ')} is already ${input.targetMode}.`,
          ),
        );
        return undefined;
      }
      try {
        const receipt = await repository.setProviderActivation({
          provider: connection.provider,
          expectedVersion: connection.version,
          targetMode: input.targetMode,
        });
        if (current.companyControlRecovery) {
          const providerLaunch = await repository.loadProviderLaunchState();
          setState((latest) => ({ ...latest, providerLaunch }));
        } else {
          await reloadLiveWorkspace();
        }
        setState((latest) =>
          withToast(
            latest,
            receipt.replayed ? 'Provider command confirmed' : 'Provider activation updated',
            `${receipt.provider.replaceAll('_', ' ')} is ${receipt.mode}. Any prior controlled-launch authorization was invalidated.`,
          ),
        );
        return receipt;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'The provider activation command was rejected.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Provider activation unchanged', detail),
        );
        return undefined;
      }
    },
    [reloadLiveWorkspace],
  );

  const setCompanyLaunchAuthorization = useCallback(
    async (input: {
      action: 'authorize' | 'revoke';
      reviewReference: string;
    }): Promise<CompanyLaunchAuthorizationReceipt | undefined> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const authority = current.providerLaunch;
      if (
        current.dataMode !== 'supabase' ||
        current.authStatus !== 'signed_in' ||
        current.role !== 'owner' ||
        !repository ||
        !authority ||
        authority.role !== 'owner' ||
        !current.online ||
        !hasCurrentServerVerification(current)
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Launch authorization unchanged',
            current.dataMode === 'sandbox'
              ? 'Sandbox rehearsal cannot create production launch authority.'
              : 'A current authenticated owner authority readback is required.',
          ),
        );
        return undefined;
      }
      if (input.action === 'authorize' && current.companyControlState?.status !== 'active') {
        setState((latest) =>
          withToast(
            latest,
            'Launch authorization blocked',
            'A paused company may revoke authority, but it cannot authorize a launch.',
          ),
        );
        return undefined;
      }
      const reviewReference = input.reviewReference.trim();
      if (
        reviewReference.length < 10 ||
        reviewReference.length > 120 ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{9,119}$/u.test(reviewReference)
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Launch review reference required',
            'Enter a 10–120 character audited reference using letters, numbers, period, underscore, or hyphen.',
          ),
        );
        return undefined;
      }
      if (
        input.action === 'revoke' &&
        !['authorized', 'invalidated'].includes(authority.launch.status)
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Launch authority already inactive',
            `Current authoritative status is ${authority.launch.status.replaceAll('_', ' ')}.`,
          ),
        );
        return undefined;
      }
      try {
        const receipt = await repository.setCompanyLaunchAuthorization({
          expectedVersion: authority.launch.version,
          action: input.action,
          reviewReference,
        });
        if (current.companyControlRecovery) {
          const providerLaunch = await repository.loadProviderLaunchState();
          setState((latest) => ({ ...latest, providerLaunch }));
        } else {
          await reloadLiveWorkspace();
        }
        setState((latest) =>
          withToast(
            latest,
            receipt.replayed ? 'Launch command confirmed' : 'Launch authority updated',
            receipt.launchAuthorized
              ? `Controlled launch is authorized at version ${receipt.version}; every live start still rechecks the bound configuration, baseline, providers, and proofs.`
              : `Controlled launch is revoked at version ${receipt.version}; recovery and reconciliation remain available.`,
          ),
        );
        return receipt;
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : 'The controlled-launch authorization command was rejected.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Launch authorization unchanged', detail),
        );
        return undefined;
      }
    },
    [reloadLiveWorkspace],
  );

  const resetDemo = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      setState((current) =>
        withToast(
          current,
          'Reset unavailable in live mode',
          'Live records can only change through normalized, audited commands.',
        ),
      );
      return;
    }
    void clearPersistedState();
    setState({ ...createDemoState(), hydrated: true, online: navigator.onLine });
  }, []);

  const resetShowcaseData = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      setState((current) =>
        withToast(
          current,
          'Showcase reset unavailable in live mode',
          'Live providers, queue state, and recorded workspace cannot be deterministically reset through sandbox replay.',
        ),
      );
      return;
    }
    void clearPersistedState();
    setState((current) => ({
      ...createDemoState(),
      hydrated: true,
      online: navigator.onLine,
      toasts: current.toasts,
      role: 'owner',
    }));
  }, []);

  const getShowcaseTourState = useCallback((): DemoShowcaseState => {
    return deriveShowcaseManifest(stateRef.current);
  }, []);

  const getShowcaseBadge = useCallback((): DemoShowcaseBadge => {
    const current = stateRef.current;
    const unknowns = [
      !current.setupComplete ? 'Setup incomplete' : '',
      current.dataMode === 'supabase' ? 'No local fixture scope in live mode' : '',
      current.leads.filter((item) => item.stage === 'new').length > 0
        ? 'One or more leads need qualification'
        : '',
    ].filter(Boolean);
    return {
      label: 'DEMO DATA',
      environment: 'local',
      state: 'sandbox',
      scope: 'DFW Exterior Services pilot',
      policyBoundaries: [
        'No invented measurements or prices',
        'No live payment state',
        'No unsanctioned chemical/safety advice',
      ],
      ownerNotice:
        unknowns.length > 0
          ? `Sandbox boundaries active: ${unknowns.join(' · ')}`
          : 'Sandbox fixture is in deterministic replay mode.',
    };
  }, []);

  const selectLead = useCallback((id: string) => {
    setState((current) => ({ ...current, selectedLeadId: id }));
  }, []);

  const addLead = useCallback(
    (input: {
      name: string;
      source: DemoState['leads'][number]['source'];
      service: string;
      address: string;
      city: string;
      phone: string;
      email: string;
      consent: boolean;
    }) => {
      if (stateRef.current.dataMode === 'supabase') {
        const entityId = crypto.randomUUID();
        const preferredContactChannel = input.email.trim()
          ? 'email'
          : input.phone.trim()
            ? 'phone'
            : undefined;
        void runLiveCommand(
          {
            commandType: 'lead.create',
            expectedVersion: 0,
            payload: {
              entityId,
              source: input.source.toLowerCase(),
              displayName: input.name.trim(),
              email: input.email.trim() || undefined,
              phone: input.phone.trim() || undefined,
              requestedServices: input.service.trim() ? [input.service.trim()] : [],
              preferredContactChannel,
            },
          },
          {
            title: 'Lead created',
            detail:
              'The server stored supported lead fields; address and consent still require normalized property/consent records.',
          },
        );
        return;
      }
      setState((current) => {
        if (!hasPermission(current.role, 'customers.write')) {
          return withToast(current, 'Action blocked', 'This role cannot create leads.');
        }
        const name = input.name.trim();
        const address = input.address.trim();
        if (name.length < 2 || address.length < 5) {
          return withToast(
            current,
            'Lead needs verified facts',
            'Customer name and service address are required.',
          );
        }
        const id = uniqueId('lead');
        const initials = name
          .split(/\s+/u)
          .map((part) => part[0])
          .filter(Boolean)
          .slice(0, 2)
          .join('')
          .toUpperCase();
        const next = withEvidence(
          {
            ...current,
            selectedLeadId: id,
            leads: [
              {
                id,
                name,
                initials,
                source: input.source,
                service: input.service.trim() || 'Scope pending',
                address,
                city: input.city.trim(),
                stage: 'new',
                value: '$0',
                age: 'now',
                phone: input.phone.trim(),
                email: input.email.trim(),
                priority: 'normal',
                consent: input.consent,
                note: 'Manually entered from verified customer-supplied facts.',
              },
              ...current.leads,
            ],
          },
          {
            agent: 'Intake',
            action: 'Normalized manual lead',
            result: 'succeeded',
            detail: 'Stored supplied facts and consent state without inferring scope or value.',
            promptVersion: 'intake-v4.2',
          },
          {
            actor: `user:${current.role}`,
            action: 'lead.created',
            entity: id,
            outcome: 'new',
          },
        );
        return withToast(
          next,
          'Lead created',
          'The record is unqualified and no price, measurement, or availability was inferred.',
        );
      });
    },
    [runLiveCommand],
  );

  const createCustomerProperty = useCallback(
    async (
      input: Parameters<StoryOpsActions['createCustomerProperty']>[0],
    ): ReturnType<StoryOpsActions['createCustomerProperty']> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const parsed = createCustomerPropertyInputSchema.safeParse(input);
      if (!parsed.success) {
        setState((latest) =>
          withToast(
            latest,
            'Customer needs verified facts',
            'A valid customer name and complete supplied service address are required.',
          ),
        );
        return undefined;
      }
      if (current.dataMode !== 'supabase') {
        setState((latest) =>
          withToast(
            latest,
            'Customer created',
            `${parsed.data.displayName} and the supplied service property were added to sandbox records.`,
          ),
        );
        return undefined;
      }
      if (
        !repository ||
        current.authStatus !== 'signed_in' ||
        !hasPermission(current.role, 'customers.write') ||
        !hasPermission(current.role, 'properties.write') ||
        !current.online ||
        !hasCurrentServerVerification(current)
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Customer not created',
            'A current online owner or dispatcher session is required for atomic customer/property intake.',
          ),
        );
        return undefined;
      }
      const fingerprint = JSON.stringify(parsed.data);
      if (
        pendingCustomerPropertyRef.current?.outcomeUnknown &&
        pendingCustomerPropertyRef.current.fingerprint !== fingerprint
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Resolve the prior intake first',
            'The previous transaction outcome is unknown. Restore the unchanged facts and retry its exact operation, or refresh the authoritative workspace before starting a different customer.',
          ),
        );
        return undefined;
      }
      if (pendingCustomerPropertyRef.current?.fingerprint !== fingerprint) {
        pendingCustomerPropertyRef.current = {
          fingerprint,
          identifiers: {
            operationId: crypto.randomUUID(),
            customerId: crypto.randomUUID(),
            propertyId: crypto.randomUUID(),
          },
        };
      }
      let receipt;
      try {
        receipt = await repository.createCustomerProperty(
          parsed.data,
          pendingCustomerPropertyRef.current.identifiers,
        );
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'Atomic customer/property intake was rejected.';
        const outcomeUnknown = mutationOutcomeRequiresReconciliation(error);
        if (outcomeUnknown && pendingCustomerPropertyRef.current) {
          pendingCustomerPropertyRef.current.outcomeUnknown = true;
        } else {
          pendingCustomerPropertyRef.current = undefined;
        }
        setState((latest) =>
          withToast(
            { ...latest, liveError: detail },
            outcomeUnknown ? 'Creation outcome unconfirmed' : 'Customer not created',
            outcomeUnknown
              ? `${detail} Do not change the form. Retrying the exact request reuses the same transaction identity.`
              : detail,
          ),
        );
        return undefined;
      }
      pendingCustomerPropertyRef.current = undefined;
      await reloadLiveWorkspace();
      setState((latest) =>
        withToast(
          latest,
          receipt.replayed ? 'Customer creation confirmed' : 'Customer and property created',
          hasCurrentServerVerification(latest)
            ? 'The server committed both records in one transaction. Scheduling remains blocked until live coordinates are reviewed.'
            : 'The server committed both records in one transaction, but the workspace refresh is pending. Refresh before continuing.',
        ),
      );
      return receipt;
    },
    [reloadLiveWorkspace],
  );

  const requestPropertyGeocode = useCallback(
    async (
      input: Parameters<StoryOpsActions['requestPropertyGeocode']>[0],
    ): ReturnType<StoryOpsActions['requestPropertyGeocode']> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const property = current.live?.properties.find(
        (candidate) =>
          candidate.id === input.propertyId && candidate.version === input.expectedPropertyVersion,
      );
      if (
        current.dataMode !== 'supabase' ||
        !repository ||
        current.authStatus !== 'signed_in' ||
        !hasPermission(current.role, 'properties.write') ||
        !current.online ||
        !hasCurrentServerVerification(current) ||
        !property ||
        property.geocodeReviewStatus === 'confirmed'
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Address review not started',
            'A current unreviewed property and online owner or dispatcher session are required.',
          ),
        );
        return undefined;
      }
      const fingerprint = `${property.id}:v${property.version}`;
      if (pendingPropertyGeocodeLookupRef.current?.fingerprint !== fingerprint) {
        pendingPropertyGeocodeLookupRef.current = {
          fingerprint,
          operationId: crypto.randomUUID(),
        };
      }
      try {
        const receipt = await repository.requestPropertyGeocode({
          propertyId: property.id,
          expectedPropertyVersion: property.version,
          operationId: pendingPropertyGeocodeLookupRef.current.operationId,
        });
        pendingPropertyGeocodeLookupRef.current = undefined;
        setState((latest) =>
          withToast(
            latest,
            'Live address candidates ready',
            'No coordinates were accepted. Review one exact provider result before confirmation.',
          ),
        );
        return receipt;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'Live property geocoding was unavailable.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Address review unavailable', detail),
        );
        return undefined;
      }
    },
    [],
  );

  const confirmPropertyGeocode = useCallback(
    async (
      input: Parameters<StoryOpsActions['confirmPropertyGeocode']>[0],
    ): ReturnType<StoryOpsActions['confirmPropertyGeocode']> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const property = current.live?.properties.find(
        (candidate) =>
          candidate.id === input.propertyId && candidate.version === input.expectedPropertyVersion,
      );
      if (
        current.dataMode !== 'supabase' ||
        !repository ||
        current.authStatus !== 'signed_in' ||
        !hasPermission(current.role, 'properties.write') ||
        !current.online ||
        !hasCurrentServerVerification(current) ||
        !property ||
        property.geocodeReviewStatus === 'confirmed'
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Coordinates not confirmed',
            'The exact unreviewed property version is no longer available. Refresh and review again.',
          ),
        );
        return undefined;
      }
      const fingerprint = `${property.id}:v${property.version}:${input.candidateId}`;
      if (
        pendingPropertyGeocodeConfirmationRef.current?.outcomeUnknown &&
        pendingPropertyGeocodeConfirmationRef.current.fingerprint !== fingerprint
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Resolve the prior confirmation first',
            'The previous confirmation outcome is unknown. Retry the same exact candidate or refresh the authoritative property before selecting another.',
          ),
        );
        return undefined;
      }
      if (pendingPropertyGeocodeConfirmationRef.current?.fingerprint !== fingerprint) {
        pendingPropertyGeocodeConfirmationRef.current = {
          fingerprint,
          commandId: crypto.randomUUID(),
        };
      }
      let receipt;
      try {
        receipt = await repository.confirmPropertyGeocode({
          propertyId: property.id,
          expectedPropertyVersion: property.version,
          candidateId: input.candidateId,
          commandId: pendingPropertyGeocodeConfirmationRef.current.commandId,
        });
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'Property coordinate confirmation was rejected.';
        const outcomeUnknown = mutationOutcomeRequiresReconciliation(error);
        if (outcomeUnknown && pendingPropertyGeocodeConfirmationRef.current) {
          pendingPropertyGeocodeConfirmationRef.current.outcomeUnknown = true;
        } else {
          pendingPropertyGeocodeConfirmationRef.current = undefined;
        }
        setState((latest) =>
          withToast(
            { ...latest, liveError: detail },
            outcomeUnknown ? 'Confirmation outcome unconfirmed' : 'Coordinates not confirmed',
            outcomeUnknown
              ? `${detail} Retry only this exact candidate until the authoritative property is refreshed.`
              : detail,
          ),
        );
        return undefined;
      }
      pendingPropertyGeocodeConfirmationRef.current = undefined;
      await reloadLiveWorkspace();
      setState((latest) =>
        withToast(
          latest,
          receipt.replayed ? 'Address confirmation verified' : 'Live coordinates confirmed',
          hasCurrentServerVerification(latest)
            ? `${receipt.provider.replaceAll('_', ' ')} ${receipt.precision} evidence is now bound to this property version.`
            : 'The coordinate confirmation committed, but the workspace refresh is pending. Refresh before scheduling.',
        ),
      );
      return receipt;
    },
    [reloadLiveWorkspace],
  );

  const qualifyLead = useCallback(
    (id: string) => {
      if (stateRef.current.dataMode === 'supabase') {
        const version = stateRef.current.live?.leadVersions[id];
        if (!version) {
          setState((current) =>
            withToast(
              current,
              'Qualification blocked',
              'The lead version is unavailable or stale.',
            ),
          );
          return;
        }
        const lead = stateRef.current.leads.find((item) => item.id === id);
        void runLiveCommand(
          {
            commandType: 'lead.qualify',
            expectedVersion: version,
            payload: {
              entityId: id,
              status: 'qualified',
              qualificationSummary:
                lead?.note.trim() || 'Qualified by an authorized back-office user.',
            },
          },
          {
            title: 'Lead qualified',
            detail: 'The server validated membership, transition, and optimistic version.',
          },
        );
        return;
      }
      setState((current) => {
        const configurationBlock = sandboxConfigurationBlock(current);
        if (configurationBlock) return configurationBlock;
        if (!hasPermission(current.role, 'customers.write')) {
          return withToast(current, 'Action blocked', 'This role cannot qualify or edit leads.');
        }
        const target = current.leads.find((lead) => lead.id === id);
        if (!target) return current;
        const next = withEvidence(
          {
            ...current,
            selectedLeadId: id,
            leads: current.leads.map((lead) =>
              lead.id === id ? { ...lead, stage: 'qualified', value: 'Not estimated' } : lead,
            ),
          },
          {
            agent: 'Intake',
            action: `Qualified ${target.name}`,
            result: 'succeeded',
            detail: 'Verified contact, consent, address, service intent, and scope inputs.',
            promptVersion: 'intake-v4.2',
          },
          {
            actor: 'agent:intake',
            action: 'lead.qualified',
            entity: id,
            outcome: 'success',
          },
        );
        return withToast(
          next,
          'Lead qualified',
          'Customer and property draft created from verified facts.',
        );
      });
    },
    [runLiveCommand],
  );

  const linkLeadScope = useCallback(
    (leadId: string, customerId: string, propertyId: string) => {
      if (stateRef.current.dataMode !== 'supabase') {
        setState((current) =>
          withToast(
            current,
            'Live scope link only',
            'Sandbox qualification already creates its synthetic customer and property scope.',
          ),
        );
        return;
      }
      if (!hasCurrentServerVerification(stateRef.current)) {
        setState((current) =>
          withToast(
            current,
            'Online verification required',
            'Linking a lead requires current customer and property ownership evidence.',
          ),
        );
        return;
      }
      const version = stateRef.current.live?.leadVersions[leadId];
      const property = stateRef.current.live?.properties.find(
        (candidate) => candidate.id === propertyId && candidate.customerId === customerId,
      );
      if (!version || !property) {
        setState((current) =>
          withToast(
            current,
            'Scope link blocked',
            'Select a current company property for this qualified lead and refresh if it is missing.',
          ),
        );
        return;
      }
      void runLiveCommand(
        {
          commandType: 'lead.link_scope',
          expectedVersion: version,
          payload: {
            entityId: leadId,
            customerId,
            propertyId,
          },
        },
        {
          title: 'Lead scope linked',
          detail: `${property.name} is now the exact property used by the estimate workflow.`,
        },
      );
    },
    [runLiveCommand],
  );

  const updateEstimate = useCallback(
    (
      field:
        | 'drivewaySqFt'
        | 'gutterLinearFt'
        | 'downspoutCount'
        | 'stories'
        | 'surface'
        | 'soil'
        | 'access'
        | 'risk'
        | 'travelZone'
        | 'discountPercent',
      value: string,
    ) => {
      if (stateRef.current.dataMode === 'supabase') {
        setState((current) =>
          withToast(
            current,
            'Read-only calculation snapshot',
            'Live estimate inputs change only through the server pricing workflow; this projection cannot overwrite them.',
          ),
        );
        return;
      }
      setState((current) => {
        if (!hasPermission(current.role, 'estimates.write')) {
          return withToast(current, 'Action blocked', 'This role has read-only estimate access.');
        }
        try {
          const estimate = calculateAndMerge(
            {
              ...current.estimate,
              [field]: value,
              status: 'draft',
            } as DemoEstimate,
            current.companyConfiguration?.published,
          );
          return { ...current, estimate };
        } catch {
          return {
            ...current,
            estimate: { ...current.estimate, [field]: value, status: 'draft' } as DemoEstimate,
          };
        }
      });
    },
    [],
  );

  const loadLiveEstimateContext = useCallback(
    async (propertyId?: string): Promise<LiveEstimateContext> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      if (
        current.dataMode !== 'supabase' ||
        !repository ||
        !hasPermission(current.role, 'estimates.write')
      ) {
        throw new Error(
          'Authenticated owner or dispatcher access is required to load live pricing context.',
        );
      }
      if (!hasCurrentServerVerification(current)) {
        throw new Error(
          'Live pricing context requires a connection because price books and evidence must be current.',
        );
      }
      return repository.loadEstimateContext(propertyId);
    },
    [],
  );

  const calculateLiveEstimate = useCallback(
    async (input: LiveEstimateRequest): Promise<LiveEstimateReceipt> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      if (
        current.dataMode !== 'supabase' ||
        !repository ||
        !hasPermission(current.role, 'estimates.write')
      ) {
        throw new Error(
          'Authenticated owner or dispatcher access is required to calculate live estimates.',
        );
      }
      if (!hasCurrentServerVerification(current)) {
        throw new Error(
          'Live estimates cannot be queued offline because authoritative evidence and policy must be checked atomically.',
        );
      }
      const receipt = await repository.calculateLiveEstimate(input);
      await reloadLiveWorkspace();
      setState((latest) =>
        withToast(
          latest,
          receipt.estimateStatus === 'approved'
            ? `${receipt.estimateNumber} approved by policy`
            : `${receipt.estimateNumber} needs owner approval`,
          receipt.replayed
            ? 'The durable idempotency receipt was replayed; no duplicate estimate or quote was created.'
            : `${receipt.quoteNumber} was created from server-owned measurements, approved terms, and the published price book.`,
        ),
      );
      return receipt;
    },
    [reloadLiveWorkspace],
  );

  const runPolicyCheck = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      setState((current) =>
        withToast(
          current,
          'Server pricing workflow required',
          'Live policy checks run against persisted measurements and the published price book on the server.',
        ),
      );
      return;
    }
    setState((current) => {
      const configurationBlock = sandboxConfigurationBlock(current, sandboxEstimateServiceCodes);
      if (configurationBlock) return configurationBlock;
      if (!hasPermission(current.role, 'estimates.write')) {
        return withToast(current, 'Action blocked', 'This role cannot recalculate estimates.');
      }
      const requiredServices: SandboxServiceCode[] = [];
      if (Number(current.estimate.drivewaySqFt) > 0) {
        requiredServices.push('pressure-wash-flatwork');
      }
      if (Number(current.estimate.gutterLinearFt) > 0) {
        requiredServices.push('gutter-cleaning');
      }
      const enabledServices = new Set(current.setupProfile?.enabledServiceCodes ?? []);
      const missingServices = requiredServices.filter((code) => !enabledServices.has(code));
      if (missingServices.length > 0) {
        return withToast(
          current,
          'Service not enabled',
          `This estimate requires ${missingServices.join(', ')}. Enable the service through setup before pricing.`,
        );
      }
      let result;
      try {
        result = calculateDemoPrice(current.estimate, current.companyConfiguration?.published);
      } catch {
        return withToast(
          current,
          'Estimate needs input',
          'Measurements must be positive decimal values.',
        );
      }
      const estimate = calculateAndMerge(current.estimate, current.companyConfiguration?.published);
      const blockingFlags = result.approvalFlags.filter((flag) => flag.blocking);
      if (result.issues.some((issue) => issue.severity === 'error')) {
        return withToast(
          { ...current, estimate: { ...estimate, status: 'draft' } },
          'Estimate cannot be quoted',
          result.issues.find((issue) => issue.severity === 'error')?.message ??
            'Correct the pricing inputs.',
        );
      }
      if (blockingFlags.length > 0) {
        const approvalId = `approval-${current.estimate.id}`;
        const approval: DemoApproval = {
          id: approvalId,
          reason:
            blockingFlags[0]?.reason === 'large_discount' ? 'large_discount' : 'large_discount',
          title:
            blockingFlags[0]?.reason === 'large_discount'
              ? `${current.estimate.discountPercent}% estimate discount`
              : 'Estimate exception',
          summary: blockingFlags.map((flag) => flag.summary).join(' '),
          risk: 'medium',
          status: 'pending',
          requestedAt: shortTime(),
          expiresAt: 'Jul 29, 5:00 PM',
          entityId: current.estimate.id,
          payloadPreview: `${current.estimate.estimateNumber} · $${result.total.amount} · exact calculation snapshot`,
          policyVersion: 'storyops-policy-v1.0.0',
        };
        const withoutDuplicate = current.approvals.filter((item) => item.id !== approvalId);
        const next = withEvidence(
          {
            ...current,
            estimate: { ...estimate, status: 'pending_approval' },
            approvals: [approval, ...withoutDuplicate],
          },
          {
            agent: 'Estimating',
            action: 'Evaluated deterministic estimate',
            result: 'approval_required',
            detail: blockingFlags.map((flag) => flag.summary).join(' '),
            promptVersion: 'estimating-tools-v1',
          },
          {
            actor: 'agent:estimating',
            action: 'approval.requested',
            entity: approvalId,
            outcome: 'pending',
          },
        );
        return withToast(next, 'Owner approval required', blockingFlags[0]?.summary ?? '');
      }
      const next = withEvidence(
        {
          ...current,
          estimate: { ...estimate, status: 'approved' },
          leads: current.leads.map((lead) =>
            lead.id === estimate.leadId
              ? { ...lead, stage: 'estimated', value: `$${result.total.amount}` }
              : lead,
          ),
        },
        {
          agent: 'Estimating',
          action: 'Calculated policy-compliant estimate',
          result: 'succeeded',
          detail: `${result.calculationVersion}; verified measurements and published price book.`,
          promptVersion: 'estimating-tools-v1',
        },
        {
          actor: 'system:pricing',
          action: 'estimate.approved_by_policy',
          entity: estimate.id,
          outcome: 'success',
        },
      );
      return withToast(
        next,
        'Estimate is within policy',
        'No price, margin, evidence, or SOP exception was found.',
      );
    });
  }, []);

  const decideApproval = useCallback(
    (id: string, decision: 'approved' | 'rejected') => {
      if (stateRef.current.dataMode === 'supabase') {
        const version = stateRef.current.live?.approvalVersions[id];
        if (!version) {
          setState((current) =>
            withToast(current, 'Decision blocked', 'The approval version is unavailable or stale.'),
          );
          return;
        }
        void runLiveCommand(
          {
            commandType: 'approval.decide',
            expectedVersion: version,
            payload: {
              entityId: id,
              decision,
              decisionNote: 'Decision submitted from the authenticated StoryOps workspace.',
            },
          },
          {
            title: decision === 'approved' ? 'Approval granted' : 'Request rejected',
            detail: 'The server applied the owner decision to the exact pending payload.',
          },
        );
        return;
      }
      setState((current) => {
        if (current.role !== 'owner') {
          return withToast(
            current,
            'Owner approval required',
            'Only the owner can decide this item.',
          );
        }
        const target = current.approvals.find((approval) => approval.id === id);
        if (!target || target.status !== 'pending') return current;
        const approvals = current.approvals.map((approval) =>
          approval.id === id ? { ...approval, status: decision, decidedAt: isoNow() } : approval,
        );
        let estimate = current.estimate;
        if (target.entityId === current.estimate.id) {
          estimate = {
            ...estimate,
            status: decision === 'approved' ? 'approved' : 'draft',
          };
        }
        const next = withEvidence(
          { ...current, approvals, estimate },
          {
            agent: 'Orchestrator',
            action: `Applied owner decision: ${decision}`,
            result: 'succeeded',
            detail: `Exact payload for ${target.id} was ${decision}; downstream execution remains idempotent.`,
            promptVersion: 'orchestrator-v1.0',
          },
          {
            actor: 'user:owner',
            action: `approval.${decision}`,
            entity: id,
            outcome: decision,
          },
        );
        return withToast(
          next,
          decision === 'approved' ? 'Approval granted' : 'Request rejected',
          decision === 'approved'
            ? 'The exact proposed payload may now execute once.'
            : 'No external action was taken.',
        );
      });
    },
    [runLiveCommand],
  );

  const executeApprovedAction = useCallback(
    (id: string) => {
      const current = stateRef.current;
      const approval = current.approvals.find((item) => item.id === id);
      const executableAction =
        approval?.actionType === 'payments.refund' ||
        approval?.actionType === 'records.create_lead' ||
        approval?.actionType === 'records.update_lead';
      if (
        current.dataMode !== 'supabase' ||
        current.role !== 'owner' ||
        !approval ||
        approval.status !== 'approved' ||
        !executableAction ||
        approval.consumedAt
      ) {
        setState((state) =>
          withToast(
            state,
            'Execution blocked',
            'Only an authenticated owner can execute an unconsumed action supported by the registered server validator.',
          ),
        );
        return;
      }
      if (!hasCurrentServerVerification(current)) {
        setState((state) =>
          withToast(
            state,
            'Connection required',
            'Approved actions are never queued offline because current authorization and authoritative state must be revalidated.',
          ),
        );
        return;
      }
      const repository = liveRepositoryRef.current;
      if (!repository) {
        setState((state) =>
          withToast(state, 'Execution blocked', 'The authenticated repository is unavailable.'),
        );
        return;
      }
      void repository
        .executeApprovedAction(id)
        .then(async (result) => {
          await reloadLiveWorkspace();
          const leadAction =
            result.toolName === 'records.create_lead' || result.toolName === 'records.update_lead';
          setState((state) =>
            withToast(
              state,
              result.replayed
                ? 'Execution already confirmed'
                : leadAction
                  ? 'Approved lead action applied'
                  : 'Approved refund executed',
              result.replayed
                ? 'The durable receipt confirms this exact action executed previously; no duplicate mutation occurred.'
                : leadAction
                  ? 'StoryOps applied the exact lead payload and consumed the approval in one database transaction.'
                  : 'Stripe returned an authoritative receipt and StoryOps consumed the approval exactly once.',
            ),
          );
        })
        .catch(async (error: unknown) => {
          try {
            await reloadLiveWorkspace();
          } catch {
            // Preserve the execution failure as the primary user-facing error.
          }
          const detail =
            error instanceof Error ? error.message : 'The approved action was not executed.';
          setState((state) =>
            withToast({ ...state, liveError: detail }, 'Approved action not executed', detail),
          );
        });
    },
    [reloadLiveWorkspace],
  );

  const sendQuote = useCallback(
    (expectedQuoteId?: string) => {
      if (stateRef.current.dataMode === 'supabase') {
        const quote = stateRef.current.live?.quote;
        if (!quote || (expectedQuoteId && quote.id !== expectedQuoteId)) {
          setState((current) =>
            withToast(
              current,
              'Exact quote unavailable',
              expectedQuoteId
                ? 'The selected lead receipt no longer matches the role-visible quote. Refresh instead of publishing another customer’s quote.'
                : 'No role-visible draft quote with an optimistic version is selected.',
            ),
          );
          return;
        }
        void runLiveCommand(
          {
            commandType: 'quote.send',
            expectedVersion: quote.version,
            payload: { entityId: quote.id },
          },
          {
            title: 'Published to customer portal',
            detail:
              'The server verified the approved estimate, quote validity, role, and version. No email or SMS delivery is asserted.',
          },
        );
        return;
      }
      setState((current) => {
        const configurationBlock = sandboxConfigurationBlock(current, sandboxEstimateServiceCodes);
        if (configurationBlock) return configurationBlock;
        if (!hasPermission(current.role, 'estimates.write')) {
          return withToast(current, 'Action blocked', 'This role cannot publish quotes.');
        }
        if (current.estimate.status !== 'approved' && current.estimate.status !== 'quoted') {
          return withToast(
            current,
            'Quote not published',
            'Run the policy check and resolve approvals first.',
          );
        }
        if (current.estimate.status === 'quoted') {
          return withToast(
            current,
            'Duplicate prevented',
            'This quote was already published with the same idempotency key.',
          );
        }
        const next = withEvidence(
          {
            ...current,
            estimate: { ...current.estimate, status: 'quoted' },
            leads: current.leads.map((lead) =>
              lead.id === current.estimate.leadId ? { ...lead, stage: 'quoted' } : lead,
            ),
          },
          {
            agent: 'Follow-up',
            action: 'Recorded sandbox portal-publication fixture',
            result: 'succeeded',
            detail:
              'A synthetic portal-publication fixture was recorded locally; no email/SMS delivery receipt exists and no provider was contacted.',
            promptVersion: 'followup-v5.0',
          },
          {
            actor: 'sandbox:follow_up',
            action: 'quote.portal_publication_fixture_recorded',
            entity: current.estimate.id,
            outcome: 'synthetic',
          },
        );
        return withToast(
          next,
          'Sandbox portal publication recorded',
          'The quote is visible in the local portal preview. No email/SMS delivery is asserted and no customer was contacted.',
        );
      });
    },
    [runLiveCommand],
  );

  const queueTransactionalDelivery = useCallback(
    async (input: {
      action: 'quote.delivery' | 'visit.on_my_way';
      channel: 'sms' | 'email';
    }): Promise<boolean> => {
      const current = stateRef.current;
      if (current.dataMode !== 'supabase') {
        setState((state) =>
          withToast(
            state,
            'Sandbox communication recorded',
            input.action === 'quote.delivery'
              ? `A synthetic ${input.channel.toUpperCase()} quote-delivery request was recorded locally. No provider or customer was contacted.`
              : `A synthetic ${input.channel.toUpperCase()} on-my-way request was recorded locally. No provider or customer was contacted.`,
          ),
        );
        return true;
      }
      if (!hasPermission(current.role, 'communications.send')) {
        setState((state) =>
          withToast(
            state,
            'Communication blocked',
            'This role cannot queue customer communications.',
          ),
        );
        return false;
      }
      if (!hasCurrentServerVerification(current)) {
        setState((state) =>
          withToast(
            state,
            'Connection required',
            'Refresh the authenticated workspace before queuing a customer communication.',
          ),
        );
        return false;
      }
      const selectedScope =
        input.action === 'visit.on_my_way' ? selectedLiveVisitScope(current) : undefined;
      const entity =
        input.action === 'quote.delivery' ? current.live?.quote : selectedScope?.visitReference;
      if (!entity) {
        setState((state) =>
          withToast(
            state,
            'Current entity unavailable',
            input.action === 'quote.delivery'
              ? 'No versioned portal-published quote is selected.'
              : 'No versioned assigned visit is selected.',
          ),
        );
        return false;
      }
      const repository = liveRepositoryRef.current;
      if (!repository) {
        setState((state) =>
          withToast(state, 'Communication blocked', 'The authenticated repository is unavailable.'),
        );
        return false;
      }
      try {
        if (
          input.action === 'visit.on_my_way' &&
          selectedLiveVisitScope(stateRef.current)?.visitReference.id !== entity.id
        ) {
          throw new Error('The selected visit changed before the on-my-way request was queued.');
        }
        const receipt = await repository.queueTransactionalDelivery({
          action: input.action,
          entityId: entity.id,
          entityVersion: entity.version,
          channel: input.channel,
        });
        await reloadLiveWorkspace();
        setState((state) =>
          withToast(
            state,
            receipt.replayed ? 'Delivery request already queued' : 'Delivery request queued',
            `${input.channel.toUpperCase()} is durably queued from current consent and contact evidence. Provider submission and customer delivery are not yet asserted.`,
          ),
        );
        return true;
      } catch (error) {
        try {
          await reloadLiveWorkspace();
        } catch {
          // Keep the delivery error as the primary operator-facing failure.
        }
        const detail =
          error instanceof Error ? error.message : 'The transactional message was not queued.';
        setState((state) =>
          withToast({ ...state, liveError: detail }, 'Communication not queued', detail),
        );
        return false;
      }
    },
    [reloadLiveWorkspace],
  );

  const acceptQuote = useCallback(
    async (input: { signerName: string; acknowledged: boolean }): Promise<boolean> => {
      const signerName = input.signerName.trim();
      if (
        input.acknowledged !== true ||
        signerName.length < 2 ||
        signerName.length > 120 ||
        containsControlCharacters(signerName)
      ) {
        setState((current) =>
          withToast(
            current,
            'Acceptance not recorded',
            'Type the signer’s name and affirmatively acknowledge the exact quote and terms.',
          ),
        );
        return false;
      }

      const current = stateRef.current;
      if (current.dataMode === 'supabase') {
        const repository = liveRepositoryRef.current;
        const quote = current.live?.customerCommercialPortal?.quote;
        if (
          current.role !== 'customer' ||
          !repository ||
          !hasCurrentServerVerification(current) ||
          !quote ||
          !current.live?.customerId ||
          !['sent', 'viewed'].includes(quote.status)
        ) {
          setState((latest) =>
            withToast(
              latest,
              'Quote unavailable',
              'Only the authenticated customer can accept a current, server-verified published quote.',
            ),
          );
          return false;
        }
        try {
          await repository.acceptCustomerQuote({
            customerId: current.live.customerId,
            quoteId: quote.id,
            quoteVersion: quote.version,
            signerName,
            acknowledged: true,
            termsVersion: quote.termsVersion,
            total: quote.total,
          });
          await reloadLiveWorkspace();
          setState((latest) =>
            withToast(
              latest,
              'Quote and terms accepted',
              'The server retained the typed signer, authenticated customer, exact version, terms, total, timestamp, and immutable context hash.',
            ),
          );
          return true;
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'Acceptance was not stored.';
          await reloadLiveWorkspace().catch(() => undefined);
          setState((latest) =>
            withToast({ ...latest, liveError: detail }, 'Acceptance not recorded', detail),
          );
          return false;
        }
      }

      let accepted = false;
      setState((latest) => {
        const configurationBlock = sandboxConfigurationBlock(latest, sandboxEstimateServiceCodes);
        if (configurationBlock) return configurationBlock;
        if (
          !hasPermission(latest.role, 'portal.self.write') &&
          !hasPermission(latest.role, 'estimates.write')
        ) {
          return withToast(latest, 'Action blocked', 'This role cannot accept customer terms.');
        }
        if (latest.estimate.status !== 'quoted' && !latest.customerQuoteAccepted) {
          return withToast(latest, 'Quote unavailable', 'The approved quote must be sent first.');
        }
        if (latest.customerQuoteAccepted) {
          accepted = true;
          return withToast(
            latest,
            'Acceptance already recorded',
            'The signed terms fixture has not been duplicated.',
          );
        }
        accepted = true;
        const next = withEvidence(
          {
            ...latest,
            customerQuoteAccepted: true,
            depositPaid: true,
            leads: latest.leads.map((lead) =>
              lead.id === latest.estimate.leadId ? { ...lead, stage: 'quoted' } : lead,
            ),
          },
          {
            agent: 'Scheduling',
            action: 'Recorded explicit sandbox acceptance and deposit fixtures',
            result: 'succeeded',
            detail: `Synthetic terms were affirmatively acknowledged by typed signer “${signerName}”; no payment provider was contacted and no funds moved.`,
            promptVersion: 'scheduling-v3.2',
          },
          {
            actor: 'sandbox:customer_fixture',
            action: 'quote.acceptance_fixture_recorded',
            entity: latest.estimate.id,
            outcome: 'synthetic',
          },
        );
        return withToast(
          next,
          'Sandbox acceptance recorded',
          'The typed signer and affirmative terms fixture were recorded locally. The deposit remains synthetic; no funds moved.',
        );
      });
      return accepted;
    },
    [reloadLiveWorkspace],
  );

  const markQuoteViewed = useCallback(() => {
    const current = stateRef.current;
    const repository = liveRepositoryRef.current;
    const quote = current.live?.customerCommercialPortal?.quote;
    if (
      current.dataMode !== 'supabase' ||
      current.role !== 'customer' ||
      !hasCurrentServerVerification(current) ||
      !repository ||
      !quote ||
      quote.status !== 'sent' ||
      !current.live?.customerId
    ) {
      return;
    }
    void repository
      .executeCustomerQuoteAction({
        customerId: current.live.customerId,
        quoteId: quote.id,
        quoteVersion: quote.version,
        action: 'quote.view',
        commandId: quote.id,
      })
      .then(() => reloadLiveWorkspace())
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : 'Quote view was not recorded.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Quote view not recorded', detail),
        );
      });
  }, [reloadLiveWorkspace]);

  const submitQuoteDecision = useCallback(
    async (input: {
      action: 'quote.decline' | 'quote.change_request';
      requestedServiceCodes?: string[];
      requestedAddOnCodes?: string[];
      notes: string;
    }): Promise<boolean> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const quote = current.live?.customerCommercialPortal?.quote;
      if (
        current.dataMode !== 'supabase' ||
        current.role !== 'customer' ||
        !hasCurrentServerVerification(current) ||
        !repository ||
        !quote ||
        !current.live?.customerId ||
        !['sent', 'viewed'].includes(quote.status)
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Quote decision unavailable',
            'Only the authenticated customer can act on a current published quote.',
          ),
        );
        return false;
      }
      try {
        await repository.executeCustomerQuoteAction({
          customerId: current.live.customerId,
          quoteId: quote.id,
          quoteVersion: quote.version,
          action: input.action,
          requestedServiceCodes: input.requestedServiceCodes,
          requestedAddOnCodes: input.requestedAddOnCodes,
          notes: input.notes,
        });
        await reloadLiveWorkspace();
        setState((latest) =>
          withToast(
            latest,
            input.action === 'quote.decline' ? 'Quote declined' : 'Change request sent for review',
            input.action === 'quote.decline'
              ? 'The published quote can no longer be accepted.'
              : 'The exact quote is unchanged and unaccepted. The office must re-estimate, review policy, and publish a replacement.',
          ),
        );
        return true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Quote decision was not stored.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Quote decision not stored', detail),
        );
        return false;
      }
    },
    [reloadLiveWorkspace],
  );

  const resolveQuoteChangeRequest = useCallback(
    async (input: {
      requestId: string;
      requestVersion: number;
      disposition: 'replacement_published' | 'cancelled';
      replacementQuoteId?: string;
      replacementQuoteVersion?: number;
      resolutionNote: string;
    }): Promise<boolean> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      if (
        current.dataMode !== 'supabase' ||
        !repository ||
        !hasCurrentServerVerification(current) ||
        !['owner', 'dispatcher'].includes(current.role)
      ) {
        return false;
      }
      try {
        await repository.resolveCustomerQuoteChangeRequest(input);
        await reloadLiveWorkspace();
        setState((latest) =>
          withToast(
            latest,
            input.disposition === 'replacement_published'
              ? 'Replacement quote linked'
              : 'Change request closed',
            input.disposition === 'replacement_published'
              ? 'The exact published replacement quote/version now resolves the customer request.'
              : 'The cancellation reason and actor were recorded in the audit trail.',
          ),
        );
        return true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Resolution was not recorded.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Request remains open', detail),
        );
        return false;
      }
    },
    [reloadLiveWorkspace],
  );

  const resolvePaymentAllocation = useCallback(
    async (input: { conflictId: string; resolutionNote: string }): Promise<boolean> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const conflict = current.live?.paymentAllocationConflicts?.find(
        (candidate) => candidate.id === input.conflictId,
      );
      const approval = conflict?.approvalRequestId
        ? current.approvals.find((candidate) => candidate.id === conflict.approvalRequestId)
        : undefined;
      const invoiceVersion = conflict
        ? current.live?.invoiceVersions[conflict.invoiceId]
        : undefined;
      if (
        current.dataMode !== 'supabase' ||
        current.role !== 'owner' ||
        !hasPermission(current.role, 'payments.manage') ||
        !repository ||
        !hasCurrentServerVerification(current) ||
        !conflict ||
        !conflict.canApplyExactCurrentBalance ||
        conflict.resolutionAction !== 'payment.allocation.apply_exact_current_balance' ||
        !conflict.approvalRequestId ||
        !approval ||
        approval.status !== 'approved' ||
        approval.actionType !== 'payment.allocation.apply_exact_current_balance' ||
        approval.entityId !== conflict.id ||
        approval.consumedAt ||
        !invoiceVersion
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Payment allocation remains on hold',
            'An authenticated owner, a current server read, and the exact approved current-balance resolution are required.',
          ),
        );
        return false;
      }
      try {
        const receipt = await repository.resolvePaymentAllocation({
          conflictId: conflict.id,
          conflictVersion: conflict.version,
          invoiceId: conflict.invoiceId,
          invoiceVersion,
          approvalRequestId: conflict.approvalRequestId,
          resolutionNote: input.resolutionNote,
        });
        await reloadLiveWorkspace();
        setState((latest) =>
          withToast(
            latest,
            'Verified funds applied',
            `$${receipt.amount} was applied to the exact current invoice after the server consumed the owner approval.`,
          ),
        );
        return true;
      } catch (error) {
        try {
          await reloadLiveWorkspace();
        } catch {
          // Preserve the resolution failure as the primary user-facing error.
        }
        const detail =
          error instanceof Error ? error.message : 'The verified funds were not applied.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Payment allocation remains on hold', detail),
        );
        return false;
      }
    },
    [reloadLiveWorkspace],
  );

  const startDepositCheckout = useCallback(() => {
    if (stateRef.current.dataMode !== 'supabase') {
      setState((current) =>
        withToast(
          current,
          'Sandbox deposit already recorded',
          'The in-browser sandbox golden path keeps its deterministic local payment fixture.',
        ),
      );
      return;
    }
    const repository = liveRepositoryRef.current;
    const commercialPortal = stateRef.current.live?.customerCommercialPortal;
    const quote = commercialPortal?.quote;
    const selectedCustomerId = stateRef.current.live?.selectedPortalCustomerId;
    if (
      !repository ||
      !quote ||
      stateRef.current.role !== 'customer' ||
      !selectedCustomerId ||
      stateRef.current.live?.customerId !== selectedCustomerId ||
      !hasCurrentServerVerification(stateRef.current) ||
      commercialPortal?.paymentReconciliationRequired
    ) {
      setState((current) =>
        withToast(
          current,
          'Checkout unavailable',
          commercialPortal?.paymentReconciliationMessage ??
            'An authenticated customer, accepted quote, and current server verification are required to prepare checkout.',
        ),
      );
      return;
    }
    void repository
      .startDepositCheckout({
        quoteId: quote.id,
        quoteVersion: quote.version,
        commandId: quote.id,
      })
      .then(async (receipt) => {
        await reloadLiveWorkspace();
        if (receipt.mode === 'live' && receipt.checkoutUrl) {
          const checkoutUrl = new URL(receipt.checkoutUrl);
          if (checkoutUrl.protocol !== 'https:') {
            throw new Error('The hosted checkout URL did not use HTTPS.');
          }
          window.location.assign(checkoutUrl.toString());
          return;
        }
        setState((current) =>
          withToast(
            current,
            receipt.depositReady ? 'Deposit requirement satisfied' : 'Sandbox checkout prepared',
            receipt.status === 'already_verified'
              ? 'The server found provider-reconciled deposit evidence; no duplicate checkout was opened.'
              : receipt.status === 'not_required'
                ? 'The accepted quote requires no deposit; no payment success was asserted.'
                : (receipt.sandboxReceipt ??
                  'No payment was recorded. Booking remains blocked pending signed webhook reconciliation.'),
          ),
        );
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : 'Checkout was not prepared.';
        setState((current) =>
          withToast({ ...current, liveError: detail }, 'Checkout not opened', detail),
        );
      });
  }, [reloadLiveWorkspace]);

  const startInvoiceCheckout = useCallback(
    (invoiceId: string) => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const invoice = current.live?.customerCommercialPortal?.invoices.find(
        (candidate) => candidate.id === invoiceId,
      );
      if (
        current.dataMode !== 'supabase' ||
        current.role !== 'customer' ||
        !repository ||
        !hasCurrentServerVerification(current) ||
        !invoice ||
        invoice.paymentReconciliationRequired ||
        current.live?.customerCommercialPortal?.paymentReconciliationRequired ||
        !['open', 'past_due'].includes(invoice.status) ||
        Number(invoice.balanceDue) <= 0
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Invoice checkout unavailable',
            invoice?.paymentReconciliationMessage ??
              current.live?.customerCommercialPortal?.paymentReconciliationMessage ??
              'Refresh to load an issued invoice with a current nonzero balance and no collection hold.',
          ),
        );
        return;
      }
      void repository
        .startInvoiceCheckout({
          invoiceId: invoice.id,
          invoiceVersion: invoice.version,
        })
        .then(async (receipt) => {
          await reloadLiveWorkspace();
          if (receipt.mode === 'live' && receipt.checkoutUrl) {
            const checkoutUrl = new URL(receipt.checkoutUrl);
            if (checkoutUrl.protocol !== 'https:') {
              throw new Error('The hosted checkout URL did not use HTTPS.');
            }
            window.location.assign(checkoutUrl.toString());
            return;
          }
          setState((latest) =>
            withToast(
              latest,
              'Sandbox invoice checkout prepared',
              receipt.sandboxReceipt ??
                'No funds moved and the invoice remains unpaid until signed provider reconciliation.',
            ),
          );
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : 'Checkout was not prepared.';
          setState((latest) =>
            withToast({ ...latest, liveError: detail }, 'Invoice checkout not opened', detail),
          );
        });
    },
    [reloadLiveWorkspace],
  );

  const loadSchedulingSuggestions = useCallback(async (): Promise<
    SchedulingSuggestionsResponse | undefined
  > => {
    const current = stateRef.current;
    const repository = liveRepositoryRef.current;
    const dispatchJob = current.live?.dispatchJob;
    if (
      current.dataMode !== 'supabase' ||
      !repository ||
      !dispatchJob ||
      current.selectedDispatchJobId !== dispatchJob.id ||
      !hasPermission(current.role, 'dispatch.manage')
    ) {
      setState((latest) =>
        withToast(
          latest,
          'Scheduling suggestions unavailable',
          'An authenticated owner or dispatcher and one ready-to-schedule job are required.',
        ),
      );
      return undefined;
    }
    if (!current.online) {
      setState((latest) =>
        withToast(
          latest,
          'Online suggestion refresh required',
          'Current internal capacity, crew, equipment, and visit-conflict facts cannot be checked offline.',
        ),
      );
      return undefined;
    }
    try {
      const result = await repository.loadSchedulingSuggestions({
        jobId: dispatchJob.id,
        expectedJobVersion: dispatchJob.version,
        ...(dispatchJob.assignedCrewId ? { crewId: dispatchJob.assignedCrewId } : {}),
      });
      if (stateRef.current.selectedDispatchJobId !== dispatchJob.id) {
        throw new Error('The ready-to-schedule job selection changed while suggestions loaded.');
      }
      return result;
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'Scheduling suggestions could not be loaded.';
      setState((latest) =>
        withToast({ ...latest, liveError: detail }, 'Scheduling suggestions failed', detail),
      );
      return undefined;
    }
  }, []);

  const refreshSchedulingEvidence = useCallback(
    async (input: {
      startsAt: string;
      endsAt: string;
      crewId?: string;
    }): Promise<LiveSchedulingEvidenceResult | undefined> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const dispatchJob = current.live?.dispatchJob;
      if (
        current.dataMode !== 'supabase' ||
        !repository ||
        !dispatchJob ||
        current.selectedDispatchJobId !== dispatchJob.id ||
        !hasPermission(current.role, 'dispatch.manage')
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Scheduling verification unavailable',
            'An authenticated owner or dispatcher and one ready-to-schedule job are required.',
          ),
        );
        return undefined;
      }
      if (!current.online) {
        setState((latest) =>
          withToast(
            latest,
            'Online verification required',
            'Refresh the scoped workspace before checking calendar, route, weather, capacity, and resource evidence.',
          ),
        );
        return undefined;
      }
      try {
        const result = await repository.refreshSchedulingEvidence({
          jobId: dispatchJob.id,
          expectedJobVersion: dispatchJob.version,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          ...(input.crewId ? { crewId: input.crewId } : {}),
        });
        if (stateRef.current.selectedDispatchJobId !== dispatchJob.id) {
          throw new Error('The ready-to-schedule job selection changed during verification.');
        }
        setState((latest) =>
          withToast(
            latest,
            result.bookable ? 'Live scheduling evidence ready' : 'Window is not bookable',
            result.message,
          ),
        );
        return result;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'Scheduling evidence could not be refreshed.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Scheduling verification failed', detail),
        );
        return undefined;
      }
    },
    [],
  );

  const bookJob = useCallback(
    (schedulingEvidenceReceiptId?: string) => {
      if (stateRef.current.dataMode === 'supabase') {
        const current = stateRef.current;
        const job = current.live?.dispatchJob;
        if (
          !job ||
          current.selectedDispatchJobId !== job.id ||
          !hasPermission(current.role, 'dispatch.manage')
        ) {
          setState((current) =>
            withToast(
              current,
              'Booking unavailable',
              'No accepted quote-backed job with an optimistic version is selected.',
            ),
          );
          return;
        }
        void runLiveGoldenPathCommand(
          {
            commandType: 'job.book',
            expectedVersion: job.version,
            payload: {
              entityId: job.id,
              ...(schedulingEvidenceReceiptId ? { schedulingEvidenceReceiptId } : {}),
            },
            commandId: job.id,
          },
          {
            title: 'Visit booked',
            detail:
              'The server consumed one reconciled live calendar receipt and reverified deposit state, skills, equipment, crew overlap, route, weather, and the active operating baseline.',
          },
        );
        return;
      }
      setState((current) => {
        const configurationBlock = sandboxConfigurationBlock(current, sandboxEstimateServiceCodes);
        if (configurationBlock) return configurationBlock;
        if (!hasPermission(current.role, 'dispatch.manage')) {
          return withToast(current, 'Action blocked', 'This role cannot manage dispatch.');
        }
        if (!current.customerQuoteAccepted || !current.depositPaid) {
          return withToast(
            current,
            'Booking blocked',
            'Verified quote acceptance and deposit state are required before booking.',
          );
        }
        const next = withEvidence(
          {
            ...current,
            customerQuoteAccepted: true,
            leads: current.leads.map((lead) =>
              lead.id === current.estimate.leadId ? { ...lead, stage: 'booked' } : lead,
            ),
          },
          {
            agent: 'Scheduling',
            action: 'Recorded sandbox booking fixture',
            result: 'succeeded',
            detail:
              'Synthetic crew, equipment, route, and weather inputs advanced the local scenario; no live slot was reserved.',
            promptVersion: 'scheduling-v3.1',
          },
          {
            actor: 'sandbox:scheduling',
            action: 'visit.booking_fixture_recorded',
            entity: 'visit-morgan',
            outcome: 'synthetic',
          },
        );
        return withToast(
          next,
          'Sandbox visit recorded',
          'The synthetic Friday slot advanced locally; no live availability was reserved.',
        );
      });
    },
    [runLiveGoldenPathCommand],
  );

  const optimizeRoutes = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      setState((current) =>
        withToast(
          current,
          'Live routing command unavailable',
          'No route was changed. Live optimization requires an authenticated scheduling service command.',
        ),
      );
      return;
    }
    setState((current) => {
      if (!hasPermission(current.role, 'dispatch.manage')) {
        return withToast(current, 'Action blocked', 'This role cannot optimize dispatch.');
      }
      const next = withEvidence(
        {
          ...current,
          visits: current.visits.map((visit) => ({
            ...visit,
            route: {
              ...visit.route,
              checkedAt: 'just now',
              feasible: true,
            },
          })),
        },
        {
          agent: 'Scheduling',
          action: 'Recorded synthetic route fixture',
          result: 'succeeded',
          detail:
            'Fixed demo inputs exercised the VROOM workflow; the result is not provider-confirmed dispatch evidence.',
          promptVersion: 'scheduling-v3.1',
        },
        {
          actor: `sandbox:${current.role}`,
          action: 'dispatch.route_fixture_recorded',
          entity: 'owner-crew',
          outcome: 'synthetic',
        },
      );
      return withToast(
        next,
        'Sandbox route scenario updated',
        'Synthetic route state changed locally; no live route or feasibility was asserted.',
      );
    });
  }, []);

  const mutateVisit = useCallback(
    (
      action: string,
      updater: (visit: DemoVisit) => DemoVisit,
      toastTitle: string,
      toastDetail: string,
      requiresActiveWork = true,
    ) => {
      setState((current) => {
        if (!hasPermission(current.role, 'field.execute') && current.role !== 'owner') {
          return withToast(current, 'Field access required', 'Switch to owner or technician view.');
        }
        const target = selectedVisit(current);
        if (!target) return current;
        if (requiresActiveWork && target.status !== 'on_site' && target.status !== 'paused') {
          return withToast(
            current,
            'Start the job first',
            'Field evidence, materials, notes, and signatures require an active on-site timer.',
          );
        }
        const visits = current.visits.map((visit) =>
          visit.id === target.id ? updater(visit) : visit,
        );
        const mutation = {
          id: uniqueId('mutation'),
          idempotencyKey: `field:${target.id}:${action}:${current.syncRevision + 1}`,
          action,
          entityId: target.id,
          scopeVisitId: target.id,
          createdAt: isoNow(),
          status: 'queued' as const,
        };
        const nextState = {
          ...current,
          visits,
          syncRevision: current.syncRevision + 1,
          offlineQueue: current.online ? current.offlineQueue : [...current.offlineQueue, mutation],
        };
        const next = withEvidence(
          nextState,
          {
            agent: 'Safety',
            action,
            result: 'succeeded',
            detail: current.online
              ? 'Field update persisted with an idempotency key.'
              : 'Field update queued locally for offline recovery.',
            promptVersion: 'field-policy-v1',
          },
          {
            actor: `user:${current.role}`,
            action,
            entity: target.id,
            outcome: current.online ? 'synced' : 'queued_offline',
          },
        );
        return withToast(next, toastTitle, toastDetail);
      });
    },
    [],
  );

  const startRouteWithDispatchClearance = useCallback(
    async (currentOrigin: DispatchCurrentOrigin): Promise<boolean> => {
      const current = stateRef.current;
      if (current.dataMode !== 'supabase') {
        setState((state) =>
          withToast(
            state,
            'Live clearance unavailable',
            'The sandbox route remains a synthetic scenario and cannot create operational dispatch clearance.',
          ),
        );
        return false;
      }
      const repository = liveRepositoryRef.current;
      const scope = selectedLiveVisitScope(current);
      if (
        !repository ||
        !scope ||
        (!hasPermission(current.role, 'field.execute') && current.role !== 'owner')
      ) {
        setState((state) =>
          withToast(
            state,
            'Dispatch clearance blocked',
            'No exact versioned role-visible field visit is selected.',
          ),
        );
        return false;
      }
      if (
        scope.visit.status !== 'ready' ||
        current.live?.visitStatus !== 'confirmed' ||
        scope.visitReference.id !== scope.visit.id
      ) {
        setState((state) =>
          withToast(
            state,
            'Dispatch clearance blocked',
            'Only the exact selected confirmed visit can request departure clearance.',
          ),
        );
        return false;
      }
      if (!current.online || !current.serverVerifiedAt) {
        setState((state) =>
          withToast(
            state,
            'Online clearance required',
            'Starting a route requires a current server session plus fresh live NWS and VROOM evidence. It cannot be queued offline.',
          ),
        );
        return false;
      }
      if (
        current.offlineQueue.some(
          (mutation) => mutation.scopeVisitId === scope.visit.id && mutation.status !== 'synced',
        )
      ) {
        setState((state) =>
          withToast(
            state,
            'Sync this visit first',
            'Pending field mutations must reconcile before departure facts can bind to the exact visit version.',
          ),
        );
        return false;
      }

      const visitId = scope.visitReference.id;
      const expectedVisitVersion = scope.visitReference.version;
      const priorConsume = pendingDispatchConsumeRef.current;
      if (
        priorConsume &&
        (priorConsume.visitId !== visitId ||
          priorConsume.expectedVisitVersion !== expectedVisitVersion)
      ) {
        setState((state) =>
          withToast(
            state,
            'Resolve the prior departure first',
            'A dispatch consumption outcome is still being reconciled for another exact visit version. Refresh authoritative field state before requesting new clearance.',
          ),
        );
        return false;
      }

      let consumeInput = priorConsume;
      if (!consumeInput) {
        let clearance;
        try {
          clearance = await repository.refreshDispatchClearance({
            visitId,
            expectedVisitVersion,
            currentOrigin,
          });
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : 'Fresh dispatch evidence was unavailable.';
          setState((state) =>
            withToast({ ...state, liveError: detail }, 'Dispatch clearance unavailable', detail),
          );
          return false;
        }
        const refreshedScope = selectedLiveVisitScope(stateRef.current);
        if (
          !stateRef.current.online ||
          !stateRef.current.serverVerifiedAt ||
          refreshedScope?.visitReference.id !== visitId ||
          refreshedScope.visitReference.version !== expectedVisitVersion ||
          refreshedScope.visit.status !== 'ready' ||
          stateRef.current.live?.visitStatus !== 'confirmed'
        ) {
          setState((state) =>
            withToast(
              state,
              'Dispatch context changed',
              'The selected visit or online server context changed while fresh NWS/VROOM evidence was being checked.',
            ),
          );
          return false;
        }
        if (!clearance.cleared || !clearance.receipt) {
          setState((state) =>
            withToast(
              state,
              'Departure not cleared',
              `${clearance.message} (${clearance.reasonCode})`,
            ),
          );
          return false;
        }
        consumeInput = {
          visitId,
          expectedVisitVersion,
          clearanceReceiptId: clearance.receipt.receiptId,
          commandId: clearance.receipt.receiptId,
        };
        pendingDispatchConsumeRef.current = consumeInput;
      }

      let ambiguousResponseObserved = Boolean(consumeInput.outcomeUnknown);
      let consumed: Awaited<ReturnType<typeof repository.consumeDispatchClearance>>;
      try {
        try {
          consumed = await repository.consumeDispatchClearance(consumeInput);
        } catch (error) {
          if (!mutationOutcomeRequiresReconciliation(error)) throw error;
          ambiguousResponseObserved = true;
          pendingDispatchConsumeRef.current = { ...consumeInput, outcomeUnknown: true };
          consumed = await repository.consumeDispatchClearance(consumeInput);
        }
        if (
          consumed.visitId !== visitId ||
          consumed.previousVersion !== expectedVisitVersion ||
          consumed.currentStatus !== 'en_route'
        ) {
          throw new Error('The server returned a dispatch receipt for another visit transition.');
        }
        pendingDispatchConsumeRef.current = undefined;
        await reloadLiveWorkspace();
        setState((state) =>
          withToast(
            state,
            'Route started',
            `The server atomically consumed one fresh NWS/VROOM clearance for this exact visit${consumed.replayed ? ' as an idempotent replay' : ''}.`,
          ),
        );
        return true;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'The visit did not transition to en route.';
        const outcomeUnknown =
          ambiguousResponseObserved || mutationOutcomeRequiresReconciliation(error);
        if (outcomeUnknown) {
          pendingDispatchConsumeRef.current = { ...consumeInput, outcomeUnknown: true };
        } else {
          pendingDispatchConsumeRef.current = undefined;
        }
        await reloadLiveWorkspace();
        const stillUnknown =
          pendingDispatchConsumeRef.current?.commandId === consumeInput.commandId &&
          pendingDispatchConsumeRef.current.outcomeUnknown === true;
        setState((state) => {
          const readbackConfirmed =
            state.live?.visit?.id === visitId &&
            state.live.visit.version === expectedVisitVersion + 1 &&
            state.live.visitStatus === 'en_route';
          if (readbackConfirmed) {
            pendingDispatchConsumeRef.current = undefined;
            return withToast(
              state,
              'Route start confirmed by readback',
              'The response was interrupted, but the authoritative workspace confirms the exact visit is en route.',
            );
          }
          if (!stillUnknown) {
            return withToast(
              { ...state, liveError: detail },
              'Route was not started',
              `${detail} Authoritative readback did not show the departure transaction.`,
            );
          }
          return withToast(
            { ...state, liveError: detail },
            'Route-start outcome unconfirmed',
            `${detail} Keep this exact visit and clearance unchanged. Retry reuses the same consume command UUID and request hash until a durable receipt or authoritative readback resolves the outcome.`,
          );
        });
        return false;
      }
    },
    [reloadLiveWorkspace],
  );

  const updateVisitStatus = useCallback(
    (status: DemoVisit['status']) => {
      if (stateRef.current.dataMode === 'supabase') {
        if (status === 'complete') {
          setState((current) =>
            withToast(
              current,
              'Completion packet required',
              'Use Complete job so checklist, media, signature, materials, notes, timer, incidents, and queued dependencies are checked together.',
            ),
          );
          return;
        }
        if (status === 'en_route') {
          setState((current) =>
            withToast(
              current,
              'Current departure location required',
              'Use the field departure button so this device can capture explicit location consent and bind a fresh accurate origin to live route evidence.',
            ),
          );
          return;
        }
        const current = stateRef.current;
        const scope = selectedLiveVisitScope(current);
        if (!scope || (!hasPermission(current.role, 'field.execute') && current.role !== 'owner')) {
          setState((state) =>
            withToast(state, 'Visit update blocked', 'No versioned assigned visit is selected.'),
          );
          return;
        }
        const { visitReference } = scope;
        const targetStatus = status;
        const transition = {
          commandType: 'visit.transition' as const,
          expectedVersion: visitReference.version,
          payload: { entityId: visitReference.id, status: targetStatus },
        };
        const now = isoNow();
        const activeTime = current.live?.activeTimeEntry;
        const commands: Array<{
          commandType: StoryOpsCommandType;
          expectedVersion: number;
          payload: Record<string, unknown>;
          commandId?: string;
        }> = [];
        let startedTimeId: string | undefined;

        if (status === 'paused' && activeTime) {
          commands.push({
            commandType: 'time.stop',
            expectedVersion: activeTime.version,
            payload: { entityId: activeTime.id, endedAt: now },
          });
        }
        commands.push(transition);
        if (status === 'on_site' && !activeTime) {
          startedTimeId = crypto.randomUUID();
          commands.push({
            commandType: 'time.start',
            expectedVersion: 0,
            payload: {
              entityId: startedTimeId,
              visitId: visitReference.id,
              startedAt: now,
            },
          });
        }

        void runLiveCommands(
          commands,
          {
            title: status === 'on_site' ? 'On-site work started' : 'Visit updated',
            detail: `The authenticated server moved the visit to ${targetStatus.replaceAll('_', ' ')}.`,
          },
          (optimisticState) => ({
            ...optimisticState,
            visits: optimisticState.visits.map((item) =>
              item.id === visitReference.id
                ? {
                    ...item,
                    status,
                    timerStartedAt: status === 'on_site' ? now : undefined,
                  }
                : item,
            ),
            live: optimisticState.live
              ? {
                  ...optimisticState.live,
                  visit: {
                    ...visitReference,
                    version: visitReference.version + 1,
                  },
                  visitStatus: targetStatus,
                  activeTimeEntry:
                    status === 'on_site' && startedTimeId
                      ? { id: startedTimeId, version: 1 }
                      : status === 'paused'
                        ? undefined
                        : optimisticState.live.activeTimeEntry,
                }
              : undefined,
          }),
          visitReference.id,
        );
        return;
      }
      mutateVisit(
        `visit.status.${status}`,
        (visit) => {
          const now = Date.now();
          const activeSeconds =
            visit.status === 'on_site' && visit.timerStartedAt
              ? Math.max(0, Math.floor((now - Date.parse(visit.timerStartedAt)) / 1000))
              : 0;
          return {
            ...visit,
            status,
            elapsedSeconds: (visit.elapsedSeconds ?? visit.elapsedMinutes * 60) + activeSeconds,
            timerStartedAt: status === 'on_site' ? new Date(now).toISOString() : undefined,
          };
        },
        status === 'on_site' ? 'Job timer started' : 'Visit updated',
        status === 'on_site'
          ? 'Checklist, materials, and media capture are ready offline.'
          : `Visit is now ${status.replace('_', ' ')}.`,
        false,
      );
    },
    [mutateVisit, runLiveCommands],
  );

  const toggleChecklist = useCallback(
    (id: string) => {
      if (stateRef.current.dataMode === 'supabase') {
        const current = stateRef.current;
        const scope = selectedLiveVisitScope(current);
        const reference = current.live?.checklistItems[id];
        const item = scope?.visit.checklist.find((entry) => entry.id === id);
        if (
          !scope ||
          !reference ||
          reference.visitId !== scope.visit.id ||
          !item ||
          (!hasPermission(current.role, 'field.execute') && current.role !== 'owner')
        ) {
          setState((current) =>
            withToast(
              current,
              'Checklist update blocked',
              'The role projection does not include this checklist item and version.',
            ),
          );
          return;
        }
        const nextStatus = item.complete ? 'pending' : 'complete';
        void runLiveCommand(
          {
            commandType: 'checklist.record',
            expectedVersion: reference.version,
            payload: {
              entityId: reference.id,
              visitId: reference.visitId,
              templateItemId: reference.templateItemId,
              status: nextStatus,
              completedAt: nextStatus === 'complete' ? isoNow() : undefined,
              evidenceAssetIds: [],
            },
          },
          {
            title: 'Checklist saved',
            detail: 'The server validated assignment, template membership, and item version.',
          },
          (optimisticState) => ({
            ...optimisticState,
            visits: optimisticState.visits.map((visit) =>
              visit.id === scope.visit.id
                ? {
                    ...visit,
                    checklist: visit.checklist.map((checklistItem) =>
                      checklistItem.id === id
                        ? { ...checklistItem, complete: !checklistItem.complete }
                        : checklistItem,
                    ),
                  }
                : visit,
            ),
            live: optimisticState.live
              ? {
                  ...optimisticState.live,
                  checklistItems: {
                    ...optimisticState.live.checklistItems,
                    [id]: {
                      ...reference,
                      status: nextStatus,
                      version: reference.version + 1,
                    },
                  },
                }
              : undefined,
          }),
          scope.visit.id,
        );
        return;
      }
      mutateVisit(
        'visit.checklist.updated',
        (visit) => ({
          ...visit,
          checklist: visit.checklist.map((item) =>
            item.id === id ? { ...item, complete: !item.complete } : item,
          ),
        }),
        'Checklist saved',
        stateRef.current.online
          ? 'Safety evidence and completion time were recorded.'
          : 'Saved on this device and queued for sync.',
      );
    },
    [mutateVisit, runLiveCommand],
  );

  const addPhoto = useCallback(
    (kind: 'before' | 'after', file?: File) => {
      if (stateRef.current.dataMode === 'supabase') {
        const scope = selectedLiveVisitScope(stateRef.current);
        if (
          !scope ||
          !['on_site', 'paused'].includes(scope.visit.status) ||
          (!hasPermission(stateRef.current.role, 'field.execute') &&
            stateRef.current.role !== 'owner')
        ) {
          setState((current) =>
            withToast(
              current,
              'Photo was not registered',
              'Select the exact assigned visit and start on-site work before capturing evidence.',
            ),
          );
          return;
        }
        if (!file) {
          setState((current) =>
            withToast(
              current,
              'Choose an evidence file',
              'Live mode requires the original photo so its byte size and SHA-256 checksum can be registered.',
            ),
          );
          return;
        }
        void prepareLiveMediaPacket(
          scope.visit.id,
          kind,
          file,
          file.name,
          file.type || 'application/octet-stream',
        )
          .then(async (packet) => {
            if (selectedLiveVisitScope(stateRef.current)?.visit.id !== packet.media.visitId) {
              throw new Error('The selected visit changed before the evidence packet was saved.');
            }
            if (!stateRef.current.online) {
              await persistLiveOfflineMutations(
                packet.mutations,
                (optimisticState) => ({
                  ...optimisticState,
                  visits: optimisticState.visits.map((visit) =>
                    visit.id === packet.media.visitId
                      ? {
                          ...visit,
                          beforePhotos:
                            kind === 'before' ? visit.beforePhotos + 1 : visit.beforePhotos,
                          afterPhotos: kind === 'after' ? visit.afterPhotos + 1 : visit.afterPhotos,
                        }
                      : visit,
                  ),
                }),
                {
                  title: `${kind === 'before' ? 'Before' : 'After'} evidence saved offline`,
                  detail:
                    'Original bytes, capture metadata, stable asset UUID, SHA-256 checksum, upload dependency, and registration command are queued.',
                },
              );
              return;
            }
            await reconcileLiveMediaPacket(packet);
            await reloadLiveWorkspace();
            setState((current) =>
              withToast(
                current,
                `${kind === 'before' ? 'Before' : 'After'} photo registered`,
                'The private original and checksum are linked to the authenticated visit.',
              ),
            );
          })
          .catch((error: unknown) => {
            setState((current) =>
              withToast(
                current,
                'Photo was not registered',
                error instanceof Error ? error.message : 'Upload failed.',
              ),
            );
          });
        return;
      }
      mutateVisit(
        `visit.photo.${kind}`,
        (visit) => ({
          ...visit,
          beforePhotos: kind === 'before' ? visit.beforePhotos + 1 : visit.beforePhotos,
          afterPhotos: kind === 'after' ? visit.afterPhotos + 1 : visit.afterPhotos,
          checklist: visit.checklist.map((item) =>
            item.id === kind ? { ...item, complete: true } : item,
          ),
        }),
        `${kind === 'before' ? 'Before' : 'After'} photo saved`,
        'Original checksum, capture time, and visibility are recorded.',
      );
    },
    [
      mutateVisit,
      persistLiveOfflineMutations,
      prepareLiveMediaPacket,
      reconcileLiveMediaPacket,
      reloadLiveWorkspace,
    ],
  );

  const addIncidentEvidence = useCallback(
    (kind: 'incident' | 'safety' | 'damage', file?: File) => {
      const current = stateRef.current;
      if (current.dataMode !== 'supabase') {
        setState((state) =>
          withToast(
            state,
            'Trusted incident evidence requires live mode',
            'Sandbox mode does not claim durable private Storage, checksum finalization, or incident association.',
          ),
        );
        return;
      }
      const scope = selectedLiveVisitScope(current);
      const pendingIncident = scope
        ? durableIncidentStopForVisit(current.offlineQueue, scope.visit.id)
        : undefined;
      const activeIncident = scope
        ? unresolvedIncidentForVisit(current.incidents, {
            visitId: scope.visit.id,
            jobId: scope.jobId,
            propertyId: scope.propertyId,
          })
        : undefined;
      const pendingIncidentId =
        typeof pendingIncident?.command?.payload.entityId === 'string'
          ? pendingIncident.command.payload.entityId
          : undefined;
      const incidentId = activeIncident?.id ?? pendingIncidentId;
      if (
        !scope ||
        !incidentId ||
        !file ||
        (!hasPermission(current.role, 'field.execute') && current.role !== 'owner')
      ) {
        setState((state) =>
          withToast(
            state,
            'Incident evidence was not captured',
            'Choose an original image while this exact visit has an unresolved incident or durable stop-work command.',
          ),
        );
        return;
      }
      void prepareLiveMediaPacket(
        scope.visit.id,
        kind,
        file,
        file.name,
        file.type || 'application/octet-stream',
        incidentId,
        pendingIncident ? [pendingIncident.id] : [],
      )
        .then(async (packet) => {
          const packetIds = packet.mutations.map((mutation) => mutation.id);
          const persisted = await persistLiveOfflineMutations(
            packet.mutations,
            undefined,
            {
              title: 'Private incident evidence durably saved',
              detail:
                'Original bytes, exact incident/visit association, capture time, SHA-256 checksum, upload, and finalizer command are queued with customer visibility forced off.',
            },
            { incidentEvidenceFirst: true },
          );
          if (!persisted || pendingIncident || !hasCurrentServerVerification(stateRef.current)) {
            return;
          }
          const repository = liveRepositoryRef.current;
          if (!repository) throw new Error('The live repository is unavailable.');
          const result = await replayOfflineQueue(packet.mutations, {
            uploadMedia: (media) => repository.uploadPreparedVisitMedia(media),
            executeCommand: (command) => repository.finalizeVisitMedia(command),
          });
          if (!(await persistOfflineMutationBatchUpdate(packetIds, result.queue))) {
            throw new Error(
              'Incident evidence replay completed, but durable queue reconciliation failed.',
            );
          }
          if (result.failure) {
            throw result.failure;
          }
          await reloadLiveWorkspace();
          setState((state) =>
            withToast(
              state,
              'Incident evidence finalized',
              'Private Storage bytes and the exact incident, visit, job, property, checksum, and finalizer receipt reconciled.',
            ),
          );
        })
        .catch((error: unknown) => {
          setState((state) =>
            withToast(
              { ...state, liveError: error instanceof Error ? error.message : 'Upload failed.' },
              'Incident evidence retained for replay',
              `${error instanceof Error ? error.message : 'Upload failed.'} The durable private packet remains available for exact replay.`,
            ),
          );
        });
    },
    [
      persistLiveOfflineMutations,
      persistOfflineMutationBatchUpdate,
      prepareLiveMediaPacket,
      reloadLiveWorkspace,
    ],
  );

  const recordMaterial = useCallback(
    (name: string, amount: string) => {
      if (stateRef.current.dataMode === 'supabase') {
        const current = stateRef.current;
        const scope = selectedLiveVisitScope(current);
        if (
          !scope ||
          !['on_site', 'paused'].includes(scope.visit.status) ||
          (!hasPermission(current.role, 'field.execute') && current.role !== 'owner')
        ) {
          setState((latest) =>
            withToast(
              latest,
              'Material record blocked',
              'Select the exact assigned visit and start on-site work before recording usage.',
            ),
          );
          return;
        }
        const requestedName = name.toLowerCase();
        const material = current.live?.materials.find((item) => {
          const candidate = item.name.toLowerCase();
          return (
            candidate === requestedName ||
            candidate.includes(requestedName.replace(' mix', '')) ||
            requestedName.includes(candidate)
          );
        });
        const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/iu.exec(amount);
        if (!material || !match) {
          setState((current) =>
            withToast(
              current,
              'Material record blocked',
              'A matching active catalog material and numeric quantity are required.',
            ),
          );
          return;
        }
        if (
          material.requiresSds &&
          (!material.sdsDocument ||
            material.sdsDocument.offlineStatus !== 'available' ||
            !material.sdsDocument.cachedFile)
        ) {
          setState((current) =>
            withToast(
              current,
              'Material record blocked',
              material.sdsDocument
                ? `${material.name} requires an SDS. Verify and save the approved PDF on this device before recording usage so it remains available if connectivity fails.`
                : `${material.name} is classified as requiring an SDS, but no SDS metadata is attached to the active catalog record.`,
            ),
          );
          return;
        }
        const requestedQuantity = Number(match[1]);
        const requestedUnit = match[2]?.toLowerCase();
        const materialUnit = material.unit.toLowerCase();
        let quantity = requestedQuantity;
        const gallons = ['gal', 'gallon', 'gallons'];
        const ounces = ['oz', 'ounce', 'ounces'];
        if (gallons.includes(materialUnit) && requestedUnit && ounces.includes(requestedUnit)) {
          quantity = requestedQuantity / 128;
        } else if (
          ounces.includes(materialUnit) &&
          requestedUnit &&
          gallons.includes(requestedUnit)
        ) {
          quantity = requestedQuantity * 128;
        } else if (
          requestedUnit &&
          requestedUnit !== materialUnit &&
          !(gallons.includes(materialUnit) && gallons.includes(requestedUnit)) &&
          !(ounces.includes(materialUnit) && ounces.includes(requestedUnit))
        ) {
          setState((current) =>
            withToast(
              current,
              'Material unit mismatch',
              `${material.name} must be recorded in ${material.unit}.`,
            ),
          );
          return;
        }
        const entityId = crypto.randomUUID();
        const visitId = scope.visit.id;
        void runLiveCommand(
          {
            commandType: 'material.record',
            expectedVersion: 0,
            payload: {
              entityId,
              visitId,
              materialId: material.id,
              quantity: quantity.toFixed(4),
              unit: material.unit,
              recordedAt: isoNow(),
            },
          },
          {
            title: 'Material usage recorded',
            detail: material.sdsDocument
              ? 'The server verified the active catalog material, unit, visit assignment, command ID, and attached SDS identity.'
              : 'The server verified the active catalog material, unit, visit assignment, command ID, and non-chemical catalog classification.',
          },
          (optimisticState) => ({
            ...optimisticState,
            visits: optimisticState.visits.map((visit) =>
              visit.id === visitId
                ? {
                    ...visit,
                    materials: [
                      ...visit.materials.filter((entry) => entry.name !== name),
                      { name, amount },
                    ],
                  }
                : visit,
            ),
          }),
          visitId,
        );
        return;
      }
      mutateVisit(
        'visit.material.recorded',
        (visit) => ({
          ...visit,
          materials: [
            ...visit.materials.filter((material) => material.name !== name),
            { name, amount },
          ],
        }),
        'Material usage recorded',
        `${name} · ${amount}. Review the material’s displayed safety-document status before use.`,
      );
    },
    [mutateVisit, runLiveCommand],
  );

  const cacheSdsDocument = useCallback(async (documentId: string): Promise<boolean> => {
    const current = stateRef.current;
    const repository = liveRepositoryRef.current;
    const document = current.live?.materials
      .map((material) => material.sdsDocument)
      .find((candidate) => candidate?.id === documentId);
    if (
      current.dataMode !== 'supabase' ||
      current.authStatus !== 'signed_in' ||
      !repository ||
      !document
    ) {
      setState((latest) =>
        withToast(
          latest,
          'SDS not saved',
          'An authenticated, company-scoped SDS record is required.',
        ),
      );
      return false;
    }
    if (document.offlineStatus === 'available' && document.cachedFile) {
      setState((latest) =>
        withToast(latest, 'SDS already available offline', document.productName),
      );
      return true;
    }
    if (!current.online || !current.serverVerifiedAt) {
      setState((latest) =>
        withToast(
          latest,
          'SDS download needs connectivity',
          'Reconnect and refresh the role-scoped workspace before saving this private PDF.',
        ),
      );
      return false;
    }
    try {
      const cachedFile = await repository.downloadSdsDocument(document);
      const latest = stateRef.current;
      const latestDocument = latest.live?.materials
        .map((material) => material.sdsDocument)
        .find((candidate) => candidate?.id === documentId);
      if (
        !latestDocument ||
        latestDocument.checksumSha256 !== document.checksumSha256 ||
        latestDocument.version !== document.version
      ) {
        throw new Error('The SDS metadata changed during download. Refresh and verify it again.');
      }
      const cachedAt = isoNow();
      const next: DemoState = {
        ...latest,
        live: latest.live
          ? {
              ...latest.live,
              materials: latest.live.materials.map((material) =>
                material.sdsDocument?.id === documentId
                  ? {
                      ...material,
                      sdsDocument: {
                        ...material.sdsDocument,
                        cachedFile,
                        cachedAt,
                        offlineStatus: 'available',
                      },
                    }
                  : material,
              ),
            }
          : latest.live,
      };
      if (persistenceTimerRef.current !== undefined) {
        window.clearTimeout(persistenceTimerRef.current);
        persistenceTimerRef.current = undefined;
      }
      if (!(await savePersistedState({ ...next, toasts: [] }))) {
        throw new Error(
          'This browser did not confirm durable device storage, so the SDS was not marked offline-ready.',
        );
      }
      stateRef.current = next;
      setState(
        withToast(
          next,
          'SDS available offline',
          `${document.productName} was checksum-verified and saved to this user-and-company-scoped device workspace.`,
        ),
      );
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The SDS download failed.';
      setState((latest) => withToast({ ...latest, liveError: detail }, 'SDS not saved', detail));
      return false;
    }
  }, []);

  const submitFieldChangeRequest = useCallback(
    async (input: Parameters<StoryOpsActions['submitFieldChangeRequest']>[0]): Promise<boolean> => {
      const summary = input.summary.trim();
      const allowedReasons = new Set([
        'scope_mismatch',
        'access_blocked',
        'customer_request',
        'site_condition',
        'other',
      ]);
      if (!allowedReasons.has(input.reasonCode) || summary.length < 10 || summary.length > 2_000) {
        setState((current) =>
          withToast(
            current,
            'Change request needs observed facts',
            'Choose a reason and record 10–2,000 characters. This request cannot change price or scope by itself.',
          ),
        );
        return false;
      }
      const current = stateRef.current;
      const visit = selectedVisit(current);
      if (!visit) {
        setState((latest) =>
          withToast(latest, 'Change request blocked', 'No assigned visit is selected.'),
        );
        return false;
      }
      const commandId = crypto.randomUUID();
      const createdAt = isoNow();
      if (current.dataMode === 'sandbox') {
        setState((latest) =>
          withToast(
            {
              ...latest,
              visits: latest.visits.map((candidate) =>
                candidate.id === visit.id
                  ? {
                      ...candidate,
                      changeRequests: [
                        {
                          id: commandId,
                          reasonCode: input.reasonCode,
                          summary,
                          status: 'submitted',
                          createdAt,
                          version: 1,
                        },
                        ...(candidate.changeRequests ?? []),
                      ],
                    }
                  : candidate,
              ),
            },
            'Sandbox change request recorded',
            'The local fixture did not change price, scope, schedule, or customer communications.',
          ),
        );
        return true;
      }
      const scope = selectedLiveVisitScope(current);
      const visitReference = scope?.visitReference;
      const liveVisitStatus = current.live?.visitStatus;
      if (
        !scope ||
        !visitReference ||
        visitReference.id !== visit.id ||
        !['confirmed', 'en_route', 'on_site', 'paused'].includes(liveVisitStatus ?? '') ||
        (!hasPermission(current.role, 'field.execute') && current.role !== 'owner')
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Change request blocked',
            'A current confirmed or active assigned visit is required.',
          ),
        );
        return false;
      }
      return runLiveCommand(
        {
          commandId,
          commandType: 'field.change_request',
          expectedVersion: visitReference.version,
          payload: {
            entityId: visit.id,
            reasonCode: input.reasonCode,
            summary,
          },
        },
        {
          title: 'Field change request submitted',
          detail:
            'Observed facts were recorded for office review. Price, scope, schedule, and customer communications were not changed.',
        },
        (optimisticState) => ({
          ...optimisticState,
          visits: optimisticState.visits.map((candidate) =>
            candidate.id === visit.id
              ? {
                  ...candidate,
                  changeRequests: [
                    {
                      id: commandId,
                      reasonCode: input.reasonCode,
                      summary,
                      status: 'submitted',
                      createdAt,
                      version: 1,
                    },
                    ...(candidate.changeRequests ?? []),
                  ],
                }
              : candidate,
          ),
        }),
        visit.id,
      );
    },
    [runLiveCommand],
  );

  const loadCustomerEvidence = useCallback(async (assetId: string): Promise<Blob | undefined> => {
    const current = stateRef.current;
    const repository = liveRepositoryRef.current;
    const evidence = current.live?.customerCompletedWork
      ?.flatMap((work) => work.media)
      .find((media) => media.id === assetId);
    if (
      current.dataMode !== 'supabase' ||
      current.role !== 'customer' ||
      !repository ||
      !evidence ||
      !current.online ||
      !current.serverVerifiedAt
    ) {
      setState((latest) =>
        withToast(
          latest,
          'Evidence unavailable',
          'A current authenticated customer projection and online server verification are required.',
        ),
      );
      return undefined;
    }
    try {
      return await repository.downloadCustomerEvidence(evidence);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'Completed-work evidence could not be loaded.';
      setState((latest) =>
        withToast({ ...latest, liveError: detail }, 'Evidence unavailable', detail),
      );
      return undefined;
    }
  }, []);

  const publishCompletedWorkEvidence = useCallback(
    async (visitId: string, assetIds: string[]): Promise<boolean> => {
      const current = stateRef.current;
      const repository = liveRepositoryRef.current;
      const visit = current.visits.find((candidate) => candidate.id === visitId);
      const eligibleIds = new Set(
        (visit?.fieldEvidence ?? [])
          .filter(
            (evidence) =>
              evidence.syncState === 'synced' &&
              !evidence.customerVisible &&
              (evidence.purpose === 'before' || evidence.purpose === 'after'),
          )
          .map((evidence) => evidence.id),
      );
      if (
        current.dataMode !== 'supabase' ||
        !repository ||
        !current.online ||
        !current.serverVerifiedAt ||
        !['owner', 'dispatcher'].includes(current.role) ||
        !visit ||
        visit.status !== 'complete' ||
        assetIds.length < 1 ||
        assetIds.some((id) => !eligibleIds.has(id))
      ) {
        setState((latest) =>
          withToast(
            latest,
            'Evidence not published',
            'A current owner/dispatcher workspace and exact unpublished synced before/after assets from a completed visit are required.',
          ),
        );
        return false;
      }
      try {
        const receipt = await repository.publishCompletedWorkEvidence({
          visitId,
          assetIds,
        });
        await reloadLiveWorkspace();
        setState((latest) =>
          withToast(
            latest,
            receipt.replayed ? 'Evidence publication confirmed' : 'Evidence published',
            `${receipt.publishedCount} exact completed-work image${
              receipt.publishedCount === 1 ? '' : 's'
            } are now available to the linked authenticated customer.`,
          ),
        );
        return true;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'Completed-work evidence was not published.';
        setState((latest) =>
          withToast({ ...latest, liveError: detail }, 'Evidence not published', detail),
        );
        return false;
      }
    },
    [reloadLiveWorkspace],
  );

  const updateVisitNotes = useCallback(
    (notes: string) => {
      if (stateRef.current.dataMode === 'supabase') {
        const normalized = notes.trim();
        const current = stateRef.current;
        const scope = selectedLiveVisitScope(current);
        if (
          !scope ||
          !['on_site', 'paused'].includes(scope.visit.status) ||
          (!hasPermission(current.role, 'field.execute') && current.role !== 'owner')
        ) {
          setState((current) =>
            withToast(current, 'Job notes blocked', 'No versioned assigned visit is selected.'),
          );
          return;
        }
        const { visit, visitReference } = scope;
        if (normalized === visit.notes) return;
        if (normalized.length < 5 || normalized.length > 4_000) {
          setState((current) =>
            withToast(
              current,
              'Job notes need review',
              'Internal job notes must contain 5–4,000 characters.',
            ),
          );
          return;
        }
        void runLiveCommand(
          {
            commandType: 'visit.notes.update',
            expectedVersion: visitReference.version,
            payload: {
              entityId: visitReference.id,
              notes: normalized,
            },
          },
          {
            title: 'Job notes saved',
            detail:
              'The server validated assignment, active work state, note length, and visit version.',
          },
          (optimisticState) => ({
            ...optimisticState,
            visits: optimisticState.visits.map((item) =>
              item.id === visit.id ? { ...item, notes: normalized } : item,
            ),
            live: optimisticState.live
              ? {
                  ...optimisticState.live,
                  visit: {
                    ...visitReference,
                    version: visitReference.version + 1,
                  },
                }
              : undefined,
          }),
          visit.id,
        );
        return;
      }
      const normalized = notes.trim();
      if (normalized === selectedVisit(stateRef.current)?.notes) return;
      mutateVisit(
        'visit.notes.updated',
        (visit) => ({ ...visit, notes: normalized }),
        'Job notes saved',
        stateRef.current.online
          ? 'The field note was persisted with the completion packet.'
          : 'The field note was saved locally and queued for sync.',
      );
    },
    [mutateVisit, runLiveCommand],
  );

  const captureSignature = useCallback(
    (signerName?: string) => {
      if (stateRef.current.dataMode === 'supabase') {
        const normalizedName = signerName?.trim() ?? '';
        const current = stateRef.current;
        const scope = selectedLiveVisitScope(current);
        if (
          normalizedName.length < 2 ||
          !scope ||
          !['on_site', 'paused'].includes(scope.visit.status) ||
          (!hasPermission(current.role, 'field.execute') && current.role !== 'owner')
        ) {
          setState((current) =>
            withToast(
              current,
              'Signature not captured',
              'Enter the signer’s verified name and load a versioned visit first.',
            ),
          );
          return;
        }
        const selectedVisitId = scope.visit.id;
        const signedAt = isoNow();
        void createCompletionSignaturePng({
          signerName: normalizedName,
          signedAt,
          visitId: selectedVisitId,
        })
          .then(async (artifact) => {
            const packet = await prepareLiveMediaPacket(
              selectedVisitId,
              'signature',
              artifact.blob,
              artifact.filename,
              artifact.contentType,
            );
            const registrationId = packet.mutations.at(-1)?.id;
            if (!registrationId) throw new Error('The signature media packet is incomplete.');
            const signatureCommand = await buildStoryOpsCommand({
              commandType: 'signature.capture',
              expectedVersion: 0,
              payload: {
                entityId: crypto.randomUUID(),
                visitId: selectedVisitId,
                signerName: normalizedName,
                signerRole: 'customer',
                signedAt,
                signatureAssetId: packet.media.assetId,
                disclosureVersion: 'completion-v1',
              },
            });
            const signatureMutation = commandMutation(
              signatureCommand,
              signedAt,
              [registrationId],
              selectedVisitId,
            );
            if (selectedLiveVisitScope(stateRef.current)?.visit.id !== selectedVisitId) {
              throw new Error('The selected visit changed before the signature packet was saved.');
            }
            if (!stateRef.current.online) {
              await persistLiveOfflineMutations(
                [...packet.mutations, signatureMutation],
                (optimisticState) => ({
                  ...optimisticState,
                  visits: optimisticState.visits.map((visit) =>
                    visit.id === selectedVisitId ? { ...visit, signature: true } : visit,
                  ),
                }),
                {
                  title: 'Signature saved offline',
                  detail:
                    'The typed acknowledgement, disclosure version, raster bytes, SHA-256 checksum, and ordered registration commands are queued.',
                },
              );
              return;
            }
            await reconcileLiveMediaPacket(packet);
            const repository = liveRepositoryRef.current;
            if (!repository) throw new Error('The live repository is unavailable.');
            if (selectedLiveVisitScope(stateRef.current)?.visit.id !== selectedVisitId) {
              throw new Error('The selected visit changed before signature registration.');
            }
            await repository.executeCommand(signatureCommand);
            await reloadLiveWorkspace();
            setState((current) =>
              withToast(
                current,
                'Signature captured',
                'The signer, disclosure, timestamp, private artifact, and checksum were recorded.',
              ),
            );
          })
          .catch((error: unknown) => {
            setState((current) =>
              withToast(
                current,
                'Signature was not captured',
                error instanceof Error ? error.message : 'Signature registration failed.',
              ),
            );
          });
        return;
      }
      mutateVisit(
        'visit.signature.captured',
        (visit) => ({ ...visit, signature: true }),
        'Signature captured',
        'Signer, disclosure version, and timestamp were recorded.',
      );
    },
    [
      mutateVisit,
      persistLiveOfflineMutations,
      prepareLiveMediaPacket,
      reconcileLiveMediaPacket,
      reloadLiveWorkspace,
    ],
  );

  const reportIncident = useCallback(
    async (input: {
      kind: DemoIncident['kind'];
      summary: string;
      severity?: 'near_miss' | 'minor' | 'serious' | 'critical';
      immediateActions?: string;
    }): Promise<boolean> => {
      if (stateRef.current.dataMode === 'supabase') {
        const current = stateRef.current;
        const repository = liveRepositoryRef.current;
        const live = current.live;
        const scope = selectedLiveVisitScope(current);
        const visit = scope?.visit;
        const summary = input.summary.trim();
        const immediateActions = input.immediateActions?.trim() ?? '';
        if (
          !repository ||
          !scope ||
          !live ||
          !visit ||
          summary.length < 10 ||
          immediateActions.length < 5 ||
          !input.severity ||
          !['en_route', 'on_site', 'paused'].includes(live.visitStatus ?? '') ||
          (!hasPermission(current.role, 'incidents.report') && current.role !== 'owner')
        ) {
          setState((state) =>
            withToast(
              state,
              'Incident needs direct facts',
              'Select severity and record both the observation and immediate actions taken.',
            ),
          );
          return false;
        }
        const visitReference = scope.visitReference;
        const category =
          input.kind === 'injury_or_exposure'
            ? 'injury'
            : input.kind === 'property_damage'
              ? 'property_damage'
              : 'other';
        const requiresLegalReview =
          input.severity === 'serious' ||
          input.severity === 'critical' ||
          input.kind === 'injury_or_exposure';
        const intent = {
          actorUserId: live.userId,
          visitId: visitReference.id,
          jobId: scope.jobId,
          propertyId: scope.propertyId,
          severity: input.severity,
          category,
          summary,
          immediateActions,
          requiresLegalReview,
        } as const;
        const existing = durableIncidentStopForVisit(current.offlineQueue, visitReference.id);
        if (existing && !incidentStopMatchesIntent(existing, intent)) {
          setState((state) =>
            withToast(
              state,
              'Resolve the prior incident first',
              'This visit already has one durable unconfirmed stop-work command. Sync its unchanged UUID, hash, expected version, and facts before recording another incident.',
            ),
          );
          return false;
        }
        let command = existing?.command;
        if (!command) {
          const requestedAt = isoNow();
          const incidentId = crypto.randomUUID();
          command = await buildStoryOpsCommand({
            commandId: crypto.randomUUID(),
            commandType: 'incident.report_pause',
            expectedVersion: visitReference.version,
            payload: {
              schemaVersion: 'storyops-incident-pause-v1',
              action: 'incident.report_pause',
              actorUserId: live.userId,
              entityId: incidentId,
              incidentNumber: `INC-${incidentId.slice(0, 8).toUpperCase()}`,
              visitId: visitReference.id,
              jobId: scope.jobId,
              propertyId: scope.propertyId,
              severity: input.severity,
              category,
              occurredAt: requestedAt,
              requestedAt,
              summary,
              immediateActions,
              requiresLegalReview,
            },
          });
          const persisted = await persistLiveOfflineMutations(
            [commandMutation(command, requestedAt, [], visitReference.id)],
            (optimisticState) => ({
              ...optimisticState,
              visits: optimisticState.visits.map((candidate) =>
                candidate.id === visitReference.id
                  ? { ...candidate, status: 'paused', timerStartedAt: undefined }
                  : candidate,
              ),
            }),
            {
              title: 'Stop-work command durably saved',
              detail:
                'The exact atomic incident/pause command was written to IndexedDB before any online submission. Keep work stopped until its receipt and authoritative readback reconcile.',
            },
            { incidentStopFirst: true },
          );
          if (!persisted) return false;
        }

        if (!hasCurrentServerVerification(stateRef.current)) {
          return true;
        }
        const durable = durableIncidentStopForVisit(
          stateRef.current.offlineQueue,
          visitReference.id,
        );
        if (!durable || durable.command?.commandId !== command.commandId) {
          setState((state) =>
            withToast(
              state,
              'Stop-work reconciliation blocked',
              'The exact write-ahead command could not be recovered from durable device state.',
            ),
          );
          return false;
        }
        let authoritativeMapped: DemoState | undefined;
        const reconciliation = await reconcileDurableIncidentStop({
          queue: stateRef.current.offlineQueue,
          mutationId: command.commandId,
          persistQueue: (queue) => persistIncidentStopQueueUpdate(command.commandId, queue),
          send: (submitted) => repository.reportIncidentAndPause(submitted),
          loadAuthoritativeReadback: async () => {
            const loaded = await loadAuthoritativeIncidentStop(command);
            authoritativeMapped = loaded.mapped;
            return loaded.readback;
          },
          isAmbiguousFailure: mutationOutcomeRequiresReconciliation,
        });
        if (reconciliation.outcome === 'confirmed' && authoritativeMapped) {
          const latest = stateRef.current;
          const next: DemoState = {
            ...authoritativeMapped,
            companyControlState: latest.companyControlState,
            companyControlRecovery: false,
            offlineQueue: latest.offlineQueue,
            toasts: latest.toasts,
          };
          portalCustomerIdRef.current = next.live?.selectedPortalCustomerId;
          selectedVisitIdRef.current = next.selectedVisitId;
          selectedDispatchJobIdRef.current = next.selectedDispatchJobId;
          stateRef.current = next;
          await savePersistedState({ ...next, toasts: [] });
          setState(
            withToast(
              next,
              reconciliation.receipt?.replayed
                ? 'Incident stop-work replay confirmed'
                : 'Incident and pause confirmed',
              `${reconciliation.receipt?.stoppedTimeEntries.length ?? 0} active timer${reconciliation.receipt?.stoppedTimeEntries.length === 1 ? '' : 's'} stopped. The exact receipt, open incident, paused visit, and absence of an active timer all matched authoritative readback before the device command was removed.`,
            ),
          );
          return true;
        }
        const detail =
          reconciliation.error?.message ?? 'Atomic incident stop-work needs reconciliation.';
        setState((state) =>
          withToast(
            {
              ...state,
              liveError: detail,
              visits: state.visits.map((candidate) =>
                candidate.id === visitReference.id
                  ? { ...candidate, status: 'paused', timerStartedAt: undefined }
                  : candidate,
              ),
            },
            reconciliation.outcome === 'rejected'
              ? 'Incident command retained for review'
              : 'Stop-work outcome needs reconciliation',
            `${detail} Keep work stopped. The unchanged command UUID, request hash, expected version, facts, and any matching receipt remain durably queued.`,
          ),
        );
        return false;
      }
      const sandboxState = stateRef.current;
      const sandboxVisit = selectedVisit(sandboxState);
      const sandboxSummary = input.summary.trim();
      if (!hasPermission(sandboxState.role, 'incidents.report')) {
        setState((current) =>
          withToast(
            current,
            'Incident reporting unavailable',
            'This role cannot create incident records.',
          ),
        );
        return false;
      }
      if (!sandboxVisit || sandboxSummary.length < 10) {
        setState((current) =>
          withToast(
            current,
            'More facts required',
            'Enter at least 10 characters describing what was directly observed.',
          ),
        );
        return false;
      }
      setState((current) => {
        const visit = selectedVisit(current);
        const summary = input.summary.trim();
        if (!visit || visit.id !== sandboxVisit.id) {
          return withToast(
            current,
            'Incident reporting unavailable',
            'The selected visit changed before the local incident was recorded.',
          );
        }
        const incident: DemoIncident = {
          id: uniqueId('incident'),
          visitId: visit.id,
          jobNumber: visit.jobNumber,
          kind: input.kind,
          summary,
          status: 'open',
          reportedAt: isoNow(),
          reportedBy: current.role,
          automationsPaused: true,
        };
        const offlineMutation = {
          id: uniqueId('mutation'),
          idempotencyKey: `field:${visit.id}:incident.reported:${current.syncRevision + 1}`,
          action: 'incident.reported',
          entityId: incident.id,
          scopeVisitId: visit.id,
          createdAt: isoNow(),
          status: 'queued' as const,
        };
        const activeSeconds =
          visit.status === 'on_site' && visit.timerStartedAt
            ? Math.max(0, Math.floor((Date.now() - Date.parse(visit.timerStartedAt)) / 1000))
            : 0;
        const next = withEvidence(
          {
            ...current,
            incidents: [incident, ...current.incidents],
            visits: current.visits.map((item) =>
              item.id === visit.id
                ? {
                    ...item,
                    status: 'paused' as const,
                    timerStartedAt: undefined,
                    elapsedSeconds:
                      (item.elapsedSeconds ?? item.elapsedMinutes * 60) + activeSeconds,
                  }
                : item,
            ),
            syncRevision: current.syncRevision + 1,
            offlineQueue: current.online
              ? current.offlineQueue
              : [...current.offlineQueue, offlineMutation],
          },
          {
            agent: 'Safety',
            action: 'Paused affected automation after incident report',
            result: 'blocked',
            detail:
              'Recorded user-supplied facts only. No emergency, legal, insurer, or customer communication was sent.',
            promptVersion: 'field-policy-v1',
          },
          {
            actor: `user:${current.role}`,
            action: 'incident.reported',
            entity: incident.id,
            outcome: current.online ? 'open' : 'queued_offline',
          },
        );
        return withToast(
          next,
          'Incident record opened',
          'Affected automation is paused. Follow the emergency plan when immediate help is needed.',
        );
      });
      return true;
    },
    [loadAuthoritativeIncidentStop, persistIncidentStopQueueUpdate, persistLiveOfflineMutations],
  );

  const closeIncident = useCallback(
    (id: string, closureNote: string) => {
      const normalizedClosureNote = closureNote.trim();
      if (normalizedClosureNote.length < 5 || normalizedClosureNote.length > 2_000) {
        setState((current) =>
          withToast(
            current,
            'Closure note required',
            'Record 5–2,000 characters of factual owner closure evidence.',
          ),
        );
        return;
      }
      if (stateRef.current.dataMode === 'supabase') {
        const current = stateRef.current;
        const scope = selectedLiveVisitScope(current);
        const incident = current.incidents.find((candidate) => candidate.id === id);
        const incidentVersion = current.live?.incidentVersions[id];
        if (
          current.role !== 'owner' ||
          !scope ||
          incident?.visitId !== scope.visit.id ||
          !incidentVersion
        ) {
          setState((current) =>
            withToast(
              current,
              'Owner review required',
              'Only an owner with the current incident version may close this live record.',
            ),
          );
          return;
        }
        void runLiveCommand(
          {
            commandType: 'incident.close',
            expectedVersion: incidentVersion,
            payload: {
              entityId: id,
              closureNote: normalizedClosureNote,
            },
          },
          {
            title: 'Incident closed',
            detail:
              'The server recorded the owner, timestamp, factual note, and incident version. No external message was sent.',
          },
          (optimisticState) => ({
            ...optimisticState,
            incidents: optimisticState.incidents.map((incident) =>
              incident.id === id ? { ...incident, status: 'closed' as const } : incident,
            ),
            live: optimisticState.live
              ? {
                  ...optimisticState.live,
                  incidentVersions: {
                    ...optimisticState.live.incidentVersions,
                    [id]: incidentVersion + 1,
                  },
                }
              : undefined,
          }),
          scope.visit.id,
        );
        return;
      }
      setState((current) => {
        if (!hasPermission(current.role, 'incidents.manage')) {
          return withToast(current, 'Owner review required', 'This role cannot close incidents.');
        }
        const incident = current.incidents.find((item) => item.id === id);
        if (!incident || incident.status === 'closed') return current;
        const next = withEvidence(
          {
            ...current,
            incidents: current.incidents.map((item) =>
              item.id === id ? { ...item, status: 'closed' as const } : item,
            ),
          },
          {
            agent: 'Safety',
            action: 'Recorded owner incident closure',
            result: 'succeeded',
            detail:
              'Closure changed internal workflow state only; no legal, insurer, authority, or customer message was sent.',
            promptVersion: 'field-policy-v1',
          },
          {
            actor: `user:${current.role}`,
            action: 'incident.closed',
            entity: id,
            outcome: 'closed',
          },
        );
        return withToast(
          next,
          'Incident closed',
          'The owner decision and factual closure note were appended to the audit trail.',
        );
      });
    },
    [runLiveCommand],
  );

  const completeVisit = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      const current = stateRef.current;
      const live = current.live;
      const scope = selectedLiveVisitScope(current);
      const visit = scope?.visit;
      if (
        !live ||
        !scope ||
        !visit ||
        (!hasPermission(current.role, 'field.execute') && current.role !== 'owner')
      ) {
        setState((state) =>
          withToast(state, 'Completion blocked', 'No versioned assigned visit is selected.'),
        );
        return;
      }
      if (visit.status !== 'on_site' && visit.status !== 'paused') {
        setState((state) =>
          withToast(
            state,
            'Completion blocked',
            'The assigned visit must have active or paused on-site work before a completion packet can be created.',
          ),
        );
        return;
      }
      if (
        current.offlineQueue.some(
          (mutation) =>
            mutation.command?.commandType === 'visit.transition' &&
            mutation.scopeVisitId === visit.id &&
            mutation.command.payload.status === 'completed',
        )
      ) {
        setState((state) =>
          withToast(
            state,
            'Completion pending sync',
            'The original completion intent is already queued. Replay it instead of creating a competing command.',
          ),
        );
        return;
      }
      const missing = visit.checklist.filter((item) => item.required && !item.complete);
      const unresolvedIncident = Boolean(
        unresolvedIncidentForVisit(current.incidents, {
          visitId: visit.id,
          jobId: scope.jobId,
          propertyId: scope.propertyId,
        }),
      );
      if (
        missing.length > 0 ||
        visit.beforePhotos < 1 ||
        visit.afterPhotos < 1 ||
        visit.materials.length < 1 ||
        visit.notes.trim().length < 5 ||
        visit.notes.trim().length > 4_000 ||
        !visit.signature ||
        unresolvedIncident
      ) {
        const requirements = [
          missing.length > 0
            ? `${missing.length} required checklist item${missing.length === 1 ? '' : 's'}`
            : '',
          visit.beforePhotos < 1 ? 'before evidence' : '',
          visit.afterPhotos < 1 ? 'after evidence' : '',
          visit.materials.length < 1 ? 'material usage' : '',
          visit.notes.trim().length < 5 || visit.notes.trim().length > 4_000
            ? '5–4,000 character internal note'
            : '',
          !visit.signature ? 'customer signature' : '',
          unresolvedIncident ? 'owner closure of unresolved incident work' : '',
        ].filter(Boolean);
        setState((state) =>
          withToast(state, 'Completion blocked', `Still required: ${requirements.join(', ')}.`),
        );
        return;
      }
      const visitReference = scope.visitReference;
      const commands: Array<{
        commandType: StoryOpsCommandType;
        expectedVersion: number;
        payload: Record<string, unknown>;
      }> = [];
      if (live.activeTimeEntry) {
        commands.push({
          commandType: 'time.stop',
          expectedVersion: live.activeTimeEntry.version,
          payload: { entityId: live.activeTimeEntry.id, endedAt: isoNow() },
        });
      }
      commands.push({
        commandType: 'visit.transition',
        expectedVersion: visitReference.version,
        payload: { entityId: visitReference.id, status: 'completed' },
      });
      void runLiveCommands(
        commands,
        {
          title: 'Visit completed',
          detail:
            'The server verified checklist, synced before/after media, durable signature, stopped timers, notes, materials, incidents, role, and optimistic version.',
        },
        undefined,
        visit.id,
      );
      return;
    }
    setState((current) => {
      const configurationBlock = sandboxConfigurationBlock(current, sandboxEstimateServiceCodes);
      if (configurationBlock) return configurationBlock;
      if (!hasPermission(current.role, 'field.execute') && current.role !== 'owner') {
        return withToast(current, 'Field access required', 'Switch to owner or technician view.');
      }
      const visit = selectedVisit(current);
      if (!visit) return current;
      if (visit.status !== 'on_site' && visit.status !== 'paused') {
        return withToast(current, 'Completion blocked', 'Start the on-site job timer first.');
      }
      if (unresolvedIncidentForVisit(current.incidents, { visitId: visit.id })) {
        return withToast(
          current,
          'Completion blocked',
          'An open incident requires owner review and closure before completion.',
        );
      }
      const missing = visit.checklist.filter((item) => item.required && !item.complete);
      if (
        missing.length > 0 ||
        visit.beforePhotos < 1 ||
        visit.afterPhotos < 1 ||
        visit.materials.length < 1 ||
        visit.notes.trim().length < 5 ||
        !visit.signature
      ) {
        const requirements = [
          missing.length > 0
            ? `${missing.length} checklist item${missing.length === 1 ? '' : 's'}`
            : '',
          visit.beforePhotos < 1 ? 'before photo' : '',
          visit.afterPhotos < 1 ? 'after photo' : '',
          visit.materials.length < 1 ? 'material usage' : '',
          visit.notes.trim().length < 5 ? 'job note' : '',
          !visit.signature ? 'signature' : '',
        ].filter(Boolean);
        return withToast(
          current,
          'Completion blocked',
          `Still required: ${requirements.join(', ')}.`,
        );
      }
      const next = withEvidence(
        (() => {
          const activeSeconds =
            visit.status === 'on_site' && visit.timerStartedAt
              ? Math.max(0, Math.floor((Date.now() - Date.parse(visit.timerStartedAt)) / 1000))
              : 0;
          const elapsedSeconds =
            (visit.elapsedSeconds ?? visit.elapsedMinutes * 60) + activeSeconds;
          return {
            ...current,
            visits: current.visits.map((item) =>
              item.id === visit.id
                ? {
                    ...item,
                    status: 'complete',
                    timerStartedAt: undefined,
                    elapsedSeconds,
                    elapsedMinutes: Math.ceil(elapsedSeconds / 60),
                  }
                : item,
            ),
          };
        })(),
        {
          agent: 'Safety',
          action: 'Validated completion packet',
          result: 'succeeded',
          detail:
            'Required checklist, time, materials, before/after evidence, notes, and signature are present.',
          promptVersion: 'field-policy-v1',
        },
        {
          actor: `user:${current.role}`,
          action: 'visit.completed',
          entity: visit.id,
          outcome: 'success',
        },
      );
      return withToast(
        next,
        'Job completed',
        'The immutable completion packet is ready for invoicing.',
      );
    });
  }, [runLiveCommands]);

  const issueInvoice = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      const live = stateRef.current.live;
      if (!live?.job || !live.visit || !live.invoice) {
        setState((current) =>
          withToast(
            current,
            'Invoice unavailable',
            'A versioned completed job, visit, and quote-backed draft invoice are required.',
          ),
        );
        return;
      }
      void runLiveGoldenPathCommand(
        {
          commandType: 'invoice.issue',
          expectedVersion: live.job.version,
          payload: {
            entityId: live.job.id,
            invoiceId: live.invoice.id,
            invoiceVersion: live.invoice.version,
            visitId: live.visit.id,
            visitVersion: live.visit.version,
          },
          commandId: live.invoice.id,
        },
        {
          title: 'Invoice issued',
          detail:
            'The server matched the accepted estimate lines and quote totals, verified the deposit, and required the current completed visit packet.',
        },
      );
      return;
    }
    setState((current) => {
      const configurationBlock = sandboxConfigurationBlock(current, sandboxEstimateServiceCodes);
      if (configurationBlock) return configurationBlock;
      if (!hasPermission(current.role, 'invoices.write')) {
        return withToast(current, 'Action blocked', 'This role cannot issue invoices.');
      }
      if (selectedVisit(current)?.status !== 'complete') {
        return withToast(
          current,
          'Invoice blocked',
          'The visit completion packet is not complete.',
        );
      }
      if (current.invoices.some((invoice) => invoice.id === 'invoice-morgan')) {
        return withToast(current, 'Duplicate prevented', 'INV-1048 was already issued.');
      }
      const total = Number(current.estimate.total);
      const deposit = current.depositPaid ? Number(current.estimate.deposit) : 0;
      const invoice = {
        id: 'invoice-morgan',
        number: 'INV-1048',
        customerName: 'Morgan Ellis',
        jobNumber: 'JOB-1048',
        issueDate: 'Jul 28, 2026',
        dueDate: 'Due today',
        total: total.toFixed(2),
        paid: deposit.toFixed(2),
        balance: (total - deposit).toFixed(2),
        status: 'open' as const,
      };
      const next = withEvidence(
        { ...current, invoices: [invoice, ...current.invoices] },
        {
          agent: 'Finance',
          action: 'Recorded sandbox completion-backed invoice',
          result: 'succeeded',
          detail:
            'The local invoice fixture matches the accepted quote less the synthetic deposit; no provider or customer was contacted.',
          promptVersion: 'finance-v3.0',
        },
        {
          actor: 'sandbox:finance',
          action: 'invoice.fixture_recorded',
          entity: invoice.id,
          outcome: 'synthetic',
        },
      );
      return withToast(
        next,
        'Sandbox invoice recorded',
        'INV-1048 exists only in the local scenario; no email or provider delivery occurred.',
      );
    });
  }, [runLiveGoldenPathCommand]);

  const recordSandboxPayment = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      setState((current) =>
        withToast(
          current,
          'Provider checkout required',
          'Live payment state only changes from a validated payment-provider event; no payment was recorded.',
        ),
      );
      return;
    }
    setState((current) => {
      const configurationBlock = sandboxConfigurationBlock(current, sandboxEstimateServiceCodes);
      if (configurationBlock) return configurationBlock;
      if (
        !hasPermission(current.role, 'payments.manage') &&
        !hasPermission(current.role, 'portal.self.write')
      ) {
        return withToast(current, 'Action blocked', 'This role cannot record or make payments.');
      }
      const invoice = current.invoices.find((item) => item.id === 'invoice-morgan');
      if (!invoice) {
        return withToast(current, 'Payment unavailable', 'Issue INV-1048 first.');
      }
      if (invoice.status === 'paid') {
        return withToast(
          current,
          'Duplicate prevented',
          'The synthetic payment fixture was already recorded locally.',
        );
      }
      const next = withEvidence(
        {
          ...current,
          invoices: current.invoices.map((item) =>
            item.id === 'invoice-morgan'
              ? { ...item, paid: item.total, balance: '0.00', status: 'paid' }
              : item,
          ),
        },
        {
          agent: 'Finance',
          action: 'Recorded sandbox payment fixture',
          result: 'succeeded',
          detail:
            'Synthetic paid state advanced locally; no Stripe event was received and no funds moved.',
          promptVersion: 'finance-v3.0',
        },
        {
          actor: 'sandbox:payment_fixture',
          action: 'payment.fixture_recorded',
          entity: invoice.id,
          outcome: 'synthetic',
        },
      );
      return withToast(
        next,
        'Sandbox payment fixture recorded',
        'INV-1048 advanced locally to paid; no provider was contacted and no funds moved.',
      );
    });
  }, []);

  const sendInvoiceReminder = useCallback((id: string) => {
    if (stateRef.current.dataMode === 'supabase') {
      setState((current) =>
        withToast(
          current,
          'Live reminder unavailable',
          `No message was sent for ${id}; the current server command allowlist has no communication-send command.`,
        ),
      );
      return;
    }
    setState((current) => {
      if (!hasPermission(current.role, 'communications.send')) {
        return withToast(current, 'Action blocked', 'This role cannot send invoice reminders.');
      }
      const invoice = current.invoices.find((item) => item.id === id);
      if (!invoice || (invoice.status !== 'open' && invoice.status !== 'past_due')) {
        return withToast(current, 'Reminder unavailable', 'Only open invoices can be reminded.');
      }
      if (current.remindedInvoiceIds.includes(id)) {
        return withToast(
          current,
          'Duplicate prevented',
          'A synthetic reminder fixture already exists for this invoice.',
        );
      }
      const next = withEvidence(
        {
          ...current,
          remindedInvoiceIds: [...current.remindedInvoiceIds, id],
        },
        {
          agent: 'Finance',
          action: `Recorded ${invoice.number} reminder fixture`,
          result: 'succeeded',
          detail:
            'Synthetic transactional-channel and consent evidence was recorded; no provider or customer was contacted.',
          promptVersion: 'finance-v3.0',
        },
        {
          actor: `sandbox:${current.role}`,
          action: 'invoice.reminder_fixture_recorded',
          entity: id,
          outcome: 'synthetic',
        },
      );
      return withToast(
        next,
        'Sandbox reminder fixture recorded',
        `${invoice.number} changed locally; no email provider or customer was contacted.`,
      );
    });
  }, []);

  const runLivePostServiceAction = useCallback(
    (input: PostServiceActionInput, success: { title: string; detail: string }): void => {
      const repository = liveRepositoryRef.current;
      if (!repository || !hasCurrentServerVerification(stateRef.current)) {
        setState((current) =>
          withToast(
            current,
            'Online verification required',
            'Post-service actions require current payment, consent, job, and invoice evidence.',
          ),
        );
        return;
      }
      void (async () => {
        try {
          const receipt = await repository.executePostServiceAction(input);
          await reloadLiveWorkspace();
          setState((current) =>
            withToast(
              current,
              success.title,
              receipt.replayed || receipt.alreadyExisted
                ? 'The durable server record already existed; no duplicate action was created.'
                : success.detail,
            ),
          );
        } catch (error) {
          setState((current) =>
            withToast(
              current,
              'Post-service action blocked',
              error instanceof Error ? error.message : 'The server rejected this action.',
            ),
          );
        }
      })();
    },
    [reloadLiveWorkspace],
  );

  const requestReview = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      const invoice = stateRef.current.live?.postServiceInvoice;
      if (!invoice) {
        setState((current) =>
          withToast(
            current,
            'Review request unavailable',
            'Select a provider-confirmed paid invoice backed by completed work.',
          ),
        );
        return;
      }
      runLivePostServiceAction(
        {
          action: 'review.request',
          invoiceId: invoice.id,
          expectedVersion: invoice.version,
          channel: 'sms',
        },
        {
          title: 'Review request queued',
          detail:
            'The server retained current marketing-SMS consent and queued follow-up without claiming provider delivery.',
        },
      );
      return;
    }
    setState((current) => {
      const configurationBlock = sandboxConfigurationBlock(current, sandboxEstimateServiceCodes);
      if (configurationBlock) return configurationBlock;
      if (
        !hasPermission(current.role, 'communications.send') &&
        !hasPermission(current.role, 'portal.self.write')
      ) {
        return withToast(current, 'Action blocked', 'This role cannot schedule follow-up.');
      }
      if (!current.leads.find((lead) => lead.id === current.estimate.leadId)?.consent) {
        return withToast(current, 'Request not sent', 'Verified channel consent is required.');
      }
      if (
        !current.invoices.some(
          (invoice) => invoice.id === 'invoice-morgan' && invoice.status === 'paid',
        )
      ) {
        return withToast(current, 'Request not sent', 'Verified payment state is required.');
      }
      if (current.reviewRequested) {
        return withToast(current, 'Duplicate prevented', 'A review request is already scheduled.');
      }
      return withToast(
        {
          ...current,
          reviewRequested: true,
        },
        'Sandbox review fixture queued',
        'The local scenario records eligibility two hours after payment; no SMS is externally scheduled.',
      );
    });
  }, [runLivePostServiceAction]);

  const inviteReferral = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      const invoice = stateRef.current.live?.postServiceInvoice;
      if (!invoice) {
        setState((current) =>
          withToast(
            current,
            'Referral invite unavailable',
            'Select a provider-confirmed paid invoice backed by completed work.',
          ),
        );
        return;
      }
      runLivePostServiceAction(
        {
          action: 'referral.invite',
          invoiceId: invoice.id,
          expectedVersion: invoice.version,
          channel: 'sms',
        },
        {
          title: 'Referral invitation queued',
          detail:
            'The referral domain record is linked to the completed job and its consent-bound SMS remains queued.',
        },
      );
      return;
    }
    setState((current) => {
      const configurationBlock = sandboxConfigurationBlock(current, sandboxEstimateServiceCodes);
      if (configurationBlock) return configurationBlock;
      if (
        !hasPermission(current.role, 'communications.send') &&
        !hasPermission(current.role, 'portal.self.write')
      ) {
        return withToast(
          current,
          'Action blocked',
          'This role cannot schedule referral follow-up.',
        );
      }
      if (!current.leads.find((lead) => lead.id === current.estimate.leadId)?.consent) {
        return withToast(current, 'Invite not sent', 'Verified channel consent is required.');
      }
      if (
        !current.invoices.some(
          (invoice) => invoice.id === 'invoice-morgan' && invoice.status === 'paid',
        )
      ) {
        return withToast(current, 'Invite not sent', 'Verified payment state is required.');
      }
      if (current.referralInvited) {
        return withToast(current, 'Duplicate prevented', 'A referral invite is already scheduled.');
      }
      return withToast(
        { ...current, referralInvited: true },
        'Sandbox referral fixture queued',
        'The local scenario records a consent-aware referral candidate; no provider delivery is scheduled.',
      );
    });
  }, [runLivePostServiceAction]);

  const activateRecurringPlan = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      const invoice = stateRef.current.live?.postServiceInvoice;
      if (!invoice) {
        setState((current) =>
          withToast(
            current,
            'Maintenance unavailable',
            'Select a provider-confirmed paid invoice backed by completed work.',
          ),
        );
        return;
      }
      runLivePostServiceAction(
        {
          action: 'maintenance.activate',
          invoiceId: invoice.id,
          expectedVersion: invoice.version,
          cadence: 'semiannual',
          nextDueDate: semiannualDueDate(
            stateRef.current.live?.serverTime ?? new Date().toISOString(),
          ),
        },
        {
          title: 'Semiannual maintenance active',
          detail:
            'The plan keeps the completed job service scope and accepted price book, and requires a fresh estimate before future work.',
        },
      );
      return;
    }
    setState((current) => {
      const configurationBlock = sandboxConfigurationBlock(current, sandboxEstimateServiceCodes);
      if (configurationBlock) return configurationBlock;
      if (
        !hasPermission(current.role, 'campaigns.manage') &&
        !hasPermission(current.role, 'portal.self.write')
      ) {
        return withToast(current, 'Action blocked', 'This role cannot activate maintenance plans.');
      }
      return withToast(
        { ...current, recurringPlanActive: true },
        'Sandbox maintenance fixture active',
        'A local semiannual due-date scenario was recorded; no customer commitment or booking exists.',
      );
    });
  }, [runLivePostServiceAction]);

  const runAiOffice = useCallback(async (input: Parameters<StoryOpsActions['runAiOffice']>[0]) => {
    const current = stateRef.current;
    if (current.dataMode !== 'supabase') {
      setState((state) =>
        withToast(
          state,
          'Live AI Office only',
          'Use the sandbox briefing fixture or sign in to an authenticated live workspace.',
        ),
      );
      return undefined;
    }
    if (current.role !== 'owner' && current.role !== 'dispatcher') {
      setState((state) =>
        withToast(
          state,
          'Action blocked',
          'Only an active owner or dispatcher can manually run AI Office.',
        ),
      );
      return undefined;
    }
    if (!hasCurrentServerVerification(current)) {
      setState((state) =>
        withToast(
          state,
          'AI Office needs a connection',
          'Refresh the scoped workspace first; manual AI runs are never based on stale source facts.',
        ),
      );
      return undefined;
    }
    const repository = liveRepositoryRef.current;
    if (!repository) {
      setState((state) =>
        withToast(state, 'AI Office unavailable', 'The live repository is not configured.'),
      );
      return undefined;
    }
    try {
      const invocation = await repository.runAiOffice({
        actorRole: current.role,
        run: input,
      });
      setState((state) =>
        withToast(
          { ...state, aiOfficeRecent: invocation.recent },
          invocation.run.durableStatus === 'waiting_approval'
            ? 'AI Office run needs approval'
            : invocation.run.durableStatus === 'failed'
              ? 'AI Office run failed'
              : 'AI Office run complete',
          invocation.run.durableStatus === 'failed'
            ? (invocation.run.errorMessage ?? 'Review the durable run error and try again.')
            : invocation.recoveredFromReadback
              ? 'The durable server record reconciled an uncertain Edge response.'
              : 'The Edge response matched the authenticated durable readback.',
        ),
      );
      return invocation.run;
    } catch (error) {
      setState((state) =>
        withToast(
          state,
          'AI Office run unavailable',
          error instanceof Error ? error.message : 'The authenticated run failed.',
        ),
      );
      return undefined;
    }
  }, []);

  const runOwnerBriefing = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      void runAiOffice({
        runId: crypto.randomUUID(),
        requestedAt: new Date().toISOString(),
        agent: 'owner_briefing',
        manualInput: '',
      });
      return;
    }
    setState((current) => {
      if (!hasPermission(current.role, 'automations.manage')) {
        return withToast(
          current,
          'Action blocked',
          'Only a role that manages automations can run an owner briefing.',
        );
      }
      const pendingApprovals = current.approvals.filter(
        (approval) => approval.status === 'pending',
      ).length;
      const openInvoices = current.invoices.filter(
        (invoice) => invoice.status === 'open' || invoice.status === 'past_due',
      ).length;
      const next = withEvidence(
        {
          ...current,
          automations: current.automations.map((automation) =>
            automation.id === 'auto-briefing'
              ? { ...automation, status: 'succeeded' as const, lastRun: 'Just now' }
              : automation,
          ),
        },
        {
          agent: 'Briefing',
          action: 'Refreshed read-only owner briefing',
          result: 'succeeded',
          detail: `${pendingApprovals} pending approvals; ${openInvoices} open or past-due invoices; no records changed.`,
          promptVersion: 'briefing-v1.0',
        },
        {
          actor: 'agent:briefing',
          action: 'briefing.generated',
          entity: 'owner-briefing',
          outcome: 'read_only',
        },
      );
      return withToast(
        next,
        'Owner briefing refreshed',
        `${pendingApprovals} approvals and ${openInvoices} receivables need attention.`,
      );
    });
  }, [runAiOffice]);

  const checkIntegrations = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      if (!hasPermission(stateRef.current.role, 'integrations.manage')) {
        setState((current) =>
          withToast(current, 'Action blocked', 'This role cannot run provider health checks.'),
        );
        return;
      }
      const repository = liveRepositoryRef.current;
      if (!repository) return;
      void repository
        .checkIntegrationHealth()
        .then(async (health) => ({
          health,
          providerLaunch: await repository.loadProviderLaunchState(),
        }))
        .then(({ health, providerLaunch }) => {
          setState((current) => {
            const retention = health.dispatchOriginRetention;
            const retentionBlocked = retention.p0ReleaseCheck === 'blocked';
            const workersBlocked = health.outboundWorkers.status === 'blocked';
            const retentionDetail =
              retention.availability === 'verified'
                ? `${retention.coordinateStaleCount} coordinate and ${retention.verifierStaleCount} verifier rows are overdue.`
                : 'Departure-location purge health is unavailable; launch remains blocked.';
            const workerDetail = health.outboundWorkers.workers
              .map((worker) => {
                const backlog =
                  worker.queue.availability === 'verified'
                    ? `${worker.queue.backlogCount} backlog / ${worker.queue.submissionUnknownCount} unknown`
                    : 'queue evidence unavailable';
                return `${worker.worker.replaceAll('_', ' ')}: ${worker.status}, ${backlog}`;
              })
              .join('; ');
            return withToast(
              {
                ...current,
                providerLaunch,
                dispatchOriginRetention: retention,
                outboundWorkers: health.outboundWorkers,
                integrations: health.providers.map((provider) => {
                  const prior = current.integrations.find(
                    (candidate) => candidate.provider === provider.provider,
                  );
                  return {
                    id: `${provider.provider}:${provider.capability}`,
                    name: provider.provider.replaceAll('_', ' '),
                    provider: provider.provider,
                    mode:
                      provider.mode === 'live'
                        ? ('Live' as const)
                        : provider.mode === 'sandbox'
                          ? ('Sandbox' as const)
                          : ('Disabled' as const),
                    status:
                      provider.status === 'healthy'
                        ? ('Healthy' as const)
                        : provider.status === 'degraded'
                          ? ('Degraded' as const)
                          : ('Needs setup' as const),
                    capabilities: [provider.capability],
                    lastCheck: provider.checkedAt ?? health.checkedAt,
                    version: prior?.version,
                  };
                }),
              },
              retentionBlocked
                ? 'Dispatch retention blocked'
                : workersBlocked
                  ? 'Outbound workers blocked'
                  : 'Provider checks complete',
              retentionBlocked
                ? retentionDetail
                : workersBlocked
                  ? workerDetail
                  : `Authenticated Edge health returned ${health.overall.replaceAll('_', ' ')}; departure-location purge and outbound worker visibility passed.`,
            );
          });
        })
        .catch((error: unknown) => {
          setState((current) =>
            withToast(
              current,
              'Provider check failed',
              error instanceof Error ? error.message : 'The Edge health request failed.',
            ),
          );
        });
      return;
    }
    setState((current) => {
      if (!hasPermission(current.role, 'integrations.manage')) {
        return withToast(current, 'Action blocked', 'This role cannot run provider health checks.');
      }
      const checked = {
        ...current,
        integrations: current.integrations.map((integration) => ({
          ...integration,
          status: integration.mode === 'Disabled' ? ('Needs setup' as const) : ('Healthy' as const),
          lastCheck: 'just now',
        })),
      };
      return withToast(
        checked,
        'Provider checks complete',
        'Sandbox adapters are healthy; live providers remain disabled until configured.',
      );
    });
  }, []);

  const markNotificationsRead = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      const unread = stateRef.current.notifications.filter((notification) => !notification.read);
      const versions = stateRef.current.live?.notificationVersions ?? {};
      const commands = unread.flatMap((notification) => {
        const version = versions[notification.id];
        return version
          ? [
              {
                commandType: 'notification.read' as const,
                expectedVersion: version,
                payload: { entityId: notification.id },
              },
            ]
          : [];
      });
      if (commands.length === 0) return;
      void runLiveCommands(
        commands,
        {
          title: 'Notifications marked read',
          detail: 'The server applied recipient ownership and version checks.',
        },
        (optimisticState) => ({
          ...optimisticState,
          notifications: optimisticState.notifications.map((notification) => ({
            ...notification,
            read: true,
          })),
          live: optimisticState.live
            ? {
                ...optimisticState.live,
                notificationVersions: Object.fromEntries(
                  Object.entries(optimisticState.live.notificationVersions).map(([id, version]) => [
                    id,
                    version + (unread.some((item) => item.id === id) ? 1 : 0),
                  ]),
                ),
              }
            : undefined,
        }),
      );
      return;
    }
    setState((current) => ({
      ...current,
      notifications: current.notifications.map((notification) => ({
        ...notification,
        read: true,
      })),
    }));
  }, [runLiveCommands]);

  const dismissToast = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      toasts: current.toasts.filter((toast) => toast.id !== id),
    }));
  }, []);

  const syncOfflineQueue = useCallback(async () => {
    if (stateRef.current.dataMode === 'supabase') {
      const repository = liveRepositoryRef.current;
      if (!repository) {
        setState((current) =>
          withToast(current, 'Sync unavailable', 'The live repository is not configured.'),
        );
        return;
      }
      if (!stateRef.current.online) {
        setState((current) =>
          withToast(current, 'Still offline', 'Queued commands remain safely on this device.'),
        );
        return;
      }
      let queued = stateRef.current.offlineQueue;
      if (queued.length === 0) {
        setState((current) =>
          withToast(current, 'Nothing to sync', 'There are no queued live commands.'),
        );
        return;
      }
      const invalidItem = queued.find(
        (item) =>
          (!item.command && !(item.kind === 'media_upload' && item.mediaUpload)) ||
          !item.scopeVisitId,
      );
      if (invalidItem) {
        setState((current) =>
          withToast(
            current,
            'Sync blocked',
            'A queue item lacks its exact visit scope, command, or media payload and cannot be replayed safely.',
          ),
        );
        return;
      }
      const scope = selectedLiveVisitScope(stateRef.current);
      const replayVisitId = scope?.visit.id;
      if (!replayVisitId) {
        setState((current) =>
          withToast(
            current,
            'Sync blocked',
            'Select the exact role-visible visit associated with the field mutations to replay.',
          ),
        );
        return;
      }
      let selectedQueueIds = new Set(
        queued
          .filter((mutation) => mutation.scopeVisitId === replayVisitId)
          .map((mutation) => mutation.id),
      );
      let visitQueue: OfflineMutation[] = queued
        .filter((mutation) => mutation.scopeVisitId === replayVisitId)
        .map((mutation) => ({
          ...mutation,
          dependsOn: (mutation.dependsOn ?? []).filter((dependency) =>
            selectedQueueIds.has(dependency),
          ),
        }));
      if (visitQueue.length === 0) {
        setState((current) =>
          withToast(
            current,
            'No changes for selected visit',
            'Choose a visit that has queued field changes, then replay its exact packet.',
          ),
        );
        return;
      }
      const incidentStop = visitQueue.find(
        (mutation) => mutation.command?.commandType === 'incident.report_pause',
      );
      if (incidentStop?.command) {
        let authoritativeMapped: DemoState | undefined;
        const reconciliation = await reconcileDurableIncidentStop({
          queue: stateRef.current.offlineQueue,
          mutationId: incidentStop.id,
          persistQueue: (queue) => persistIncidentStopQueueUpdate(incidentStop.id, queue),
          send: (command) => repository.reportIncidentAndPause(command),
          loadAuthoritativeReadback: async () => {
            const loaded = await loadAuthoritativeIncidentStop(incidentStop.command!);
            authoritativeMapped = loaded.mapped;
            return loaded.readback;
          },
          isAmbiguousFailure: mutationOutcomeRequiresReconciliation,
        });
        if (reconciliation.outcome !== 'confirmed' || !authoritativeMapped) {
          const detail =
            reconciliation.error?.message ?? 'The atomic stop-work command is still unconfirmed.';
          setState((current) =>
            withToast(
              { ...current, liveError: detail },
              'Incident stop-work retained',
              `${detail} The exact command and any matching receipt remain durable; ordinary work stays locked.`,
            ),
          );
          return;
        }
        const latest = stateRef.current;
        const next: DemoState = {
          ...authoritativeMapped,
          companyControlState: latest.companyControlState,
          companyControlRecovery: false,
          offlineQueue: latest.offlineQueue,
          toasts: latest.toasts,
        };
        portalCustomerIdRef.current = next.live?.selectedPortalCustomerId;
        selectedVisitIdRef.current = next.selectedVisitId;
        selectedDispatchJobIdRef.current = next.selectedDispatchJobId;
        stateRef.current = next;
        await savePersistedState({ ...next, toasts: [] });
        setState(next);
        queued = next.offlineQueue;
        selectedQueueIds = new Set(
          queued
            .filter((mutation) => mutation.scopeVisitId === replayVisitId)
            .map((mutation) => mutation.id),
        );
        visitQueue = queued
          .filter((mutation) => mutation.scopeVisitId === replayVisitId)
          .map((mutation) => ({
            ...mutation,
            dependsOn: (mutation.dependsOn ?? []).filter((dependency) =>
              selectedQueueIds.has(dependency),
            ),
          }));
        if (visitQueue.length === 0) {
          setState((current) =>
            withToast(
              current,
              'Incident stop-work reconciled',
              'The matching durable receipt and authoritative open-incident, paused-visit, stopped-timer readback were confirmed before queue removal.',
            ),
          );
          return;
        }
      }
      const refreshedScope = selectedLiveVisitScope(stateRef.current);
      const unresolvedIncidentIds = new Set(
        refreshedScope
          ? stateRef.current.incidents
              .filter(
                (incident) =>
                  incident.status !== 'closed' &&
                  incidentAffectsVisit(incident, {
                    visitId: replayVisitId,
                    jobId: refreshedScope.jobId,
                    propertyId: refreshedScope.propertyId,
                  }),
              )
              .map((incident) => incident.id)
          : [],
      );
      let selectedReplayMutationIds: Set<string> | undefined;
      if (unresolvedIncidentIds.size > 0) {
        const evidenceQueue = selectIncidentEvidenceReplayQueue(
          visitQueue,
          replayVisitId,
          unresolvedIncidentIds,
        );
        if (evidenceQueue.length === 0) {
          setState((current) =>
            withToast(
              current,
              'Ordinary replay remains locked',
              'This visit has an unresolved incident. Only exact private incident evidence upload/finalizer pairs may reconcile until owner closure.',
            ),
          );
          return;
        }
        visitQueue = evidenceQueue;
        selectedReplayMutationIds = new Set(evidenceQueue.map((mutation) => mutation.id));
      }
      const completionRequested = visitQueue.some(
        (mutation) =>
          mutation.command?.commandType === 'visit.transition' &&
          mutation.command.payload.status === 'completed',
      );
      const result = await replayOfflineQueue(
        visitQueue,
        {
          executeCommand: (command) => {
            if (selectedLiveVisitScope(stateRef.current)?.visit.id !== replayVisitId) {
              throw new Error('The selected visit changed during offline replay.');
            }
            const commandVisitId = commandVisitScopeId(command);
            if (commandVisitId && commandVisitId !== replayVisitId) {
              throw new Error('An offline command escaped the selected visit scope.');
            }
            return command.commandType === 'media.register'
              ? repository.finalizeVisitMedia(command)
              : repository.executeCommand(command);
          },
          uploadMedia: (media) => {
            if (
              selectedLiveVisitScope(stateRef.current)?.visit.id !== replayVisitId ||
              media.visitId !== replayVisitId
            ) {
              throw new Error('An offline media upload escaped the selected visit scope.');
            }
            return repository.uploadPreparedVisitMedia(media);
          },
        },
        (progress) => {
          setState((current) => ({
            ...current,
            offlineQueue: mergeVisitReplayQueue(
              current.offlineQueue,
              replayVisitId,
              progress,
              selectedReplayMutationIds,
            ),
          }));
        },
      );
      await reloadLiveWorkspace();
      setState((current) => {
        const remainingQueue = mergeVisitReplayQueue(
          current.offlineQueue,
          replayVisitId,
          result.queue,
          selectedReplayMutationIds,
        );
        const otherVisitCount = new Set(
          remainingQueue
            .map((mutation) => mutation.scopeVisitId)
            .filter((visitId) => visitId && visitId !== replayVisitId),
        ).size;
        const next = { ...current, offlineQueue: remainingQueue };
        return withToast(
          next,
          result.failure
            ? 'Offline replay paused'
            : selectedReplayMutationIds
              ? 'Private incident evidence synced'
              : completionRequested
                ? 'Completion packet reconciled'
                : 'Selected visit synced',
          result.failure
            ? `${result.confirmed} newly confirmed; ${remainingQueue.length} retained with dependency and conflict evidence. ${result.failure.message}`
            : `${result.confirmed} mutation${result.confirmed === 1 ? '' : 's'} confirmed for the selected visit in dependency order with original UUIDs, hashes, expected versions, and durable media read-back.${selectedReplayMutationIds ? ' Ordinary field mutations remain retained behind the unresolved incident stop-work lock.' : ''}${otherVisitCount > 0 ? ` ${otherVisitCount} other visit packet${otherVisitCount === 1 ? '' : 's'} remain queued.` : ''}`,
        );
      });
      return;
    }
    if (
      !hasPermission(stateRef.current.role, 'field.execute') &&
      stateRef.current.role !== 'owner'
    ) {
      setState((current) =>
        withToast(current, 'Field access required', 'This role cannot replay field mutations.'),
      );
      return;
    }
    if (!stateRef.current.online) {
      setState((current) =>
        withToast(current, 'Still offline', 'Queued field changes remain safely on this device.'),
      );
      return;
    }
    setState((current) => ({
      ...current,
      offlineQueue: current.offlineQueue.map((item) => ({ ...item, status: 'syncing' })),
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    setState((current) => {
      const count = current.offlineQueue.length;
      return withToast(
        { ...current, offlineQueue: [] },
        'Offline changes synced',
        `${count} idempotent mutation${count === 1 ? '' : 's'} confirmed by the sandbox repository.`,
      );
    });
  }, [loadAuthoritativeIncidentStop, persistIncidentStopQueueUpdate, reloadLiveWorkspace]);

  const actions = useMemo<StoryOpsActions>(
    () => ({
      setRole,
      setOnline,
      completeSetup,
      saveCompanyConfigurationDraft,
      publishCompanyConfiguration,
      publishOperatingBaseline,
      setProviderActivation,
      setCompanyLaunchAuthorization,
      resetDemo,
      resetShowcaseData,
      getShowcaseTourState,
      getShowcaseBadge,
      requestMagicLink,
      signOut,
      clearThisDevice,
      reloadLiveWorkspace,
      selectCustomerPortalAccount,
      selectVisit,
      selectDispatchJob,
      setCompanyOperationalStatus,
      recordPilotReleaseEvidence,
      createRecurringDueWork,
      attachRecurringDueEstimate,
      registerMaterialSds,
      loadMoreAuditEvents,
      submitCustomerPortalRequest,
      updateCustomerCommunicationPreferences,
      selectLead,
      addLead,
      createCustomerProperty,
      requestPropertyGeocode,
      confirmPropertyGeocode,
      qualifyLead,
      linkLeadScope,
      updateEstimate,
      loadLiveEstimateContext,
      calculateLiveEstimate,
      runPolicyCheck,
      decideApproval,
      executeApprovedAction,
      sendQuote,
      queueTransactionalDelivery,
      acceptQuote,
      markQuoteViewed,
      submitQuoteDecision,
      resolveQuoteChangeRequest,
      resolvePaymentAllocation,
      startDepositCheckout,
      startInvoiceCheckout,
      loadSchedulingSuggestions,
      refreshSchedulingEvidence,
      bookJob,
      optimizeRoutes,
      startRouteWithDispatchClearance,
      updateVisitStatus,
      toggleChecklist,
      addPhoto,
      addIncidentEvidence,
      recordMaterial,
      cacheSdsDocument,
      submitFieldChangeRequest,
      loadCustomerEvidence,
      publishCompletedWorkEvidence,
      updateVisitNotes,
      captureSignature,
      reportIncident,
      closeIncident,
      completeVisit,
      issueInvoice,
      recordSandboxPayment,
      sendInvoiceReminder,
      requestReview,
      inviteReferral,
      activateRecurringPlan,
      runAiOffice,
      runOwnerBriefing,
      checkIntegrations,
      markNotificationsRead,
      dismissToast,
      syncOfflineQueue,
    }),
    [
      setRole,
      setOnline,
      completeSetup,
      saveCompanyConfigurationDraft,
      publishCompanyConfiguration,
      publishOperatingBaseline,
      setProviderActivation,
      setCompanyLaunchAuthorization,
      resetDemo,
      resetShowcaseData,
      getShowcaseTourState,
      getShowcaseBadge,
      requestMagicLink,
      signOut,
      clearThisDevice,
      reloadLiveWorkspace,
      selectCustomerPortalAccount,
      selectVisit,
      selectDispatchJob,
      setCompanyOperationalStatus,
      recordPilotReleaseEvidence,
      createRecurringDueWork,
      attachRecurringDueEstimate,
      registerMaterialSds,
      loadMoreAuditEvents,
      submitCustomerPortalRequest,
      updateCustomerCommunicationPreferences,
      selectLead,
      addLead,
      createCustomerProperty,
      requestPropertyGeocode,
      confirmPropertyGeocode,
      qualifyLead,
      linkLeadScope,
      updateEstimate,
      loadLiveEstimateContext,
      calculateLiveEstimate,
      runPolicyCheck,
      decideApproval,
      executeApprovedAction,
      sendQuote,
      queueTransactionalDelivery,
      acceptQuote,
      markQuoteViewed,
      submitQuoteDecision,
      resolveQuoteChangeRequest,
      resolvePaymentAllocation,
      startDepositCheckout,
      startInvoiceCheckout,
      loadSchedulingSuggestions,
      refreshSchedulingEvidence,
      bookJob,
      optimizeRoutes,
      startRouteWithDispatchClearance,
      updateVisitStatus,
      toggleChecklist,
      addPhoto,
      addIncidentEvidence,
      recordMaterial,
      cacheSdsDocument,
      submitFieldChangeRequest,
      loadCustomerEvidence,
      publishCompletedWorkEvidence,
      updateVisitNotes,
      captureSignature,
      reportIncident,
      closeIncident,
      completeVisit,
      issueInvoice,
      recordSandboxPayment,
      sendInvoiceReminder,
      requestReview,
      inviteReferral,
      activateRecurringPlan,
      runAiOffice,
      runOwnerBriefing,
      checkIntegrations,
      markNotificationsRead,
      dismissToast,
      syncOfflineQueue,
    ],
  );

  const value = useMemo<StoryOpsContextValue>(
    () => ({
      state,
      actions,
      can: (permission) => hasPermission(state.role, permission),
    }),
    [actions, state],
  );

  return <StoryOpsContext.Provider value={value}>{children}</StoryOpsContext.Provider>;
}

export function useStoryOps(): StoryOpsContextValue {
  const context = useContext(StoryOpsContext);
  if (!context) {
    throw new Error('useStoryOps must be used inside StoryOpsProvider');
  }
  return context;
}
