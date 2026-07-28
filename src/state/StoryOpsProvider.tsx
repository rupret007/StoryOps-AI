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
import { calculateDemoPrice, mergeDemoPrice } from '@/data/priceBook';
import { hasPermission, type Permission } from '@/domain';
import { createDemoState } from './demoSeed';
import {
  buildStoryOpsCommand,
  buildStoryOpsGoldenPathCommand,
  getLiveStoryOpsRepository,
  readLiveRepositoryConfig,
  type PreparedVisitMedia,
  type PostServiceActionInput,
  type StoryOpsCommandType,
} from './liveRepository';
import { commandMutation, mediaUploadMutation, replayOfflineQueue } from './offlineFieldQueue';
import {
  createLiveSetupRequiredState,
  createSignedOutLiveState,
  mapLiveWorkspace,
} from './liveWorkspaceMapper';
import type {
  LiveEstimateContext,
  LiveEstimateReceipt,
  LiveEstimateRequest,
} from './liveEstimating';
import type {
  AppRole,
  DemoApproval,
  DemoAuditEvent,
  DemoEstimate,
  DemoIncident,
  DemoState,
  DemoToast,
  DemoTrace,
  DemoVisit,
  OfflineMutation,
  SandboxSetupInput,
  SandboxServiceCode,
  StoryOpsActions,
} from './model';
import {
  clearPersistedState,
  loadPersistedState,
  purgeClientPersistence,
  savePersistedState,
} from './persistence';
import { createCompletionSignaturePng } from './completionSignature';

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
const sandboxServiceCodes = new Set<SandboxServiceCode>([
  'pressure-wash-flatwork',
  'soft-wash-house',
  'gutter-cleaning',
]);
const containsControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

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

function calculateAndMerge(estimate: DemoEstimate): DemoEstimate {
  return mergeDemoPrice(estimate);
}

