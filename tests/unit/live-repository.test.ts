import { describe, expect, it, vi } from 'vitest';
import {
  buildStoryOpsCommand,
  buildStoryOpsGoldenPathCommand,
  canonicalCommandBody,
  LiveStoryOpsRepository,
  readLiveRepositoryConfig,
  type StoryOpsSupabaseAdapter,
} from '@/state/liveRepository';
import { createLiveSetupRequiredState, mapLiveWorkspace } from '@/state/liveWorkspaceMapper';

const companyId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const leadId = '33333333-3333-4333-8333-333333333333';
const quoteId = '44444444-4444-4444-8444-444444444444';
const customerId = '55555555-5555-4555-8555-555555555555';
const propertyId = '66666666-6666-4666-8666-666666666666';
const jobId = '77777777-7777-4777-8777-777777777777';
const visitId = '88888888-8888-4888-8888-888888888888';
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
            integrationsDisabled: 10,
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
    const rpc = vi.fn().mockResolvedValue({
      data: {
        commandId: command.commandId,
        commandType: command.commandType,
        status: 'applied',
        replayed: false,
        entityId: visitId,
        version: 1,
        requestHash: command.requestHash,
        serverTime: '2026-07-28T12:00:00Z',
      },
      error: null,
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
    expect(rpc).toHaveBeenCalledWith('execute_storyops_golden_path_command', {
      p_company_id: companyId,
      p_command_id: jobId,
      p_command_type: 'job.book',
      p_expected_version: 3,
      p_payload: { entityId: jobId },
      p_request_hash: command.requestHash,
    });
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
    expect(rpc).toHaveBeenNthCalledWith(4, 'execute_storyops_command', {
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
      },
    });
    expect(state.live?.incidentVersions[sdsDocumentId]).toBe(6);
    expect(state.incidents[0]).toMatchObject({ id: sdsDocumentId, status: 'open' });
    expect(state.invoices).toEqual([]);
    expect(state.traces).toEqual([]);
    expect(state.auditEvents).toEqual([]);
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
