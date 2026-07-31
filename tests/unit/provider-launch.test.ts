import { describe, expect, it, vi } from 'vitest';
import { LiveStoryOpsRepository, type StoryOpsSupabaseAdapter } from '@/state/liveRepository';
import {
  buildCompanyLaunchAuthorizationCommand,
  buildProviderActivationCommand,
  providerLaunchStateSchema,
} from '@/state/providerLaunch';

const companyId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';
const providerCommandId = '44444444-4444-4444-8444-444444444444';
const launchCommandId = '55555555-5555-4555-8555-555555555555';

function authorityState(status: 'not_authorized' | 'authorized' | 'invalidated' | 'revoked') {
  const active = status === 'authorized';
  const version = status === 'not_authorized' ? 0 : 7;
  return {
    schemaVersion: 'storyops-provider-launch-state-v1',
    companyId,
    role: 'owner',
    connections: [
      {
        id: connectionId,
        provider: 'stripe',
        mode: 'disabled',
        ownerEnabled: false,
        environmentMode: 'live',
        environmentStatus: 'healthy',
        environmentCheckedAt: '2026-07-30T12:00:00Z',
        environmentExpiresAt: '2026-07-30T12:15:00Z',
        environmentCapabilities: ['payments'],
        capabilities: [],
        version: 4,
        canActivateLive: true,
        canActivateSandbox: false,
      },
    ],
    schedulingGate: null,
    launch:
      version === 0
        ? { version, status, launchAuthorized: false }
        : {
            version,
            status,
            launchAuthorized: active,
            configurationRevision: 3,
            configurationHash: 'a'.repeat(64),
            baselineId: '66666666-6666-4666-8666-666666666666',
            baselineHash: 'b'.repeat(64),
            providerSnapshotHash: 'c'.repeat(64),
            proofSnapshotHash: 'd'.repeat(64),
            reviewReference: 'pilot-review-20260730',
            occurredAt: '2026-07-30T12:00:00Z',
          },
    serverTime: '2026-07-30T12:00:00Z',
  };
}

function adapter(rpc: StoryOpsSupabaseAdapter['rpc']): StoryOpsSupabaseAdapter {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: userId } } as never },
        error: null,
      }),
      signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
    rpc,
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: null, error: null }),
        download: vi.fn().mockResolvedValue({ data: null, error: null }),
        remove: vi.fn().mockResolvedValue({ error: null }),
      }),
    },
  };
}

describe('provider and launch authority contracts', () => {
  it('builds stable idempotent hashes and parses effective versus invalidated authority', async () => {
    const first = await buildProviderActivationCommand({
      provider: 'stripe',
      expectedVersion: 4,
      targetMode: 'live',
      commandId: providerCommandId,
    });
    const replay = await buildProviderActivationCommand({
      provider: 'stripe',
      expectedVersion: 4,
      targetMode: 'live',
      commandId: providerCommandId,
    });
    const different = await buildProviderActivationCommand({
      provider: 'stripe',
      expectedVersion: 4,
      targetMode: 'disabled',
      commandId: providerCommandId,
    });
    expect(replay).toEqual(first);
    expect(different.requestHash).not.toBe(first.requestHash);
    await expect(
      buildProviderActivationCommand({
        provider: 'supabase_auth',
        expectedVersion: 2,
        targetMode: 'live',
        commandId: '77777777-7777-4777-8777-777777777777',
      }),
    ).resolves.toMatchObject({
      provider: 'supabase_auth',
      expectedVersion: 2,
      targetMode: 'live',
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const launch = await buildCompanyLaunchAuthorizationCommand({
      expectedVersion: 7,
      action: 'revoke',
      reviewReference: 'pilot-revoke-20260730',
      commandId: launchCommandId,
    });
    expect(launch.reviewReference).toBe('pilot-revoke-20260730');
    expect(launch.requestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(providerLaunchStateSchema.parse(authorityState('authorized')).launch).toMatchObject({
      status: 'authorized',
      launchAuthorized: true,
    });
    expect(providerLaunchStateSchema.parse(authorityState('invalidated')).launch).toMatchObject({
      status: 'invalidated',
      launchAuthorized: false,
    });
  });

  it('submits exact-version owner commands and accepts a matching replay receipt', async () => {
    const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>) => {
      if (name === 'get_storyops_provider_launch_state') {
        return { data: authorityState('invalidated'), error: null };
      }
      if (name === 'set_storyops_provider_activation') {
        return {
          data: {
            schemaVersion: 'storyops-provider-activation-receipt-v1',
            companyId,
            provider: parameters.p_provider,
            mode: parameters.p_target_mode,
            ownerEnabled: parameters.p_target_mode !== 'disabled',
            environmentMode: 'live',
            health: 'healthy',
            capabilities: parameters.p_target_mode === 'disabled' ? [] : ['payments'],
            version: Number(parameters.p_expected_version) + 1,
            launchVersion: 8,
            commandId: parameters.p_command_id,
            requestHash: parameters.p_request_hash,
            replayed: true,
            serverTime: '2026-07-30T12:01:00Z',
          },
          error: null,
        };
      }
      if (name === 'set_storyops_company_launch_authorization') {
        return {
          data: {
            schemaVersion: 'storyops-launch-authorization-receipt-v1',
            companyId,
            version: Number(parameters.p_expected_version) + 1,
            status: 'revoked',
            launchAuthorized: false,
            configurationRevision: 3,
            configurationHash: 'a'.repeat(64),
            baselineId: '66666666-6666-4666-8666-666666666666',
            baselineHash: 'b'.repeat(64),
            providerSnapshotHash: 'c'.repeat(64),
            proofSnapshotHash: 'd'.repeat(64),
            reviewReference: parameters.p_review_reference,
            commandId: parameters.p_command_id,
            requestHash: parameters.p_request_hash,
            replayed: true,
            serverTime: '2026-07-30T12:02:00Z',
          },
          error: null,
        };
      }
      return { data: null, error: { message: `Unexpected RPC ${name}` } };
    });
    const repository = new LiveStoryOpsRepository(adapter(rpc), companyId);

    await expect(repository.loadProviderLaunchState()).resolves.toMatchObject({
      companyId,
      launch: { status: 'invalidated', launchAuthorized: false },
    });
    await expect(
      repository.setProviderActivation({
        provider: 'stripe',
        expectedVersion: 4,
        targetMode: 'live',
        commandId: providerCommandId,
      }),
    ).resolves.toMatchObject({
      provider: 'stripe',
      version: 5,
      replayed: true,
    });
    await expect(
      repository.setCompanyLaunchAuthorization({
        expectedVersion: 7,
        action: 'revoke',
        reviewReference: 'pilot-revoke-20260730',
        commandId: launchCommandId,
      }),
    ).resolves.toMatchObject({
      version: 8,
      status: 'revoked',
      replayed: true,
    });

    expect(rpc).toHaveBeenCalledWith('set_storyops_provider_activation', {
      p_company_id: companyId,
      p_command_id: providerCommandId,
      p_provider: 'stripe',
      p_expected_version: 4,
      p_target_mode: 'live',
      p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(rpc).toHaveBeenCalledWith('set_storyops_company_launch_authorization', {
      p_company_id: companyId,
      p_command_id: launchCommandId,
      p_expected_version: 7,
      p_action: 'revoke',
      p_review_reference: 'pilot-revoke-20260730',
      p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });
});
