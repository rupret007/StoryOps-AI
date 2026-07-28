import { Decimal } from 'decimal.js';
import {
  asDecimalString,
  asDomainId,
  asISODateTime,
  asPercentageString,
  money,
  type PriceBook,
} from '@/domain';
import { calculateEstimate, type PricingResult } from '@/core/pricing';
import type { DemoEstimate } from '@/state/model';

const COMPANY_ID = asDomainId('a94b8d4e-33ad-46f3-ae42-72f70c9391bd');
const PRICE_BOOK_ID = asDomainId('fbe7afc4-d259-4690-814c-889fcb3d72a7');
const PROPERTY_ID = asDomainId('74b93545-9fa4-4561-a0e5-cc37130e38e6');
const DRIVEWAY_MEASUREMENT_ID = asDomainId('7394dd55-189e-48cf-bf03-8d12afc5d5df');
const GUTTER_MEASUREMENT_ID = asDomainId('d428b1bf-df8a-44e8-ad50-0cd13283a199');

export const demoPriceBook: PriceBook = {
  id: PRICE_BOOK_ID,
  companyId: COMPANY_ID,
  createdAt: asISODateTime('2026-07-01T14:00:00.000Z'),
  updatedAt: asISODateTime('2026-07-01T14:00:00.000Z'),
  version: 3,
  name: 'DFW Residential',
  versionLabel: '2026.07-v3',
  status: 'active',
  effectiveFrom: asISODateTime('2026-07-01T00:00:00.000Z'),
  currency: 'USD',
  companyMinimum: money('225.00'),
  travelZones: [
    {
      zoneCode: 'DFW-A',
      name: 'Core service zone',
      fee: money('0.00'),
      taxable: false,
      maximumOneWayMiles: asDecimalString('20'),
    },
    {
      zoneCode: 'DFW-B',
      name: 'Extended service zone',
      fee: money('35.00'),
      taxable: false,
      maximumOneWayMiles: asDecimalString('35'),
    },
    {
      zoneCode: 'DFW-C',
      name: 'Outer service zone',
      fee: money('75.00'),
      taxable: false,
      maximumOneWayMiles: asDecimalString('50'),
    },
  ],
  defaultTaxRate: asPercentageString('8.25'),
  marginFloor: asPercentageString('42'),
  automaticDiscountLimit: asPercentageString('10'),
  depositRule: {
    kind: 'percent',
    value: asPercentageString('25'),
  },
  serviceRules: [
    {
      serviceCode: 'DRIVEWAY_WASH',
      pricingUnit: 'sq_ft',
      basePrice: money('110.00'),
      unitPrice: asDecimalString('0.14'),
      includedQuantity: asDecimalString('500'),
      serviceMinimum: money('185.00'),
      estimatedBaseCost: money('45.00'),
      estimatedUnitCost: asDecimalString('0.05'),
      durationBaseMinutes: 45,
      durationMinutesPerUnit: asDecimalString('0.055'),
      taxable: true,
      allowedAttributeValues: {
        surface: ['concrete', 'pavers', 'aggregate'],
        soil: ['light', 'moderate', 'heavy'],
        access: ['clear', 'limited'],
        risk: ['standard', 'elevated'],
      },
      attributeMultipliers: [
        { attribute: 'surface', value: 'concrete', multiplier: asDecimalString('1') },
        { attribute: 'surface', value: 'pavers', multiplier: asDecimalString('1.2') },
        { attribute: 'surface', value: 'aggregate', multiplier: asDecimalString('1.15') },
        { attribute: 'soil', value: 'light', multiplier: asDecimalString('0.92') },
        { attribute: 'soil', value: 'moderate', multiplier: asDecimalString('1') },
        { attribute: 'soil', value: 'heavy', multiplier: asDecimalString('1.28') },
        { attribute: 'access', value: 'clear', multiplier: asDecimalString('1') },
        { attribute: 'access', value: 'limited', multiplier: asDecimalString('1.18') },
        { attribute: 'risk', value: 'standard', multiplier: asDecimalString('1') },
        { attribute: 'risk', value: 'elevated', multiplier: asDecimalString('1.25') },
      ],
      addOns: [
        {
          code: 'OIL_SPOT_TREAT',
          name: 'Oil spot pretreatment',
          unit: 'each',
          unitPrice: asDecimalString('22.00'),
          taxable: true,
          estimatedUnitCost: asDecimalString('5.50'),
          durationMinutesPerUnit: asDecimalString('8'),
        },
      ],
    },
    {
      serviceCode: 'GUTTER_CLEAN',
      pricingUnit: 'linear_ft',
      basePrice: money('155.00'),
      unitPrice: asDecimalString('0.85'),
      includedQuantity: asDecimalString('100'),
      serviceMinimum: money('180.00'),
      estimatedBaseCost: money('60.00'),
      estimatedUnitCost: asDecimalString('0.24'),
      durationBaseMinutes: 70,
      durationMinutesPerUnit: asDecimalString('0.32'),
      taxable: true,
      allowedAttributeValues: {
        stories: ['1', '2', '3'],
        soil: ['light', 'moderate', 'heavy'],
        access: ['clear', 'limited'],
        risk: ['standard', 'elevated'],
      },
      attributeMultipliers: [
        { attribute: 'stories', value: '1', multiplier: asDecimalString('1') },
        { attribute: 'stories', value: '2', multiplier: asDecimalString('1.22') },
        { attribute: 'stories', value: '3', multiplier: asDecimalString('1.55') },
        { attribute: 'soil', value: 'light', multiplier: asDecimalString('0.95') },
        { attribute: 'soil', value: 'moderate', multiplier: asDecimalString('1') },
        { attribute: 'soil', value: 'heavy', multiplier: asDecimalString('1.25') },
        { attribute: 'access', value: 'clear', multiplier: asDecimalString('1') },
        { attribute: 'access', value: 'limited', multiplier: asDecimalString('1.2') },
        { attribute: 'risk', value: 'standard', multiplier: asDecimalString('1') },
        { attribute: 'risk', value: 'elevated', multiplier: asDecimalString('1.3') },
      ],
      addOns: [
        {
          code: 'DOWNSPOUT_FLUSH',
          name: 'Downspout flow test and flush',
          unit: 'each',
          unitPrice: asDecimalString('18.00'),
          taxable: true,
          estimatedUnitCost: asDecimalString('4.00'),
          durationMinutesPerUnit: asDecimalString('7'),
        },
      ],
    },
  ],
  publishedBy: asDomainId('cd77c73c-30f1-48fa-9887-3846516a77b4'),
  publishedAt: asISODateTime('2026-07-01T14:00:00.000Z'),
};

