import { describe, expect, it, vi } from 'vitest';
import {
  buildCustomerPortalCommand,
  LiveStoryOpsRepository,
  type StoryOpsSupabaseAdapter,
} from '@/state/liveRepository';

const companyId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const propertyId = '33333333-3333-4333-8333-333333333333';
const visitId = '44444444-4444-4444-8444-444444444444';
const commandId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';
const leadId = '77777777-7777-4777-8777-777777777777';

function adapter(rpc: StoryOpsSupabaseAdapter['rpc']): StoryOpsSupabaseAdapter {
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
      invoke: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'unused' }, error: null }),
        download: vi.fn().mockResolvedValue({ data: new Blob(), error: null }),
        remove: vi.fn().mockResolvedValue({ error: null }),
      }),
    },
  };
}

describe('customer portal repository boundary', () => {
  it('creates stable canonical SHA-256 evidence for exact command replays', async () => {
    const first = await buildCustomerPortalCommand({
      commandId,
      commandType: 'portal.reschedule.request',
      payload: {
        visitId,
        nested: { second: 2, first: 1 },
        customerId,
      },
    });
    const replay = await buildCustomerPortalCommand({
      commandId,
      commandType: 'portal.reschedule.request',
      payload: {
        customerId,
        nested: { first: 1, second: 2 },
        visitId,
      },
    });

    expect(replay).toEqual(first);
    expect(first.canonicalRequest).toBe(
      `{"commandType":"portal.reschedule.request","payload":{"customerId":"${customerId}","nested":{"first":1,"second":2},"visitId":"${visitId}"}}`,
    );
    expect(first.requestHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('submits a reschedule request RPC twice with one exact idempotency identity', async () => {
    let calls = 0;
    const rpc = vi.fn((name: string, parameters: Record<string, unknown>) => {
      expect(name).toBe('submit_customer_portal_request');
      calls += 1;
      return Promise.resolve({
        data: {
          schemaVersion: 'storyops-customer-portal-request-v1',
          companyId,
          customerId,
          commandId: parameters.p_command_id,
          requestHash: parameters.p_request_hash,
          requestId,
          requestType: 'reschedule',
          status: 'submitted',
          normalizedLeadId: null,
          visitChanged: false,
          replayed: calls > 1,
          serverTime: '2026-07-29T12:00:00.000Z',
        },
        error: null,
      });
    });
    const repository = new LiveStoryOpsRepository(adapter(rpc), companyId);
    const input = {
      requestType: 'reschedule' as const,
      customerId,
      propertyId,
      visitId,
      preferredStartDate: '2026-08-03',
      preferredEndDate: '2026-08-05',
      requestNotes: '  Mornings work best.  ',
      commandId,
    };

    const first = await repository.submitCustomerPortalRequest(input);
    const replay = await repository.submitCustomerPortalRequest(input);

    expect(first).toMatchObject({ requestId, visitChanged: false, replayed: false });
    expect(replay).toMatchObject({ requestId, visitChanged: false, replayed: true });
    expect(rpc).toHaveBeenCalledTimes(2);
    const firstPayload = rpc.mock.calls[0]?.[1];
    const replayPayload = rpc.mock.calls[1]?.[1];
    expect(firstPayload).toEqual(replayPayload);
    expect(firstPayload).toMatchObject({
      p_command_type: 'portal.reschedule.request',
      p_request_type: 'reschedule',
      p_visit_id: visitId,
      p_property_id: propertyId,
      p_requested_service_codes: [],
      p_request_notes: 'Mornings work best.',
    });
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain('execute_storyops_command');
  });

  it('normalizes an additional-service request into sorted service codes and a lead receipt', async () => {
    const rpc = vi.fn((name: string, parameters: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          schemaVersion: 'storyops-customer-portal-request-v1',
          companyId,
          customerId,
          commandId: parameters.p_command_id,
          requestHash: parameters.p_request_hash,
          requestId,
          requestType: 'additional_service',
          status: 'submitted',
          normalizedLeadId: leadId,
          visitChanged: false,
          replayed: false,
          serverTime: '2026-07-29T12:00:00.000Z',
        },
        error: name === 'submit_customer_portal_request' ? null : { message: 'Unexpected RPC' },
      }),
    );
    const repository = new LiveStoryOpsRepository(adapter(rpc), companyId);

    await expect(
      repository.submitCustomerPortalRequest({
        requestType: 'additional_service',
        customerId,
        propertyId,
        requestedServiceCodes: ['soft-wash-house', 'gutter-cleaning', 'soft-wash-house'],
        requestNotes: 'Please verify scope.',
        commandId,
      }),
    ).resolves.toMatchObject({
      normalizedLeadId: leadId,
      visitChanged: false,
    });
    expect(rpc).toHaveBeenCalledWith(
      'submit_customer_portal_request',
      expect.objectContaining({
        p_visit_id: null,
        p_requested_service_codes: ['gutter-cleaning', 'soft-wash-house'],
      }),
    );
  });

  it('normalizes global opt-out to four false purposes without contacting a provider', async () => {
    const consentRecordIds = [
      '80000000-0000-4000-8000-000000000001',
      '80000000-0000-4000-8000-000000000002',
      '80000000-0000-4000-8000-000000000003',
      '80000000-0000-4000-8000-000000000004',
    ];
    const rpc = vi.fn((_name: string, parameters: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          schemaVersion: 'storyops-customer-communication-preferences-v1',
          companyId,
          customerId,
          commandId: parameters.p_command_id,
          requestHash: parameters.p_request_hash,
          preferencesVersion: 2,
          consentRecordIds,
          globalOptOut: true,
          replayed: false,
          serverTime: '2026-07-29T12:00:00.000Z',
        },
        error: null,
      }),
    );
    const testAdapter = adapter(rpc);
    const repository = new LiveStoryOpsRepository(testAdapter, companyId);

    await expect(
      repository.updateCustomerCommunicationPreferences({
        customerId,
        transactionalSms: true,
        transactionalEmail: true,
        marketingSms: true,
        marketingEmail: true,
        globalOptOut: true,
        disclosureVersion: 'customer-portal-consent-v1',
        commandId,
      }),
    ).resolves.toMatchObject({
      globalOptOut: true,
      consentRecordIds,
    });
    expect(rpc).toHaveBeenCalledWith(
      'update_customer_communication_preferences',
      expect.objectContaining({
        p_transactional_sms: false,
        p_transactional_email: false,
        p_marketing_sms: false,
        p_marketing_email: false,
        p_global_opt_out: true,
      }),
    );
    expect(testAdapter.functions.invoke).not.toHaveBeenCalled();
  });

  it('rejects malformed requests before making an RPC', async () => {
    const rpc = vi.fn();
    const repository = new LiveStoryOpsRepository(adapter(rpc), companyId);
    await expect(
      repository.submitCustomerPortalRequest({
        requestType: 'additional_service',
        customerId,
        propertyId,
        requestedServiceCodes: [],
        requestNotes: '',
      }),
    ).rejects.toThrow(/Select one or more valid services/u);
    expect(rpc).not.toHaveBeenCalled();
  });
});
