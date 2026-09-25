import { asDecimalString, asPercentageString, money } from '../domain/primitives.ts';
import {
  type IndustryScopeDefinition,
  type IndustryServiceTemplate,
  type ServiceIndustryPack,
} from '../domain/industryPack.ts';
import type {
  PriceBook,
  PricingUnit,
  ServiceCatalogItem,
  ServicePackageDefinition,
  ServicePriceRule,
} from '../domain/catalog.ts';
import type { EntityMetadata } from '../domain/primitives.ts';
export { getExteriorConfigurationRequirements } from '../domain/exteriorServiceRequirements.ts';

export const EXTERIOR_SERVICE_CODES = [
  'pressure-wash-flatwork',
  'soft-wash-house',
  'gutter-cleaning',
  'roof-washing',
  'window-cleaning',
] as const;

export type ExteriorServiceCode = (typeof EXTERIOR_SERVICE_CODES)[number];
export type SandboxServiceCode = ExteriorServiceCode;

export const EXTERIOR_ADD_ON_CODES = [
  'OIL_SPOT_TREAT',
  'DOWNSPOUT_FLUSH',
  'SIDEWALK_WASH',
  'PATIO_WASH',
  'FENCE_WASH',
  'RETAINING_WALL_WASH',
  'OXIDATION_TREATMENT',
  'RECURRING_MAINTENANCE',
] as const;

export type ExteriorAddOnCode = (typeof EXTERIOR_ADD_ON_CODES)[number];

export const EXTERIOR_PACKAGE_IDENTITIES = [
  {
    code: 'ESSENTIAL_CARE',
    name: 'Essential care',
    tier: 'good',
  },
  {
    code: 'CURB_APPEAL_PLUS',
    name: 'Curb appeal plus',
    tier: 'better',
  },
  {
    code: 'WHOLE_PROPERTY_CARE',
    name: 'Whole-property care',
    tier: 'best',
  },
] as const;

export type ExteriorPackageCode = (typeof EXTERIOR_PACKAGE_IDENTITIES)[number]['code'];

export const EXTERIOR_PACKAGE_CODES: readonly ExteriorPackageCode[] =
  EXTERIOR_PACKAGE_IDENTITIES.map((identity) => identity.code);

export const EXTERIOR_STARTER_PACK_VERSION = 'storyops-exterior-dfw-v1.1.0';

type CatalogTemplate = Omit<ServiceCatalogItem, keyof EntityMetadata>;

export interface ExteriorScopeDefinition extends IndustryScopeDefinition {
  pricingUnit: PricingUnit;
}

export interface ExteriorServiceTemplate extends IndustryServiceTemplate<ExteriorServiceCode> {
  templateVersion: typeof EXTERIOR_STARTER_PACK_VERSION;
  catalogItem: CatalogTemplate & { code: ExteriorServiceCode };
  scope: ExteriorScopeDefinition;
  priceRule: ServicePriceRule & { serviceCode: ExteriorServiceCode };
}

const d = asDecimalString;

