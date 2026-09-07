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
      expect(screen.getAllByText(action.title).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Resolve provider readiness')).toBeVisible();
    expect(screen.getByLabelText('Do this next')).toBeVisible();
    expect(screen.getByLabelText('Holds that stop work')).toBeVisible();
    expect(screen.getByRole('link', { name: /Open next:/u })).toBeVisible();
  });

  it('renders leftover incident, field-change, and offline holds on the live queue', () => {
    const state = createDemoState();
    const visit = state.visits[0]!;
    state.dataMode = 'supabase';
    state.authStatus = 'signed_in';
    state.role = 'owner';
    visit.changeRequests = [
      {
        id: 'change-access',
        reasonCode: 'access_blocked',
        summary: 'Gate locked.',
        status: 'submitted',
        createdAt: '2026-07-29T12:00:00.000Z',
        version: 1,
      },
    ];
    state.incidents = [
      {
        id: 'incident-shutter',
        visitId: visit.id,
        jobNumber: visit.jobNumber,
        kind: 'property_damage',
        summary: 'Downspout dented a shutter.',
        status: 'open',
        reportedAt: '2026-07-29T12:00:00.000Z',
        reportedBy: 'technician',
        automationsPaused: true,
      },
    ];
    state.offlineQueue = [
      {
        id: 'packet-complete',
        idempotencyKey: 'packet-complete',
        action: 'visit.complete',
        entityId: visit.id,
        createdAt: '2026-07-29T12:10:00.000Z',
        status: 'failed',
        kind: 'command',
      },
    ];
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
    };
    mocked.state = state;

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('Open incidents pause automation').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Field change requests need office review').length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText('Offline packets failed to reconcile').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('link', { name: `${visit.jobNumber} · property damage` }),
    ).toHaveAttribute('href', '/operations#safety');
    expect(screen.getByRole('link', { name: /Open next:/u })).toBeVisible();
  });

  it('renders a sandbox next-action strip from workspace records', () => {
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

    expect(projection.nextAction?.id).toBe('configuration-missing');
    expect(screen.getAllByText('Do this next').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Complete the owner configuration').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('link', { name: /Open next: Complete the owner configuration/u }),
    ).toHaveAttribute('href', '/setup');
  });
});
