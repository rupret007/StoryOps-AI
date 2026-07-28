import {
  asDecimalString,
  asDomainId,
  asISODateTime,
  asPercentageString,
  money,
  type PriceBook,
} from '@/domain';
import { calculateEstimate } from '@/core/pricing';

const companyId = asDomainId('10000000-0000-4000-8000-000000000001');
const priceBookId = asDomainId('10000000-0000-4000-8000-000000000401');
const propertyId = asDomainId('10000000-0000-4000-8000-000000000211');
const measurementId = asDomainId('10000000-0000-4000-8000-000000000441');
const effectiveFrom = asISODateTime('2026-01-01T00:00:00.000-06:00');
const calculatedAt = asISODateTime('2026-07-28T12:00:00.000-05:00');

const priceBook = (): PriceBook => ({
  id: priceBookId,
  companyId,
  createdAt: effectiveFrom,
  updatedAt: effectiveFrom,
  version: 1,
  name: 'DFW Residential',
  versionLabel: '2026.1',
  status: 'active',
  effectiveFrom,
  currency: 'USD',
  companyMinimum: money('149.00'),
  defaultTaxRate: asPercentageString('8.25'),
  marginFloor: asPercentageString('35'),
  automaticDiscountLimit: asPercentageString('10'),
  depositRule: {
    kind: 'percent',
    value: asPercentageString('25'),
  },
  travelZones: [
    {
      zoneCode: 'CORE',
      name: 'Core',
      fee: money('0.00'),
      taxable: false,
    },
    {
      zoneCode: 'OUTER',
      name: 'Outer',
      fee: money('35.00'),
      taxable: false,
    },
  ],
  serviceRules: [
    {
      serviceCode: 'pressure-wash-flatwork',
      pricingUnit: 'sq_ft',
      basePrice: money('0.00'),
      unitPrice: asDecimalString('0.18'),
      includedQuantity: asDecimalString('0'),
      serviceMinimum: money('149.00'),
      estimatedBaseCost: money('25.00'),
      estimatedUnitCost: asDecimalString('0.04'),
      durationBaseMinutes: 30,
      durationMinutesPerUnit: asDecimalString('0.04'),
      taxable: true,
      allowedAttributeValues: {
        surface: ['concrete', 'pavers'],
        soil: ['light', 'medium', 'heavy'],
        access: ['standard', 'difficult'],
        risk: ['standard', 'elevated'],
      },
      attributeMultipliers: [
        { attribute: 'surface', value: 'concrete', multiplier: asDecimalString('1') },
        { attribute: 'surface', value: 'pavers', multiplier: asDecimalString('1.2') },
        { attribute: 'soil', value: 'light', multiplier: asDecimalString('1') },
        { attribute: 'soil', value: 'medium', multiplier: asDecimalString('1.15') },
        { attribute: 'soil', value: 'heavy', multiplier: asDecimalString('1.35') },
        { attribute: 'access', value: 'standard', multiplier: asDecimalString('1') },
        { attribute: 'access', value: 'difficult', multiplier: asDecimalString('1.25') },
        { attribute: 'risk', value: 'standard', multiplier: asDecimalString('1') },
        { attribute: 'risk', value: 'elevated', multiplier: asDecimalString('1.3') },
      ],
      addOns: [
        {
          code: 'spot-treatment',
          name: 'Spot treatment',
          unit: 'each',
          unitPrice: asDecimalString('15.00'),
          taxable: true,
          estimatedUnitCost: asDecimalString('2.00'),
          durationMinutesPerUnit: asDecimalString('5'),
        },
      ],
    },
  ],
});

