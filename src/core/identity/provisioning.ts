import { z } from 'zod';

export const identityProvisioningRoleSchema = z.enum(['dispatcher', 'technician', 'customer']);
export const identityProvisioningActionSchema = z.enum(['invite', 'link', 'revoke']);
export const identityProvisioningStatusSchema = z.enum(['pending', 'invited', 'linked', 'revoked']);
export const identityDeliveryStatusSchema = z.enum([
  'not_requested',
  'disabled',
  'provider_submission_accepted',
  'provider_submission_failed',
  'provider_submission_unknown',
]);
export const identityProvisioningOutcomeSchema = z.enum([
  'invite_delivery_disabled',
  'existing_identity_requires_link',
  'invite_submission_accepted',
  'invite_submission_failed',
  'invite_submission_unknown',
  'identity_not_found',
  'identity_confirmation_required',
  'identity_linked',
  'identity_revoked',
]);

const exactEmailSchema = z
  .string()
  .min(3)
  .max(254)
  .email()
  .regex(/^[\x21-\x7e]+$/u, 'Email must contain printable ASCII characters only.')
  .refine((value) => value === value.trim().toLowerCase(), {
    message: 'Email must already be normalized.',
  });

const nullableCustomerIdSchema = z.string().uuid().nullable();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export type IdentityProvisioningRole = z.infer<typeof identityProvisioningRoleSchema>;
export type IdentityProvisioningAction = z.infer<typeof identityProvisioningActionSchema>;
export type IdentityProvisioningStatus = z.infer<typeof identityProvisioningStatusSchema>;
export type IdentityDeliveryStatus = z.infer<typeof identityDeliveryStatusSchema>;
export type IdentityProvisioningOutcome = z.infer<typeof identityProvisioningOutcomeSchema>;

export interface IdentityProvisioningInput {
  action: IdentityProvisioningAction;
  email: string;
  role: IdentityProvisioningRole;
  customerId?: string;
  commandId?: string;
}

export const identityProvisioningCanonicalRequestSchema = z
  .object({
    schemaVersion: z.literal('storyops-identity-provisioning-request-v1'),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    action: identityProvisioningActionSchema,
    email: exactEmailSchema,
    role: identityProvisioningRoleSchema,
    customerId: nullableCustomerIdSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.role === 'customer' && request.customerId === null) {
      context.addIssue({
        code: 'custom',
        path: ['customerId'],
        message: 'Customer portal identities require one exact customer binding.',
      });
    }
    if (request.role !== 'customer' && request.customerId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['customerId'],
        message: 'Staff identities cannot include a customer binding.',
      });
    }
  });

export const identityProvisioningCommandRequestSchema = z
  .object({
    operation: z.literal('command'),
    request: identityProvisioningCanonicalRequestSchema,
    canonicalRequest: z.string().min(2).max(4096),
    requestHash: sha256Schema,
  })
  .strict();

export const identityProvisioningStateRequestSchema = z
  .object({
    operation: z.literal('state'),
    companyId: z.string().uuid(),
  })
  .strict();

export const identityProvisioningEdgeRequestSchema = z.discriminatedUnion('operation', [
  identityProvisioningStateRequestSchema,
  identityProvisioningCommandRequestSchema,
]);

export const identityProvisioningReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-identity-provisioning-receipt-v1'),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: sha256Schema,
    action: identityProvisioningActionSchema,
    email: exactEmailSchema,
    role: identityProvisioningRoleSchema,
    customerId: nullableCustomerIdSchema,
    status: identityProvisioningStatusSchema,
    deliveryStatus: identityDeliveryStatusSchema,
    externalDeliveryClaimed: z.literal(false),
    membershipActive: z.boolean(),
    portalLinked: z.boolean(),
    outcomeCode: identityProvisioningOutcomeSchema,
    replayed: z.boolean(),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.status === 'linked' && !receipt.membershipActive) {
      context.addIssue({
        code: 'custom',
        path: ['membershipActive'],
        message: 'A linked identity must have an active company membership.',
      });
    }
    if (receipt.role === 'customer') {
      if (receipt.customerId === null) {
        context.addIssue({
          code: 'custom',
          path: ['customerId'],
          message: 'Customer portal receipts require the exact customer binding.',
        });
      }
      if (receipt.status === 'linked' && !receipt.portalLinked) {
        context.addIssue({
          code: 'custom',
          path: ['portalLinked'],
          message: 'A linked customer identity must have its exact portal mapping.',
        });
      }
    } else if (receipt.customerId !== null || receipt.portalLinked) {
      context.addIssue({
        code: 'custom',
        path: ['customerId'],
        message: 'Staff identity receipts cannot claim a customer portal binding.',
      });
    }
    if (receipt.deliveryStatus === 'provider_submission_accepted' && receipt.status !== 'invited') {
      context.addIssue({
        code: 'custom',
        path: ['deliveryStatus'],
        message: 'Provider acceptance may only accompany an invited identity.',
      });
    }
    if (receipt.externalDeliveryClaimed) {
      context.addIssue({
        code: 'custom',
        path: ['externalDeliveryClaimed'],
        message: 'The auth provider does not prove inbox delivery.',
      });
    }
  });

