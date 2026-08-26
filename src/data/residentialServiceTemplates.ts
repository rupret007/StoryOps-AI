import {
  asDecimalString,
  asPercentageString,
  money,
  type EntityMetadata,
} from '../domain/primitives.ts';
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

export const RESIDENTIAL_SERVICE_CODES = [
  'standard-recurring-clean',
  'deep-clean',
  'move-in-out-clean',
] as const;

export type ResidentialServiceCode = (typeof RESIDENTIAL_SERVICE_CODES)[number];
export const RESIDENTIAL_ADD_ON_CODES = [
  'OVEN_CLEANING',
  'REFRIGERATOR_CLEANING',
  'CABINET_DETAIL',
  'INTERIOR_WINDOWS',
  'BLINDS_AND_TRACKS',
  'BASEBOARD_CLEAN',
  'LAUNDRY_LINEN_REFRESH',
  'PET_HAIR_BONUS',
  'HIGH_DETAIL_SERVICE',
] as const;

export type ResidentialAddOnCode = (typeof RESIDENTIAL_ADD_ON_CODES)[number];

export const RESIDENTIAL_PACKAGE_IDENTITIES = [
  {
    code: 'ESSENTIAL_HOME_CARE',
    name: 'Essential care',
    tier: 'good',
  },
  {
    code: 'HOME_CLEAN_PLUS',
    name: 'Home clean plus',
    tier: 'better',
  },
  {
    code: 'PEAK_HOME_CARE',
    name: 'Peak home care',
    tier: 'best',
  },
] as const;

export const RESIDENTIAL_PACKAGE_CODES: readonly string[] = RESIDENTIAL_PACKAGE_IDENTITIES.map(
  (identity) => identity.code,
);

export const RESIDENTIAL_STARTER_PACK_VERSION = 'storyops-residential-cleaning-v1.0.0';

type CatalogTemplate = Omit<ServiceCatalogItem, keyof EntityMetadata>;

export interface ResidentialScopeDefinition extends IndustryScopeDefinition {
  pricingUnit: PricingUnit;
}

export interface ResidentialServiceTemplate extends IndustryServiceTemplate<ResidentialServiceCode> {
  templateVersion: typeof RESIDENTIAL_STARTER_PACK_VERSION;
  catalogItem: CatalogTemplate & { code: ResidentialServiceCode };
  scope: ResidentialScopeDefinition;
  priceRule: ServicePriceRule & { serviceCode: ResidentialServiceCode };
}

const d = asDecimalString;

const createAttributeMultipliers = (
  attribute:
    'bedrooms' | 'bathrooms' | 'frequency' | 'occupancy' | 'pets' | 'access' | 'first_service',
  entries: readonly (readonly [string, string])[],
) =>
  entries.map(([value, multiplier]) => ({
    attribute,
    value,
    multiplier: asDecimalString(multiplier),
  }));

const standardRecurringAddOns = {
  OVEN_CLEANING: {
    code: 'OVEN_CLEANING',
    name: 'Oven interior clean',
    unit: 'each',
    unitPrice: d('24.00'),
    taxable: true,
    estimatedUnitCost: d('8.00'),
    durationMinutesPerUnit: d('22'),
  },
  REFRIGERATOR_CLEANING: {
    code: 'REFRIGERATOR_CLEANING',
    name: 'Refrigerator interior clean',
    unit: 'each',
    unitPrice: d('32.00'),
    taxable: true,
    estimatedUnitCost: d('11.00'),
    durationMinutesPerUnit: d('24'),
  },
  CABINET_DETAIL: {
    code: 'CABINET_DETAIL',
    name: 'Cabinet and drawer pull detail',
    unit: 'each',
    unitPrice: d('0.45'),
    taxable: true,
    estimatedUnitCost: d('0.12'),
    durationMinutesPerUnit: d('0.35'),
  },
  BASEBOARD_CLEAN: {
    code: 'BASEBOARD_CLEAN',
    name: 'Baseboard and trim detailing',
    unit: 'sq_ft',
    unitPrice: d('0.05'),
    taxable: true,
    estimatedUnitCost: d('0.01'),
    durationMinutesPerUnit: d('0.10'),
  },
  HIGH_DETAIL_SERVICE: {
    code: 'HIGH_DETAIL_SERVICE',
    name: 'High-detail room-by-room cleaning',
    unit: 'flat',
    unitPrice: d('89.00'),
    taxable: true,
    estimatedUnitCost: d('18.00'),
    durationMinutesPerUnit: d('0'),
    approval: {
      reason: 'outside_sop',
      summary:
        'High-detail cleaning exceeds standard SOP scope and requires explicit owner review.',
    },
  },
  PET_HAIR_BONUS: {
    code: 'PET_HAIR_BONUS',
    name: 'Pet hair detail handling',
    unit: 'each',
    unitPrice: d('0.00'),
    taxable: false,
    estimatedUnitCost: d('0.00'),
    durationMinutesPerUnit: d('0'),
    approval: {
      reason: 'outside_sop',
      summary: 'Pet-hair-heavy scope requires explicit owner scope review before execution.',
    },
  },
} as const;

