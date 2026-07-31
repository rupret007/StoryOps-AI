import { z } from 'zod';

export const aiEvalFixtureIds = [
  'prompt-injection',
  'invented-measurement',
  'invented-price',
  'invented-availability',
  'invented-payment',
  'invented-delivery',
  'prohibited-regulation-chemical',
  'unsupported-legal-claim',
  'false-summary-grounding',
  'false-customer-draft-grounding',
  'consent-bypass',
  'unnecessary-escalation',
  'uncertainty-escalation',
  'approval-required',
  'cross-tenant-least-privilege',
  'idempotency-duplicate',
  'pii-leakage',
  'malformed-structured-output',
] as const;

export type AiEvalFixtureId = (typeof aiEvalFixtureIds)[number];

export const aiEvalFixtureSchema = z
  .object({
    id: z.enum(aiEvalFixtureIds),
    title: z.string().min(1).max(240),
    category: z.string().min(1).max(120),
    coverage: z.enum(['runtime', 'contract_only']),
    expectedOutcome: z.enum([
      'denied',
      'blocked',
      'approval_required',
      'escalated',
      'executed_deterministically',
      'replayed_once',
      'minimized_before_model',
      'integration_gap_detected',
      'invalid_model_output',
      'not_escalated',
    ]),
  })
  .strict();

export type AiEvalFixture = z.infer<typeof aiEvalFixtureSchema>;

export const aiEvalFixtureSetSchema = z
  .object({
    suite: z.literal('storyops-ai-safety-evals-v1'),
    fixtures: z.array(aiEvalFixtureSchema).length(aiEvalFixtureIds.length),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, fixture] of value.fixtures.entries()) {
      if (seen.has(fixture.id)) {
        context.addIssue({
          code: 'custom',
          message: `Fixture "${fixture.id}" is duplicated.`,
          path: ['fixtures', index, 'id'],
        });
      }
      seen.add(fixture.id);
    }
    for (const fixtureId of aiEvalFixtureIds) {
      if (!seen.has(fixtureId)) {
        context.addIssue({
          code: 'custom',
          message: `Required fixture "${fixtureId}" is missing.`,
          path: ['fixtures'],
        });
      }
    }
  });

export type AiEvalFixtureSet = z.infer<typeof aiEvalFixtureSetSchema>;

export interface AiEvalResult {
  id: AiEvalFixtureId;
  title: string;
  category: string;
  coverage: AiEvalFixture['coverage'];
  expectedOutcome: AiEvalFixture['expectedOutcome'];
  actualOutcome: AiEvalFixture['expectedOutcome'] | 'failed';
  status: 'pass' | 'fail';
  evidence: string[];
  integrationGap?: string;
}

export interface AiEvalReport {
  schemaVersion: 'storyops-ai-safety-evals-report-v1';
  suite: 'storyops-ai-safety-evals-v1';
  mode: 'deterministic_no_key';
  executedAt: string;
  passed: number;
  failed: number;
  results: AiEvalResult[];
  integrationGaps: string[];
}
