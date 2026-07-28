import type { ActionProposal, ActionRisk, OfficeAgentName } from './contracts.ts';
import type { OfficeToolRegistry } from './tools.ts';

export type OfficePolicyDecision =
  | { outcome: 'allow'; rule: string; reason: string }
  | { outcome: 'require_approval'; rule: string; reason: string }
  | { outcome: 'deny'; rule: string; reason: string };

export type OfficePolicyContext = {
  agent: OfficeAgentName;
  proposal: ActionProposal;
  registry: OfficeToolRegistry;
  injectionDetected: boolean;
  sourceFactsVerified: boolean;
};

export interface OfficePolicyEvaluator {
  evaluate(context: OfficePolicyContext): Promise<OfficePolicyDecision>;
}

const riskRank: Readonly<Record<ActionRisk, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const approvalRequiredTools = new Set([
  'records.merge',
  'pricing.override',
  'pricebook.publish',
  'communications.reply_negative_review',
  'payments.refund',
  'vendor.change',
  'bank.transfer',
  'safety.send_message',
  'legal.send_message',
]);

const alwaysDeniedTools = new Set<string>([
  'safety.generate_chemical_instructions',
  'legal.file_regulatory_response',
  'payments.assert_paid',
  'pricing.llm_estimate',
]);

export class DefaultOfficePolicyEvaluator implements OfficePolicyEvaluator {
  async evaluate({
    proposal,
    registry,
    injectionDetected,
    sourceFactsVerified,
  }: OfficePolicyContext): Promise<OfficePolicyDecision> {
    if (injectionDetected) {
      return {
        outcome: 'deny',
        rule: 'AI-002-prompt-injection',
        reason: 'Untrusted content contained an instruction-injection signal.',
      };
    }
    if (!sourceFactsVerified) {
      return {
        outcome: 'deny',
        rule: 'AI-003-source-grounding',
        reason: 'The action cites facts that were not verified.',
      };
    }
    if (alwaysDeniedTools.has(proposal.toolName)) {
      return {
        outcome: 'deny',
        rule: 'AI-000-never-delegate',
        reason: 'The requested capability is never delegated to AI.',
      };
    }

    const tool = registry.metadata(proposal.toolName);
    if (!tool) {
      return {
        outcome: 'deny',
        rule: 'AI-010-unregistered-tool',
        reason: 'No typed server-side implementation is registered for this capability.',
      };
    }

    if (approvalRequiredTools.has(proposal.toolName)) {
      return {
        outcome: 'require_approval',
        rule: 'AI-100-sensitive-action',
        reason:
          'Price exceptions, refunds, legal/safety messaging, public review replies, financial/vendor actions, and irreversible changes require exact-payload approval.',
      };
    }

    if (proposal.reversible && !tool.reversible) {
      return {
        outcome: 'deny',
        rule: 'AI-020-metadata-downgrade',
        reason: 'The proposal incorrectly described an irreversible tool as reversible.',
      };
    }
    if (riskRank[proposal.risk] < riskRank[tool.risk]) {
      return {
        outcome: 'deny',
        rule: 'AI-021-risk-downgrade',
        reason: 'The proposal risk is lower than the registered tool risk.',
      };
    }

    if (
      tool.sideEffect === 'destructive' ||
      tool.risk === 'high' ||
      tool.risk === 'critical' ||
      !tool.reversible
    ) {
      return {
        outcome: 'require_approval',
        rule: 'AI-100-sensitive-action',
        reason:
          'Price exceptions, refunds, legal/safety messaging, public review replies, financial/vendor actions, and irreversible changes require exact-payload approval.',
      };
    }

    if (tool.sideEffect === 'none') {
      return {
        outcome: 'allow',
        rule: 'AI-200-read-only',
        reason: 'Read-only typed capability.',
      };
    }

    if (tool.risk === 'low' && tool.reversible && tool.supportsIdempotency && tool.autoExecute) {
      return {
        outcome: 'allow',
        rule: 'AI-210-low-risk-reversible',
        reason: 'Policy-approved, low-risk, reversible, idempotent action.',
      };
    }

    return {
      outcome: 'require_approval',
      rule: 'AI-900-conservative-default',
      reason: 'The action is not eligible for unattended execution.',
    };
  }
}
