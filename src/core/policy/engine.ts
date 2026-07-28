import { Decimal } from 'decimal.js';
import {
  asDecimalString,
  hasPermission,
  type ApprovalReason,
  type Permission,
  type RiskLevel,
} from '@/domain';
import type {
  ActionProposal,
  AutomationPolicy,
  GuardrailResult,
  PolicyActionType,
  PolicyDecision,
  PolicyEvaluationContext,
} from './types.ts';

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy = {
  version: 'storyops-policy-v1.0.0',
  automaticallyExecutableActions: [
    'qualify_lead',
    'create_customer',
    'create_property',
    'calculate_estimate',
    'schedule_visit',
    'reschedule_visit',
    'send_transactional_message',
    'request_review',
    'create_recurring_plan',
  ],
  automaticDiscountLimitPercent: asDecimalString('10'),
  permittedAgentRole: 'dispatcher',
};

const ACTION_PERMISSION: Readonly<Record<PolicyActionType, Permission>> = {
  qualify_lead: 'customers.write',
  create_customer: 'customers.write',
  create_property: 'properties.write',
  calculate_estimate: 'estimates.write',
  publish_quote: 'estimates.write',
  apply_discount: 'estimates.write',
  schedule_visit: 'dispatch.manage',
  reschedule_visit: 'dispatch.manage',
  send_transactional_message: 'communications.send',
  send_marketing_message: 'campaigns.manage',
  issue_refund: 'payments.manage',
  send_legal_message: 'communications.send',
  send_safety_message: 'communications.send',
  reply_to_review: 'reviews.manage',
  create_vendor_commitment: 'company.manage',
  initiate_bank_action: 'payments.manage',
  delete_record: 'company.manage',
  update_price_book: 'price_books.manage',
  update_sop: 'safety.manage',
  collect_payment: 'payments.manage',
  record_payment: 'payments.manage',
  export_accounting: 'payments.read',
  request_review: 'communications.send',
  create_recurring_plan: 'customers.write',
  record_field_work: 'field.execute',
};

const intrinsicallyHighRisk = new Set<PolicyActionType>([
  'issue_refund',
  'send_legal_message',
  'send_safety_message',
  'create_vendor_commitment',
  'initiate_bank_action',
  'delete_record',
  'update_price_book',
  'update_sop',
]);

const mediumRisk = new Set<PolicyActionType>([
  'publish_quote',
  'apply_discount',
  'send_marketing_message',
  'reply_to_review',
  'collect_payment',
  'record_payment',
  'export_accounting',
]);

const riskFor = (proposal: ActionProposal): RiskLevel => {
  if (proposal.actionType === 'delete_record' || proposal.actionType === 'initiate_bank_action') {
    return 'critical';
  }
  if (intrinsicallyHighRisk.has(proposal.actionType)) {
    return 'high';
  }
  if (
    mediumRisk.has(proposal.actionType) ||
    !proposal.priceBookCompliant ||
    !proposal.sopCompliant ||
    proposal.evidenceDisposition === 'human_review_required'
  ) {
    return 'medium';
  }
  return 'low';
};

const approvalReasonsFor = (
  proposal: ActionProposal,
  policy: AutomationPolicy,
): ApprovalReason[] => {
  const reasons: ApprovalReason[] = [];
  if (!proposal.priceBookCompliant) {
    reasons.push('outside_price_book');
  }
  if (!proposal.sopCompliant) {
    reasons.push('outside_sop');
  }
  if (proposal.hasPriceException) {
    reasons.push('price_exception');
  }
  if (
    proposal.requestedDiscountPercent &&
    new Decimal(proposal.requestedDiscountPercent).greaterThan(policy.automaticDiscountLimitPercent)
  ) {
    reasons.push('large_discount');
  }
  if (proposal.actionType === 'issue_refund') {
    reasons.push('refund');
  }
  if (proposal.actionType === 'send_legal_message' || proposal.messageContainsLegalClaim) {
    reasons.push('legal_message');
  }
  if (proposal.actionType === 'send_safety_message' || proposal.messageContainsSafetyInstruction) {
    reasons.push('safety_message');
  }
  if (proposal.actionType === 'reply_to_review' && proposal.reviewSentiment === 'negative') {
    reasons.push('negative_review_response');
  }
  if (proposal.actionType === 'create_vendor_commitment') {
    reasons.push('vendor_action');
  }
  if (proposal.actionType === 'initiate_bank_action') {
    reasons.push('bank_action');
  }
  if (proposal.actionType === 'delete_record') {
    reasons.push('destructive_change');
  }
  if (
    proposal.evidenceDisposition === 'human_review_required' ||
    proposal.evidenceDisposition === 'insufficient'
  ) {
    reasons.push('uncertain_scope');
  }
  if (proposal.bookingDisposition === 'requires_approval') {
    reasons.push('weather_exception');
  }
  if (proposal.actionType === 'send_marketing_message') {
    reasons.push('campaign_send');
  }
  return [...new Set(reasons)];
};

const fail = (
  policy: AutomationPolicy,
  permission: Permission,
  riskLevel: RiskLevel,
  guardrails: GuardrailResult[],
  detail: string,
): PolicyDecision => {
  guardrails.push({ guardrail: 'risk', passed: false, detail });
  return {
    disposition: 'deny',
    allowed: false,
    riskLevel,
    requiredPermission: permission,
    approvalReasons: [],
    guardrails,
    policyVersion: policy.version,
  };
};

