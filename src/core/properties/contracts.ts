import { z } from 'zod';
import { sha256Hex } from '../ai/approval.ts';

export const CUSTOMER_PROPERTY_CREATE_SCHEMA_VERSION =
  'storyops-customer-property-create-v1' as const;
export const PROPERTY_GEOCODE_LOOKUP_SCHEMA_VERSION =
  'storyops-property-geocode-lookup-v1' as const;

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const printableText = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) =>
        ![...value].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 31 || codePoint === 127;
        }),
      'Control characters are not allowed.',
    );

export const serviceAddressInputSchema = z
  .object({
    line1: printableText(5, 240),
    line2: printableText(1, 240).optional(),
    city: printableText(2, 120),
    region: printableText(2, 80),
    postalCode: printableText(3, 20),
    country: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase()),
  })
  .strict();

export const createCustomerPropertyInputSchema = z
  .object({
    displayName: printableText(2, 200),
    email: z
      .union([z.literal(''), z.email().max(320)])
      .optional()
      .default(''),
    phone: z.string().trim().max(40).optional().default(''),
    acquisitionSource: printableText(1, 120).optional().default('manual'),
    propertyName: printableText(2, 200).optional().default('Primary property'),
    propertyType: z
      .enum(['single_family', 'multi_family', 'commercial', 'other'])
      .optional()
      .default('single_family'),
    serviceAddress: serviceAddressInputSchema,
    knownHazards: z.array(printableText(1, 200)).max(20).optional().default([]),
  })
  .strict();

export type CreateCustomerPropertyInput = z.input<typeof createCustomerPropertyInputSchema>;

export const customerPropertyCreatePayloadSchema = z
  .object({
    schemaVersion: z.literal(CUSTOMER_PROPERTY_CREATE_SCHEMA_VERSION),
    customer: z
      .object({
        id: uuidSchema,
        kind: z.enum(['individual', 'business']),
        displayName: printableText(2, 200),
        email: z.email().max(320).optional(),
        phone: printableText(1, 40).optional(),
        acquisitionSource: printableText(1, 120),
      })
      .strict(),
    property: z
      .object({
        id: uuidSchema,
        name: printableText(2, 200),
        propertyType: z.enum(['single_family', 'multi_family', 'commercial', 'other']),
        serviceAddress: serviceAddressInputSchema,
        knownHazards: z.array(printableText(1, 200)).max(20),
      })
      .strict(),
  })
  .strict();

export const customerPropertyCreateReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-customer-property-receipt-v1'),
    operationId: uuidSchema,
    customerId: uuidSchema,
    propertyId: uuidSchema,
    customerVersion: z.number().int().positive(),
    propertyVersion: z.number().int().positive(),
    requestHash: sha256Schema,
    replayed: z.boolean(),
    serverTime: z.iso.datetime({ offset: true }),
  })
  .strict();

export type CustomerPropertyCreateReceipt = z.infer<typeof customerPropertyCreateReceiptSchema>;

