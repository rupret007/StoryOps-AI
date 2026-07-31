import { z } from 'zod';

const uuidSchema = z.string().uuid();
const checklistCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,79}$/u);

function canonicalArray<T extends string>(itemSchema: z.ZodType<T>, label: string): z.ZodType<T[]> {
  return z
    .array(itemSchema)
    .max(50)
    .refine((values) => new Set(values).size === values.length, `${label} must be unique.`)
    .refine(
      (values) => values.every((value, index) => index === 0 || values[index - 1]! < value),
      `${label} must use canonical sort order.`,
    );
}

export const estimateScopeEvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal('storyops-estimate-scope-evidence-v1'),
    eligible: z.boolean(),
    reason: z
      .enum([
        'request_missing',
        'request_inactive_or_incomplete',
        'unsupported_checklist',
        'confirmed_review_required',
        'unresolved_unknowns',
        'required_views_incomplete',
        'measurement_evidence_incomplete',
      ])
      .nullable(),
    requestId: uuidSchema.nullable(),
    requestVersion: z.number().int().positive().nullable(),
    requestStatus: z.enum(['open', 'submitted', 'reviewed', 'expired', 'cancelled']).nullable(),
    reviewId: uuidSchema.nullable(),
    reviewedAt: z.string().datetime({ offset: true }).nullable(),
    reviewDisposition: z
      .enum(['confirmed_for_estimate', 'site_verification_required', 'more_photos_required'])
      .nullable(),
    checklistVersion: z.string().min(1).max(80).nullable(),
    checklistCodes: canonicalArray(checklistCodeSchema, 'Checklist codes'),
    requiredChecklistCodes: canonicalArray(checklistCodeSchema, 'Required checklist codes'),
    submittedChecklistCodes: canonicalArray(checklistCodeSchema, 'Submitted checklist codes'),
    measurementIds: canonicalArray(uuidSchema, 'Measurement IDs').refine(
      (values) => values.length >= 1,
      'At least one measurement ID is required.',
    ),
    analysisIds: canonicalArray(uuidSchema, 'Analysis IDs'),
    unresolvedUnknowns: z.array(z.string().min(1).max(500)).max(50),
  })
  .strict()
  .superRefine((bundle, context) => {
    if (!bundle.eligible) {
      if (bundle.reason === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason'],
          message: 'An ineligible bundle must explain why it is blocked.',
        });
      }
      return;
    }
    if (
      bundle.reason !== null ||
      bundle.requestId === null ||
      bundle.requestVersion === null ||
      bundle.requestStatus !== 'reviewed' ||
      bundle.reviewId === null ||
      bundle.reviewedAt === null ||
      bundle.reviewDisposition !== 'confirmed_for_estimate' ||
      bundle.checklistVersion !== 'exterior-scope-v2' ||
      bundle.unresolvedUnknowns.length > 0 ||
      bundle.requiredChecklistCodes.length !== 12 ||
      !bundle.requiredChecklistCodes.every((code) => bundle.submittedChecklistCodes.includes(code))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An eligible scope-evidence bundle must be complete and human-confirmed.',
      });
    }
  });

export type EstimateScopeEvidenceBundle = z.infer<typeof estimateScopeEvidenceBundleSchema>;
