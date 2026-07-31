import { z } from 'zod';
import { resolveLiveProviderActivation } from '../../../src/core/integrations/configuration.ts';

export const schedulingReconciliationRequestSchema = z
  .object({
    companyId: z.string().uuid(),
    workerId: z.string().uuid().optional(),
    batchSize: z.number().int().min(1).max(25).default(10),
    leaseSeconds: z.number().int().min(30).max(300).default(90),
  })
  .strict();

export const schedulingReconciliationClaimSchema = z
  .object({
    schemaVersion: z.literal('storyops-scheduling-reconciliation-claim-v1'),
    caseId: z.string().uuid(),
    receiptId: z.string().uuid().optional(),
    companyId: z.string().uuid(),
    jobId: z.string().uuid(),
    claimToken: z.string().uuid(),
    operation: z.enum(['cancel', 'reconcile']),
    attempt: z.number().int().min(1).max(20),
    calendarId: z.string().min(1).max(500),
    eventId: z.string().regex(/^storyops[a-f0-9]{40}$/u),
    eventEtag: z.string().min(1).max(500).optional(),
    idempotencyKey: z.string().min(8).max(220),
    window: z
      .object({
        start: z.string().datetime({ offset: true }),
        end: z.string().datetime({ offset: true }),
      })
      .strict(),
    receiptExpiresAt: z.string().datetime({ offset: true }).optional(),
    leaseExpiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type SchedulingReconciliationClaim = z.infer<typeof schedulingReconciliationClaimSchema>;

export const schedulingReconciliationResultSchema = z
  .object({
    schemaVersion: z.literal('storyops-scheduling-reconciliation-result-v1'),
    caseId: z.string().uuid(),
    receiptId: z.string().uuid().optional(),
    companyId: z.string().uuid(),
    jobId: z.string().uuid(),
    status: z.enum([
      'pending',
      'leased',
      'retry_wait',
      'provider_unknown',
      'cancelled',
      'no_action',
      'manual_required',
    ]),
    attemptCount: z.number().int().min(0).max(20),
    nextAttemptAt: z.string().datetime({ offset: true }).optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,120}$/u)
      .optional(),
    calendarCancellationConfirmed: z.boolean(),
    externalStateUnknown: z.boolean(),
    manualReviewRequired: z.boolean(),
  })
  .strict();
export type SchedulingReconciliationResult = z.infer<typeof schedulingReconciliationResultSchema>;

const activeRunSchema = z
  .object({
    schemaVersion: z.literal('storyops-scheduling-reconciliation-run-v1'),
    mode: z.literal('live'),
    status: z.literal('processed'),
    workerId: z.string().uuid(),
    claimed: z.number().int().nonnegative().max(25),
    empty: z.boolean(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    results: z.array(schedulingReconciliationResultSchema).max(25),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const inactiveRunSchema = z
  .object({
    schemaVersion: z.literal('storyops-scheduling-reconciliation-run-v1'),
    mode: z.enum(['sandbox', 'disabled']),
    status: z.literal('inactive'),
    claimed: z.literal(0),
    empty: z.literal(true),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    results: z.array(z.never()).max(0),
    message: z.string().min(1).max(500),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const schedulingReconciliationRunSchema = z.union([activeRunSchema, inactiveRunSchema]);

export function resolveSchedulingReconciliationActivation(
  environment: Readonly<Record<string, string | undefined>>,
) {
  return resolveLiveProviderActivation(
    environment,
    'SCHEDULING_RECONCILIATION_LIVE_ENABLED',
    'SCHEDULING_RECONCILIATION_MODE',
  );
}
