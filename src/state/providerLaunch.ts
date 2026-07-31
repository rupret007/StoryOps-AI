import { z } from 'zod';
import { outboundWorkerHealthProjectionSchema } from '@/core/integrations/outboundWorkerHealth';

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const capabilitySchema = z.string().regex(/^[a-z][a-z0-9_]{2,79}$/u);

export const authoritativeProviderSchema = z.enum([
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

export const providerActivationModeSchema = z.enum(['disabled', 'sandbox', 'live']);
export const providerEnvironmentStatusSchema = z.enum([
  'healthy',
  'not_configured',
  'degraded',
  'down',
]);

const providerConnectionStateSchema = z
  .object({
    id: uuidSchema,
    provider: authoritativeProviderSchema,
    mode: providerActivationModeSchema,
    ownerEnabled: z.boolean(),
    environmentMode: providerActivationModeSchema,
    environmentStatus: providerEnvironmentStatusSchema,
    environmentCheckedAt: z.string().datetime({ offset: true }).nullable(),
    environmentExpiresAt: z.string().datetime({ offset: true }).nullable(),
    environmentCapabilities: z.array(capabilitySchema),
    capabilities: z.array(capabilitySchema),
    version: z.number().int().positive(),
    canActivateLive: z.boolean(),
    canActivateSandbox: z.boolean(),
  })
  .strict();

const schedulingGateStateSchema = z
  .object({
    provider: z.literal('scheduling_evidence_gate'),
    capability: z.literal('calendar_weather_route_booking_evidence'),
    mode: providerActivationModeSchema,
    status: providerEnvironmentStatusSchema,
    checkedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    current: z.boolean(),
  })
  .strict();

const launchStateSchema = z
  .object({
    version: z.number().int().nonnegative(),
    status: z.enum(['not_authorized', 'authorized', 'invalidated', 'revoked']),
    launchAuthorized: z.boolean(),
    configurationRevision: z.number().int().positive().optional(),
    configurationHash: sha256Schema.optional(),
    baselineId: uuidSchema.optional(),
    baselineHash: sha256Schema.optional(),
    providerSnapshotHash: sha256Schema.optional(),
    proofSnapshotHash: sha256Schema.optional(),
    reviewReference: z.string().min(10).max(120).optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((launch, context) => {
    if (
      launch.launchAuthorized &&
      (launch.status !== 'authorized' ||
        launch.version < 1 ||
        !launch.configurationRevision ||
        !launch.configurationHash ||
        !launch.baselineId ||
        !launch.baselineHash ||
        !launch.providerSnapshotHash ||
        !launch.proofSnapshotHash ||
        !launch.reviewReference ||
        !launch.occurredAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An authorized launch must include every immutable authority binding.',
      });
    }
    if (launch.version === 0 && launch.status !== 'not_authorized') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Launch version zero must be explicitly not authorized.',
      });
    }
  });

export const providerLaunchStateSchema = z
  .object({
    schemaVersion: z.literal('storyops-provider-launch-state-v1'),
    companyId: uuidSchema,
    role: z.enum(['owner', 'dispatcher']),
    connections: z.array(providerConnectionStateSchema),
    schedulingGate: schedulingGateStateSchema.nullable(),
    privateWorkers: outboundWorkerHealthProjectionSchema.optional(),
    launch: launchStateSchema,
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export const providerActivationReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-provider-activation-receipt-v1'),
    companyId: uuidSchema,
    provider: authoritativeProviderSchema,
    mode: providerActivationModeSchema,
    ownerEnabled: z.boolean(),
    environmentMode: providerActivationModeSchema,
    health: providerEnvironmentStatusSchema,
    capabilities: z.array(capabilitySchema),
    version: z.number().int().positive(),
    launchVersion: z.number().int().nonnegative(),
    commandId: uuidSchema,
    requestHash: sha256Schema,
    replayed: z.boolean(),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export const companyLaunchAuthorizationReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-launch-authorization-receipt-v1'),
    companyId: uuidSchema,
    version: z.number().int().positive(),
    status: z.enum(['authorized', 'revoked']),
    launchAuthorized: z.boolean(),
    configurationRevision: z.number().int().positive(),
    configurationHash: sha256Schema,
    baselineId: uuidSchema,
    baselineHash: sha256Schema,
    providerSnapshotHash: sha256Schema,
    proofSnapshotHash: sha256Schema,
    reviewReference: z.string().min(10).max(120),
    commandId: uuidSchema,
    requestHash: sha256Schema,
    replayed: z.boolean(),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export type AuthoritativeProvider = z.infer<typeof authoritativeProviderSchema>;
export type ProviderActivationMode = z.infer<typeof providerActivationModeSchema>;
export type ProviderConnectionState = z.infer<typeof providerConnectionStateSchema>;
export type ProviderLaunchState = z.infer<typeof providerLaunchStateSchema>;
export type ProviderActivationReceipt = z.infer<typeof providerActivationReceiptSchema>;
export type CompanyLaunchAuthorizationReceipt = z.infer<
  typeof companyLaunchAuthorizationReceiptSchema
>;

export interface ProviderActivationInput {
  provider: AuthoritativeProvider;
  expectedVersion: number;
  targetMode: ProviderActivationMode;
  commandId?: string;
}

export interface CompanyLaunchAuthorizationInput {
  expectedVersion: number;
  action: 'authorize' | 'revoke';
  reviewReference: string;
  commandId?: string;
}

export interface ProviderActivationCommand {
  commandId: string;
  provider: AuthoritativeProvider;
  expectedVersion: number;
  targetMode: ProviderActivationMode;
  requestHash: string;
}

export interface CompanyLaunchAuthorizationCommand {
  commandId: string;
  expectedVersion: number;
  action: 'authorize' | 'revoke';
  reviewReference: string;
  requestHash: string;
}

export async function buildProviderActivationCommand(
  input: ProviderActivationInput,
): Promise<ProviderActivationCommand> {
  const provider = authoritativeProviderSchema.parse(input.provider);
  const expectedVersion = z.number().int().positive().parse(input.expectedVersion);
  const targetMode = providerActivationModeSchema.parse(input.targetMode);
  const commandId = uuidSchema.parse(input.commandId ?? crypto.randomUUID());
  return {
    commandId,
    provider,
    expectedVersion,
    targetMode,
    requestHash: await sha256Hex(
      ['storyops-provider-activation-v1', provider, String(expectedVersion), targetMode].join(
        '\u001f',
      ),
    ),
  };
}

export async function buildCompanyLaunchAuthorizationCommand(
  input: CompanyLaunchAuthorizationInput,
): Promise<CompanyLaunchAuthorizationCommand> {
  const expectedVersion = z.number().int().nonnegative().parse(input.expectedVersion);
  const action = z.enum(['authorize', 'revoke']).parse(input.action);
  const reviewReference = z
    .string()
    .trim()
    .min(10)
    .max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{9,119}$/u)
    .parse(input.reviewReference);
  const commandId = uuidSchema.parse(input.commandId ?? crypto.randomUUID());
  return {
    commandId,
    expectedVersion,
    action,
    reviewReference,
    requestHash: await sha256Hex(
      ['storyops-launch-authorization-v1', action, String(expectedVersion), reviewReference].join(
        '\u001f',
      ),
    ),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
