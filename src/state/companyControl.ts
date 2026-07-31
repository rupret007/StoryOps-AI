import { z } from 'zod';

const companyOperationalStatusSchema = z.enum(['active', 'paused']);
const companyStatusSchema = z.enum(['setup', 'active', 'paused']);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const safeReasonSchema = z
  .string()
  .trim()
  .min(10, 'Explain the operational reason in at least 10 characters.')
  .max(1000, 'Keep the operational reason under 1,000 characters.')
  .refine(
    (value) =>
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    'Operational reasons cannot contain control characters.',
  );

export const companyLifecycleEventSchema = z
  .object({
    commandId: z.string().uuid(),
    previousStatus: companyOperationalStatusSchema,
    status: companyOperationalStatusSchema,
    reason: safeReasonSchema,
    changedAt: z.string().datetime({ offset: true }),
    changedByCurrentOwner: z.boolean(),
    requestHash: sha256Schema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.previousStatus === event.status) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'A lifecycle event must change the operational status.',
      });
    }
  });

export const companyControlStateSchema = z
  .object({
    schemaVersion: z.literal('storyops-company-control-state-v1'),
    companyId: z.string().uuid(),
    userId: z.string().uuid(),
    companyName: z.string().trim().min(1).max(160),
    timezone: z.string().trim().min(1).max(100),
    status: companyStatusSchema,
    canPause: z.boolean(),
    canReactivate: z.boolean(),
    recentEvents: z.array(companyLifecycleEventSchema).max(20),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.canPause !== (state.status === 'active')) {
      context.addIssue({
        code: 'custom',
        path: ['canPause'],
        message: 'Pause capability does not match company status.',
      });
    }
    if (state.canReactivate !== (state.status === 'paused')) {
      context.addIssue({
        code: 'custom',
        path: ['canReactivate'],
        message: 'Reactivation capability does not match company status.',
      });
    }
  });

export const companyControlReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-company-control-receipt-v1'),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    previousStatus: companyOperationalStatusSchema,
    status: companyOperationalStatusSchema,
    reason: safeReasonSchema,
    requestHash: sha256Schema,
    changedAt: z.string().datetime({ offset: true }),
    replayed: z.boolean(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.previousStatus === receipt.status) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'A lifecycle receipt must change the operational status.',
      });
    }
  });

const companyOperationalStatusCommandInputSchema = z
  .object({
    expectedStatus: companyOperationalStatusSchema,
    targetStatus: companyOperationalStatusSchema,
    reason: safeReasonSchema,
    commandId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.expectedStatus === input.targetStatus) {
      context.addIssue({
        code: 'custom',
        path: ['targetStatus'],
        message: 'The target status must differ from the current status.',
      });
    }
  });

export type CompanyOperationalStatus = z.infer<typeof companyOperationalStatusSchema>;
export type CompanyLifecycleEvent = z.infer<typeof companyLifecycleEventSchema>;
export type CompanyControlState = z.infer<typeof companyControlStateSchema>;
export type CompanyControlReceipt = z.infer<typeof companyControlReceiptSchema>;
export type CompanyOperationalStatusCommandInput = z.input<
  typeof companyOperationalStatusCommandInputSchema
>;

export interface CompanyOperationalStatusCommand {
  commandId: string;
  expectedStatus: CompanyOperationalStatus;
  targetStatus: CompanyOperationalStatus;
  reason: string;
  canonicalRequest: string;
  requestHash: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

async function sha256TextHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildCompanyOperationalStatusCommand(
  input: CompanyOperationalStatusCommandInput,
): Promise<CompanyOperationalStatusCommand> {
  const parsed = companyOperationalStatusCommandInputSchema.parse(input);
  const commandId = parsed.commandId ?? crypto.randomUUID();
  const canonicalRequest = JSON.stringify(
    canonicalize({
      action: 'company.operational_status.set',
      payload: {
        expectedStatus: parsed.expectedStatus,
        reason: parsed.reason,
        targetStatus: parsed.targetStatus,
      },
    }),
  );
  return {
    commandId,
    expectedStatus: parsed.expectedStatus,
    targetStatus: parsed.targetStatus,
    reason: parsed.reason,
    canonicalRequest,
    requestHash: await sha256TextHex(canonicalRequest),
  };
}
