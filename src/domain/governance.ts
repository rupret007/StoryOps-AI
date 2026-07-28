import type { JsonValue } from './idempotency.ts';
import type {
  ActorReference,
  DomainId,
  EntityMetadata,
  ISODateTime,
  RetentionMetadata,
} from './primitives.ts';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type ApprovalReason =
  | 'price_exception'
  | 'large_discount'
  | 'margin_below_floor'
  | 'refund'
  | 'legal_message'
  | 'safety_message'
  | 'negative_review_response'
  | 'vendor_action'
  | 'bank_action'
  | 'destructive_change'
  | 'outside_price_book'
  | 'outside_sop'
  | 'uncertain_scope'
  | 'stale_availability'
  | 'weather_exception'
  | 'campaign_send'
  | 'other';

export interface ApprovalRequest extends EntityMetadata {
  reason: ApprovalReason;
  riskLevel: RiskLevel;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  requestedBy: ActorReference;
  requestedAt: ISODateTime;
  expiresAt?: ISODateTime;
  entityType: string;
  entityId?: DomainId;
  actionType: string;
  actionPayload: JsonValue;
  summary: string;
  policyVersion: string;
  decidedBy?: DomainId;
  decidedAt?: ISODateTime;
  decisionNote?: string;
}

export interface AutomationRun extends EntityMetadata {
  automationKey: string;
  triggerType: 'event' | 'schedule' | 'manual' | 'webhook';
  triggerReference?: string;
  status: 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled';
  startedAt?: ISODateTime;
  completedAt?: ISODateTime;
  idempotencyKey: string;
  attempt: number;
  input: JsonValue;
  output?: JsonValue;
  errorCode?: string;
  errorMessage?: string;
  approvalRequestId?: DomainId;
}

export interface AiTrace extends EntityMetadata {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  agent:
    | 'orchestrator'
    | 'intake'
    | 'estimating'
    | 'scheduling'
    | 'follow_up'
    | 'marketing'
    | 'finance'
    | 'safety'
    | 'briefing';
  operation: string;
  status: 'started' | 'succeeded' | 'failed' | 'guardrail_blocked' | 'approval_required';
  model?: string;
  promptVersion: string;
  toolName?: string;
  startedAt: ISODateTime;
  endedAt?: ISODateTime;
  inputRedacted: JsonValue;
  outputRedacted?: JsonValue;
  guardrailResults: JsonValue;
  tokenUsage?: {
    input: number;
    output: number;
  };
  costMicros?: number;
  retention: RetentionMetadata;
}

export interface AuditEvent {
  id: DomainId;
  companyId: DomainId;
  occurredAt: ISODateTime;
  actor: ActorReference;
  action: string;
  entityType: string;
  entityId?: DomainId;
  before?: JsonValue;
  after?: JsonValue;
  requestId?: string;
  traceId?: string;
  sourceIpHash?: string;
  retention: RetentionMetadata;
}

export interface OwnerBriefing extends EntityMetadata {
  briefingDate: string;
  periodStartsAt: ISODateTime;
  periodEndsAt: ISODateTime;
  status: 'draft' | 'ready' | 'delivered';
  sections: readonly {
    key: 'today' | 'approvals' | 'cash' | 'pipeline' | 'risks' | 'follow_ups' | 'kpis';
    headline: string;
    facts: readonly string[];
    sourceEntityIds: readonly DomainId[];
  }[];
  generatedByRunId: DomainId;
  deliveredAt?: ISODateTime;
}
