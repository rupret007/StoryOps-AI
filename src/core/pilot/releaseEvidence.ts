import { z } from 'zod';

export const pilotEvidenceKindSchema = z.enum([
  'provider_canary',
  'field_media_canary',
  'backup_restore',
]);

export const pilotEvidenceProviderSchema = z.enum([
  'openai',
  'twilio',
  'email',
  'stripe',
  'google_calendar',
  'maps',
  'nws',
  'vroom',
  'storage',
  'signed_storage_targets',
  'quickbooks_export',
]);

export const pilotEvidenceAttestationSourceSchema = z.enum([
  'external_provider_receipt',
  'storage_roundtrip',
  'isolated_restore_drill',
]);

export const pilotEvidenceSourceSchema = z.enum([
  ...pilotEvidenceAttestationSourceSchema.options,
  'external_provider_read_canary',
  'deterministic_local_canary',
  'authenticated_field_media_roundtrip',
  'signed_isolated_restore_drill',
]);

export const pilotEvidenceVerificationBasisSchema = z.enum([
  'owner_attestation',
  'trusted_system_proof',
]);

const opaqueIdentifier = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .regex(
      new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{${minimum - 1},${maximum - 1}}$`, 'u'),
      'Use only letters, numbers, periods, underscores, and hyphens.',
    )
    .refine(
      (value) =>
        !/(?:^|[._-])(?:secret|password|token|bearer|api[._-]?key|access[._-]?key|private[._-]?key)(?:[._-]|$)|^(?:sk|pk)_(?:live|test)_|^sk-proj-|^whsec_|^eyJ/iu.test(
          value,
        ),
      'Credential-like identifiers are not allowed.',
    );

export const pilotEvidenceBindingSchema = z
  .object({
    configurationRevision: z.number().int().positive(),
    configurationHash: z.string().regex(/^[a-f0-9]{64}$/u),
    baselineId: z.string().uuid(),
    baselineHash: z.string().regex(/^[a-f0-9]{64}$/u),
    capability: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/u),
    integrationProvider: pilotEvidenceProviderSchema.optional(),
    integrationVersion: z.number().int().positive().optional(),
    verificationRunId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
    mediaAssetId: z.string().uuid().optional(),
    fieldWorkerRole: z.enum(['technician', 'owner_field_worker']).optional(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (Boolean(binding.integrationProvider) !== Boolean(binding.integrationVersion)) {
      context.addIssue({
        code: 'custom',
        path: ['integrationProvider'],
        message: 'Integration provider and version bindings must be supplied together.',
      });
    }
  });

export const pilotReleaseEvidenceInputSchema = z
  .object({
    kind: pilotEvidenceKindSchema,
    provider: pilotEvidenceProviderSchema.optional(),
    outcome: z.enum(['passed', 'failed']),
    source: pilotEvidenceAttestationSourceSchema,
    evidenceReference: opaqueIdentifier(5, 120),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    observedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    reviewNote: opaqueIdentifier(10, 120),
  })
  .strict()
  .superRefine((input, context) => {
    const expectedSource =
      input.kind === 'provider_canary'
        ? 'external_provider_receipt'
        : input.kind === 'field_media_canary'
          ? 'storage_roundtrip'
          : 'isolated_restore_drill';
    if (input.source !== expectedSource) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: `${input.kind} evidence must use ${expectedSource}.`,
      });
    }
    if ((input.kind === 'provider_canary') !== Boolean(input.provider)) {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'Only provider canaries require a provider.',
      });
    }
    const observedAt = Date.parse(input.observedAt);
    const expiresAt = Date.parse(input.expiresAt);
    if (expiresAt <= observedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Release evidence must expire after it was observed.',
      });
    }
    const maximumAgeDays = input.kind === 'provider_canary' ? 7 : 30;
    if (expiresAt - observedAt > maximumAgeDays * 24 * 60 * 60_000) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: `${input.kind} evidence cannot remain current for more than ${maximumAgeDays} days.`,
      });
    }
  });

export const pilotReleaseEvidenceRecordSchema = z
  .object({
    kind: pilotEvidenceKindSchema,
    provider: pilotEvidenceProviderSchema.optional(),
    outcome: z.enum(['passed', 'failed']),
    source: pilotEvidenceSourceSchema,
    evidenceReference: opaqueIdentifier(5, 120),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    observedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    reviewNote: opaqueIdentifier(10, 120),
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    reviewedByUserId: z.string().uuid(),
    verificationBasis: pilotEvidenceVerificationBasisSchema,
    binding: pilotEvidenceBindingSchema.optional(),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, context) => {
    const ownerSource =
      record.kind === 'provider_canary'
        ? 'external_provider_receipt'
        : record.kind === 'field_media_canary'
          ? 'storage_roundtrip'
          : 'isolated_restore_drill';
    const trustedSources =
      record.kind === 'provider_canary'
        ? record.provider === 'quickbooks_export'
          ? ['deterministic_local_canary']
          : ['external_provider_read_canary']
        : record.kind === 'field_media_canary'
          ? ['authenticated_field_media_roundtrip']
          : ['signed_isolated_restore_drill'];
    if (
      (record.verificationBasis === 'owner_attestation' && record.source !== ownerSource) ||
      (record.verificationBasis === 'trusted_system_proof' &&
        !trustedSources.includes(record.source))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'Evidence source does not match its kind and verification basis.',
      });
    }
    const providerShapeValid =
      record.kind === 'provider_canary'
        ? Boolean(record.provider)
        : record.kind === 'field_media_canary' &&
            record.verificationBasis === 'trusted_system_proof'
          ? ['storage', 'signed_storage_targets'].includes(record.provider ?? '')
          : record.provider === undefined;
    if (!providerShapeValid) {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'Evidence provider does not match its kind and verification basis.',
      });
    }
    const observedAt = Date.parse(record.observedAt);
    const expiresAt = Date.parse(record.expiresAt);
    const maximumAgeDays = record.kind === 'provider_canary' ? 7 : 30;
    if (expiresAt <= observedAt || expiresAt - observedAt > maximumAgeDays * 24 * 60 * 60_000) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Evidence expiry is outside its allowed verification window.',
      });
    }
    if (record.verificationBasis === 'owner_attestation' && record.binding) {
      context.addIssue({
        code: 'custom',
        path: ['binding'],
        message: 'Owner attestations cannot claim a trusted system binding.',
      });
    }
    if (record.verificationBasis === 'trusted_system_proof' && !record.binding) {
      context.addIssue({
        code: 'custom',
        path: ['binding'],
        message: 'Trusted system proof requires an immutable release binding.',
      });
      return;
    }
    if (!record.binding) return;
    if (record.verificationBasis === 'trusted_system_proof' && !record.binding.verificationRunId) {
      context.addIssue({
        code: 'custom',
        path: ['binding', 'verificationRunId'],
        message: 'Trusted system proof must identify its immutable verification run.',
      });
    }
    if (
      record.kind === 'provider_canary' &&
      (record.binding.integrationProvider !== record.provider ||
        record.binding.integrationVersion === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['binding'],
        message: 'Provider proof must bind the exact provider and integration version.',
      });
    }
    if (
      record.kind === 'field_media_canary' &&
      (!['storage', 'signed_storage_targets'].includes(record.binding.integrationProvider ?? '') ||
        !record.binding.visitId ||
        !record.binding.mediaAssetId ||
        !record.binding.fieldWorkerRole)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['binding', 'integrationProvider'],
        message: 'Field-media proof must bind the current private-storage integration.',
      });
    }
    if (
      record.kind === 'backup_restore' &&
      (record.binding.integrationProvider !== undefined ||
        record.binding.capability !== 'isolated_database_restore')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['binding'],
        message: 'Restore proof must bind the isolated_database_restore capability only.',
      });
    }
  });

export const pilotReleaseEvidenceStateSchema = z
  .object({
    schemaVersion: z.literal('storyops-pilot-evidence-state-v1'),
    companyId: z.string().uuid(),
    records: z.array(pilotReleaseEvidenceRecordSchema).max(200),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export const pilotReleaseEvidenceReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-pilot-evidence-receipt-v1'),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    record: pilotReleaseEvidenceRecordSchema,
    replayed: z.boolean(),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export type PilotEvidenceKind = z.infer<typeof pilotEvidenceKindSchema>;
export type PilotEvidenceProvider = z.infer<typeof pilotEvidenceProviderSchema>;
export type PilotEvidenceSource = z.infer<typeof pilotEvidenceSourceSchema>;
export type PilotEvidenceVerificationBasis = z.infer<typeof pilotEvidenceVerificationBasisSchema>;
export type PilotEvidenceBinding = z.infer<typeof pilotEvidenceBindingSchema>;
export type PilotReleaseEvidenceInput = z.input<typeof pilotReleaseEvidenceInputSchema>;
export type PilotReleaseEvidenceRecord = z.infer<typeof pilotReleaseEvidenceRecordSchema>;
export type PilotReleaseEvidenceState = z.infer<typeof pilotReleaseEvidenceStateSchema>;
export type PilotReleaseEvidenceReceipt = z.infer<typeof pilotReleaseEvidenceReceiptSchema>;

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

export async function buildPilotReleaseEvidenceCommand(input: {
  companyId: string;
  userId: string;
  evidence: PilotReleaseEvidenceInput;
}): Promise<{
  commandId: string;
  requestHash: string;
  evidence: z.output<typeof pilotReleaseEvidenceInputSchema>;
}> {
  const companyId = z.string().uuid().parse(input.companyId);
  const userId = z.string().uuid().parse(input.userId);
  const parsedEvidence = pilotReleaseEvidenceInputSchema.parse(input.evidence);
  const evidence = {
    ...parsedEvidence,
    observedAt: new Date(parsedEvidence.observedAt).toISOString(),
    expiresAt: new Date(parsedEvidence.expiresAt).toISOString(),
  };
  const requestHash = await sha256(
    [
      'storyops-pilot-release-evidence-v1',
      evidence.kind,
      evidence.provider ?? '',
      evidence.outcome,
      evidence.source,
      evidence.evidenceReference,
      evidence.artifactSha256,
      evidence.observedAt,
      evidence.expiresAt,
      evidence.reviewNote,
    ].join('\u001f'),
  );
  const commandDigest = await sha256(
    `storyops-pilot-evidence-v1\u001f${companyId}\u001f${userId}\u001f${requestHash}`,
  );
  return {
    commandId: digestToUuid(commandDigest),
    requestHash,
    evidence,
  };
}
