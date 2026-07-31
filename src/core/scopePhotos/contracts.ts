import { z } from 'zod';

export const SCOPE_PHOTO_MAX_COUNT = 12;
export const SCOPE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const SCOPE_PHOTO_ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const decimalSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/u);
const idempotencyKeySchema = z.string().min(8).max(256);
const scopePhotoContentTypeSchema = z.enum(SCOPE_PHOTO_ALLOWED_CONTENT_TYPES);

export const scopePhotoChecklistItemSchema = z
  .object({
    code: z.string().min(1).max(80),
    label: z.string().min(1).max(160),
    guidance: z.string().min(1).max(500),
    required: z.boolean(),
    maximumPhotos: z.number().int().min(1).max(3),
    sortOrder: z.number().int().min(0).max(100),
  })
  .strict();

export const scopeEvidenceFlagSchema = z
  .object({
    code: z.string().min(1).max(80),
    label: z.string().min(1).max(160),
    evidence: z.string().min(1).max(1_000),
    confidence: z.number().min(0).max(1),
    status: z.enum(['observed', 'possible', 'unknown']),
  })
  .strict();

export const scopeMeasurementCandidateSchema = z
  .object({
    dimension: z.enum(['area_sq_ft', 'length_linear_ft', 'count', 'stories']),
    value: decimalSchema.nullable(),
    confidence: z.number().min(0).max(1),
    scaleReference: z.string().min(1).max(500).nullable(),
    sourceAssetId: uuidSchema.optional(),
    sourceAssetIds: z.array(uuidSchema).optional(),
  })
  .passthrough();

export const scopePhotoAnalysisSchema = z
  .object({
    id: uuidSchema,
    sourceAssetId: uuidSchema,
    overallConfidence: z.string(),
    disposition: z.enum(['usable_for_scope', 'human_review_required', 'insufficient']),
    observations: z.array(
      z
        .object({
          label: z.string(),
          evidence: z.string(),
          confidence: z.number(),
          sourceAssetId: uuidSchema.optional(),
        })
        .passthrough(),
    ),
    measurementCandidates: z.array(scopeMeasurementCandidateSchema),
    accessFlags: z.array(scopeEvidenceFlagSchema),
    riskFlags: z.array(scopeEvidenceFlagSchema),
    unknowns: z.array(z.string()),
    injectionSignals: z.array(z.string()),
    analyzedAt: z.string(),
  })
  .strict();

export const scopePhotoSubmissionSchema = z
  .object({
    id: uuidSchema,
    requestId: uuidSchema,
    checklistItemCode: z.string(),
    assetId: uuidSchema,
    contentType: scopePhotoContentTypeSchema,
    byteSize: z.number().int().positive().max(SCOPE_PHOTO_MAX_BYTES),
    checksumSha256: sha256Schema,
    capturedAt: z.string(),
    uploadedBy: uuidSchema,
    analysis: scopePhotoAnalysisSchema.nullable(),
  })
  .strict();

export const scopePhotoReviewSchema = z
  .object({
    id: uuidSchema,
    requestId: uuidSchema,
    disposition: z.enum([
      'confirmed_for_estimate',
      'site_verification_required',
      'more_photos_required',
    ]),
    accessDecision: z.string(),
    riskDecision: z.string(),
    unresolvedUnknowns: z.array(z.string()),
    reviewedBy: uuidSchema,
    reviewedAt: z.string(),
  })
  .strict();

export const scopePhotoRequestRecordSchema = z
  .object({
    id: uuidSchema,
    companyId: uuidSchema,
    customerId: uuidSchema,
    propertyId: uuidSchema,
    status: z.enum(['open', 'submitted', 'reviewed', 'expired', 'cancelled']),
    checklistVersion: z.string(),
    checklist: z.array(scopePhotoChecklistItemSchema).min(1).max(SCOPE_PHOTO_MAX_COUNT),
    note: z.string(),
    maximumPhotos: z.number().int().min(1).max(SCOPE_PHOTO_MAX_COUNT),
    photoCount: z.number().int().min(0).max(SCOPE_PHOTO_MAX_COUNT),
    completedItemCodes: z.array(z.string()),
    expiresAt: z.string(),
    createdAt: z.string(),
    review: scopePhotoReviewSchema.nullable(),
  })
  .strict();

