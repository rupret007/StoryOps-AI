import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCompanyControlPacketDiagnostics,
  CompanyControlView,
  type CompanyControlPacketDiagnostic,
} from '@/pages/CompanyControlPage';
import type { CompanyControlState } from '@/state/companyControl';
import type { OfflineMutation } from '@/state/model';

const pausedState: CompanyControlState = {
  schemaVersion: 'storyops-company-control-state-v1',
  companyId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  companyName: 'North Texas Exterior Care',
  timezone: 'America/Chicago',
  status: 'paused',
  canPause: false,
  canReactivate: true,
  recentEvents: [
    {
      commandId: '33333333-3333-4333-8333-333333333333',
      previousStatus: 'active',
      status: 'paused',
      reason: 'Owner stopped work for a verified safety review.',
      changedAt: '2026-07-29T12:00:00.000Z',
      changedByCurrentOwner: true,
      requestHash: 'a'.repeat(64),
    },
  ],
  serverTime: '2026-07-29T12:01:00.000Z',
};

function renderControl(
  controlState: CompanyControlState,
  options: {
    recoveryMode?: boolean;
    pendingMutationCount?: number;
    pendingPackets?: CompanyControlPacketDiagnostic[];
    error?: string;
  } = {},
) {
  const onStatusChange = vi.fn().mockResolvedValue(true);
  const onReload = vi.fn().mockResolvedValue(undefined);
  const onSignOut = vi.fn().mockResolvedValue(undefined);
  const pendingPackets =
    options.pendingPackets ??
    Array.from({ length: options.pendingMutationCount ?? 0 }, (_, index) => ({
      key: `packet-${index}`,
      kind: 'command' as const,
      status: 'queued' as const,
      createdAt: `2026-07-29T12:0${index}:00.000Z`,
    }));
  render(
    <CompanyControlView
      controlState={controlState}
      recoveryMode={options.recoveryMode ?? false}
      online
      serverVerified
      lastServerVerifiedAt="2026-07-29T12:01:00.000Z"
      pendingPackets={pendingPackets}
      busy={false}
      error={options.error}
      onStatusChange={onStatusChange}
      onReload={onReload}
      onSignOut={onSignOut}
    />,
  );
  return { onStatusChange, onReload, onSignOut };
}

describe('owner company-control accessibility', () => {
  it('keeps paused recovery operable without the full workspace and exposes read-only history', async () => {
    const { onStatusChange } = renderControl(pausedState, {
      recoveryMode: true,
      error: 'Full workspace readback is unavailable.',
      pendingPackets: [
        {
          key: 'local-media-packet',
          kind: 'media_upload',
          status: 'failed',
          createdAt: '2026-07-29T11:58:00.000Z',
        },
      ],
    });

    expect(screen.getByRole('heading', { name: 'Company operations are paused.' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Operational kill switch engaged');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    const history = screen.getByRole('list', { name: 'Company lifecycle history' });
    expect(within(history).getByText(/verified safety review/iu)).toBeVisible();
    expect(within(history).queryByRole('button')).not.toBeInTheDocument();
    const diagnostics = screen.getByRole('region', { name: 'Recovery diagnostics' });
    expect(diagnostics).toHaveTextContent(/remain on this device and cannot sync while/iu);
    expect(diagnostics).toHaveTextContent('Full workspace readback is unavailable.');
    expect(within(diagnostics).getByText('Media upload packet')).toBeVisible();
    expect(within(diagnostics).getByText('failed')).toBeVisible();
    expect(diagnostics.querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-07-29T11:58:00.000Z',
    );

    const reason = screen.getByLabelText('Reactivation reason');
    const confirmation = screen.getByLabelText('Typed confirmation');
    const reactivate = screen.getByRole('button', { name: 'Reactivate operations' });
    expect(reason).toHaveAccessibleDescription(/immutable audit evidence/iu);
    expect(confirmation).toHaveAccessibleDescription(/REACTIVATE North Texas Exterior Care/iu);
    expect(reactivate).toBeDisabled();

    fireEvent.change(reason, {
      target: { value: 'Owner completed the safety review and cleared work to resume.' },
    });
    fireEvent.change(confirmation, {
      target: { value: 'REACTIVATE North Texas Exterior Care' },
    });
    expect(reactivate).toBeEnabled();
    fireEvent.click(reactivate);

    await waitFor(() =>
      expect(onStatusChange).toHaveBeenCalledWith({
        expectedStatus: 'paused',
        targetStatus: 'active',
        reason: 'Owner completed the safety review and cleared work to resume.',
      }),
    );
  });

  it('reduces pending packets to privacy-safe diagnostics before rendering', () => {
    const diagnostic = buildCompanyControlPacketDiagnostics([
      {
        id: 'local-command-with-sensitive-payload',
        idempotencyKey: '44444444-4444-4444-8444-444444444444',
        action: 'signature.capture',
        entityId: '55555555-5555-4555-8555-555555555555',
        createdAt: '2026-07-29T11:57:00.000Z',
        status: 'queued',
        kind: 'command',
        command: {
          commandId: '44444444-4444-4444-8444-444444444444',
          commandType: 'signature.capture',
          expectedVersion: 1,
          payload: {
            signaturePng: 'raw-signature-bytes',
            customerName: 'Sensitive Customer',
          },
          requestHash: 'a'.repeat(64),
        },
      } satisfies OfflineMutation,
    ]);

    expect(diagnostic).toEqual([
      {
        key: 'packet-0-2026-07-29T11:57:00.000Z',
        kind: 'command',
        status: 'queued',
        createdAt: '2026-07-29T11:57:00.000Z',
      },
    ]);
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /raw-signature-bytes|Sensitive Customer|signaturePng/iu,
    );
  });

  it('keeps the kill switch available and warns that queued field evidence will be preserved', async () => {
    const { onStatusChange } = renderControl(
      {
        ...pausedState,
        status: 'active',
        canPause: true,
        canReactivate: false,
      },
      { pendingMutationCount: 2 },
    );

    expect(screen.getByText(/2 queued field mutations are preserved/iu)).toHaveAttribute(
      'role',
      'alert',
    );
    fireEvent.change(screen.getByLabelText('Pause reason'), {
      target: { value: 'Owner is pausing work for an operational incident review.' },
    });
    fireEvent.change(screen.getByLabelText('Typed confirmation'), {
      target: { value: 'PAUSE North Texas Exterior Care' },
    });
    const pause = screen.getByRole('button', { name: 'Pause operations' });
    expect(pause).toBeEnabled();
    fireEvent.click(pause);
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenCalledWith({
        expectedStatus: 'active',
        targetStatus: 'paused',
        reason: 'Owner is pausing work for an operational incident review.',
      }),
    );
  });
});
