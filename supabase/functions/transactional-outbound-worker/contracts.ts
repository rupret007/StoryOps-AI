import { z } from 'zod';

const claimIdentity = {
  schemaVersion: z.literal('storyops-transactional-worker-claim-v1'),
  attemptId: z.string().uuid(),
  companyId: z.string().uuid(),
  action: z.enum(['quote.delivery', 'visit.on_my_way']),
  channel: z.enum(['sms', 'email']),
  claimToken: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(120),
  attempt: z.number().int().positive(),
};

const sendClaimSchema = z
  .object({
    ...claimIdentity,
    operation: z.literal('send'),
    recipient: z.string().min(3).max(320),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(1_600),
    consentSnapshotId: z.string().uuid(),
  })
  .strict();

const reconcileClaimSchema = z
  .object({
    ...claimIdentity,
    operation: z.literal('reconcile'),
    providerMessageId: z.string().min(1).max(255),
    providerName: z.string().min(1).max(80),
  })
  .strict();

export const transactionalClaimSchema = z.discriminatedUnion('operation', [
  sendClaimSchema,
  reconcileClaimSchema,
]);
export type TransactionalClaim = z.infer<typeof transactionalClaimSchema>;

export const transactionalWorkerRequestSchema = z
  .object({
    companyId: z.string().uuid(),
    trigger: z.enum(['manual', 'scheduled']),
    workerId: z.string().uuid().optional(),
    batchSize: z.number().int().min(1).max(25).default(10),
    leaseSeconds: z.number().int().min(30).max(300).default(90),
  })
  .strict();

export const transactionalWorkerResultSchema = z
  .object({
    schemaVersion: z.literal('storyops-transactional-worker-result-v1'),
    attemptId: z.string().uuid(),
    status: z.enum([
      'queued',
      'submitting',
      'submitted',
      'submitted_unknown',
      'delivered',
      'sandboxed',
      'failed',
      'cancelled',
    ]),
    providerMode: z.enum(['sandbox', 'live']).optional(),
    providerStatus: z
      .enum([
        'accepted',
        'queued',
        'sent',
        'delivered',
        'failed',
        'submission_unknown',
        'sandbox_recorded',
      ])
      .optional(),
    errorCode: z.string().max(120).optional(),
    providerReadErrorCode: z.string().max(120).nullish(),
    retryScheduled: z.boolean().optional(),
    manualReconciliationRequired: z.boolean().optional(),
    externalDeliveryClaimed: z.boolean(),
  })
  .strict();
export type TransactionalWorkerResult = z.infer<typeof transactionalWorkerResultSchema>;

export const transactionalWorkerResponseSchema = z
  .object({
    schemaVersion: z.literal('storyops-transactional-worker-run-v2'),
    activationMode: z.enum(['manual', 'scheduled']),
    trigger: z.enum(['manual', 'scheduled']),
    status: z.literal('processed'),
    workerId: z.string().uuid(),
    claimed: z.number().int().nonnegative(),
    empty: z.boolean(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    results: z.array(transactionalWorkerResultSchema).max(25),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict();
