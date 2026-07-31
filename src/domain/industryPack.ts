import type { PricingUnit, ServiceCatalogItem, ServicePriceRule } from './catalog.ts';
import type { EntityMetadata } from './primitives.ts';

export interface IndustryScopeDefinition {
  primaryMeasurementKind: string;
  pricingUnit: PricingUnit;
  scopeEvidencePolicy: 'photo_required' | 'photo_optional' | 'not_applicable';
  requiredPhotoViews: readonly string[];
  humanReviewTriggers: readonly string[];
}

export interface IndustryServiceTemplate<ServiceCode extends string = string> {
  templateVersion: string;
  catalogItem: Omit<ServiceCatalogItem, keyof EntityMetadata> & { code: ServiceCode };
  scope: IndustryScopeDefinition;
  priceRule: ServicePriceRule & { serviceCode: ServiceCode };
}

export interface ServiceIndustryPack<ServiceCode extends string = string> {
  code: string;
  name: string;
  version: string;
  description: string;
  serviceCodes: readonly ServiceCode[];
  serviceTemplates: readonly IndustryServiceTemplate<ServiceCode>[];
  supportedKernelCapabilities: readonly [
    'crm',
    'properties',
    'measured_pricing',
    'dispatch',
    'offline_field',
    'billing',
    'customer_portal',
    'ai_office',
  ];
}

export interface IndustryPackIssue {
  code:
    | 'DUPLICATE_SERVICE_CODE'
    | 'SERVICE_TEMPLATE_COVERAGE'
    | 'TEMPLATE_VERSION_MISMATCH'
    | 'CATALOG_PRICE_CODE_MISMATCH'
    | 'SCOPE_PRICING_UNIT_MISMATCH'
    | 'SCOPE_MEASUREMENT_KIND_MISMATCH'
    | 'SCOPE_REVIEW_CONTRACT_MISSING'
    | 'SCOPE_REVIEW_CONTRACT_CONFLICT'
    | 'SEMANTIC_CODE_INVALID';
  message: string;
  serviceCode?: string;
}

export function validateServiceIndustryPack(pack: ServiceIndustryPack): IndustryPackIssue[] {
  const issues: IndustryPackIssue[] = [];
  const semanticCode = /^[a-z][a-z0-9_-]{1,79}$/u;
  const snakeCaseCode = /^[a-z][a-z0-9_]{1,79}$/u;
  const kernelMeasurementKinds = new Set([
    'area_sq_ft',
    'length_linear_ft',
    'height_ft',
    'count',
    'stories',
    'duration_hours',
  ]);
  const primaryKindForUnit: Readonly<Record<PricingUnit, string>> = {
    flat: 'count',
    sq_ft: 'area_sq_ft',
    linear_ft: 'length_linear_ft',
    each: 'count',
    hour: 'duration_hours',
  };
  if (!semanticCode.test(pack.code)) {
    issues.push({
      code: 'SEMANTIC_CODE_INVALID',
      message: 'Industry pack codes must be bounded lowercase semantic codes.',
    });
  }
  const serviceCodes = new Set<string>();
  for (const serviceCode of pack.serviceCodes) {
    if (!semanticCode.test(serviceCode)) {
      issues.push({
        code: 'SEMANTIC_CODE_INVALID',
        serviceCode,
        message: `Service "${serviceCode}" is not a bounded semantic code.`,
      });
    }
    if (serviceCodes.has(serviceCode)) {
      issues.push({
        code: 'DUPLICATE_SERVICE_CODE',
        serviceCode,
        message: `Industry pack service code "${serviceCode}" is duplicated.`,
      });
    }
    serviceCodes.add(serviceCode);
  }

  const templateCodes = new Set(pack.serviceTemplates.map((template) => template.catalogItem.code));
  if (
    templateCodes.size !== serviceCodes.size ||
    [...serviceCodes].some((serviceCode) => !templateCodes.has(serviceCode))
  ) {
    issues.push({
      code: 'SERVICE_TEMPLATE_COVERAGE',
      message: 'Every registered service code must have exactly one service template.',
    });
  }

  for (const template of pack.serviceTemplates) {
    const serviceCode = template.catalogItem.code;
    if (
      !snakeCaseCode.test(template.catalogItem.category) ||
      !snakeCaseCode.test(template.scope.primaryMeasurementKind) ||
      Object.keys(template.priceRule.allowedAttributeValues).some(
        (attribute) => !snakeCaseCode.test(attribute),
      ) ||
      template.priceRule.attributeMultipliers.some(
        (multiplier) => !snakeCaseCode.test(multiplier.attribute),
      )
    ) {
      issues.push({
        code: 'SEMANTIC_CODE_INVALID',
        serviceCode,
        message: `Service "${serviceCode}" contains an invalid category, measurement, or pricing-dimension code.`,
      });
    }
    if (template.templateVersion !== pack.version) {
      issues.push({
        code: 'TEMPLATE_VERSION_MISMATCH',
        serviceCode,
        message: `Service "${serviceCode}" does not use pack version "${pack.version}".`,
      });
    }
    if (template.priceRule.serviceCode !== serviceCode) {
      issues.push({
        code: 'CATALOG_PRICE_CODE_MISMATCH',
        serviceCode,
        message: `Service "${serviceCode}" does not match its deterministic price rule.`,
      });
    }
    if (template.scope.pricingUnit !== template.priceRule.pricingUnit) {
      issues.push({
        code: 'SCOPE_PRICING_UNIT_MISMATCH',
        serviceCode,
        message: `Service "${serviceCode}" scope and price rule use different units.`,
      });
    }
    const requiredMeasurementKinds = template.catalogItem.requiredMeasurementKinds;
    const expectedPrimaryKind = primaryKindForUnit[template.scope.pricingUnit];
    if (
      requiredMeasurementKinds.length === 0 ||
      requiredMeasurementKinds.some((kind) => !kernelMeasurementKinds.has(kind)) ||
      requiredMeasurementKinds[0] !== expectedPrimaryKind ||
      new Set(requiredMeasurementKinds).size !== requiredMeasurementKinds.length
    ) {
      issues.push({
        code: 'SCOPE_MEASUREMENT_KIND_MISMATCH',
        serviceCode,
        message: `Service "${serviceCode}" must list the bounded ${expectedPrimaryKind} kernel measurement first for ${template.scope.pricingUnit} pricing, followed only by unique supporting kinds.`,
      });
    }
    if (
      template.scope.humanReviewTriggers.length === 0 ||
      (template.scope.scopeEvidencePolicy === 'photo_required' &&
        template.scope.requiredPhotoViews.length === 0)
    ) {
      issues.push({
        code: 'SCOPE_REVIEW_CONTRACT_MISSING',
        serviceCode,
        message: `Service "${serviceCode}" needs the human-review contract required by its scope-evidence policy.`,
      });
    }
    if (
      template.scope.scopeEvidencePolicy === 'not_applicable' &&
      template.scope.requiredPhotoViews.length > 0
    ) {
      issues.push({
        code: 'SCOPE_REVIEW_CONTRACT_CONFLICT',
        serviceCode,
        message: `Service "${serviceCode}" cannot require photo views when photo scope evidence is not applicable.`,
      });
    }
  }

  return issues;
}
