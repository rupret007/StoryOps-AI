import { z } from 'zod';
import {
  AI_NARRATIVE_POLICY,
  AiOfficeError,
  type OfficeAgentOutput,
  type OfficeRunOutput,
  type OfficeRunRequest,
  type TrustedFact,
} from './contracts.ts';

export const protectedNarrativeClaimKinds = [
  'measurement',
  'price',
  'availability',
  'payment_state',
  'delivery_state',
  'legal_or_regulatory',
  'chemical_instruction',
] as const;

export type ProtectedNarrativeClaimKind = (typeof protectedNarrativeClaimKinds)[number];

export const narrativeGroundingIssueSchema = z
  .object({
    code: z.enum([
      'UNCITED_PROTECTED_CLAIM',
      'SEMANTIC_SOURCE_MISMATCH',
      'FACT_VALUE_MISMATCH',
      'NEVER_DELEGATED_CLAIM',
    ]),
    location: z.enum(['summary', 'evidence_claim', 'unknown', 'customer_draft']),
    itemIndex: z.number().int().nonnegative().nullable(),
    kind: z.enum(protectedNarrativeClaimKinds),
    sourceFactIds: z.array(z.string().min(1).max(128)).max(100),
  })
  .strict();

export type NarrativeGroundingIssue = z.infer<typeof narrativeGroundingIssueSchema>;

export const AI_ADVISORY_SUMMARY_PREFIX =
  '[NON-AUTHORITATIVE AI ADVISORY — VERIFY SOURCE RECORDS] ';
export const AI_RATIONALE_PREFIX = '[NON-AUTHORITATIVE AI RATIONALE] ';
export const AI_REPORTED_UNKNOWN_PREFIX = '[AI-REPORTED UNKNOWN — VERIFY SOURCE RECORDS] ';
export const AI_UNSENT_DRAFT_PREFIX =
  '[UNSENT AI DRAFT — HUMAN REVIEW REQUIRED — DO NOT AUTO-SEND] ';

type ProtectedClaim = {
  kind: ProtectedNarrativeClaimKind;
  assertedValues: string[];
};

const numberWords =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand';
const numberWordPattern = new RegExp(`\\b(?:${numberWords})\\b`, 'iu');

const claimRules: ReadonlyArray<{
  kind: ProtectedNarrativeClaimKind;
  pattern: RegExp;
}> = [
  {
    kind: 'legal_or_regulatory',
    pattern:
      /\b(?:legally?\s+(?:permitted|allowed|required|compliant)|(?:law|regulation|ordinance)\s+(?:allows?|requires?|permits?|prohibits?)|complies?\s+with\s+(?:the\s+)?(?:law|regulation|ordinance)|(?:may|can)\s+(?:legally\s+)?discharge)\b/iu,
  },
  {
    kind: 'chemical_instruction',
    pattern:
      /(?:\b(?:mix|dilute|combine|apply|use|spray)\b.{0,80}\b(?:bleach|chemical|chlorine|hypochlorite|acid|surfactant|parts?|ratio|percent|%)\b|\b(?:bleach|chemical|chlorine|hypochlorite|acid|surfactant)\b.{0,80}\b(?:mix|dilute|combine|apply|use|spray|ratio|\d+\s*%|\d+\s*:\s*\d+)\b)/iu,
  },
  {
    kind: 'measurement',
    pattern: new RegExp(
      `\\b(?:\\d[\\d,.]*|(?:${numberWords})(?:[-\\s]+(?:and\\s+)?(?:${numberWords}))*)\\s*(?:square\\s*(?:feet|foot)|sq\\.?\\s*ft\\.?|linear\\s*(?:feet|foot)|lin\\.?\\s*ft\\.?|feet|foot|ft\\.?|stories?|story|gallons?|gal\\.?)\\b`,
      'iu',
    ),
  },
  {
    kind: 'price',
    pattern: new RegExp(
      `(?:\\$\\s*(?:\\d[\\d,.]*|(?:${numberWords})(?:[-\\s]+(?:${numberWords}))*)|\\b(?:\\d[\\d,.]*|(?:${numberWords})(?:[-\\s]+(?:${numberWords}))*)\\s*(?:usd|dollars?)\\b|\\b(?:price|total|deposit|discount|tax|quote|estimate)\\s+(?:is|was|equals?|totals?)\\s+\\$?\\s*(?:\\d[\\d,.]*|${numberWords}))`,
      'iu',
    ),
  },
  {
    kind: 'availability',
    pattern:
      /\b(?:available|unavailable|availability|open\s+slot|booked|scheduled)\b.{0,100}\b(?:at|on|from|until|through|for)\b/iu,
  },
  {
    kind: 'payment_state',
    pattern:
      /(?:\b(?:payment|invoice|deposit|funds?)\b.{0,80}\b(?:paid|unpaid|settled|processed|refunded|succeeded|failed|past\s+due|cleared|declined|voided|authorized|pending)\b|\b(?:paid|unpaid|settled|processed|refunded|succeeded|failed|past\s+due|cleared|declined|voided|authorized|pending)\b.{0,80}\b(?:payment|invoice|deposit|funds?)\b)/iu,
  },
  {
    kind: 'delivery_state',
    pattern:
      /(?:\b(?:sms|text|email|message|quote|invoice)\b.{0,80}\b(?:delivered|sent|received|bounced|undeliverable|delivery\s+failed|queued|accepted|read|opened)\b|\b(?:delivered|sent|received|bounced|undeliverable|delivery\s+failed|queued|accepted|read|opened)\b.{0,80}\b(?:sms|text|email|message|quote|invoice)\b)/iu,
  },
];

