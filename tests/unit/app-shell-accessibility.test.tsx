import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { hasPermission, type Permission } from '@/domain';
import { MemoryRouter } from '@/router';
import { createDemoState } from '@/state/demoSeed';
import type { AppRole, DemoState, StoryOpsActions } from '@/state/model';

const mocked = vi.hoisted(() => ({
  value: undefined as
    | {
        state: DemoState;
        actions: StoryOpsActions;
        can(permission: Permission): boolean;
      }
    | undefined,
}));

vi.mock('@/state/StoryOpsProvider', () => ({
  useStoryOps: () => {
    if (!mocked.value) throw new Error('Test StoryOps context was not initialized.');
    return mocked.value;
  },
}));

import { AppShell } from '@/components/AppShell';
import { Field } from '@/components/ui/Primitives';

function renderLiveShell(role: AppRole = 'owner', overrides: Partial<DemoState> = {}) {
  const signOut = vi.fn(async () => undefined);
  const clearThisDevice = vi.fn(async () => undefined);
  const state: DemoState = {
    ...createDemoState(),
    hydrated: true,
    setupComplete: true,
    dataMode: 'supabase',
    authStatus: 'signed_in',
    role,
    serverVerifiedAt: '2026-07-29T12:00:00.000Z',
    offlineQueue: [],
    ...overrides,
  };
  const actions = {
    signOut,
    clearThisDevice,
    setRole: vi.fn(),
    resetDemo: vi.fn(),
    markNotificationsRead: vi.fn(),
    dismissToast: vi.fn(),
    getShowcaseBadge: vi.fn(() => ({
      label: 'DEMO DATA',
      environment: 'local',
      state: 'sandbox',
      scope: 'DFW Exterior Services pilot',
      policyBoundaries: [
        'No invented measurements or prices',
        'No live payment state',
        'No unsanctioned chemical/safety advice',
      ],
      ownerNotice: 'Sandbox boundary active.',
    })),
  } as unknown as StoryOpsActions;
  mocked.value = {
    state,
    actions,
    can: (permission) => hasPermission(state.role, permission),
  };

  const result = render(
    <MemoryRouter>
      <AppShell>
        <button type="button">Page action</button>
      </AppShell>
    </MemoryRouter>,
  );
  return { ...result, signOut, clearThisDevice };
}

describe('AppShell keyboard and mobile accessibility', () => {
  it('exposes every owner destination and authenticated session actions in a trapped menu', async () => {
    const { signOut } = renderLiveShell();
    const menuTrigger = screen.getByRole('button', { name: 'Open navigation menu' });

    menuTrigger.focus();
    fireEvent.click(menuTrigger);

    const menu = screen.getByRole('dialog', { name: 'WashOps workspace' });
    const menuQueries = within(menu);
    for (const destination of [
      'Command center',
      'Pipeline',
      'Customers',
      'Dispatch',
      'Field mode',
      'Finance',
      'AI office',
      'Approvals',
      'Operations',
      'Company setup',
      'Company control',
      'Integrations',
      'Audit trail',
      'Estimate EST-1048',
    ]) {
      expect(menuQueries.getByRole('link', { name: new RegExp(destination, 'u') })).toBeVisible();
    }
    expect(menuQueries.getByRole('button', { name: 'Sign out of WashOps' })).toBeVisible();
    expect(screen.getByLabelText('Server verified · 0 queued · 0 failed')).toBeVisible();
    expect(screen.queryByText('Synced', { exact: true })).not.toBeInTheDocument();

    const closeButton = menuQueries.getByRole('button', { name: 'Close navigation menu' });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
    expect(
      menuQueries.getByRole('button', { name: 'Clear this device and sign out' }),
    ).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(menuTrigger).toHaveFocus());
    expect(screen.queryByRole('dialog', { name: 'WashOps workspace' })).not.toBeInTheDocument();

    fireEvent.click(menuTrigger);
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'WashOps workspace' })).getByRole('button', {
        name: 'Sign out of WashOps',
      }),
    );
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('contains command-palette focus, makes the background inert, and restores its trigger', async () => {
    renderLiveShell();
    const trigger = screen.getByRole('button', { name: 'Search WashOps' });

    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Search WashOps' });
    const search = within(dialog).getByRole('textbox', { name: 'Search' });
    const background = document.querySelector('.app-shell__chrome');
    expect(search).toHaveFocus();
    expect(background).toHaveAttribute('inert');
    expect(background).toHaveAttribute('aria-hidden', 'true');

    fireEvent.keyDown(search, { key: 'Tab', shiftKey: true });
    expect(within(dialog).getByRole('button', { name: /EST-1048 Estimate/u })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });
    expect(search).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole('dialog', { name: 'Search WashOps' })).not.toBeInTheDocument();
    expect(background).not.toHaveAttribute('inert');
    expect(background).not.toHaveAttribute('aria-hidden');
  });

  it('filters the complete drawer to the authenticated technician permission set', () => {
    renderLiveShell('technician');
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));

    const menu = within(screen.getByRole('dialog', { name: 'WashOps workspace' }));
    for (const destination of ['Pipeline', 'Customers', 'Dispatch', 'Field mode', 'Operations']) {
      expect(menu.getByRole('link', { name: new RegExp(destination, 'u') })).toBeVisible();
    }
    for (const deniedDestination of [
      'Command center',
      'Finance',
      'AI office',
      'Approvals',
      'Company setup',
      'Company control',
      'Integrations',
      'Audit trail',
      'Estimate EST-1048',
    ]) {
      expect(
        menu.queryByRole('link', { name: new RegExp(deniedDestination, 'u') }),
      ).not.toBeInTheDocument();
    }
    expect(menu.getByRole('button', { name: 'Sign out of WashOps' })).toBeVisible();
  });

  it('does not confuse browser connectivity with authenticated server verification', () => {
    renderLiveShell('owner', {
      serverVerifiedAt: undefined,
      online: true,
      offlineQueue: [
        {
          id: 'offline-1',
          idempotencyKey: 'offline-1',
          action: 'visit.notes.update',
          entityId: 'visit-1',
          createdAt: '2026-07-29T12:00:00.000Z',
          status: 'failed',
        },
      ],
    });

    expect(
      screen.getByLabelText('Network available · server not verified · 0 queued · 1 failed'),
    ).toBeVisible();
    expect(screen.getByText('Network available · server not verified')).toBeVisible();
    expect(screen.queryByText('Synced', { exact: true })).not.toBeInTheDocument();
  });
});