export const exteriorServiceTemplates = [
  {
    templateVersion: EXTERIOR_STARTER_PACK_VERSION,
    catalogItem: {
      code: 'pressure-wash-flatwork',
      name: 'Driveway and flatwork pressure wash',
      description:
        'Pressure washing for measured concrete, paver, or exposed-aggregate driveways and flatwork.',
      category: 'pressure_washing',
      active: true,
      taxable: true,
      requiredSkills: ['surface-identification', 'pressure-washing'],
      requiredEquipmentTypes: ['pressure-washer', 'surface-cleaner'],
      requiredMeasurementKinds: ['area_sq_ft'],
      safetySopReference: 'SOP-PW-FLATWORK-001',
    },
    scope: {
      primaryMeasurementKind: 'area_sq_ft',
      pricingUnit: 'sq_ft',
      scopeEvidencePolicy: 'photo_required',
      requiredPhotoViews: ['full flatwork boundary', 'surface close-up', 'access and drainage'],
      humanReviewTriggers: [
        'measurement is missing or photo-derived without scale',
        'surface is damaged, painted, sealed, or not represented in the price book',
        'access or runoff risk is uncertain',
      ],
    },
    priceRule: {
      serviceCode: 'pressure-wash-flatwork',
      requestAliases: ['DRIVEWAY_WASH'],
      pricingUnit: 'sq_ft',
      basePrice: money('110.00'),
      unitPrice: d('0.14'),
      includedQuantity: d('500'),
      serviceMinimum: money('185.00'),
      estimatedBaseCost: money('45.00'),
      estimatedUnitCost: d('0.05'),
      durationBaseMinutes: 45,
      durationMinutesPerUnit: d('0.055'),
      taxable: true,
      allowedAttributeValues: {
        surface: ['concrete', 'pavers', 'aggregate'],
        soil: ['light', 'moderate', 'heavy'],
        access: ['clear', 'limited'],
        risk: ['standard', 'elevated'],
      },
      attributeMultipliers: [
        { attribute: 'surface', value: 'concrete', multiplier: d('1') },
        { attribute: 'surface', value: 'pavers', multiplier: d('1.2') },
        { attribute: 'surface', value: 'aggregate', multiplier: d('1.15') },
        { attribute: 'soil', value: 'light', multiplier: d('0.92') },
        { attribute: 'soil', value: 'moderate', multiplier: d('1') },
        { attribute: 'soil', value: 'heavy', multiplier: d('1.28') },
        { attribute: 'access', value: 'clear', multiplier: d('1') },
        { attribute: 'access', value: 'limited', multiplier: d('1.18') },
        { attribute: 'risk', value: 'standard', multiplier: d('1') },
        {
          attribute: 'risk',
          value: 'elevated',
          multiplier: d('1.25'),
          approval: {
            reason: 'outside_sop',
            summary: 'Elevated flatwork risk requires owner scope and SOP review.',
          },
        },
      ],
      addOns: [
        {
          code: 'OIL_SPOT_TREAT',
          name: 'Oil spot pretreatment',
          unit: 'each',
          unitPrice: d('22.00'),
          taxable: true,
          estimatedUnitCost: d('5.50'),
          durationMinutesPerUnit: d('8'),
        },
        {
          code: 'SIDEWALK_WASH',
          name: 'Sidewalk pressure wash',
          unit: 'sq_ft',
          unitPrice: d('0.16'),
          taxable: true,
          estimatedUnitCost: d('0.05'),
          durationMinutesPerUnit: d('0.045'),
        },
        {
          code: 'PATIO_WASH',
          name: 'Patio pressure wash',
          unit: 'sq_ft',
          unitPrice: d('0.18'),
          taxable: true,
          estimatedUnitCost: d('0.06'),
          durationMinutesPerUnit: d('0.05'),
        },
        {
          code: 'FENCE_WASH',
          name: 'Fence wash',
          unit: 'linear_ft',
          unitPrice: d('1.25'),
          taxable: true,
          estimatedUnitCost: d('0.42'),
          durationMinutesPerUnit: d('0.5'),
        },
        {
          code: 'RETAINING_WALL_WASH',
          name: 'Retaining wall wash',
          unit: 'sq_ft',
          unitPrice: d('0.45'),
          taxable: true,
          estimatedUnitCost: d('0.15'),
          durationMinutesPerUnit: d('0.12'),
        },
      ],
    },
  },
  {
    templateVersion: EXTERIOR_STARTER_PACK_VERSION,
    catalogItem: {
      code: 'soft-wash-house',
      name: 'House exterior soft wash',
      description:
        'Low-pressure exterior cleaning priced from verified exterior square footage and explicit siding conditions.',
      category: 'soft_washing',
      active: true,
      taxable: true,
      requiredSkills: ['soft-washing', 'siding-identification', 'chemical-handling'],
      requiredEquipmentTypes: ['soft-wash-system', 'chemical-metering', 'plant-protection'],
      requiredMeasurementKinds: ['area_sq_ft'],
      safetySopReference: 'SOP-SW-HOUSE-001',
    },
    scope: {
      primaryMeasurementKind: 'area_sq_ft',
      pricingUnit: 'sq_ft',
      scopeEvidencePolicy: 'photo_required',
      requiredPhotoViews: [
        'each exterior elevation',
        'siding close-up',
        'organic growth',
        'delicate features and access',
      ],
      humanReviewTriggers: [
        'exterior wall area is unverified',
        'siding material or coating is unknown',
        'oxidation, failing paint, electrical exposure, or delicate landscaping is present',
      ],
    },
    priceRule: {
      serviceCode: 'soft-wash-house',
      requestAliases: ['HOUSE_SOFT_WASH'],
      pricingUnit: 'sq_ft',
      basePrice: money('195.00'),
      unitPrice: d('0.13'),
      includedQuantity: d('1200'),
      serviceMinimum: money('249.00'),
      estimatedBaseCost: money('70.00'),
      estimatedUnitCost: d('0.035'),
      durationBaseMinutes: 90,
      durationMinutesPerUnit: d('0.035'),
      taxable: true,
      allowedAttributeValues: {
        stories: ['1', '2', '3'],
        siding_material: ['vinyl', 'brick', 'fiber_cement', 'stucco', 'painted_wood'],
        organic_growth: ['light', 'moderate', 'heavy'],
        access: ['clear', 'limited'],
        risk: ['standard', 'elevated'],
      },
      attributeMultipliers: [
        { attribute: 'stories', value: '1', multiplier: d('1') },
        { attribute: 'stories', value: '2', multiplier: d('1.2') },
        {
          attribute: 'stories',
          value: '3',
          multiplier: d('1.45'),
          approval: {
            reason: 'outside_sop',
            summary: 'Three-story house washing requires owner access and SOP review.',
          },
        },
        { attribute: 'siding_material', value: 'vinyl', multiplier: d('1') },
        { attribute: 'siding_material', value: 'brick', multiplier: d('1.05') },
        { attribute: 'siding_material', value: 'fiber_cement', multiplier: d('1.1') },
        { attribute: 'siding_material', value: 'stucco', multiplier: d('1.18') },
        { attribute: 'siding_material', value: 'painted_wood', multiplier: d('1.25') },
        { attribute: 'organic_growth', value: 'light', multiplier: d('0.95') },
        { attribute: 'organic_growth', value: 'moderate', multiplier: d('1') },
        { attribute: 'organic_growth', value: 'heavy', multiplier: d('1.28') },
        { attribute: 'access', value: 'clear', multiplier: d('1') },
        { attribute: 'access', value: 'limited', multiplier: d('1.18') },
        { attribute: 'risk', value: 'standard', multiplier: d('1') },
        {
          attribute: 'risk',
          value: 'elevated',
          multiplier: d('1.3'),
          approval: {
            reason: 'outside_sop',
            summary: 'Elevated house-wash risk requires owner scope and SOP review.',
          },
        },
      ],
      addOns: [
        {
          code: 'OXIDATION_TREATMENT',
          name: 'Oxidation treatment',
          unit: 'sq_ft',
          unitPrice: d('0.38'),
          taxable: true,
          estimatedUnitCost: d('0.14'),
          durationMinutesPerUnit: d('0.04'),
          approval: {
            reason: 'outside_sop',
            summary: 'Oxidation treatment requires owner material compatibility review.',
          },
        },
        {
          code: 'RECURRING_MAINTENANCE',
          name: 'Recurring maintenance enrollment',
          unit: 'flat',
          unitPrice: d('0.00'),
          taxable: false,
          estimatedUnitCost: d('0.00'),
          durationMinutesPerUnit: d('0'),
        },
      ],
    },
  },
  {
    templateVersion: EXTERIOR_STARTER_PACK_VERSION,
    catalogItem: {
      code: 'gutter-cleaning',
      name: 'Gutter and downspout cleaning',
      description:
        'Gutter cleaning priced from verified gutter linear footage, stories, debris, guards, and roof access.',
      category: 'gutter_cleaning',
      active: true,
      taxable: true,
      requiredSkills: ['ladder-safety', 'gutter-cleaning'],
      requiredEquipmentTypes: ['ladder', 'fall-protection', 'gutter-tools'],
      requiredMeasurementKinds: ['length_linear_ft', 'count'],
      safetySopReference: 'SOP-GUTTER-001',
    },
    scope: {
      primaryMeasurementKind: 'length_linear_ft',
      pricingUnit: 'linear_ft',
      scopeEvidencePolicy: 'photo_required',
      requiredPhotoViews: [
        'all rooflines',
        'representative debris',
        'gutter guards',
        'ladder and roof access',
        'downspout outlets',
      ],
      humanReviewTriggers: [
        'linear footage or downspout count is unverified',
        'roof access, pitch, guard type, or debris condition is unknown',
        'three-story or elevated fall risk is present',
      ],
    },
    priceRule: {
      serviceCode: 'gutter-cleaning',
      requestAliases: ['GUTTER_CLEAN'],
      pricingUnit: 'linear_ft',
      basePrice: money('155.00'),
      unitPrice: d('0.85'),
      includedQuantity: d('100'),
      serviceMinimum: money('180.00'),
      estimatedBaseCost: money('60.00'),
      estimatedUnitCost: d('0.24'),
      durationBaseMinutes: 70,
      durationMinutesPerUnit: d('0.32'),
      taxable: true,
      allowedAttributeValues: {
        stories: ['1', '2', '3'],
        gutter_guards: ['none', 'snap_in', 'locked'],
        roof_access: ['clear', 'limited'],
        debris: ['light', 'moderate', 'heavy'],
        risk: ['standard', 'elevated'],
      },
      attributeMultipliers: [
        { attribute: 'stories', value: '1', multiplier: d('1') },
        { attribute: 'stories', value: '2', multiplier: d('1.22') },
        {
          attribute: 'stories',
          value: '3',
          multiplier: d('1.55'),
          approval: {
            reason: 'outside_sop',
            summary: 'Three-story gutter work requires owner access and fall-protection review.',
          },
        },
        { attribute: 'gutter_guards', value: 'none', multiplier: d('1') },
        { attribute: 'gutter_guards', value: 'snap_in', multiplier: d('1.2') },
        { attribute: 'gutter_guards', value: 'locked', multiplier: d('1.45') },
        { attribute: 'roof_access', value: 'clear', multiplier: d('1') },
        { attribute: 'roof_access', value: 'limited', multiplier: d('1.2') },
        { attribute: 'debris', value: 'light', multiplier: d('0.95') },
        { attribute: 'debris', value: 'moderate', multiplier: d('1') },
        { attribute: 'debris', value: 'heavy', multiplier: d('1.25') },
        { attribute: 'risk', value: 'standard', multiplier: d('1') },
        {
          attribute: 'risk',
          value: 'elevated',
          multiplier: d('1.3'),
          approval: {
            reason: 'outside_sop',
            summary: 'Elevated gutter-work risk requires owner scope and SOP review.',
          },
        },
      ],
      addOns: [
        {
          code: 'DOWNSPOUT_FLUSH',
          name: 'Downspout flow test and flush',
          unit: 'each',
          unitPrice: d('18.00'),
          taxable: true,
          estimatedUnitCost: d('4.00'),
          durationMinutesPerUnit: d('7'),
        },
      ],
    },
  },
  {
    templateVersion: EXTERIOR_STARTER_PACK_VERSION,
    catalogItem: {
      code: 'roof-washing',
      name: 'Roof soft wash',
      description:
        'Roof soft washing priced from verified roof area with explicit material, pitch, access, growth, story, and risk inputs.',
      category: 'roof_washing',
      active: true,
      taxable: true,
      requiredSkills: ['roof-soft-washing', 'fall-protection', 'chemical-handling'],
      requiredEquipmentTypes: ['soft-wash-system', 'fall-protection', 'plant-protection'],
      requiredMeasurementKinds: ['area_sq_ft'],
      safetySopReference: 'SOP-SW-ROOF-001',
    },
    scope: {
      primaryMeasurementKind: 'area_sq_ft',
      pricingUnit: 'sq_ft',
      scopeEvidencePolicy: 'photo_required',
      requiredPhotoViews: [
        'all roof planes',
        'roof material',
        'pitch and access',
        'organic growth',
        'gutters and runoff protection',
      ],
      humanReviewTriggers: [
        'roof area, material, or pitch is unverified',
        'tile, damaged roofing, solar panels, or specialty coatings are present',
        'steep pitch, limited access, or elevated fall risk is present',
      ],
    },
    priceRule: {
      serviceCode: 'roof-washing',
      requestAliases: ['ROOF_SOFT_WASH'],
      pricingUnit: 'sq_ft',
      basePrice: money('275.00'),
      unitPrice: d('0.22'),
      includedQuantity: d('1000'),
      serviceMinimum: money('425.00'),
      estimatedBaseCost: money('140.00'),
      estimatedUnitCost: d('0.08'),
      durationBaseMinutes: 150,
      durationMinutesPerUnit: d('0.06'),
      taxable: true,
      allowedAttributeValues: {
        stories: ['1', '2', '3'],
        roof_pitch: ['walkable', 'moderate', 'steep'],
        roof_material: ['asphalt', 'metal', 'tile'],
        roof_access: ['clear', 'limited'],
        organic_growth: ['light', 'moderate', 'heavy'],
        risk: ['standard', 'elevated'],
      },
      attributeMultipliers: [
        { attribute: 'stories', value: '1', multiplier: d('1') },
        { attribute: 'stories', value: '2', multiplier: d('1.15') },
        {
          attribute: 'stories',
          value: '3',
          multiplier: d('1.4'),
          approval: {
            reason: 'outside_sop',
            summary: 'Three-story roof work requires owner access and fall-protection review.',
          },
        },
        { attribute: 'roof_pitch', value: 'walkable', multiplier: d('1') },
        { attribute: 'roof_pitch', value: 'moderate', multiplier: d('1.2') },
        {
          attribute: 'roof_pitch',
          value: 'steep',
          multiplier: d('1.55'),
          approval: {
            reason: 'outside_sop',
            summary: 'Steep-pitch roof work requires owner access and fall-protection review.',
          },
        },
        { attribute: 'roof_material', value: 'asphalt', multiplier: d('1') },
        { attribute: 'roof_material', value: 'metal', multiplier: d('1.15') },
        {
          attribute: 'roof_material',
          value: 'tile',
          multiplier: d('1.4'),
          approval: {
            reason: 'outside_sop',
            summary: 'Tile roof work requires owner material compatibility and access review.',
          },
        },
        { attribute: 'roof_access', value: 'clear', multiplier: d('1') },
        { attribute: 'roof_access', value: 'limited', multiplier: d('1.25') },
        { attribute: 'organic_growth', value: 'light', multiplier: d('0.95') },
        { attribute: 'organic_growth', value: 'moderate', multiplier: d('1') },
        { attribute: 'organic_growth', value: 'heavy', multiplier: d('1.3') },
        { attribute: 'risk', value: 'standard', multiplier: d('1') },
        {
          attribute: 'risk',
          value: 'elevated',
          multiplier: d('1.45'),
          approval: {
            reason: 'outside_sop',
            summary: 'Elevated roof-work risk requires owner scope and SOP review.',
          },
        },
      ],
      addOns: [],
    },
  },
  {
    templateVersion: EXTERIOR_STARTER_PACK_VERSION,
    catalogItem: {
      code: 'window-cleaning',
      name: 'Window cleaning',
      description:
        'Window cleaning priced from a verified pane count with explicit side, story, screen, track, access, and risk inputs.',
      category: 'window_cleaning',
      active: true,
      taxable: true,
      requiredSkills: ['window-cleaning', 'ladder-safety'],
      requiredEquipmentTypes: ['window-cleaning-kit', 'ladder'],
      requiredMeasurementKinds: ['count'],
      safetySopReference: 'SOP-WINDOW-001',
    },
    scope: {
      primaryMeasurementKind: 'count',
      pricingUnit: 'each',
      scopeEvidencePolicy: 'photo_required',
      requiredPhotoViews: [
        'each elevation',
        'representative window configuration',
        'screens and tracks',
        'ladder access',
      ],
      humanReviewTriggers: [
        'pane count or service side is unverified',
        'specialty glass, storms, construction debris, or damaged seals are present',
        'three-story or elevated access risk is present',
      ],
    },
    priceRule: {
      serviceCode: 'window-cleaning',
      requestAliases: ['WINDOW_CLEAN'],
      pricingUnit: 'each',
      basePrice: money('85.00'),
      unitPrice: d('9.00'),
      includedQuantity: d('10'),
      serviceMinimum: money('149.00'),
      estimatedBaseCost: money('35.00'),
      estimatedUnitCost: d('3.25'),
      durationBaseMinutes: 45,
      durationMinutesPerUnit: d('6'),
      taxable: true,
      allowedAttributeValues: {
        stories: ['1', '2', '3'],
        service_side: ['exterior', 'interior_exterior'],
        screens: ['excluded', 'included'],
        tracks: ['excluded', 'included'],
        access: ['clear', 'limited'],
        risk: ['standard', 'elevated'],
      },
      attributeMultipliers: [
        { attribute: 'stories', value: '1', multiplier: d('1') },
        { attribute: 'stories', value: '2', multiplier: d('1.18') },
        {
          attribute: 'stories',
          value: '3',
          multiplier: d('1.45'),
          approval: {
            reason: 'outside_sop',
            summary: 'Three-story window work requires owner access and fall-protection review.',
          },
        },
        { attribute: 'service_side', value: 'exterior', multiplier: d('1') },
        { attribute: 'service_side', value: 'interior_exterior', multiplier: d('1.85') },
        { attribute: 'screens', value: 'excluded', multiplier: d('1') },
        { attribute: 'screens', value: 'included', multiplier: d('1.12') },
        { attribute: 'tracks', value: 'excluded', multiplier: d('1') },
        { attribute: 'tracks', value: 'included', multiplier: d('1.15') },
        { attribute: 'access', value: 'clear', multiplier: d('1') },
        { attribute: 'access', value: 'limited', multiplier: d('1.2') },
        { attribute: 'risk', value: 'standard', multiplier: d('1') },
        {
          attribute: 'risk',
          value: 'elevated',
          multiplier: d('1.35'),
          approval: {
            reason: 'outside_sop',
            summary: 'Elevated window-work risk requires owner scope and SOP review.',
          },
        },
      ],
      addOns: [],
    },
  },
] satisfies readonly ExteriorServiceTemplate[];

