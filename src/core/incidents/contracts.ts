import { z } from 'zod';

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true });

export const incidentPausePayloadSchema = z
  .object({
    schemaVersion: z.literal('storyops-incident-pause-v1'),
    action: z.literal('incident.report_pause'),
    actorUserId: uuidSchema,
    entityId: uuidSchema,
    incidentNumber: z.string().trim().min(3).max(80),
    visitId: uuidSchema,
    jobId: uuidSchema,
    propertyId: uuidSchema,
    severity: z.enum(['near_miss', 'minor', 'serious', 'critical']),
    category: z.enum([
      'injury',
      'property_damage',
      'chemical',
      'vehicle',
      'environmental',
      'other',
    ]),
    occurredAt: timestampSchema,
    requestedAt: timestampSchema,
    summary: z.string().trim().min(10).max(2_000),
    immediateActions: z.string().trim().min(5).max(2_000),
    requiresLegalReview: z.boolean(),
  })
  .strict();

const stoppedTimeEntrySchema = z
  .object({
    id: uuidSchema,
    previousVersion: z.number().int().positive(),
    currentVersion: z.number().int().positive(),
    endedAt: timestampSchema,
  })
  .strict();

export const incidentPauseReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-incident-pause-receipt-v1'),
    action: z.literal('incident.report_pause'),
    commandId: uuidSchema,
    commandType: z.literal('incident.report_pause'),
    status: z.literal('applied'),
    companyId: uuidSchema,
    actorUserId: uuidSchema,
    requestHash: sha256Schema,
    replayed: z.boolean(),
    entityId: uuidSchema,
    version: z.number().int().positive(),
    incident: z
      .object({
        id: uuidSchema,
        incidentNumber: z.string().min(3).max(80),
        status: z.literal('open'),
        version: z.number().int().positive(),
      })
      .strict(),
    visit: z
      .object({
        id: uuidSchema,
        jobId: uuidSchema,
        propertyId: uuidSchema,
        previousStatus: z.enum(['en_route', 'on_site', 'paused']),
        currentStatus: z.literal('paused'),
        submittedExpectedVersion: z.number().int().positive(),
        previousVersion: z.number().int().positive(),
        currentVersion: z.number().int().positive(),
      })
      .strict(),
    stoppedTimeEntries: z.array(stoppedTimeEntrySchema),
    serverTime: timestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.visit.previousVersion < receipt.visit.submittedExpectedVersion) {
      context.addIssue({
        code: 'custom',
        path: ['visit', 'previousVersion'],
        message: 'Locked visit version cannot precede the submitted safety version.',
      });
    }
    const expectedCurrentVersion =
      receipt.visit.previousStatus === 'paused'
        ? receipt.visit.previousVersion
        : receipt.visit.previousVersion + 1;
    if (receipt.visit.currentVersion !== expectedCurrentVersion) {
      context.addIssue({
        code: 'custom',
        path: ['visit', 'currentVersion'],
        message: 'Paused visit receipt must prove the exact authoritative version transition.',
      });
    }
    receipt.stoppedTimeEntries.forEach((entry, index) => {
      if (entry.currentVersion !== entry.previousVersion + 1) {
        context.addIssue({
          code: 'custom',
          path: ['stoppedTimeEntries', index, 'currentVersion'],
          message: 'Stopped timer receipt must prove exactly one authoritative version change.',
        });
      }
    });
  });

export type IncidentPausePayload = z.infer<typeof incidentPausePayloadSchema>;
export type IncidentPauseReceipt = z.infer<typeof incidentPauseReceiptSchema>;
