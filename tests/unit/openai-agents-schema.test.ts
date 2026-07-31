import { zodTextFormat } from 'openai/helpers/zod';
import { describe, expect, it } from 'vitest';
import {
  decodeOpenAiOfficeAgentOutput,
  officeAgentOutputSchema,
  openAiOfficeAgentOutputSchema,
} from '@/core/ai/contracts';

function expectStrictObjects(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectStrictObjects);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (record.type === 'object') {
    expect(record.additionalProperties).toBe(false);
  }
  Object.values(record).forEach(expectStrictObjects);
}

describe('OpenAI Agents structured output contract', () => {
  it('converts to a strict API schema with every field required', () => {
    const format = zodTextFormat(openAiOfficeAgentOutputSchema, 'storyops_office_output');
    const schema = format.schema as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(format.strict).toBe(true);
    expect(schema.additionalProperties).toBe(false);
    expectStrictObjects(schema);
    expect(schema.required).toHaveLength(7);
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'summary',
        'confidence',
        'evidence',
        'unknowns',
        'proposedActions',
        'customerDraft',
        'ownerAttention',
      ]),
    );
    expect(schema.properties?.customerDraft).toEqual(
      expect.objectContaining({
        anyOf: expect.arrayContaining([
          expect.objectContaining({ type: 'string' }),
          expect.objectContaining({ type: 'null' }),
        ]),
      }),
    );
  });

  it('decodes strict payload JSON before deterministic tool-policy validation', () => {
    expect(
      decodeOpenAiOfficeAgentOutput({
        summary: 'One deterministic calculation is proposed.',
        confidence: 1,
        evidence: [],
        unknowns: [],
        proposedActions: [
          {
            actionId: 'calculate-1',
            toolName: 'pricing.calculate',
            purpose: 'Calculate from verified inputs.',
            payloadJson: '{"estimateId":"estimate-1","version":3}',
            risk: 'low',
            reversible: true,
            sourceFactIds: ['estimate-1'],
          },
        ],
        customerDraft: null,
        ownerAttention: false,
      }).proposedActions[0]?.payload,
    ).toEqual({ estimateId: 'estimate-1', version: 3 });
  });

  it.each([
    ['not JSON', 'not-json'],
    ['an array', '[]'],
    ['a reserved key', '{"__proto__":{"polluted":true}}'],
  ])('rejects payloadJson containing %s', (_label, payloadJson) => {
    expect(() =>
      decodeOpenAiOfficeAgentOutput({
        summary: 'Invalid proposal.',
        confidence: 0,
        evidence: [],
        unknowns: [],
        proposedActions: [
          {
            actionId: 'invalid-1',
            toolName: 'records.read',
            purpose: 'Invalid test proposal.',
            payloadJson,
            risk: 'low',
            reversible: true,
            sourceFactIds: ['fact-1'],
          },
        ],
        customerDraft: null,
        ownerAttention: true,
      }),
    ).toThrow(/payload/u);
  });

  it('uses explicit null instead of an omitted customer draft', () => {
    const base = {
      summary: 'No customer message is warranted.',
      confidence: 1,
      evidence: [],
      unknowns: [],
      proposedActions: [],
      ownerAttention: false,
    };

    expect(officeAgentOutputSchema.safeParse(base).success).toBe(false);
    expect(
      officeAgentOutputSchema.safeParse({
        ...base,
        customerDraft: null,
      }).success,
    ).toBe(true);
  });
});
