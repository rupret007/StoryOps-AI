import { z } from 'zod';

const dateTimeSchema = z.string().datetime({ offset: true });

export const dispatchOriginRetentionHealthRpcSchema = z
  .object({
    schemaVersion: z.literal('storyops-dispatch-origin-retention-health-v1'),
    status: z.enum(['healthy', 'blocked']),
    p0ReleaseCheck: z.enum(['passed', 'blocked']),
    scheduleActive: z.boolean(),
    scheduleSeconds: z.literal(5),
    scheduleRegisteredAt: dateTimeSchema.nullable(),
    schedulerExecutionVerified: z.boolean(),
    schedulerLastRunStatus: z.enum(['succeeded', 'failed']).nullable(),
    schedulerLastStartedAt: dateTimeSchema.nullable(),
    schedulerLastCompletedAt: dateTimeSchema.nullable(),
    lastStartedAt: dateTimeSchema.nullable(),
    lastCompletedAt: dateTimeSchema.nullable(),
    lastStatus: z.enum(['pending', 'running', 'healthy', 'failed']),
    lastPurgedCount: z.number().int().nonnegative(),
    lastCronHistoryPurgedCount: z.number().int().nonnegative(),
    coordinateStaleCount: z.number().int().nonnegative(),
    verifierStaleCount: z.number().int().nonnegative(),
    cronHistoryStaleCount: z.number().int().nonnegative(),
    cronHistoryRetentionHours: z.literal(24),
    oldestCoordinateStaleSeconds: z.number().nonnegative(),
    oldestVerifierStaleSeconds: z.number().nonnegative(),
    retentionPolicy: z.literal('storyops-dispatch-current-origin-ephemeral-v1'),
  })
  .strict()
  .superRefine((health, context) => {
    const schedulerEvidence =
      health.schedulerLastRunStatus === 'succeeded' &&
      health.scheduleRegisteredAt !== null &&
      health.schedulerLastStartedAt !== null &&
      health.schedulerLastCompletedAt !== null;
    if (health.schedulerExecutionVerified && !schedulerEvidence) {
      context.addIssue({
        code: 'custom',
        message:
          'Dispatch-origin scheduler verification requires a successful completed pg_cron run.',
      });
    }
    const passed =
      health.status === 'healthy' &&
      health.p0ReleaseCheck === 'passed' &&
      health.scheduleActive &&
      health.schedulerExecutionVerified &&
      schedulerEvidence &&
      health.lastStatus === 'healthy' &&
      health.coordinateStaleCount === 0 &&
      health.verifierStaleCount === 0 &&
      health.cronHistoryStaleCount === 0;
    if ((health.p0ReleaseCheck === 'passed' || health.status === 'healthy') && !passed) {
      context.addIssue({
        code: 'custom',
        message: 'Dispatch-origin retention cannot report healthy while its worker is unverified.',
      });
    }
  });

const verifiedDispatchOriginRetentionSchema = dispatchOriginRetentionHealthRpcSchema.safeExtend({
  availability: z.literal('verified'),
  checkedAt: dateTimeSchema,
});

const unavailableDispatchOriginRetentionSchema = z
  .object({
    schemaVersion: z.literal('storyops-dispatch-origin-retention-health-v1'),
    availability: z.literal('unavailable'),
    status: z.literal('blocked'),
    p0ReleaseCheck: z.literal('blocked'),
    checkedAt: dateTimeSchema,
    reasonCode: z.literal('DISPATCH_ORIGIN_RETENTION_HEALTH_UNAVAILABLE'),
  })
  .strict();

export const dispatchOriginRetentionProjectionSchema = z.discriminatedUnion('availability', [
  verifiedDispatchOriginRetentionSchema,
  unavailableDispatchOriginRetentionSchema,
]);

export type DispatchOriginRetentionProjection = z.infer<
  typeof dispatchOriginRetentionProjectionSchema
>;

export type IntegrationHealthOverall = 'healthy' | 'not_configured' | 'degraded' | 'down';

export function projectDispatchOriginRetention(
  value: unknown,
  checkedAt: string,
): DispatchOriginRetentionProjection {
  const parsed = dispatchOriginRetentionHealthRpcSchema.safeParse(value);
  if (parsed.success) {
    return dispatchOriginRetentionProjectionSchema.parse({
      ...parsed.data,
      availability: 'verified',
      checkedAt,
    });
  }
  return {
    schemaVersion: 'storyops-dispatch-origin-retention-health-v1',
    availability: 'unavailable',
    status: 'blocked',
    p0ReleaseCheck: 'blocked',
    checkedAt,
    reasonCode: 'DISPATCH_ORIGIN_RETENTION_HEALTH_UNAVAILABLE',
  };
}

export function integrationOverallWithDispatchRetention(
  providerOverall: IntegrationHealthOverall,
  retention: DispatchOriginRetentionProjection,
): IntegrationHealthOverall {
  if (retention.p0ReleaseCheck === 'passed') return providerOverall;
  return providerOverall === 'down' ? 'down' : 'degraded';
}
