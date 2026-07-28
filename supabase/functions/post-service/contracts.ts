import { z } from 'zod';

const identifiers = {
  companyId: z.string().uuid(),
  commandId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
};

const communicationRequest = (action: 'review.request' | 'referral.invite') =>
  z
    .object({
      ...identifiers,
      action: z.literal(action),
      channel: z.enum(['sms', 'email']),
    })
    .strict();

const maintenanceRequest = z
  .object({
    ...identifiers,
    action: z.literal('maintenance.activate'),
    cadence: z.enum(['monthly', 'quarterly', 'semiannual', 'annual', 'custom']),
    intervalDays: z.number().int().min(1).max(3650).optional(),
    nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cadence === 'custom' && value.intervalDays === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['intervalDays'],
        message: 'Custom cadence requires intervalDays.',
      });
    }
    if (value.cadence !== 'custom' && value.intervalDays !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['intervalDays'],
        message: 'Named cadence must not provide intervalDays.',
      });
    }
    const parsed = new Date(`${value.nextDueDate}T00:00:00Z`);
    if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value.nextDueDate) {
      context.addIssue({
        code: 'custom',
        path: ['nextDueDate'],
        message: 'nextDueDate must be a real calendar date.',
      });
    }
  });

export const postServiceRequestSchema = z.union([
  communicationRequest('review.request'),
  communicationRequest('referral.invite'),
  maintenanceRequest,
]);

export type PostServiceRequest = z.infer<typeof postServiceRequestSchema>;

const receiptIdentity = {
  schemaVersion: z.literal('storyops-post-service-v1'),
  companyId: z.string().uuid(),
  commandId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  invoiceVersion: z.number().int().positive(),
  jobId: z.string().uuid(),
  recordId: z.string().uuid(),
  domainRecordId: z.string().uuid(),
  replayed: z.boolean(),
  alreadyExisted: z.boolean(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  serverTime: z.string(),
};

const communicationResponse = (action: 'review.request' | 'referral.invite') =>
  z
    .object({
      ...receiptIdentity,
      action: z.literal(action),
      status: z.enum(['queued', 'completed', 'failed', 'cancelled']),
      channel: z.enum(['sms', 'email']),
      scheduledAt: z.string(),
    })
    .strict();

const maintenanceResponse = z
  .object({
    ...receiptIdentity,
    action: z.literal('maintenance.activate'),
    status: z.literal('active'),
    cadence: z.enum(['monthly', 'quarterly', 'semiannual', 'annual', 'custom']),
    nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    requiresFreshEstimate: z.literal(true),
  })
  .strict();

export const postServiceResponseSchema = z.union([
  communicationResponse('review.request'),
  communicationResponse('referral.invite'),
  maintenanceResponse,
]);

export type PostServiceResponse = z.infer<typeof postServiceResponseSchema>;

export const postServiceStatusSchema = z
  .object({
    schemaVersion: z.literal('storyops-post-service-status-v1'),
    companyId: z.string().uuid(),
    serverTime: z.string(),
    followups: z.array(
      z
        .object({
          id: z.string().uuid(),
          invoiceId: z.string().uuid(),
          jobId: z.string().uuid(),
          customerId: z.string().uuid(),
          propertyId: z.string().uuid(),
          action: z.enum(['review.request', 'referral.invite', 'maintenance.reminder']),
          domainRecordId: z.string().uuid(),
          channel: z.enum(['sms', 'email']),
          status: z.enum([
            'queued',
            'submitted',
            'reconciliation_required',
            'submitted_unknown',
            'completed',
            'sandboxed',
            'failed',
            'cancelled',
          ]),
          scheduledAt: z.string(),
          providerMode: z.enum(['sandbox', 'live']).nullable().optional(),
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
            .nullable()
            .optional(),
          manualReconciliationRequired: z.boolean(),
          externalDeliveryClaimed: z.boolean().optional(),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
    maintenancePlans: z.array(
      z
        .object({
          id: z.string().uuid(),
          invoiceId: z.string().uuid(),
          jobId: z.string().uuid(),
          customerId: z.string().uuid(),
          propertyId: z.string().uuid(),
          status: z.literal('active'),
          cadence: z.enum(['monthly', 'quarterly', 'semiannual', 'annual', 'custom']),
          nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
          serviceCodes: z.array(z.string().min(1)),
          requiresFreshEstimate: z.literal(true),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export type PostServiceStatus = z.infer<typeof postServiceStatusSchema>;