export const exteriorServicesIndustryPack = {
  code: 'exterior-services',
  name: 'Exterior services',
  version: EXTERIOR_STARTER_PACK_VERSION,
  description:
    'Pressure washing, soft washing, gutter/downspout cleaning, roof washing, and window cleaning on the shared WashOps field-service kernel.',
  serviceCodes: EXTERIOR_SERVICE_CODES,
  serviceTemplates: exteriorServiceTemplates,
  supportedKernelCapabilities: [
    'crm',
    'properties',
    'measured_pricing',
    'dispatch',
    'offline_field',
    'billing',
    'customer_portal',
    'ai_office',
  ],
} satisfies ServiceIndustryPack<ExteriorServiceCode>;

const exteriorPackageServiceOrder = [
  'pressure-wash-flatwork',
  'gutter-cleaning',
  'soft-wash-house',
  'window-cleaning',
  'roof-washing',
] as const satisfies readonly ExteriorServiceCode[];

function packageTemplate(serviceCode: ExteriorServiceCode): ExteriorServiceTemplate {
  const template = exteriorServiceTemplates.find(
    (candidate) => candidate.catalogItem.code === serviceCode,
  );
  if (!template) {
    throw new Error(`Exterior service template "${serviceCode}" is not registered.`);
  }
  return template;
}

