import { asDecimalString, asDomainId, asISODateTime, type IdempotencyContext } from '@/domain';
import {
  evaluateActionPolicy,
  type ActionProposal,
  type PolicyEvaluationContext,
} from '@/core/policy';

const companyId = asDomainId('10000000-0000-4000-8000-000000000001');

const idempotency: IdempotencyContext = {
  key: 'schedule:abc',
  scope: 'schedule',
  requestHash: 'a'.repeat(64),
  requestedAt: asISODateTime('2026-07-28T12:00:00.000-05:00'),
};

const proposal = (overrides: Partial<ActionProposal> = {}): ActionProposal => ({
  actionType: 'schedule_visit',
  companyId,
  entityType: 'visit',
  payload: { visitId: 'visit-1' },
  reversible: true,
  stateChanging: true,
  priceBookCompliant: true,
  sopCompliant: true,
  bookingDisposition: 'eligible',
  ...overrides,
});

const context = (overrides: Partial<PolicyEvaluationContext> = {}): PolicyEvaluationContext => ({
  actorId: 'scheduling-agent',
  actorRole: 'owner',
  delegatedAgent: 'scheduling',
  idempotency,
  promptInjectionDetected: false,
  untrustedContentUsedAsInstruction: false,
  sourceFactsVerified: true,
  ...overrides,
});

describe('automation policy', () => {
  it('auto-executes only grounded, idempotent, low-risk, reversible allowlisted actions', () => {
    const decision = evaluateActionPolicy(proposal(), context());
    expect(decision.disposition).toBe('auto_execute');
    expect(decision.allowed).toBe(true);
    expect(decision.riskLevel).toBe('low');
  });

  it('requires approval for every safety message and negative review response', () => {
    const safety = evaluateActionPolicy(
      proposal({
        actionType: 'send_safety_message',
        entityType: 'communication',
        bookingDisposition: undefined,
      }),
      context({ delegatedAgent: undefined, actorRole: 'owner' }),
    );
    const review = evaluateActionPolicy(
      proposal({
        actionType: 'reply_to_review',
        entityType: 'review',
        reviewSentiment: 'negative',
        bookingDisposition: undefined,
      }),
      context(),
    );

    expect(safety.disposition).toBe('require_approval');
    expect(safety.approvalReasons).toContain('safety_message');
    expect(review.disposition).toBe('require_approval');
    expect(review.approvalReasons).toContain('negative_review_response');
  });

  it('requires approval for price exceptions and discounts above the configured limit', () => {
    const decision = evaluateActionPolicy(
      proposal({
        actionType: 'apply_discount',
        entityType: 'estimate',
        bookingDisposition: undefined,
        hasPriceException: true,
        requestedDiscountPercent: asDecimalString('15'),
      }),
      context(),
    );
    expect(decision.disposition).toBe('require_approval');
    expect(decision.approvalReasons).toEqual(
      expect.arrayContaining(['price_exception', 'large_discount']),
    );
  });

  it('denies prompt injection, unverified source facts, missing idempotency, and unavailable bookings', () => {
    expect(
      evaluateActionPolicy(proposal(), context({ promptInjectionDetected: true })).disposition,
    ).toBe('deny');
    expect(
      evaluateActionPolicy(proposal(), context({ sourceFactsVerified: false })).disposition,
    ).toBe('deny');
    expect(evaluateActionPolicy(proposal(), context({ idempotency: undefined })).disposition).toBe(
      'deny',
    );
    expect(
      evaluateActionPolicy(proposal({ bookingDisposition: 'unavailable' }), context()).disposition,
    ).toBe('deny');
  });

  it('denies actions outside the effective delegated role permission', () => {
    const decision = evaluateActionPolicy(
      proposal({ actionType: 'delete_record', entityType: 'customer', reversible: false }),
      context(),
    );
    expect(decision.disposition).toBe('deny');
    expect(decision.requiredPermission).toBe('company.manage');
  });

  it('allows an owner-approved high-risk action only when the approval is attached', () => {
    const refund = proposal({
      actionType: 'issue_refund',
      entityType: 'payment',
      reversible: false,
      bookingDisposition: undefined,
    });
    expect(
      evaluateActionPolicy(refund, context({ delegatedAgent: undefined, actorRole: 'owner' }))
        .disposition,
    ).toBe('require_approval');
    const approved = evaluateActionPolicy(
      refund,
      context({
        delegatedAgent: undefined,
        actorRole: 'owner',
        approvalId: asDomainId('10000000-0000-4000-8000-000000000801'),
      }),
    );
    expect(approved.disposition).toBe('auto_execute');
    expect(approved.allowed).toBe(true);
  });
});