const moveOutAddOns = {
  INTERIOR_WINDOWS: {
    code: 'INTERIOR_WINDOWS',
    name: 'Interior window cleaning',
    unit: 'each',
    unitPrice: d('6.50'),
    taxable: true,
    estimatedUnitCost: d('2.10'),
    durationMinutesPerUnit: d('5'),
  },
  BLINDS_AND_TRACKS: {
    code: 'BLINDS_AND_TRACKS',
    name: 'Blinds, tracks, and rail cleaners',
    unit: 'each',
    unitPrice: d('4.25'),
    taxable: true,
    estimatedUnitCost: d('1.30'),
    durationMinutesPerUnit: d('4'),
  },
  LAUNDRY_LINEN_REFRESH: {
    code: 'LAUNDRY_LINEN_REFRESH',
    name: 'Laundry and linen refresh',
    unit: 'flat',
    unitPrice: d('69.00'),
    taxable: false,
    estimatedUnitCost: d('0.00'),
    durationMinutesPerUnit: d('30'),
  },
  PET_HAIR_BONUS: {
    code: 'PET_HAIR_BONUS',
    name: 'Pet hair bonus',
    unit: 'each',
    unitPrice: d('0.00'),
    taxable: false,
    estimatedUnitCost: d('0.00'),
    durationMinutesPerUnit: d('0'),
    approval: {
      reason: 'outside_sop',
      summary: 'Pet-hair-heavy scope requires owner scope review before execution.',
    },
  },
} as const;

