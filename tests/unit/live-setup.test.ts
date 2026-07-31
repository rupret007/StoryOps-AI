import { describe, expect, it } from 'vitest';
import {
  canonicalLiveSetupPayload,
  liveSetupReceiptSchema,
  liveSetupStateSchema,
  stableLiveSetupCommandId,
} from '@/state/liveSetup';

describe('authenticated live setup contracts', () => {
  it('normalizes a supported DFW setup payload and sorts the service scope', () => {
    expect(
      canonicalLiveSetupPayload({
        businessName: '  North Texas Exterior Care ',
        ownerName: ' Dana Owner ',
        homePostalCode: '76051',
        timezone: 'America/Chicago',
        enabledServiceCodes: ['pressure-wash-flatwork', 'gutter-cleaning'],
        policyAcknowledged: true,
      }),
    ).toEqual({
      businessName: 'North Texas Exterior Care',
      ownerName: 'Dana Owner',
      homePostalCode: '76051',
      timezone: 'America/Chicago',
      enabledServiceCodes: ['gutter-cleaning', 'pressure-wash-flatwork'],
      policyAcknowledged: true,
    });
  });

  it.each([
    {
      businessName: 'Valid Business',
      ownerName: 'Valid Owner',
      homePostalCode: '76051',
      timezone: 'America/Chicago',
      enabledServiceCodes: ['invented-service'],
      policyAcknowledged: true,
    },
    {
      businessName: 'Valid Business',
      ownerName: 'Valid Owner',
      homePostalCode: '76051',
      timezone: 'America/Chicago',
      enabledServiceCodes: ['gutter-cleaning', 'gutter-cleaning'],
      policyAcknowledged: true,
    },
    {
      businessName: 'Valid Business',
      ownerName: 'Valid Owner',
      homePostalCode: '76051',
      timezone: 'America/Chicago',
      enabledServiceCodes: ['gutter-cleaning'],
      policyAcknowledged: false,
    },
  ])('rejects unsupported, duplicate, or unacknowledged input: %#', (input) => {
    expect(() => canonicalLiveSetupPayload(input as never)).toThrow();
  });

  it('refuses setup-state and receipt claims without their required evidence', () => {
    expect(() =>
      liveSetupStateSchema.parse({
        schemaVersion: 'storyops-setup-state-v1',
        status: 'ready',
        userId: '10000000-0000-4000-8000-000000000102',
        companyId: null,
        requestedCompanyId: null,
        role: null,
        setupComplete: false,
        requiresLaunchReview: true,
      }),
    ).toThrow(/ready setup state requires/iu);

    expect(() =>
      liveSetupReceiptSchema.parse({
        schemaVersion: 'storyops-live-setup-v1',
        status: 'configured',
        companyId: '98000000-0000-4000-8000-000000000001',
        role: 'owner',
        companyStatus: 'active',
        setupComplete: true,
        requiresLaunchReview: true,
        replayed: false,
        commandId: '98000000-0000-4000-8000-000000000902',
        requestHash: '9'.repeat(64),
        serverTime: '2026-07-28T12:00:00Z',
      }),
    ).toThrow();
  });

  it('accepts a truthful receipt that distinguishes selected and installed service counts', () => {
    expect(
      liveSetupReceiptSchema.parse({
        schemaVersion: 'storyops-live-setup-v1',
        status: 'configured',
        companyId: '98000000-0000-4000-8000-000000000001',
        role: 'owner',
        companyStatus: 'setup',
        setupComplete: true,
        requiresLaunchReview: true,
        replayed: false,
        commandId: '98000000-0000-4000-8000-000000000902',
        requestHash: '9'.repeat(64),
        serviceCount: 2,
        availableServiceCount: 5,
        integrationsDisabled: 11,
        serverTime: '2026-07-28T12:00:00Z',
      }),
    ).toMatchObject({
      serviceCount: 2,
      availableServiceCount: 5,
    });
  });

  it('derives a stable actor-and-company scoped UUID for idempotent setup retries', async () => {
    const first = await stableLiveSetupCommandId(
      '10000000-0000-4000-8000-000000000102',
      '98000000-0000-4000-8000-000000000001',
    );
    await expect(
      stableLiveSetupCommandId(
        '10000000-0000-4000-8000-000000000102',
        '98000000-0000-4000-8000-000000000001',
      ),
    ).resolves.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    await expect(
      stableLiveSetupCommandId(
        '10000000-0000-4000-8000-000000000103',
        '98000000-0000-4000-8000-000000000001',
      ),
    ).resolves.not.toBe(first);
  });
});
