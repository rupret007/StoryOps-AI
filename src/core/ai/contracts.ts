import { z } from 'zod';

export const officeAgentNames = [
  'intake',
  'estimating',
  'scheduling',
  'follow_up',
  'marketing',
  'finance',
  'safety',
  'owner_briefing',
] as const;

export type OfficeAgentName = (typeof officeAgentNames)[number];

export const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
export type ActionRisk = (typeof riskLevels)[number];

export const officeToolNames = [
  'records.read',
  'records.create_lead',
  'records.update_lead',
  'records.merge',
  'pricing.calculate',
  'pricing.override',
  'pricebook.publish',
  'calendar.read_availability',
  'calendar.create_hold',
  'calendar.create_booking',
  'weather.read_forecast',
  'routing.optimize',
  'maps.geocode',
  'storage.create_upload',
  'storage.read_asset',
  'communications.send_sms',
  'communications.send_email',
  'communications.reply_negative_review',
  'payments.read_status',
  'payments.create_checkout',
  'payments.create_invoice',
  'payments.refund',
  'accounting.export_invoice',
  'vendor.change',
  'bank.transfer',
  'safety.send_message',
  'legal.send_message',
  'metrics.read',
  'approval.request',
] as const;

export type OfficeToolName = (typeof officeToolNames)[number];

export type OfficeActor = {
  id: string;
  role: 'owner' | 'dispatcher' | 'technician' | 'system';
};

export type TrustedFact = {
  id: string;
  name: string;
  value: unknown;
  source: 'database' | 'human' | 'provider' | 'deterministic_calculation';
  observedAt: string;
};

export type UntrustedContent = {
  id: string;
  channel: 'web' | 'chat' | 'sms' | 'phone' | 'email' | 'photo_ocr' | 'review';
  content: string;
  receivedAt: string;
};

export type OfficeRunRequest = {
  runId: string;
  companyId: string;
  agent: OfficeAgentName;
  objective: string;
  actor: OfficeActor;
  trustedFacts: TrustedFact[];
  untrustedContent: UntrustedContent[];
  idempotencyKey: string;
  requestedAt: string;
};

export const officeRunRequestSchema = z.object({
  runId: z.string().min(1).max(128),
  companyId: z.string().min(1).max(128),
  agent: z.enum(officeAgentNames),
  objective: z.string().min(1).max(8_000),
  actor: z.object({
    id: z.string().min(1).max(128),
    role: z.enum(['owner', 'dispatcher', 'technician', 'system']),
  }),
  trustedFacts: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        name: z.string().min(1).max(256),
        value: z.unknown(),
        source: z.enum(['database', 'human', 'provider', 'deterministic_calculation']),
        observedAt: z.string().min(1).max(64),
      }),
    )
    .max(500),
  untrustedContent: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        channel: z.enum(['web', 'chat', 'sms', 'phone', 'email', 'photo_ocr', 'review']),
        content: z.string().max(100_000),
        receivedAt: z.string().min(1).max(64),
      }),
    )
    .max(100),
  idempotencyKey: z.string().min(8).max(256),
  requestedAt: z.string().min(1).max(64),
});

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const actionProposalSchema = z
  .object({
    actionId: z.string().min(1).max(128),
    toolName: z.enum(officeToolNames),
    purpose: z.string().min(1).max(1_000),
    payload: z.record(z.string(), jsonValueSchema),
    risk: z.enum(riskLevels),
    reversible: z.boolean(),
    sourceFactIds: z.array(z.string().min(1)).min(1).max(100),
  })
  .strict();

export type ActionProposal = z.infer<typeof actionProposalSchema>;

export const agentEvidenceSchema = z.object({
  claim: z.string().min(1).max(2_000),
  sourceFactIds: z.array(z.string().min(1)).min(1).max(100),
  confidence: z.number().min(0).max(1),
});

export type AgentEvidence = z.infer<typeof agentEvidenceSchema>;

export const officeAgentOutputSchema = z
  .object({
    summary: z.string().min(1).max(8_000),
    confidence: z.number().min(0).max(1),
    evidence: z.array(agentEvidenceSchema).max(100),
    unknowns: z.array(z.string().min(1).max(1_000)).max(100),
    proposedActions: z.array(actionProposalSchema).max(25),
    customerDraft: z.string().max(8_000).optional(),
    ownerAttention: z.boolean(),
  })
  .strict();

export type OfficeAgentOutput = z.infer<typeof officeAgentOutputSchema>;

export type StructuredGenerationRequest = {
  runId: string;
  agent: OfficeAgentName;
  systemInstructions: string;
  input: string;
};

export interface StructuredModel {
  readonly provider: string;
  generate(request: StructuredGenerationRequest): Promise<unknown>;
}

export type ActionDisposition =
  | {
      actionId: string;
      status: 'executed';
      output: unknown;
      policyRule: string;
    }
  | {
      actionId: string;
      status: 'approval_required';
      approvalId: string;
      payloadHash: string;
      policyRule: string;
    }
  | {
      actionId: string;
      status: 'denied';
      reason: string;
      policyRule: string;
    }
  | {
      actionId: string;
      status: 'failed';
      reason: string;
      retryable: boolean;
      policyRule: string;
    };

export type OfficeRunResult = {
  traceId: string;
  runId: string;
  agent: OfficeAgentName;
  modelProvider: string;
  output: OfficeAgentOutput;
  actions: ActionDisposition[];
  injectionSignals: string[];
  completedAt: string;
  replayed: boolean;
};

export class AiOfficeError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_MODEL_OUTPUT'
      | 'CAPABILITY_DENIED'
      | 'POLICY_DENIED'
      | 'APPROVAL_REQUIRED'
      | 'APPROVAL_MISMATCH'
      | 'APPROVAL_EXPIRED'
      | 'IDEMPOTENCY_CONFLICT'
      | 'TOOL_NOT_FOUND'
      | 'TOOL_EXECUTION_FAILED',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AiOfficeError';
  }
}