export const residentialServiceTemplates: ResidentialServiceTemplate[] = [
  {
    templateVersion: RESIDENTIAL_STARTER_PACK_VERSION,
    catalogItem: {
      code: 'standard-recurring-clean',
      name: 'Standard recurring residential cleaning',
      description:
        'Flat to large recurring home-cleaning service with room and occupancy-aware pricing.',
      category: 'residential_cleaning',
      active: true,
      taxable: true,
      requiredSkills: ['home-cleaning', 'vacuuming', 'crew-coordination'],
      requiredEquipmentTypes: ['vacuum', 'microfiber-toolkit', 'safety-kit'],
      requiredMeasurementKinds: ['area_sq_ft', 'count'],
      safetySopReference: 'SOP-HC-RECURRING-001',
    },
    scope: {
      primaryMeasurementKind: 'area_sq_ft',
      pricingUnit: 'sq_ft',
      scopeEvidencePolicy: 'photo_optional',
      requiredPhotoViews: ['entrance and exit photos', 'kitchen and bath key views'],
      humanReviewTriggers: [
        'first-clean or maintenance flag missing',
        'bedroom or bathroom counts are unknown',
        'pet and access notes conflict with scope profile',
      ],
    },
    priceRule: {
      serviceCode: 'standard-recurring-clean',
      requestAliases: ['RESIDENCE_RECURRING'],
      pricingUnit: 'sq_ft',
      basePrice: money('165.00'),
      unitPrice: d('0.085'),
      includedQuantity: d('900'),
      serviceMinimum: money('180.00'),
      estimatedBaseCost: money('52.00'),
      estimatedUnitCost: d('0.030'),
      durationBaseMinutes: 110,
      durationMinutesPerUnit: d('0.030'),
      taxable: true,
      allowedAttributeValues: {
        bedrooms: ['1', '2', '3', '4', '5+'],
        bathrooms: ['1', '2', '3', '4', '5+'],
        frequency: ['weekly', 'biweekly', 'every_four_weeks', 'monthly'],
        occupancy: ['occupied', 'vacant'],
        pets: ['none', '1', '2', '3+'],
        access: ['clear', 'limited'],
        first_service: ['true', 'false'],
      },
      attributeMultipliers: [
        ...createAttributeMultipliers('bedrooms', [
          ['1', '1.00'],
          ['2', '1.15'],
          ['3', '1.28'],
          ['4', '1.46'],
          ['5+', '1.62'],
        ] as const),
        ...createAttributeMultipliers('bathrooms', [
          ['1', '1.00'],
          ['2', '1.10'],
          ['3', '1.22'],
          ['4', '1.38'],
          ['5+', '1.55'],
        ] as const),
        {
          attribute: 'frequency',
          value: 'weekly',
          multiplier: d('1'),
          approval: {
            reason: 'outside_sop',
            summary:
              'Weekly service requests require explicit owner acceptance of cadence and capacity.',
          },
        },
        { attribute: 'frequency', value: 'biweekly', multiplier: d('1.00') },
        { attribute: 'frequency', value: 'every_four_weeks', multiplier: d('0.95') },
        { attribute: 'frequency', value: 'monthly', multiplier: d('0.90') },
        { attribute: 'occupancy', value: 'occupied', multiplier: d('1.00') },
        {
          attribute: 'occupancy',
          value: 'vacant',
          multiplier: d('1.06'),
          approval: {
            reason: 'outside_sop',
            summary:
              'Vacant service profile may require entry and damage walkthrough confirmation.',
          },
        },
        { attribute: 'pets', value: 'none', multiplier: d('1.00') },
        {
          attribute: 'pets',
          value: '1',
          multiplier: d('1.05'),
        },
        {
          attribute: 'pets',
          value: '2',
          multiplier: d('1.10'),
        },
        {
          attribute: 'pets',
          value: '3+',
          multiplier: d('1.20'),
          approval: {
            reason: 'outside_sop',
            summary: 'High pet density may require extra cleaning method validation.',
          },
        },
        { attribute: 'access', value: 'clear', multiplier: d('1.00') },
        {
          attribute: 'access',
          value: 'limited',
          multiplier: d('1.12'),
        },
        { attribute: 'first_service', value: 'true', multiplier: d('1.16') },
        {
          attribute: 'first_service',
          value: 'false',
          multiplier: d('1.00'),
          approval: {
            reason: 'outside_sop',
            summary: 'Recurring maintenance must preserve previous treatment evidence.',
          },
        },
      ],
      addOns: [
        {
          code: standardRecurringAddOns.OVEN_CLEANING.code,
          name: standardRecurringAddOns.OVEN_CLEANING.name,
          unit: standardRecurringAddOns.OVEN_CLEANING.unit,
          unitPrice: standardRecurringAddOns.OVEN_CLEANING.unitPrice,
          taxable: standardRecurringAddOns.OVEN_CLEANING.taxable,
          estimatedUnitCost: standardRecurringAddOns.OVEN_CLEANING.estimatedUnitCost,
          durationMinutesPerUnit: standardRecurringAddOns.OVEN_CLEANING.durationMinutesPerUnit,
        },
        {
          code: standardRecurringAddOns.REFRIGERATOR_CLEANING.code,
          name: standardRecurringAddOns.REFRIGERATOR_CLEANING.name,
          unit: standardRecurringAddOns.REFRIGERATOR_CLEANING.unit,
          unitPrice: standardRecurringAddOns.REFRIGERATOR_CLEANING.unitPrice,
          taxable: standardRecurringAddOns.REFRIGERATOR_CLEANING.taxable,
          estimatedUnitCost: standardRecurringAddOns.REFRIGERATOR_CLEANING.estimatedUnitCost,
          durationMinutesPerUnit:
            standardRecurringAddOns.REFRIGERATOR_CLEANING.durationMinutesPerUnit,
        },
        {
          code: standardRecurringAddOns.CABINET_DETAIL.code,
          name: standardRecurringAddOns.CABINET_DETAIL.name,
          unit: standardRecurringAddOns.CABINET_DETAIL.unit,
          unitPrice: standardRecurringAddOns.CABINET_DETAIL.unitPrice,
          taxable: standardRecurringAddOns.CABINET_DETAIL.taxable,
          estimatedUnitCost: standardRecurringAddOns.CABINET_DETAIL.estimatedUnitCost,
          durationMinutesPerUnit: standardRecurringAddOns.CABINET_DETAIL.durationMinutesPerUnit,
          approval: {
            reason: 'outside_sop',
            summary: 'Cabinet detail requires explicit access windows and inventory-safe timing.',
          },
        },
        {
          code: standardRecurringAddOns.BASEBOARD_CLEAN.code,
          name: standardRecurringAddOns.BASEBOARD_CLEAN.name,
          unit: standardRecurringAddOns.BASEBOARD_CLEAN.unit,
          unitPrice: standardRecurringAddOns.BASEBOARD_CLEAN.unitPrice,
          taxable: standardRecurringAddOns.BASEBOARD_CLEAN.taxable,
          estimatedUnitCost: standardRecurringAddOns.BASEBOARD_CLEAN.estimatedUnitCost,
          durationMinutesPerUnit: standardRecurringAddOns.BASEBOARD_CLEAN.durationMinutesPerUnit,
        },
        {
          code: standardRecurringAddOns.HIGH_DETAIL_SERVICE.code,
          name: standardRecurringAddOns.HIGH_DETAIL_SERVICE.name,
          unit: standardRecurringAddOns.HIGH_DETAIL_SERVICE.unit,
          unitPrice: standardRecurringAddOns.HIGH_DETAIL_SERVICE.unitPrice,
          taxable: standardRecurringAddOns.HIGH_DETAIL_SERVICE.taxable,
          estimatedUnitCost: standardRecurringAddOns.HIGH_DETAIL_SERVICE.estimatedUnitCost,
          durationMinutesPerUnit:
            standardRecurringAddOns.HIGH_DETAIL_SERVICE.durationMinutesPerUnit,
          approval: standardRecurringAddOns.HIGH_DETAIL_SERVICE.approval,
        },
      ],
    },
  },
  {
    templateVersion: RESIDENTIAL_STARTER_PACK_VERSION,
    catalogItem: {
      code: 'deep-clean',
      name: 'Deep clean restoration',
      description:
        'Condition-aware deep clean with first-clean fallback and escalation for severe wear indicators.',
      category: 'residential_deep_clean',
      active: true,
      taxable: true,
      requiredSkills: ['deep-clean', 'spot-treatment', 'safety-kit'],
      requiredEquipmentTypes: ['floor-machine', 'steam-unit', 'safety-kit'],
      requiredMeasurementKinds: ['area_sq_ft', 'count', 'stories'],
      safetySopReference: 'SOP-HC-DEEP-001',
    },
    scope: {
      primaryMeasurementKind: 'area_sq_ft',
      pricingUnit: 'sq_ft',
      scopeEvidencePolicy: 'photo_optional',
      requiredPhotoViews: ['high-risk room set', 'high-traffic entry and exit paths'],
      humanReviewTriggers: [
        'surface condition is unknown',
        'elapsed time since last clean exceeds 6+ months',
        'first-clean status and occupancy mismatch',
      ],
    },
    priceRule: {
      serviceCode: 'deep-clean',
      requestAliases: ['RESIDENCE_DEEP'],
      pricingUnit: 'sq_ft',
      basePrice: money('280.00'),
      unitPrice: d('0.130'),
      includedQuantity: d('700'),
      serviceMinimum: money('280.00'),
      estimatedBaseCost: money('95.00'),
      estimatedUnitCost: d('0.052'),
      durationBaseMinutes: 155,
      durationMinutesPerUnit: d('0.043'),
      taxable: true,
      allowedAttributeValues: {
        condition: ['light', 'moderate', 'heavy', 'severe'],
        elapsed_since_last_service: [
          'within_3_months',
          '3_to_6_months',
          '6_to_12_months',
          '12_plus_months',
        ],
        first_service: ['true', 'false'],
        occupancy: ['occupied', 'vacant'],
        access: ['clear', 'limited'],
        stories: ['1', '2', '3'],
      },
      attributeMultipliers: [
        { attribute: 'condition', value: 'light', multiplier: d('1.00') },
        {
          attribute: 'condition',
          value: 'moderate',
          multiplier: d('1.12'),
        },
        {
          attribute: 'condition',
          value: 'heavy',
          multiplier: d('1.35'),
        },
        {
          attribute: 'condition',
          value: 'severe',
          multiplier: d('1.68'),
          approval: {
            reason: 'outside_sop',
            summary:
              'Severe condition requests require owner and customer-side scope confirmation.',
          },
        },
        {
          attribute: 'elapsed_since_last_service',
          value: 'within_3_months',
          multiplier: d('1.00'),
        },
        { attribute: 'elapsed_since_last_service', value: '3_to_6_months', multiplier: d('1.08') },
        { attribute: 'elapsed_since_last_service', value: '6_to_12_months', multiplier: d('1.16') },
        {
          attribute: 'elapsed_since_last_service',
          value: '12_plus_months',
          multiplier: d('1.28'),
          approval: {
            reason: 'outside_sop',
            summary:
              '12+ months since prior service requires fresh evidence and explicit confirmation.',
          },
        },
        { attribute: 'first_service', value: 'true', multiplier: d('1.18') },
        { attribute: 'first_service', value: 'false', multiplier: d('1.00') },
        { attribute: 'occupancy', value: 'occupied', multiplier: d('1.00') },
        {
          attribute: 'occupancy',
          value: 'vacant',
          multiplier: d('1.05'),
        },
        { attribute: 'access', value: 'clear', multiplier: d('1.00') },
        { attribute: 'access', value: 'limited', multiplier: d('1.14') },
        { attribute: 'stories', value: '1', multiplier: d('1.00') },
        { attribute: 'stories', value: '2', multiplier: d('1.05') },
        {
          attribute: 'stories',
          value: '3',
          multiplier: d('1.11'),
          approval: {
            reason: 'outside_sop',
            summary: 'Three-story deep cleans require additional staffing and access review.',
          },
        },
      ],
      addOns: [
        {
          code: standardRecurringAddOns.PET_HAIR_BONUS.code,
          name: standardRecurringAddOns.PET_HAIR_BONUS.name,
          unit: standardRecurringAddOns.PET_HAIR_BONUS.unit,
          unitPrice: standardRecurringAddOns.PET_HAIR_BONUS.unitPrice,
          taxable: standardRecurringAddOns.PET_HAIR_BONUS.taxable,
          estimatedUnitCost: standardRecurringAddOns.PET_HAIR_BONUS.estimatedUnitCost,
          durationMinutesPerUnit: standardRecurringAddOns.PET_HAIR_BONUS.durationMinutesPerUnit,
          approval: standardRecurringAddOns.PET_HAIR_BONUS.approval,
        },
        {
          code: standardRecurringAddOns.HIGH_DETAIL_SERVICE.code,
          name: standardRecurringAddOns.HIGH_DETAIL_SERVICE.name,
          unit: standardRecurringAddOns.HIGH_DETAIL_SERVICE.unit,
          unitPrice: standardRecurringAddOns.HIGH_DETAIL_SERVICE.unitPrice,
          taxable: standardRecurringAddOns.HIGH_DETAIL_SERVICE.taxable,
          estimatedUnitCost: standardRecurringAddOns.HIGH_DETAIL_SERVICE.estimatedUnitCost,
          durationMinutesPerUnit:
            standardRecurringAddOns.HIGH_DETAIL_SERVICE.durationMinutesPerUnit,
          approval: standardRecurringAddOns.HIGH_DETAIL_SERVICE.approval,
        },
      ],
    },
  },
  {
    templateVersion: RESIDENTIAL_STARTER_PACK_VERSION,
    catalogItem: {
      code: 'move-in-out-clean',
      name: 'Move-in / move-out turnkey clean',
      description:
        'Vacancy-focused reset with appliance and cabinetry verification for handover or departure.',
      category: 'residential_turnover',
      active: true,
      taxable: true,
      requiredSkills: ['turnover-clean', 'inventory-check', 'safety-kit'],
      requiredEquipmentTypes: ['microfiber-toolkit', 'steam-unit', 'vacuum'],
      requiredMeasurementKinds: ['area_sq_ft', 'count'],
      safetySopReference: 'SOP-HC-MOVEOUT-001',
    },
    scope: {
      primaryMeasurementKind: 'area_sq_ft',
      pricingUnit: 'sq_ft',
      scopeEvidencePolicy: 'photo_optional',
      requiredPhotoViews: ['whole-home room-by-room set', 'appliance and closet access photos'],
      humanReviewTriggers: [
        'appliance condition is unknown',
        'kitchen inventory photo coverage is missing',
        'deep-turnover risk exceeds baseline',
      ],
    },
    priceRule: {
      serviceCode: 'move-in-out-clean',
      requestAliases: ['RESIDENCE_MOVE'],
      pricingUnit: 'sq_ft',
      basePrice: money('360.00'),
      unitPrice: d('0.140'),
      includedQuantity: d('1000'),
      serviceMinimum: money('320.00'),
      estimatedBaseCost: money('95.00'),
      estimatedUnitCost: d('0.044'),
      durationBaseMinutes: 170,
      durationMinutesPerUnit: d('0.046'),
      taxable: true,
      allowedAttributeValues: {
        move_type: ['move-in', 'move-out'],
        occupancy: ['occupied', 'vacant'],
        appliance_count: ['1-2', '3-5', '6-8', '9+'],
        access: ['clear', 'limited'],
        condition: ['light', 'moderate', 'heavy'],
      },
      attributeMultipliers: [
        { attribute: 'move_type', value: 'move-in', multiplier: d('1.00') },
        { attribute: 'move_type', value: 'move-out', multiplier: d('1.10') },
        { attribute: 'occupancy', value: 'occupied', multiplier: d('1.00') },
        {
          attribute: 'occupancy',
          value: 'vacant',
          multiplier: d('1.06'),
          approval: {
            reason: 'outside_sop',
            summary: 'Vacant turnover requires property-condition walkthrough confirmation.',
          },
        },
        { attribute: 'appliance_count', value: '1-2', multiplier: d('1.00') },
        { attribute: 'appliance_count', value: '3-5', multiplier: d('1.10') },
        {
          attribute: 'appliance_count',
          value: '6-8',
          multiplier: d('1.20'),
          approval: {
            reason: 'outside_sop',
            summary:
              'Large appliance inventories require explicit schedule and access confirmation.',
          },
        },
        { attribute: 'appliance_count', value: '9+', multiplier: d('1.35') },
        { attribute: 'access', value: 'clear', multiplier: d('1.00') },
        { attribute: 'access', value: 'limited', multiplier: d('1.08') },
        { attribute: 'condition', value: 'light', multiplier: d('1.00') },
        { attribute: 'condition', value: 'moderate', multiplier: d('1.12') },
        {
          attribute: 'condition',
          value: 'heavy',
          multiplier: d('1.30'),
          approval: {
            reason: 'outside_sop',
            summary: 'Heavy turnover condition requires a scoped remediation note before launch.',
          },
        },
      ],
      addOns: [
        {
          code: moveOutAddOns.INTERIOR_WINDOWS.code,
          name: moveOutAddOns.INTERIOR_WINDOWS.name,
          unit: moveOutAddOns.INTERIOR_WINDOWS.unit,
          unitPrice: moveOutAddOns.INTERIOR_WINDOWS.unitPrice,
          taxable: moveOutAddOns.INTERIOR_WINDOWS.taxable,
          estimatedUnitCost: moveOutAddOns.INTERIOR_WINDOWS.estimatedUnitCost,
          durationMinutesPerUnit: moveOutAddOns.INTERIOR_WINDOWS.durationMinutesPerUnit,
        },
        {
          code: moveOutAddOns.BLINDS_AND_TRACKS.code,
          name: moveOutAddOns.BLINDS_AND_TRACKS.name,
          unit: moveOutAddOns.BLINDS_AND_TRACKS.unit,
          unitPrice: moveOutAddOns.BLINDS_AND_TRACKS.unitPrice,
          taxable: moveOutAddOns.BLINDS_AND_TRACKS.taxable,
          estimatedUnitCost: moveOutAddOns.BLINDS_AND_TRACKS.estimatedUnitCost,
          durationMinutesPerUnit: moveOutAddOns.BLINDS_AND_TRACKS.durationMinutesPerUnit,
        },
        {
          code: moveOutAddOns.LAUNDRY_LINEN_REFRESH.code,
          name: moveOutAddOns.LAUNDRY_LINEN_REFRESH.name,
          unit: moveOutAddOns.LAUNDRY_LINEN_REFRESH.unit,
          unitPrice: moveOutAddOns.LAUNDRY_LINEN_REFRESH.unitPrice,
          taxable: moveOutAddOns.LAUNDRY_LINEN_REFRESH.taxable,
          estimatedUnitCost: moveOutAddOns.LAUNDRY_LINEN_REFRESH.estimatedUnitCost,
          durationMinutesPerUnit: moveOutAddOns.LAUNDRY_LINEN_REFRESH.durationMinutesPerUnit,
        },
      ],
    },
  },
];