/*
 * These conservative topic rules intentionally prefer a false positive over
 * allowing an uncited protected assertion. They supplement the value-oriented
 * rules above; free-form model prose is also quarantined before persistence, so
 * an unforeseen paraphrase cannot become user-visible truth.
 */
const conservativeClaimRules: ReadonlyArray<{
  kind: ProtectedNarrativeClaimKind;
  pattern: RegExp;
}> = [
  {
    kind: 'payment_state',
    pattern:
      /(?:\b(?:customer|client|card|charge|transaction|money|funds?|balance|deposit|invoice|payment)\b.{0,100}\b(?:paid|unpaid|settled|cleared?|complete(?:d)?|successful|succeeded|failed|declined|pending|received|arrived|went\s+through|past\s+due|outstanding|owed)\b|\b(?:paid|unpaid|settled|cleared?|complete(?:d)?|successful|succeeded|failed|declined|pending|received|arrived|went\s+through|past\s+due|outstanding|owed)\b.{0,100}\b(?:customer|client|card|charge|transaction|money|funds?|balance|deposit|invoice|payment)\b)/iu,
  },
  {
    kind: 'delivery_state',
    pattern:
      /(?:\b(?:customer|client|recipient)\b.{0,100}\b(?:got|received|saw|opened|read|accepted)\b.{0,100}\b(?:quote|text|sms|email|message|invoice)\b|\b(?:quote|text|sms|email|message|invoice)\b.{0,100}\b(?:got|reached|arrived|received|seen|opened|read|accepted|bounced|failed)\b)/iu,
  },
  {
    kind: 'availability',
    pattern:
      /(?:\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|morning|afternoon|evening|slot|window|crew|calendar)\b.{0,100}\b(?:free|open|available|unavailable|works?|fit|booked|scheduled)\b|\b(?:free|open|available|unavailable|works?|can\s+fit|booked|scheduled)\b.{0,100}\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|morning|afternoon|evening|slot|window|crew|calendar|job)\b)/iu,
  },
  {
    kind: 'price',
    pattern:
      /(?:\b(?:costs?|charges?|priced?|worth|runs?|comes?\s+to|quote|estimate|total|deposit|discount|tax)\b.{0,80}(?:\$?\s*\d[\d,.]*|\b(?:bucks?|dollars?|usd)\b)|(?:\$?\s*\d[\d,.]*)\s*(?:bucks?|dollars?|usd)\b)/iu,
  },
  {
    kind: 'measurement',
    pattern:
      /(?:\b(?:measures?|measurement|area|length|height|width|covers?|footprint|stories?|story)\b.{0,80}\b\d[\d,.]*\b|\b\d[\d,.]*\b.{0,40}\b(?:sq\.?\s*ft\.?|square\s+feet|linear\s+feet|feet|foot|stories?|story|gallons?)\b)/iu,
  },
  {
    kind: 'legal_or_regulatory',
    pattern:
      /\b(?:legal(?:ly)?|lawful(?:ly)?|compliant|compliance|permitted|required|prohibited|ordinance|regulation|statute|code\s+allows?|code\s+requires?)\b/iu,
  },
  {
    kind: 'chemical_instruction',
    pattern:
      /\b(?:bleach|chlorine|hypochlorite|acid|surfactant|chemical|pesticide|biocide|dilution|mixing\s+ratio)\b/iu,
  },
];