describe('deterministic pricing', () => {
  it('calculates the same exact cents, tax, deposit, cost, and duration from explicit rules', () => {
    const result = calculateEstimate({
      requestId: 'request-1',
      companyId,
      propertyId,
      priceBook: priceBook(),
      services: [
        {
          serviceCode: 'pressure-wash-flatwork',
          quantity: asDecimalString('1000'),
          attributes: {
            surface: 'concrete',
            soil: 'medium',
            access: 'standard',
            risk: 'standard',
          },
          addOns: [{ code: 'spot-treatment', quantity: asDecimalString('2') }],
          sourceMeasurementIds: [measurementId],
        },
      ],
      travelZoneCode: 'OUTER',
      discount: {
        kind: 'percent',
        value: asDecimalString('5'),
        reason: 'Launch offer',
      },
      customerTaxExempt: false,
      calculatedAt,
    });

    expect(result.quoteable).toBe(true);
    expect(result.lines.map((line) => line.kind)).toEqual(['service', 'add_on', 'travel']);
    expect(result.serviceSubtotal.amount).toBe('237.00');
    expect(result.travelFee.amount).toBe('35.00');
    expect(result.subtotalBeforeDiscount.amount).toBe('272.00');
    expect(result.discount.amount).toBe('13.60');
    expect(result.taxableSubtotal.amount).toBe('225.15');
    expect(result.tax.amount).toBe('18.57');
    expect(result.total.amount).toBe('276.97');
    expect(result.depositRequired.amount).toBe('69.24');
    expect(result.estimatedCost.amount).toBe('78.75');
    expect(result.marginPercent).toBe('69.52');
    expect(result.durationMinutes).toBe(91);
    expect(result.issues).toEqual([]);
    expect(result.approvalFlags).toEqual([]);
  });

  it('preserves fractional configured rates until the extended amount is rounded', () => {
    const book = priceBook();
    book.companyMinimum = money('0.00');
    book.defaultTaxRate = asPercentageString('0');
    book.marginFloor = asPercentageString('0');
    const rule = book.serviceRules[0];
    if (!rule) throw new Error('Expected a service rule fixture.');
    rule.unitPrice = asDecimalString('0.185');
    rule.estimatedBaseCost = money('0.00');
    rule.estimatedUnitCost = asDecimalString('0.0149');
    rule.allowedAttributeValues = {};
    rule.attributeMultipliers = [];

    const result = calculateEstimate({
      requestId: 'fractional-rates',
      companyId,
      propertyId,
      priceBook: book,
      services: [
        {
          serviceCode: rule.serviceCode,
          quantity: asDecimalString('1000'),
          attributes: {},
          addOns: [],
          sourceMeasurementIds: [measurementId],
        },
      ],
      discount: { kind: 'none' },
      customerTaxExempt: true,
      calculatedAt,
    });

    expect(result.lines[0]?.unitPrice).toBe('0.185');
    expect(result.serviceSubtotal.amount).toBe('185.00');
    expect(result.estimatedCost.amount).toBe('14.90');
  });

  it('never guesses a missing attribute value', () => {
    const result = calculateEstimate({
      requestId: 'request-2',
      companyId,
      propertyId,
      priceBook: priceBook(),
      services: [
        {
          serviceCode: 'pressure-wash-flatwork',
          quantity: asDecimalString('1000'),
          attributes: {
            surface: 'concrete',
            soil: 'medium',
            access: 'standard',
          },
          addOns: [],
          sourceMeasurementIds: [measurementId],
        },
      ],
      discount: { kind: 'none' },
      customerTaxExempt: false,
      calculatedAt,
    });

    expect(result.quoteable).toBe(false);
    expect(result.serviceSubtotal.amount).toBe('0.00');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'MISSING_ATTRIBUTE', serviceCode: 'pressure-wash-flatwork' }),
    );
  });

  it('flags large discounts, manual exceptions, low margins, and uncertain scope', () => {
    const book = priceBook();
    book.marginFloor = asPercentageString('90');
    const result = calculateEstimate({
      requestId: 'request-3',
      companyId,
      propertyId,
      priceBook: book,
      services: [
        {
          serviceCode: 'pressure-wash-flatwork',
          quantity: asDecimalString('1000'),
          attributes: {
            surface: 'concrete',
            soil: 'medium',
            access: 'standard',
            risk: 'standard',
          },
          addOns: [],
          sourceMeasurementIds: [measurementId],
        },
      ],
      discount: {
        kind: 'percent',
        value: asDecimalString('20'),
        reason: 'Customer request',
      },
      manualPriceAdjustment: money('-10.00'),
      customerTaxExempt: false,
      scopeEvidenceDisposition: 'human_review_required',
      calculatedAt,
    });

    expect(result.quoteable).toBe(false);
    expect(result.approvalFlags.map((flag) => flag.reason)).toEqual(
      expect.arrayContaining([
        'price_exception',
        'large_discount',
        'margin_below_floor',
        'uncertain_scope',
      ]),
    );
  });

  it('blocks an inactive or out-of-window price-book version', () => {
    const book = priceBook();
    book.status = 'retired';
    book.effectiveUntil = asISODateTime('2026-06-01T00:00:00.000-05:00');
    const result = calculateEstimate({
      requestId: 'request-4',
      companyId,
      propertyId,
      priceBook: book,
      services: [],
      discount: { kind: 'none' },
      customerTaxExempt: true,
      calculatedAt,
    });

    expect(result.quoteable).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['PRICE_BOOK_INACTIVE', 'PRICE_BOOK_NOT_EFFECTIVE', 'EMPTY_SCOPE']),
    );
  });
});
