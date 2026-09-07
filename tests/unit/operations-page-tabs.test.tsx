import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from '@/router';
import { createDemoState } from '@/state/demoSeed';
import type { DemoState, StoryOpsActions } from '@/state/model';

const mocked = vi.hoisted(() => ({
  state: undefined as DemoState | undefined,
}));

vi.mock('@/state/StoryOpsProvider', () => ({
  useStoryOps: () => {
    if (!mocked.state) throw new Error('Operations page test state is missing.');
    return {
      state: mocked.state,
      actions: {} as StoryOpsActions,
      can: () => true,
    };
  },
}));

import { OperationsPage } from '@/pages/OperationsPage';

describe('operations page hold deep-links', () => {
  it('opens the safety tab from an incident hold hash', () => {
    const state = createDemoState();
    state.setupComplete = true;
    state.role = 'owner';
    mocked.state = state;

    render(
      <MemoryRouter initialEntries={['/operations#safety']}>
        <OperationsPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('tab', { name: /Safety & incidents/u })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('heading', { name: 'Open incidents' })).toBeVisible();
  });

  it('opens the recurring tab from a due-work hold hash', () => {
    const state = createDemoState();
    state.setupComplete = true;
    state.role = 'owner';
    mocked.state = state;

    render(
      <MemoryRouter initialEntries={['/operations#recurring']}>
        <OperationsPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('tab', { name: /Recurring care/u })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('heading', { name: /Recurring/u })).toBeVisible();
  });
});