export const scopePhotoContextSchema = z
  .object({
    schemaVersion: z.literal('storyops-scope-photo-context-v1'),
    companyId: uuidSchema,
    propertyId: uuidSchema,
    actorRole: z.enum(['owner', 'dispatcher', 'customer']),
    requests: z.array(scopePhotoRequestRecordSchema),
    submissions: z.array(scopePhotoSubmissionSchema),
    confirmedMeasurements: z.array(
      z
        .object({
          id: uuidSchema,
          requestId: uuidSchema,
          analysisId: uuidSchema.nullable(),
          label: z.string(),
          kind: z.enum([
            'area_sq_ft',
            'length_linear_ft',
            'height_ft',
            'count',
            'stories',
            'duration_hours',
          ]),
          value: z.string(),
          unit: z.enum(['sq_ft', 'linear_ft', 'ft', 'each', 'story', 'hour']),
          serviceCodes: z.array(z.string()),
          addOnCodes: z.array(z.string()),
          sourceAssetIds: z.array(uuidSchema),
          confirmationNote: z.string(),
          confirmedBy: uuidSchema,
          confirmedAt: z.string(),
        })
        .strict(),
    ),
    serverTime: z.string(),
  })
  .strict();

export type ScopePhotoContext = z.infer<typeof scopePhotoContextSchema>;
export type ScopePhotoContentType = z.infer<typeof scopePhotoContentTypeSchema>;

const baseRequestSchema = z.object({
  companyId: uuidSchema,
});

export const scopePhotoWorkflowRequestSchema = z.discriminatedUnion('operation', [
  baseRequestSchema
    .extend({
      operation: z.literal('context'),
      propertyId: uuidSchema,
    })
    .strict(),
  baseRequestSchema
    .extend({
      operation: z.literal('create_request'),
      customerId: uuidSchema,
      propertyId: uuidSchema,
      note: z.string().trim().max(500).default(''),
      expiresInDays: z.number().int().min(1).max(14).default(7),
      idempotencyKey: idempotencyKeySchema,
    })
    .strict(),
  baseRequestSchema
    .extend({
      operation: z.literal('prepare_upload'),
      requestId: uuidSchema,
      checklistItemCode: z.string().min(1).max(80),
      assetId: uuidSchema,
      contentType: scopePhotoContentTypeSchema,
      byteSize: z.number().int().min(1).max(SCOPE_PHOTO_MAX_BYTES),
      checksumSha256: sha256Schema,
      capturedAt: z.string().datetime({ offset: true }),
      idempotencyKey: uuidSchema,
    })
    .strict(),
  baseRequestSchema
    .extend({
      operation: z.literal('finalize_upload'),
      requestId: uuidSchema,
      idempotencyKey: uuidSchema,
    })
    .strict(),
  baseRequestSchema
    .extend({
      operation: z.literal('confirm_measurement'),
      requestId: uuidSchema,
      analysisId: uuidSchema.nullable(),
      sourceAssetIds: z.array(uuidSchema).min(1).max(SCOPE_PHOTO_MAX_COUNT),
      kind: z.enum([
        'area_sq_ft',
        'length_linear_ft',
        'height_ft',
        'count',
        'stories',
        'duration_hours',
      ]),
      label: z.string().trim().min(2).max(160),
      value: decimalSchema.refine((value) => Number(value) > 0, 'Measurement must be positive.'),
      unit: z.enum(['sq_ft', 'linear_ft', 'ft', 'each', 'story', 'hour']),
      serviceCodes: z.array(z.string().min(1).max(120)).max(5),
      addOnCodes: z.array(z.string().min(1).max(120)).max(10),
      confirmationNote: z.string().trim().min(10).max(1_000),
      idempotencyKey: idempotencyKeySchema,
    })
    .strict()
    .superRefine((input, context) => {
      const expectedUnit: Record<string, string> = {
        area_sq_ft: 'sq_ft',
        length_linear_ft: 'linear_ft',
        height_ft: 'ft',
        count: 'each',
        stories: 'story',
        duration_hours: 'hour',
      };
      if (expectedUnit[input.kind] !== input.unit) {
        context.addIssue({
          code: 'custom',
          path: ['unit'],
          message: 'Measurement kind and unit do not match.',
        });
      }
      if (['count', 'stories'].includes(input.kind) && !Number.isInteger(Number(input.value))) {
        context.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'Count and story measurements must be whole numbers.',
        });
      }
      if (input.serviceCodes.length === 0 && input.addOnCodes.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['serviceCodes'],
          message: 'A human must classify the measurement for a service or add-on.',
        });
      }
    }),
  baseRequestSchema
    .extend({
      operation: z.literal('review_scope'),
      requestId: uuidSchema,
      disposition: z.enum([
        'confirmed_for_estimate',
        'site_verification_required',
        'more_photos_required',
      ]),
      accessDecision: z.string().trim().min(10).max(1_000),
      riskDecision: z.string().trim().min(10).max(1_000),
      unresolvedUnknowns: z.array(z.string().trim().min(1).max(500)).max(50),
      idempotencyKey: idempotencyKeySchema,
    })
    .strict(),
]);

