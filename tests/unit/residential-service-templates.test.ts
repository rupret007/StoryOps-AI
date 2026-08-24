import { describe, expect, it } from 'vitest';
import {
  calculateEstimate,
  calculatePackageEstimate,
  type PackagePricingRequest,
  type PricingRequest,
  type RequestedService,
} from '@/core/pricing';
import {
  createResidentialConfigurationPackages,
  createResidentialStarterPriceBook,
} from '@/data/residentialServiceTemplates';
import { asDecimalString, asDomainId, asISODateTime } from '@/domain';

const companyId = asDomainId('20000000-0000-4000-8000-000000000001');
const priceBookId = asDomainId('20000000-0000-4000-8000-000000000402');
const propertyId = asDomainId('20000000-0000-4000-8000-000000000211');
const measurementId = asDomainId('20000000-0000-4000-8000-000000000441');
const publisherId = asDomainId('20000000-0000-4000-8000-000000000101');
const calculatedAt = asISODateTime('2026-08-24T12:00:00.000-05:00');

const priceBook = createResidentialStarterPriceBook({
  id: priceBookId,
  companyId,
  createdAt: asISODateTime('2026-08-01T00:00:00.000-05:00'),
  updatedAt: asISODateTime('2026-08-01T00:00:00.000-05:00'),
  version: 1,
  status: 'active',
  effectiveFrom: asISODateTime('2026-08-01T00:00:00.000-05:00'),
  publishedBy: publisherId,
  publishedAt: asISODateTime('2026-08-01T00:00:00.000-05:00'),
});

const standardRecurring: RequestedService = {
  serviceCode: 'standard-recurring-clean',
  quantity: asDecimalString('1800'),
  attributes: {
    bedrooms: '3',
    bathrooms: '2',
    frequency: 'biweekly',
    occupancy: 'occupied',
    pets: 'none',
    access: 'clear',
    first_service: 'true',
  },
  addOns: [{ code: 'OVEN_CLEANING', quantity: asDecimalString('1') }],
  sourceMeasurementIds: [measurementId],
};

const deepClean: RequestedService = {
  serviceCode: 'deep-clean',
  quantity: asDecimalString('1500'),
  attributes: {
    condition: 'moderate',
    elapsed_since_last_service: '3_to_6_months',
    first_service: 'true',
    occupancy: 'occupied',
    access: 'clear',
    stories: '2',
  },
  addOns: [],
  sourceMeasurementIds: [measurementId],
};

const moveInOut: RequestedService = {
  serviceCode: 'move-in-out-clean',
  quantity: asDecimalString('2000'),
  attributes: {
    move_type: 'move-in',
    occupancy: 'occupied',
    appliance_count: '3-5',
    access: 'clear',
    condition: 'moderate',
  },
  addOns: [{ code: 'INTERIOR_WINDOWS', quantity: asDecimalString('10') }],
  sourceMeasurementIds: [measurementId],
};

const requestFor = (service: RequestedService): PricingRequest => ({
  requestId: `residential:${service.serviceCode}`,
  companyId,
  propertyId,
  priceBook,
  services: [service],
  discount: { kind: 'none' },
  customerTaxExempt: false,
  scopeEvidenceDisposition: 'usable_for_scope',
  calculatedAt,
});

describe('residential service starter pricing', () => {
  it.each([
    {
      name: 'standard recurring clean with oven',
      service: standardRecurring,
      serviceAmount: '394.44',
      addOnAmount: '24.00',
      total: '452.96',
      deposit: '90.59',
      estimatedCost: '137.03',
      durationMinutes: 246,
    },
    {
      name: 'deep clean',
      service: deepClean,
      serviceAmount: '575.50',
      addOnAmount: undefined,
      total: '622.98',
      deposit: '124.60',
      estimatedCost: '204.72',
      durationMinutes: 284,
    },
    {
      name: 'move-in clean with interior windows',
      service: moveInOut,
      serviceAmount: '616.00',
      addOnAmount: '65.00',
      total: '737.18',
      deposit: '147.44',
      estimatedCost: '192.25',
      durationMinutes: 317,
    },
  ])(
    'calculates exact line-item math for $name',
    ({ service, serviceAmount, addOnAmount, total, deposit, estimatedCost, durationMinutes }) => {
      const result = calculateEstimate(requestFor(service));

      expect(result.issues).toEqual([]);
      expect(result.approvalFlags).toEqual([]);
      expect(result.quoteable).toBe(true);
      expect(result.lines.find((line) => line.kind === 'service')?.subtotal.amount).toBe(
        serviceAmount,
      );
      expect(result.lines.find((line) => line.kind === 'add_on')?.subtotal.amount).toBe(
        addOnAmount,
      );
      expect(result.total.amount).toBe(total);
      expect(result.depositRequired.amount).toBe(deposit);
      expect(result.estimatedCost.amount).toBe(estimatedCost);
      expect(result.durationMinutes).toBe(durationMinutes);
    },
  );

  it('prices the exact best-package scope without silently adding optional add-ons', () => {
    const packageDefinition = createResidentialConfigurationPackages().find(
      (candidate) => candidate.code === 'PEAK_HOME_CARE',
    );
    if (!packageDefinition) throw new Error('Expected the residential best package.');
    const request: PackagePricingRequest = {
      ...requestFor(standardRecurring),
      requestId: 'residential:package:best',
      packageDefinition,
      measuredServices: [
        { ...standardRecurring, addOns: [] },
        deepClean,
        { ...moveInOut, addOns: [] },
      ],
      selectedOptionalServiceCodes: [],
      selectedOptionalAddOns: [],
    };

    const result = calculatePackageEstimate(request);

    expect(result.issues).toEqual([]);
    expect(result.approvalFlags).toEqual([]);
    expect(result.pricedServiceCodes).toEqual([
      'standard-recurring-clean',
      'deep-clean',
      'move-in-out-clean',
    ]);
    expect(result.lines.filter((line) => line.kind === 'add_on')).toEqual([]);
    expect(result.serviceSubtotal.amount).toBe('1585.94');
    expect(result.tax.amount).toBe('130.84');
    expect(result.total.amount).toBe('1716.78');
    expect(result.depositRequired.amount).toBe('343.36');
    expect(result.estimatedCost.amount).toBe('505.00');
    expect(result.durationMinutes).toBe(774);
  });

  it('fails closed on missing condition and flags severe condition for owner approval', () => {
    const { condition: _condition, ...missingConditionAttributes } = deepClean.attributes;
    const missingCondition = calculateEstimate(
      requestFor({ ...deepClean, attributes: missingConditionAttributes }),
    );
    expect(missingCondition.quoteable).toBe(false);
    expect(missingCondition.issues).toContainEqual(
      expect.objectContaining({ code: 'MISSING_ATTRIBUTE', serviceCode: 'deep-clean' }),
    );

    const severeCondition = calculateEstimate(
      requestFor({
        ...deepClean,
        attributes: { ...deepClean.attributes, condition: 'severe' },
      }),
    );
    expect(severeCondition.quoteable).toBe(false);
    expect(severeCondition.approvalFlags).toContainEqual(
      expect.objectContaining({ reason: 'outside_sop', blocking: true }),
    );
  });
});
