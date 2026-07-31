import { z } from 'zod';

const printableText = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) =>
        ![...value].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 31 || codePoint === 127;
        }),
      'Control characters are not allowed.',
    );

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/u);
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Use a real calendar date.');

export const materialSdsDocumentSchema = z
  .object({
    id: z.string().uuid(),
    documentVersion: z.number().int().positive(),
    productName: printableText(2, 120),
    manufacturer: printableText(2, 120),
    revisionDate: isoDateSchema,
    contentType: z.literal('application/pdf'),
    byteSize: z
      .number()
      .int()
      .min(5)
      .max(10 * 1024 * 1024),
    checksumSha256: sha256Schema,
    storageObjectPath: z.string().min(1).max(500),
    reviewedAt: z.string().datetime({ offset: true }),
    reviewedByUserId: z.string().uuid(),
    reviewReference: printableText(5, 240),
    configurationRevision: z.number().int().positive(),
    configurationHash: sha256Schema,
    baselineId: z.string().uuid().nullable(),
    baselineHash: sha256Schema.nullable(),
  })
  .strict();

export const materialSdsRegistryEntrySchema = z
  .object({
    materialId: z.string().uuid().nullable(),
    materialVersion: z.number().int().positive().nullable(),
    configurationKey: identifierSchema,
    configurationRevision: z.number().int().positive(),
    configurationHash: sha256Schema,
    baselineId: z.string().uuid().nullable(),
    baselineHash: sha256Schema.nullable(),
    name: printableText(2, 100),
    unit: z.enum(['oz', 'gal', 'lb', 'each']),
    requiresSds: z.boolean(),
    active: z.boolean(),
    registrationStatus: z.enum(['not_required', 'registration_required', 'registered']),
    expectedChecksumSha256: sha256Schema.nullable(),
    sdsDocument: materialSdsDocumentSchema.nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if ((entry.materialId === null) !== (entry.materialVersion === null)) {
      context.addIssue({
        code: 'custom',
        path: ['materialId'],
        message: 'Material identity and version must appear together.',
      });
    }
    if ((entry.baselineId === null) !== (entry.baselineHash === null)) {
      context.addIssue({
        code: 'custom',
        path: ['baselineId'],
        message: 'Baseline identity and hash must appear together.',
      });
    }
    if (!entry.requiresSds && entry.registrationStatus !== 'not_required') {
      context.addIssue({
        code: 'custom',
        path: ['registrationStatus'],
        message: 'Non-chemical materials cannot claim SDS registration.',
      });
    }
    if (
      entry.requiresSds &&
      (entry.expectedChecksumSha256 === null ||
        (entry.registrationStatus === 'registered') !== (entry.sdsDocument !== null))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sdsDocument'],
        message: 'Required SDS state must include the exact configured checksum and registration.',
      });
    }
  });

export const materialSdsRegistryStateSchema = z
  .object({
    schemaVersion: z.literal('storyops-material-sds-registry-v1'),
    companyId: z.string().uuid(),
    baselineId: z.string().uuid().nullable(),
    baselineHash: sha256Schema.nullable(),
    configurationRevision: z.number().int().positive(),
    configurationHash: sha256Schema,
    materials: z.array(materialSdsRegistryEntrySchema).max(100),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export type MaterialSdsRegistryState = z.infer<typeof materialSdsRegistryStateSchema>;
export type MaterialSdsRegistryEntry = z.infer<typeof materialSdsRegistryEntrySchema>;

export interface RegisterMaterialSdsInput {
  materialConfigurationKey: string;
  file: Blob;
  productName: string;
  manufacturer: string;
  revisionDate: string;
  reviewReference: string;
  commandId?: string;
}

export interface NormalizedSdsRegistrationMetadata {
  materialConfigurationKey: string;
  productName: string;
  manufacturer: string;
  revisionDate: string;
  reviewReference: string;
  contentType: 'application/pdf';
  byteSize: number;
  checksumSha256: string;
}

export function normalizeSdsRegistrationMetadata(input: {
  materialConfigurationKey: string;
  productName: string;
  manufacturer: string;
  revisionDate: string;
  reviewReference: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
}): NormalizedSdsRegistrationMetadata {
  return z
    .object({
      materialConfigurationKey: identifierSchema,
      productName: printableText(2, 120),
      manufacturer: printableText(2, 120),
      revisionDate: isoDateSchema,
      reviewReference: printableText(5, 240),
      contentType: z.literal('application/pdf'),
      byteSize: z
        .number()
        .int()
        .min(5)
        .max(10 * 1024 * 1024),
      checksumSha256: sha256Schema,
    })
    .strict()
    .parse(input);
}

export function sdsRegistrationRequestHashMaterial(
  companyId: string,
  input: NormalizedSdsRegistrationMetadata,
): string {
  z.string().uuid().parse(companyId);
  return [
    'storyops-material-sds-registration-v1',
    companyId,
    input.materialConfigurationKey,
    input.productName,
    input.manufacturer,
    input.revisionDate,
    input.contentType,
    String(input.byteSize),
    input.checksumSha256,
    input.reviewReference,
  ].join('\u001f');
}

export async function reviewedSdsPdfChecksum(file: Blob): Promise<string> {
  if (file.type !== 'application/pdf' || file.size < 5 || file.size > 10 * 1024 * 1024) {
    throw new Error('The reviewed SDS must be a PDF between 5 bytes and 10 MB.');
  }
  const contents = await file.arrayBuffer();
  const signature = new Uint8Array(contents, 0, 5);
  if (
    signature[0] !== 0x25 ||
    signature[1] !== 0x50 ||
    signature[2] !== 0x44 ||
    signature[3] !== 0x46 ||
    signature[4] !== 0x2d
  ) {
    throw new Error('The reviewed SDS does not have a valid PDF file signature.');
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', contents));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const preparedSdsRegistrationReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-material-sds-registration-v1'),
    status: z.enum(['prepared', 'registered']),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: sha256Schema,
    registrationRequestId: z.string().uuid(),
    materialId: z.string().uuid().nullable(),
    materialConfigurationKey: identifierSchema,
    materialVersion: z.number().int().positive().nullable(),
    configurationRevision: z.number().int().positive(),
    configurationHash: sha256Schema,
    baselineId: z.string().uuid().nullable(),
    baselineHash: sha256Schema.nullable(),
    documentVersion: z.number().int().positive(),
    objectPath: z.string().min(1).max(500),
    contentType: z.literal('application/pdf'),
    byteSize: z
      .number()
      .int()
      .min(5)
      .max(10 * 1024 * 1024),
    checksumSha256: sha256Schema,
    expiresAt: z.string().datetime({ offset: true }),
    sdsDocumentId: z.string().uuid().nullable(),
    replayed: z.boolean(),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export const finalizedSdsRegistrationReceiptSchema = preparedSdsRegistrationReceiptSchema.extend({
  status: z.literal('registered'),
  sdsDocumentId: z.string().uuid(),
});

export const sdsUploadAttestationReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-sds-upload-attestation-v1'),
    status: z.literal('attested'),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: sha256Schema,
    registrationRequestId: z.string().uuid(),
    objectPath: z.string().min(1).max(500),
    contentType: z.literal('application/pdf'),
    byteSize: z
      .number()
      .int()
      .min(5)
      .max(10 * 1024 * 1024),
    checksumSha256: sha256Schema,
    attestedAt: z.string().datetime({ offset: true }),
    replayed: z.boolean(),
  })
  .strict();

export type FinalizedSdsRegistrationReceipt = z.infer<typeof finalizedSdsRegistrationReceiptSchema>;