export const evaluateActionPolicy = (
  proposal: ActionProposal,
  context: PolicyEvaluationContext,
  policy: AutomationPolicy = DEFAULT_AUTOMATION_POLICY,
): PolicyDecision => {
  const permission = ACTION_PERMISSION[proposal.actionType];
  const riskLevel = riskFor(proposal);
  const guardrails: GuardrailResult[] = [];
  const effectiveRole = context.delegatedAgent ? policy.permittedAgentRole : context.actorRole;

  const permissionPassed = hasPermission(effectiveRole, permission);
  guardrails.push({
    guardrail: 'permission',
    passed: permissionPassed,
    detail: permissionPassed
      ? `Role "${effectiveRole}" has "${permission}".`
      : `Role "${effectiveRole}" lacks "${permission}".`,
  });
  if (!permissionPassed) {
    return fail(policy, permission, riskLevel, guardrails, 'Required permission is missing.');
  }

  if (context.promptInjectionDetected || context.untrustedContentUsedAsInstruction) {
    guardrails.push({
      guardrail: 'prompt_injection',
      passed: false,
      detail: 'Untrusted content attempted to influence instructions or tool execution.',
    });
    return fail(
      policy,
      permission,
      'critical',
      guardrails,
      'Prompt-injection defense blocked execution.',
    );
  }
  guardrails.push({
    guardrail: 'prompt_injection',
    passed: true,
    detail: 'No prompt-injection signal affected the proposed action.',
  });

  if (!context.sourceFactsVerified) {
    guardrails.push({
      guardrail: 'source_grounding',
      passed: false,
      detail:
        'Required price, measurement, availability, payment, regulation, or safety facts are unverified.',
    });
    return fail(
      policy,
      permission,
      riskLevel,
      guardrails,
      'Unverified facts cannot be used for execution.',
    );
  }
  guardrails.push({
    guardrail: 'source_grounding',
    passed: true,
    detail: 'Execution inputs are grounded in verified system or provider records.',
  });

  if (proposal.stateChanging && !context.idempotency) {
    guardrails.push({
      guardrail: 'idempotency',
      passed: false,
      detail: 'State-changing actions require an idempotency context.',
    });
    return fail(policy, permission, riskLevel, guardrails, 'Missing idempotency context.');
  }
  guardrails.push({
    guardrail: 'idempotency',
    passed: true,
    detail: proposal.stateChanging
      ? 'Idempotency key and request hash are present.'
      : 'Action is read-only.',
  });

  if (proposal.bookingDisposition === 'unavailable') {
    return fail(
      policy,
      permission,
      riskLevel,
      guardrails,
      'Capacity, route, or weather policy marks the booking unavailable.',
    );
  }

  guardrails.push({
    guardrail: 'price_book',
    passed: proposal.priceBookCompliant,
    detail: proposal.priceBookCompliant
      ? 'Action stays within the approved price book.'
      : 'Action falls outside the approved price book.',
  });
  guardrails.push({
    guardrail: 'sop',
    passed: proposal.sopCompliant,
    detail: proposal.sopCompliant
      ? 'Action stays within an approved SOP.'
      : 'Action falls outside an approved SOP.',
  });

  const approvalReasons = approvalReasonsFor(proposal, policy);
  const explicitlyApproved = context.approvalId !== undefined;
  if (approvalReasons.length > 0 && !explicitlyApproved) {
    guardrails.push({
      guardrail: 'approval',
      passed: false,
      detail: `Approval is required: ${approvalReasons.join(', ')}.`,
    });
    return {
      disposition: 'require_approval',
      allowed: false,
      riskLevel,
      requiredPermission: permission,
      approvalReasons,
      guardrails,
      policyVersion: policy.version,
    };
  }
  guardrails.push({
    guardrail: 'approval',
    passed: true,
    detail: explicitlyApproved ? 'A prior approval is attached.' : 'No mandatory approval applies.',
  });

  const isAllowlisted = policy.automaticallyExecutableActions.includes(proposal.actionType);
  const safelyReversible = proposal.reversible;
  guardrails.push({
    guardrail: 'reversibility',
    passed: safelyReversible,
    detail: safelyReversible ? 'The action is reversible.' : 'The action is not safely reversible.',
  });

  if (!explicitlyApproved && (riskLevel !== 'low' || !isAllowlisted || !safelyReversible)) {
    guardrails.push({
      guardrail: 'risk',
      passed: false,
      detail: 'Only low-risk, reversible, allowlisted actions may execute automatically.',
    });
    return {
      disposition: 'require_approval',
      allowed: false,
      riskLevel,
      requiredPermission: permission,
      approvalReasons: approvalReasons.length > 0 ? approvalReasons : ['other'],
      guardrails,
      policyVersion: policy.version,
    };
  }

  guardrails.push({
    guardrail: 'risk',
    passed: true,
    detail: explicitlyApproved
      ? 'Attached approval authorizes execution.'
      : 'Action is low-risk, reversible, and allowlisted.',
  });
  return {
    disposition: 'auto_execute',
    allowed: true,
    riskLevel,
    requiredPermission: permission,
    approvalReasons: [],
    guardrails,
    policyVersion: policy.version,
  };
};

export interface PolicyEngine {
  evaluate(
    proposal: ActionProposal,
    context: PolicyEvaluationContext,
    policy?: AutomationPolicy,
  ): PolicyDecision;
}

export const policyEngine: PolicyEngine = {
  evaluate: evaluateActionPolicy,
};
