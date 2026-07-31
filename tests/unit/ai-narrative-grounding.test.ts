import { describe, expect, it } from 'vitest';
import {
  AI_ADVISORY_SUMMARY_PREFIX,
  AI_NARRATIVE_POLICY,
  AI_RATIONALE_PREFIX,
  evaluateNarrativeGrounding,
  groundOfficeAgentOutput,
  type OfficeAgentOutput,
  type OfficeRunRequest,
} from '@/core/ai';

const observedAt = '2026-07-30T12:00:00.000Z';

function request(): OfficeRunRequest {
  return {
    runId: 'grounding-run',
    companyId: 'grounding-company',
    agent: 'estimating',
    objective: 'Review the selected record without inventing facts.',
    actor: { id: 'grounding-owner', role: 'owner' },
    trustedFacts: [
      {
        id: 'property-record',
        name: 'properties',
        value: { id: 'property-1', stories: 2, status: 'active' },
        source: 'database',
        observedAt,
      },
      {
        id: 'measurement-record',
        name: 'property_measurements',
        value: {
          id: 'measurement-1',
          kind: 'area',
          value: '1200',
          unit: 'sq_ft',
          verified_by_human: true,
          confidence: 0.99,
          version: 1900,
        },
        source: 'human',
        observedAt,
      },
      {
        id: 'payment-record',
        name: 'payment_summary',
        value: {
          invoiceId: 'invoice-1',
          statusCounts: { processed: 1 },
        },
        source: 'deterministic_calculation',
        observedAt,
      },
      {
        id: 'price-record',
        name: 'estimates',
        value: {
          id: 'estimate-1',
          total: '350.00',
          status: 'draft',
          version: 999,
        },
        source: 'deterministic_calculation',
        observedAt,
      },
      {
        id: 'availability-record',
        name: 'scheduling_availability',
        value: {
          eligibility: 'eligible',
          window: {
            start: '2026-08-01T15:00:00.000Z',
            end: '2026-08-01T17:00:00.000Z',
          },
          version: 2,
        },
        source: 'database',
        observedAt,
      },
      {
        id: 'delivery-record',
        name: 'provider_delivery_callback',
        value: { delivery_status: 'delivered', attemptCount: 12 },
        source: 'provider',
        observedAt,
      },
      {
        id: 'human-payment-note',
        name: 'payment_status',
        value: { status: 'paid' },
        source: 'human',
        observedAt,
      },
    ],
    untrustedContent: [],
    idempotencyKey: 'grounding-idempotency',
    requestedAt: observedAt,
  };
}

function output(overrides: Partial<OfficeAgentOutput> = {}): OfficeAgentOutput {
  return {
    summary: 'Review the current source records and listed unknowns.',
    confidence: 0.8,
    evidence: [],
    unknowns: [],
    proposedActions: [],
    customerDraft: null,
    ownerAttention: false,
    ...overrides,
  };
}

