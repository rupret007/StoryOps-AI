import { Decimal } from 'decimal.js';
import {
  asDecimalString,
  asDomainId,
  asISODateTime,
  asPercentageString,
  money,
  type PriceBook,
  type ServicePackageDefinition,
} from '@/domain';
import { calculatePackageEstimate, type PricingResult } from '@/core/pricing';
import type { CompanyConfiguration } from '@/domain/companyConfiguration';
import type { DemoEstimate } from '@/state/model';
import {
  createExteriorStarterPriceBook,
  getExteriorServicePackage,
} from './exteriorServiceTemplates.ts';

const DEMO_ENABLED_SERVICE_CODES = ['pressure-wash-flatwork', 'gutter-cleaning'] as const;

const COMPANY_ID = asDomainId('a94b8d4e-33ad-46f3-ae42-72f70c9391bd');
const PRICE_BOOK_ID = asDomainId('fbe7afc4-d259-4690-814c-889fcb3d72a7');
const PROPERTY_ID = asDomainId('74b93545-9fa4-4561-a0e5-cc37130e38e6');
const DRIVEWAY_MEASUREMENT_ID = asDomainId('7394dd55-189e-48cf-bf03-8d12afc5d5df');
const GUTTER_MEASUREMENT_ID = asDomainId('d428b1bf-df8a-44e8-ad50-0cd13283a199');

export const demoPriceBook = createExteriorStarterPriceBook({
  id: PRICE_BOOK_ID,
  companyId: COMPANY_ID,
  createdAt: asISODateTime('2026-07-01T14:00:00.000Z'),
  updatedAt: asISODateTime('2026-07-01T14:00:00.000Z'),
  version: 3,
  status: 'active',
  effectiveFrom: asISODateTime('2026-07-01T00:00:00.000Z'),
  publishedBy: asDomainId('cd77c73c-30f1-48fa-9887-3846516a77b4'),
  publishedAt: asISODateTime('2026-07-01T14:00:00.000Z'),
});

function priceBookFromPublishedSandboxConfiguration(
  configuration: CompanyConfiguration,
): PriceBook {
  return {
    id: PRICE_BOOK_ID,
    companyId: COMPANY_ID,
    createdAt: asISODateTime('2026-07-01T14:00:00.000Z'),
    updatedAt: asISODateTime('2026-07-01T14:00:00.000Z'),
    version: 1,
    name: 'Published sandbox company configuration',
    versionLabel: configuration.pricing.priceBookTemplateVersion,
    status: 'active',
    effectiveFrom: asISODateTime('2026-07-01T00:00:00.000Z'),
    currency: 'USD',
    companyMinimum: money(configuration.pricing.companyMinimum),
    travelZones: configuration.territory.travelZones.map((zone) => ({
      zoneCode: zone.code,
      name: zone.name,
      fee: money(zone.fee),
      taxable: false,
      ...(zone.maximumMiles ? { maximumOneWayMiles: asDecimalString(zone.maximumMiles) } : {}),
      postalCodes: [...zone.postalCodes],
    })),
    defaultTaxRate: asPercentageString(
      configuration.pricing.taxEnabled ? configuration.pricing.defaultTaxRatePercent : '0',
    ),
    marginFloor: asPercentageString(configuration.pricing.marginFloorPercent),
    automaticDiscountLimit: asPercentageString(configuration.pricing.automaticDiscountLimitPercent),
    depositRule: {
      kind:
        configuration.payments.depositKind === 'fixed'
          ? 'flat'
          : configuration.payments.depositKind,
      value:
        configuration.payments.depositKind === 'percent'
          ? asPercentageString(configuration.payments.depositValue)
          : money(configuration.payments.depositValue),
    },
    serviceRules: configuration.pricing.serviceRules.map((rule) => ({
      serviceCode: rule.serviceCode,
      requiredMeasurementKinds: [...rule.requiredMeasurementKinds],
      pricingUnit: rule.pricingUnit,
      basePrice: money(rule.basePrice),
      unitPrice: asDecimalString(rule.unitPrice),
      includedQuantity: asDecimalString(rule.includedQuantity),
      serviceMinimum: money(rule.serviceMinimum),
      estimatedBaseCost: money(rule.estimatedBaseCost),
      estimatedUnitCost: asDecimalString(rule.estimatedUnitCost),
      durationBaseMinutes: rule.durationBaseMinutes,
      durationMinutesPerUnit: asDecimalString(rule.durationMinutesPerUnit),
      taxable: rule.taxable,
      allowedAttributeValues: Object.fromEntries(
        Object.entries(rule.allowedAttributeValues).map(([attribute, values]) => [
          attribute,
          [...values],
        ]),
      ),
      attributeMultipliers: rule.attributeMultipliers.map((multiplier) => ({
        attribute: multiplier.attribute,
        value: multiplier.value,
        multiplier: asDecimalString(multiplier.multiplier),
        ...(multiplier.approval ? { approval: { ...multiplier.approval } } : {}),
      })),
      addOns: rule.addOns.map((addOn) => ({
        code: addOn.code,
        name: addOn.name,
        unit: addOn.pricingUnit,
        unitPrice: asDecimalString(addOn.unitPrice),
        taxable: addOn.taxable,
        estimatedUnitCost: asDecimalString(addOn.estimatedUnitCost),
        durationMinutesPerUnit: asDecimalString(addOn.durationMinutesPerUnit),
        ...(addOn.approval ? { approval: { ...addOn.approval } } : {}),
      })),
    })),
    publishedBy: asDomainId('cd77c73c-30f1-48fa-9887-3846516a77b4'),
    publishedAt: asISODateTime('2026-07-01T14:00:00.000Z'),
  };
}

