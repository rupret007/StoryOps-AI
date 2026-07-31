import {
  estimateWorkflowRequestSchema,
  humanMeasurementSchema,
  persistedEstimateReceiptSchema,
} from './contracts.ts';
import { estimateScopeEvidenceBundleSchema } from '../../../src/domain/estimateScopeEvidence.ts';
import {
  measurementSupportsScope,
  measurementSupportsServiceRequirement,
  resolveScopeEvidenceDisposition,
} from './evidence.ts';

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
const SCOPE_CHECKLIST_CODES = [
  'access_drainage_risk',
  'downspout_runoff',
  'flatwork_boundary',
  'front_elevation',
  'gutter_debris_guards',
  'left_elevation',
  'rear_elevation',
  'right_elevation',
  'roof_material_pitch_growth',
  'roof_planes_rooflines',
  'surface_growth_detail',
  'window_configuration',
];

Deno.test(
  'scope evidence policies support non-photo packs without weakening required photos',
  () => {
    assertEquals(
      resolveScopeEvidenceDisposition(['photo_required'], null),
      'human_review_required',
    );
    assertEquals(
      resolveScopeEvidenceDisposition(['photo_required'], 'insufficient'),
      'human_review_required',
    );
    assertEquals(
      resolveScopeEvidenceDisposition(['photo_required'], 'usable_for_scope'),
      'human_review_required',
    );
    assertEquals(
      resolveScopeEvidenceDisposition(['photo_required'], 'usable_for_scope', true),
      'usable_for_scope',
    );
    assertEquals(resolveScopeEvidenceDisposition(['photo_optional'], null), 'not_applicable');
    assertEquals(
      resolveScopeEvidenceDisposition(['photo_optional'], 'human_review_required'),
      'human_review_required',
    );
    assertEquals(resolveScopeEvidenceDisposition(['not_applicable'], null), 'not_applicable');
  },
);

Deno.test('eligible estimate scope bundles require exact v2 review and canonical evidence', () => {
  const valid = {
    schemaVersion: 'storyops-estimate-scope-evidence-v1',
    eligible: true,
    reason: null,
    requestId: '10000000-0000-4000-8000-000000000461',
    requestVersion: 1,
    requestStatus: 'reviewed',
    reviewId: '10000000-0000-4000-8000-000000000462',
    reviewedAt: '2026-07-29T12:00:00.000Z',
    reviewDisposition: 'confirmed_for_estimate',
    checklistVersion: 'exterior-scope-v2',
    checklistCodes: SCOPE_CHECKLIST_CODES,
    requiredChecklistCodes: SCOPE_CHECKLIST_CODES,
    submittedChecklistCodes: SCOPE_CHECKLIST_CODES,
    measurementIds: [MEASUREMENT_ID],
    analysisIds: ['10000000-0000-4000-8000-000000000451'],
    unresolvedUnknowns: [],
  };
  assert(estimateScopeEvidenceBundleSchema.safeParse(valid).success);
  assert(
    !estimateScopeEvidenceBundleSchema.safeParse({
      ...valid,
      unresolvedUnknowns: ['Access remains unknown.'],
    }).success,
  );
  assert(
    !estimateScopeEvidenceBundleSchema.safeParse({
      ...valid,
      submittedChecklistCodes: SCOPE_CHECKLIST_CODES.slice(1),
    }).success,
  );
  assert(
    !estimateScopeEvidenceBundleSchema.safeParse({
      ...valid,
      measurementIds: [MEASUREMENT_ID, MEASUREMENT_ID],
    }).success,
  );
});

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

Deno.test('estimate request accepts only a package identity, never package pricing', () => {
  const base = {
    operation: 'calculate',
    companyId: COMPANY_ID,
    customerId: CUSTOMER_ID,
    propertyId: PROPERTY_ID,
    packageCode: 'CURB_APPEAL_PLUS',
    idempotencyKey: `estimate:${'p'.repeat(64)}`,
    services: [
      {
        serviceCode: 'gutter-cleaning',
        measurementId: MEASUREMENT_ID,
        attributes: {},
      },
    ],
  };
  const parsed = estimateWorkflowRequestSchema.safeParse(base);
  assert(parsed.success);
  assert(
    !estimateWorkflowRequestSchema.safeParse({
      ...base,
      packagePrice: '1.00',
    }).success,
  );
});

Deno.test('estimate request accepts pack-defined bounded pricing attributes', () => {
  const parsed = estimateWorkflowRequestSchema.safeParse({
    operation: 'calculate',
    companyId: COMPANY_ID,
    customerId: CUSTOMER_ID,
    propertyId: PROPERTY_ID,
    idempotencyKey: `estimate:${'k'.repeat(64)}`,
    services: [
      {
        serviceCode: 'lawn-mowing',
        measurementId: MEASUREMENT_ID,
        attributes: {
          turf_condition: 'maintained',
          gate_clearance: 'standard',
        },
      },
    ],
  });
  assert(parsed.success);
  assert(
    !estimateWorkflowRequestSchema.safeParse({
      operation: 'calculate',
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      propertyId: PROPERTY_ID,
      idempotencyKey: `estimate:${'x'.repeat(64)}`,
      services: [
        {
          serviceCode: 'lawn-mowing',
          measurementId: MEASUREMENT_ID,
          attributes: { 'DROP TABLE': 'invalid' },
        },
      ],
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

Deno.test('flat and hourly rules require unit-safe human evidence', () => {
  assert(
    measurementSupportsScope(
      {
        kind: 'count',
        unit: 'each',
        value: '1',
        service_codes: ['inspection'],
        add_on_codes: [],
      },
      'flat',
      'inspection',
    ),
  );
  assert(
    !measurementSupportsScope(
      {
        kind: 'count',
        unit: 'each',
        value: '2',
        service_codes: ['inspection'],
        add_on_codes: [],
      },
      'flat',
      'inspection',
    ),
  );
  assert(
    measurementSupportsScope(
      {
        kind: 'duration_hours',
        unit: 'hour',
        value: '2.5',
        service_codes: ['consulting'],
        add_on_codes: [],
      },
      'hour',
      'consulting',
    ),
  );
});

Deno.test('industry-pack measurement semantics narrow otherwise unit-compatible evidence', () => {
  const area = {
    kind: 'area_sq_ft',
    unit: 'sq_ft',
    value: '400',
    service_codes: ['lawn-treatment'],
    add_on_codes: [],
  };
  assert(measurementSupportsScope(area, 'sq_ft', 'lawn-treatment', undefined, ['area_sq_ft']));
  assert(
    !measurementSupportsScope(area, 'sq_ft', 'lawn-treatment', undefined, ['length_linear_ft']),
  );
});

Deno.test('each catalog-required kind needs exact service-scoped evidence', () => {
  const gutterLength = {
    kind: 'length_linear_ft',
    unit: 'linear_ft',
    service_codes: ['gutter-cleaning'],
  };
  const downspoutCount = {
    kind: 'count',
    unit: 'each',
    service_codes: ['gutter-cleaning'],
  };
  const requiredKinds = ['length_linear_ft', 'count'];
  assert(
    requiredKinds.every((kind) =>
      [gutterLength, downspoutCount].some((measurement) =>
        measurementSupportsServiceRequirement(measurement, kind, 'gutter-cleaning'),
      ),
    ),
  );
  assert(
    !requiredKinds.every((kind) =>
      [gutterLength].some((measurement) =>
        measurementSupportsServiceRequirement(measurement, kind, 'gutter-cleaning'),
      ),
    ),
  );
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
