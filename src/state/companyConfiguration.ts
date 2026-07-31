import { z } from 'zod';
import {
  assessCompanyConfiguration,
  companyConfigurationInputSchema,
  type CompanyConfiguration,
  type CompanyConfigurationPublicationMode,
} from '@/domain/companyConfiguration';

export const companyConfigurationIssueSchema = z
  .object({
    section: z.enum([
      'identity',
      'territory',
      'schedule',
      'pricing',
      'people',
      'resources',
      'materials',
      'payments',
      'policies',
      'engagement',
      'integrations',
    ]),
    code: z.string().min(1),
    message: z.string().min(1),
    severity: z.enum(['blocking', 'warning']),
  })
  .strict();

export const companyConfigurationReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-company-config-receipt-v1'),
    commandType: z.enum(['company.configuration.save', 'company.configuration.publish']),
    status: z.enum(['draft', 'published']),
    companyId: z.string().uuid(),
    revision: z.number().int().positive(),
    publicationMode: z.enum(['sandbox', 'live']).optional(),
    configurationHash: z.string().regex(/^[a-f0-9]{64}$/u),
    reviewReference: z.string().min(5).max(240).optional(),
    issues: z.array(companyConfigurationIssueSchema),
    replayed: z.boolean(),
    commandId: z.string().uuid(),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export type CompanyConfigurationReceipt = z.infer<typeof companyConfigurationReceiptSchema>;

export function canonicalCompanyConfiguration(input: unknown): CompanyConfiguration {
  return companyConfigurationInputSchema.parse(input);
}

export async function buildCompanyConfigurationCommand(input: {
  companyId: string;
  userId: string;
  action: 'save' | 'publish';
  expectedRevision: number;
  configuration?: CompanyConfiguration;
  publicationMode?: CompanyConfigurationPublicationMode;
  reviewReference?: string;
}): Promise<{ commandId: string; requestHash: string }> {
  const companyId = z.string().uuid().parse(input.companyId);
  const userId = z.string().uuid().parse(input.userId);
  const payload =
    input.action === 'save'
      ? {
          action: input.action,
          expectedRevision: z.number().int().nonnegative().parse(input.expectedRevision),
          configuration: canonicalCompanyConfiguration(input.configuration),
        }
      : {
          action: input.action,
          expectedRevision: z.number().int().positive().parse(input.expectedRevision),
          publicationMode: z.enum(['sandbox', 'live']).parse(input.publicationMode),
          reviewReference: z.string().trim().min(5).max(240).parse(input.reviewReference),
        };
  const canonicalPayload = JSON.stringify(canonicalize(payload));
  const requestHash = await sha256(canonicalPayload);
  const commandDigest = await sha256(
    `storyops-company-configuration-v1\u001f${companyId}\u001f${userId}\u001f${requestHash}`,
  );
  return {
    commandId: digestToUuid(commandDigest),
    requestHash,
  };
}

export function assertConfigurationPublishable(
  configuration: CompanyConfiguration,
  mode: CompanyConfigurationPublicationMode,
): void {
  const readiness = assessCompanyConfiguration(configuration, mode);
  if (!readiness.publishable) {
    const details = readiness.issues
      .filter((issue) => issue.severity === 'blocking')
      .map((issue) => issue.message)
      .join(' ');
    throw new Error(`Configuration publication is blocked. ${details}`);
  }
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
