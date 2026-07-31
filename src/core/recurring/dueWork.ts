import { z } from 'zod';

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const recurringDuePlanSchema = z
  .object({
    planId: z.string().uuid(),
    planVersion: z.number().int().positive(),
    customerId: z.string().uuid(),
    customerName: z.string().min(1),
    propertyId: z.string().uuid(),
    propertyName: z.string().min(1),
    cadence: z.enum(['monthly', 'quarterly', 'semiannual', 'annual', 'custom']),
    nextDueDate: isoDateSchema,
    serviceCodes: z.array(z.string().min(1)).min(1),
    requiresFreshEstimate: z.literal(true),
    dueNow: z.boolean(),
    generationAction: z.enum(['create_fresh_estimate_work_item', 'not_available']),
  })
  .strict();

export const recurringDueWorkItemSchema = z
  .object({
    id: z.string().uuid(),
    recurringPlanId: z.string().uuid(),
    planDueDate: isoDateSchema,
    customerId: z.string().uuid(),
    customerName: z.string().min(1),
    propertyId: z.string().uuid(),
    propertyName: z.string().min(1),
    serviceCodes: z.array(z.string().min(1)).min(1),
    sourcePlanVersion: z.number().int().positive(),
    status: z.enum(['fresh_estimate_required', 'estimate_created']),
    estimateId: z.string().uuid().nullable(),
    estimateLinkedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    version: z.number().int().positive(),
    freshEstimateRequired: z.literal(true),
    historicalPriceCopied: z.literal(false),
    estimateCreated: z.boolean(),
    quoteAccepted: z.literal(false),
    depositVerified: z.literal(false),
    schedulingEvidenceVerified: z.literal(false),
    visitCreated: z.literal(false),
    customerContacted: z.literal(false),
    bookingBoundary: z.literal('job.book'),
    nextAction: z.string().min(1).max(500),
  })
  .strict()
  .superRefine((item, context) => {
    const attached = item.status === 'estimate_created';
    if (
      attached !== item.estimateCreated ||
      attached !== Boolean(item.estimateId) ||
      attached !== Boolean(item.estimateLinkedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Estimate milestone fields must describe one exact state.',
      });
    }
  });

export const recurringDueWorkStateSchema = z
  .object({
    schemaVersion: z.literal('storyops-recurring-due-work-state-v1'),
    companyId: z.string().uuid(),
    role: z.enum(['owner', 'dispatcher', 'customer']),
    localDate: isoDateSchema,
    plans: z.array(recurringDuePlanSchema).max(500),
    workItems: z.array(recurringDueWorkItemSchema).max(500),
    guardrails: z
      .object({
        historicalPriceCopied: z.literal(false),
        estimateCreated: z.literal(false),
        quoteAccepted: z.literal(false),
        depositVerified: z.literal(false),
        availabilityVerified: z.literal(false),
        visitCreated: z.literal(false),
        customerContacted: z.literal(false),
        requiredSequence: z.tuple([
          z.literal('fresh_deterministic_estimate'),
          z.literal('policy_approval_if_required'),
          z.literal('quote_acceptance'),
          z.literal('deposit_verification_if_required'),
          z.literal('live_scheduling_evidence'),
          z.literal('job.book'),
        ]),
      })
      .strict(),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export const recurringDueWorkReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-recurring-due-work-receipt-v1'),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    workItemId: z.string().uuid(),
    recurringPlanId: z.string().uuid(),
    sourcePlanVersion: z.number().int().positive(),
    planDueDate: isoDateSchema,
    status: z.literal('fresh_estimate_required'),
    freshEstimateRequired: z.literal(true),
    historicalPriceCopied: z.literal(false),
    estimateCreated: z.literal(false),
    quoteAccepted: z.literal(false),
    depositVerified: z.literal(false),
    schedulingEvidenceVerified: z.literal(false),
    visitCreated: z.literal(false),
    customerContacted: z.literal(false),
    bookingBoundary: z.literal('job.book'),
    alreadyExisted: z.boolean(),
    replayed: z.boolean(),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export const recurringDueEstimateReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-recurring-due-estimate-receipt-v1'),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    workItemId: z.string().uuid(),
    workItemVersion: z.number().int().min(2),
    estimateId: z.string().uuid(),
    status: z.literal('estimate_created'),
    estimateCreated: z.literal(true),
    historicalPriceCopied: z.literal(false),
    quoteAccepted: z.literal(false),
    depositVerified: z.literal(false),
    schedulingEvidenceVerified: z.literal(false),
    visitCreated: z.literal(false),
    customerContacted: z.literal(false),
    bookingBoundary: z.literal('job.book'),
    alreadyAttached: z.boolean(),
    replayed: z.boolean(),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export type RecurringDuePlan = z.infer<typeof recurringDuePlanSchema>;
export type RecurringDueWorkItem = z.infer<typeof recurringDueWorkItemSchema>;
export type RecurringDueWorkState = z.infer<typeof recurringDueWorkStateSchema>;
export type RecurringDueWorkReceipt = z.infer<typeof recurringDueWorkReceiptSchema>;
export type RecurringDueEstimateReceipt = z.infer<typeof recurringDueEstimateReceiptSchema>;

export interface CreateRecurringDueWorkInput {
  planId: string;
  planVersion: number;
  dueDate: string;
  commandId?: string;
}

export interface AttachRecurringDueEstimateInput {
  workItemId: string;
  workItemVersion: number;
  estimateId: string;
  commandId?: string;
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildRecurringDueWorkCommand(input: {
  companyId: string;
  work: CreateRecurringDueWorkInput;
}): Promise<{
  commandId: string;
  requestHash: string;
  planId: string;
  planVersion: number;
  dueDate: string;
}> {
  const companyId = z.string().uuid().parse(input.companyId);
  const planId = z.string().uuid().parse(input.work.planId);
  const planVersion = z.number().int().positive().parse(input.work.planVersion);
  const dueDate = isoDateSchema.parse(input.work.dueDate);
  const commandId = z
    .string()
    .uuid()
    .parse(input.work.commandId ?? crypto.randomUUID());
  const requestHash = await sha256(
    ['storyops-recurring-due-work-v1', companyId, planId, String(planVersion), dueDate].join(
      '\u001f',
    ),
  );
  return { commandId, requestHash, planId, planVersion, dueDate };
}

export async function buildRecurringDueEstimateCommand(input: {
  companyId: string;
  association: AttachRecurringDueEstimateInput;
}): Promise<{
  commandId: string;
  requestHash: string;
  workItemId: string;
  workItemVersion: number;
  estimateId: string;
}> {
  const companyId = z.string().uuid().parse(input.companyId);
  const workItemId = z.string().uuid().parse(input.association.workItemId);
  const workItemVersion = z.number().int().positive().parse(input.association.workItemVersion);
  const estimateId = z.string().uuid().parse(input.association.estimateId);
  const commandId = z
    .string()
    .uuid()
    .parse(input.association.commandId ?? crypto.randomUUID());
  const requestHash = await sha256(
    [
      'storyops-recurring-due-estimate-v1',
      companyId,
      workItemId,
      String(workItemVersion),
      estimateId,
    ].join('\u001f'),
  );
  return { commandId, requestHash, workItemId, workItemVersion, estimateId };
}
