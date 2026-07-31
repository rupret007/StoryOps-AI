import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DispatchOriginRetentionHealth } from '@/pages/IntegrationsPage';
import { projectDispatchOriginRetention } from '@/core/integrations/dispatchOriginRetention';

const checkedAt = '2026-07-30T21:30:00.000Z';
const healthyRpc = {
  schemaVersion: 'storyops-dispatch-origin-retention-health-v1',
  status: 'healthy',
  p0ReleaseCheck: 'passed',
  scheduleActive: true,
  scheduleSeconds: 5,
  scheduleRegisteredAt: '2026-07-30T21:29:50.000Z',
  schedulerExecutionVerified: true,
  schedulerLastRunStatus: 'succeeded',
  schedulerLastStartedAt: '2026-07-30T21:29:55.000Z',
  schedulerLastCompletedAt: '2026-07-30T21:29:55.010Z',
  lastStartedAt: '2026-07-30T21:29:55.000Z',
  lastCompletedAt: '2026-07-30T21:29:55.010Z',
  lastStatus: 'healthy',
  lastPurgedCount: 1,
  lastCronHistoryPurgedCount: 1,
  coordinateStaleCount: 0,
  verifierStaleCount: 0,
  cronHistoryStaleCount: 0,
  cronHistoryRetentionHours: 24,
  oldestCoordinateStaleSeconds: 0,
  oldestVerifierStaleSeconds: 0,
  retentionPolicy: 'storyops-dispatch-current-origin-ephemeral-v1',
};

describe('dispatch-origin retention integration health', () => {
  it('renders a verified verifier backlog as an accessible P0 launch block', () => {
    const retention = projectDispatchOriginRetention(
      {
        ...healthyRpc,
        status: 'blocked',
        p0ReleaseCheck: 'blocked',
        lastStatus: 'failed',
        lastPurgedCount: 5000,
        verifierStaleCount: 1,
        oldestVerifierStaleSeconds: 2.5,
      },
      checkedAt,
    );

    render(<DispatchOriginRetentionHealth retention={retention} />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Departure-location retention · launch blocked',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      '0 expired coordinate rows, 1 expired verifier rows',
    );
    expect(screen.getByText('P0 blocked')).toBeVisible();
  });

  it('fails closed without fabricating worker or backlog evidence when the RPC is unavailable', () => {
    const retention = projectDispatchOriginRetention(undefined, checkedAt);

    render(<DispatchOriginRetentionHealth retention={retention} />);

    expect(screen.getByRole('alert')).toHaveTextContent('purge-health RPC is unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('No backlog count is assumed');
    expect(screen.queryByText(/expired coordinate rows/iu)).not.toBeInTheDocument();
  });

  it('shows the P0 check as passed only for verified healthy worker evidence', () => {
    const retention = projectDispatchOriginRetention(healthyRpc, checkedAt);

    render(<DispatchOriginRetentionHealth retention={retention} />);

    expect(screen.getByRole('heading')).toHaveTextContent('Departure-location retention · healthy');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('P0 passed')).toBeVisible();
  });
});