const statusMatchers: Readonly<Record<'payment_state' | 'delivery_state', RegExp>> = {
  payment_state:
    /\b(?:paid|unpaid|settled|processed|refunded|succeeded|failed|past\s+due|cleared|declined|voided|authorized|pending)\b/giu,
  delivery_state:
    /\b(?:delivered|sent|received|bounced|undeliverable|delivery\s+failed|queued|accepted|read|opened)\b/giu,
};

function normalizeToken(value: string): string {
  return value.toLowerCase().replaceAll(',', '').replace(/\s+/gu, '_');
}

function numericTokens(value: string): string[] {
  return [...value.matchAll(/\b\d[\d,.]*\b/gu)]
    .map((match) => Number(match[0].replaceAll(',', '')))
    .filter(Number.isFinite)
    .map((number) => `number:${number.toString()}`);
}

function statusTokens(value: string, kind: 'payment_state' | 'delivery_state'): string[] {
  return [...value.matchAll(statusMatchers[kind])].map(
    (match) => `status:${normalizeToken(match[0])}`,
  );
}

function measurementUnitTokens(value: string): string[] {
  const tokens: string[] = [];
  const square = /(?:square\s*(?:feet|foot)|sq\.?\s*ft\.?)/iu.test(value);
  const linear = /(?:linear\s*(?:feet|foot)|lin\.?\s*ft\.?)/iu.test(value);
  if (square) tokens.push('unit:sq_ft');
  if (linear) {
    tokens.push('unit:linear_ft');
  } else if (!square && /\b(?:feet|foot|ft\.?)\b/iu.test(value)) {
    tokens.push('unit:ft');
  }
  if (/\b(?:stories?|story)\b/iu.test(value)) tokens.push('unit:stories');
  if (/\b(?:gallons?|gal\.?)\b/iu.test(value)) tokens.push('unit:gallons');
  return tokens;
}

function availabilityTokens(value: string): string[] {
  const tokens: string[] = [];
  for (const match of value.matchAll(
    /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?/giu,
  )) {
    const normalized = match[0].toLowerCase();
    if (normalized.includes('t')) tokens.push(`instant:${normalized}`);
    tokens.push(`date:${normalized.slice(0, 10)}`);
  }
  if (/\bavailable\b/iu.test(value)) tokens.push('status:available');
  if (/\bunavailable\b/iu.test(value)) tokens.push('status:unavailable');
  if (/\bbooked\b/iu.test(value)) tokens.push('status:booked');
  if (/\bscheduled\b/iu.test(value)) tokens.push('status:scheduled');
  if (
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|today|tomorrow|am|pm)\b/iu.test(
      value,
    )
  ) {
    tokens.push('unsupported:relative_time');
  }
  return tokens;
}

