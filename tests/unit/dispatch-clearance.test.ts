import { describe, expect, it, vi } from 'vitest';
import {
  buildDispatchClearanceConsumption,
  dispatchClearanceIdempotencyKey,
  dispatchClearanceResponseSchema,
} from '@/core/scheduling/dispatchClearance';
import type { DispatchCurrentOrigin } from '@/core/scheduling/dispatchOrigin';
import { LiveStoryOpsRepository, type StoryOpsSupabaseAdapter } from '@/state/liveRepository';

const companyId = '11111111-1111-4111-8111-111111111111';
const visitId = '88888888-8888-4888-8888-888888888888';
const jobId = '77777777-7777-4777-8777-777777777777';
const propertyId = '66666666-6666-4666-8666-666666666666';
const crewId = '55555555-5555-4555-8555-555555555555';
const receiptId = '99999999-9999-4999-8999-999999999999';
const configurationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const schedulingReceiptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const routeCheckId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const weatherCheckId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const hash = 'a'.repeat(64);
const originReadingId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function currentOrigin(): DispatchCurrentOrigin {
  return {
    schemaVersion: 'storyops-dispatch-current-origin-v1',
    readingId: originReadingId,
    source: 'device_geolocation',
    coordinates: { latitude: 32.781, longitude: -96.81 },
    observedAt: new Date(Date.now() - 5_000).toISOString(),
    accuracyMeters: 18,
    consent: {
      kind: 'explicit_user_action',
      disclosureVersion: 'storyops-dispatch-origin-consent-v1',
      capturedAt: new Date().toISOString(),
    },
  };
}

function adapter(input: {
  rpc?: StoryOpsSupabaseAdapter['rpc'];
  invoke?: StoryOpsSupabaseAdapter['functions']['invoke'];
}): StoryOpsSupabaseAdapter {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
    rpc: input.rpc ?? vi.fn().mockResolvedValue({ data: null, error: null }),
    functions: {
      invoke: input.invoke ?? vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn(),
        download: vi.fn(),
        remove: vi.fn(),
      }),
    },
  };
}

