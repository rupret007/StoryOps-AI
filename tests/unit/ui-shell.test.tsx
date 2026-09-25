import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { MemoryRouter } from '@/router';
import { StoryOpsProvider } from '@/state/StoryOpsProvider';

const lazyRouteTimeout = { timeout: 10_000 };

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <StoryOpsProvider>
        <App />
      </StoryOpsProvider>
    </MemoryRouter>,
  );
}

async function completeSandboxSetup() {
  expect(
    await screen.findByRole(
      'heading',
      { name: 'Tell StoryOps who it works for.' },
      lazyRouteTimeout,
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(
    screen.getByLabelText(/I understand these settings are local sandbox guardrails/u),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create sandbox profile' }));
  await screen.findByText('AI office ready · manual runs', {}, lazyRouteTimeout);
}

describe('StoryOps application shell', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the next safe action and sandbox status', async () => {
    renderApp('/');
    await completeSandboxSetup();
    expect(screen.getByText('Good morning, Jeff.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(screen.getByText('AI office ready · manual runs')).toBeVisible();
    expect(screen.getByText(/sandbox adapters ready/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Do this next' })).toBeVisible();
    expect(screen.getByText(/Sandbox records only/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Do this: Open Owner configuration' })).toHaveAttribute(
      'href',
      '/setup',
    );
    expect(screen.queryByText('$4,862')).not.toBeInTheDocument();
    expect(screen.getByText('Not dispatch evidence', { exact: true })).toBeVisible();
    expect(screen.queryByText('NWS sandbox checked')).not.toBeInTheDocument();
    expect(screen.queryByText('In policy', { exact: true })).not.toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
  }, 15_000);

  it('enforces route permissions when previewing the technician role', async () => {
    renderApp('/');
    await completeSandboxSetup();
    const role = await screen.findByLabelText('Preview role', {}, lazyRouteTimeout);
    fireEvent.change(role, { target: { value: 'technician' } });
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Selected field visit' })).toBeVisible();
    }, lazyRouteTimeout);
  }, 15_000);

  it('fails closed to authenticated sign-in when live configuration is incomplete', async () => {
    vi.stubEnv('VITE_STORYOPS_DATA_MODE', 'supabase');
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    vi.stubEnv('VITE_STORYOPS_COMPANY_ID', '');

    renderApp('/');

    expect(
      await screen.findByRole('heading', { name: 'Sign in to your workspace' }, lazyRouteTimeout),
    ).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/VITE_SUPABASE_URL/u);
    expect(screen.queryByText('Good morning, Jeff.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview role')).not.toBeInTheDocument();
  }, 15_000);
});
