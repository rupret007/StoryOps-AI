import { z } from 'zod';
import type { IntegrationHealthOverall } from './dispatchOriginRetention.ts';

const dateTimeSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const requiredPrivateWorkerIds = [
  'post_service',
  'transactional_outbound',
  'scheduling_reconciliation',
  'scope_photo_cleanup',
] as const;
export const privateWorkerIdSchema = z.enum(requiredPrivateWorkerIds);
export type PrivateWorkerId = z.infer<typeof privateWorkerIdSchema>;

const actionCountsSchema = z
  .object({
    postService: z.number().int().nonnegative(),
    quoteDelivery: z.number().int().nonnegative(),
    onMyWay: z.number().int().nonnegative(),
    schedulingReconciliation: z.number().int().nonnegative(),
    scopePhotoCleanup: z.number().int().nonnegative(),
  })
  .strict();

const verifiedQueueSchema = z
  .object({
    availability: z.literal('verified'),
    backlogCount: z.number().int().nonnegative(),
    dueCount: z.number().int().nonnegative(),
    submissionUnknownCount: z.number().int().nonnegative(),
    oldestQueuedAt: dateTimeSchema.nullable(),
    oldestQueuedAgeSeconds: z.number().int().nonnegative().nullable(),
    actionCounts: actionCountsSchema,
  })
  .strict()
  .superRefine((queue, context) => {
    const actionTotal =
      queue.actionCounts.postService +
      queue.actionCounts.quoteDelivery +
      queue.actionCounts.onMyWay +
      queue.actionCounts.schedulingReconciliation +
      queue.actionCounts.scopePhotoCleanup;
    if (
      queue.dueCount > queue.backlogCount ||
      queue.submissionUnknownCount > queue.backlogCount ||
      actionTotal !== queue.backlogCount ||
      (queue.oldestQueuedAt === null) !== (queue.oldestQueuedAgeSeconds === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Private-worker queue counts are internally inconsistent.',
      });
    }
  });

const unavailableQueueSchema = z
  .object({
    availability: z.literal('unavailable'),
    reasonCode: z.enum([
      'POST_SERVICE_QUEUE_PROJECTION_UNAVAILABLE',
      'TRANSACTIONAL_QUEUE_PROJECTION_UNAVAILABLE',
      'SCHEDULING_RECONCILIATION_QUEUE_PROJECTION_UNAVAILABLE',
      'SCOPE_PHOTO_CLEANUP_QUEUE_PROJECTION_UNAVAILABLE',
    ]),
  })
  .strict();

export const outboundWorkerQueueProjectionSchema = z.discriminatedUnion('availability', [
  verifiedQueueSchema,
  unavailableQueueSchema,
]);
export type OutboundWorkerQueueProjection = z.infer<typeof outboundWorkerQueueProjectionSchema>;

export const privateWorkerBlockerSchema = z.enum([
  'WORKER_INACTIVE',
  'WORKER_ACTIVATION_INVALID',
  'WORKER_SCHEDULE_REQUIRED',
  'WORKER_CREDENTIAL_INVALID',
  'WORKER_HEARTBEAT_MISSING',
  'WORKER_HEARTBEAT_STALE',
  'WORKER_HEARTBEAT_FAILED',
  'WORKER_DEPLOYMENT_IDENTITY_MISSING',
  'WORKER_DEPLOYMENT_IDENTITY_INVALID',
  'WORKER_DEPLOYMENT_DRIFT',
  'WORKER_CONFIGURATION_HASH_DRIFT',
  'WORKER_QUEUE_UNAVAILABLE',
  'WORKER_QUEUE_STALE',
  'WORKER_SUBMISSION_UNKNOWN',
]);