function assertedValuesForClaim(value: string, kind: ProtectedNarrativeClaimKind): string[] {
  if (kind === 'measurement') {
    const tokens = [...numericTokens(value), ...measurementUnitTokens(value)];
    if (numberWordPattern.test(value)) tokens.push('unsupported:number_words');
    return tokens;
  }
  if (kind === 'price') {
    const tokens = numericTokens(value);
    if (numberWordPattern.test(value)) tokens.push('unsupported:number_words');
    return tokens;
  }
  if (kind === 'availability') return availabilityTokens(value);
  if (kind === 'payment_state' || kind === 'delivery_state') {
    return statusTokens(value, kind);
  }
  return [];
}

function detectProtectedClaims(value: string): ProtectedClaim[] {
  const matches = new Map<ProtectedNarrativeClaimKind, ProtectedClaim>();
  for (const rule of [...claimRules, ...conservativeClaimRules]) {
    if (!rule.pattern.test(value)) continue;
    matches.set(rule.kind, {
      kind: rule.kind,
      assertedValues: assertedValuesForClaim(value, rule.kind),
    });
  }
  return [...matches.values()];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function semanticFactMatch(fact: TrustedFact, kind: ProtectedNarrativeClaimKind): boolean {
  const identity = `${fact.id} ${fact.name}`.toLowerCase();
  const value = recordValue(fact.value);
  switch (kind) {
    case 'measurement':
      return (
        /\b(?:measurement|property_measurements)\b/u.test(identity) ||
        (/\bpropert(?:y|ies)\b/u.test(identity) &&
          value !== undefined &&
          Object.hasOwn(value, 'stories'))
      );
    case 'price':
      return (
        /\b(?:price|estimate|estimate_lines|quote)\b/u.test(identity) &&
        (fact.source === 'database' || fact.source === 'deterministic_calculation')
      );
    case 'availability':
      return /\b(?:availability|capacity|freebusy|free_busy|scheduling|visit)\b/u.test(identity);
    case 'payment_state':
      return (
        /\b(?:payment|payments|invoice|invoices)\b/u.test(identity) &&
        (fact.source === 'database' ||
          fact.source === 'provider' ||
          fact.source === 'deterministic_calculation')
      );
    case 'delivery_state':
      return (
        fact.source === 'provider' &&
        /\b(?:delivery|communication|message|sms|email|provider_event|callback)\b/u.test(identity)
      );
    case 'legal_or_regulatory':
    case 'chemical_instruction':
      return false;
  }
}

function collectNamedValues(
  value: unknown,
  names: ReadonlySet<string>,
  collected: unknown[] = [],
): unknown[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNamedValues(item, names, collected));
    return collected;
  }
  const record = recordValue(value);
  if (!record) return collected;
  for (const [key, nested] of Object.entries(record)) {
    if (names.has(key)) collected.push(nested);
    collectNamedValues(nested, names, collected);
  }
  return collected;
}

function numericValueTokens(values: unknown[]): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    if (
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value))
    ) {
      tokens.add(`number:${Number(value).toString()}`);
    }
  }
  return tokens;
}

function normalizedMeasurementUnit(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeToken(value).replaceAll('.', '');
  if (['sq_ft', 'square_feet', 'square_foot'].includes(normalized)) return 'unit:sq_ft';
  if (['linear_ft', 'linear_feet', 'linear_foot', 'lin_ft'].includes(normalized)) {
    return 'unit:linear_ft';
  }
  if (['ft', 'feet', 'foot'].includes(normalized)) return 'unit:ft';
  if (['story', 'stories'].includes(normalized)) return 'unit:stories';
  if (['gallon', 'gallons', 'gal'].includes(normalized)) return 'unit:gallons';
  return undefined;
}

function statusValueTokens(value: unknown): Set<string> {
  const tokens = new Set<string>();
  for (const status of collectNamedValues(
    value,
    new Set(['status', 'payment_status', 'provider_status', 'delivery_status']),
  )) {
    if (typeof status === 'string') tokens.add(`status:${normalizeToken(status)}`);
  }
  for (const counts of collectNamedValues(value, new Set(['statusCounts', 'status_counts']))) {
    const record = recordValue(counts);
    if (!record) continue;
    for (const [status, count] of Object.entries(record)) {
      if (typeof count === 'number' && count > 0) {
        tokens.add(`status:${normalizeToken(status)}`);
      }
    }
  }
  return tokens;
}