function packageDescription(
  identity: (typeof EXTERIOR_PACKAGE_IDENTITIES)[number],
  serviceCodes: readonly ExteriorServiceCode[],
  includesRequiredDownspoutFlush: boolean,
): string {
  const scope = serviceCodes
    .map((serviceCode) => packageTemplate(serviceCode).catalogItem.name)
    .join(', ');
  const addOnPolicy = includesRequiredDownspoutFlush
    ? 'Downspout flushing is included only from an explicit measured count; every other listed add-on remains optional.'
    : 'Every listed add-on remains optional and needs its own explicit measured quantity.';
  return `${identity.tier[0]!.toUpperCase()}${identity.tier.slice(1)}: includes measured ${scope}. ${addOnPolicy}`;
}

export function createExteriorConfigurationPackages(
  enabledServiceCodes: readonly ExteriorServiceCode[],
): ServicePackageDefinition[] {
  const selected = exteriorPackageServiceOrder.filter((code) => enabledServiceCodes.includes(code));
  if (selected.length < 2 || (selected.length === 2 && !selected.includes('gutter-cleaning'))) {
    throw new Error(
      'Distinct Good, Better, and Best require at least three exterior services, or two services including gutter cleaning so Best can require an explicitly measured downspout flush.',
    );
  }

  const serviceCountByTier = {
    good: 1,
    better: Math.min(selected.length, Math.max(2, Math.ceil((selected.length * 2) / 3))),
    best: selected.length,
  } as const;

  return EXTERIOR_PACKAGE_IDENTITIES.map((identity) => {
    const packageServiceCodes = selected.slice(0, serviceCountByTier[identity.tier]);
    const includesRequiredDownspoutFlush =
      identity.tier === 'best' && packageServiceCodes.includes('gutter-cleaning');
    const components = packageServiceCodes.map((serviceCode) => {
      const template = packageTemplate(serviceCode);
      const requiredAddOnCodes =
        includesRequiredDownspoutFlush && serviceCode === 'gutter-cleaning'
          ? ['DOWNSPOUT_FLUSH']
          : [];
      const addOnCodes = template.priceRule.addOns.map((addOn) => addOn.code);
      return {
        serviceCode,
        required: true,
        requiredAddOnCodes,
        optionalAddOnCodes: addOnCodes.filter((code) => !requiredAddOnCodes.includes(code)),
      };
    });
    return {
      code: identity.code,
      name: identity.name,
      description: packageDescription(
        identity,
        packageServiceCodes,
        includesRequiredDownspoutFlush,
      ),
      tier: identity.tier,
      components,
    };
  });
}

