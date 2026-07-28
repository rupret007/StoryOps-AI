import { z } from 'zod';

const claimIdentity = {
  schemaVersion: z.literal('storyops-post-service-worker-claim-v1'),
  followupId: z.string().uuid(),
  companyId: z.string().uuid(),
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

export const outboundClaimSchema = z.discriminatedUnion('operation', [
  sendClaimSchema,
  reconcileClaimSchema,
]);
export type OutboundClaim = z.infer<typeof outboundClaimSchema>;

export const workerRequestSchema = z
  .object({
    workerId: z.string().uuid().optional(),
    batchSize: z.number().int().min(1).max(25).default(10),
    leaseSeconds: z.number().int().min(30).max(300).default(90),
  })
  .strict();
export type WorkerRequest = z.infer<typeof workerRequestSchema>;

export const workerResultSchema = z
  .object({
    schemaVersion: z.literal('storyops-post-service-worker-result-v1'),
    followupId: z.string().uuid(),
    status: z.enum([
      'queued',
      'submitted',
      'submitted_unknown',
      'completed',
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
    retryScheduled: z.boolean().optional(),
    externalDeliveryClaimed: z.boolean(),
  })
  .strict();
export type WorkerResult = z.infer<typeof workerResultSchema>;

export const workerResponseSchema = z
  .object({
    schemaVersion: z.literal('storyops-post-service-worker-run-v1'),
    workerId: z.string().uuid(),
    claimed: z.number().int().nonnegative(),
    empty: z.boolean(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    results: z.array(workerResultSchema),
  })
  .strict();
