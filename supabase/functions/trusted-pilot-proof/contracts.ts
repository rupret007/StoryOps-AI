import { z } from 'zod';

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceReferenceSchema = z
  .string()
  .min(5)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{4,119}$/u);

export const providerCanaryTargets = {
  openai: ['structured_ai', 'photo_analysis'],
  twilio: ['sms_voice'],
  email: ['email'],
  supabase_auth: ['identity_invitation'],
  stripe: ['payments'],
  google_calendar: ['calendar'],
  maps: ['geocoding'],
  nws: ['weather'],
  vroom: ['routing'],
  signed_storage_targets: ['server_signed_targets'],
  quickbooks_export: ['accounting_export'],
} as const;

const providerSchema = z.enum([
  'openai',
  'twilio',
  'email',
  'supabase_auth',
  'stripe',
  'google_calendar',
  'maps',
  'nws',
  'vroom',
  'signed_storage_targets',
  'quickbooks_export',
]);

const common = {
  companyId: uuidSchema,
  commandId: uuidSchema,
  requestedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
};

const providerCanaryRequestSchema = z
  .object({
    operation: z.literal('provider_canary'),
    ...common,
    provider: providerSchema,
    capability: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/u),
  })
  .strict()
  .superRefine((request, context) => {
    const supported = providerCanaryTargets[request.provider] as readonly string[];
    if (!supported.includes(request.capability)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capability'],
        message: 'Capability is not provided by the selected adapter.',
      });
    }
  });

const fieldMediaCanaryRequestSchema = z
  .object({
    operation: z.literal('field_media_canary_start'),
    ...common,
    fieldWorkerUserId: uuidSchema,
  })
  .strict();

const fieldMediaCanaryCompleteRequestSchema = z
  .object({
    operation: z.literal('field_media_canary_complete'),
    companyId: uuidSchema,
    commandId: uuidSchema,
    verificationRunId: uuidSchema,
    requestedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const isolatedRestoreEvidenceSchema = z
  .object({
    schemaVersion: z.literal('storyops-isolated-restore-evidence-v2'),
    restoreCommandId: uuidSchema,
    evidenceReference: evidenceReferenceSchema,
    isolationId: evidenceReferenceSchema,
    status: z.literal('committed'),
    isolatedTarget: z.literal(true),
    sourceManifestSha256: sha256Schema,
    restoredDatabaseSha256: sha256Schema,
    verifiedMigrationId: z.literal('20260728530000'),
    sourceDatabaseSystemIdentifier: z.string().regex(/^[1-9][0-9]{0,19}$/u),
    targetDatabaseSystemIdentifier: z.string().regex(/^[1-9][0-9]{0,19}$/u),
    sourceStorageHost: z
      .string()
      .min(3)
      .max(255)
      .regex(/^[A-Za-z0-9.:[\]-]+$/u),
    targetStorageHost: z
      .string()
      .min(3)
      .max(255)
      .regex(/^[A-Za-z0-9.:[\]-]+$/u),
    storageVerification: z
      .object({
        schemaVersion: z.literal('storyops-storage-byte-verification-v1'),
        objectCount: z.number().int().positive().safe(),
        byteCount: z.number().int().positive().safe(),
        fingerprintSha256: sha256Schema,
      })
      .strict(),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.sourceDatabaseSystemIdentifier === evidence.targetDatabaseSystemIdentifier) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetDatabaseSystemIdentifier'],
        message: 'Restore target must be a different database system.',
      });
    }
    if (evidence.sourceStorageHost === evidence.targetStorageHost) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetStorageHost'],
        message: 'Restore target must use a different Storage endpoint.',
      });
    }
  });

const backupRestoreRequestSchema = z
  .object({
    operation: z.literal('backup_restore'),
    ...common,
    restoreEvidence: isolatedRestoreEvidenceSchema,
  })
  .strict();

export const trustedPilotProofRequestSchema = z
  .discriminatedUnion('operation', [
    providerCanaryRequestSchema,
    fieldMediaCanaryRequestSchema,
    fieldMediaCanaryCompleteRequestSchema,
    backupRestoreRequestSchema,
  ])
  .superRefine((request, context) => {
    const observedAt = Date.parse(request.requestedAt);
    if ('expiresAt' in request) {
      const expiresAt = Date.parse(request.expiresAt);
      const maximumDays = request.operation === 'provider_canary' ? 7 : 30;
      if (
        !Number.isFinite(observedAt) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= observedAt ||
        expiresAt > observedAt + maximumDays * 24 * 60 * 60_000
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expiresAt'],
          message: `Evidence expiry must be after requestedAt and within ${maximumDays} days.`,
        });
      }
    }
    if (
      request.operation === 'backup_restore' &&
      request.restoreEvidence.completedAt !== request.requestedAt
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedAt'],
        message: 'Restore requestedAt must equal the signed restore completion time.',
      });
    }
  });

export type TrustedPilotProofRequest = z.infer<typeof trustedPilotProofRequestSchema>;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signedRestoreProofMaterial(
  request: Extract<TrustedPilotProofRequest, { operation: 'backup_restore' }>,
): string {
  return `storyops-signed-isolated-restore-proof-v2\u001f${canonicalJson(request)}`;
}

export function trustedVerificationRequestMaterial(request: TrustedPilotProofRequest): string {
  return `storyops-trusted-verification-request-v1\u001f${canonicalJson(request)}`;
}
