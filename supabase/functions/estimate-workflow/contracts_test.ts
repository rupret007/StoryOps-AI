import {
  estimateWorkflowRequestSchema,
  humanMeasurementSchema,
  persistedEstimateReceiptSchema,
} from './contracts.ts';
import { measurementSupportsScope } from './evidence.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '10000000-0000-4000-8000-000000000201';
const PROPERTY_ID = '10000000-0000-4000-8000-000000000211';
const MEASUREMENT_ID = '10000000-0000-4000-8000-000000000441';

Deno.test(
  'estimate request accepts identifiers and classifications but no client quantity or price',
  () => {
    const parsed = estimateWorkflowRequestSchema.parse({
      operation: 'calculate',
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      propertyId: PROPERTY_ID,
      idempotencyKey: `estimate:${'a'.repeat(64)}`,
      services: [
        {
          serviceCode: 'pressure-wash-flatwork',
          measurementId: MEASUREMENT_ID,
          attributes: {
            surface: 'concrete',
            soil: 'medium',
            access: 'standard',
            risk: 'standard',
          },
        },
      ],
      travelZoneCode: 'DFW-CORE',
      discount: { kind: 'none' },
    });
    assertEquals(parsed.operation, 'calculate');
    if (parsed.operation !== 'calculate') {
      throw new Error('Expected a calculate request.');
    }

    const injected = estimateWorkflowRequestSchema.safeParse({
      ...parsed,
      services: [{ ...parsed.services[0], quantity: '1', unitPrice: '0.01' }],
    });
    assert(!injected.success);
  },
);

Deno.test('estimate request rejects unknown top-level fields and malformed discounts', () => {
  const base = {
    operation: 'calculate',
    companyId: COMPANY_ID,
    customerId: CUSTOMER_ID,
    propertyId: PROPERTY_ID,
    idempotencyKey: `estimate:${'b'.repeat(64)}`,
    services: [
      {
        serviceCode: 'gutter-cleaning',
        measurementId: MEASUREMENT_ID,
        attributes: {},
      },
    ],
  };
  assert(!estimateWorkflowRequestSchema.safeParse({ ...base, total: '1.00' }).success);
  assert(
    !estimateWorkflowRequestSchema.safeParse({
      ...base,
      discount: { kind: 'percent', value: '101', reason: 'invalid' },
    }).success,
  );
});

Deno.test('measurement contract requires explicit human verification', () => {
  const valid = {
    id: MEASUREMENT_ID,
    propertyId: PROPERTY_ID,
    kind: 'area_sq_ft',
    label: 'Driveway',
    value: '850',
    unit: 'sq_ft',
    source: 'field_measured',
    measuredAt: '2026-07-28T12:00:00.000Z',
    confidence: '1.0000',
    verifiedByHuman: true,
    serviceCodes: ['pressure-wash-flatwork'],
    addOnCodes: [],
  };
  assert(humanMeasurementSchema.safeParse(valid).success);
  assert(!humanMeasurementSchema.safeParse({ ...valid, verifiedByHuman: false }).success);
});

Deno.test('same-kind measurements cannot cross an authoritative service scope', () => {
  const driveway = {
    kind: 'area_sq_ft',
    unit: 'sq_ft',
    service_codes: ['pressure-wash-flatwork'],
    add_on_codes: [],
  };
  const siding = {
    ...driveway,
    service_codes: ['soft-wash-house'],
  };
  assert(measurementSupportsScope(driveway, 'sq_ft', 'pressure-wash-flatwork'));
  assert(!measurementSupportsScope(siding, 'sq_ft', 'pressure-wash-flatwork'));
  assert(!measurementSupportsScope(driveway, 'sq_ft', 'soft-wash-house'));
});

Deno.test('add-on evidence requires its explicit add-on tag', () => {
  const downspouts = {
    kind: 'count',
    unit: 'each',
    service_codes: [],
    add_on_codes: ['downspout-flush'],
  };
  assert(measurementSupportsScope(downspouts, 'each', 'gutter-cleaning', 'downspout-flush'));
  assert(!measurementSupportsScope(downspouts, 'each', 'gutter-cleaning', 'spot-treatment'));
});

Deno.test('persisted receipt is fail-closed and exact', () => {
  const receipt = {
    estimateId: '10000000-0000-4000-8000-000000000501',
    estimateNumber: 'EST-2026-0002',
    quoteId: '10000000-0000-4000-8000-000000000521',
    quoteNumber: 'Q-2026-0002',
    approvalId: null,
    estimateStatus: 'approved',
    quoteStatus: 'draft',
    total: '528.00',
    depositRequired: '132.00',
    calculationVersion: 'storyops-pricing-v1.1.0',
    requestHash: 'c'.repeat(64),
    authoritativeSnapshotHash: 'd'.repeat(64),
    replayed: false,
  };
  assert(persistedEstimateReceiptSchema.safeParse(receipt).success);
  assert(!persistedEstimateReceiptSchema.safeParse({ ...receipt, replayed: 'false' }).success);
});