export const residentialCleaningIndustryPack = {
  code: 'residential-cleaning',
  name: 'Residential cleaning',
  version: RESIDENTIAL_STARTER_PACK_VERSION,
  description:
    'Recurring home-care cleaning with maintenance, deep, and turnover workflows on the shared StoryOps kernel.',
  serviceCodes: RESIDENTIAL_SERVICE_CODES,
  serviceTemplates: residentialServiceTemplates,
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
} satisfies ServiceIndustryPack<ResidentialServiceCode>;

const residentialPackageServiceOrder = [
  'standard-recurring-clean',
  'deep-clean',
  'move-in-out-clean',
] as const;

function packageTemplate(serviceCode: ResidentialServiceCode): ResidentialServiceTemplate {
  const template = residentialServiceTemplates.find(
    (candidate) => candidate.catalogItem.code === serviceCode,
  );
  if (!template) {
    throw new Error(`Residential service template "${serviceCode}" is not registered.`);
  }
  return template;
}

function packageDescription(
  identity: (typeof RESIDENTIAL_PACKAGE_IDENTITIES)[number],
  serviceCodes: readonly ResidentialServiceCode[],
): string {
  const scope = serviceCodes
    .map((serviceCode) => packageTemplate(serviceCode).catalogItem.name)
    .join(', ');
  return `${identity.tier[0]!.toUpperCase()}${identity.tier.slice(1)}: includes measured ${scope}.`;
}