function packageFromPublishedSandboxConfiguration(
  configuration: CompanyConfiguration,
): ServicePackageDefinition {
  const selected = configuration.pricing.packages.find(
    (servicePackage) => servicePackage.code === 'WHOLE_PROPERTY_CARE',
  );
  if (!selected) {
    throw new Error('The published sandbox configuration has no Whole-property care package.');
  }
  return {
    ...selected,
    components: selected.components.map((component) => ({
      ...component,
      requiredAddOnCodes: [...component.requiredAddOnCodes],
      optionalAddOnCodes: [...component.optionalAddOnCodes],
    })),
  };
}

export function calculateDemoPrice(
  estimate: DemoEstimate,
  publishedConfiguration?: CompanyConfiguration,
): PricingResult {
  const discountValue = asDecimalString(estimate.discountPercent || '0');
  const enabledServiceCodes =
    publishedConfiguration?.pricing.enabledServiceCodes ?? DEMO_ENABLED_SERVICE_CODES;
  for (const requiredServiceCode of DEMO_ENABLED_SERVICE_CODES) {
    if (!enabledServiceCodes.includes(requiredServiceCode)) {
      throw new Error(
        `The published sandbox configuration does not authorize ${requiredServiceCode}.`,
      );
    }
  }
  return calculatePackageEstimate({
    requestId: `estimate:${estimate.id}:${estimate.drivewaySqFt}:${estimate.gutterLinearFt}:${estimate.downspoutCount}:${estimate.discountPercent}`,
    companyId: COMPANY_ID,
    propertyId: PROPERTY_ID,
    priceBook: publishedConfiguration
      ? priceBookFromPublishedSandboxConfiguration(publishedConfiguration)
      : demoPriceBook,
    packageDefinition: publishedConfiguration
      ? packageFromPublishedSandboxConfiguration(publishedConfiguration)
      : getExteriorServicePackage('WHOLE_PROPERTY_CARE', DEMO_ENABLED_SERVICE_CODES),
    measuredServices: [
      {
        serviceCode: 'pressure-wash-flatwork',
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
        serviceCode: 'gutter-cleaning',
        quantity: asDecimalString(estimate.gutterLinearFt),
        attributes: {
          stories: estimate.stories,
          gutter_guards: 'none',
          roof_access: estimate.access,
          debris: estimate.soil,
          risk: estimate.risk,
        },
        addOns: [
          {
            code: 'DOWNSPOUT_FLUSH',
            quantity: asDecimalString(estimate.downspoutCount),
          },
        ],
        sourceMeasurementIds: [GUTTER_MEASUREMENT_ID],
      },
    ],
    selectedOptionalServiceCodes: [],
    selectedOptionalAddOns: [],
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
    driveway: sumService('pressure-wash-flatwork'),
    gutters: sumService('gutter-cleaning'),
  };
}

export function mergeDemoPrice(
  estimate: DemoEstimate,
  publishedConfiguration?: CompanyConfiguration,
): DemoEstimate {
  const result = calculateDemoPrice(estimate, publishedConfiguration);
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
