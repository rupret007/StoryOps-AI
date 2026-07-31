import { z } from 'zod';

const uuidSchema = z.string().uuid();
const decimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,4})?$/u)
  .refine((value) => Number(value) > 0, 'Quantity must be positive.');
const moneySchema = z.string().regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/u);
const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const pricingAttributesSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{1,79}$/u), z.string().trim().min(1).max(80))
  .refine((attributes) => Object.keys(attributes).length <= 30, {
    message: 'A service may contain at most 30 bounded pricing attributes.',
  });

const contextRequestSchema = z
  .object({
    operation: z.literal('context'),
    companyId: uuidSchema,
    propertyId: uuidSchema.optional(),
  })
  .strict();

const requestedAddOnSchema = z
  .object({
    code: z.string().trim().min(1).max(80),
    measurementId: uuidSchema,
  })
  .strict();

const requestedServiceSchema = z
  .object({
    serviceCode: z.string().trim().min(1).max(100),
    measurementId: uuidSchema,
    supportingMeasurementIds: z.array(uuidSchema).max(12).default([]),
    attributes: pricingAttributesSchema.default({}),
    addOns: z.array(requestedAddOnSchema).max(12).default([]),
  })
  .strict()
  .refine(
    (service) => new Set(service.addOns.map((addOn) => addOn.code)).size === service.addOns.length,
    'An add-on code may appear only once per service.',
  )
  .refine(
    (service) =>
      new Set(service.supportingMeasurementIds).size === service.supportingMeasurementIds.length &&
      !service.supportingMeasurementIds.includes(service.measurementId),
    'Supporting measurement identities must be unique and separate from the priced quantity.',
  );

const discountSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('percent'),
      value: z.string().regex(/^(?:0|[1-9]\d?)(?:\.\d{1,2})?$|^100(?:\.0{1,2})?$/u),
      reason: z.string().trim().min(3).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fixed'),
      value: moneySchema,
      reason: z.string().trim().min(3).max(500),
    })
    .strict(),
]);

const calculateRequestSchema = z
  .object({
    operation: z.literal('calculate'),
    companyId: uuidSchema,
    customerId: uuidSchema,
    propertyId: uuidSchema,
    leadId: uuidSchema.optional(),
    packageCode: z.string().trim().min(1).max(80).optional(),
    idempotencyKey: idempotencyKeySchema,
    services: z.array(requestedServiceSchema).min(1).max(12),
    travelZoneCode: z.string().trim().min(1).max(80).optional(),
    discount: discountSchema.default({ kind: 'none' }),
  })
  .strict();

export const estimateWorkflowRequestSchema = z.discriminatedUnion('operation', [
  contextRequestSchema,
  calculateRequestSchema,
]);

export type EstimateWorkflowRequest = z.infer<typeof estimateWorkflowRequestSchema>;
export type EstimateCalculateRequest = z.infer<typeof calculateRequestSchema>;

export const persistedEstimateReceiptSchema = z
  .object({
    estimateId: uuidSchema,
    estimateNumber: z.string().min(1),
    quoteId: uuidSchema,
    quoteNumber: z.string().min(1),
    approvalId: uuidSchema.nullable(),
    estimateStatus: z.enum(['approved', 'pending_approval']),
    quoteStatus: z.enum(['draft', 'pending_approval']),
    total: moneySchema,
    depositRequired: moneySchema,
    calculationVersion: z.string().min(1),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    authoritativeSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    replayed: z.boolean(),
  })
  .strict();

export const humanMeasurementSchema = z
  .object({
    id: uuidSchema,
    propertyId: uuidSchema,
    kind: z.enum([
      'area_sq_ft',
      'length_linear_ft',
      'height_ft',
      'count',
      'stories',
      'duration_hours',
    ]),
    label: z.string(),
    value: decimalSchema,
    unit: z.enum(['sq_ft', 'linear_ft', 'ft', 'each', 'story', 'hour']),
    source: z.enum(['field_measured', 'map', 'customer_reported', 'photo_assisted', 'imported']),
    measuredAt: z.string(),
    confidence: z.string().nullable(),
    verifiedByHuman: z.literal(true),
    serviceCodes: z.array(z.string().min(1)),
    addOnCodes: z.array(z.string().min(1)),
  })
  .strict();