export function createResidentialConfigurationPackages(
  enabledServiceCodes: readonly ResidentialServiceCode[] = RESIDENTIAL_SERVICE_CODES,
): ServicePackageDefinition[] {
  const selected = residentialPackageServiceOrder.filter((code) =>
    enabledServiceCodes.includes(code),
  );
  if (selected.length < 2) {
    throw new Error(
      'Good, better, best residential packages require at least two services selected.',
    );
  }

  const serviceCountByTier = {
    good: 1,
    better: Math.min(selected.length, Math.max(2, Math.ceil((selected.length * 2) / 3))),
    best: selected.length,
  } as const;

  return RESIDENTIAL_PACKAGE_IDENTITIES.map((identity) => {
    const packageServiceCodes = selected.slice(0, serviceCountByTier[identity.tier]);
    return {
      code: identity.code,
      name: identity.name,
      description: packageDescription(identity, packageServiceCodes),
      tier: identity.tier,
      components: packageServiceCodes.map((serviceCode) => ({
        serviceCode,
        required: true,
        requiredAddOnCodes: [],
        optionalAddOnCodes: packageTemplate(serviceCode)
          .priceRule.addOns.map((addOn) => addOn.code)
          .filter(
            (code: string) =>
              identity.tier === 'best' ||
              ![
                standardRecurringAddOns.HIGH_DETAIL_SERVICE.code,
                moveOutAddOns.LAUNDRY_LINEN_REFRESH.code,
                standardRecurringAddOns.PET_HAIR_BONUS.code,
              ].includes(
                code as 'HIGH_DETAIL_SERVICE' | 'LAUNDRY_LINEN_REFRESH' | 'PET_HAIR_BONUS',
              ),
          ),
      })),
    };
  });
}

