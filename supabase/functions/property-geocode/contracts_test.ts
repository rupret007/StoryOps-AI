import {
  PROPERTY_GEOCODE_LOOKUP_SCHEMA_VERSION,
  candidateIsConfirmable,
  lookupHashPayload,
  propertyGeocodeCandidatesReceiptSchema,
  propertyGeocodeLookupRequestSchema,
} from './contracts.ts';

function assert(
  condition: unknown,
  message = 'Expected condition to be truthy',
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

const companyId = '10000000-0000-4000-8000-000000000001';
const propertyId = '10000000-0000-4000-8000-000000000201';
const operationId = '94900000-0000-4000-8000-000000000001';

Deno.test('property geocode lookup accepts only exact finite request facts', () => {
  const input = propertyGeocodeLookupRequestSchema.parse({
    schemaVersion: PROPERTY_GEOCODE_LOOKUP_SCHEMA_VERSION,
    companyId,
    propertyId,
    expectedPropertyVersion: 3,
    operationId,
  });
  assertEquals(lookupHashPayload(input), {
    schemaVersion: PROPERTY_GEOCODE_LOOKUP_SCHEMA_VERSION,
    operationId,
    propertyId,
    propertyVersion: 3,
  });
  assert(
    !propertyGeocodeLookupRequestSchema.safeParse({
      ...input,
      ownerSuppliedLatitude: 32.7,
    }).success,
  );
});

Deno.test('only a fresh high-confidence live provider candidate is confirmable', () => {
  const now = new Date('2026-07-30T15:00:00.000Z');
  const base = {
    provider: 'google_maps' as const,
    mode: 'live' as const,
    precision: 'rooftop' as const,
    confidence: 0.99,
    expiresAt: '2026-07-31T14:00:00.000Z',
  };
  assert(candidateIsConfirmable(base, now));
  assert(!candidateIsConfirmable({ ...base, confidence: 0.79 }, now));
  assert(!candidateIsConfirmable({ ...base, precision: 'city' }, now));
  assert(!candidateIsConfirmable({ ...base, expiresAt: '2026-07-30T14:59:59.000Z' }, now));
});

Deno.test('candidate receipt cannot claim sandbox evidence or omit confirmation boundary', () => {
  const candidate = {
    id: '94900000-0000-4000-8000-000000000002',
    propertyId,
    propertyVersion: 3,
    provider: 'google_maps',
    mode: 'live',
    formattedAddress: '123 Main St, Dallas, TX 75201, USA',
    latitude: 32.7767,
    longitude: -96.797,
    precision: 'rooftop',
    confidence: 0.99,
    providerPlaceId: 'place-123',
    observedAt: '2026-07-30T15:00:00.000Z',
    expiresAt: '2026-07-31T15:00:00.000Z',
    evidenceHash: 'a'.repeat(64),
  };
  const receipt = {
    schemaVersion: 'storyops-property-geocode-candidates-v1',
    operationId,
    companyId,
    propertyId,
    propertyVersion: 3,
    addressHash: 'b'.repeat(64),
    candidates: [candidate],
    requiresHumanConfirmation: true,
    replayed: false,
    serverTime: '2026-07-30T15:00:01.000Z',
  };
  assert(propertyGeocodeCandidatesReceiptSchema.safeParse(receipt).success);
  assert(
    !propertyGeocodeCandidatesReceiptSchema.safeParse({
      ...receipt,
      candidates: [{ ...candidate, mode: 'sandbox' }],
    }).success,
  );
  assert(
    !propertyGeocodeCandidatesReceiptSchema.safeParse({
      ...receipt,
      requiresHumanConfirmation: false,
    }).success,
  );
});
