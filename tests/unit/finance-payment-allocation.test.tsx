import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from '@/router';
import { createDemoState } from '@/state/demoSeed';
import { mapLiveWorkspace } from '@/state/liveWorkspaceMapper';
import type { DemoState, PaymentAllocationConflict, StoryOpsActions } from '@/state/model';

const companyId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const conflictId = '33333333-3333-4333-8333-333333333333';
const paymentId = '44444444-4444-4444-8444-444444444444';
const invoiceId = '55555555-5555-4555-8555-555555555555';
const customerId = '66666666-6666-4666-8666-666666666666';
const providerEventId = '77777777-7777-4777-8777-777777777777';
const approvalId = '88888888-8888-4888-8888-888888888888';

const mocked = vi.hoisted(() => ({
  state: undefined as DemoState | undefined,
  resolvePaymentAllocation: vi.fn(),
}));

vi.mock('@/state/StoryOpsProvider', () => ({
  useStoryOps: () => {
    if (!mocked.state) throw new Error('Finance test state was not initialized.');
    return {
      state: mocked.state,
      actions: {
        resolvePaymentAllocation: mocked.resolvePaymentAllocation,
      } as unknown as StoryOpsActions,
      can: () => true,
    };
  },
}));

import { FinancePage } from '@/pages/FinancePage';

function liveState(conflict: PaymentAllocationConflict): DemoState {
  const state = mapLiveWorkspace({
    schemaVersion: 'storyops-workspace-v1',
    serverTime: '2026-07-28T12:00:00.000Z',
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
  });
  if (!state.live) throw new Error('Expected a live workspace.');
  state.serverVerifiedAt = state.live.serverTime;
  state.live.paymentAllocationConflicts = [conflict];
  state.live.invoiceVersions = { [invoiceId]: 5 };
  state.approvals = [
    {
      id: approvalId,
      reason: 'other',
      title: 'Exact payment allocation',
      summary: 'Apply provider-verified funds to the exact current balance.',
      risk: 'high',
      status: 'approved',
      requestedAt: 'Jul 28, 12:00 PM',
      expiresAt: 'Jul 29, 12:00 PM',
      entityId: conflictId,
      payloadPreview: 'Exact verified amount and invoice balance',
      policyVersion: 'payment-allocation-conflict-v1',
      actionType: conflict.resolutionAction,
    },
  ];
  return state;
}

function conflict(overrides: Partial<PaymentAllocationConflict> = {}): PaymentAllocationConflict {
  return {
    id: conflictId,
    paymentId,
    invoiceId,
    invoiceNumber: 'INV-1048',
    customerId,
    providerEventId,
    conflictCode: 'stale_invoice_version',
    intendedAmount: '396.00',
    verifiedAmount: '396.00',
    invoiceBalanceAtEvent: '396.00',
    providerCheckoutId: 'cs_storyops_exact',
    providerPaymentId: 'pi_storyops_exact',
    providerOccurredAt: '2026-07-28T12:00:00.000Z',
    approvalRequestId: approvalId,
    status: 'open',
    createdAt: '2026-07-28T12:00:01.000Z',
    version: 2,
    resolutionAction: 'payment.allocation.apply_exact_current_balance',
    canApplyExactCurrentBalance: true,
    nextAction: 'Verify the exact charge and current balance.',
    ...overrides,
  };
}

describe('live finance payment allocation', () => {
  beforeEach(() => {
    mocked.resolvePaymentAllocation.mockReset();
    mocked.resolvePaymentAllocation.mockResolvedValue(true);
  });

  it('focuses the exact role-visible invoice named by global search', async () => {
    mocked.state = createDemoState();
    render(
      <MemoryRouter initialEntries={['/finance?invoice=invoice-1021']}>
        <FinancePage />
      </MemoryRouter>,
    );

    const row = screen.getByText('INV-1021').closest('tr');
    expect(row).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(row).toHaveFocus());
  });

  it('does not fall back to a different invoice when the requested one is absent', () => {
    mocked.state = createDemoState();
    render(
      <MemoryRouter initialEntries={['/finance?invoice=stale-invoice-id']}>
        <FinancePage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/not in the current role-visible workspace/iu)).toBeVisible();
    expect(document.querySelector('tr[aria-current="true"]')).toBeNull();
  });

  it('requires an explicit owner note before invoking the exact resolver', async () => {
    mocked.state = liveState(conflict());
    render(
      <MemoryRouter>
        <FinancePage />
      </MemoryRouter>,
    );

    const apply = screen.getByRole('button', {
      name: 'Apply verified funds to current invoice',
    });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Owner reconciliation note'), {
      target: { value: 'Matched the signed Stripe charge to the current invoice balance.' },
    });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    await waitFor(() => {
      expect(mocked.resolvePaymentAllocation).toHaveBeenCalledWith({
        conflictId,
        resolutionNote: 'Matched the signed Stripe charge to the current invoice balance.',
      });
    });
  });

  it('does not render an automatic resolver for overpayments or retired checkouts', () => {
    mocked.state = liveState(
      conflict({
        conflictCode: 'retired_checkout_succeeded',
        resolutionAction: 'payment.allocation.review_manual',
        canApplyExactCurrentBalance: false,
      }),
    );
    render(
      <MemoryRouter>
        <FinancePage />
      </MemoryRouter>,
    );

    expect(screen.getByText('manual/provider work only')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Apply verified funds to current invoice' }),
    ).not.toBeInTheDocument();
    expect(mocked.resolvePaymentAllocation).not.toHaveBeenCalled();
  });
});
