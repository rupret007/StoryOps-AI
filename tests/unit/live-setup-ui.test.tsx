import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from '@/router';
import { SetupPage } from '@/pages/SetupPage';

const mocks = vi.hoisted(() => ({
  completeSetup: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/state/StoryOpsProvider', () => ({
  useStoryOps: () => ({
    state: {
      dataMode: 'supabase',
      setupProfile: undefined,
    },
    actions: {
      completeSetup: mocks.completeSetup,
    },
  }),
}));

describe('authenticated setup wizard UI', () => {
  beforeEach(() => {
    mocks.completeSetup.mockReset();
    mocks.completeSetup.mockResolvedValue(true);
  });

  it('submits the exact live setup scope without claiming launch authorization', async () => {
    render(
      <MemoryRouter initialEntries={['/setup']}>
        <SetupPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/one owner-scoped company/iu)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Business name'), {
      target: { value: 'North Texas Exterior Care' },
    });
    fireEvent.change(screen.getByLabelText('Owner name'), {
      target: { value: 'Dana Owner' },
    });
    fireEvent.change(screen.getByLabelText('Home ZIP code'), {
      target: { value: '76051' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(
      screen.getByLabelText(/inactive services, unpublished drafts, disabled providers/iu),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      screen.getByRole('heading', { name: 'Confirm the protected setup scope.' }),
    ).toBeVisible();
    expect(screen.getByText(/Nothing below exists until the server confirms it/)).toBeVisible();
    expect(screen.getByText(/company status will remain setup/iu)).toBeVisible();
    expect(screen.queryByText(/workspace is ready/iu)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create setup workspace' }));

    await waitFor(() => {
      expect(mocks.completeSetup).toHaveBeenCalledWith({
        businessName: 'North Texas Exterior Care',
        ownerName: 'Dana Owner',
        homePostalCode: '76051',
        timezone: 'America/Chicago',
        enabledServiceCodes: ['pressure-wash-flatwork', 'gutter-cleaning'],
        policyAcknowledged: true,
      });
    });
  });

  it('never renders setup success when the durable command is rejected', async () => {
    mocks.completeSetup.mockResolvedValue(false);
    render(
      <MemoryRouter initialEntries={['/setup']}>
        <SetupPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Business name'), {
      target: { value: 'North Texas Exterior Care' },
    });
    fireEvent.change(screen.getByLabelText('Owner name'), {
      target: { value: 'Dana Owner' },
    });
    fireEvent.change(screen.getByLabelText('Home ZIP code'), {
      target: { value: '76051' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(
      screen.getByLabelText(/inactive services, unpublished drafts, disabled providers/iu),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create setup workspace' }));

    expect(await screen.findByText(/setup was not confirmed by the server/iu)).toBeVisible();
    expect(screen.queryByText(/workspace is ready/iu)).not.toBeInTheDocument();
  });
});
