import { describe, expect, it, vi } from 'vitest';
import {
  buildCompanyOperationalStatusCommand,
  companyControlReceiptSchema,
  companyControlStateSchema,
} from '@/state/companyControl';
import { createPausedCompanyRecoveryState } from '@/state/liveWorkspaceMapper';
import { LiveStoryOpsRepository, type StoryOpsSupabaseAdapter } from '@/state/liveRepository';

const companyId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';

const pausedControlState = {
  schemaVersion: 'storyops-company-control-state-v1' as const,
  companyId,
  userId,
  companyName: 'North Texas Exterior Care',
  timezone: 'America/Chicago',
  status: 'paused' as const,
  canPause: false,
  canReactivate: true,
  recentEvents: [
    {
      commandId,
      previousStatus: 'active' as const,
      status: 'paused' as const,
      reason: 'Owner stopped work for a verified safety review.',
      changedAt: '2026-07-29T12:00:00.000Z',
      changedByCurrentOwner: true,
      requestHash: 'a'.repeat(64),
    },
  ],
  serverTime: '2026-07-29T12:01:00.000Z',
};

describe('company lifecycle control contracts', () => {
  it('binds every normalized command field to canonical JSON and lowercase SHA-256', async () => {
    await expect(
      buildCompanyOperationalStatusCommand({
        commandId,
        expectedStatus: 'paused',
        targetStatus: 'active',
        reason: '  Owner reviewed safety stop.  ',
      }),
    ).resolves.toEqual({
      commandId,
      expectedStatus: 'paused',
      targetStatus: 'active',
      reason: 'Owner reviewed safety stop.',
      canonicalRequest:
        '{"action":"company.operational_status.set","payload":{"expectedStatus":"paused","reason":"Owner reviewed safety stop.","targetStatus":"active"}}',
      requestHash: '5e70efd314adc0e09e5b7bc26f5c85d9bc006eb38d313eb47ad79064d22058d7',
    });
  });

  it('rejects no-op, unsafe, malformed, and unbound lifecycle evidence', async () => {
    await expect(
      buildCompanyOperationalStatusCommand({
        expectedStatus: 'active',
        targetStatus: 'active',
        reason: 'This cannot be a no-op.',
      }),
    ).rejects.toThrow(/target status must differ/iu);
    await expect(
      buildCompanyOperationalStatusCommand({
        expectedStatus: 'active',
        targetStatus: 'paused',
        reason: 'Unsafe\u0000reason',
      }),
    ).rejects.toThrow(/control characters/iu);

    expect(
      companyControlStateSchema.safeParse({
        ...pausedControlState,
        canPause: true,
      }).success,
    ).toBe(false);
    expect(
      companyControlReceiptSchema.safeParse({
        schemaVersion: 'storyops-company-control-receipt-v1',
        companyId,
        commandId,
        previousStatus: 'active',
        status: 'paused',
        reason: 'Owner stopped work for a verified safety review.',
        requestHash: 'A'.repeat(64),
        changedAt: '2026-07-29T12:00:00.000Z',
        replayed: false,
      }).success,
    ).toBe(false);
  });

  it('builds a minimal signed-in recovery state without projecting the operational workspace', () => {
    const queuedPacket = {
      id: 'queued-packet-1',
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
      action: 'visit.notes.update',
      entityId: '55555555-5555-4555-8555-555555555555',
      createdAt: '2026-07-29T12:00:30.000Z',
      status: 'queued' as const,
    };
    const state = createPausedCompanyRecoveryState(
      companyControlStateSchema.parse(pausedControlState),
      undefined,
      [queuedPacket],
    );

    expect(state).toMatchObject({
      dataMode: 'supabase',
      authStatus: 'signed_in',
      setupComplete: true,
      role: 'owner',
      companyControlRecovery: true,
      companyControlState: { companyId, userId, status: 'paused' },
      live: { companyId, userId, companyName: 'North Texas Exterior Care' },
    });
    expect(state.leads).toEqual([]);
    expect(state.visits).toEqual([]);
    expect(state.invoices).toEqual([]);
    expect(state.integrations).toEqual([]);
    expect(state.offlineQueue).toEqual([queuedPacket]);
  });

  it('uses only owner RPCs and binds the receipt to the exact submitted command', async () => {
    const rpc = vi.fn((name: string, parameters: Record<string, unknown>) => {
      if (name === 'get_storyops_company_control_state') {
        return Promise.resolve({ data: pausedControlState, error: null });
      }
      if (name === 'set_storyops_company_operational_status') {
        return Promise.resolve({
          data: {
            schemaVersion: 'storyops-company-control-receipt-v1',
            companyId,
            commandId: parameters.p_command_id,
            previousStatus: parameters.p_expected_status,
            status: parameters.p_target_status,
            reason: parameters.p_reason,
            requestHash: parameters.p_request_hash,
            changedAt: '2026-07-29T12:02:00.000Z',
            replayed: false,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: 'Unexpected RPC' } });
    });
    const repository = new LiveStoryOpsRepository(
      {
        auth: {
          getSession: vi.fn().mockResolvedValue({
            data: { session: { user: { id: userId } } },
            error: null,
          }),
          signInWithOtp: vi.fn(),
          signOut: vi.fn(),
          onAuthStateChange: vi.fn(),
        },
        rpc,
        functions: { invoke: vi.fn() },
        storage: { from: vi.fn() },
      } as unknown as StoryOpsSupabaseAdapter,
      companyId,
    );

    await expect(repository.loadCompanyControlState()).resolves.toEqual(pausedControlState);
    await expect(
      repository.setCompanyOperationalStatus({
        commandId,
        expectedStatus: 'paused',
        targetStatus: 'active',
        reason: 'Owner reviewed safety stop.',
      }),
    ).resolves.toMatchObject({
      companyId,
      commandId,
      previousStatus: 'paused',
      status: 'active',
      requestHash: '5e70efd314adc0e09e5b7bc26f5c85d9bc006eb38d313eb47ad79064d22058d7',
    });
    expect(rpc).toHaveBeenNthCalledWith(1, 'get_storyops_company_control_state', {
      p_company_id: companyId,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'set_storyops_company_operational_status', {
      p_company_id: companyId,
      p_command_id: commandId,
      p_expected_status: 'paused',
      p_target_status: 'active',
      p_reason: 'Owner reviewed safety stop.',
      p_canonical_request:
        '{"action":"company.operational_status.set","payload":{"expectedStatus":"paused","reason":"Owner reviewed safety stop.","targetStatus":"active"}}',
      p_request_hash: '5e70efd314adc0e09e5b7bc26f5c85d9bc006eb38d313eb47ad79064d22058d7',
    });
  });
});