export const identityProvisioningTargetSchema = z
  .object({
    id: z.string().uuid(),
    email: exactEmailSchema,
    role: identityProvisioningRoleSchema,
    customerId: nullableCustomerIdSchema,
    customerDisplayName: z.string().min(1).max(240).nullable(),
    status: identityProvisioningStatusSchema,
    deliveryStatus: identityDeliveryStatusSchema,
    outcomeCode: identityProvisioningOutcomeSchema,
    membershipActive: z.boolean(),
    portalLinked: z.boolean(),
    invitedAt: z.string().datetime({ offset: true }).nullable(),
    linkedAt: z.string().datetime({ offset: true }).nullable(),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const identityInvitationAttemptAuthorityStatusSchema = z.enum([
  'pending',
  'provider_submission_accepted',
  'provider_submission_unknown',
]);

export const identityInvitationUnresolvedAttemptSchema = z
  .object({
    id: z.string().uuid(),
    email: exactEmailSchema,
    originatingRole: identityProvisioningRoleSchema,
    originatingCustomerId: nullableCustomerIdSchema,
    providerCommandId: z.string().uuid(),
    authorityStatus: identityInvitationAttemptAuthorityStatusSchema,
    authorizedAt: z.string().datetime({ offset: true }),
    observedAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }),
    retryEligible: z.boolean(),
    reconciliationRequired: z.literal(true),
  })
  .strict();

export const identityInvitationAttemptStateSchema = z
  .object({
    schemaVersion: z.literal('storyops-identity-invitation-attempt-state-v1'),
    companyId: z.string().uuid(),
    companyStatus: z.enum(['setup', 'active', 'paused']),
    unresolvedAttempts: z.array(identityInvitationUnresolvedAttemptSchema).max(200),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export const identityProvisioningStateSchema = z
  .object({
    schemaVersion: z.literal('storyops-identity-provisioning-state-v1'),
    companyId: z.string().uuid(),
    companyStatus: z.enum(['setup', 'active', 'paused']),
    inviteMode: z.enum(['disabled', 'live']),
    inviteSubmissionOnly: z.literal(true),
    externalDeliveryClaimed: z.literal(false),
    customers: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            displayName: z.string().min(1).max(240),
          })
          .strict(),
      )
      .max(500),
    targets: z.array(identityProvisioningTargetSchema).max(200),
    unresolvedAttempts: z.array(identityInvitationUnresolvedAttemptSchema).max(200),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export type IdentityProvisioningCanonicalRequest = z.infer<
  typeof identityProvisioningCanonicalRequestSchema
>;
export type IdentityProvisioningCommandRequest = z.infer<
  typeof identityProvisioningCommandRequestSchema
>;
export type IdentityProvisioningReceipt = z.infer<typeof identityProvisioningReceiptSchema>;
export type IdentityProvisioningState = z.infer<typeof identityProvisioningStateSchema>;
export type IdentityInvitationUnresolvedAttempt = z.infer<
  typeof identityInvitationUnresolvedAttemptSchema
>;

export function normalizeIdentityEmail(value: string): string {
  return exactEmailSchema.parse(value.trim().normalize('NFKC').toLowerCase());
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalIdentityRequestText(
  request: IdentityProvisioningCanonicalRequest,
): string {
  return JSON.stringify(canonicalize(identityProvisioningCanonicalRequestSchema.parse(request)));
}

export async function identityRequestSha256(canonicalRequest: string): Promise<string> {
  return sha256Hex(canonicalRequest);
}

export async function buildIdentityProvisioningCommand(input: {
  companyId: string;
  command: IdentityProvisioningInput;
}): Promise<IdentityProvisioningCommandRequest> {
  const role = identityProvisioningRoleSchema.parse(input.command.role);
  if (role === 'customer' && !input.command.customerId) {
    throw new Error('Customer portal identities require one exact customer binding.');
  }
  if (role !== 'customer' && input.command.customerId !== undefined) {
    throw new Error('Staff identities cannot include a customer binding.');
  }
  const request = identityProvisioningCanonicalRequestSchema.parse({
    schemaVersion: 'storyops-identity-provisioning-request-v1',
    companyId: input.companyId,
    commandId: input.command.commandId ?? crypto.randomUUID(),
    action: input.command.action,
    email: normalizeIdentityEmail(input.command.email),
    role,
    customerId: role === 'customer' ? (input.command.customerId ?? null) : null,
  });
  const canonicalRequest = canonicalIdentityRequestText(request);
  return identityProvisioningCommandRequestSchema.parse({
    operation: 'command',
    request,
    canonicalRequest,
    requestHash: await sha256Hex(canonicalRequest),
  });
}
