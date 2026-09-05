import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from '@/router';
import { createDemoState } from '@/state/demoSeed';
import type { DemoState, StoryOpsActions } from '@/state/model';
import { deriveOwnerCommandCenter } from '@/core/pilot/ownerCommandCenter';

const mocked = vi.hoisted(() => ({
  state: undefined as DemoState | undefined,
}));

vi.mock('@/state/StoryOpsProvider', () => ({
  useStoryOps: () => {
    if (!mocked.state) throw new Error('Owner dashboard test state is missing.');
    return {
      state: mocked.state,
      actions: {} as StoryOpsActions,
      can: () => true,
    };
  },
}));

import { DashboardPage } from '@/pages/DashboardPage';

describe('owner command-center UI', () => {
  it('renders the complete recommended-action queue instead of only five items', () => {
    const state = createDemoState();
    state.dataMode = 'supabase';
    state.authStatus = 'signed_in';
    state.role = 'owner';
    state.customerQuoteAccepted = true;
    state.depositPaid = false;
    state.visits[0]!.status = 'weather_hold';
    state.invoices[0]!.status = 'past_due';
    state.traces[0]!.result = 'blocked';
    state.integrations = state.integrations.map((integration) => ({
      ...integration,
      status: 'Degraded',
    }));
    state.live = {
      userId: '10000000-0000-4000-8000-000000000101',
      companyId: '10000000-0000-4000-8000-000000000001',
      companyName: 'Pilot Exterior Care',
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-31T14:00:00.000Z',
      fieldVisitReferences: {
        [state.visits[0]!.id]: {
          visit: { id: state.visits[0]!.id, version: 1 },
          visitStatus: 'weather_hold',
          visitStartsAt: '2026-07-31T14:00:00.000Z',
          visitEndsAt: '2026-07-31T16:00:00.000Z',
          job: { id: 'job-1', version: 1 },
          jobId: 'job-1',
          propertyId: 'property-1',
          checklistItems: {},
        },
      },
      invoiceVersions: {},
      leadVersions: {},
      checklistItems: {},
      checklistDefinitions: {},
      incidentVersions: {},
      notificationVersions: {},
      approvalVersions: {},
      materials: [],
      customers: [],
      properties: [],
    };
    mocked.state = state;
    const projection = deriveOwnerCommandCenter(state);
    expect(projection.actions.length).toBeGreaterThan(5);

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    for (const action of projection.actions) {
      expect(screen.getByText(action.title)).toBeVisible();
    }
    expect(screen.getByText('Resolve provider readiness')).toBeVisible();
  });

  it('renders sandbox command-center facts from workspace records instead of invented KPIs', () => {
    const state = createDemoState();
    state.dataMode = 'sandbox';
    state.role = 'owner';
    state.setupComplete = true;
    mocked.state = state;
    const projection = deriveOwnerCommandCenter(state);

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(screen.queryByText('$4,862')).not.toBeInTheDocument();
    expect(screen.queryByText('58.7%')).not.toBeInTheDocument();
    expect(screen.queryByText('$8,420')).not.toBeInTheDocument();
    expect(screen.queryByText('14 active opportunities')).not.toBeInTheDocument();
    expect(screen.queryByText('Weekly equipment inspection')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Workspace record counts')).toBeVisible();
    expect(screen.getByText('Workspace visits')).toBeVisible();
    expect(screen.getByText(state.visits[0]!.jobNumber, { exact: false })).toBeVisible();
    expect(screen.getByText(state.visits[1]!.jobNumber, { exact: false })).toBeVisible();
    expect(screen.getAllByText(/not dispatch evidence/i).length).toBeGreaterThan(0);
    for (const action of projection.actions) {
      expect(screen.getByText(action.title)).toBeVisible();
    }
  });

  it('renders collection-hold and worker-block actions on the live owner queue', () => {
    const state = createDemoState();
    state.dataMode = 'supabase';
    state.authStatus = 'signed_in';
    state.role = 'owner';
    state.live = {
      userId: '10000000-0000-4000-8000-000000000101',
      companyId: '10000000-0000-4000-8000-000000000001',
      companyName: 'Pilot Exterior Care',
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-31T14:00:00.000Z',
      invoiceVersions: {},
      leadVersions: {},
      checklistItems: {},
      checklistDefinitions: {},
      incidentVersions: {},
      notificationVersions: {},
      approvalVersions: {},
      materials: [],
      customers: [],
      properties: [],
      paymentAllocationConflicts: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          paymentId: '55555555-5555-4555-8555-555555555555',
          invoiceId: '66666666-6666-4666-8666-666666666666',
          invoiceNumber: 'INV-1021',
          customerId: '22222222-2222-4222-8222-222222222222',
          providerEventId: 'evt_hold',
          conflictCode: 'retired_checkout_succeeded',
          intendedAmount: '438.70',
          verifiedAmount: '438.70',
          invoiceBalanceAtEvent: '438.70',
          providerPaymentId: 'pi_hold',
          providerOccurredAt: '2026-07-29T12:00:00.000Z',
          status: 'open',
          createdAt: '2026-07-29T12:00:00.000Z',
          version: 1,
          resolutionAction: 'payment.allocation.apply_exact_current_balance',
          canApplyExactCurrentBalance: true,
          nextAction: 'Approve the exact current-balance action, then apply verified funds.',
        },
      ],
    };
    mocked.state = state;

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Verified funds are on collection hold')).toBeVisible();
    expect(
      screen.getByText('Approve the exact current-balance action, then apply verified funds.'),
    ).toBeVisible();
  });
});
