import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from '@/router';
import { EstimatePage } from '@/pages/EstimatePage';
import { OperationsPage } from '@/pages/OperationsPage';
import { createDemoState } from '@/state/demoSeed';
import { customPublishedPricingConfiguration } from '../fixtures/customPublishedPricing';

const storyOps = vi.hoisted(() => ({
  current: undefined as unknown,
}));

vi.mock('@/state/StoryOpsProvider', () => ({
  useStoryOps: () => storyOps.current,
}));

describe('published sandbox pricing UI', () => {
  beforeEach(() => {
    const state = createDemoState();
    const published = customPublishedPricingConfiguration();
    state.companyConfiguration = {
      schemaVersion: 'storyops-company-config-record-v1',
      status: 'published',
      revision: 7,
      draft: published,
      published,
      updatedAt: '2026-07-30T12:00:00.000Z',
      publishedAt: '2026-07-30T12:00:00.000Z',
      publicationMode: 'sandbox',
      publicationReceipt: {
        commandId: '99000000-0000-4000-8000-000000000007',
        configurationHash: '7'.repeat(64),
        reviewReference: 'owner-custom-pricing-v7',
        replayed: false,
      },
    };
    storyOps.current = {
      state,
      actions: {
        updateEstimate: vi.fn(),
        runPolicyCheck: vi.fn(),
        sendQuote: vi.fn(),
      },
      can: () => true,
    };
  });

  it('renders custom published rules and zones in Estimate without legacy values', () => {
    render(
      <MemoryRouter>
        <EstimatePage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/\$987\.65 base · \$0\.33 \/ sq ft/iu)).toBeVisible();
    expect(screen.queryByText(/\$110(?:\.00)? base \+ \$0\.14/iu)).not.toBeInTheDocument();
    expect(
      screen.getByRole('option', {
        name: 'OWNER-ZONE · $48.25 · Up to 12.5 one-way miles',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /DFW-B/iu })).not.toBeInTheDocument();
    expect(screen.getByText('Sales tax · 6.5%', { exact: true })).toBeVisible();
    expect(screen.getByText('Deposit · 40% rule', { exact: true })).toBeVisible();
    expect(screen.getByText(/7\.5% auto limit/iu)).toBeVisible();
  });

  it('renders custom published operations summaries and never the legacy zone', () => {
    render(
      <MemoryRouter>
        <OperationsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('$333.00', { exact: true })).toBeVisible();
    expect(screen.queryByText('$225.00', { exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Service catalog' }));
    expect(screen.getByText(/\$987\.65 base · \$0\.33 \/ sq ft/iu)).toBeVisible();
    expect(screen.queryByText(/\$110(?:\.00)? base \+ \$0\.14/iu)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Travel zones' }));
    expect(screen.getByText(/OWNER-ZONE · Up to 12\.5 one-way miles/iu)).toBeVisible();
    expect(screen.getByText('$48.25', { exact: true })).toBeVisible();
    expect(screen.queryByText(/DFW-B/iu)).not.toBeInTheDocument();
  });
});
