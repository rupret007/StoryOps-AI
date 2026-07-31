import {
  integrationOverallWithDispatchRetention,
  projectDispatchOriginRetention,
} from '../../../src/core/integrations/dispatchOriginRetention.ts';
import {
  integrationOverallWithOutboundWorkers,
  outboundWorkerHealthProjectionSchema,
  projectPostServiceWorkerQueue,
  projectTransactionalWorkerQueue,
  requiredPrivateWorkerIds,
} from '../../../src/core/integrations/outboundWorkerHealth.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
}

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

Deno.test('verified purge health preserves provider overall only when the P0 gate passes', () => {
  const retention = projectDispatchOriginRetention(healthyRpc, checkedAt);
  assert(retention.availability === 'verified');
  assert(retention.p0ReleaseCheck === 'passed');
  assert(integrationOverallWithDispatchRetention('healthy', retention) === 'healthy');
  assert(integrationOverallWithDispatchRetention('not_configured', retention) === 'not_configured');
});

Deno.test('a verifier backlog is visible and degrades otherwise healthy provider results', () => {
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
  assert(retention.availability === 'verified');
  assert(retention.verifierStaleCount === 1);
  assert(retention.p0ReleaseCheck === 'blocked');
  assert(integrationOverallWithDispatchRetention('healthy', retention) === 'degraded');
  assert(integrationOverallWithDispatchRetention('down', retention) === 'down');
});

Deno.test('stale purge history is a visible P0 block instead of unbounded silent growth', () => {
  const retention = projectDispatchOriginRetention(
    {
      ...healthyRpc,
      status: 'blocked',
      p0ReleaseCheck: 'blocked',
      lastStatus: 'failed',
      lastCronHistoryPurgedCount: 5000,
      cronHistoryStaleCount: 1,
    },
    checkedAt,
  );
  assert(retention.availability === 'verified');
  assert(retention.cronHistoryRetentionHours === 24);
  assert(retention.cronHistoryStaleCount === 1);
  assert(integrationOverallWithDispatchRetention('healthy', retention) === 'degraded');
});

Deno.test(
  'missing or inconsistent retention RPC evidence is blocked without invented counts',
  () => {
    for (const value of [
      undefined,
      null,
      {
        ...healthyRpc,
        verifierStaleCount: 1,
      },
      {
        ...healthyRpc,
        schedulerExecutionVerified: false,
      },
    ]) {
      const retention = projectDispatchOriginRetention(value, checkedAt);
      assert(retention.availability === 'unavailable');
      assert(retention.status === 'blocked');
      assert(retention.p0ReleaseCheck === 'blocked');
      assert(!('coordinateStaleCount' in retention));
      assert(!('scheduleActive' in retention));
      assert(integrationOverallWithDispatchRetention('healthy', retention) === 'degraded');
    }
  },
);

Deno.test(
  'outbound worker health exposes finite backlog, age, action, and uncertainty facts',
  () => {
    const postService = projectPostServiceWorkerQueue(
      {
        followups: [
          {
            action: 'review.request',
            status: 'queued',
            scheduledAt: '2026-07-30T21:00:00.000Z',
            manualReconciliationRequired: false,
          },
          {
            action: 'referral.invite',
            status: 'submitted_unknown',
            scheduledAt: '2026-07-30T21:20:00.000Z',
            manualReconciliationRequired: true,
          },
          {
            action: 'maintenance.reminder',
            status: 'sandboxed',
            scheduledAt: '2026-07-30T20:00:00.000Z',
            manualReconciliationRequired: false,
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
    assert(postService.availability === 'verified');
    assert(postService.backlogCount === 2);
    assert(postService.dueCount === 1);
    assert(postService.submissionUnknownCount === 1);
    assert(postService.oldestQueuedAgeSeconds === 1_800);
    assert(transactional.availability === 'verified');
    assert(transactional.actionCounts.quoteDelivery === 2);
    assert(transactional.actionCounts.onMyWay === 1);
    assert(transactional.oldestQueuedAgeSeconds === 1_200);

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
      evidenceVersion: 7,
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
        scheduleIntervalSeconds: 120,
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
    assert(health.status === 'blocked');
    assert(health.workers[0]?.status === 'blocked');
    assert(health.workers[0]?.schedulerEvidence === 'verified');
    assert(health.workers[1]?.status === 'healthy');
    assert(health.workers.length === 4);
    assert(integrationOverallWithOutboundWorkers('healthy', health) === 'degraded');
  },
);

Deno.test('scheduled mode cannot parse as healthy without durable scheduler-run evidence', () => {
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
  let rejected = false;
  try {
    outboundWorkerHealthProjectionSchema.parse({
      schemaVersion: 'storyops-private-worker-readiness-v2',
      companyId: '10000000-0000-4000-8000-000000000001',
      checkedAt,
      expiresAt: '2026-07-30T21:35:00.000Z',
      evidenceVersion: 7,
      evidenceHash: 'a'.repeat(64),
      deploymentFingerprint: 'b'.repeat(64),
      alertAfterSeconds: 900,
      status: 'healthy',
      liveReady: true,
      safeDisabled: false,
      workers: requiredPrivateWorkerIds.map((worker) => ({
        worker,
        configurationEnabled: true,
        activationMode: 'scheduled',
        credentialStatus: 'valid',
        acceptedTrigger: 'scheduled',
        queue: emptyQueue,
        scheduleIntervalSeconds: 900,
        configurationHash: 'c'.repeat(64),
        deploymentIdentityStatus: 'valid',
        deploymentFingerprint: 'b'.repeat(64),
        heartbeat: {
          status: 'missing',
          observedAt: null,
          trigger: null,
        },
        schedulerEvidence: 'missing',
        status: 'healthy',
        liveReady: true,
        blockers: [],
      })),
    });
  } catch {
    rejected = true;
  }
  assert(rejected);
});

Deno.test('disabled empty workers are represented but never aggregate as live healthy', () => {
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
    expiresAt: '2026-07-30T21:31:00.000Z',
    evidenceVersion: 8,
    evidenceHash: 'a'.repeat(64),
    deploymentFingerprint: 'b'.repeat(64),
    alertAfterSeconds: 900,
    status: 'blocked',
    liveReady: false,
    safeDisabled: true,
    workers: requiredPrivateWorkerIds.map((worker) => ({
      worker,
      configurationEnabled: false,
      activationMode: 'disabled',
      credentialStatus: 'missing',
      acceptedTrigger: null,
      scheduleIntervalSeconds: null,
      configurationHash: 'c'.repeat(64),
      deploymentIdentityStatus: 'valid',
      deploymentFingerprint: 'b'.repeat(64),
      heartbeat: {
        status: 'missing',
        observedAt: null,
        trigger: null,
      },
      schedulerEvidence: 'not_required',
      status: 'inactive',
      liveReady: false,
      blockers: ['WORKER_INACTIVE'],
      queue: emptyQueue,
    })),
  });
  assert(health.status === 'blocked');
  assert(health.safeDisabled);
  assert(!health.liveReady);
  assert(health.workers[0]?.status === 'inactive');
  assert(health.workers[1]?.status === 'inactive');
  assert(integrationOverallWithOutboundWorkers('down', health) === 'down');
});
