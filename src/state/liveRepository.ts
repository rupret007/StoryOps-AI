import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js';
import { z } from 'zod';
import type { AppRole, SandboxSetupInput } from './model';
import {
  liveEstimateContextSchema,
  liveEstimateReceiptSchema,
  type LiveEstimateContext,
  type LiveEstimateReceipt,
  type LiveEstimateRequest,
} from './liveEstimating';
import {
  canonicalLiveSetupPayload,
  liveSetupReceiptSchema,
  liveSetupStateSchema,
  stableLiveSetupCommandId,
  type LiveSetupReceipt,
  type LiveSetupState,
} from './liveSetup';

export const LIVE_WORKSPACE_SCHEMA_VERSION = 'storyops-workspace-v1';

const appRoleSchema = z.enum(['owner', 'dispatcher', 'technician', 'customer']);

const workspaceSchema = z
  .object({
    schemaVersion: z.literal(LIVE_WORKSPACE_SCHEMA_VERSION),
    serverTime: z.string(),
    session: z.object({
      userId: z.string().uuid(),
      companyId: z.string().uuid(),
      role: appRoleSchema,
    }),
    company: z.object({
      id: z.string().uuid(),
      name: z.string(),
      timezone: z.string(),
      currency: z.string(),
      status: z.string(),
      settings: z.record(z.string(), z.unknown()),
      version: z.number().int().nonnegative(),
    }),
  })
  .passthrough();