function availabilityFactTokens(value: unknown): Set<string> {
  const tokens = statusValueTokens(value);
  for (const status of collectNamedValues(
    value,
    new Set([
      'eligibility',
      'disposition',
      'capacityDisposition',
      'freeBusyDisposition',
      'capacity_disposition',
      'free_busy_disposition',
    ]),
  )) {
    if (typeof status !== 'string') continue;
    const normalized = normalizeToken(status);
    tokens.add(`status:${normalized}`);
    if (normalized === 'eligible') tokens.add('status:available');
    if (normalized === 'ineligible') tokens.add('status:unavailable');
  }
  for (const instant of collectNamedValues(
    value,
    new Set([
      'startsAt',
      'endsAt',
      'starts_at',
      'ends_at',
      'start',
      'end',
      'checkedAt',
      'validUntil',
    ]),
  )) {
    if (typeof instant !== 'string') continue;
    const normalized = instant.toLowerCase();
    tokens.add(`instant:${normalized}`);
    if (/^\d{4}-\d{2}-\d{2}/u.test(normalized)) {
      tokens.add(`date:${normalized.slice(0, 10)}`);
    }
  }
  return tokens;
}

function factAssertedValues(facts: TrustedFact[], kind: ProtectedNarrativeClaimKind): Set<string> {
  const tokens = new Set<string>();
  for (const fact of facts) {
    if (kind === 'measurement') {
      for (const token of numericValueTokens(
        collectNamedValues(
          fact.value,
          new Set(['value', 'quantity', 'stories', 'square_feet', 'linear_feet']),
        ),
      )) {
        tokens.add(token);
      }
      for (const unit of collectNamedValues(fact.value, new Set(['unit']))) {
        const normalized = normalizedMeasurementUnit(unit);
        if (normalized) tokens.add(normalized);
      }
      const factRecord = recordValue(fact.value);
      if (factRecord && Object.hasOwn(factRecord, 'stories')) tokens.add('unit:stories');
      continue;
    }
    if (kind === 'price') {
      for (const token of numericValueTokens(
        collectNamedValues(
          fact.value,
          new Set([
            'service_subtotal',
            'travel_fee',
            'discount',
            'tax',
            'total',
            'deposit_required',
            'estimated_cost',
            'estimated_margin_pct',
            'company_minimum',
            'default_tax_rate_pct',
            'margin_floor_pct',
            'automatic_discount_limit_pct',
            'deposit_value',
            'unit_price',
            'subtotal',
          ]),
        ),
      )) {
        tokens.add(token);
      }
      continue;
    }
    if (kind === 'payment_state' || kind === 'delivery_state') {
      for (const token of statusValueTokens(fact.value)) tokens.add(token);
      continue;
    }
    if (kind === 'availability') {
      for (const token of availabilityFactTokens(fact.value)) tokens.add(token);
    }
  }
  return tokens;
}

function groundingIssue(options: {
  code: NarrativeGroundingIssue['code'];
  location: NarrativeGroundingIssue['location'];
  itemIndex: number | null;
  claim: ProtectedClaim;
  sourceFactIds?: string[];
}): NarrativeGroundingIssue {
  return {
    code: options.code,
    location: options.location,
    itemIndex: options.itemIndex,
    kind: options.claim.kind,
    sourceFactIds: options.sourceFactIds ?? [],
  };
}

function evaluateTextWithoutCitations(
  text: string | null,
  location: 'summary' | 'unknown' | 'customer_draft',
  itemIndex: number | null,
): NarrativeGroundingIssue[] {
  if (!text) return [];
  return detectProtectedClaims(text).map((claim) =>
    groundingIssue({
      code:
        claim.kind === 'legal_or_regulatory' || claim.kind === 'chemical_instruction'
          ? 'NEVER_DELEGATED_CLAIM'
          : 'UNCITED_PROTECTED_CLAIM',
      location,
      itemIndex,
      claim,
    }),
  );
}

