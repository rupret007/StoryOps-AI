import { z } from 'zod';

const uuidSchema = z.string().uuid();

const priceRuleSchema = z
  .object({
    serviceCode: z.string(),
    pricingUnit: z.enum(['flat', 'sq_ft', 'linear_ft', 'each', 'hour']),
    allowedAttributeValues: z.record(z.string(), z.array(z.string())),
    addOns: z.array(
      z.object({
        code: z.string(),
        name: z.string(),
        unit: z.enum(['flat', 'sq_ft', 'linear_ft', 'each', 'hour']),
      }),
    ),
  })
  .passthrough();

export const liveEstimateContextSchema = z
  .object({
    operation: z.literal('context'),
    companyId: uuidSchema,
    customers: z.array(
      z.object({
        id: uuidSchema,
        displayName: z.string(),
        taxExempt: z.boolean(),
      }),
    ),
    properties: z.array(
      z.object({
        id: uuidSchema,
        customerId: uuidSchema,
        name: z.string(),
        serviceAddress: z.record(z.string(), z.unknown()),
        stories: z.number().int().nullable(),
      }),
    ),
    measurements: z.array(
      z.object({
        id: uuidSchema,
        propertyId: uuidSchema,
        kind: z.enum(['area_sq_ft', 'length_linear_ft', 'height_ft', 'count', 'stories']),
        label: z.string(),
        value: z.string(),
        unit: z.enum(['sq_ft', 'linear_ft', 'ft', 'each', 'story']),
        source: z.enum([
          'field_measured',
          'map',
          'customer_reported',
          'photo_assisted',
          'imported',
        ]),
        measuredAt: z.string(),
        confidence: z.string().nullable(),
        verifiedByHuman: z.literal(true),
        serviceCodes: z.array(z.string()).default([]),
        addOnCodes: z.array(z.string()).default([]),
      }),
    ),
    photoEvidence: z
      .object({
        id: uuidSchema,
        confidence: z.string(),
        unknowns: z.array(z.string()),
        disposition: z.enum(['usable_for_scope', 'human_review_required', 'insufficient']),
        analyzedAt: z.string(),
        injectionSignals: z.array(z.string()),
      })
      .nullable(),
    priceBook: z
      .object({
        id: uuidSchema,
        versionLabel: z.string(),
        serviceRules: z.array(priceRuleSchema),
        travelZones: z.array(
          z
            .object({
              zoneCode: z.string(),
              name: z.string(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    serviceTerms: z.object({
      id: uuidSchema,
      versionLabel: z.string(),
      reviewReference: z.string(),
      reviewedAt: z.string(),
    }),
    derivedTravelZone: z
      .object({
        code: z.string(),
        source: z.enum(['postal_code', 'conservative_default']),
        postalCode: z.string(),
      })
      .nullable(),
  })
  .strict();

export type LiveEstimateContext = z.infer<typeof liveEstimateContextSchema>;

export interface LiveEstimateRequest {
  customerId: string;
  propertyId: string;
  leadId?: string;
  idempotencyKey: string;
  services: Array<{
    serviceCode: string;
    measurementId: string;
    attributes: {
      stories?: string;
      surface?: string;
      soil?: string;
      access?: string;
      risk?: string;
    };
    addOns?: Array<{ code: string; measurementId: string }>;
  }>;
  travelZoneCode?: string;
  discount:
    | { kind: 'none' }
    | { kind: 'percent'; value: string; reason: string }
    | { kind: 'fixed'; value: string; reason: string };
}

export type LiveEstimateIntent = Omit<LiveEstimateRequest, 'idempotencyKey'>;

export interface LiveEstimateIdempotencyReservation {
  intentFingerprint: string;
  idempotencyKey: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function reserveLiveEstimateIdempotencyKey(
  current: LiveEstimateIdempotencyReservation | undefined,
  intent: LiveEstimateIntent,
  keyFactory: () => string,
): LiveEstimateIdempotencyReservation {
  const intentFingerprint = JSON.stringify(canonicalize(intent));
  if (current?.intentFingerprint === intentFingerprint) return current;
  return {
    intentFingerprint,
    idempotencyKey: keyFactory(),
  };
}

export function confirmedLiveEstimateMatchesDraft(input: {
  confirmedContextKey: string | undefined;
  confirmedIntentFingerprint: string | undefined;
  currentContextKey: string;
  currentIntentFingerprint: string | undefined;
}): boolean {
  return Boolean(
    input.currentIntentFingerprint &&
    input.confirmedContextKey === input.currentContextKey &&
    input.confirmedIntentFingerprint === input.currentIntentFingerprint,
  );
}

export const liveEstimateReceiptSchema = z
  .object({
    estimateId: uuidSchema,
    estimateNumber: z.string(),
    quoteId: uuidSchema,
    quoteNumber: z.string(),
    approvalId: uuidSchema.nullable(),
    estimateStatus: z.enum(['approved', 'pending_approval']),
    quoteStatus: z.enum(['draft', 'pending_approval']),
    total: z.string(),
    depositRequired: z.string(),
    calculationVersion: z.string(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    authoritativeSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    replayed: z.boolean(),
  })
  .strict();

export type LiveEstimateReceipt = z.infer<typeof liveEstimateReceiptSchema>;