export function calculateDemoPrice(estimate: DemoEstimate): PricingResult {
  const discountValue = asDecimalString(estimate.discountPercent || '0');
  return calculateEstimate({
    requestId: `estimate:${estimate.id}:${estimate.drivewaySqFt}:${estimate.gutterLinearFt}:${estimate.discountPercent}`,
    companyId: COMPANY_ID,
    propertyId: PROPERTY_ID,
    priceBook: demoPriceBook,
    services: [
      {
        serviceCode: 'DRIVEWAY_WASH',
        quantity: asDecimalString(estimate.drivewaySqFt),
        attributes: {
          surface: estimate.surface,
          soil: estimate.soil,
          access: estimate.access,
          risk: estimate.risk,
        },
        addOns: [],
        sourceMeasurementIds: [DRIVEWAY_MEASUREMENT_ID],
      },
      {
        serviceCode: 'GUTTER_CLEAN',
        quantity: asDecimalString(estimate.gutterLinearFt),
        attributes: {
          stories: estimate.stories,
          soil: estimate.soil,
          access: estimate.access,
          risk: estimate.risk,
        },
        addOns: [
          {
            code: 'DOWNSPOUT_FLUSH',
            quantity: asDecimalString('4'),
          },
        ],
        sourceMeasurementIds: [GUTTER_MEASUREMENT_ID],
      },
    ],
    travelZoneCode: estimate.travelZone,
    discount:
      discountValue === '0'
        ? { kind: 'none' }
        : {
            kind: 'percent',
            value: discountValue,
            reason: 'Owner-entered estimate discount',
          },
    customerTaxExempt: false,
    scopeEvidenceDisposition: estimate.photoEvidence.humanVerified
      ? 'usable_for_scope'
      : 'human_review_required',
    calculatedAt: asISODateTime('2026-07-28T15:00:00.000Z'),
  });
}

export interface DemoServiceTotals {
  driveway: string;
  gutters: string;
}

export function summarizeDemoServiceTotals(result: PricingResult): DemoServiceTotals {
  const sumService = (serviceCode: string): string =>
    result.lines
      .filter((line) => line.serviceCode === serviceCode)
      .reduce((total, line) => total.plus(line.subtotal.amount), new Decimal(0))
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toFixed(2);

  return {
    driveway: sumService('DRIVEWAY_WASH'),
    gutters: sumService('GUTTER_CLEAN'),
  };
}

export function mergeDemoPrice(estimate: DemoEstimate): DemoEstimate {
  const result = calculateDemoPrice(estimate);
  return {
    ...estimate,
    serviceSubtotal: result.serviceSubtotal.amount,
    travelFee: result.travelFee.amount,
    discount: result.discount.amount,
    tax: result.tax.amount,
    total: result.total.amount,
    deposit: result.depositRequired.amount,
    estimatedCost: result.estimatedCost.amount,
    marginPercent: result.marginPercent,
    durationMinutes: result.durationMinutes,
    formulaHash: `${result.calculationVersion} · ${result.requestId.slice(-12)}`,
  };
}
