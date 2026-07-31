import { describe, expect, it, vi } from 'vitest';
import {
  TrustedIdentityProvisioningClient,
  type IdentityProvisioningEdgeClient,
} from '@/state/identityProvisioningClient';

const companyId = '10000000-0000-4000-8000-000000000001';
const commandId = '46000000-0000-4000-8000-000000000001';
const now = '2026-07-30T15:00:00.000Z';

describe('trusted identity provisioning client', () => {
  it('loads only bound owner state and preserves provider-submission truth', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: {
        schemaVersion: 'storyops-identity-provisioning-state-v1',
        companyId,
        companyStatus: 'active',
        inviteMode: 'disabled',
        inviteSubmissionOnly: true,
        externalDeliveryClaimed: false,
        customers: [
          {
            id: '10000000-0000-4000-8000-000000000201',
            displayName: 'Morgan Ellis',
          },
        ],
        targets: [],
        unresolvedAttempts: [],
        serverTime: now,
      },
      error: null,
    });
    const client = new TrustedIdentityProvisioningClient({ functions: { invoke } }, companyId);

    await expect(client.loadState()).resolves.toMatchObject({
      companyId,
      inviteMode: 'disabled',
      externalDeliveryClaimed: false,
    });
    expect(invoke).toHaveBeenCalledWith('identity-provisioning', {
      body: { operation: 'state', companyId },
    });
  });

  it('normalizes the exact email and binds the receipt to the full command hash', async () => {
    const invoke = vi.fn(async (_name: string, input: { body: Record<string, unknown> }) => {
      const body = input.body as {
        request: {
          commandId: string;
          action: string;
          email: string;
          role: string;
          customerId: string | null;
        };
        requestHash: string;
      };
      return {
        data: {
          schemaVersion: 'storyops-identity-provisioning-receipt-v1',
          companyId,
          commandId: body.request.commandId,
          requestHash: body.requestHash,
          action: body.request.action,
          email: body.request.email,
          role: body.request.role,
          customerId: body.request.customerId,
          status: 'invited',
          deliveryStatus: 'provider_submission_accepted',
          externalDeliveryClaimed: false,
          membershipActive: false,
          portalLinked: false,
          outcomeCode: 'invite_submission_accepted',
          replayed: false,
          serverTime: now,
        },
        error: null,
      };
    });
    const client = new TrustedIdentityProvisioningClient(
      { functions: { invoke } } as IdentityProvisioningEdgeClient,
      companyId,
    );
    const receipt = await client.execute({
      action: 'invite',
      email: ' Field.User@Example.com ',
      role: 'technician',
      commandId,
    });

    expect(receipt.email).toBe('field.user@example.com');
    expect(receipt.deliveryStatus).toBe('provider_submission_accepted');
    expect(receipt.externalDeliveryClaimed).toBe(false);
    const submitted = invoke.mock.calls[0]?.[1].body as {
      canonicalRequest: string;
      requestHash: string;
    };
    expect(submitted.canonicalRequest).toContain('"email":"field.user@example.com"');
    expect(submitted.requestHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects a response for a different identity even when the shape is valid', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: {
        schemaVersion: 'storyops-identity-provisioning-receipt-v1',
        companyId,
        commandId,
        requestHash: 'a'.repeat(64),
        action: 'link',
        email: 'other@example.com',
        role: 'technician',
        customerId: null,
        status: 'linked',
        deliveryStatus: 'not_requested',
        externalDeliveryClaimed: false,
        membershipActive: true,
        portalLinked: false,
        outcomeCode: 'identity_linked',
        replayed: false,
        serverTime: now,
      },
      error: null,
    });
    const client = new TrustedIdentityProvisioningClient({ functions: { invoke } }, companyId);

    await expect(
      client.execute({
        action: 'link',
        email: 'field@example.com',
        role: 'technician',
        commandId,
      }),
    ).rejects.toThrow(/did not match/iu);
  });

  it('requires one exact customer binding and forbids staff customer IDs', async () => {
    const client = new TrustedIdentityProvisioningClient(
      {
        functions: {
          invoke: vi.fn(),
        },
      },
      companyId,
    );
    await expect(
      client.execute({
        action: 'link',
        email: 'portal@example.com',
        role: 'customer',
        commandId,
      }),
    ).rejects.toThrow(/customer binding/iu);
    await expect(
      client.execute({
        action: 'link',
        email: 'field@example.com',
        role: 'technician',
        customerId: '10000000-0000-4000-8000-000000000201',
        commandId,
      }),
    ).rejects.toThrow(/staff identities/iu);
  });
});