const privateWorkerProjectionSchema = z
  .object({
    worker: privateWorkerIdSchema,
    configurationEnabled: z.boolean(),
    activationMode: z.enum(['disabled', 'manual', 'scheduled', 'invalid']),
    credentialStatus: z.enum([
      'valid',
      'missing',
      'too_short',
      'surrounding_whitespace',
      'service_role_reuse',
      'peer_worker_reuse',
    ]),
    acceptedTrigger: z.enum(['manual', 'scheduled']).nullable(),
    scheduleIntervalSeconds: z.number().int().positive().nullable(),
    configurationHash: sha256Schema,
    deploymentIdentityStatus: z.enum(['valid', 'missing', 'invalid']),
    deploymentFingerprint: sha256Schema,
    heartbeat: z
      .object({
        status: z.enum([
          'verified',
          'missing',
          'stale',
          'failed',
          'deployment_drift',
          'configuration_drift',
        ]),
        observedAt: dateTimeSchema.nullable(),
        trigger: z.enum(['manual', 'scheduled']).nullable(),
      })
      .strict(),
    schedulerEvidence: z.enum([
      'verified',
      'missing',
      'stale',
      'failed',
      'deployment_drift',
      'configuration_drift',
      'not_required',
    ]),
    status: z.enum(['healthy', 'inactive', 'degraded', 'blocked']),
    liveReady: z.boolean(),
    blockers: z.array(privateWorkerBlockerSchema),
    queue: outboundWorkerQueueProjectionSchema,
  })
  .strict()
  .superRefine((worker, context) => {
    if (
      worker.liveReady !==
      (worker.status === 'healthy' &&
        worker.activationMode === 'scheduled' &&
        worker.credentialStatus === 'valid' &&
        worker.heartbeat.status === 'verified' &&
        worker.schedulerEvidence === 'verified' &&
        worker.blockers.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Private-worker live readiness is internally inconsistent.',
      });
    }
  });

export const outboundWorkerHealthProjectionSchema = z
  .object({
    schemaVersion: z.literal('storyops-private-worker-readiness-v2'),
    companyId: z.string().uuid(),
    checkedAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
    evidenceVersion: z.number().int().positive(),
    evidenceHash: sha256Schema,
    deploymentFingerprint: sha256Schema,
    alertAfterSeconds: z.number().int().min(60).max(86_400),
    status: z.enum(['healthy', 'degraded', 'blocked']),
    liveReady: z.boolean(),
    safeDisabled: z.boolean(),
    workers: z.array(privateWorkerProjectionSchema).length(4),
  })
  .strict()
  .superRefine((projection, context) => {
    const ids = projection.workers.map((worker) => worker.worker);
    if (
      requiredPrivateWorkerIds.some((worker) => !ids.includes(worker)) ||
      new Set(ids).size !== requiredPrivateWorkerIds.length ||
      projection.liveReady !==
        (projection.status === 'healthy' &&
          projection.workers.every((worker) => worker.liveReady)) ||
      projection.safeDisabled !==
        projection.workers.every(
          (worker) =>
            worker.activationMode === 'disabled' &&
            worker.status === 'inactive' &&
            !worker.liveReady,
        )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The private-worker projection must contain four exact, consistent workers.',
      });
    }
  });
export type OutboundWorkerHealthProjection = z.infer<typeof outboundWorkerHealthProjectionSchema>;

