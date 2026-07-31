import { Decimal } from 'decimal.js';
import type { CompanyConfiguration } from '@/domain/companyConfiguration';
import type { DepositRule, PricingUnit, ServicePriceRule } from '@/domain';
import { demoPriceBook } from '@/data/priceBook';
import { exteriorServiceTemplates } from '@/data/exteriorServiceTemplates';

const PILOT_SERVICE_CODES = ['pressure-wash-flatwork', 'gutter-cleaning'] as const;

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const serviceNames = new Map<string, string>(
  exteriorServiceTemplates.map((template) => [
    template.catalogItem.code,
    template.catalogItem.name,
  ]),
);

export interface SandboxPricingRulePresentation {
  serviceCode: string;
  name: string;
  enabled: boolean;
  unitLabel: string;
  summary: string;
  addOns: Array<{
    code: string;
    name: string;
    unitLabel: string;
    summary: string;
  }>;
}

export interface SandboxTravelZonePresentation {
  code: string;
  name: string;
  boundary: string;
  fee: string;
}

export interface SandboxPricingPresentation {
  source: 'published_configuration' | 'starter_fixture';
  sourceLabel: string;
  versionLabel: string;
  companyMinimum: string;
  marginFloor: string;
  automaticDiscountLimit: string;
  deposit: string;
  taxRule: string;
  enabledServiceCodes: string[];
  serviceRules: SandboxPricingRulePresentation[];
  travelZones: SandboxTravelZonePresentation[];
}

function decimal(value: string): string {
  return new Decimal(value).toFixed(6).replace(/(?:\.0+|(\.\d+?)0+)$/u, '$1');
}

function money(value: string): string {
  return currency.format(new Decimal(value).toNumber());
}

function percent(value: string): string {
  return `${decimal(value)}%`;
}

function unitLabel(unit: PricingUnit): string {
  return unit === 'sq_ft'
    ? 'sq ft'
    : unit === 'linear_ft'
      ? 'linear ft'
      : unit === 'each'
        ? 'each'
        : unit === 'hour'
          ? 'hour'
          : 'flat service';
}

function priceRuleSummary(input: {
  basePrice: string;
  unitPrice: string;
  includedQuantity: string;
  serviceMinimum: string;
  pricingUnit: PricingUnit;
}): string {
  const parts = [`${money(input.basePrice)} base`];
  if (new Decimal(input.unitPrice).greaterThan(0)) {
    parts.push(
      `${money(input.unitPrice)} / ${unitLabel(input.pricingUnit)}${
        new Decimal(input.includedQuantity).greaterThan(0)
          ? ` after ${decimal(input.includedQuantity)}`
          : ''
      }`,
    );
  }
  if (new Decimal(input.serviceMinimum).greaterThan(0)) {
    parts.push(`${money(input.serviceMinimum)} service minimum`);
  }
  return parts.join(' · ');
}

function depositLabel(rule: { kind: DepositRule['kind'] | 'fixed'; value: string }): string {
  if (rule.kind === 'none') return 'None';
  return rule.kind === 'percent' ? percent(rule.value) : money(rule.value);
}

function normalizeStarterRule(
  rule: ServicePriceRule,
  enabledServiceCodes: ReadonlySet<string>,
): SandboxPricingRulePresentation {
  return {
    serviceCode: rule.serviceCode,
    name: serviceNames.get(rule.serviceCode) ?? rule.serviceCode,
    enabled: enabledServiceCodes.has(rule.serviceCode),
    unitLabel: unitLabel(rule.pricingUnit),
    summary: priceRuleSummary({
      basePrice: rule.basePrice.amount,
      unitPrice: rule.unitPrice,
      includedQuantity: rule.includedQuantity,
      serviceMinimum: rule.serviceMinimum?.amount ?? '0',
      pricingUnit: rule.pricingUnit,
    }),
    addOns: rule.addOns.map((addOn) => ({
      code: addOn.code,
      name: addOn.name,
      unitLabel: unitLabel(addOn.unit),
      summary: `${money(addOn.unitPrice)} / ${unitLabel(addOn.unit)}`,
    })),
  };
}