export const exteriorServicePackages = createExteriorConfigurationPackages(EXTERIOR_SERVICE_CODES);

export function createExteriorConfigurationPricing(
  enabledServiceCodes: readonly ExteriorServiceCode[] = EXTERIOR_SERVICE_CODES,
) {
  return {
    serviceRules: exteriorServiceTemplates.map((template) => ({
      serviceCode: template.priceRule.serviceCode,
      pricingUnit: template.priceRule.pricingUnit,
      requiredMeasurementKinds: [...template.catalogItem.requiredMeasurementKinds],
      basePrice: template.priceRule.basePrice.amount,
      unitPrice: template.priceRule.unitPrice,
      includedQuantity: template.priceRule.includedQuantity,
      serviceMinimum: template.priceRule.serviceMinimum?.amount ?? '0.00',
      estimatedBaseCost: template.priceRule.estimatedBaseCost.amount,
      estimatedUnitCost: template.priceRule.estimatedUnitCost,
      durationBaseMinutes: template.priceRule.durationBaseMinutes,
      durationMinutesPerUnit: template.priceRule.durationMinutesPerUnit,
      taxable: template.priceRule.taxable,
      allowedAttributeValues: Object.fromEntries(
        Object.entries(template.priceRule.allowedAttributeValues).map(([attribute, values]) => [
          attribute,
          [...(values ?? [])],
        ]),
      ),
      attributeMultipliers: template.priceRule.attributeMultipliers.map((multiplier) => ({
        attribute: multiplier.attribute,
        value: multiplier.value,
        multiplier: multiplier.multiplier,
        ...(multiplier.approval ? { approval: { ...multiplier.approval } } : {}),
      })),
      addOns: template.priceRule.addOns.map((addOn) => ({
        code: addOn.code,
        name: addOn.name,
        pricingUnit: addOn.unit,
        unitPrice: addOn.unitPrice,
        taxable: addOn.taxable,
        estimatedUnitCost: addOn.estimatedUnitCost ?? d('0'),
        durationMinutesPerUnit: addOn.durationMinutesPerUnit,
        ...('approval' in addOn && addOn.approval ? { approval: { ...addOn.approval } } : {}),
      })),
    })),
    packages: createExteriorConfigurationPackages(enabledServiceCodes).map((servicePackage) => ({
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
    })),
  };
}