export const preparedScopePhotoUploadSchema = z
  .object({
    schemaVersion: z.literal('storyops-scope-photo-upload-v1'),
    commandId: uuidSchema,
    requestId: uuidSchema,
    assetId: uuidSchema,
    objectPath: z.string().min(1).max(500),
    token: z.string().min(1),
    expiresAt: z.string(),
    replayed: z.boolean(),
  })
  .strict();

export const scopePhotoRequestReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-scope-photo-request-v1'),
    requestId: uuidSchema,
    propertyId: uuidSchema,
    customerId: uuidSchema,
    status: z.literal('open'),
    checklistVersion: z.string(),
    maximumPhotos: z.number().int().min(1).max(SCOPE_PHOTO_MAX_COUNT),
    replayed: z.boolean(),
    serverTime: z.string(),
  })
  .strict();

export const finalizedScopePhotoUploadSchema = z
  .object({
    schemaVersion: z.literal('storyops-scope-photo-finalized-v1'),
    commandId: uuidSchema,
    requestId: uuidSchema,
    submissionId: uuidSchema,
    assetId: uuidSchema,
    version: z.number().int().positive(),
    replayed: z.boolean(),
    serverTime: z.string(),
  })
  .strict();

export const confirmedScopeMeasurementSchema = z
  .object({
    schemaVersion: z.literal('storyops-scope-measurement-v1'),
    commandId: z.string(),
    requestId: uuidSchema,
    measurementId: uuidSchema,
    version: z.number().int().positive(),
    replayed: z.boolean(),
    serverTime: z.string(),
  })
  .strict();

export const reviewedScopePhotoRequestSchema = z
  .object({
    schemaVersion: z.literal('storyops-scope-review-v1'),
    commandId: z.string(),
    requestId: uuidSchema,
    reviewId: uuidSchema,
    replayed: z.boolean(),
    serverTime: z.string(),
  })
  .strict();

export function assertScopePhotoFile(file: Pick<File, 'size' | 'type'>): ScopePhotoContentType {
  const parsedType = scopePhotoContentTypeSchema.safeParse(file.type);
  if (!parsedType.success) {
    throw new Error('Use a JPEG, PNG, or WebP image.');
  }
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > SCOPE_PHOTO_MAX_BYTES) {
    throw new Error('Each scope photo must be between 1 byte and 10 MiB.');
  }
  return parsedType.data;
}

export async function sha256File(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
