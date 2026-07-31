import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const uuidSchema = z.string().uuid();

export const operatingBaselineReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-operating-baseline-receipt-v1'),
    commandType: z.literal('company.operating_baseline.publish'),
    status: z.literal('active'),
    companyId: uuidSchema,
    configurationRevision: z.number().int().positive(),
    configurationHash: sha256Schema,
    baselineId: uuidSchema,
    baselineHash: sha256Schema,
    priceBookId: uuidSchema,
    priceBookVersion: z.string().min(1).max(120),
    serviceTermsId: uuidSchema,
    serviceTermsVersion: z.string().min(1).max(120),
    retentionPolicyId: uuidSchema,
    retentionPolicyVersion: z.string().min(1).max(120),
    serviceCount: z.number().int().positive(),
    packageCount: z.number().int().min(3),
    providersActivated: z.literal(false),
    outboundEnabled: z.literal(false),
    launchAuthorized: z.literal(false),
    reviewReference: z.string().min(5).max(240),
    commandId: uuidSchema,
    requestHash: sha256Schema,
    replayed: z.boolean(),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export const operatingBaselineStateSchema = z
  .object({
    schemaVersion: z.literal('storyops-operating-baseline-state-v1'),
    status: z.literal('active'),
    companyId: uuidSchema,
    configurationRevision: z.number().int().positive(),
    configurationHash: sha256Schema,
    baselineId: uuidSchema,
    baselineHash: sha256Schema,
    priceBookId: uuidSchema,
    serviceTermsId: uuidSchema,
    retentionPolicyId: uuidSchema,
    reviewReference: z.string().min(5).max(240),
    activatedAt: z.string().datetime({ offset: true }),
    providersActivated: z.literal(false),
    outboundEnabled: z.literal(false),
    launchAuthorized: z.boolean(),
    launchVersion: z.number().int().nonnegative(),
    launchStatus: z.enum(['not_authorized', 'authorized', 'invalidated', 'revoked']),
    launchProviderSnapshotHash: sha256Schema.nullable(),
    launchProofSnapshotHash: sha256Schema.nullable(),
  })
  .strict();

export type OperatingBaselineReceipt = z.infer<typeof operatingBaselineReceiptSchema>;
export type OperatingBaselineState = z.infer<typeof operatingBaselineStateSchema>;

export async function buildOperatingBaselineCommand(input: {
  companyId: string;
  userId: string;
  configurationRevision: number;
  reviewReference: string;
}): Promise<{ commandId: string; requestHash: string }> {
  const companyId = uuidSchema.parse(input.companyId);
  const userId = uuidSchema.parse(input.userId);
  const payload = {
    configurationRevision: z.number().int().positive().parse(input.configurationRevision),
    reviewReference: z.string().trim().min(5).max(240).parse(input.reviewReference),
  };
  const requestHash = await sha256(JSON.stringify(canonicalize(payload)));
  const commandDigest = await sha256(
    `storyops-operating-baseline-v1\u001f${companyId}\u001f${userId}\u001f${requestHash}`,
  );
  return {
    commandId: digestToUuid(commandDigest),
    requestHash,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function digestToUuid(digest: string): string {
  const bytes = digest.slice(0, 32).split('');
  bytes[12] = '5';
  const variant = Number.parseInt(bytes[16] ?? '0', 16);
  bytes[16] = ((variant & 0x3) | 0x8).toString(16);
  const value = bytes.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}
