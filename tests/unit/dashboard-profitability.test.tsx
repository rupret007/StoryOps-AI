import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DemoState, StoryOpsActions } from '@/state/model';
import { mapLiveWorkspace } from '@/state/liveWorkspaceMapper';
import { MemoryRouter } from '@/router';
import { makeLiveProfitabilityKpis } from '../fixtures/live-profitability';

const companyId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

const mocked = vi.hoisted(() => ({
  state: undefined as DemoState | undefined,
}));

vi.mock('@/state/StoryOpsProvider', () => ({
  useStoryOps: () => {
    if (!mocked.state) throw new Error('Dashboard test state was not initialized.');
    return {
      state: mocked.state,
      actions: {} as StoryOpsActions,
      can: () => true,
    };
  },
}));

import { DashboardPage } from '@/pages/DashboardPage';

function liveState(role: 'owner' | 'technician', withProfitability: boolean): DemoState {
  return mapLiveWorkspace({
    schemaVersion: 'storyops-workspace-v1',
    serverTime: '2026-07-28T12:00:00.000Z',
    session: { userId, companyId, role },
    company: {
      id: companyId,
      name: 'Live Service Company',
      timezone: 'America/Chicago',
      currency: 'USD',
      status: 'active',
      settings: {},
      version: 1,
    },
    ...(withProfitability
      ? { profitabilityKpis: makeLiveProfitabilityKpis(companyId, { complete: false }) }
      : {}),
  });
}

describe('live dashboard profitability', () => {
  it('labels estimate and actual financial facts and exposes completeness evidence', () => {
    mocked.state = liveState('owner', true);
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Invoiced revenue')).toBeVisible();
    expect(screen.getByText('$487.76')).toBeVisible();
    expect(screen.getByText('Estimated gross margin')).toBeVisible();
    expect(screen.getByText(/estimated cost · not actual/u)).toBeVisible();
    expect(screen.getByText('Actual gross margin')).toBeVisible();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.getByText(/0\/1 invoiced jobs cost-complete/u)).toBeVisible();
    expect(screen.getByText(/no labor cost is inferred from time entries/u)).toBeVisible();
    expect(screen.getByText('77777777-7777-4777-8777-777777777777')).toBeInTheDocument();
  });

  it('does not project company receivables or profitability to a technician', () => {
    mocked.state = liveState('technician', false);
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Invoiced revenue')).not.toBeInTheDocument();
    expect(screen.queryByText('Open receivables')).not.toBeInTheDocument();
    expect(screen.queryByText('Actual gross margin')).not.toBeInTheDocument();
    expect(screen.getByText('No company financial projection for this role')).toBeVisible();
  });
});
