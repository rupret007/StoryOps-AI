import { z } from 'zod';
import {
  dispatchCurrentOriginSchema,
  type DispatchCurrentOrigin,
} from '@/core/scheduling/dispatchOrigin';

const uuidSchema = z.string().uuid();
const dateTimeSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const dispatchClearanceReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-dispatch-clearance-v2'),
    receiptId: uuidSchema,
    companyId: uuidSchema,
    visitId: uuidSchema,
    visitVersion: z.number().int().positive(),
    jobId: uuidSchema,
    jobVersion: z.number().int().positive(),
    propertyId: uuidSchema,
    propertyVersion: z.number().int().positive(),
    crewId: uuidSchema,
    crewVersion: z.number().int().positive(),
    startsAt: dateTimeSchema,
    endsAt: dateTimeSchema,
    evidenceMode: z.literal('live'),
    configurationRevision: z.number().int().positive(),
    configurationHash: sha256Schema,
    operatingBaselinePublicationId: uuidSchema,
    operatingBaselineHash: sha256Schema,
    schedulingEvidenceReceiptId: uuidSchema,
    providerSnapshotHash: sha256Schema,
    currentOrigin: dispatchCurrentOriginSchema,
    currentOriginHash: sha256Schema,
    currentOriginExpiresAt: dateTimeSchema,
    routeCheckId: uuidSchema,
    routeDisposition: z.literal('eligible'),
    routeObservedAt: dateTimeSchema,
    routeExpiresAt: dateTimeSchema,
    weatherCheckId: uuidSchema,
    weatherDisposition: z.literal('eligible'),
    weatherObservedAt: dateTimeSchema,
    weatherExpiresAt: dateTimeSchema,
    unknowns: z.array(z.string()).max(20),
    conflicts: z.array(z.unknown()).max(20),
    expiresAt: dateTimeSchema,
    evidenceHash: sha256Schema,
    requestHash: sha256Schema,
    createdAt: dateTimeSchema,
    replayed: z.boolean(),
  })
  .strict();

export const dispatchClearanceResponseSchema = z
  .object({
    operation: z.literal('visit.dispatch_clearance.refresh'),
    mode: z.enum(['live', 'sandbox', 'disabled']),
    status: z.enum(['cleared', 'blocked']),
    cleared: z.boolean(),
    reasonCode: z.string().regex(/^[A-Z0-9_]{3,100}$/u),
    message: z.string().min(1).max(500),
    companyId: uuidSchema,
    visitId: uuidSchema,
    visitVersion: z.number().int().positive(),
    receipt: dispatchClearanceReceiptSchema.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    const cleared =
      response.cleared &&
      response.mode === 'live' &&
      response.status === 'cleared' &&
      response.reasonCode === 'LIVE_DISPATCH_CLEARANCE_READY' &&
      response.receipt !== undefined;
    const blocked =
      !response.cleared && response.status === 'blocked' && response.receipt === undefined;
    if (!cleared && !blocked) {
      context.addIssue({
        code: 'custom',
        message: 'Dispatch clearance response state is inconsistent.',
      });
    }
  });

export type DispatchClearanceResult = z.infer<typeof dispatchClearanceResponseSchema>;

export const dispatchClearanceConsumptionSchema = z
  .object({
    schemaVersion: z.literal('storyops-dispatch-clearance-consumption-v1'),
    operation: z.literal('visit.dispatch_clearance.consume'),
    companyId: uuidSchema,
    visitId: uuidSchema,
    clearanceReceiptId: uuidSchema,
    commandId: uuidSchema,
    status: z.literal('applied'),
    previousStatus: z.literal('confirmed'),
    currentStatus: z.literal('en_route'),
    previousVersion: z.number().int().positive(),
    resultingVersion: z.number().int().positive(),
    requestHash: sha256Schema,
    serverTime: dateTimeSchema,
    replayed: z.boolean(),
  })
  .strict()
  .refine((receipt) => receipt.resultingVersion === receipt.previousVersion + 1, {
    message: 'Dispatch consumption version progression is invalid.',
  });

export type DispatchClearanceConsumption = z.infer<typeof dispatchClearanceConsumptionSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function dispatchClearanceIdempotencyKey(input: {
  visitId: string;
  visitVersion: number;
  currentOrigin: DispatchCurrentOrigin;
}): string {
  const visitId = uuidSchema.parse(input.visitId);
  const visitVersion = z.number().int().positive().parse(input.visitVersion);
  const currentOrigin = dispatchCurrentOriginSchema.parse(input.currentOrigin);
  return `dispatch:${visitId}:v${visitVersion}:origin:${currentOrigin.readingId}`;
}

export async function buildDispatchClearanceConsumption(input: {
  companyId: string;
  visitId: string;
  expectedVisitVersion: number;
  clearanceReceiptId: string;
  commandId: string;
}): Promise<{
  companyId: string;
  visitId: string;
  expectedVisitVersion: number;
  clearanceReceiptId: string;
  commandId: string;
  requestHash: string;
}> {
  const companyId = uuidSchema.parse(input.companyId);
  const visitId = uuidSchema.parse(input.visitId);
  const expectedVisitVersion = z.number().int().positive().parse(input.expectedVisitVersion);
  const clearanceReceiptId = uuidSchema.parse(input.clearanceReceiptId);
  const commandId = uuidSchema.parse(input.commandId);
  const requestHash = await sha256Hex(
    JSON.stringify(
      canonicalize({
        clearanceReceiptId,
        companyId,
        expectedVisitVersion,
        operation: 'visit.dispatch_clearance.consume',
      }),
    ),
  );
  return {
    companyId,
    visitId,
    expectedVisitVersion,
    clearanceReceiptId,
    commandId,
    requestHash,
  };
}