describe('Field accessible descriptions', () => {
  it('keeps a nested unit wrapper distinct from its labelled input', () => {
    render(
      <Field label="Discount" hint="Above 10% requires approval." htmlFor="discount">
        <div data-testid="unit-wrapper">
          <input id="discount" aria-describedby="discount-hint" />
          <span>%</span>
        </div>
      </Field>,
    );

    expect(screen.getByRole('textbox', { name: 'Discount' })).toHaveAttribute(
      'aria-describedby',
      'discount-hint',
    );
    expect(screen.getByTestId('unit-wrapper')).not.toHaveAttribute('id');
    expect(document.querySelectorAll('#discount')).toHaveLength(1);
  });

  it('associates a stable hint while preserving an existing description', () => {
    const { rerender } = render(
      <>
        <span id="external-context">External context</span>
        <Field label="Crew note" hint="Use observed facts only." htmlFor="crew-note">
          <input id="crew-note" aria-describedby="external-context" />
        </Field>
      </>,
    );

    const input = screen.getByRole('textbox', { name: 'Crew note' });
    const hint = screen.getByText('Use observed facts only.');
    expect(hint).toHaveAttribute('id', 'crew-note-hint');
    expect(input).toHaveAttribute('aria-describedby', 'external-context crew-note-hint');
    expect(input).not.toHaveAttribute('aria-invalid');

    rerender(
      <>
        <span id="external-context">External context</span>
        <Field label="Crew note" error="A factual note is required." htmlFor="crew-note">
          <input id="crew-note" aria-describedby="external-context" />
        </Field>
      </>,
    );

    const error = screen.getByRole('alert');
    expect(error).toHaveAttribute('id', 'crew-note-error');
    expect(input).toHaveAttribute('aria-describedby', 'external-context crew-note-error');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('creates one stable label/control/description identity when callers omit an id', () => {
    render(
      <Field label="Access detail" hint="Describe only what is known.">
        <textarea />
      </Field>,
    );

    const control = screen.getByRole('textbox', { name: 'Access detail' });
    const hint = screen.getByText('Describe only what is known.');
    expect(control.id).toMatch(/^field-/u);
    expect(hint).toHaveAttribute('id', `${control.id}-hint`);
    expect(control).toHaveAttribute('aria-describedby', `${control.id}-hint`);
  });
});