describe('dispatch clearance client boundary', () => {
  it('binds a stable refresh key to the exact departure reading', () => {
    const origin = currentOrigin();
    expect(
      dispatchClearanceIdempotencyKey({
        visitId,
        visitVersion: 4,
        currentOrigin: origin,
      }),
    ).toBe(`dispatch:${visitId}:v4:origin:${originReadingId}`);
    expect(
      dispatchClearanceIdempotencyKey({
        visitId,
        visitVersion: 4,
        currentOrigin: origin,
      }),
    ).toBe(`dispatch:${visitId}:v4:origin:${originReadingId}`);
    expect(
      dispatchClearanceIdempotencyKey({
        visitId,
        visitVersion: 4,
        currentOrigin: { ...origin, readingId: receiptId },
      }),
    ).toBe(`dispatch:${visitId}:v4:origin:${receiptId}`);
  });

  it('hashes only the exact typed consume envelope', async () => {
    const commandId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const command = await buildDispatchClearanceConsumption({
      companyId,
      visitId,
      expectedVisitVersion: 4,
      clearanceReceiptId: receiptId,
      commandId,
    });
    const replay = await buildDispatchClearanceConsumption({
      clearanceReceiptId: receiptId,
      expectedVisitVersion: 4,
      visitId,
      companyId,
      commandId,
    });

    expect(command).toEqual(replay);
    expect(command.requestHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('never accepts a sandbox or receipt-free cleared response', () => {
    expect(
      dispatchClearanceResponseSchema.safeParse({
        operation: 'visit.dispatch_clearance.refresh',
        mode: 'sandbox',
        status: 'blocked',
        cleared: false,
        reasonCode: 'LIVE_DISPATCH_CLEARANCE_DISABLED',
        message: 'Live evidence was not created.',
        companyId,
        visitId,
        visitVersion: 4,
      }).success,
    ).toBe(true);
    expect(
      dispatchClearanceResponseSchema.safeParse({
        operation: 'visit.dispatch_clearance.refresh',
        mode: 'sandbox',
        status: 'cleared',
        cleared: true,
        reasonCode: 'LIVE_DISPATCH_CLEARANCE_READY',
        message: 'Unsafe claim.',
        companyId,
        visitId,
        visitVersion: 4,
      }).success,
    ).toBe(false);
  });

  it('refreshes and consumes only receipts bound to the exact selected visit version', async () => {
    const startsAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const endsAt = new Date(Date.now() + 90 * 60_000).toISOString();
    const origin = currentOrigin();
    const originExpiresAt = new Date(Date.parse(origin.observedAt) + 2 * 60_000).toISOString();
    const expiresAt = originExpiresAt;
    const routeExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const invoke = vi.fn().mockResolvedValue({
      data: {
        operation: 'visit.dispatch_clearance.refresh',
        mode: 'live',
        status: 'cleared',
        cleared: true,
        reasonCode: 'LIVE_DISPATCH_CLEARANCE_READY',
        message: 'Current live evidence is eligible.',
        companyId,
        visitId,
        visitVersion: 4,
        receipt: {
          schemaVersion: 'storyops-dispatch-clearance-v2',
          receiptId,
          companyId,
          visitId,
          visitVersion: 4,
          jobId,
          jobVersion: 8,
          propertyId,
          propertyVersion: 3,
          crewId,
          crewVersion: 2,
          startsAt,
          endsAt,
          evidenceMode: 'live',
          configurationRevision: 5,
          configurationHash: hash,
          operatingBaselinePublicationId: configurationId,
          operatingBaselineHash: hash,
          schedulingEvidenceReceiptId: schedulingReceiptId,
          providerSnapshotHash: hash,
          currentOrigin: origin,
          currentOriginHash: hash,
          currentOriginExpiresAt: originExpiresAt,
          routeCheckId,
          routeDisposition: 'eligible',
          routeObservedAt: new Date().toISOString(),
          routeExpiresAt,
          weatherCheckId,
          weatherDisposition: 'eligible',
          weatherObservedAt: new Date().toISOString(),
          weatherExpiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
          unknowns: [],
          conflicts: [],
          expiresAt,
          evidenceHash: hash,
          requestHash: hash,
          createdAt: new Date().toISOString(),
          replayed: false,
        },
      },
      error: null,
    });
    const rpc = vi.fn((name: string, parameters: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          schemaVersion: 'storyops-dispatch-clearance-consumption-v1',
          operation: 'visit.dispatch_clearance.consume',
          companyId,
          visitId,
          clearanceReceiptId: receiptId,
          commandId: parameters.p_command_id,
          status: 'applied',
          previousStatus: 'confirmed',
          currentStatus: 'en_route',
          previousVersion: 4,
          resultingVersion: 5,
          requestHash: parameters.p_request_hash,
          serverTime: new Date().toISOString(),
          replayed: false,
        },
        error:
          name === 'consume_storyops_dispatch_clearance' ? null : { message: 'Unexpected RPC' },
      }),
    );
    const repository = new LiveStoryOpsRepository(adapter({ rpc, invoke }), companyId);
    const consumeCommandId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

    const clearance = await repository.refreshDispatchClearance({
      visitId,
      expectedVisitVersion: 4,
      currentOrigin: origin,
    });
    await expect(
      repository.consumeDispatchClearance({
        visitId,
        expectedVisitVersion: 4,
        clearanceReceiptId: clearance.receipt?.receiptId ?? '',
        commandId: consumeCommandId,
      }),
    ).resolves.toMatchObject({
      visitId,
      previousVersion: 4,
      resultingVersion: 5,
      currentStatus: 'en_route',
    });
    expect(invoke).toHaveBeenCalledWith('dispatch-clearance', {
      body: expect.objectContaining({
        companyId,
        visitId,
        expectedVisitVersion: 4,
        currentOrigin: origin,
        idempotencyKey: expect.stringMatching(/^dispatch:/u),
      }),
    });
    expect(rpc).toHaveBeenCalledWith('consume_storyops_dispatch_clearance', {
      p_company_id: companyId,
      p_command_id: consumeCommandId,
      p_expected_visit_version: 4,
      p_clearance_receipt_id: receiptId,
      p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('can replay one exact consume command after the first response is lost', async () => {
    const commandId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    let attempt = 0;
    const rpc = vi.fn((_name: string, parameters: Record<string, unknown>) => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve({
          data: null,
          error: {
            message: 'TypeError: Failed to fetch after submission',
            status: 503,
          },
        });
      }
      return Promise.resolve({
        data: {
          schemaVersion: 'storyops-dispatch-clearance-consumption-v1',
          operation: 'visit.dispatch_clearance.consume',
          companyId,
          visitId,
          clearanceReceiptId: receiptId,
          commandId: parameters.p_command_id,
          status: 'applied',
          previousStatus: 'confirmed',
          currentStatus: 'en_route',
          previousVersion: 4,
          resultingVersion: 5,
          requestHash: parameters.p_request_hash,
          serverTime: new Date().toISOString(),
          replayed: true,
        },
        error: null,
      });
    });
    const repository = new LiveStoryOpsRepository(adapter({ rpc }), companyId);
    const exactInput = {
      visitId,
      expectedVisitVersion: 4,
      clearanceReceiptId: receiptId,
      commandId,
    };

    await expect(repository.consumeDispatchClearance(exactInput)).rejects.toThrow(
      /Failed to fetch after submission/u,
    );
    await expect(repository.consumeDispatchClearance(exactInput)).resolves.toMatchObject({
      commandId,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      replayed: true,
      currentStatus: 'en_route',
    });

    const submissions = rpc.mock.calls.map(([, parameters]) => parameters);
    expect(submissions).toHaveLength(2);
    expect(submissions[0]?.p_command_id).toBe(commandId);
    expect(submissions[1]?.p_command_id).toBe(commandId);
    expect(submissions[1]?.p_request_hash).toBe(submissions[0]?.p_request_hash);
    expect(submissions[1]?.p_clearance_receipt_id).toBe(receiptId);
  });
});
