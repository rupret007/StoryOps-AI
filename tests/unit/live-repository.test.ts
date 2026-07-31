import { describe, expect, it, vi } from 'vitest';
import {
  buildStoryOpsCommand,
  buildStoryOpsGoldenPathCommand,
  canonicalCommandBody,
  classifyLiveRepositoryFailure,
  LiveRepositoryError,
  LiveStoryOpsRepository,
  mayUsePersistedLiveWorkspace,
  mutationOutcomeRequiresReconciliation,
  readLiveRepositoryConfig,
  sha256Hex,
  type StoryOpsSupabaseAdapter,
} from '@/state/liveRepository';
import { createLiveSetupRequiredState, mapLiveWorkspace } from '@/state/liveWorkspaceMapper';
import { makeLiveProfitabilityKpis } from '../fixtures/live-profitability';

const companyId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const leadId = '33333333-3333-4333-8333-333333333333';
const quoteId = '44444444-4444-4444-8444-444444444444';
const customerId = '55555555-5555-4555-8555-555555555555';
const propertyId = '66666666-6666-4666-8666-666666666666';
const jobId = '77777777-7777-4777-8777-777777777777';
const visitId = '88888888-8888-4888-8888-888888888888';
const schedulingReceiptId = '99999999-9999-4999-8999-999999999999';
const approvalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const materialId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sdsDocumentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function adapter(
  rpc: StoryOpsSupabaseAdapter['rpc'],
  invoke: StoryOpsSupabaseAdapter['functions']['invoke'] = vi.fn().mockResolvedValue({
    data: { overall: 'healthy', checkedAt: '2026-07-28T12:00:00Z', providers: [] },
    error: null,
  }),
): StoryOpsSupabaseAdapter {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
    rpc,
    functions: {
      invoke,
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'safe/path' }, error: null }),
        download: vi.fn().mockResolvedValue({
          data: new Blob(['durable']),
          error: null,
        }),
        remove: vi.fn().mockResolvedValue({ error: null }),
      }),
    },
  };
}

