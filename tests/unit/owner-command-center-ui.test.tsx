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
});
