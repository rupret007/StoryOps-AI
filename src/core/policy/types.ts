import type {
  ApprovalReason,
  DecimalString,
  DomainId,
  IdempotencyContext,
  JsonValue,
  Permission,
  RiskLevel,
  UserRole,
} from '@/domain';

export type PolicyActionType =
  | 'qualify_lead'
  | 'create_customer'
  | 'create_property'
  | 'calculate_estimate'
  | 'publish_quote'
  | 'apply_discount'
  | 'schedule_visit'
  | 'reschedule_visit'
  | 'send_transactional_message'
  | 'send_marketing_message'
  | 'issue_refund'
  | 'send_legal_message'
  | 'send_safety_message'
  | 'reply_to_review'
  | 'create_vendor_commitment'
  | 'initiate_bank_action'
  | 'delete_record'
  | 'update_price_book'
  | 'update_sop'
  | 'collect_payment'
  | 'record_payment'
  | 'export_accounting'
  | 'request_review'
  | 'create_recurring_plan'
  | 'record_field_work';

export interface ActionProposal {
  actionType: PolicyActionType;
  companyId: DomainId;
  entityType: string;
  entityId?: DomainId;
  payload: JsonValue;
  reversible: boolean;
  stateChanging: boolean;
  priceBookCompliant: boolean;
  sopCompliant: boolean;
  requestedDiscountPercent?: DecimalString;
  hasPriceException?: boolean;
  refundAmount?: string;
  reviewSentiment?: 'positive' | 'neutral' | 'negative' | 'unknown';
  bookingDisposition?: 'eligible' | 'requires_approval' | 'unavailable';
  evidenceDisposition?: 'usable_for_scope' | 'human_review_required' | 'insufficient';
  messageContainsLegalClaim?: boolean;
  messageContainsSafetyInstruction?: boolean;
}

export interface PolicyEvaluationContext {
  actorId: DomainId | string;
  actorRole: UserRole;
  delegatedAgent?: string;
  idempotency?: IdempotencyContext;
  promptInjectionDetected: boolean;
  untrustedContentUsedAsInstruction: boolean;
  sourceFactsVerified: boolean;
  approvalId?: DomainId;
}

export interface AutomationPolicy {
  version: string;
  automaticallyExecutableActions: readonly PolicyActionType[];
  automaticDiscountLimitPercent: DecimalString;
  permittedAgentRole: UserRole;
}

export interface GuardrailResult {
  guardrail:
    | 'permission'
    | 'idempotency'
    | 'prompt_injection'
    | 'source_grounding'
    | 'price_book'
    | 'sop'
    | 'risk'
    | 'reversibility'
    | 'approval';
  passed: boolean;
  detail: string;
}

export interface PolicyDecision {
  disposition: 'auto_execute' | 'require_approval' | 'deny';
  allowed: boolean;
  riskLevel: RiskLevel;
  requiredPermission: Permission;
  approvalReasons: readonly ApprovalReason[];
  guardrails: readonly GuardrailResult[];
  policyVersion: string;
}