function normalizePublishedRule(
  rule: CompanyConfiguration['pricing']['serviceRules'][number],
  enabledServiceCodes: ReadonlySet<string>,
): SandboxPricingRulePresentation {
  return {
    serviceCode: rule.serviceCode,
    name: serviceNames.get(rule.serviceCode) ?? rule.serviceCode,
    enabled: enabledServiceCodes.has(rule.serviceCode),
    unitLabel: unitLabel(rule.pricingUnit),
    summary: priceRuleSummary({
      basePrice: rule.basePrice,
      unitPrice: rule.unitPrice,
      includedQuantity: rule.includedQuantity,
      serviceMinimum: rule.serviceMinimum,
      pricingUnit: rule.pricingUnit,
    }),
    addOns: rule.addOns.map((addOn) => ({
      code: addOn.code,
      name: addOn.name,
      unitLabel: unitLabel(addOn.pricingUnit),
      summary: `${money(addOn.unitPrice)} / ${unitLabel(addOn.pricingUnit)}`,
    })),
  };
}

export function deriveSandboxPricingPresentation(
  publishedConfiguration?: CompanyConfiguration,
): SandboxPricingPresentation {
  if (publishedConfiguration) {
    const enabledServiceCodes = new Set(publishedConfiguration.pricing.enabledServiceCodes);
    return {
      source: 'published_configuration',
      sourceLabel: 'Published sandbox company configuration',
      versionLabel: publishedConfiguration.pricing.priceBookTemplateVersion,
      companyMinimum: money(publishedConfiguration.pricing.companyMinimum),
      marginFloor: percent(publishedConfiguration.pricing.marginFloorPercent),
      automaticDiscountLimit: percent(publishedConfiguration.pricing.automaticDiscountLimitPercent),
      deposit: depositLabel({
        kind: publishedConfiguration.payments.depositKind,
        value: publishedConfiguration.payments.depositValue,
      }),
      taxRule: publishedConfiguration.pricing.taxEnabled
        ? percent(publishedConfiguration.pricing.defaultTaxRatePercent)
        : 'Disabled',
      enabledServiceCodes: [...enabledServiceCodes],
      serviceRules: publishedConfiguration.pricing.serviceRules.map((rule) =>
        normalizePublishedRule(rule, enabledServiceCodes),
      ),
      travelZones: publishedConfiguration.territory.travelZones.map((zone) => ({
        code: zone.code,
        name: zone.name,
        boundary: zone.maximumMiles
          ? `Up to ${decimal(zone.maximumMiles)} one-way miles`
          : `${zone.postalCodes.length} reviewed ZIP ${
              zone.postalCodes.length === 1 ? 'mapping' : 'mappings'
            }`,
        fee: money(zone.fee),
      })),
    };
  }

  const enabledServiceCodes = new Set<string>(PILOT_SERVICE_CODES);
  return {
    source: 'starter_fixture',
    sourceLabel: 'Starter pricing fixture only · no company configuration published',
    versionLabel: `${demoPriceBook.name} · ${demoPriceBook.versionLabel}`,
    companyMinimum: money(demoPriceBook.companyMinimum.amount),
    marginFloor: percent(demoPriceBook.marginFloor),
    automaticDiscountLimit: percent(demoPriceBook.automaticDiscountLimit),
    deposit: depositLabel({
      kind: demoPriceBook.depositRule.kind,
      value:
        typeof demoPriceBook.depositRule.value === 'string'
          ? demoPriceBook.depositRule.value
          : demoPriceBook.depositRule.value.amount,
    }),
    taxRule: percent(demoPriceBook.defaultTaxRate),
    enabledServiceCodes: [...enabledServiceCodes],
    serviceRules: demoPriceBook.serviceRules.map((rule) =>
      normalizeStarterRule(rule, enabledServiceCodes),
    ),
    travelZones: demoPriceBook.travelZones.map((zone) => ({
      code: zone.zoneCode,
      name: zone.name,
      boundary: zone.maximumOneWayMiles
        ? `Up to ${decimal(zone.maximumOneWayMiles)} one-way miles`
        : 'Reviewed ZIP mappings only',
      fee: money(zone.fee.amount),
    })),
  };
}
