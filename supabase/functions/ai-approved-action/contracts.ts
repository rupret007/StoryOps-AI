import { z } from 'zod';
import { sha256Hex } from '../../../src/core/ai/approval.ts';
import {
  officeToolNames,
  riskLevels,
  type OfficeAgentName,
  type OfficeToolName,
} from '../../../src/core/ai/contracts.ts';
import { leadCreateInputSchema, leadUpdateInputSchema } from '../_shared/server-record-tools.ts';

const uuidSchema = z.string().uuid();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const moneySchema = z
  .object({
    amount: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/u)
      .refine((amount) => amount !== '0.00', 'Amount must be positive.'),
    currency: z.literal('USD'),
  })
  .strict();

export const approvedActionRequestSchema = z
  .object({
    companyId: uuidSchema,
    approvalId: uuidSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export type ApprovedActionRequest = z.infer<typeof approvedActionRequestSchema>;

const persistedApprovalSchema = z
  .object({
    id: uuidSchema,
    company_id: uuidSchema,
    reason: z.string().min(1),
    risk_level: z.enum(riskLevels),
    status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']),
    expires_at: z.string().nullable(),
    consumed_at: z.string().nullable(),
    action_type: z.string().min(1),
    action_payload: z
      .object({
        exactPayload: z.unknown(),
        payloadHash: hashSchema,
        runId: z.string().min(1).max(128),
        actionId: z.string().min(1).max(128),
        toolName: z.string().min(1),
      })
      .strict(),
  })
  .passthrough();

export const approvedRefundPayloadSchema = z
  .object({
    paymentProviderId: z.string().min(1).max(255),
    amount: moneySchema,
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export type ApprovedRefundPayload = z.infer<typeof approvedRefundPayloadSchema>;

const paymentDocumentSchema = z
  .object({
    provider: z.literal('stripe'),
    providerId: z.string().min(3).max(255),
    mode: z.enum(['sandbox', 'live']),
    kind: z.literal('refund'),
    status: z.enum(['open', 'refunded']),
    total: moneySchema,
    idempotencyKey: z.string().min(32).max(255),
  })
  .strict();

export type ApprovedRefundOutput = z.infer<typeof paymentDocumentSchema>;
export type ApprovedLeadCreatePayload = z.infer<typeof leadCreateInputSchema>;
export type ApprovedLeadUpdatePayload = z.infer<typeof leadUpdateInputSchema>;

export type PersistedApprovedAction = {
  approvalId: string;
  companyId: string;
  reason: string;
  runId: string;
  actionId: string;
  toolName: OfficeToolName;
  risk: (typeof riskLevels)[number];
  exactPayload: unknown;
  payloadHash: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  expiresAt: string | null;
  consumedAt: string | null;
};

export class ApprovedActionContractError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'APPROVAL_MALFORMED'
      | 'APPROVAL_MISMATCH'
      | 'APPROVAL_PENDING'
      | 'APPROVAL_REJECTED'
      | 'APPROVAL_EXPIRED'
      | 'APPROVAL_CONSUMED'
      | 'UNSUPPORTED_TOOL'
      | 'INVALID_PROVIDER_OUTPUT',
  ) {
    super(message);
    this.name = 'ApprovedActionContractError';
  }
}

function isOfficeToolName(value: string): value is OfficeToolName {
  return (officeToolNames as readonly string[]).includes(value);
}

export async function parseAndRevalidatePersistedApproval(
  value: unknown,
  expected: { companyId: string; approvalId: string },
): Promise<PersistedApprovedAction> {
  const parsed = persistedApprovalSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApprovedActionContractError(
      'The persisted approval contract is malformed.',
      'APPROVAL_MALFORMED',
    );
  }
  const row = parsed.data;
  if (row.id !== expected.approvalId || row.company_id !== expected.companyId) {
    throw new ApprovedActionContractError(
      'The persisted approval belongs to a different scope.',
      'APPROVAL_MISMATCH',
    );
  }
  if (!isOfficeToolName(row.action_payload.toolName)) {
    throw new ApprovedActionContractError(
      'The persisted approval names an unregistered tool.',
      'UNSUPPORTED_TOOL',
    );
  }
  if (row.action_type !== row.action_payload.toolName) {
    throw new ApprovedActionContractError(
      'The approval action identity is inconsistent.',
      'APPROVAL_MISMATCH',
    );
  }

  const recomputedHash = await sha256Hex({
    runId: row.action_payload.runId,
    actionId: row.action_payload.actionId,
    toolName: row.action_payload.toolName,
    risk: row.risk_level,
    payload: row.action_payload.exactPayload,
  });
  if (recomputedHash !== row.action_payload.payloadHash) {
    throw new ApprovedActionContractError(
      'The persisted exact payload no longer matches its approval hash.',
      'APPROVAL_MISMATCH',
    );
  }

  return {
    approvalId: row.id,
    companyId: row.company_id,
    reason: row.reason,
    runId: row.action_payload.runId,
    actionId: row.action_payload.actionId,
    toolName: row.action_payload.toolName,
    risk: row.risk_level,
    exactPayload: row.action_payload.exactPayload,
    payloadHash: row.action_payload.payloadHash,
    status: row.status,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export function assertExecutableApprovalState(
  approval: PersistedApprovedAction,
  now = new Date(),
): void {
  if (approval.status === 'pending') {
    throw new ApprovedActionContractError(
      'The action is still waiting for owner approval.',
      'APPROVAL_PENDING',
    );
  }
  if (approval.status === 'rejected') {
    throw new ApprovedActionContractError('The owner rejected this action.', 'APPROVAL_REJECTED');
  }
  if (
    approval.status === 'expired' ||
    approval.status === 'cancelled' ||
    (approval.expiresAt !== null && new Date(approval.expiresAt).getTime() <= now.getTime())
  ) {
    throw new ApprovedActionContractError('The approval has expired.', 'APPROVAL_EXPIRED');
  }
  if (approval.status !== 'approved') {
    throw new ApprovedActionContractError('The action has not been approved.', 'APPROVAL_MISMATCH');
  }
  if (approval.consumedAt !== null) {
    throw new ApprovedActionContractError(
      'The approval was already consumed.',
      'APPROVAL_CONSUMED',
    );
  }
}

const supportedApprovedToolAgents = {
  'payments.refund': 'finance',
  'records.create_lead': 'intake',
  'records.update_lead': 'intake',
} as const satisfies Partial<Record<OfficeToolName, OfficeAgentName>>;

export function approvedToolAgent(toolName: OfficeToolName): OfficeAgentName {
  const agent = supportedApprovedToolAgents[toolName as keyof typeof supportedApprovedToolAgents];
  if (!agent) {
    throw new ApprovedActionContractError(
      'This approved action has no authoritative server validator.',
      'UNSUPPORTED_TOOL',
    );
  }
  return agent;
}

export function parseApprovedRefundPayload(value: unknown): ApprovedRefundPayload {
  const parsed = approvedRefundPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApprovedActionContractError(
      'The exact refund payload is malformed.',
      'APPROVAL_MALFORMED',
    );
  }
  return parsed.data;
}

export function parseApprovedLeadPayload(
  toolName: 'records.create_lead' | 'records.update_lead',
  value: unknown,
): ApprovedLeadCreatePayload | ApprovedLeadUpdatePayload {
  const parsed =
    toolName === 'records.create_lead'
      ? leadCreateInputSchema.safeParse(value)
      : leadUpdateInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApprovedActionContractError(
      'The exact approved lead payload is malformed.',
      'APPROVAL_MALFORMED',
    );
  }
  return parsed.data;
}

export function parseApprovedRefundOutput(
  value: unknown,
  expected: { payload: ApprovedRefundPayload; providerIdempotencyKey: string },
): ApprovedRefundOutput {
  const parsed = paymentDocumentSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.idempotencyKey !== expected.providerIdempotencyKey ||
    parsed.data.total.amount !== expected.payload.amount.amount ||
    parsed.data.total.currency !== expected.payload.amount.currency
  ) {
    throw new ApprovedActionContractError(
      'The provider receipt does not match the approved refund.',
      'INVALID_PROVIDER_OUTPUT',
    );
  }
  return parsed.data;
}

export function safeExecutionErrorCode(error: unknown): string {
  const candidate =
    error !== null &&
    typeof error === 'object' &&
    'providerCode' in error &&
    typeof error.providerCode === 'string'
      ? error.providerCode
      : error instanceof Error
        ? error.name
        : 'UNKNOWN';
  return (
    candidate
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/gu, '_')
      .slice(0, 100) || 'UNKNOWN'
  );
}