export async function buildCustomerPropertyCreateRequest(
  rawInput: CreateCustomerPropertyInput,
  identifiers: {
    operationId?: string;
    customerId?: string;
    propertyId?: string;
  } = {},
) {
  const input = createCustomerPropertyInputSchema.parse(rawInput);
  const operationId = uuidSchema.parse(identifiers.operationId ?? crypto.randomUUID());
  const customerId = uuidSchema.parse(identifiers.customerId ?? crypto.randomUUID());
  const propertyId = uuidSchema.parse(identifiers.propertyId ?? crypto.randomUUID());
  const payload = customerPropertyCreatePayloadSchema.parse({
    schemaVersion: CUSTOMER_PROPERTY_CREATE_SCHEMA_VERSION,
    customer: {
      id: customerId,
      kind: 'individual',
      displayName: input.displayName,
      ...(input.email ? { email: input.email } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
      acquisitionSource: input.acquisitionSource,
    },
    property: {
      id: propertyId,
      name: input.propertyName,
      propertyType: input.propertyType,
      serviceAddress: input.serviceAddress,
      knownHazards: [...new Set(input.knownHazards)].sort(),
    },
  });
  return {
    operationId,
    customerId,
    propertyId,
    payload,
    requestHash: await sha256Hex(payload),
  };
}

export const propertyGeocodeLookupRequestSchema = z
  .object({
    schemaVersion: z.literal(PROPERTY_GEOCODE_LOOKUP_SCHEMA_VERSION),
    companyId: uuidSchema,
    propertyId: uuidSchema,
    expectedPropertyVersion: z.number().int().positive(),
    operationId: uuidSchema,
  })
  .strict();

export type PropertyGeocodeLookupRequest = z.infer<typeof propertyGeocodeLookupRequestSchema>;

export function lookupHashPayload(input: PropertyGeocodeLookupRequest) {
  return {
    schemaVersion: PROPERTY_GEOCODE_LOOKUP_SCHEMA_VERSION,
    operationId: input.operationId,
    propertyId: input.propertyId,
    propertyVersion: input.expectedPropertyVersion,
  } as const;
}

export const propertyGeocodeCandidateSchema = z
  .object({
    id: uuidSchema,
    propertyId: uuidSchema,
    propertyVersion: z.number().int().positive(),
    provider: z.literal('google_maps'),
    mode: z.literal('live'),
    formattedAddress: printableText(5, 500),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    precision: z.enum(['rooftop', 'parcel', 'street', 'city', 'unknown']),
    confidence: z.number().finite().min(0).max(1),
    providerPlaceId: z.string().min(1).max(300).optional(),
    observedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    evidenceHash: sha256Schema,
  })
  .strict();

export type PropertyGeocodeCandidate = z.infer<typeof propertyGeocodeCandidateSchema>;

export const propertyGeocodeCandidatesReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-property-geocode-candidates-v1'),
    operationId: uuidSchema,
    companyId: uuidSchema,
    propertyId: uuidSchema,
    propertyVersion: z.number().int().positive(),
    addressHash: sha256Schema,
    candidates: z.array(propertyGeocodeCandidateSchema).min(1).max(5),
    requiresHumanConfirmation: z.literal(true),
    replayed: z.boolean(),
    serverTime: z.iso.datetime({ offset: true }),
  })
  .strict();

export type PropertyGeocodeCandidatesReceipt = z.infer<
  typeof propertyGeocodeCandidatesReceiptSchema
>;

export function candidateIsConfirmable(
  candidate: Pick<
    PropertyGeocodeCandidate,
    'mode' | 'provider' | 'precision' | 'confidence' | 'expiresAt'
  >,
  now = new Date(),
): boolean {
  return (
    candidate.mode === 'live' &&
    candidate.provider === 'google_maps' &&
    ['rooftop', 'parcel', 'street'].includes(candidate.precision) &&
    candidate.confidence >= 0.8 &&
    Date.parse(candidate.expiresAt) > now.getTime()
  );
}

export const propertyGeocodeConfirmationReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-property-geocode-confirmation-v1'),
    commandId: uuidSchema,
    companyId: uuidSchema,
    propertyId: uuidSchema,
    propertyVersion: z.number().int().positive(),
    candidateId: uuidSchema,
    provider: z.literal('google_maps'),
    precision: z.enum(['rooftop', 'parcel', 'street']),
    confidence: z.number().min(0.8).max(1),
    confirmedAt: z.iso.datetime({ offset: true }),
    requestHash: sha256Schema,
    replayed: z.boolean(),
  })
  .strict();

export type PropertyGeocodeConfirmationReceipt = z.infer<
  typeof propertyGeocodeConfirmationReceiptSchema
>;

export function propertyGeocodeConfirmationHashPayload(input: {
  propertyId: string;
  propertyVersion: number;
  candidateId: string;
}) {
  return {
    action: 'property.geocode.confirm',
    propertyId: uuidSchema.parse(input.propertyId),
    propertyVersion: z.number().int().positive().parse(input.propertyVersion),
    candidateId: uuidSchema.parse(input.candidateId),
  } as const;
}
