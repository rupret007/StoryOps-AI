import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@/core/ai/approval';
import { propertyGeocodeConfirmationHashPayload } from '@/core/properties/contracts';
import { LiveStoryOpsRepository, type StoryOpsSupabaseAdapter } from '@/state/liveRepository';

const companyId = '10000000-0000-4000-8000-000000000001';
const operationId = '94800000-0000-4000-8000-000000000001';
const customerId = '94800000-0000-4000-8000-000000000002';
const propertyId = '94800000-0000-4000-8000-000000000003';
const candidateId = '94900000-0000-4000-8000-000000000002';
const commandId = '94900000-0000-4000-8000-000000000003';

function adapter(options: {
  rpc: StoryOpsSupabaseAdapter['rpc'];
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
    rpc: options.rpc,
    functions: {
      invoke:
        options.invoke ??
        vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'Unexpected Edge invocation.' },
        }),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'unused' }, error: null }),
        download: vi.fn().mockResolvedValue({ data: null, error: null }),
        remove: vi.fn().mockResolvedValue({ error: null }),
      }),
    },
  };
}

const intake = {
  displayName: 'Morgan Ellis',
  email: 'morgan@example.com',
  phone: '214-555-0100',
  acquisitionSource: 'manual',
  propertyName: 'Primary property',
  serviceAddress: {
    line1: '123 Main Street',
    city: 'Dallas',
    region: 'TX',
    postalCode: '75201',
    country: 'US',
  },
};

describe('live property repository boundary', () => {
  it('creates customer and property through one exact transaction RPC', async () => {
    const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>) => ({
      data: {
        schemaVersion: 'storyops-customer-property-receipt-v1',
        operationId: parameters.p_operation_id,
        customerId,
        propertyId,
        customerVersion: 1,
        propertyVersion: 1,
        requestHash: parameters.p_request_hash,
        replayed: false,
        serverTime: '2026-07-30T15:00:00.000Z',
      },
      error: null,
    }));
    const repository = new LiveStoryOpsRepository(adapter({ rpc }), companyId);

    await expect(
      repository.createCustomerProperty(intake, {
        operationId,
        customerId,
        propertyId,
      }),
    ).resolves.toMatchObject({
      operationId,
      customerId,
      propertyId,
      customerVersion: 1,
      propertyVersion: 1,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      'create_storyops_customer_property',
      expect.objectContaining({
        p_company_id: companyId,
        p_operation_id: operationId,
        p_payload: expect.objectContaining({
          schemaVersion: 'storyops-customer-property-create-v1',
          customer: expect.objectContaining({ id: customerId }),
          property: expect.objectContaining({ id: propertyId }),
        }),
        p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
  });

  it('rejects a receipt for another property instead of claiming partial success', async () => {
    const repository = new LiveStoryOpsRepository(
      adapter({
        rpc: vi.fn(async (_name: string, parameters: Record<string, unknown>) => ({
          data: {
            schemaVersion: 'storyops-customer-property-receipt-v1',
            operationId,
            customerId,
            propertyId: '94800000-0000-4000-8000-000000000099',
            customerVersion: 1,
            propertyVersion: 1,
            requestHash: parameters.p_request_hash,
            replayed: false,
            serverTime: '2026-07-30T15:00:00.000Z',
          },
          error: null,
        })),
      }),
      companyId,
    );

    await expect(
      repository.createCustomerProperty(intake, {
        operationId,
        customerId,
        propertyId,
      }),
    ).rejects.toThrow(/complete submitted request/iu);
  });

  it('binds lookup and confirmation to one exact property version and candidate', async () => {
    const observedAt = '2026-07-30T15:00:00.000Z';
    const expiresAt = '2026-07-31T15:00:00.000Z';
    const invoke = vi.fn(async (_name: string, input: { body: Record<string, unknown> }) => ({
      data: {
        schemaVersion: 'storyops-property-geocode-candidates-v1',
        operationId: input.body.operationId,
        companyId,
        propertyId,
        propertyVersion: 3,
        addressHash: 'b'.repeat(64),
        candidates: [
          {
            id: candidateId,
            propertyId,
            propertyVersion: 3,
            provider: 'google_maps',
            mode: 'live',
            formattedAddress: '123 Main Street, Dallas, TX 75201, USA',
            latitude: 32.7767,
            longitude: -96.797,
            precision: 'rooftop',
            confidence: 0.99,
            providerPlaceId: 'place-123',
            observedAt,
            expiresAt,
            evidenceHash: 'a'.repeat(64),
          },
        ],
        requiresHumanConfirmation: true,
        replayed: false,
        serverTime: '2026-07-30T15:00:01.000Z',
      },
      error: null,
    }));
    const expectedConfirmationHash = await sha256Hex(
      propertyGeocodeConfirmationHashPayload({
        propertyId,
        propertyVersion: 3,
        candidateId,
      }),
    );
    const rpc = vi.fn(async (_name: string, parameters: Record<string, unknown>) => ({
      data: {
        schemaVersion: 'storyops-property-geocode-confirmation-v1',
        commandId,
        companyId,
        propertyId,
        propertyVersion: 4,
        candidateId,
        provider: 'google_maps',
        precision: 'rooftop',
        confidence: 0.99,
        confirmedAt: '2026-07-30T15:02:00.000Z',
        requestHash: parameters.p_request_hash,
        replayed: false,
      },
      error: null,
    }));
    const repository = new LiveStoryOpsRepository(adapter({ rpc, invoke }), companyId);

    await expect(
      repository.requestPropertyGeocode({
        propertyId,
        expectedPropertyVersion: 3,
        operationId,
      }),
    ).resolves.toMatchObject({
      propertyId,
      propertyVersion: 3,
      requiresHumanConfirmation: true,
    });
    expect(invoke).toHaveBeenCalledWith('property-geocode', {
      body: {
        schemaVersion: 'storyops-property-geocode-lookup-v1',
        companyId,
        propertyId,
        expectedPropertyVersion: 3,
        operationId,
      },
    });

    await expect(
      repository.confirmPropertyGeocode({
        propertyId,
        expectedPropertyVersion: 3,
        candidateId,
        commandId,
      }),
    ).resolves.toMatchObject({
      propertyId,
      propertyVersion: 4,
      candidateId,
      provider: 'google_maps',
    });
    expect(rpc).toHaveBeenCalledWith('confirm_storyops_property_geocode_candidate', {
      p_company_id: companyId,
      p_command_id: commandId,
      p_property_id: propertyId,
      p_expected_property_version: 3,
      p_candidate_id: candidateId,
      p_request_hash: expectedConfirmationHash,
    });
  });
});