const fieldReferenceSchema = z
  .object({
    materials: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string().min(1),
          unit: z.string().min(1),
          requiresSds: z.boolean(),
          version: z.number().int().positive(),
          sdsDocument: z
            .object({
              id: z.string().uuid(),
              productName: z.string().min(1),
              manufacturer: z.string().min(1),
              revisionDate: z.string().min(1),
              reviewedAt: z.string().nullable(),
              checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
              storageObjectPath: z.string().min(1),
              version: z.number().int().positive(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    checklistDefinitions: z.array(
      z
        .object({
          id: z.string().uuid(),
          templateId: z.string().uuid(),
          label: z.string().min(1),
          itemKind: z.enum(['boolean', 'text', 'number', 'photo', 'signature']),
          required: z.boolean(),
          safetyCritical: z.boolean(),
          sortOrder: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    fieldIncidents: z.array(
      z
        .object({
          id: z.string().uuid(),
          visitId: z.string().uuid().nullable(),
          jobId: z.string().uuid().nullable(),
          incidentNumber: z.string().min(1),
          severity: z.enum(['near_miss', 'minor', 'serious', 'critical']),
          status: z.enum(['open', 'investigating', 'corrective_action', 'closed']),
          category: z.enum([
            'injury',
            'property_damage',
            'chemical',
            'vehicle',
            'environmental',
            'other',
          ]),
          reportedAt: z.string().min(1),
          summary: z.string().min(1),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export type LiveWorkspace = z.infer<typeof workspaceSchema>;

export type StoryOpsCommandType =
  | 'lead.create'
  | 'lead.qualify'
  | 'lead.link_scope'
  | 'customer.create'
  | 'property.create'
  | 'quote.send'
  | 'quote.accept'
  | 'visit.transition'
  | 'visit.notes.update'
  | 'checklist.record'
  | 'time.start'
  | 'time.stop'
  | 'material.record'
  | 'media.register'
  | 'signature.capture'
  | 'incident.report'
  | 'incident.close'
  | 'notification.read'
  | 'approval.decide';

export type StoryOpsGoldenPathCommandType = 'job.book' | 'invoice.issue';

export interface StoryOpsCommand {
  commandId: string;
  commandType: StoryOpsCommandType;
  expectedVersion: number;
  payload: Record<string, unknown>;
  requestHash: string;
}

export interface StoryOpsGoldenPathCommand {
  commandId: string;
  commandType: StoryOpsGoldenPathCommandType;
  expectedVersion: number;
  payload: Record<string, unknown>;
  requestHash: string;
}

export interface StoryOpsCommandResult {
  commandId: string;
  commandType: StoryOpsCommandType | StoryOpsGoldenPathCommandType;
  status: 'applied';
  replayed: boolean;
  entityId: string;
  version: number;
  requestHash: string;
  serverTime: string;
}

export interface PreparedVisitMedia {
  assetId: string;
  visitId: string;
  blob: Blob;
  filename: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  objectPath: string;
  checksumSha256: string;
  byteSize: number;
  capturedAt: string;
}

export interface LiveRepositoryConfig {
  requested: boolean;
  mode: 'sandbox' | 'supabase';
  url?: string;
  anonKey?: string;
  companyId?: string;
  configurationError?: string;
}

export interface IntegrationHealthResult {
  overall: 'healthy' | 'not_configured' | 'degraded' | 'down';
  checkedAt: string;
  providers: Array<{
    id?: string;
    provider: string;
    capability: string;
    mode: string;
    status: 'healthy' | 'not_configured' | 'degraded' | 'down';
    checkedAt?: string;
    message?: string;
  }>;
}

export interface ApprovedActionExecutionResult {
  approvalId: string;
  actionId: string;
  toolName: string;
  status: 'succeeded';
  completedAt: string;
  replayed: boolean;
}

export interface DepositCheckoutResult {
  action: 'deposit.checkout';
  status: 'checkout_open' | 'not_required' | 'already_verified';
  mode: 'live' | 'sandbox' | 'none';
  quoteId: string;
  jobId: string;
  invoiceId: string;
  amount: string;
  currency: 'USD';
  paymentVerified: boolean;
  depositReady: boolean;
  replayed: boolean;
  checkoutId?: string;
  checkoutUrl?: string;
  sandboxReceipt?: string;
}

const postServiceStatusSchema = z
  .object({
    schemaVersion: z.literal('storyops-post-service-status-v1'),
    companyId: z.string().uuid(),
    serverTime: z.string(),
    followups: z.array(
      z
        .object({
          id: z.string().uuid(),
          invoiceId: z.string().uuid(),
          jobId: z.string().uuid(),
          customerId: z.string().uuid(),
          propertyId: z.string().uuid(),
          action: z.enum(['review.request', 'referral.invite', 'maintenance.reminder']),
          domainRecordId: z.string().uuid(),
          channel: z.enum(['sms', 'email']),
          status: z.enum([
            'queued',
            'submitted',
            'reconciliation_required',
            'submitted_unknown',
            'completed',
            'sandboxed',
            'failed',
            'cancelled',
          ]),
          scheduledAt: z.string(),
          providerMode: z.enum(['sandbox', 'live']).nullable().optional(),
          providerStatus: z
            .enum([
              'accepted',
              'queued',
              'sent',
              'delivered',
              'failed',
              'submission_unknown',
              'sandbox_recorded',
            ])
            .nullable()
            .optional(),
          manualReconciliationRequired: z.boolean(),
          externalDeliveryClaimed: z.boolean().optional(),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
    maintenancePlans: z.array(
      z
        .object({
          id: z.string().uuid(),
          invoiceId: z.string().uuid(),
          jobId: z.string().uuid(),
          customerId: z.string().uuid(),
          propertyId: z.string().uuid(),
          status: z.literal('active'),
          cadence: z.enum(['monthly', 'quarterly', 'semiannual', 'annual', 'custom']),
          nextDueDate: z.string(),
          serviceCodes: z.array(z.string().min(1)),
          requiresFreshEstimate: z.literal(true),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export type PostServiceActionInput =
  | {
      action: 'review.request' | 'referral.invite';
      invoiceId: string;
      expectedVersion: number;
      channel: 'sms' | 'email';
      commandId?: string;
    }
  | {
      action: 'maintenance.activate';
      invoiceId: string;
      expectedVersion: number;
      cadence: 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'custom';
      intervalDays?: number;
      nextDueDate: string;
      commandId?: string;
    };

export interface PostServiceActionResult {
  schemaVersion: 'storyops-post-service-v1';
  companyId: string;
  action: 'review.request' | 'referral.invite' | 'maintenance.activate';
  commandId: string;
  invoiceId: string;
  invoiceVersion: number;
  jobId: string;
  recordId: string;
  domainRecordId: string;
  status: 'queued' | 'completed' | 'failed' | 'cancelled' | 'active';
  replayed: boolean;
  alreadyExisted: boolean;
  requestHash: string;
  serverTime: string;
  channel?: 'sms' | 'email';
  scheduledAt?: string;
  cadence?: 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'custom';
  nextDueDate?: string;
  requiresFreshEstimate?: true;
}

type RepositoryError = { message: string };

export interface StoryOpsSupabaseAdapter {
  auth: {
    getSession(): Promise<{ data: { session: Session | null }; error: RepositoryError | null }>;
    signInWithOtp(input: {
      email: string;
      options: { emailRedirectTo: string };
    }): Promise<{ error: RepositoryError | null }>;
    signOut(): Promise<{ error: RepositoryError | null }>;
    onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
  };
  rpc(
    functionName: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RepositoryError | null }>;
  functions: {
    invoke(
      functionName: string,
      input: { body: Record<string, unknown> },
    ): Promise<{ data: unknown; error: RepositoryError | null }>;
  };
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Blob,
        options: { contentType: string; upsert: boolean },
      ): PromiseLike<{ data: { path: string } | null; error: RepositoryError | null }>;
      download(path: string): PromiseLike<{ data: Blob | null; error: RepositoryError | null }>;
      remove(paths: string[]): PromiseLike<{ error: RepositoryError | null }>;
    };
  };
}

function normalizeMode(value: string | undefined): 'sandbox' | 'supabase' {
  return value === 'supabase' || value === 'live' ? 'supabase' : 'sandbox';
}

function isClearlyPrivilegedKey(value: string): boolean {
  if (value.startsWith('sb_secret_')) return true;
  const payload = value.split('.')[1];
  if (!payload) return false;
  try {
    const normalized = payload.replaceAll('-', '+').replaceAll('_', '/');
    const decoded = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')),
    ) as UnknownRecord;
    return decoded.role === 'service_role';
  } catch {
    return false;
  }
}

type UnknownRecord = Record<string, unknown>;

export function readLiveRepositoryConfig(
  environment: Partial<ImportMetaEnv> = import.meta.env,
): LiveRepositoryConfig {
  const mode = normalizeMode(environment.VITE_STORYOPS_DATA_MODE);
  if (mode === 'sandbox') return { requested: false, mode };

  const url = environment.VITE_SUPABASE_URL?.trim();
  const anonKey = environment.VITE_SUPABASE_ANON_KEY?.trim();
  const companyId = environment.VITE_STORYOPS_COMPANY_ID?.trim();
  const missing = [
    !url && 'VITE_SUPABASE_URL',
    !anonKey && 'VITE_SUPABASE_ANON_KEY',
    !companyId && 'VITE_STORYOPS_COMPANY_ID',
  ].filter(Boolean);
  const invalid = [
    url && !z.string().url().safeParse(url).success && 'VITE_SUPABASE_URL must be an absolute URL',
    companyId &&
      !z.string().uuid().safeParse(companyId).success &&
      'VITE_STORYOPS_COMPANY_ID must be a UUID',
    anonKey &&
      isClearlyPrivilegedKey(anonKey) &&
      'VITE_SUPABASE_ANON_KEY appears to be a privileged secret/service-role key',
  ].filter(Boolean);

  return {
    requested: true,
    mode,
    url,
    anonKey,
    companyId,
    configurationError:
      missing.length > 0
        ? `Live mode requires ${missing.join(', ')}. Browser variables must use the public anon key, never a service-role key.`
        : invalid.length > 0
          ? `${invalid.join('. ')}. Browser variables must use the public anon key only.`
          : undefined,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Command payload cannot contain a non-finite number.');
  }
  return value;
}

export function canonicalCommandBody(
  commandType: StoryOpsCommandType | StoryOpsGoldenPathCommandType,
  expectedVersion: number,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify(canonicalize({ commandType, expectedVersion, payload }));
}

export async function sha256Hex(contents: string | ArrayBuffer): Promise<string> {
  const bytes =
    typeof contents === 'string' ? new TextEncoder().encode(contents) : new Uint8Array(contents);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function blobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const direct = (blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
  if (typeof direct === 'function') return direct.call(blob);
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('Blob reader did not return binary data.'));
    });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Blob read failed.')));
    reader.readAsArrayBuffer(blob);
  });
}

export async function buildStoryOpsCommand(input: {
  commandType: StoryOpsCommandType;
  expectedVersion: number;
  payload: Record<string, unknown>;
  commandId?: string;
}): Promise<StoryOpsCommand> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('Expected version must be a non-negative integer.');
  }
  const commandId = input.commandId ?? crypto.randomUUID();
  const payload = canonicalize(input.payload) as Record<string, unknown>;
  const requestHash = await sha256Hex(
    canonicalCommandBody(input.commandType, input.expectedVersion, payload),
  );
  return {
    commandId,
    commandType: input.commandType,
    expectedVersion: input.expectedVersion,
    payload,
    requestHash,
  };
}

export async function buildStoryOpsGoldenPathCommand(input: {
  commandType: StoryOpsGoldenPathCommandType;
  expectedVersion: number;
  payload: Record<string, unknown>;
  commandId?: string;
}): Promise<StoryOpsGoldenPathCommand> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error('Golden-path expected version must be a positive integer.');
  }
  const commandId = input.commandId ?? crypto.randomUUID();
  const payload = canonicalize(input.payload) as Record<string, unknown>;
  const requestHash = await sha256Hex(
    canonicalCommandBody(input.commandType, input.expectedVersion, payload),
  );
  return {
    commandId,
    commandType: input.commandType,
    expectedVersion: input.expectedVersion,
    payload,
    requestHash,
  };
}

function repositoryError(operation: string, error: RepositoryError): Error {
  return new Error(`${operation} failed: ${error.message}`);
}

function commandResult(value: unknown): StoryOpsCommandResult {
  return z
    .object({
      commandId: z.string().uuid(),
      commandType: z.string(),
      status: z.literal('applied'),
      replayed: z.boolean(),
      entityId: z.string().uuid(),
      version: z.number().int().positive(),
      requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
      serverTime: z.string(),
    })
    .transform((result) => result as StoryOpsCommandResult)
    .parse(value);
}

export class LiveStoryOpsRepository {
  constructor(
    private readonly client: StoryOpsSupabaseAdapter,
    readonly companyId: string,
  ) {}

  async getSession(): Promise<Session | null> {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw repositoryError('Session lookup', error);
    return data.session;
  }

  onAuthStateChange(callback: (session: Session | null) => void): () => void {
    const {
      data: { subscription },
    } = this.client.auth.onAuthStateChange((_event, session) => callback(session));
    return () => subscription.unsubscribe();
  }

  async requestMagicLink(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    if (!z.string().email().safeParse(normalized).success) {
      throw new Error('Enter a valid email address.');
    }
    const { error } = await this.client.auth.signInWithOtp({
      email: normalized,
      options: {
        emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
      },
    });
    if (error) throw repositoryError('Magic-link request', error);
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) throw repositoryError('Sign out', error);
  }

  async loadSetupState(): Promise<LiveSetupState> {
    const { data, error } = await this.client.rpc('get_storyops_setup_state', {
      p_company_id: this.companyId,
    });
    if (error) throw repositoryError('Setup-state load', error);
    const setupState = liveSetupStateSchema.parse(data);
    if (
      (setupState.companyId !== null && setupState.companyId !== this.companyId) ||
      (setupState.requestedCompanyId !== null && setupState.requestedCompanyId !== this.companyId)
    ) {
      throw new Error('Setup-state company identity did not match the configured company.');
    }
    return setupState;
  }

  async completeSetup(input: SandboxSetupInput): Promise<LiveSetupReceipt> {
    const normalized = canonicalLiveSetupPayload(input);
    const session = await this.getSession();
    if (!session) throw new Error('Authenticated setup requires a current session.');
    const commandId = await stableLiveSetupCommandId(session.user.id, this.companyId);
    const requestHash = await sha256Hex(
      JSON.stringify(
        canonicalize({
          schemaVersion: 'storyops-live-setup-request-v1',
          companyId: this.companyId,
          commandId,
          input: normalized,
        }),
      ),
    );
    const { data, error } = await this.client.rpc('complete_storyops_setup', {
      p_company_id: this.companyId,
      p_command_id: commandId,
      p_request_hash: requestHash,
      p_business_name: normalized.businessName,
      p_owner_name: normalized.ownerName,
      p_home_postal_code: normalized.homePostalCode,
      p_timezone: normalized.timezone,
      p_enabled_service_codes: normalized.enabledServiceCodes,
      p_policy_acknowledged: normalized.policyAcknowledged,
    });
    if (error) throw repositoryError('Company setup', error);
    const receipt = liveSetupReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== commandId ||
      receipt.requestHash !== requestHash
    ) {
      throw new Error('Setup receipt identity did not match the submitted request.');
    }
    return receipt;
  }

  async loadWorkspace(): Promise<LiveWorkspace> {
    const { data, error } = await this.client.rpc('get_storyops_workspace', {
      p_company_id: this.companyId,
    });
    if (error) throw repositoryError('Workspace load', error);
    const workspace = workspaceSchema.parse(data);
    if (workspace.session.companyId !== this.companyId || workspace.company.id !== this.companyId) {
      throw new Error('Workspace company identity did not match the requested company.');
    }
    let fieldReference: z.infer<typeof fieldReferenceSchema> = {
      materials: [],
      checklistDefinitions: [],
      fieldIncidents: [],
    };
    if (workspace.session.role !== 'customer') {
      const { data: fieldReferenceData, error: fieldReferenceError } = await this.client.rpc(
        'get_storyops_field_reference',
        { p_company_id: this.companyId },
      );
      if (fieldReferenceError) {
        throw repositoryError('Field safety reference load', fieldReferenceError);
      }
      fieldReference = fieldReferenceSchema.parse(fieldReferenceData);
    }
    let postService = { followups: [], maintenancePlans: [] } as Pick<
      z.infer<typeof postServiceStatusSchema>,
      'followups' | 'maintenancePlans'
    >;
    if (['owner', 'dispatcher', 'customer'].includes(workspace.session.role)) {
      const { data: postServiceData, error: postServiceError } = await this.client.rpc(
        'get_storyops_post_service_status',
        { p_company_id: this.companyId },
      );
      if (postServiceError) {
        throw repositoryError('Post-service status load', postServiceError);
      }
      const projection = postServiceStatusSchema.parse(postServiceData);
      if (projection.companyId !== this.companyId) {
        throw new Error('Post-service status company identity did not match the workspace.');
      }
      postService = projection;
    }
    return {
      ...workspace,
      ...fieldReference,
      postServiceFollowups: postService.followups,
      postServiceMaintenancePlans: postService.maintenancePlans,
    };
  }

  async executeCommand(command: StoryOpsCommand): Promise<StoryOpsCommandResult> {
    if (command.commandType === 'media.register') {
      throw new Error(
        'Media registration requires trusted Storage byte verification through finalizeVisitMedia.',
      );
    }
    const { data, error } = await this.client.rpc('execute_storyops_command', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_command_type: command.commandType,
      p_expected_version: command.expectedVersion,
      p_payload: command.payload,
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError(command.commandType, error);
    const result = commandResult(data);
    if (result.commandId !== command.commandId || result.commandType !== command.commandType) {
      throw new Error('Command receipt identity did not match the submitted command.');
    }
    return result;
  }

  async finalizeVisitMedia(command: StoryOpsCommand): Promise<StoryOpsCommandResult> {
    if (command.commandType !== 'media.register' || command.expectedVersion !== 0) {
      throw new Error('Media finalization requires an exact create-only media.register command.');
    }
    const { data, error } = await this.client.functions.invoke('field-media-finalize', {
      body: {
        companyId: this.companyId,
        command,
      },
    });
    if (error) throw repositoryError('Media finalization', error);
    const result = commandResult(data);
    if (
      result.commandId !== command.commandId ||
      result.commandType !== command.commandType ||
      result.requestHash !== command.requestHash
    ) {
      throw new Error('Media finalization receipt identity did not match the submitted command.');
    }
    return result;
  }

  async executeGoldenPathCommand(
    command: StoryOpsGoldenPathCommand,
  ): Promise<StoryOpsCommandResult> {
    const { data, error } = await this.client.rpc('execute_storyops_golden_path_command', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_command_type: command.commandType,
      p_expected_version: command.expectedVersion,
      p_payload: command.payload,
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError(command.commandType, error);
    const result = commandResult(data);
    if (result.commandId !== command.commandId || result.commandType !== command.commandType) {
      throw new Error('Golden-path receipt identity did not match the submitted command.');
    }
    return result;
  }

  async startDepositCheckout(input: {
    quoteId: string;
    quoteVersion: number;
    commandId?: string;
  }): Promise<DepositCheckoutResult> {
    const commandId = input.commandId ?? input.quoteId;
    if (
      !z.string().uuid().safeParse(input.quoteId).success ||
      !z.string().uuid().safeParse(commandId).success ||
      !Number.isInteger(input.quoteVersion) ||
      input.quoteVersion < 1
    ) {
      throw new Error('Deposit checkout requires a versioned quote and stable command ID.');
    }
    const { data, error } = await this.client.functions.invoke('golden-path', {
      body: {
        companyId: this.companyId,
        action: 'deposit.checkout',
        commandId,
        entityId: input.quoteId,
        expectedVersion: input.quoteVersion,
      },
    });
    if (error) throw repositoryError('Deposit checkout', error);
    return z
      .object({
        action: z.literal('deposit.checkout'),
        status: z.enum(['checkout_open', 'not_required', 'already_verified']),
        mode: z.enum(['live', 'sandbox', 'none']),
        quoteId: z.string().uuid(),
        jobId: z.string().uuid(),
        invoiceId: z.string().uuid(),
        amount: z.string().regex(/^\d+\.\d{2}$/u),
        currency: z.literal('USD'),
        paymentVerified: z.boolean(),
        depositReady: z.boolean(),
        replayed: z.boolean(),
        checkoutId: z.string().startsWith('cs_').optional(),
        checkoutUrl: z.string().url().optional(),
        sandboxReceipt: z.string().optional(),
      })
      .strict()
      .refine((result) => result.quoteId === input.quoteId, {
        message: 'Deposit checkout receipt quote did not match the request.',
      })
      .parse(data);
  }

  async executePostServiceAction(input: PostServiceActionInput): Promise<PostServiceActionResult> {
    const commandId = input.commandId ?? crypto.randomUUID();
    if (
      !z.string().uuid().safeParse(input.invoiceId).success ||
      !z.string().uuid().safeParse(commandId).success ||
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      throw new Error(
        'Post-service action requires a versioned paid invoice and stable command ID.',
      );
    }
    const { data, error } = await this.client.functions.invoke('post-service', {
      body: {
        companyId: this.companyId,
        ...input,
        commandId,
      },
    });
    if (error) throw repositoryError(input.action, error);
    const result = z
      .object({
        schemaVersion: z.literal('storyops-post-service-v1'),
        companyId: z.string().uuid(),
        action: z.enum(['review.request', 'referral.invite', 'maintenance.activate']),
        commandId: z.string().uuid(),
        invoiceId: z.string().uuid(),
        invoiceVersion: z.number().int().positive(),
        jobId: z.string().uuid(),
        recordId: z.string().uuid(),
        domainRecordId: z.string().uuid(),
        status: z.enum(['queued', 'completed', 'failed', 'cancelled', 'active']),
        replayed: z.boolean(),
        alreadyExisted: z.boolean(),
        requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
        serverTime: z.string(),
        channel: z.enum(['sms', 'email']).optional(),
        scheduledAt: z.string().optional(),
        cadence: z.enum(['monthly', 'quarterly', 'semiannual', 'annual', 'custom']).optional(),
        nextDueDate: z.string().optional(),
        requiresFreshEstimate: z.literal(true).optional(),
      })
      .strict()
      .parse(data) as PostServiceActionResult;
    if (
      result.companyId !== this.companyId ||
      result.commandId !== commandId ||
      result.action !== input.action ||
      result.invoiceId !== input.invoiceId ||
      result.invoiceVersion !== input.expectedVersion
    ) {
      throw new Error('Post-service receipt identity did not match the submitted action.');
    }
    return result;
  }

  async checkIntegrationHealth(): Promise<IntegrationHealthResult> {
    const { data, error } = await this.client.functions.invoke('integration-health', {
      body: { companyId: this.companyId },
    });
    if (error) throw repositoryError('Integration health check', error);
    return z
      .object({
        overall: z.enum(['healthy', 'not_configured', 'degraded', 'down']),
        checkedAt: z.string(),
        providers: z.array(
          z
            .object({
              id: z.string().optional(),
              provider: z.string(),
              capability: z.string(),
              mode: z.string(),
              status: z.enum(['healthy', 'not_configured', 'degraded', 'down']),
              checkedAt: z.string().optional(),
              message: z.string().optional(),
            })
            .passthrough(),
        ),
      })
      .parse(data);
  }

  async loadEstimateContext(propertyId?: string): Promise<LiveEstimateContext> {
    if (propertyId && !z.string().uuid().safeParse(propertyId).success) {
      throw new Error('Estimate context requires a valid property ID.');
    }
    const { data, error } = await this.client.functions.invoke('estimate-workflow', {
      body: {
        operation: 'context',
        companyId: this.companyId,
        propertyId,
      },
    });
    if (error) throw repositoryError('Estimate context', error);
    const context = liveEstimateContextSchema.parse(data);
    if (context.companyId !== this.companyId) {
      throw new Error('Estimate context company identity did not match the workspace.');
    }
    return context;
  }

  async calculateLiveEstimate(input: LiveEstimateRequest): Promise<LiveEstimateReceipt> {
    const { data, error } = await this.client.functions.invoke('estimate-workflow', {
      body: {
        operation: 'calculate',
        companyId: this.companyId,
        ...input,
      },
    });
    if (error) throw repositoryError('Estimate calculation', error);
    return liveEstimateReceiptSchema.parse(data);
  }

  async executeApprovedAction(approvalId: string): Promise<ApprovedActionExecutionResult> {
    if (!z.string().uuid().safeParse(approvalId).success) {
      throw new Error('Approved-action execution requires a valid approval ID.');
    }
    const { data, error } = await this.client.functions.invoke('ai-approved-action', {
      body: {
        companyId: this.companyId,
        approvalId,
        idempotencyKey: `approved:${approvalId}`,
      },
    });
    if (error) throw repositoryError('Approved-action execution', error);
    return z
      .object({
        approvalId: z.string().uuid(),
        actionId: z.string().min(1),
        toolName: z.string().min(1),
        status: z.literal('succeeded'),
        completedAt: z.string(),
        replayed: z.boolean().optional().default(false),
      })
      .refine((result) => result.approvalId === approvalId, {
        message: 'Approved-action receipt identity did not match the request.',
      })
      .parse(data);
  }

  async uploadVisitMedia(input: {
    visitId: string;
    assetId: string;
    blob: Blob;
    filename: string;
    contentType: string;
  }): Promise<{ objectPath: string; checksumSha256: string; byteSize: number }> {
    const prepared = await this.prepareVisitMedia(input);
    await this.uploadPreparedVisitMedia(prepared);
    return {
      objectPath: prepared.objectPath,
      checksumSha256: prepared.checksumSha256,
      byteSize: prepared.byteSize,
    };
  }

  async prepareVisitMedia(input: {
    visitId: string;
    assetId: string;
    blob: Blob;
    filename: string;
    contentType: string;
    capturedAt?: string;
  }): Promise<PreparedVisitMedia> {
    if (
      !z.string().uuid().safeParse(input.visitId).success ||
      !z.string().uuid().safeParse(input.assetId).success
    ) {
      throw new Error('Visit media requires stable visit and asset UUIDs.');
    }
    const contentType = z.enum(['image/jpeg', 'image/png', 'image/webp']).parse(input.contentType);
    if (input.blob.size < 1 || input.blob.size > 15 * 1024 * 1024) {
      throw new Error('Evidence files must be between 1 byte and 15 MB.');
    }
    const safeFilename =
      input.filename
        .normalize('NFKD')
        .replaceAll(/[^a-zA-Z0-9._-]/gu, '-')
        .replaceAll(/-+/gu, '-')
        .slice(-96) || 'evidence.bin';
    const checksumSha256 = await sha256Hex(await blobArrayBuffer(input.blob));
    const objectPath = `${this.companyId}/visits/${input.visitId}/${input.assetId}-${checksumSha256.slice(0, 16)}-${safeFilename}`;
    return {
      assetId: input.assetId,
      visitId: input.visitId,
      blob: input.blob.slice(0, input.blob.size, contentType),
      filename: safeFilename,
      contentType,
      objectPath,
      checksumSha256,
      byteSize: input.blob.size,
      capturedAt: input.capturedAt ?? new Date().toISOString(),
    };
  }

  async uploadPreparedVisitMedia(input: PreparedVisitMedia): Promise<void> {
    const expectedPrefix = `${this.companyId}/visits/${input.visitId}/${input.assetId}-`;
    if (
      !input.objectPath.startsWith(expectedPrefix) ||
      !input.objectPath.includes(input.checksumSha256.slice(0, 16))
    ) {
      throw new Error('Prepared media object identity does not match its company and visit scope.');
    }
    const localChecksum = await sha256Hex(await blobArrayBuffer(input.blob));
    if (
      localChecksum !== input.checksumSha256 ||
      input.blob.size !== input.byteSize ||
      input.blob.type !== input.contentType
    ) {
      throw new Error('Prepared media bytes no longer match their captured checksum metadata.');
    }
    const bucket = this.client.storage.from('job-media');
    const { error: uploadError } = await bucket.upload(input.objectPath, input.blob, {
      contentType: input.contentType,
      upsert: false,
    });
    const { data: durableBlob, error: downloadError } = await bucket.download(input.objectPath);
    if (downloadError || !durableBlob) {
      if (uploadError) throw repositoryError('Media upload', uploadError);
      throw repositoryError(
        'Media reconciliation',
        downloadError ?? { message: 'The uploaded object could not be read back.' },
      );
    }
    const durableChecksum = await sha256Hex(await blobArrayBuffer(durableBlob));
    if (durableBlob.size !== input.byteSize || durableChecksum !== input.checksumSha256) {
      throw new Error(
        'Durable media reconciliation failed because stored bytes do not match the local SHA-256 packet.',
      );
    }
  }

  async removeUploadedMedia(objectPath: string): Promise<void> {
    const { error } = await this.client.storage.from('job-media').remove([objectPath]);
    if (error) throw repositoryError('Media cleanup', error);
  }
}

let liveRepositorySingleton: LiveStoryOpsRepository | undefined;

export function getLiveStoryOpsRepository(
  config = readLiveRepositoryConfig(),
): LiveStoryOpsRepository | undefined {
  if (!config.requested || config.configurationError) return undefined;
  if (!config.url || !config.anonKey || !config.companyId) return undefined;
  if (!liveRepositorySingleton) {
    const client: SupabaseClient = createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    liveRepositorySingleton = new LiveStoryOpsRepository(
      client as unknown as StoryOpsSupabaseAdapter,
      config.companyId,
    );
  }
  return liveRepositorySingleton;
}

export function liveRole(workspace: LiveWorkspace): AppRole {
  return workspace.session.role;
}
