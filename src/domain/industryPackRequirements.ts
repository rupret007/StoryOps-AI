import { getServiceIndustryPack, serviceIndustryPacks } from '../data/industryPacks.ts';
import type { ServiceIndustryPack } from './industryPack.ts';

export interface IndustryPackMetadataReference {
  code: string;
  version: string;
}

export interface IndustryServiceRequirements {
  requiredSkills: string[];
  requiredEquipmentTypes: string[];
}

export interface IndustryPackPricingSemantics {
  pricingUnit: 'flat' | 'sq_ft' | 'linear_ft' | 'each' | 'hour';
  requiredMeasurementKinds: string[];
}

export interface ResolvePackInput {
  enabledServiceCodes: readonly string[];
  activePack?: IndustryPackMetadataReference;
  priceBookTemplateVersion?: string;
}

interface TemplateMetadata {
  serviceCode: string;
  requiredSkills: readonly string[];
  requiredEquipmentTypes: readonly string[];
}

function canonicalizeServiceCodeList(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function packContainsAllServices(
  pack: ServiceIndustryPack,
  enabledServiceCodes: readonly string[],
): boolean {
  const packServiceSet = new Set<string>(pack.serviceCodes as readonly string[]);
  return enabledServiceCodes.every((serviceCode) => packServiceSet.has(serviceCode));
}

export function getPackByCodeAndVersion(
  reference: IndustryPackMetadataReference,
): ServiceIndustryPack | undefined {
  const matching = getServiceIndustryPack(reference.code);
  return matching?.version === reference.version ? matching : undefined;
}

export function getPackByTemplateVersion(version: string): ServiceIndustryPack | undefined {
  return serviceIndustryPacks.find((pack) => pack.version === version);
}

export function getPackByServiceMembership(
  enabledServiceCodes: readonly string[],
): ServiceIndustryPack | undefined {
  const candidate = serviceIndustryPacks.filter((pack) =>
    packContainsAllServices(pack, enabledServiceCodes),
  );
  if (candidate.length === 1) return candidate[0];
  return undefined;
}

function getTemplateMetadata(
  pack: ServiceIndustryPack,
  serviceCode: string,
): TemplateMetadata | undefined {
  const template = pack.serviceTemplates.find((entry) => entry.catalogItem.code === serviceCode);
  if (!template) return undefined;
  return {
    serviceCode,
    requiredSkills: [...template.catalogItem.requiredSkills],
    requiredEquipmentTypes: [...template.catalogItem.requiredEquipmentTypes],
  };
}

export function resolveIndustryPack(input: ResolvePackInput): ServiceIndustryPack | undefined {
  if (input.activePack?.code && input.activePack.version) {
    const active = getPackByCodeAndVersion(input.activePack);
    if (!active || !packContainsAllServices(active, input.enabledServiceCodes)) {
      return undefined;
    }
    // Both fields are persisted evidence when they are present. Never let an
    // active-pack reference silently override a conflicting price-book
    // template version and then resolve pricing under the wrong pack.
    if (input.priceBookTemplateVersion && input.priceBookTemplateVersion !== active.version) {
      return undefined;
    }
    return active;
  }
  if (input.priceBookTemplateVersion) {
    const versioned = getPackByTemplateVersion(input.priceBookTemplateVersion);
    return versioned && packContainsAllServices(versioned, input.enabledServiceCodes)
      ? versioned
      : undefined;
  }
  if (input.enabledServiceCodes.length > 0) {
    return getPackByServiceMembership(input.enabledServiceCodes);
  }
  return undefined;
}

export function getIndustryPackServiceRequirements(
  enabledServiceCodes: readonly string[],
  activePack?: IndustryPackMetadataReference,
  priceBookTemplateVersion?: string,
): IndustryServiceRequirements {
  const resolvedPack = resolveIndustryPack({
    enabledServiceCodes,
    activePack,
    priceBookTemplateVersion,
  });
  const requirementByService =
    resolvedPack?.serviceTemplates
      .filter((template) => enabledServiceCodes.includes(template.catalogItem.code))
      .map((template) => getTemplateMetadata(resolvedPack, template.catalogItem.code)) ?? [];

  const requiredSkills = canonicalizeServiceCodeList(
    requirementByService.flatMap((entry) => entry?.requiredSkills ?? []),
  );
  const requiredEquipmentTypes = canonicalizeServiceCodeList(
    requirementByService.flatMap((entry) => entry?.requiredEquipmentTypes ?? []),
  );

  return { requiredSkills, requiredEquipmentTypes };
}

export function getIndustryPackPricingSemantics(
  enabledServiceCode: string,
  activePack?: IndustryPackMetadataReference,
  priceBookTemplateVersion?: string,
): IndustryPackPricingSemantics | undefined {
  const resolvedPack = resolveIndustryPack({
    enabledServiceCodes: [enabledServiceCode],
    activePack,
    priceBookTemplateVersion,
  });
  if (!resolvedPack) return undefined;
  const template = resolvedPack.serviceTemplates.find(
    (entry) => entry.catalogItem.code === enabledServiceCode,
  );
  if (!template) return undefined;
  return {
    pricingUnit: template.priceRule.pricingUnit,
    requiredMeasurementKinds: [...template.catalogItem.requiredMeasurementKinds],
  };
}

export function assertAllEnabledServicesArePackBound(
  enabledServiceCodes: readonly string[],
  activePack?: IndustryPackMetadataReference,
  priceBookTemplateVersion?: string,
): boolean {
  const resolvedPack = resolveIndustryPack({
    enabledServiceCodes,
    activePack,
    priceBookTemplateVersion,
  });
  if (!resolvedPack) return false;
  return packContainsAllServices(resolvedPack, enabledServiceCodes);
}

export function getIndustryPackServiceTemplateCodeList(pack: ServiceIndustryPack): string[] {
  return [...pack.serviceCodes].sort();
}