const postServiceStatusSchema = z
  .object({
    followups: z.array(
      z
        .object({
          action: z.enum(['review.request', 'referral.invite', 'maintenance.reminder']),
          status: z.enum([
            'queued',
            'submitted',
            'submitted_unknown',
            'reconciliation_required',
            'completed',
            'sandboxed',
            'failed',
            'cancelled',
          ]),
          scheduledAt: dateTimeSchema,
          manualReconciliationRequired: z.boolean(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function ageSeconds(timestamp: string | null, checkedAt: string): number | null {
  if (timestamp === null) return null;
  return Math.max(0, Math.floor((Date.parse(checkedAt) - Date.parse(timestamp)) / 1_000));
}

function emptyActionCounts(): z.infer<typeof actionCountsSchema> {
  return {
    postService: 0,
    quoteDelivery: 0,
    onMyWay: 0,
    schedulingReconciliation: 0,
    scopePhotoCleanup: 0,
  };
}

export function projectPostServiceWorkerQueue(
  value: unknown,
  checkedAt: string,
): OutboundWorkerQueueProjection {
  const parsed = postServiceStatusSchema.safeParse(value);
  if (!parsed.success) {
    return {
      availability: 'unavailable',
      reasonCode: 'POST_SERVICE_QUEUE_PROJECTION_UNAVAILABLE',
    };
  }
  const executorStatuses = new Set(['queued', 'submitted']);
  const backlog = parsed.data.followups.filter(
    (followup) =>
      executorStatuses.has(followup.status) ||
      followup.status === 'submitted_unknown' ||
      followup.status === 'reconciliation_required',
  );
  const executorQueue = backlog.filter((followup) => executorStatuses.has(followup.status));
  const oldestQueuedAt =
    executorQueue
      .map((followup) => followup.scheduledAt)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
  const submissionUnknownCount = backlog.filter(
    (followup) =>
      followup.status === 'submitted_unknown' ||
      followup.status === 'reconciliation_required' ||
      followup.manualReconciliationRequired,
  ).length;
  return outboundWorkerQueueProjectionSchema.parse({
    availability: 'verified',
    backlogCount: backlog.length,
    dueCount: executorQueue.filter(
      (followup) => Date.parse(followup.scheduledAt) <= Date.parse(checkedAt),
    ).length,
    submissionUnknownCount,
    oldestQueuedAt,
    oldestQueuedAgeSeconds: ageSeconds(oldestQueuedAt, checkedAt),
    actionCounts: { ...emptyActionCounts(), postService: backlog.length },
  });
}

const finiteQueueEvidenceSchema = z
  .object({
    backlogCount: z.number().int().nonnegative(),
    dueCount: z.number().int().nonnegative(),
    submissionUnknownCount: z.number().int().nonnegative(),
    oldestQueuedAt: dateTimeSchema.nullable(),
  })
  .strict();

const transactionalQueueEvidenceSchema = finiteQueueEvidenceSchema.extend({
  quoteDeliveryBacklogCount: z.number().int().nonnegative(),
  onMyWayBacklogCount: z.number().int().nonnegative(),
});
export type TransactionalQueueEvidence = z.infer<typeof transactionalQueueEvidenceSchema>;

export function projectTransactionalWorkerQueue(
  value: unknown,
  checkedAt: string,
): OutboundWorkerQueueProjection {
  const parsed = transactionalQueueEvidenceSchema.safeParse(value);
  if (!parsed.success) {
    return {
      availability: 'unavailable',
      reasonCode: 'TRANSACTIONAL_QUEUE_PROJECTION_UNAVAILABLE',
    };
  }
  return outboundWorkerQueueProjectionSchema.parse({
    availability: 'verified',
    backlogCount: parsed.data.backlogCount,
    dueCount: parsed.data.dueCount,
    submissionUnknownCount: parsed.data.submissionUnknownCount,
    oldestQueuedAt: parsed.data.oldestQueuedAt,
    oldestQueuedAgeSeconds: ageSeconds(parsed.data.oldestQueuedAt, checkedAt),
    actionCounts: {
      ...emptyActionCounts(),
      quoteDelivery: parsed.data.quoteDeliveryBacklogCount,
      onMyWay: parsed.data.onMyWayBacklogCount,
    },
  });
}

export type FinitePrivateWorkerQueueEvidence = z.infer<typeof finiteQueueEvidenceSchema>;

export function projectFinitePrivateWorkerQueue(
  worker: 'scheduling_reconciliation' | 'scope_photo_cleanup',
  value: unknown,
  checkedAt: string,
): OutboundWorkerQueueProjection {
  const parsed = finiteQueueEvidenceSchema.safeParse(value);
  if (!parsed.success) {
    return {
      availability: 'unavailable',
      reasonCode:
        worker === 'scheduling_reconciliation'
          ? 'SCHEDULING_RECONCILIATION_QUEUE_PROJECTION_UNAVAILABLE'
          : 'SCOPE_PHOTO_CLEANUP_QUEUE_PROJECTION_UNAVAILABLE',
    };
  }
  return outboundWorkerQueueProjectionSchema.parse({
    availability: 'verified',
    ...parsed.data,
    oldestQueuedAgeSeconds: ageSeconds(parsed.data.oldestQueuedAt, checkedAt),
    actionCounts: {
      ...emptyActionCounts(),
      [worker === 'scheduling_reconciliation' ? 'schedulingReconciliation' : 'scopePhotoCleanup']:
        parsed.data.backlogCount,
    },
  });
}

export function integrationOverallWithOutboundWorkers(
  providerOverall: IntegrationHealthOverall,
  workers: OutboundWorkerHealthProjection,
): IntegrationHealthOverall {
  if (workers.liveReady) return providerOverall;
  return providerOverall === 'down' ? 'down' : 'degraded';
}