export const getExteriorServiceTemplate = (
  serviceCode: ExteriorServiceCode,
): ExteriorServiceTemplate => {
  const template = exteriorServiceTemplates.find(
    (candidate) => candidate.catalogItem.code === serviceCode,
  );
  if (!template) {
    throw new Error(`Exterior service template "${serviceCode}" is not registered.`);
  }
  return template;
};

export const getExteriorServicePackage = (
  packageCode: ExteriorPackageCode,
  enabledServiceCodes: readonly ExteriorServiceCode[] = EXTERIOR_SERVICE_CODES,
): ServicePackageDefinition => {
  const definition = createExteriorConfigurationPackages(enabledServiceCodes).find(
    (candidate) => candidate.code === packageCode,
  );
  if (!definition) {
    throw new Error(`Exterior service package "${packageCode}" is not registered.`);
  }
  return definition;
};

export const EXTERIOR_STARTER_PRICE_BOOK_POLICY = {
  name: 'DFW Residential',
  versionLabel: '2026.07-v3',
  currency: 'USD',
  companyMinimum: money('225.00'),
  travelZones: [
    {
      zoneCode: 'DFW-A',
      name: 'Core service zone',
      fee: money('0.00'),
      taxable: false,
      maximumOneWayMiles: d('20'),
    },
    {
      zoneCode: 'DFW-B',
      name: 'Extended service zone',
      fee: money('35.00'),
      taxable: false,
      maximumOneWayMiles: d('35'),
    },
    {
      zoneCode: 'DFW-C',
      name: 'Outer service zone',
      fee: money('75.00'),
      taxable: false,
      maximumOneWayMiles: d('50'),
    },
  ],
  defaultTaxRate: asPercentageString('8.25'),
  marginFloor: asPercentageString('42'),
  automaticDiscountLimit: asPercentageString('10'),
  depositRule: {
    kind: 'percent',
    value: asPercentageString('25'),
  },
} as const satisfies Pick<
  PriceBook,
  | 'name'
  | 'versionLabel'
  | 'currency'
  | 'companyMinimum'
  | 'travelZones'
  | 'defaultTaxRate'
  | 'marginFloor'
  | 'automaticDiscountLimit'
  | 'depositRule'