function chainOfflineMutations(
  existing: readonly OfflineMutation[],
  additions: readonly OfflineMutation[],
): OfflineMutation[] {
  let previousId = existing.at(-1)?.id;
  return additions.map((mutation) => {
    const dependencies = new Set(mutation.dependsOn ?? []);
    if (previousId) dependencies.add(previousId);
    const chained = { ...mutation, dependsOn: [...dependencies] };
    previousId = mutation.id;
    return chained;
  });
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
  const persistenceTimerRef = useRef<number | undefined>(undefined);
  const offlineCommitTailRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const reloadLiveWorkspace = useCallback(async () => {
    const repository = liveRepositoryRef.current;
    if (!repository) {
      const error =
        liveConfigRef.current.configurationError ?? 'The live repository is not configured.';
      setState(createSignedOutLiveState(error));
      return;
    }
    if (!navigator.onLine) {
      setState((current) =>
        withToast(
          { ...current, online: false },
          'Workspace is offline',
          'The last role-scoped workspace remains available. Queued commands have not been sent.',
        ),
      );
      return;
    }
    try {
      const setupState = await repository.loadSetupState();
      if (setupState.status === 'required') {
        await clearPersistedState();
        const setupRequired = createLiveSetupRequiredState(setupState);
        setState((current) => ({
          ...setupRequired,
          online: true,
          toasts: current.toasts,
        }));
        return;
      }
      const workspace = await repository.loadWorkspace();
      const mapped = mapLiveWorkspace(workspace);
      setState((current) => ({
        ...mapped,
        online: true,
        offlineQueue: current.dataMode === 'supabase' ? current.offlineQueue : mapped.offlineQueue,
        toasts: current.toasts,
      }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Workspace load failed.';
      setState((current) => ({
        ...current,
        hydrated: true,
        authStatus: 'error',
        liveError: detail,
      }));
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

    void repository
      .getSession()
      .then(async (session) => {
        if (!active) return;
        if (!session) {
          await purgeClientPersistence();
          setState(createSignedOutLiveState());
          return;
        }
        const persisted = await loadPersistedState({
          userId: session.user.id,
          companyId: repository.companyId,
        });
        if (!navigator.onLine && persisted?.dataMode === 'supabase') {
          if (!active) return;
          setState({
            ...persisted,
            hydrated: true,
            authStatus: 'signed_in',
            online: false,
            toasts: [],
          });
          return;
        }
        let workspace;
        try {
          const setupState = await repository.loadSetupState();
          if (setupState.userId !== session.user.id) {
            throw new Error('Setup-state user identity did not match the authenticated session.');
          }
          if (setupState.status === 'required') {
            await clearPersistedState();
            if (!active) return;
            setState(createLiveSetupRequiredState(setupState));
            return;
          }
          workspace = await repository.loadWorkspace();
        } catch (error) {
          if (persisted?.dataMode !== 'supabase') throw error;
          if (!active) return;
          setState({
            ...persisted,
            hydrated: true,
            authStatus: 'signed_in',
            online: false,
            liveError:
              error instanceof Error
                ? `${error.message} Showing the last scoped field workspace.`
                : 'Workspace refresh failed. Showing the last scoped field workspace.',
            toasts: [],
          });
          return;
        }
        if (!active) return;
        const mapped = mapLiveWorkspace(workspace);
        setState({
          ...mapped,
          offlineQueue: persisted?.dataMode === 'supabase' ? persisted.offlineQueue : [],
          online: navigator.onLine,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState(
          createSignedOutLiveState(
            error instanceof Error ? error.message : 'Live workspace initialization failed.',
          ),
        );
      });

    const unsubscribe = repository.onAuthStateChange((session) => {
      if (!active) return;
      if (!session) {
        void purgeClientPersistence();
        setState(createSignedOutLiveState());
        return;
      }
      if (stateRef.current.live?.userId && stateRef.current.live.userId !== session.user.id) {
        void purgeClientPersistence();
        setState(createSignedOutLiveState());
      }
      window.setTimeout(() => {
        if (active) void reloadLiveWorkspace();
      }, 0);
    });
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
    try {
      await repository.signOut();
      await purgeClientPersistence();
      setState(createSignedOutLiveState());
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

  const persistLiveOfflineMutations = useCallback(
    (
      mutations: readonly OfflineMutation[],
      optimistic: ((current: DemoState) => DemoState) | undefined,
      success: { title: string; detail: string },
    ): Promise<boolean> => {
      const commit = offlineCommitTailRef.current.then(async () => {
        const current = stateRef.current;
        const optimisticState = optimistic ? optimistic(current) : current;
        const chained = chainOfflineMutations(optimisticState.offlineQueue, mutations);
        const next = {
          ...optimisticState,
          offlineQueue: [...optimisticState.offlineQueue, ...chained],
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
        return;
      }
      try {
        const commands = await Promise.all(inputs.map(buildStoryOpsCommand));
        if (!stateRef.current.online) {
          const queuedAt = isoNow();
          const mutations = commands.map((command) => commandMutation(command, queuedAt));
          const completionRequested = commands.some(
            (command) =>
              command.commandType === 'visit.transition' && command.payload.status === 'completed',
          );
          await persistLiveOfflineMutations(mutations, optimistic, {
            title: completionRequested ? 'Completion pending sync' : 'Saved offline',
            detail: completionRequested
              ? 'The completion intent and timer stop are queued, but the visit remains incomplete until Storage and every prerequisite RPC are durably reconciled.'
              : `${commands.length} command${commands.length === 1 ? '' : 's'} queued with stable UUIDs, request hashes, expected versions, and dependency order.`,
          });
          return;
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
    ) => runLiveCommands([input], success, optimistic),
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
      if (!repository || !stateRef.current.online) {
        setState((current) =>
          withToast(
            current,
            'Online verification required',
            'Booking and invoice issuance require current server evidence and cannot be queued offline.',
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
      purpose: 'before' | 'after' | 'signature',
      blob: Blob,
      filename: string,
      contentType: string,
    ): Promise<PreparedLiveMediaPacket> => {
      const repository = liveRepositoryRef.current;
      const live = stateRef.current.live;
      if (!repository || !live?.visit || !live.propertyId || !live.jobId) {
        throw new Error('The live visit, property, and job scope must be loaded before upload.');
      }
      const assetId = crypto.randomUUID();
      const prepared = await repository.prepareVisitMedia({
        visitId: live.visit.id,
        assetId,
        blob,
        filename,
        contentType,
        capturedAt: isoNow(),
      });
      const uploadId = crypto.randomUUID();
      const registerCommand = await buildStoryOpsCommand({
        commandType: 'media.register',
        expectedVersion: 0,
        payload: {
          entityId: assetId,
          visitId: live.visit.id,
          jobId: live.jobId,
          propertyId: live.propertyId,
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
          mediaUploadMutation(uploadId, prepared, prepared.capturedAt),
          commandMutation(registerCommand, prepared.capturedAt, [uploadId]),
        ],
      };
    },
    [],
  );

  const reconcileLiveMediaPacket = useCallback(
    async (packet: PreparedLiveMediaPacket): Promise<string> => {
      const repository = liveRepositoryRef.current;
      if (!repository) throw new Error('The live repository is unavailable.');
      const upload = packet.mutations.find((mutation) => mutation.kind === 'media_upload');
      const registration = packet.mutations.find(
        (mutation) => mutation.command?.commandType === 'media.register',
      );
      if (!upload?.mediaUpload || !registration?.command) {
        throw new Error('The prepared media packet is incomplete.');
      }
      await repository.uploadPreparedVisitMedia(upload.mediaUpload);
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
        { ...current, online },
        online ? 'Connection restored' : 'Offline field mode',
        online
          ? `${current.offlineQueue.length} queued change${current.offlineQueue.length === 1 ? '' : 's'} ready to sync.`
          : 'Field updates will be stored on this device with idempotency keys.',
      ),
    );
  }, []);

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
              'The owner membership, inactive service drafts, review-required pricing/terms/retention drafts, and ten disabled integrations are durable. Company status remains setup; launch is not authorized.',
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
    (input: {
      displayName: string;
      email: string;
      phone: string;
      acquisitionSource: string;
      propertyName: string;
      serviceAddress: {
        line1: string;
        city: string;
        region: string;
        postalCode: string;
        country: string;
      };
    }) => {
      const displayName = input.displayName.trim();
      if (displayName.length < 2 || input.serviceAddress.line1.trim().length < 5) {
        setState((current) =>
          withToast(
            current,
            'Customer needs verified facts',
            'A customer name and complete service address are required.',
          ),
        );
        return;
      }
      if (stateRef.current.dataMode === 'supabase') {
        const customerId = crypto.randomUUID();
        const propertyId = crypto.randomUUID();
        void runLiveCommands(
          [
            {
              commandType: 'customer.create',
              expectedVersion: 0,
              payload: {
                entityId: customerId,
                kind: 'individual',
                displayName,
                email: input.email.trim() || undefined,
                phone: input.phone.trim() || undefined,
                acquisitionSource: input.acquisitionSource.trim() || 'manual',
              },
            },
            {
              commandType: 'property.create',
              expectedVersion: 0,
              payload: {
                entityId: propertyId,
                customerId,
                name: input.propertyName.trim() || 'Primary property',
                propertyType: 'single_family',
                serviceAddress: {
                  line1: input.serviceAddress.line1.trim(),
                  city: input.serviceAddress.city.trim(),
                  region: input.serviceAddress.region.trim(),
                  postalCode: input.serviceAddress.postalCode.trim(),
                  country: input.serviceAddress.country.trim() || 'US',
                },
                knownHazards: [],
              },
            },
          ],
          {
            title: 'Customer and property created',
            detail: 'Both normalized records were accepted in order with stable command IDs.',
          },
        );
        return;
      }
      setState((current) =>
        withToast(
          current,
          'Customer created',
          `${displayName} and the supplied service property were added to sandbox records.`,
        ),
      );
    },
    [runLiveCommands],
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
              lead.id === id ? { ...lead, stage: 'qualified', value: '$613' } : lead,
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
      if (!stateRef.current.online) {
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
          const estimate = calculateAndMerge({
            ...current.estimate,
            [field]: value,
            status: 'draft',
          } as DemoEstimate);
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
      if (!current.online) {
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
      if (!current.online) {
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
        result = calculateDemoPrice(current.estimate);
      } catch {
        return withToast(
          current,
          'Estimate needs input',
          'Measurements must be positive decimal values.',
        );
      }
      const estimate = calculateAndMerge(current.estimate);
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
      if (
        current.dataMode !== 'supabase' ||
        current.role !== 'owner' ||
        !approval ||
        approval.status !== 'approved' ||
        approval.actionType !== 'payments.refund' ||
        approval.consumedAt
      ) {
        setState((state) =>
          withToast(
            state,
            'Execution blocked',
            'Only an authenticated owner can execute an unconsumed, approved refund through the registered server validator.',
          ),
        );
        return;
      }
      if (!current.online) {
        setState((state) =>
          withToast(
            state,
            'Connection required',
            'External approved actions are never queued offline because provider state must be reconciled immediately.',
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
          setState((state) =>
            withToast(
              state,
              result.replayed ? 'Execution already confirmed' : 'Approved refund executed',
              result.replayed
                ? 'The durable receipt confirms this exact action executed previously; no duplicate provider write occurred.'
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
                ? 'The selected lead receipt no longer matches the role-visible quote. Refresh instead of sending another customer’s quote.'
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
            title: 'Quote sent',
            detail: 'The server verified the approved estimate, quote validity, role, and version.',
          },
        );
        return;
      }
      setState((current) => {
        if (!hasPermission(current.role, 'estimates.write')) {
          return withToast(current, 'Action blocked', 'This role cannot publish quotes.');
        }
        if (current.estimate.status !== 'approved' && current.estimate.status !== 'quoted') {
          return withToast(
            current,
            'Quote not sent',
            'Run the policy check and resolve approvals first.',
          );
        }
        if (current.estimate.status === 'quoted') {
          return withToast(
            current,
            'Duplicate prevented',
            'This quote was already sent with the same idempotency key.',
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
            action: 'Recorded sandbox quote-delivery fixture',
            result: 'succeeded',
            detail:
              'Synthetic consent and delivery receipts were recorded locally; no email or SMS provider was contacted.',
            promptVersion: 'followup-v5.0',
          },
          {
            actor: 'sandbox:follow_up',
            action: 'quote.delivery_fixture_recorded',
            entity: current.estimate.id,
            outcome: 'synthetic',
          },
        );
        return withToast(
          next,
          'Sandbox quote recorded',
          'Synthetic email and SMS receipts were recorded locally; no customer was contacted.',
        );
      });
    },
    [runLiveCommand],
  );

  const acceptQuote = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      const quote = stateRef.current.live?.quote;
      if (!quote) {
        setState((current) =>
          withToast(current, 'Quote unavailable', 'No customer-visible quote is selected.'),
        );
        return;
      }
      const signerName = stateRef.current.live?.customerName;
      if (!signerName) {
        setState((current) =>
          withToast(
            current,
            'Signer identity unavailable',
            'The portal customer projection must include a verified display name.',
          ),
        );
        return;
      }
      void runLiveCommand(
        {
          commandType: 'quote.accept',
          expectedVersion: quote.version,
          payload: {
            entityId: quote.id,
            signerName,
          },
        },
        {
          title: 'Quote accepted',
          detail: 'The server recorded the authenticated customer, exact terms, total, and time.',
        },
      );
      return;
    }
    setState((current) => {
      if (
        !hasPermission(current.role, 'portal.self.write') &&
        !hasPermission(current.role, 'estimates.write')
      ) {
        return withToast(current, 'Action blocked', 'This role cannot accept customer terms.');
      }
      if (current.estimate.status !== 'quoted' && !current.customerQuoteAccepted) {
        return withToast(current, 'Quote unavailable', 'The approved quote must be sent first.');
      }
      if (current.customerQuoteAccepted) {
        return withToast(
          current,
          'Acceptance already recorded',
          'The signed terms snapshot has not been duplicated.',
        );
      }
      const next = withEvidence(
        {
          ...current,
          customerQuoteAccepted: true,
          depositPaid: true,
          leads: current.leads.map((lead) =>
            lead.id === current.estimate.leadId ? { ...lead, stage: 'quoted' } : lead,
          ),
        },
        {
          agent: 'Scheduling',
          action: 'Recorded sandbox acceptance and deposit fixtures',
          result: 'succeeded',
          detail:
            'Synthetic terms and deposit state advanced locally; no payment provider was contacted and no funds moved.',
          promptVersion: 'scheduling-v3.1',
        },
        {
          actor: 'sandbox:customer_fixture',
          action: 'quote.acceptance_fixture_recorded',
          entity: current.estimate.id,
          outcome: 'synthetic',
        },
      );
      return withToast(
        next,
        'Sandbox acceptance recorded',
        'Synthetic terms, signature, and deposit fixtures were recorded locally; no funds moved.',
      );
    });
  }, [runLiveCommand]);

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
    const quote = stateRef.current.live?.quote;
    if (!repository || !quote || !stateRef.current.online) {
      setState((current) =>
        withToast(
          current,
          'Checkout unavailable',
          'An online authenticated accepted quote is required to prepare checkout.',
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

  const bookJob = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      const job = stateRef.current.live?.job;
      if (!job) {
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
          payload: { entityId: job.id },
          commandId: job.id,
        },
        {
          title: 'Visit booked',
          detail:
            'The server verified provider-backed deposit state, active skills and equipment, crew overlap, fresh route evidence, and eligible weather.',
        },
      );
      return;
    }
    setState((current) => {
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
  }, [runLiveGoldenPathCommand]);

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
        const target = current.visits[0];
        if (!target) return current;
        if (requiresActiveWork && target.status !== 'on_site' && target.status !== 'paused') {
          return withToast(
            current,
            'Start the job first',
            'Field evidence, materials, notes, and signatures require an active on-site timer.',
          );
        }
        const visits = current.visits.map((visit, index) => (index === 0 ? updater(visit) : visit));
        const mutation = {
          id: uniqueId('mutation'),
          idempotencyKey: `field:${target.id}:${action}:${current.syncRevision + 1}`,
          action,
          entityId: target.id,
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
        const current = stateRef.current;
        const visit = current.visits[0];
        const visitReference = current.live?.visit;
        if (!visit || !visitReference) {
          setState((state) =>
            withToast(state, 'Visit update blocked', 'No versioned assigned visit is selected.'),
          );
          return;
        }
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
            visits: optimisticState.visits.map((item, index) =>
              index === 0
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
        const reference = stateRef.current.live?.checklistItems[id];
        const item = stateRef.current.visits[0]?.checklist.find((entry) => entry.id === id);
        if (!reference || !item) {
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
            visits: optimisticState.visits.map((visit, index) =>
              index === 0
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
        void prepareLiveMediaPacket(kind, file, file.name, file.type || 'application/octet-stream')
          .then(async (packet) => {
            if (!stateRef.current.online) {
              await persistLiveOfflineMutations(
                packet.mutations,
                (optimisticState) => ({
                  ...optimisticState,
                  visits: optimisticState.visits.map((visit, index) =>
                    index === 0
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

  const recordMaterial = useCallback(
    (name: string, amount: string) => {
      if (stateRef.current.dataMode === 'supabase') {
        const requestedName = name.toLowerCase();
        const material = stateRef.current.live?.materials.find((item) => {
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
        if (material.requiresSds && !material.sdsDocument) {
          setState((current) =>
            withToast(
              current,
              'Material record blocked',
              `${material.name} is classified as requiring an SDS, but no SDS metadata is attached to the active catalog record.`,
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
        const visitId = stateRef.current.live?.visit?.id;
        if (!visitId) return;
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
            visits: optimisticState.visits.map((visit, index) =>
              index === 0
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

  const updateVisitNotes = useCallback(
    (notes: string) => {
      if (stateRef.current.dataMode === 'supabase') {
        const normalized = notes.trim();
        const visit = stateRef.current.visits[0];
        const visitReference = stateRef.current.live?.visit;
        if (!visit || !visitReference) {
          setState((current) =>
            withToast(current, 'Job notes blocked', 'No versioned assigned visit is selected.'),
          );
          return;
        }
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
            visits: optimisticState.visits.map((item, index) =>
              index === 0 ? { ...item, notes: normalized } : item,
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
        );
        return;
      }
      const normalized = notes.trim();
      if (normalized === stateRef.current.visits[0]?.notes) return;
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
        const live = stateRef.current.live;
        if (normalizedName.length < 2 || !live?.visit) {
          setState((current) =>
            withToast(
              current,
              'Signature not captured',
              'Enter the signer’s verified name and load a versioned visit first.',
            ),
          );
          return;
        }
        const signedAt = isoNow();
        void createCompletionSignaturePng({
          signerName: normalizedName,
          signedAt,
          visitId: live.visit.id,
        })
          .then(async (artifact) => {
            const packet = await prepareLiveMediaPacket(
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
                visitId: live.visit?.id,
                signerName: normalizedName,
                signerRole: 'customer',
                signedAt,
                signatureAssetId: packet.media.assetId,
                disclosureVersion: 'completion-v1',
              },
            });
            const signatureMutation = commandMutation(signatureCommand, signedAt, [registrationId]);
            if (!stateRef.current.online) {
              await persistLiveOfflineMutations(
                [...packet.mutations, signatureMutation],
                (optimisticState) => ({
                  ...optimisticState,
                  visits: optimisticState.visits.map((visit, index) =>
                    index === 0 ? { ...visit, signature: true } : visit,
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
    (input: {
      kind: DemoIncident['kind'];
      summary: string;
      severity?: 'near_miss' | 'minor' | 'serious' | 'critical';
      immediateActions?: string;
    }) => {
      if (stateRef.current.dataMode === 'supabase') {
        const current = stateRef.current;
        const live = current.live;
        const visit = current.visits[0];
        const summary = input.summary.trim();
        const immediateActions = input.immediateActions?.trim() ?? '';
        if (
          !live?.visit ||
          !live.jobId ||
          !live.propertyId ||
          !visit ||
          summary.length < 10 ||
          immediateActions.length < 5 ||
          !input.severity
        ) {
          setState((state) =>
            withToast(
              state,
              'Incident needs direct facts',
              'Select severity and record both the observation and immediate actions taken.',
            ),
          );
          return;
        }
        const visitReference = live.visit;
        const entityId = crypto.randomUUID();
        const occurredAt = isoNow();
        const category =
          input.kind === 'injury_or_exposure'
            ? 'injury'
            : input.kind === 'property_damage'
              ? 'property_damage'
              : 'other';
        const commands: Array<{
          commandType: StoryOpsCommandType;
          expectedVersion: number;
          payload: Record<string, unknown>;
        }> = [
          {
            commandType: 'incident.report',
            expectedVersion: 0,
            payload: {
              entityId,
              incidentNumber: `INC-${entityId.slice(0, 8).toUpperCase()}`,
              jobId: live.jobId,
              visitId: visitReference.id,
              propertyId: live.propertyId,
              severity: input.severity,
              category,
              occurredAt,
              summary,
              immediateActions,
              requiresLegalReview:
                input.severity === 'serious' ||
                input.severity === 'critical' ||
                input.kind === 'injury_or_exposure',
            },
          },
        ];
        if (live.activeTimeEntry) {
          commands.push({
            commandType: 'time.stop',
            expectedVersion: live.activeTimeEntry.version,
            payload: {
              entityId: live.activeTimeEntry.id,
              endedAt: occurredAt,
            },
          });
        }
        if (visit.status === 'on_site') {
          commands.push({
            commandType: 'visit.transition',
            expectedVersion: visitReference.version,
            payload: { entityId: visitReference.id, status: 'paused' },
          });
        }
        void runLiveCommands(
          commands,
          {
            title: 'Incident record opened',
            detail: 'The server recorded supplied facts and paused supported affected work.',
          },
          (optimisticState) => ({
            ...optimisticState,
            incidents: [
              {
                id: entityId,
                visitId: visitReference.id,
                jobNumber: visit.jobNumber,
                kind: input.kind,
                summary,
                status: 'open',
                reportedAt: occurredAt,
                reportedBy: optimisticState.role,
                automationsPaused: true,
              },
              ...optimisticState.incidents,
            ],
            visits: optimisticState.visits.map((item, index) =>
              index === 0 ? { ...item, status: 'paused', timerStartedAt: undefined } : item,
            ),
            live: optimisticState.live
              ? {
                  ...optimisticState.live,
                  activeTimeEntry: undefined,
                  visit: {
                    ...visitReference,
                    version:
                      visit.status === 'on_site'
                        ? visitReference.version + 1
                        : visitReference.version,
                  },
                  visitStatus: visit.status === 'on_site' ? 'paused' : live.visitStatus,
                }
              : undefined,
          }),
        );
        return;
      }
      setState((current) => {
        if (!hasPermission(current.role, 'incidents.report')) {
          return withToast(
            current,
            'Incident reporting unavailable',
            'This role cannot create incident records.',
          );
        }
        const visit = current.visits[0];
        const summary = input.summary.trim();
        if (!visit || summary.length < 10) {
          return withToast(
            current,
            'More facts required',
            'Enter at least 10 characters describing what was directly observed.',
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
            visits: current.visits.map((item, index) =>
              index === 0
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
    },
    [runLiveCommands],
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
        const incidentVersion = stateRef.current.live?.incidentVersions[id];
        if (stateRef.current.role !== 'owner' || !incidentVersion) {
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
      const visit = current.visits[0];
      if (!live?.visit || !visit) {
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
      const unresolvedIncident = current.incidents.some(
        (incident) => incident.visitId === visit.id && incident.status !== 'closed',
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
      const visitReference = live.visit;
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
      void runLiveCommands(commands, {
        title: 'Visit completed',
        detail:
          'The server verified checklist, synced before/after media, durable signature, stopped timers, notes, materials, incidents, role, and optimistic version.',
      });
      return;
    }
    setState((current) => {
      if (!hasPermission(current.role, 'field.execute') && current.role !== 'owner') {
        return withToast(current, 'Field access required', 'Switch to owner or technician view.');
      }
      const visit = current.visits[0];
      if (!visit) return current;
      if (visit.status !== 'on_site' && visit.status !== 'paused') {
        return withToast(current, 'Completion blocked', 'Start the on-site job timer first.');
      }
      if (
        current.incidents.some(
          (incident) => incident.visitId === visit.id && incident.status === 'open',
        )
      ) {
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
            visits: current.visits.map((item, index) =>
              index === 0
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
      if (!hasPermission(current.role, 'invoices.write')) {
        return withToast(current, 'Action blocked', 'This role cannot issue invoices.');
      }
      if (current.visits[0]?.status !== 'complete') {
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
      if (!repository || !stateRef.current.online) {
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

  const runOwnerBriefing = useCallback(() => {
    if (stateRef.current.dataMode === 'supabase') {
      setState((current) =>
        withToast(
          current,
          'Live briefing command unavailable',
          'No briefing run was claimed. The role projection does not expose an authenticated briefing command.',
        ),
      );
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
  }, []);

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
        .then((health) => {
          setState((current) =>
            withToast(
              {
                ...current,
                integrations: health.providers.map((provider) => ({
                  id: provider.provider,
                  name: provider.provider.replaceAll('_', ' '),
                  provider: provider.provider,
                  mode:
                    provider.mode === 'live'
                      ? 'Live'
                      : provider.mode === 'sandbox'
                        ? 'Sandbox'
                        : 'Disabled',
                  status:
                    provider.status === 'healthy'
                      ? 'Healthy'
                      : provider.status === 'degraded'
                        ? 'Degraded'
                        : 'Needs setup',
                  capabilities: [provider.capability],
                  lastCheck: provider.checkedAt ?? health.checkedAt,
                })),
              },
              'Provider checks complete',
              `Authenticated Edge health returned ${health.overall.replaceAll('_', ' ')}.`,
            ),
          );
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
      const queued = stateRef.current.offlineQueue;
      if (queued.length === 0) {
        setState((current) =>
          withToast(current, 'Nothing to sync', 'There are no queued live commands.'),
        );
        return;
      }
      const invalidItem = queued.find(
        (item) => !item.command && !(item.kind === 'media_upload' && item.mediaUpload),
      );
      if (invalidItem) {
        setState((current) =>
          withToast(
            current,
            'Sync blocked',
            'A legacy queue item lacks its exact command or media payload and cannot be replayed safely.',
          ),
        );
        return;
      }
      const completionRequested = queued.some(
        (mutation) =>
          mutation.command?.commandType === 'visit.transition' &&
          mutation.command.payload.status === 'completed',
      );
      const result = await replayOfflineQueue(
        queued,
        {
          executeCommand: (command) =>
            command.commandType === 'media.register'
              ? repository.finalizeVisitMedia(command)
              : repository.executeCommand(command),
          uploadMedia: (media) => repository.uploadPreparedVisitMedia(media),
        },
        (progress) => {
          setState((current) => ({ ...current, offlineQueue: progress }));
        },
      );
      await reloadLiveWorkspace();
      setState((current) => {
        const next = { ...current, offlineQueue: result.queue };
        return withToast(
          next,
          result.failure
            ? 'Offline replay paused'
            : completionRequested
              ? 'Completion packet reconciled'
              : 'Offline commands synced',
          result.failure
            ? `${result.confirmed} newly confirmed; ${result.queue.length} retained with dependency and conflict evidence. ${result.failure.message}`
            : `${result.confirmed} mutation${result.confirmed === 1 ? '' : 's'} confirmed in dependency order with original UUIDs, hashes, expected versions, and durable media read-back.`,
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
  }, [reloadLiveWorkspace]);

  const actions = useMemo<StoryOpsActions>(
    () => ({
      setRole,
      setOnline,
      completeSetup,
      resetDemo,
      requestMagicLink,
      signOut,
      reloadLiveWorkspace,
      selectLead,
      addLead,
      createCustomerProperty,
      qualifyLead,
      linkLeadScope,
      updateEstimate,
      loadLiveEstimateContext,
      calculateLiveEstimate,
      runPolicyCheck,
      decideApproval,
      executeApprovedAction,
      sendQuote,
      acceptQuote,
      startDepositCheckout,
      bookJob,
      optimizeRoutes,
      updateVisitStatus,
      toggleChecklist,
      addPhoto,
      recordMaterial,
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
      resetDemo,
      requestMagicLink,
      signOut,
      reloadLiveWorkspace,
      selectLead,
      addLead,
      createCustomerProperty,
      qualifyLead,
      linkLeadScope,
      updateEstimate,
      loadLiveEstimateContext,
      calculateLiveEstimate,
      runPolicyCheck,
      decideApproval,
      executeApprovedAction,
      sendQuote,
      acceptQuote,
      startDepositCheckout,
      bookJob,
      optimizeRoutes,
      updateVisitStatus,
      toggleChecklist,
      addPhoto,
      recordMaterial,
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
