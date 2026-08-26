import type { CompanyConfiguration } from '@/domain/companyConfiguration';
import type { IndustryServiceTemplate, ServiceIndustryPack } from '@/domain/industryPack';
import {
  getIndustryPackServiceTemplateCodeList,
  resolveIndustryPack,
  type ResolvePackInput,
} from '@/domain/industryPackRequirements';
import type { ServiceIndustryPackCode } from '@/data/industryPacks';
import {
  createExteriorConfigurationPackages,
  createExteriorConfigurationPricing,
  EXTERIOR_SERVICE_CODES,
  type ExteriorServiceCode,
  exteriorServicesIndustryPack,
} from '@/data/exteriorServiceTemplates';
import {
  createResidentialConfigurationPackages,
  createResidentialConfigurationPricing,
  type ResidentialServiceCode,
  RESIDENTIAL_SERVICE_CODES,
  residentialCleaningIndustryPack,
} from '@/data/residentialServiceTemplates';

type StudioPricingInput = {
  serviceRules: CompanyConfiguration['pricing']['serviceRules'];
  packages: CompanyConfiguration['pricing']['packages'];
};

export type IndustryPackRuntimeProfile = {
  packCode: ServiceIndustryPackCode;
  packName: string;
  packVersion: string;
  pack: ServiceIndustryPack;
  serviceTemplates: readonly IndustryServiceTemplate[];
  serviceCodes: readonly string[];
  defaultEnabledServiceCodes: readonly string[];
  starterEquipmentType: string;
  starterSkills: readonly string[];
  buildPricing: (enabledServiceCodes: readonly string[]) => StudioPricingInput;
  buildPackages: (
    enabledServiceCodes: readonly string[],
  ) => CompanyConfiguration['pricing']['packages'];
};

function assertRuntimeServiceSelection(
  runtime: Pick<IndustryPackRuntimeProfile, 'packCode' | 'serviceCodes'>,
  enabledServiceCodes: readonly string[],
): void {
  const supported = new Set(runtime.serviceCodes);
  const unsupported = enabledServiceCodes.filter((serviceCode) => !supported.has(serviceCode));
  if (unsupported.length > 0) {
    throw new Error(
      `Industry pack ${runtime.packCode} does not contain: ${unsupported.join(', ')}.`,
    );
  }
}

const runtimeByCode: Record<ServiceIndustryPackCode, IndustryPackRuntimeProfile> = {
  'exterior-services': {
    packCode: 'exterior-services',
    packName: exteriorServicesIndustryPack.name,
    packVersion: exteriorServicesIndustryPack.version,
    pack: exteriorServicesIndustryPack,
    serviceTemplates: exteriorServicesIndustryPack.serviceTemplates,
    serviceCodes: getIndustryPackServiceTemplateCodeList(exteriorServicesIndustryPack),
    defaultEnabledServiceCodes: ['pressure-wash-flatwork', 'gutter-cleaning'],
    starterEquipmentType: 'pressure-washer',
    starterSkills: ['scope-verification', 'exterior-cleaning'],
    buildPricing: (enabledServiceCodes) => {
      assertRuntimeServiceSelection(
        { packCode: 'exterior-services', serviceCodes: EXTERIOR_SERVICE_CODES },
        enabledServiceCodes,
      );
      return createExteriorConfigurationPricing(enabledServiceCodes as ExteriorServiceCode[]);
    },
    buildPackages: (enabledServiceCodes) => {
      assertRuntimeServiceSelection(
        { packCode: 'exterior-services', serviceCodes: EXTERIOR_SERVICE_CODES },
        enabledServiceCodes,
      );
      return createExteriorConfigurationPackages(enabledServiceCodes as ExteriorServiceCode[]).map(
        (servicePackage) => ({
          code: servicePackage.code,
          name: servicePackage.name,
          description: servicePackage.description,
          tier: servicePackage.tier,
          components: servicePackage.components.map((component) => ({
            serviceCode: component.serviceCode,
            required: component.required,
            requiredAddOnCodes: [...component.requiredAddOnCodes],
            optionalAddOnCodes: [...component.optionalAddOnCodes],
          })),
        }),
      );
    },
  },
  'residential-cleaning': {
    packCode: 'residential-cleaning',
    packName: residentialCleaningIndustryPack.name,
    packVersion: residentialCleaningIndustryPack.version,
    pack: residentialCleaningIndustryPack,
    serviceTemplates: residentialCleaningIndustryPack.serviceTemplates,
    serviceCodes: RESIDENTIAL_SERVICE_CODES,
    defaultEnabledServiceCodes: RESIDENTIAL_SERVICE_CODES,
    starterEquipmentType: 'vacuum',
    starterSkills: ['scope-verification'],
    buildPricing: (enabledServiceCodes) => {
      assertRuntimeServiceSelection(
        { packCode: 'residential-cleaning', serviceCodes: RESIDENTIAL_SERVICE_CODES },
        enabledServiceCodes,
      );
      return createResidentialConfigurationPricing(enabledServiceCodes as ResidentialServiceCode[]);
    },
    buildPackages: (enabledServiceCodes) => {
      assertRuntimeServiceSelection(
        { packCode: 'residential-cleaning', serviceCodes: RESIDENTIAL_SERVICE_CODES },
        enabledServiceCodes,
      );
      return createResidentialConfigurationPackages(
        enabledServiceCodes as ResidentialServiceCode[],
      ).map((servicePackage) => ({
        code: servicePackage.code,
        name: servicePackage.name,
        description: servicePackage.description,
        tier: servicePackage.tier,
        components: servicePackage.components.map((component) => ({
          serviceCode: component.serviceCode,
          required: component.required,
          requiredAddOnCodes: [...component.requiredAddOnCodes],
          optionalAddOnCodes: [...component.optionalAddOnCodes],
        })),
      }));
    },
  },
};

export function listIndustryPackCodes(): ServiceIndustryPackCode[] {
  return Object.keys(runtimeByCode) as ServiceIndustryPackCode[];
}

export function getIndustryPackRuntimeForInput(
  input: ResolvePackInput,
): IndustryPackRuntimeProfile | undefined {
  const pack = resolveIndustryPack(input);
  if (!pack) return undefined;
  return runtimeByCode[pack.code as ServiceIndustryPackCode];
}

export function getIndustryPackRuntimeForCode(
  code: string,
): IndustryPackRuntimeProfile | undefined {
  return runtimeByCode[code as ServiceIndustryPackCode];
}

export function getIndustryPackTemplateCodes(input: ResolvePackInput): string[] {
  const pack = resolveIndustryPack(input);
  return pack ? getIndustryPackServiceTemplateCodeList(pack) : [];
}

export function getCanonicalPricingConfiguration(
  runtime: IndustryPackRuntimeProfile,
  enabledServiceCodes: readonly string[] = runtime.serviceCodes,
): StudioPricingInput {
  return runtime.buildPricing(enabledServiceCodes);
}

export function getCanonicalPackagesFromInput(
  input: ResolvePackInput,
): CompanyConfiguration['pricing']['packages'] {
  const runtime = getIndustryPackRuntimeForInput(input);
  if (!runtime) return [];
  return runtime.buildPackages(input.enabledServiceCodes);
}