>;

type ExteriorPriceBookPublication = Pick<
  PriceBook,
  | keyof EntityMetadata
  | 'status'
  | 'effectiveFrom'
  | 'effectiveUntil'
  | 'publishedBy'
  | 'publishedAt'
>;

const clonePriceRule = (rule: ServicePriceRule): ServicePriceRule => ({
  ...rule,
  requestAliases: rule.requestAliases ? [...rule.requestAliases] : undefined,
  basePrice: { ...rule.basePrice },
  serviceMinimum: rule.serviceMinimum ? { ...rule.serviceMinimum } : undefined,
  estimatedBaseCost: { ...rule.estimatedBaseCost },
  allowedAttributeValues: Object.fromEntries(
    Object.entries(rule.allowedAttributeValues).map(([attribute, values]) => [
      attribute,
      values ? [...values] : [],
    ]),
  ),
  attributeMultipliers: rule.attributeMultipliers.map((multiplier) => ({
    ...multiplier,
    approval: multiplier.approval ? { ...multiplier.approval } : undefined,
  })),
  addOns: rule.addOns.map((addOn) => ({
    ...addOn,
    approval: addOn.approval ? { ...addOn.approval } : undefined,
  })),
});

export const createExteriorStarterPriceBook = (
  publication: ExteriorPriceBookPublication,
): PriceBook => ({
  ...publication,
  name: EXTERIOR_STARTER_PRICE_BOOK_POLICY.name,
  versionLabel: EXTERIOR_STARTER_PRICE_BOOK_POLICY.versionLabel,
  currency: EXTERIOR_STARTER_PRICE_BOOK_POLICY.currency,
  companyMinimum: { ...EXTERIOR_STARTER_PRICE_BOOK_POLICY.companyMinimum },
  travelZones: EXTERIOR_STARTER_PRICE_BOOK_POLICY.travelZones.map((zone) => ({
    ...zone,
    fee: { ...zone.fee },
  })),
  defaultTaxRate: EXTERIOR_STARTER_PRICE_BOOK_POLICY.defaultTaxRate,
  marginFloor: EXTERIOR_STARTER_PRICE_BOOK_POLICY.marginFloor,
  automaticDiscountLimit: EXTERIOR_STARTER_PRICE_BOOK_POLICY.automaticDiscountLimit,
  depositRule: { ...EXTERIOR_STARTER_PRICE_BOOK_POLICY.depositRule },
  serviceRules: exteriorServiceTemplates.map((template) => clonePriceRule(template.priceRule)),
});
