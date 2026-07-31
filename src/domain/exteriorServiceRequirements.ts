export const exteriorServiceOperationalRequirements = {
  'pressure-wash-flatwork': {
    requiredSkills: ['surface-identification', 'pressure-washing'],
    requiredEquipmentTypes: ['pressure-washer', 'surface-cleaner'],
  },
  'soft-wash-house': {
    requiredSkills: ['soft-washing', 'siding-identification', 'chemical-handling'],
    requiredEquipmentTypes: ['soft-wash-system', 'chemical-metering', 'plant-protection'],
  },
  'gutter-cleaning': {
    requiredSkills: ['ladder-safety', 'gutter-cleaning'],
    requiredEquipmentTypes: ['ladder', 'fall-protection', 'gutter-tools'],
  },
  'roof-washing': {
    requiredSkills: ['roof-soft-washing', 'fall-protection', 'chemical-handling'],
    requiredEquipmentTypes: ['soft-wash-system', 'fall-protection', 'plant-protection'],
  },
  'window-cleaning': {
    requiredSkills: ['window-cleaning', 'ladder-safety'],
    requiredEquipmentTypes: ['window-cleaning-kit', 'ladder'],
  },
} as const;

export const exteriorServicePricingSemantics = {
  'pressure-wash-flatwork': {
    pricingUnit: 'sq_ft',
    requiredMeasurementKinds: ['area_sq_ft'],
  },
  'soft-wash-house': {
    pricingUnit: 'sq_ft',
    requiredMeasurementKinds: ['area_sq_ft'],
  },
  'gutter-cleaning': {
    pricingUnit: 'linear_ft',
    requiredMeasurementKinds: ['length_linear_ft', 'count'],
  },
  'roof-washing': {
    pricingUnit: 'sq_ft',
    requiredMeasurementKinds: ['area_sq_ft'],
  },
  'window-cleaning': {
    pricingUnit: 'each',
    requiredMeasurementKinds: ['count'],
  },
} as const;

export function getExteriorServicePricingSemantics(serviceCode: string):
  | {
      pricingUnit: 'flat' | 'sq_ft' | 'linear_ft' | 'each' | 'hour';
      requiredMeasurementKinds: readonly string[];
    }
  | undefined {
  return exteriorServicePricingSemantics[
    serviceCode as keyof typeof exteriorServicePricingSemantics
  ];
}

export function getExteriorConfigurationRequirements(enabledServiceCodes: readonly string[]): {
  requiredSkills: string[];
  requiredEquipmentTypes: string[];
} {
  const selected = enabledServiceCodes.flatMap((serviceCode) => {
    const requirements =
      exteriorServiceOperationalRequirements[
        serviceCode as keyof typeof exteriorServiceOperationalRequirements
      ];
    return requirements ? [requirements] : [];
  });
  return {
    requiredSkills: [...new Set(selected.flatMap((requirements) => requirements.requiredSkills))],
    requiredEquipmentTypes: [
      ...new Set(selected.flatMap((requirements) => requirements.requiredEquipmentTypes)),
    ],
  };
}
