import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IdentityProvisioningPanel } from '@/components/IdentityProvisioningPanel';
import type { IdentityProvisioningState } from '@/core/identity/provisioning';

const customerId = '10000000-0000-4000-8000-000000000201';

const state: IdentityProvisioningState = {
  schemaVersion: 'storyops-identity-provisioning-state-v1',
  companyId: '10000000-0000-4000-8000-000000000001',
  companyStatus: 'active',
  inviteMode: 'disabled',
  inviteSubmissionOnly: true,
  externalDeliveryClaimed: false,
  customers: [{ id: customerId, displayName: 'Morgan Ellis' }],
  targets: [
    {
      id: '46000000-0000-4000-8000-000000000010',
      email: 'portal@example.com',
      role: 'customer',
      customerId,
      customerDisplayName: 'Morgan Ellis',
      status: 'invited',
      deliveryStatus: 'provider_submission_accepted',
      outcomeCode: 'invite_submission_accepted',
      membershipActive: false,
      portalLinked: false,
      invitedAt: '2026-07-30T15:00:00.000Z',
      linkedAt: null,
      revokedAt: null,
      updatedAt: '2026-07-30T15:00:00.000Z',
    },
  ],
  unresolvedAttempts: [],
  serverTime: '2026-07-30T15:01:00.000Z',
};

function renderPanel(overrides: Partial<Parameters<typeof IdentityProvisioningPanel>[0]> = {}) {
  const onCommand = vi.fn().mockResolvedValue(undefined);
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  render(
    <IdentityProvisioningPanel
      state={state}
      online
      serverVerified
      busy={false}
      onCommand={onCommand}
      onRefresh={onRefresh}
      {...overrides}
    />,
  );
  return { onCommand, onRefresh };
}

describe('owner identity provisioning panel', () => {
  it('states the disabled delivery boundary and never equates invite submission with access', () => {
    renderPanel({
      lastReceipt: {
        schemaVersion: 'storyops-identity-provisioning-receipt-v1',
        companyId: state.companyId,
        commandId: '46000000-0000-4000-8000-000000000011',
        requestHash: 'a'.repeat(64),
        action: 'invite',
        email: 'portal@example.com',
        role: 'customer',
        customerId,
        status: 'invited',
        deliveryStatus: 'provider_submission_accepted',
        externalDeliveryClaimed: false,
        membershipActive: false,
        portalLinked: false,
        outcomeCode: 'invite_submission_accepted',
        replayed: false,
        serverTime: state.serverTime,
      },
    });

    expect(screen.getByRole('region', { name: 'Identity authority status' })).toHaveTextContent(
      /will not submit external invite email/iu,
    );
    const result = screen.getByRole('region', { name: 'Latest identity command result' });
    expect(result).toHaveTextContent(/inbox delivery and active access are not claimed/iu);
    expect(result).toHaveTextContent(/membership inactive/iu);
    expect(result).toHaveTextContent(/external delivery claimed: no/iu);
    const row = screen.getByRole('row', { name: /portal@example.com/iu });
    expect(within(row).getByText(/delivery claimed: no/iu)).toBeVisible();
    expect(within(row).getByText(/membership inactive/iu)).toBeVisible();
  });

  it('normalizes one exact staff email before sending the owner command', async () => {
    const { onCommand } = renderPanel();
    fireEvent.change(screen.getByLabelText('Exact email'), {
      target: { value: ' Field.User@Example.com ' },
    });
    fireEvent.change(screen.getByLabelText('Role'), {
      target: { value: 'technician' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit invite or locate' }));

    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith({
        action: 'invite',
        email: 'field.user@example.com',
        role: 'technician',
        customerId: undefined,
      }),
    );
  });

  it('surfaces unresolved provider authority without resending and prepares exact lookup', () => {
    renderPanel({
      state: {
        ...state,
        unresolvedAttempts: [
          {
            id: '63000000-0000-4000-8000-000000000201',
            email: 'uncertain@example.com',
            originatingRole: 'dispatcher',
            originatingCustomerId: null,
            providerCommandId: '63000000-0000-4000-8000-000000000202',
            authorityStatus: 'provider_submission_unknown',
            authorizedAt: '2026-07-30T15:00:00.000Z',
            observedAt: '2026-07-30T15:00:01.000Z',
            expiresAt: '2026-08-06T15:00:00.000Z',
            retryEligible: false,
            reconciliationRequired: true,
          },
        ],
      },
    });

    const authority = screen.getByRole('region', { name: 'Unresolved invitation attempts' });
    expect(authority).toHaveTextContent(/duplicate invite submission is blocked/iu);
    expect(authority).toHaveTextContent(/provider submission unknown/iu);
    fireEvent.click(within(authority).getByRole('button', { name: 'Prepare exact lookup' }));
    expect(screen.getByLabelText('Action')).toHaveValue('invite');
    expect(screen.getByLabelText('Exact email')).toHaveValue('uncertain@example.com');
    expect(screen.getByLabelText('Role')).toHaveValue('dispatcher');
  });

  it('requires an explicit customer and prepares exact link/revoke actions from a row', async () => {
    const { onCommand } = renderPanel();
    fireEvent.change(screen.getByLabelText('Exact email'), {
      target: { value: 'new.portal@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Role'), {
      target: { value: 'customer' },
    });
    fireEvent.change(screen.getByLabelText('Action'), {
      target: { value: 'link' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link exact identity' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/choose the exact customer/iu);
    expect(onCommand).not.toHaveBeenCalled();

    const row = screen.getByRole('row', { name: /portal@example.com/iu });
    fireEvent.click(within(row).getByRole('button', { name: 'Prepare link' }));
    expect(screen.getByLabelText('Exact email')).toHaveValue('portal@example.com');
    expect(screen.getByLabelText('Role')).toHaveValue('customer');
    expect(screen.getByLabelText('Exact customer account')).toHaveValue(customerId);
    fireEvent.click(screen.getByRole('button', { name: 'Link exact identity' }));

    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith({
        action: 'link',
        email: 'portal@example.com',
        role: 'customer',
        customerId,
      }),
    );
  });

  it('blocks all mutation controls when the company is paused or server state is stale', () => {
    renderPanel({
      state: { ...state, companyStatus: 'paused' },
      serverVerified: false,
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/company status is paused/iu);
    expect(screen.getByRole('button', { name: 'Submit invite or locate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Prepare link' })).toBeDisabled();
  });
});