describe('live StoryOps repository', () => {
  it('uses a cached live workspace only for an explicit connectivity failure', () => {
    const revoked = new LiveRepositoryError(
      'Setup-state load',
      'P0001',
      undefined,
      'No active company membership.',
    );
    const forbidden = new LiveRepositoryError('Workspace load', '42501', 403, 'Permission denied.');
    const offline = new LiveRepositoryError(
      'Workspace load',
      undefined,
      undefined,
      'TypeError: Failed to fetch',
    );
    const malformed = new LiveRepositoryError(
      'Workspace load',
      'PGRST204',
      400,
      'The expected schema projection is unavailable.',
    );

    expect(classifyLiveRepositoryFailure(revoked)).toBe('authorization_revoked');
    expect(classifyLiveRepositoryFailure(forbidden)).toBe('authorization_revoked');
    expect(classifyLiveRepositoryFailure(offline)).toBe('connectivity_unavailable');
    expect(classifyLiveRepositoryFailure(malformed)).toBe('other');
    expect(mayUsePersistedLiveWorkspace(revoked)).toBe(false);
    expect(mayUsePersistedLiveWorkspace(forbidden)).toBe(false);
    expect(mayUsePersistedLiveWorkspace(offline)).toBe(true);
    expect(mayUsePersistedLiveWorkspace(malformed)).toBe(false);
    expect(mutationOutcomeRequiresReconciliation(offline)).toBe(true);
    expect(
      mutationOutcomeRequiresReconciliation(
        new LiveRepositoryError('Atomic intake', undefined, 500, 'Gateway failure'),
      ),
    ).toBe(true);
    expect(
      mutationOutcomeRequiresReconciliation(
        new LiveRepositoryError('Atomic intake', undefined, 429, 'Rate limited'),
      ),
    ).toBe(true);
    expect(mutationOutcomeRequiresReconciliation(new TypeError('Malformed receipt'))).toBe(true);
    expect(mutationOutcomeRequiresReconciliation(malformed)).toBe(false);
    expect(mutationOutcomeRequiresReconciliation(forbidden)).toBe(false);
  });

  it('keeps sandbox as the fail-safe default and reports incomplete live configuration', () => {
    expect(readLiveRepositoryConfig({})).toEqual({ requested: false, mode: 'sandbox' });
    expect(
      readLiveRepositoryConfig({
        VITE_STORYOPS_DATA_MODE: 'supabase',
        VITE_SUPABASE_URL: 'https://project.supabase.co',
      }).configurationError,
    ).toMatch(/VITE_SUPABASE_ANON_KEY.*VITE_STORYOPS_COMPANY_ID/u);
    expect(
      readLiveRepositoryConfig({
        VITE_STORYOPS_DATA_MODE: 'supabase',
        VITE_SUPABASE_URL: 'https://project.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'sb_secret_never-in-a-browser',
        VITE_STORYOPS_COMPANY_ID: companyId,
      }).configurationError,
    ).toMatch(/privileged secret/u);
  });

  it('propagates the Supabase auth event with the session boundary', () => {
    const supabase = adapter(vi.fn());
    const repository = new LiveStoryOpsRepository(supabase, companyId);
    const observer = vi.fn();

    const unsubscribe = repository.onAuthStateChange(observer);
    const providerObserver = vi.mocked(supabase.auth.onAuthStateChange).mock.calls[0]?.[0];
    expect(providerObserver).toBeDefined();

    providerObserver?.('SIGNED_OUT', null);

    expect(observer).toHaveBeenCalledWith('SIGNED_OUT', null);
    unsubscribe();
    const subscription = vi.mocked(supabase.auth.onAuthStateChange).mock.results[0]?.value.data
      .subscription;
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('loads setup scope and provisions through one stable authenticated RPC payload', async () => {
    const rpc = vi.fn((name: string, parameters: Record<string, unknown>) => {
      if (name === 'get_storyops_setup_state') {
        return Promise.resolve({
          data: {
            schemaVersion: 'storyops-setup-state-v1',
            status: 'required',
            userId,
            companyId: null,
            requestedCompanyId: companyId,
            role: null,
            setupComplete: false,
            requiresLaunchReview: true,
          },
          error: null,
        });
      }
      if (name === 'complete_storyops_setup') {
        return Promise.resolve({
          data: {
            schemaVersion: 'storyops-live-setup-v1',
            status: 'configured',
            companyId,
            role: 'owner',
            companyStatus: 'setup',
            setupComplete: true,
            requiresLaunchReview: true,
            replayed: false,
            commandId: parameters.p_command_id,
            requestHash: parameters.p_request_hash,
            serviceCount: 2,
            availableServiceCount: 5,
            integrationsDisabled: 11,
            serverTime: '2026-07-28T12:00:00Z',
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: 'Unexpected RPC' } });
    });
    const supabase = adapter(rpc);
    supabase.auth.getSession = vi.fn().mockResolvedValue({
      data: { session: { user: { id: userId } } as never },
      error: null,
    });
    const repository = new LiveStoryOpsRepository(supabase, companyId);

    const setupState = await repository.loadSetupState();
    expect(setupState).toMatchObject({
      status: 'required',
      requestedCompanyId: companyId,
      setupComplete: false,
    });
    expect(createLiveSetupRequiredState(setupState)).toMatchObject({
      dataMode: 'supabase',
      authStatus: 'signed_in',
      setupComplete: false,
      role: 'owner',
      live: { userId, companyId },
    });

    const input = {
      businessName: 'North Texas Exterior Care',
      ownerName: 'Dana Owner',
      homePostalCode: '76051',
      timezone: 'America/Chicago' as const,
      enabledServiceCodes: ['pressure-wash-flatwork', 'gutter-cleaning'] as const,
      policyAcknowledged: true as const,
    };
    await expect(
      repository.completeSetup({
        ...input,
        enabledServiceCodes: [...input.enabledServiceCodes],
      }),
    ).resolves.toMatchObject({
      companyId,
      companyStatus: 'setup',
      requiresLaunchReview: true,
    });
    await repository.completeSetup({
      ...input,
      enabledServiceCodes: [...input.enabledServiceCodes],
    });

    const setupCalls = rpc.mock.calls.filter(([name]) => name === 'complete_storyops_setup');
    expect(setupCalls).toHaveLength(2);
    expect(setupCalls[0]?.[1]).toMatchObject({
      p_company_id: companyId,
      p_business_name: 'North Texas Exterior Care',
      p_owner_name: 'Dana Owner',
      p_home_postal_code: '76051',
      p_timezone: 'America/Chicago',
      p_enabled_service_codes: ['gutter-cleaning', 'pressure-wash-flatwork'],
      p_policy_acknowledged: true,
    });
    expect(setupCalls[1]?.[1]?.p_command_id).toBe(setupCalls[0]?.[1]?.p_command_id);
    expect(setupCalls[1]?.[1]?.p_request_hash).toBe(setupCalls[0]?.[1]?.p_request_hash);
  });

  it('rejects a setup-state response for a different configured company', async () => {
    const repository = new LiveStoryOpsRepository(
      adapter(
        vi.fn().mockResolvedValue({
          data: {
            schemaVersion: 'storyops-setup-state-v1',
            status: 'required',
            userId,
            companyId: null,
            requestedCompanyId: '99999999-9999-4999-8999-999999999999',
            role: null,
            setupComplete: false,
            requiresLaunchReview: true,
          },
          error: null,
        }),
      ),
      companyId,
    );
    await expect(repository.loadSetupState()).rejects.toThrow(/company identity/iu);
  });

  it('executes an approved action through the exact server endpoint with a stable key', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: {
        approvalId,
        actionId: 'refund-action-1',
        toolName: 'payments.refund',
        status: 'succeeded',
        completedAt: '2026-07-28T12:00:00Z',
        replayed: false,
      },
      error: null,
    });
    const repository = new LiveStoryOpsRepository(
      adapter(vi.fn().mockResolvedValue({ data: null, error: null }), invoke),
      companyId,
    );

    await expect(repository.executeApprovedAction(approvalId)).resolves.toMatchObject({
      approvalId,
      toolName: 'payments.refund',
      status: 'succeeded',
    });
    expect(invoke).toHaveBeenCalledWith('ai-approved-action', {
      body: {
        companyId,
        approvalId,
        idempotencyKey: `approved:${approvalId}`,
      },
    });
  });

  it('canonicalizes command payloads and creates stable lowercase SHA-256 evidence', async () => {
    expect(
      canonicalCommandBody('lead.qualify', 3, {
        z: true,
        nested: { second: 2, first: 1 },
        a: 'value',
      }),
    ).toBe(
      '{"commandType":"lead.qualify","expectedVersion":3,"payload":{"a":"value","nested":{"first":1,"second":2},"z":true}}',
    );

    const commandId = '99999999-9999-4999-8999-999999999999';
    const first = await buildStoryOpsCommand({
      commandId,
      commandType: 'lead.qualify',
      expectedVersion: 3,
      payload: { entityId: leadId, status: 'qualified' },
    });
    const replay = await buildStoryOpsCommand({
      commandId,
      commandType: 'lead.qualify',
      expectedVersion: 3,
      payload: { status: 'qualified', entityId: leadId },
    });
    expect(first).toEqual(replay);
    expect(first.requestHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('creates only a guarded recurring fresh-estimate work item through the finite RPC', async () => {
    const recurringPlanId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd41';
    const recurringWorkItemId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd42';
    const commandId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd43';
    const requestHash = '00425fc0c980b37252ae1fb12026e08189b2681f8c08dfafc9ec89c16f29173b';
    const rpc = vi.fn((name: string, parameters: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          schemaVersion: 'storyops-recurring-due-work-receipt-v1',
          companyId,
          commandId,
          requestHash,
          workItemId: recurringWorkItemId,
          recurringPlanId,
          sourcePlanVersion: 3,
          planDueDate: '2026-07-29',
          status: 'fresh_estimate_required',
          freshEstimateRequired: true,
          historicalPriceCopied: false,
          estimateCreated: false,
          quoteAccepted: false,
          depositVerified: false,
          schedulingEvidenceVerified: false,
          visitCreated: false,
          customerContacted: false,
          bookingBoundary: 'job.book',
          alreadyExisted: false,
          replayed: false,
          serverTime: '2026-07-29T12:00:00Z',
        },
        error:
          name === 'create_storyops_recurring_due_work' && parameters.p_request_hash === requestHash
            ? null
            : { message: 'Unexpected recurring RPC' },
      }),
    );
    const supabase = adapter(rpc);
    supabase.auth.getSession = vi.fn().mockResolvedValue({
      data: { session: { user: { id: userId } } as never },
      error: null,
    });
    const repository = new LiveStoryOpsRepository(supabase, companyId);

    await expect(
      repository.createRecurringDueWork({
        planId: recurringPlanId,
        planVersion: 3,
        dueDate: '2026-07-29',
        commandId,
      }),
    ).resolves.toMatchObject({
      workItemId: recurringWorkItemId,
      freshEstimateRequired: true,
      estimateCreated: false,
      visitCreated: false,
      customerContacted: false,
      bookingBoundary: 'job.book',
    });
    expect(rpc).toHaveBeenCalledWith('create_storyops_recurring_due_work', {
      p_company_id: companyId,
      p_command_id: commandId,
      p_plan_id: recurringPlanId,
      p_expected_plan_version: 3,
      p_due_date: '2026-07-29',
      p_request_hash: requestHash,
    });
  });

  it('associates an exact newly persisted estimate without accepting later lifecycle claims', async () => {
    const workItemId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd42';
    const estimateId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd44';
    const commandId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd45';
    const requestHash = '7a036a211928da9e5025cd53d186958e8befb2cd231bccf2e3cbc82ec2534e4d';
    const rpc = vi.fn().mockResolvedValue({
      data: {
        schemaVersion: 'storyops-recurring-due-estimate-receipt-v1',
        companyId,
        commandId,
        requestHash,
        workItemId,
        workItemVersion: 2,
        estimateId,
        status: 'estimate_created',
        estimateCreated: true,
        historicalPriceCopied: false,
        quoteAccepted: false,
        depositVerified: false,
        schedulingEvidenceVerified: false,
        visitCreated: false,
        customerContacted: false,
        bookingBoundary: 'job.book',
        alreadyAttached: false,
        replayed: false,
        serverTime: '2026-07-29T12:00:00Z',
      },
      error: null,
    });
    const supabase = adapter(rpc);
    supabase.auth.getSession = vi.fn().mockResolvedValue({
      data: { session: { user: { id: userId } } as never },
      error: null,
    });
    const repository = new LiveStoryOpsRepository(supabase, companyId);

    await expect(
      repository.attachRecurringDueEstimate({
        workItemId,
        workItemVersion: 1,
        estimateId,
        commandId,
      }),
    ).resolves.toMatchObject({
      workItemVersion: 2,
      estimateId,
      estimateCreated: true,
      quoteAccepted: false,
      visitCreated: false,
    });
    expect(rpc).toHaveBeenCalledWith('attach_storyops_recurring_due_estimate', {
      p_company_id: companyId,
      p_command_id: commandId,
      p_work_item_id: workItemId,
      p_expected_work_item_version: 1,
      p_estimate_id: estimateId,
      p_request_hash: requestHash,
    });
  });

  it('queues transactional delivery without accepting a sent or delivered claim', async () => {
    const commandId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd31';
    const attemptId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd32';
    const rpc = vi.fn((name: string, parameters: Record<string, unknown>) => {
      expect(name).toBe('queue_storyops_transactional_delivery');
      return Promise.resolve({
        data: {
          schemaVersion: 'storyops-transactional-delivery-command-v1',
          companyId,
          commandId: parameters.p_command_id,
          requestHash: parameters.p_request_hash,
          attemptId,
          action: parameters.p_action_type,
          entityId: parameters.p_entity_id,
          entityVersion: parameters.p_expected_version,
          channel: parameters.p_channel,
          status: 'queued',
          portalPublicationAsserted: true,
          providerSubmissionAsserted: false,
          externalDeliveryClaimed: false,
          replayed: false,
          serverTime: '2026-07-29T12:00:00Z',
        },
        error: null,
      });
    });
    const repository = new LiveStoryOpsRepository(adapter(rpc), companyId);

    await expect(
      repository.queueTransactionalDelivery({
        action: 'quote.delivery',
        entityId: quoteId,
        entityVersion: 5,
        channel: 'email',
        commandId,
      }),
    ).resolves.toMatchObject({
      attemptId,
      status: 'queued',
      providerSubmissionAsserted: false,
      externalDeliveryClaimed: false,
    });
    expect(rpc).toHaveBeenCalledWith(
      'queue_storyops_transactional_delivery',
      expect.objectContaining({
        p_company_id: companyId,
        p_command_id: commandId,
        p_action_type: 'quote.delivery',
        p_entity_id: quoteId,
        p_expected_version: 5,
        p_channel: 'email',
        p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
  });

  it('prepares content-addressed media and requires a matching durable read-back', async () => {
    const bytes = new TextEncoder().encode('durable field evidence');
    const blob = new Blob([bytes], { type: 'image/png' });
    const upload = vi.fn().mockResolvedValue({ data: { path: 'safe/path' }, error: null });
    const download = vi.fn().mockResolvedValue({ data: blob, error: null });
    const testAdapter = adapter(vi.fn().mockResolvedValue({ data: null, error: null }));
    testAdapter.storage.from = vi.fn().mockReturnValue({
      upload,
      download,
      remove: vi.fn().mockResolvedValue({ error: null }),
    });
    const repository = new LiveStoryOpsRepository(testAdapter, companyId);
    const assetId = '99999999-9999-4999-8999-999999999991';

    const prepared = await repository.prepareVisitMedia({
      visitId,
      assetId,
      blob,
      filename: 'Before photo.png',
      contentType: 'image/png',
      capturedAt: '2026-07-28T12:00:00.000Z',
    });

    expect(prepared.objectPath).toMatch(
      new RegExp(
        `^${companyId}/visits/${visitId}/${assetId}-[a-f0-9]{16}-Before-photo\\.png$`,
        'u',
      ),
    );
    expect(prepared.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(repository.uploadPreparedVisitMedia(prepared)).resolves.toBeUndefined();
    expect(upload).toHaveBeenCalledWith(prepared.objectPath, prepared.blob, {
      contentType: 'image/png',
      upsert: false,
    });
    expect(download).toHaveBeenCalledWith(prepared.objectPath);
  });

  it('binds incident media bytes to one incident and visit path', async () => {
    const incidentId = '95000000-0000-4000-8000-000000000521';
    const blob = new Blob(['private incident evidence'], { type: 'image/jpeg' });
    const upload = vi.fn().mockResolvedValue({ data: { path: 'safe/path' }, error: null });
    const download = vi.fn().mockResolvedValue({ data: blob, error: null });
    const testAdapter = adapter(vi.fn().mockResolvedValue({ data: null, error: null }));
    testAdapter.storage.from = vi.fn().mockReturnValue({
      upload,
      download,
      remove: vi.fn().mockResolvedValue({ error: null }),
    });
    const repository = new LiveStoryOpsRepository(testAdapter, companyId);
    const incidentAssetId = '99999999-9999-4999-8999-999999999998';
    const prepared = await repository.prepareVisitMedia({
      visitId,
      assetId: incidentAssetId,
      incidentId,
      purpose: 'damage',
      blob,
      filename: 'damage.jpg',
      contentType: 'image/jpeg',
      capturedAt: '2026-01-01T12:00:00.000Z',
    });

    expect(prepared).toMatchObject({ incidentId, visitId, purpose: 'damage' });
    expect(prepared.objectPath).toMatch(
      new RegExp(
        `^${companyId}/incidents/${incidentId}/visits/${visitId}/${incidentAssetId}-[a-f0-9]{16}-damage\\.jpg$`,
        'u',
      ),
    );
    await expect(repository.uploadPreparedVisitMedia(prepared)).resolves.toBeUndefined();
    await expect(
      repository.uploadPreparedVisitMedia({
        ...prepared,
        incidentId: '95000000-0000-4000-8000-000000000522',
      }),
    ).rejects.toThrow(/company and visit scope/u);
    await expect(
      repository.prepareVisitMedia({
        visitId,
        assetId: incidentAssetId,
        purpose: 'incident',
        blob,
        filename: 'incident.jpg',
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow(/exact incident UUID/u);
  });

  it('reconciles an exact existing object after an ambiguous upload response and rejects drift', async () => {
    const blob = new Blob(['captured bytes'], { type: 'image/webp' });
    const upload = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'The resource already exists' },
    });
    const download = vi.fn().mockResolvedValue({ data: blob, error: null });
    const testAdapter = adapter(vi.fn().mockResolvedValue({ data: null, error: null }));
    testAdapter.storage.from = vi.fn().mockReturnValue({
      upload,
      download,
      remove: vi.fn().mockResolvedValue({ error: null }),
    });
    const repository = new LiveStoryOpsRepository(testAdapter, companyId);
    const prepared = await repository.prepareVisitMedia({
      visitId,
      assetId: '99999999-9999-4999-8999-999999999992',
      blob,
      filename: 'after.webp',
      contentType: 'image/webp',
    });

    await expect(repository.uploadPreparedVisitMedia(prepared)).resolves.toBeUndefined();
    download.mockResolvedValueOnce({
      data: new Blob(['different bytes'], { type: 'image/webp' }),
      error: null,
    });
    await expect(repository.uploadPreparedVisitMedia(prepared)).rejects.toThrow(
      /stored bytes do not match/u,
    );
  });

  it('routes media registration through the trusted finalizer and rejects direct RPC use', async () => {
    const command = await buildStoryOpsCommand({
      commandId: '99999999-9999-4999-8999-999999999993',
      commandType: 'media.register',
      expectedVersion: 0,
      payload: {
        entityId: '99999999-9999-4999-8999-999999999994',
        visitId,
      },
    });
    const invoke = vi.fn().mockResolvedValue({
      data: {
        commandId: command.commandId,
        commandType: command.commandType,
        status: 'applied',
        replayed: false,
        entityId: command.payload.entityId,
        version: 1,
        requestHash: command.requestHash,
        serverTime: '2026-07-28T12:00:00.000Z',
      },
      error: null,
    });
    const rpc = vi.fn();
    const repository = new LiveStoryOpsRepository(adapter(rpc, invoke), companyId);

    await expect(repository.executeCommand(command)).rejects.toThrow(/trusted Storage/u);
    await expect(repository.finalizeVisitMedia(command)).resolves.toMatchObject({
      commandId: command.commandId,
      requestHash: command.requestHash,
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('field-media-finalize', {
      body: { companyId, command },
    });
  });

  it('routes field change requests through the dedicated least-privilege RPC', async () => {
    const command = await buildStoryOpsCommand({
      commandId: '99999999-9999-4999-8999-999999999995',
      commandType: 'field.change_request',
      expectedVersion: 9,
      payload: {
        entityId: visitId,
        reasonCode: 'scope_mismatch',
        summary: 'The accepted gutter scope does not include the detached garage.',
      },
    });
    const rpc = vi.fn((name: string, parameters: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          commandId: parameters.p_command_id,
          commandType: command.commandType,
          status: 'applied',
          replayed: false,
          entityId: command.commandId,
          version: 1,
          requestHash: parameters.p_request_hash,
          serverTime: '2026-07-28T12:00:00.000Z',
        },
        error: name === 'submit_storyops_field_change_request' ? null : { message: 'Unexpected' },
      }),
    );
    const repository = new LiveStoryOpsRepository(adapter(rpc), companyId);

    await expect(repository.executeCommand(command)).resolves.toMatchObject({
      commandId: command.commandId,
      commandType: 'field.change_request',
      requestHash: command.requestHash,
    });
    expect(rpc).toHaveBeenCalledWith('submit_storyops_field_change_request', {
      p_company_id: companyId,
      p_command_id: command.commandId,
      p_expected_version: 9,
      p_payload: command.payload,
      p_request_hash: command.requestHash,
    });
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain('execute_storyops_command');
  });

  it('routes atomic incident stop-work through one exact receipt-validated RPC', async () => {
    const incidentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const command = await buildStoryOpsCommand({
      commandId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      commandType: 'incident.report_pause',
      expectedVersion: 9,
      payload: {
        schemaVersion: 'storyops-incident-pause-v1',
        action: 'incident.report_pause',
        actorUserId: userId,
        entityId: incidentId,
        incidentNumber: 'INC-DDDDDDDD',
        visitId,
        jobId,
        propertyId,
        severity: 'minor',
        category: 'property_damage',
        occurredAt: '2026-07-28T12:00:00.000Z',
        requestedAt: '2026-07-28T12:00:01.000Z',
        summary: 'A loose fixture fell beside the active work area.',
        immediateActions: 'Stopped work and isolated the affected area.',
        requiresLegalReview: false,
      },
    });
    const rpc = vi.fn((name: string, parameters: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          schemaVersion: 'storyops-incident-pause-receipt-v1',
          action: 'incident.report_pause',
          commandId: parameters.p_command_id,
          commandType: 'incident.report_pause',
          status: 'applied',
          companyId,
          actorUserId: userId,
          requestHash: parameters.p_request_hash,
          replayed: false,
          entityId: incidentId,
          version: 1,
          incident: {
            id: incidentId,
            incidentNumber: 'INC-DDDDDDDD',
            status: 'open',
            version: 1,
          },
          visit: {
            id: visitId,
            jobId,
            propertyId,
            previousStatus: 'on_site',
            currentStatus: 'paused',
            submittedExpectedVersion: 9,
            previousVersion: 11,
            currentVersion: 12,
          },
          stoppedTimeEntries: [
            {
              id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              previousVersion: 2,
              currentVersion: 3,
              endedAt: '2026-07-28T12:00:01.000Z',
            },
          ],
          serverTime: '2026-07-28T12:00:01.000Z',
        },
        error: name === 'report_storyops_incident_and_pause' ? null : { message: 'Unexpected RPC' },
      }),
    );
    const repository = new LiveStoryOpsRepository(adapter(rpc), companyId);

    await expect(repository.executeCommand(command)).resolves.toMatchObject({
      commandId: command.commandId,
      entityId: incidentId,
      requestHash: command.requestHash,
      visit: {
        submittedExpectedVersion: 9,
        previousVersion: 11,
        currentStatus: 'paused',
        currentVersion: 12,
      },
      stoppedTimeEntries: [{ currentVersion: 3 }],
    });
    expect(rpc).toHaveBeenCalledWith('report_storyops_incident_and_pause', {
      p_company_id: companyId,
      p_command_id: command.commandId,
      p_expected_visit_version: 9,
      p_payload: command.payload,
      p_request_hash: command.requestHash,
    });
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain('execute_storyops_command');
  });

  it('rejects an atomic incident receipt that escapes the submitted visit scope', async () => {
    const incidentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const command = await buildStoryOpsCommand({
      commandId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      commandType: 'incident.report_pause',
      expectedVersion: 9,
      payload: {
        schemaVersion: 'storyops-incident-pause-v1',
        action: 'incident.report_pause',
        actorUserId: userId,
        entityId: incidentId,
        incidentNumber: 'INC-DDDDDDDD',
        visitId,
        jobId,
        propertyId,
        severity: 'minor',
        category: 'other',
        occurredAt: '2026-07-28T12:00:00.000Z',
        requestedAt: '2026-07-28T12:00:01.000Z',
        summary: 'A direct observed safety fact with enough detail.',
        immediateActions: 'Stopped work and isolated the affected area.',
        requiresLegalReview: false,
      },
    });
    const rpc = vi.fn().mockResolvedValue({
      data: {
        schemaVersion: 'storyops-incident-pause-receipt-v1',
        action: 'incident.report_pause',
        commandId: command.commandId,
        commandType: 'incident.report_pause',
        status: 'applied',
        companyId,
        actorUserId: userId,
        requestHash: command.requestHash,
        replayed: false,
        entityId: incidentId,
        version: 1,
        incident: {
          id: incidentId,
          incidentNumber: 'INC-DDDDDDDD',
          status: 'open',
          version: 1,
        },
        visit: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          jobId,
          propertyId,
          previousStatus: 'on_site',
          currentStatus: 'paused',
          submittedExpectedVersion: 9,
          previousVersion: 9,
          currentVersion: 10,
        },
        stoppedTimeEntries: [],
        serverTime: '2026-07-28T12:00:01.000Z',
      },
      error: null,
    });
    const repository = new LiveStoryOpsRepository(adapter(rpc), companyId);

    await expect(repository.reportIncidentAndPause(command)).rejects.toThrow(
      /did not match the exact submitted stop-work request/u,
    );
  });

  it('checksum-verifies private SDS and customer evidence downloads', async () => {
    const bytes = 'durable verified evidence';
    const checksumSha256 = await sha256Hex(new TextEncoder().encode(bytes).buffer);
    const download = vi.fn().mockImplementation(() =>
      Promise.resolve({
        data: new Blob([bytes]),
        error: null,
      }),
    );
    const testAdapter = adapter(vi.fn());
    testAdapter.storage.from = vi.fn().mockReturnValue({
      upload: vi.fn(),
      download,
      remove: vi.fn(),
    });
    const repository = new LiveStoryOpsRepository(testAdapter, companyId);

    await expect(
      repository.downloadSdsDocument({
        id: sdsDocumentId,
        storageObjectPath: `${companyId}/approved-cleaner.pdf`,
        checksumSha256,
      }),
    ).resolves.toMatchObject({
      size: bytes.length,
      type: 'application/pdf',
    });
    await expect(
      repository.downloadCustomerEvidence({
        id: approvalId,
        visitId,
        jobId,
        objectPath: `${companyId}/visits/${visitId}/${approvalId}-before.jpg`,
        contentType: 'image/jpeg',
        byteSize: bytes.length,
        checksumSha256,
      }),
    ).resolves.toMatchObject({
      size: bytes.length,
      type: 'image/jpeg',
    });
    await expect(
      repository.downloadSdsDocument({
        id: sdsDocumentId,
        storageObjectPath: `${companyId}/approved-cleaner.pdf`,
        checksumSha256: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/did not match/u);
    await expect(
      repository.downloadCustomerEvidence({
        id: approvalId,
        visitId,
        jobId,
        objectPath: `other-company/visits/${visitId}/${approvalId}.jpg`,
        contentType: 'image/jpeg',
        byteSize: bytes.length,
        checksumSha256,
      }),
    ).rejects.toThrow(/outside the portal scope/u);
  });

  it('publishes an exact sorted completed-work selection through the dedicated RPC', async () => {
    const firstAssetId = '99999999-9999-4999-8999-999999999981';
    const secondAssetId = '99999999-9999-4999-8999-999999999982';
    const rpc = vi.fn((_name: string, parameters: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          schemaVersion: 'storyops-completed-work-publication-v1',
          companyId,
          commandId: parameters.p_command_id,
          visitId,
          assetIds: parameters.p_asset_ids,
          publishedCount: 2,
          requestHash: parameters.p_request_hash,
          replayed: false,
          serverTime: '2026-07-28T12:00:00.000Z',
        },
        error: null,
      }),
    );
    const repository = new LiveStoryOpsRepository(adapter(rpc), companyId);

    await expect(
      repository.publishCompletedWorkEvidence({
        commandId: '99999999-9999-4999-8999-999999999983',
        visitId,
        assetIds: [secondAssetId, firstAssetId],
      }),
    ).resolves.toMatchObject({ publishedCount: 2, replayed: false });
    expect(rpc).toHaveBeenCalledWith(
      'publish_storyops_completed_work_evidence',
      expect.objectContaining({
        p_company_id: companyId,
        p_visit_id: visitId,
        p_asset_ids: [firstAssetId, secondAssetId],
        p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
  });

  it('uses distinct finite contracts for booking and deposit checkout', async () => {
    const command = await buildStoryOpsGoldenPathCommand({
      commandId: jobId,
      commandType: 'job.book',
      expectedVersion: 3,
      payload: { entityId: jobId },
    });
    const invoke = vi.fn().mockResolvedValue({
      data: {
        action: 'deposit.checkout',
        status: 'checkout_open',
        mode: 'sandbox',
        quoteId,
        jobId,
        invoiceId: approvalId,
        amount: '62.50',
        currency: 'USD',
        paymentVerified: false,
        depositReady: false,
        replayed: false,
        checkoutId: 'cs_sandbox_repository',
        sandboxReceipt: 'No payment recorded.',
      },
      error: null,
    });
    const rpc = vi.fn((name: string, parameters: Record<string, unknown>) => {
      if (name === 'get_storyops_booking_candidate') {
        return Promise.resolve({
          data: {
            companyId,
            jobId,
            jobVersion: 3,
            schedulingEvidenceReceiptId: schedulingReceiptId,
            expiresAt: '2099-07-28T12:00:00Z',
            evidenceHash: 'e'.repeat(64),
          },
          error: null,
        });
      }
      return Promise.resolve({
        data: {
          commandId: command.commandId,
          commandType: command.commandType,
          status: 'applied',
          replayed: false,
          entityId: visitId,
          version: 1,
          requestHash: parameters.p_request_hash,
          serverTime: '2026-07-28T12:00:00Z',
        },
        error: null,
      });
    });
    const repository = new LiveStoryOpsRepository(adapter(rpc, invoke), companyId);

    await expect(repository.executeGoldenPathCommand(command)).resolves.toMatchObject({
      commandType: 'job.book',
      entityId: visitId,
    });
    await expect(
      repository.startDepositCheckout({ quoteId, quoteVersion: 5 }),
    ).resolves.toMatchObject({
      status: 'checkout_open',
      paymentVerified: false,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, 'get_storyops_booking_candidate', {
      p_company_id: companyId,
      p_job_id: jobId,
      p_job_version: 3,
    });
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      'execute_storyops_golden_path_command',
      expect.objectContaining({
        p_company_id: companyId,
        p_command_id: jobId,
        p_command_type: 'job.book',
        p_expected_version: 3,
        p_payload: {
          entityId: jobId,
          schedulingEvidenceReceiptId: schedulingReceiptId,
        },
        p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    expect(invoke).toHaveBeenCalledWith('golden-path', {
      body: {
        companyId,
        action: 'deposit.checkout',
        commandId: quoteId,
        entityId: quoteId,
        expectedVersion: 5,
      },
    });
  });

  it('submits quote changes as scope-only evidence and invoice checkout by exact identity', async () => {
    const quoteCommandId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01';
    const invoiceCommandId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02';
    const invoiceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd03';
    const changeRequestId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd04';
    const rpc = vi.fn((name: string, parameters: Record<string, unknown>) => {
      if (name !== 'execute_customer_quote_action') {
        return Promise.resolve({ data: null, error: { message: 'Unexpected RPC' } });
      }
      return Promise.resolve({
        data: {
          schemaVersion: 'storyops-customer-quote-action-v1',
          companyId,
          customerId,
          commandId: parameters.p_command_id,
          action: parameters.p_action,
          requestHash: parameters.p_request_hash,
          quoteId,
          quoteVersion: 6,
          quoteStatus: 'change_requested',
          priceChanged: false,
          termsChanged: false,
          accepted: false,
          deliveryAsserted: false,
          replayed: false,
          serverTime: '2026-07-28T12:00:00Z',
          changeRequestId,
        },
        error: null,
      });
    });
    const invoke = vi.fn().mockResolvedValue({
      data: {
        action: 'invoice.checkout',
        status: 'checkout_open',
        mode: 'sandbox',
        quoteId,
        jobId,
        invoiceId,
        invoiceVersion: 4,
        amount: '396.00',
        currency: 'USD',
        paymentVerified: false,
        invoicePaid: false,
        replayed: false,
        checkoutId: 'cs_sandbox_invoice_repository',
        sandboxReceipt: 'Sandbox only. No funds moved.',
      },
      error: null,
    });
    const repository = new LiveStoryOpsRepository(adapter(rpc, invoke), companyId);

    await expect(
      repository.executeCustomerQuoteAction({
        customerId,
        quoteId,
        quoteVersion: 5,
        action: 'quote.change_request',
        requestedServiceCodes: ['soft-wash-house', 'gutter-cleaning', 'soft-wash-house'],
        requestedAddOnCodes: ['gutter-cleaning:downspout-flush'],
        notes: '  Please add the detached garage.  ',
        commandId: quoteCommandId,
      }),
    ).resolves.toMatchObject({
      quoteStatus: 'change_requested',
      priceChanged: false,
      termsChanged: false,
      accepted: false,
      deliveryAsserted: false,
    });
    const quoteParameters = rpc.mock.calls[0]?.[1];
    expect(quoteParameters).toMatchObject({
      p_company_id: companyId,
      p_customer_id: customerId,
      p_command_id: quoteCommandId,
      p_action: 'quote.change_request',
      p_quote_id: quoteId,
      p_expected_quote_version: 5,
      p_requested_service_codes: ['gutter-cleaning', 'soft-wash-house'],
      p_requested_add_on_codes: ['gutter-cleaning:downspout-flush'],
      p_request_notes: 'Please add the detached garage.',
      p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(String(quoteParameters?.p_canonical_request)).not.toMatch(
      /price|total|deposit|discount/iu,
    );

    await expect(
      repository.startInvoiceCheckout({
        invoiceId,
        invoiceVersion: 4,
        commandId: invoiceCommandId,
      }),
    ).resolves.toMatchObject({
      invoiceId,
      invoiceVersion: 4,
      amount: '396.00',
      paymentVerified: false,
      invoicePaid: false,
    });
    expect(invoke).toHaveBeenCalledWith('golden-path', {
      body: {
        companyId,
        action: 'invoice.checkout',
        commandId: invoiceCommandId,
        entityId: invoiceId,
        expectedVersion: 4,
      },
    });
  });

  it('accepts a quote only through the affirmative exact-context RPC', async () => {
    const commandId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd05';
    const rpc = vi.fn((_name: string, parameters: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          schemaVersion: 'storyops-customer-quote-acceptance-v1',
          companyId,
          customerId,
          commandId: parameters.p_command_id,
          requestHash: parameters.p_request_hash,
          quoteId,
          expectedQuoteVersion: 5,
          quoteVersion: 6,
          termsVersion: 'terms-v2026.07',
          total: '614.17',
          signerName: 'Morgan Customer',
          acknowledged: true,
          acceptedAt: '2026-07-28T12:00:00Z',
          acceptanceContextHash: 'b'.repeat(64),
          replayed: false,
          serverTime: '2026-07-28T12:00:00Z',
        },
        error: null,
      }),
    );
    const repository = new LiveStoryOpsRepository(adapter(rpc), companyId);

    await expect(
      repository.acceptCustomerQuote({
        customerId,
        quoteId,
        quoteVersion: 5,
        signerName: '  Morgan Customer  ',
        acknowledged: true,
        termsVersion: 'terms-v2026.07',
        total: '614.17',
        commandId,
      }),
    ).resolves.toMatchObject({
      signerName: 'Morgan Customer',
      acknowledged: true,
      total: '614.17',
    });
    expect(rpc).toHaveBeenCalledWith(
      'accept_customer_quote',
      expect.objectContaining({
        p_company_id: companyId,
        p_customer_id: customerId,
        p_command_id: commandId,
        p_quote_id: quoteId,
        p_expected_quote_version: 5,
        p_signer_name: 'Morgan Customer',
        p_acknowledged: true,
        p_terms_version: 'terms-v2026.07',
        p_total: '614.17',
        p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    const canonical = JSON.parse(String(rpc.mock.calls[0]?.[1]?.p_canonical_request));
    expect(canonical).toEqual({
      action: 'quote.accept',
      payload: {
        acknowledged: true,
        customerId,
        quoteId,
        quoteVersion: 5,
        signerName: 'Morgan Customer',
        termsVersion: 'terms-v2026.07',
        total: '614.17',
      },
    });

    await expect(
      repository.acceptCustomerQuote({
        customerId,
        quoteId,
        quoteVersion: 5,
        signerName: 'Morgan Customer',
        acknowledged: false,
        termsVersion: 'terms-v2026.07',
        total: '614.17',
      }),
    ).rejects.toThrow(/typed signer, affirmative acknowledgment/u);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('applies verified funds only through the exact owner-approved allocation RPC', async () => {
    const conflictId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd20';
    const paymentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd21';
    const invoiceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd22';
    const resolutionApprovalId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd23';
    const rpc = vi.fn((name: string) => {
      if (name !== 'resolve_storyops_payment_allocation') {
        return Promise.resolve({ data: null, error: { message: 'Unexpected RPC' } });
      }
      return Promise.resolve({
        data: {
          schemaVersion: 'storyops-payment-allocation-resolution-v1',
          status: 'applied',
          companyId,
          conflictId,
          conflictVersion: 3,
          paymentId,
          paymentVersion: 7,
          invoiceId,
          invoiceVersion: 6,
          approvalRequestId: resolutionApprovalId,
          amount: '396.00',
          serverTime: '2026-07-28T12:00:00Z',
        },
        error: null,
      });
    });
    const repository = new LiveStoryOpsRepository(adapter(rpc), companyId);

    await expect(
      repository.resolvePaymentAllocation({
        conflictId,
        conflictVersion: 2,
        invoiceId,
        invoiceVersion: 5,
        approvalRequestId: resolutionApprovalId,
        resolutionNote: '  Matched the signed Stripe charge to the current invoice balance.  ',
      }),
    ).resolves.toMatchObject({
      companyId,
      conflictId,
      conflictVersion: 3,
      invoiceId,
      invoiceVersion: 6,
      amount: '396.00',
    });
    expect(rpc).toHaveBeenCalledWith('resolve_storyops_payment_allocation', {
      p_company_id: companyId,
      p_conflict_id: conflictId,
      p_approval_request_id: resolutionApprovalId,
      p_expected_conflict_version: 2,
      p_expected_invoice_version: 5,
      p_resolution_note: 'Matched the signed Stripe charge to the current invoice balance.',
    });
    await expect(
      repository.resolvePaymentAllocation({
        conflictId,
        conflictVersion: 2,
        invoiceId,
        invoiceVersion: 5,
        approvalRequestId: resolutionApprovalId,
        resolutionNote: 'no',
      }),
    ).rejects.toThrow(/5–2,000/u);
  });

  it('executes a strict invoice-scoped post-service action without delivery claims', async () => {
    const commandId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const followupId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const invoke = vi.fn().mockResolvedValue({
      data: {
        schemaVersion: 'storyops-post-service-v1',
        companyId,
        action: 'review.request',
        commandId,
        invoiceId: approvalId,
        invoiceVersion: 4,
        jobId,
        recordId: followupId,
        domainRecordId: followupId,
        status: 'queued',
        channel: 'email',
        scheduledAt: '2026-07-28T14:00:00Z',
        replayed: false,
        alreadyExisted: false,
        requestHash: 'a'.repeat(64),
        serverTime: '2026-07-28T12:00:00Z',
      },
      error: null,
    });
    const repository = new LiveStoryOpsRepository(
      adapter(vi.fn().mockResolvedValue({ data: null, error: null }), invoke),
      companyId,
    );

    await expect(
      repository.executePostServiceAction({
        action: 'review.request',
        invoiceId: approvalId,
        expectedVersion: 4,
        channel: 'email',
        commandId,
      }),
    ).resolves.toMatchObject({
      status: 'queued',
      replayed: false,
      domainRecordId: followupId,
    });
    expect(invoke).toHaveBeenCalledWith('post-service', {
      body: {
        companyId,
        action: 'review.request',
        invoiceId: approvalId,
        expectedVersion: 4,
        channel: 'email',
        commandId,
      },
    });
  });

  it('calls only the authenticated workspace and normalized command RPC contracts', async () => {
    const command = await buildStoryOpsCommand({
      commandId: '99999999-9999-4999-8999-999999999999',
      commandType: 'lead.qualify',
      expectedVersion: 3,
      payload: { entityId: leadId, status: 'qualified' },
    });
    const workspace = {
      schemaVersion: 'storyops-workspace-v1',
      serverTime: '2026-07-28T12:00:00Z',
      session: { userId, companyId, role: 'owner' },
      company: {
        id: companyId,
        name: 'Story Exterior Care',
        timezone: 'America/Chicago',
        currency: 'USD',
        status: 'active',
        settings: {},
        version: 1,
      },
      leads: [],
    };
    const rpc = vi.fn((name: string) =>
      Promise.resolve(
        name === 'get_storyops_workspace'
          ? { data: workspace, error: null }
          : name === 'get_storyops_field_reference'
            ? {
                data: {
                  materials: [],
                  checklistDefinitions: [],
                  fieldIncidents: [],
                },
                error: null,
              }
            : name === 'get_storyops_post_service_status'
              ? {
                  data: {
                    schemaVersion: 'storyops-post-service-status-v1',
                    companyId,
                    serverTime: '2026-07-28T12:00:00Z',
                    followups: [
                      {
                        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                        invoiceId: approvalId,
                        jobId,
                        customerId,
                        propertyId,
                        action: 'review.request',
                        domainRecordId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                        channel: 'sms',
                        status: 'submitted_unknown',
                        scheduledAt: '2026-07-28T12:00:00Z',
                        providerMode: 'live',
                        providerStatus: 'submission_unknown',
                        manualReconciliationRequired: true,
                        externalDeliveryClaimed: false,
                        version: 1,
                      },
                    ],
                    maintenancePlans: [],
                  },
                  error: null,
                }
              : name === 'get_storyops_recurring_due_work'
                ? {
                    data: {
                      schemaVersion: 'storyops-recurring-due-work-state-v1',
                      companyId,
                      role: 'owner',
                      localDate: '2026-07-28',
                      plans: [],
                      workItems: [],
                      guardrails: {
                        historicalPriceCopied: false,
                        estimateCreated: false,
                        quoteAccepted: false,
                        depositVerified: false,
                        availabilityVerified: false,
                        visitCreated: false,
                        customerContacted: false,
                        requiredSequence: [
                          'fresh_deterministic_estimate',
                          'policy_approval_if_required',
                          'quote_acceptance',
                          'deposit_verification_if_required',
                          'live_scheduling_evidence',
                          'job.book',
                        ],
                      },
                      serverTime: '2026-07-28T12:00:00Z',
                    },
                    error: null,
                  }
                : name === 'get_storyops_provider_launch_state'
                  ? {
                      data: {
                        schemaVersion: 'storyops-provider-launch-state-v1',
                        companyId,
                        role: 'owner',
                        connections: [],
                        schedulingGate: null,
                        launch: {
                          version: 7,
                          status: 'authorized',
                          launchAuthorized: true,
                          configurationRevision: 4,
                          configurationHash: 'a'.repeat(64),
                          baselineId: '33333333-3333-4333-8333-333333333333',
                          baselineHash: 'b'.repeat(64),
                          providerSnapshotHash: 'c'.repeat(64),
                          proofSnapshotHash: 'd'.repeat(64),
                          reviewReference: 'pilot-review-20260730',
                          occurredAt: '2026-07-28T12:00:00Z',
                        },
                        serverTime: '2026-07-28T12:00:00Z',
                      },
                      error: null,
                    }
                  : name === 'get_storyops_profitability_kpis'
                    ? { data: makeLiveProfitabilityKpis(companyId), error: null }
                    : name === 'get_storyops_ai_office_recent'
                      ? {
                          data: {
                            schemaVersion: 'storyops-ai-office-recent-v1',
                            companyId,
                            actorUserId: userId,
                            manualTriggeredOnly: true,
                            schedulerConfigured: false,
                            runs: [],
                            asOf: '2026-07-28T12:00:00Z',
                          },
                          error: null,
                        }
                      : name === 'get_storyops_audit_feed'
                        ? {
                            data: {
                              schemaVersion: 'storyops-audit-feed-v1',
                              companyId,
                              events: [],
                              hasMore: false,
                              nextCursor: null,
                              pageLimit: 50,
                              redacted: true,
                              serverTime: '2026-07-28T12:00:00Z',
                            },
                            error: null,
                          }
                        : name === 'get_company_configuration_state'
                          ? { data: null, error: null }
                          : name === 'get_company_operating_baseline_state'
                            ? {
                                data: {
                                  schemaVersion: 'storyops-operating-baseline-state-v1',
                                  status: 'active',
                                  companyId,
                                  configurationRevision: 4,
                                  configurationHash: 'a'.repeat(64),
                                  baselineId: '33333333-3333-4333-8333-333333333333',
                                  baselineHash: 'b'.repeat(64),
                                  priceBookId: '44444444-4444-4444-8444-444444444444',
                                  serviceTermsId: '55555555-5555-4555-8555-555555555555',
                                  retentionPolicyId: '66666666-6666-4666-8666-666666666666',
                                  reviewReference: 'owner-operating-review',
                                  activatedAt: '2026-07-28T11:00:00Z',
                                  providersActivated: false,
                                  outboundEnabled: false,
                                  launchAuthorized: true,
                                  launchVersion: 7,
                                  launchStatus: 'authorized',
                                  launchProviderSnapshotHash: 'c'.repeat(64),
                                  launchProofSnapshotHash: 'd'.repeat(64),
                                },
                                error: null,
                              }
                            : name === 'get_storyops_pilot_release_evidence'
                              ? {
                                  data: {
                                    schemaVersion: 'storyops-pilot-evidence-state-v1',
                                    companyId,
                                    records: [],
                                    serverTime: '2026-07-28T12:00:00Z',
                                  },
                                  error: null,
                                }
                              : {
                                  data: {
                                    commandId: command.commandId,
                                    commandType: command.commandType,
                                    status: 'applied',
                                    replayed: false,
                                    entityId: leadId,
                                    version: 4,
                                    requestHash: command.requestHash,
                                    serverTime: '2026-07-28T12:00:01Z',
                                  },
                                  error: null,
                                },
      ),
    );
    const repository = new LiveStoryOpsRepository(adapter(rpc), companyId);

    await expect(repository.loadWorkspace()).resolves.toMatchObject({
      schemaVersion: 'storyops-workspace-v1',
      session: { role: 'owner' },
      postServiceFollowups: [
        {
          status: 'submitted_unknown',
          providerStatus: 'submission_unknown',
          manualReconciliationRequired: true,
          externalDeliveryClaimed: false,
        },
      ],
      profitabilityKpis: {
        schemaVersion: 'storyops-profitability-kpis-v1',
        companyId,
      },
      providerLaunch: {
        launch: { version: 7, status: 'authorized', launchAuthorized: true },
      },
      operatingBaseline: {
        launchAuthorized: true,
        launchVersion: 7,
        launchStatus: 'authorized',
      },
    });
    await expect(repository.executeCommand(command)).resolves.toMatchObject({
      commandId: command.commandId,
      version: 4,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, 'get_storyops_workspace', {
      p_company_id: companyId,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'get_storyops_field_reference', {
      p_company_id: companyId,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, 'get_storyops_post_service_status', {
      p_company_id: companyId,
    });
    expect(rpc).toHaveBeenNthCalledWith(4, 'get_storyops_recurring_due_work', {
      p_company_id: companyId,
    });
    expect(rpc).toHaveBeenNthCalledWith(5, 'get_storyops_provider_launch_state', {
      p_company_id: companyId,
    });
    expect(rpc).toHaveBeenNthCalledWith(6, 'get_storyops_profitability_kpis', {
      p_company_id: companyId,
    });
    expect(rpc).toHaveBeenNthCalledWith(7, 'get_storyops_ai_office_recent', {
      p_company_id: companyId,
      p_limit: 10,
    });
    expect(rpc).toHaveBeenNthCalledWith(8, 'get_storyops_audit_feed', {
      p_company_id: companyId,
      p_before_occurred_at: null,
      p_before_id: null,
      p_limit: 50,
    });
    expect(rpc).toHaveBeenNthCalledWith(9, 'get_company_configuration_state', {
      p_company_id: companyId,
    });
    expect(rpc).toHaveBeenNthCalledWith(10, 'get_company_operating_baseline_state', {
      p_company_id: companyId,
    });
    expect(rpc).toHaveBeenNthCalledWith(11, 'get_storyops_pilot_release_evidence', {
      p_company_id: companyId,
    });
    expect(rpc).toHaveBeenNthCalledWith(12, 'execute_storyops_command', {
      p_company_id: companyId,
      p_command_id: command.commandId,
      p_command_type: command.commandType,
      p_expected_version: 3,
      p_payload: command.payload,
      p_request_hash: command.requestHash,
    });
  });

  it('maps a server role and entity versions without retaining sandbox records', () => {
    const state = mapLiveWorkspace({
      schemaVersion: 'storyops-workspace-v1',
      serverTime: '2026-07-28T12:00:00Z',
      session: { userId, companyId, role: 'technician' },
      company: {
        id: companyId,
        name: 'Live Exterior Co',
        timezone: 'America/Chicago',
        currency: 'USD',
        status: 'active',
        settings: {},
        version: 1,
      },
      leads: [
        {
          id: leadId,
          version: 7,
          display_name: 'Verified Lead',
          source: 'phone',
          status: 'qualified',
          requested_services: ['gutter_clean'],
        },
      ],
      customers: [{ id: customerId, displayName: 'A Customer', phone: '555-0100' }],
      properties: [
        {
          id: propertyId,
          customerId,
          serviceAddress: {
            line1: '100 Main Street',
            city: 'Grapevine',
            region: 'TX',
            postalCode: '76051',
          },
          version: 2,
        },
      ],
      quotes: [
        {
          id: quoteId,
          quoteNumber: 'Q-1',
          status: 'sent',
          total: '250.00',
          depositRequired: '62.50',
          version: 5,
        },
      ],
      jobs: [
        {
          id: jobId,
          jobNumber: 'JOB-1',
          customerId,
          propertyId,
          serviceCodes: ['gutter_clean'],
          version: 3,
        },
      ],
      visits: [
        {
          id: visitId,
          jobId,
          status: 'confirmed',
          startsAt: '2026-07-31T14:00:00Z',
          endsAt: '2026-07-31T16:00:00Z',
          version: 9,
        },
      ],
      checklistItems: [
        {
          id: approvalId,
          visitId,
          templateItemId: leadId,
          status: 'pending',
          version: 2,
        },
      ],
      checklistDefinitions: [
        {
          id: leadId,
          templateId: quoteId,
          label: 'Review stop-work conditions',
          itemKind: 'boolean',
          required: true,
          safetyCritical: true,
          sortOrder: 10,
        },
      ],
      timeEntries: [],
      materialUsage: [],
      media: [],
      completionSignatures: [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          visitId,
          signerName: 'A Customer',
          signerRole: 'customer',
          signedAt: '2026-07-28T12:00:00Z',
          signatureAssetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          disclosureVersion: 'completion-v1',
        },
      ],
      materials: [
        {
          id: materialId,
          name: 'Reference-only cleaner',
          unit: 'gal',
          requiresSds: true,
          version: 4,
          sdsDocument: {
            id: sdsDocumentId,
            productName: 'Reference-only cleaner',
            manufacturer: 'Example Manufacturer',
            revisionDate: '2026-06-01',
            reviewedAt: '2026-07-01T12:00:00Z',
            checksumSha256: 'a'.repeat(64),
            storageObjectPath: `${companyId}/reference-only.pdf`,
            version: 3,
          },
        },
      ],
      fieldPackets: [
        {
          visitId,
          visitVersion: 9,
          jobId,
          jobNumber: 'JOB-1',
          quoteId,
          propertyId,
          scopeLines: [
            {
              id: approvalId,
              lineKind: 'service',
              serviceCode: 'gutter_clean',
              addOnCode: null,
              description: 'Gutter and downspout cleaning',
              quantity: '180.00',
              unit: 'linear_ft',
              sortOrder: 1,
            },
          ],
          exclusions: [],
          exclusionsStatus: 'not_recorded',
          access: {
            instructions: 'Use the east gate.',
            waterSourceNotes: null,
            drainageNotes: 'Keep runoff away from the inlet.',
            knownHazards: ['Low utility line'],
          },
          routeEvidence: {
            id: schedulingReceiptId,
            provider: 'vroom',
            evidenceMode: 'live',
            checkedAt: '2026-07-28T11:50:00Z',
            driveMinutes: 24,
            distanceMiles: '12.50',
            routeFeasible: true,
            violations: [],
            freshness: 'current',
          },
          weatherEvidence: {
            id: '99999999-9999-4999-8999-999999999991',
            provider: 'nws',
            evidenceMode: 'live',
            forecastIssuedAt: '2026-07-28T11:00:00Z',
            checkedAt: '2026-07-28T11:50:00Z',
            periodStartsAt: '2026-07-28T11:00:00Z',
            periodEndsAt: '2026-07-28T15:00:00Z',
            temperatureF: '86.00',
            precipitationProbability: '0.1200',
            windSpeedMph: '8.00',
            lightningRisk: 'none',
            conditionCodes: ['clear'],
            policyDisposition: 'eligible',
            freshness: 'current',
          },
          evidence: [],
          changeRequests: [],
        },
      ],
      fieldIncidents: [
        {
          id: sdsDocumentId,
          visitId,
          jobId,
          incidentNumber: 'INC-1',
          severity: 'minor',
          status: 'investigating',
          category: 'other',
          reportedAt: '2026-07-28T12:00:00Z',
          summary: 'A factual field observation.',
          version: 6,
        },
      ],
      equipment: [],
    });

    expect(state.dataMode).toBe('supabase');
    expect(state.role).toBe('technician');
    expect(state.live?.companyName).toBe('Live Exterior Co');
    expect(state.live?.quote).toEqual({ id: quoteId, version: 5 });
    expect(state.live?.visit).toEqual({ id: visitId, version: 9 });
    expect(state.live?.job).toEqual({ id: jobId, version: 3 });
    expect(state.visits).toHaveLength(1);
    expect(state.visits[0]?.customerName).toBe('A Customer');
    expect(state.visits[0]?.signature).toBe(true);
    expect(state.visits[0]).toMatchObject({
      service: 'Gutter and downspout cleaning',
      route: {
        driveMinutes: 24,
        miles: 12.5,
        provider: 'vroom',
        evidenceMode: 'live',
      },
      weather: {
        temperature: 86,
        precipitation: 12,
        provider: 'nws',
        evidenceMode: 'live',
      },
      exclusionsStatus: 'not_recorded',
      access: {
        instructions: 'Use the east gate.',
        drainageNotes: 'Keep runoff away from the inlet.',
        knownHazards: ['Low utility line'],
      },
    });
    expect(state.visits[0]?.checklist[0]).toMatchObject({
      label: 'Review stop-work conditions',
      required: true,
      safetyCritical: true,
    });
    expect(state.live?.materials[0]).toMatchObject({
      id: materialId,
      requiresSds: true,
      sdsDocument: {
        productName: 'Reference-only cleaner',
        checksumSha256: 'a'.repeat(64),
        offlineStatus: 'not_cached',
      },
    });
    expect(state.live?.incidentVersions[sdsDocumentId]).toBe(6);
    expect(state.incidents[0]).toMatchObject({ id: sdsDocumentId, status: 'open' });
    expect(state.invoices).toEqual([]);
    expect(state.traces).toEqual([]);
    expect(state.auditEvents).toEqual([]);
  });

  it('maps open payment allocation conflicts into the back-office collection hold queue', () => {
    const conflictId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd10';
    const paymentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd11';
    const providerEventId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd12';
    const state = mapLiveWorkspace({
      schemaVersion: 'storyops-workspace-v1',
      serverTime: '2026-07-28T12:00:00Z',
      session: { userId, companyId, role: 'owner' },
      company: {
        id: companyId,
        name: 'Live Exterior Co',
        timezone: 'America/Chicago',
        currency: 'USD',
        status: 'active',
        settings: {},
        version: 1,
      },
      paymentAllocationConflicts: [
        {
          id: conflictId,
          paymentId,
          invoiceId: approvalId,
          invoiceNumber: 'INV-1048',
          customerId,
          providerEventId,
          conflictCode: 'stale_invoice_version',
          intendedAmount: '396.00',
          verifiedAmount: '396.00',
          invoiceBalanceAtEvent: '420.00',
          providerCheckoutId: 'cs_storyops_exact',
          providerPaymentId: 'pi_storyops_exact',
          providerOccurredAt: '2026-07-28T12:00:00Z',
          approvalRequestId: quoteId,
          status: 'open',
          createdAt: '2026-07-28T12:00:01Z',
          version: 1,
          resolutionAction: 'payment.allocation.apply_exact_current_balance',
          canApplyExactCurrentBalance: true,
          nextAction: 'Verify the exact charge and ledger before resolving.',
        },
      ],
    });

    expect(state.live?.paymentAllocationConflicts).toEqual([
      expect.objectContaining({
        id: conflictId,
        paymentId,
        invoiceNumber: 'INV-1048',
        conflictCode: 'stale_invoice_version',
        verifiedAmount: '396.00',
        providerPaymentId: 'pi_storyops_exact',
        approvalRequestId: quoteId,
        status: 'open',
        resolutionAction: 'payment.allocation.apply_exact_current_balance',
        canApplyExactCurrentBalance: true,
      }),
    ]);
  });

  it('maps queued, submitted, and delivered transactional facts without conflating them', () => {
    const attemptId = 'dddddddd-dddd-4ddd-8ddd-dddddddddd33';
    const state = mapLiveWorkspace({
      schemaVersion: 'storyops-workspace-v1',
      serverTime: '2026-07-29T12:00:00Z',
      session: { userId, companyId, role: 'owner' },
      company: {
        id: companyId,
        name: 'Live Exterior Co',
        timezone: 'America/Chicago',
        currency: 'USD',
        status: 'active',
        settings: {},
        version: 1,
      },
      quotes: [
        {
          id: quoteId,
          quoteNumber: 'Q-1048',
          status: 'sent',
          total: '250.00',
          depositRequired: '62.50',
          version: 5,
        },
      ],
      transactionalDeliveries: [
        {
          id: attemptId,
          action: 'quote.delivery',
          entityId: quoteId,
          entityVersion: 5,
          customerId,
          channel: 'sms',
          status: 'submitted',
          providerMode: 'live',
          providerName: 'twilio',
          providerStatus: 'queued',
          attemptCount: 1,
          reconciliationCount: 0,
          lastErrorCode: null,
          manualReconciliationRequired: false,
          portalPublicationAsserted: true,
          providerSubmissionAsserted: true,
          externalDeliveryClaimed: false,
          requestedAt: '2026-07-29T11:59:00Z',
          completedAt: null,
          version: 2,
        },
      ],
    });

    expect(state.live?.quoteDelivery).toMatchObject({
      id: attemptId,
      status: 'submitted',
      providerStatus: 'queued',
      providerSubmissionAsserted: true,
      externalDeliveryClaimed: false,
    });
  });

  it('keeps each projected lead bound to its own customer and property', () => {
    const secondLeadId = '33333333-3333-4333-8333-333333333334';
    const secondCustomerId = '55555555-5555-4555-8555-555555555556';
    const secondPropertyId = '66666666-6666-4666-8666-666666666667';
    const state = mapLiveWorkspace({
      schemaVersion: 'storyops-workspace-v1',
      serverTime: '2026-07-28T12:00:00Z',
      session: { userId, companyId, role: 'owner' },
      company: {
        id: companyId,
        name: 'Live Exterior Co',
        timezone: 'America/Chicago',
        currency: 'USD',
        status: 'active',
        settings: {},
        version: 1,
      },
      customers: [
        { id: customerId, display_name: 'First Customer' },
        { id: secondCustomerId, display_name: 'Second Customer' },
      ],
      properties: [
        {
          id: propertyId,
          customer_id: customerId,
          name: 'First Property',
          service_address: {
            line1: '100 First Street',
            city: 'Dallas',
            region: 'TX',
            postalCode: '75201',
          },
        },
        {
          id: secondPropertyId,
          customer_id: secondCustomerId,
          name: 'Second Property',
          service_address: {
            line1: '200 Second Street',
            city: 'Fort Worth',
            region: 'TX',
            postalCode: '76102',
          },
        },
      ],
      leads: [
        {
          id: leadId,
          company_id: companyId,
          customer_id: customerId,
          property_id: propertyId,
          version: 2,
          display_name: 'First Lead',
          source: 'web',
          status: 'converted',
          requested_services: ['pressure-wash-flatwork'],
          created_at: '2026-07-28T10:00:00Z',
        },
        {
          id: secondLeadId,
          company_id: companyId,
          customer_id: secondCustomerId,
          property_id: secondPropertyId,
          version: 4,
          display_name: 'Second Lead',
          source: 'phone',
          status: 'converted',
          requested_services: ['soft-wash-house'],
          created_at: '2026-07-28T11:00:00Z',
        },
      ],
    });

    expect(state.leads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: leadId,
          customerId,
          propertyId,
          address: expect.stringContaining('100 First Street'),
        }),
        expect.objectContaining({
          id: secondLeadId,
          customerId: secondCustomerId,
          propertyId: secondPropertyId,
          address: expect.stringContaining('200 Second Street'),
        }),
      ]),
    );
    expect(state.live?.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: propertyId, customerId }),
        expect.objectContaining({ id: secondPropertyId, customerId: secondCustomerId }),
      ]),
    );
    expect(state.live?.propertyId).toBeUndefined();
  });
});
