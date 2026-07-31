import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  outboundWorkerHealthProjectionSchema,
  projectPostServiceWorkerQueue,
  projectTransactionalWorkerQueue,
  requiredPrivateWorkerIds,
} from '@/core/integrations/outboundWorkerHealth';
import { OutboundWorkerHealth } from '@/pages/IntegrationsPage';

const checkedAt = '2026-07-30T21:30:00.000Z';

describe('outbound worker integration health', () => {
  it('renders queue actions, age, and submission uncertainty as an accessible block', () => {
    const postService = projectPostServiceWorkerQueue(
      {
        followups: [
          {
            action: 'review.request',
            status: 'submitted_unknown',
            scheduledAt: '2026-07-30T21:00:00.000Z',
            manualReconciliationRequired: true,
          },
        ],
      },
      checkedAt,
    );
    const transactional = projectTransactionalWorkerQueue(
      {
        backlogCount: 3,
        dueCount: 2,
        submissionUnknownCount: 0,
        quoteDeliveryBacklogCount: 2,
        onMyWayBacklogCount: 1,
        oldestQueuedAt: '2026-07-30T21:10:00.000Z',
      },
      checkedAt,
    );
    const emptyQueue = projectTransactionalWorkerQueue(
      {
        backlogCount: 0,
        dueCount: 0,
        submissionUnknownCount: 0,
        quoteDeliveryBacklogCount: 0,
        onMyWayBacklogCount: 0,
        oldestQueuedAt: null,
      },
      checkedAt,
    );
    const health = outboundWorkerHealthProjectionSchema.parse({
      schemaVersion: 'storyops-private-worker-readiness-v2',
      companyId: '10000000-0000-4000-8000-000000000001',
      checkedAt,
      expiresAt: '2026-07-30T21:35:00.000Z',
      evidenceVersion: 3,
      evidenceHash: 'a'.repeat(64),
      deploymentFingerprint: 'b'.repeat(64),
      alertAfterSeconds: 900,
      status: 'blocked',
      liveReady: false,
      safeDisabled: false,
      workers: requiredPrivateWorkerIds.map((worker) => ({
        worker,
        configurationEnabled: true,
        activationMode: 'scheduled',
        credentialStatus: 'valid',
        acceptedTrigger: 'scheduled',
        scheduleIntervalSeconds: worker === 'transactional_outbound' ? 60 : 900,
        configurationHash: 'c'.repeat(64),
        deploymentIdentityStatus: 'valid',
        deploymentFingerprint: 'b'.repeat(64),
        heartbeat: {
          status: 'verified',
          observedAt: '2026-07-30T21:29:30.000Z',
          trigger: 'scheduled',
        },
        schedulerEvidence: 'verified',
        status: worker === 'post_service' ? 'blocked' : 'healthy',
        liveReady: worker !== 'post_service',
        blockers: worker === 'post_service' ? ['WORKER_SUBMISSION_UNKNOWN'] : [],
        queue:
          worker === 'post_service'
            ? postService
            : worker === 'transactional_outbound'
              ? transactional
              : emptyQueue,
      })),
    });

    render(<OutboundWorkerHealth health={health} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Private scheduled workers · blocked');
    expect(screen.getByRole('alert')).toHaveTextContent('1 submission unknown');
    expect(screen.getByRole('alert')).toHaveTextContent('scheduler verified');
    expect(screen.getByRole('alert')).toHaveTextContent('2 quote / 1 on-my-way');
    expect(screen.getByRole('alert')).toHaveTextContent('oldest 20m');
  });

  it('does not invent queue counts before authenticated health is checked', () => {
    render(<OutboundWorkerHealth />);

    expect(screen.getByRole('heading')).toHaveTextContent(
      'Private scheduled workers · not checked',
    );
    expect(screen.queryByText(/backlog/iu)).not.toBeInTheDocument();
  });
});