export function evaluateNarrativeGrounding(
  output: OfficeAgentOutput,
  request: OfficeRunRequest,
): NarrativeGroundingIssue[] {
  const factsById = new Map(request.trustedFacts.map((fact) => [fact.id, fact]));
  const issues: NarrativeGroundingIssue[] = [
    ...evaluateTextWithoutCitations(output.summary, 'summary', null),
    ...output.unknowns.flatMap((unknown, index) =>
      evaluateTextWithoutCitations(unknown, 'unknown', index),
    ),
    ...evaluateTextWithoutCitations(output.customerDraft, 'customer_draft', null),
  ];

  output.evidence.forEach((evidence, itemIndex) => {
    const citedFacts = evidence.sourceFactIds.flatMap((id) => {
      const fact = factsById.get(id);
      return fact ? [fact] : [];
    });
    for (const claim of detectProtectedClaims(evidence.claim)) {
      if (claim.kind === 'legal_or_regulatory' || claim.kind === 'chemical_instruction') {
        issues.push(
          groundingIssue({
            code: 'NEVER_DELEGATED_CLAIM',
            location: 'evidence_claim',
            itemIndex,
            claim,
            sourceFactIds: [...evidence.sourceFactIds],
          }),
        );
        continue;
      }
      const semanticallyMatchedFacts = citedFacts.filter((fact) =>
        semanticFactMatch(fact, claim.kind),
      );
      if (semanticallyMatchedFacts.length === 0) {
        issues.push(
          groundingIssue({
            code: 'SEMANTIC_SOURCE_MISMATCH',
            location: 'evidence_claim',
            itemIndex,
            claim,
            sourceFactIds: [...evidence.sourceFactIds],
          }),
        );
        continue;
      }
      const authoritativeValues = factAssertedValues(semanticallyMatchedFacts, claim.kind);
      if (
        claim.assertedValues.length === 0 ||
        claim.assertedValues.some((value) => !authoritativeValues.has(value))
      ) {
        issues.push(
          groundingIssue({
            code: 'FACT_VALUE_MISMATCH',
            location: 'evidence_claim',
            itemIndex,
            claim,
            sourceFactIds: [...evidence.sourceFactIds],
          }),
        );
      }
    }
  });

  return issues.map((issue) => narrativeGroundingIssueSchema.parse(issue));
}

export function groundOfficeAgentOutput(
  output: OfficeAgentOutput,
  request: OfficeRunRequest,
): OfficeRunOutput {
  const issues = evaluateNarrativeGrounding(output, request);
  if (issues.length > 0) {
    const codes = [...new Set(issues.map((issue) => `${issue.location}:${issue.code}`))].join(', ');
    throw new AiOfficeError(
      `AI model narrative failed deterministic grounding (${codes}).`,
      'INVALID_MODEL_OUTPUT',
    );
  }
  return {
    ...output,
    summary: `${AI_ADVISORY_SUMMARY_PREFIX}Model-authored prose was quarantined. Review ${
      output.evidence.length
    } cited evidence item(s), ${output.unknowns.length} unresolved item(s), and ${
      output.proposedActions.length
    } deterministic action disposition(s).`,
    evidence: output.evidence.map((evidence) => ({
      ...evidence,
      claim: `${AI_RATIONALE_PREFIX}Model-authored claim quarantined; review ${evidence.sourceFactIds.length} cited server-resolved fact(s).`,
    })),
    unknowns: output.unknowns.map(
      (_unknown, index) =>
        `${AI_REPORTED_UNKNOWN_PREFIX}Unresolved item ${index + 1}; inspect source records.`,
    ),
    proposedActions: output.proposedActions.map((proposal) => ({
      ...proposal,
      purpose:
        'Model-authored rationale quarantined; review the exact typed payload and deterministic policy disposition.',
    })),
    customerDraft: null,
    ownerAttention:
      output.ownerAttention || output.unknowns.length > 0 || output.customerDraft !== null,
    narrativePolicy: AI_NARRATIVE_POLICY,
  };
}