describe('AI narrative semantic grounding', () => {
  it.each([
    ['measurement', 'The driveway is 1,900 sq ft.'],
    ['payment', 'The payment is paid.'],
    ['delivery', 'The quote SMS was delivered.'],
    ['legal', 'The company may legally discharge runoff into the street.'],
  ])(
    'rejects a false %s claim even when it cites an existing unrelated fact ID',
    (_kind, claim) => {
      const issues = evaluateNarrativeGrounding(
        output({
          evidence: [
            {
              claim,
              sourceFactIds: ['property-record'],
              confidence: 0.99,
            },
          ],
        }),
        request(),
      );

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        location: 'evidence_claim',
        sourceFactIds: ['property-record'],
      });
      expect(() =>
        groundOfficeAgentOutput(
          output({
            evidence: [
              {
                claim,
                sourceFactIds: ['property-record'],
                confidence: 0.99,
              },
            ],
          }),
          request(),
        ),
      ).toThrow(/failed deterministic grounding/iu);
    },
  );

  it('rejects protected factual assertions in uncited summary and customer draft prose', () => {
    const issues = evaluateNarrativeGrounding(
      output({
        summary: 'The payment is paid.',
        unknowns: ['The funds cleared.'],
        customerDraft: 'Your quote SMS was delivered.',
      }),
      request(),
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNCITED_PROTECTED_CLAIM',
          location: 'summary',
          kind: 'payment_state',
        }),
        expect.objectContaining({
          code: 'UNCITED_PROTECTED_CLAIM',
          location: 'customer_draft',
          kind: 'delivery_state',
        }),
        expect.objectContaining({
          code: 'UNCITED_PROTECTED_CLAIM',
          location: 'unknown',
          kind: 'payment_state',
        }),
      ]),
    );
  });

  it.each([
    ['payment paraphrase', 'The customer has fully paid us.'],
    ['payment idiom', 'The card charge went through.'],
    ['availability paraphrase', 'Tuesday afternoon is free for this job.'],
    ['delivery paraphrase', 'The customer got the quote text.'],
    ['price colloquialism', 'The job costs 500 bucks.'],
  ])('fails closed on ordinary protected %s', (_label, claim) => {
    const unsafe = output({ summary: claim });
    expect(evaluateNarrativeGrounding(unsafe, request())).toEqual([
      expect.objectContaining({
        code: 'UNCITED_PROTECTED_CLAIM',
        location: 'summary',
      }),
    ]);
    expect(() => groundOfficeAgentOutput(unsafe, request())).toThrow(
      /failed deterministic grounding/iu,
    );
  });

  it('binds assertions only to whitelisted value/status fields, not other fact numbers', () => {
    const falseMeasurement = output({
      evidence: [
        {
          claim: 'The human-verified driveway area is 1,900 sq ft.',
          sourceFactIds: ['measurement-record'],
          confidence: 1,
        },
      ],
    });
    expect(evaluateNarrativeGrounding(falseMeasurement, request())).toEqual([
      expect.objectContaining({
        code: 'FACT_VALUE_MISMATCH',
        kind: 'measurement',
      }),
    ]);
    expect(
      evaluateNarrativeGrounding(
        output({
          evidence: [
            {
              claim: 'The estimate total is $999.',
              sourceFactIds: ['price-record'],
              confidence: 1,
            },
            {
              claim: 'The payment is paid.',
              sourceFactIds: ['payment-record'],
              confidence: 1,
            },
            {
              claim: 'The SMS was received.',
              sourceFactIds: ['delivery-record'],
              confidence: 1,
            },
          ],
        }),
        request(),
      ),
    ).toEqual([
      expect.objectContaining({ code: 'FACT_VALUE_MISMATCH', kind: 'price' }),
      expect.objectContaining({ code: 'FACT_VALUE_MISMATCH', kind: 'payment_state' }),
      expect.objectContaining({ code: 'FACT_VALUE_MISMATCH', kind: 'delivery_state' }),
    ]);
  });

  it('fails closed on number words, relative availability, and human payment assertions', () => {
    const issues = evaluateNarrativeGrounding(
      output({
        evidence: [
          {
            claim: 'The driveway is twelve hundred sq ft.',
            sourceFactIds: ['measurement-record'],
            confidence: 1,
          },
          {
            claim: 'The crew is available on Friday.',
            sourceFactIds: ['availability-record'],
            confidence: 1,
          },
          {
            claim: 'The payment is paid.',
            sourceFactIds: ['human-payment-note'],
            confidence: 1,
          },
        ],
      }),
      request(),
    );
    expect(issues).toEqual([
      expect.objectContaining({ code: 'FACT_VALUE_MISMATCH', kind: 'measurement' }),
      expect.objectContaining({ code: 'FACT_VALUE_MISMATCH', kind: 'availability' }),
      expect.objectContaining({
        code: 'SEMANTIC_SOURCE_MISMATCH',
        kind: 'payment_state',
      }),
    ]);
  });

  it('quarantines all model-authored prose even when exact protected values are grounded', () => {
    const exactOutput = output({
      customerDraft: 'Thanks for contacting us. We still need owner-reviewed scope details.',
      evidence: [
        {
          claim: 'The human-verified driveway area is 1,200 sq ft.',
          sourceFactIds: ['measurement-record'],
          confidence: 1,
        },
        {
          claim: 'The payment is processed.',
          sourceFactIds: ['payment-record'],
          confidence: 1,
        },
        {
          claim: 'The estimate total is $350.',
          sourceFactIds: ['price-record'],
          confidence: 1,
        },
        {
          claim: 'The crew is available on 2026-08-01.',
          sourceFactIds: ['availability-record'],
          confidence: 1,
        },
        {
          claim: 'The SMS was delivered.',
          sourceFactIds: ['delivery-record'],
          confidence: 1,
        },
      ],
    });
    expect(evaluateNarrativeGrounding(exactOutput, request())).toEqual([]);
    const grounded = groundOfficeAgentOutput(exactOutput, request());
    expect(grounded.narrativePolicy).toEqual(AI_NARRATIVE_POLICY);
    expect(grounded.narrativePolicy.automaticSendAllowed).toBe(false);
    expect(grounded.summary.startsWith(AI_ADVISORY_SUMMARY_PREFIX)).toBe(true);
    expect(grounded.evidence.every((entry) => entry.claim.startsWith(AI_RATIONALE_PREFIX))).toBe(
      true,
    );
    expect(JSON.stringify(grounded)).not.toContain('1,200 sq ft');
    expect(JSON.stringify(grounded)).not.toContain('$350');
    expect(JSON.stringify(grounded)).not.toContain('Thanks for contacting us');
    expect(grounded.customerDraft).toBeNull();
    expect(grounded.ownerAttention).toBe(true);
  });

  it('never persists an unforeseen free-form paraphrase even if lexical detection misses it', () => {
    const oblique = output({
      summary: 'The obligation between the parties has been extinguished.',
      evidence: [
        {
          claim: 'All relevant circumstances now favor immediate action.',
          sourceFactIds: ['property-record'],
          confidence: 0.7,
        },
      ],
      unknowns: ['One subtle issue remains in the background.'],
      customerDraft: 'Everything is squared away.',
      proposedActions: [
        {
          actionId: 'oblique-action',
          toolName: 'records.read',
          purpose: 'The customer has already paid, so proceed immediately.',
          payload: {
            subjectType: 'property',
            subjectId: '10000000-0000-4000-8000-000000000001',
          },
          risk: 'low',
          reversible: true,
          sourceFactIds: ['property-record'],
        },
      ],
    });
    const grounded = groundOfficeAgentOutput(oblique, request());
    const serialized = JSON.stringify(grounded);
    expect(serialized).not.toContain('obligation between the parties');
    expect(serialized).not.toContain('immediate action');
    expect(serialized).not.toContain('subtle issue');
    expect(serialized).not.toContain('squared away');
    expect(serialized).not.toContain('already paid');
    expect(grounded.customerDraft).toBeNull();
  });
});