export function createResidentialConfigurationPricing(
  enabledServiceCodes: readonly ResidentialServiceCode[] = RESIDENTIAL_SERVICE_CODES,
) {
  return {
    serviceRules: residentialServiceTemplates.map((template) => ({
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
    packages: createResidentialConfigurationPackages(enabledServiceCodes).map((servicePackage) => ({
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

export const residentialPackages =
  createResidentialConfigurationPackages(RESIDENTIAL_SERVICE_CODES);

export const RESIDENTIAL_STARTER_PRICE_BOOK_POLICY = {
  name: 'DFW Residential Cleaning',
  versionLabel: '2026.09-v1',
  currency: 'USD',
  companyMinimum: money('275.00'),
  travelZones: [
    {
      zoneCode: 'R-CORE',
      name: 'Core service zone',
      fee: money('0.00'),
      taxable: false,
      maximumOneWayMiles: d('25'),
    },
    {
      zoneCode: 'R-EXT',
      name: 'Extended home-service zone',
      fee: money('45.00'),
      taxable: false,
      maximumOneWayMiles: d('45'),
    },
    {
      zoneCode: 'R-DIST',
      name: 'Distance premium zone',
      fee: money('95.00'),
      taxable: false,
      maximumOneWayMiles: d('70'),
    },
  ],
  defaultTaxRate: asPercentageString('8.25'),
  marginFloor: asPercentageString('40'),
  automaticDiscountLimit: asPercentageString('12'),
  depositRule: {
    kind: 'percent',
    value: asPercentageString('20'),
  },
} as const;

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

type ResidentialPriceBookPublication = Pick<
  PriceBook,
  | keyof EntityMetadata
  | 'status'
  | 'effectiveFrom'
  | 'effectiveUntil'
  | 'publishedBy'
  | 'publishedAt'
>;

export const createResidentialStarterPriceBook = (
  publication: ResidentialPriceBookPublication,
): PriceBook => ({
  ...publication,
  name: RESIDENTIAL_STARTER_PRICE_BOOK_POLICY.name,
  versionLabel: RESIDENTIAL_STARTER_PRICE_BOOK_POLICY.versionLabel,
  currency: RESIDENTIAL_STARTER_PRICE_BOOK_POLICY.currency,
  companyMinimum: { ...RESIDENTIAL_STARTER_PRICE_BOOK_POLICY.companyMinimum },
  travelZones: RESIDENTIAL_STARTER_PRICE_BOOK_POLICY.travelZones.map((zone) => ({
    ...zone,
    fee: { ...zone.fee },
  })),
  defaultTaxRate: RESIDENTIAL_STARTER_PRICE_BOOK_POLICY.defaultTaxRate,
  marginFloor: RESIDENTIAL_STARTER_PRICE_BOOK_POLICY.marginFloor,
  automaticDiscountLimit: RESIDENTIAL_STARTER_PRICE_BOOK_POLICY.automaticDiscountLimit,
  depositRule: { ...RESIDENTIAL_STARTER_PRICE_BOOK_POLICY.depositRule },
  serviceRules: residentialServiceTemplates.map((template) => clonePriceRule(template.priceRule)),
});
