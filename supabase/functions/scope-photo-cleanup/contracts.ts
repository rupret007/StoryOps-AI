import { z } from 'zod';

export const scopePhotoCleanupRequestSchema = z
  .object({
    companyId: z.string().uuid(),
    trigger: z.enum(['manual', 'scheduled']),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();

export const scopePhotoCleanupClaimSchema = z
  .object({
    commandId: z.string().uuid(),
    companyId: z.string().uuid(),
    objectPath: z.string().min(1).max(500),
  })
  .strict();

export const scopePhotoCleanupResponseSchema = z
  .object({
    schemaVersion: z.literal('storyops-scope-photo-cleanup-run-v2'),
    activationMode: z.enum(['manual', 'scheduled']),
    trigger: z.enum(['manual', 'scheduled']),
    status: z.literal('processed'),
    claimed: z.number().int().nonnegative(),
    cleaned: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    empty: z.boolean(),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.cleaned + result.failed !== result.claimed ||
      result.empty !== (result.claimed === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Scope-photo cleanup counts are internally inconsistent.',
      });
    }
  });
