import { z } from 'zod';
import type { SandboxSetupInput } from './model';

const supportedServiceCodeSchema = z.enum([
  'pressure-wash-flatwork',
  'soft-wash-house',
  'gutter-cleaning',
  'roof-washing',
  'window-cleaning',
]);

const printableName = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    'Name contains a control character.',
  );

export const liveSetupInputSchema = z
  .object({
    businessName: printableName,
    ownerName: printableName,
    homePostalCode: z
      .string()
      .trim()
      .regex(/^\d{5}$/u),
    timezone: z.literal('America/Chicago'),
    enabledServiceCodes: z.array(supportedServiceCodeSchema).min(1).max(5),
    policyAcknowledged: z.literal(true),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.enabledServiceCodes).size !== input.enabledServiceCodes.length) {
      context.addIssue({
        code: 'custom',
        path: ['enabledServiceCodes'],
        message: 'Service codes must be unique.',
      });
    }
  })
  .transform((input) => ({
    ...input,
    enabledServiceCodes: [...input.enabledServiceCodes].sort(),
  })) satisfies z.ZodType<SandboxSetupInput>;

export const liveSetupStateSchema = z
  .object({
    schemaVersion: z.literal('storyops-setup-state-v1'),
    status: z.enum(['required', 'ready']),
    userId: z.string().uuid(),
    companyId: z.string().uuid().nullable(),
    requestedCompanyId: z.string().uuid().nullable(),
    companyName: z.string().min(1).optional(),
    role: z.enum(['owner', 'dispatcher', 'technician', 'customer']).nullable(),
    setupComplete: z.boolean(),
    requiresLaunchReview: z.literal(true),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.status === 'ready') {
      if (!state.setupComplete || !state.companyId || !state.role) {
        context.addIssue({
          code: 'custom',
          message: 'A ready setup state requires company, role, and completion evidence.',
        });
      }
    } else if (state.setupComplete) {
      context.addIssue({
        code: 'custom',
        message: 'A setup-required state cannot claim completion.',
      });
    }
  });

export const liveSetupReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-live-setup-v1'),
    status: z.literal('configured'),
    companyId: z.string().uuid(),
    role: z.literal('owner'),
    companyStatus: z.literal('setup'),
    setupComplete: z.literal(true),
    requiresLaunchReview: z.literal(true),
    replayed: z.boolean(),
    commandId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    serviceCount: z.number().int().min(1).max(5),
    availableServiceCount: z.literal(5),
    integrationsDisabled: z.literal(11),
    serverTime: z.string(),
  })
  .strict();

export type LiveSetupState = z.infer<typeof liveSetupStateSchema>;
export type LiveSetupReceipt = z.infer<typeof liveSetupReceiptSchema>;

export function canonicalLiveSetupPayload(input: SandboxSetupInput): SandboxSetupInput {
  return liveSetupInputSchema.parse(input);
}

export async function stableLiveSetupCommandId(userId: string, companyId: string): Promise<string> {
  const user = z.string().uuid().parse(userId);
  const company = z.string().uuid().parse(companyId);
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`storyops-live-setup-v1\u001f${company}\u001f${user}`),
    ),
  ).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
