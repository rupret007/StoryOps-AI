import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  getIndustryPackPricingSemantics,
  getIndustryPackServiceRequirements,
} from './industryPackRequirements.ts';

export const COMPANY_CONFIGURATION_SCHEMA_VERSION = 'storyops-company-config-v1' as const;

export const companyConfigurationSections = [
  'identity',
  'territory',
  'schedule',
  'pricing',
  'people',
  'resources',
  'materials',
  'payments',
  'policies',
  'engagement',
  'integrations',
] as const;

export type CompanyConfigurationSection = (typeof companyConfigurationSections)[number];
export type ConfigurationReviewStatus = 'required' | 'in_review' | 'approved';
export type CompanyConfigurationPublicationMode = 'sandbox' | 'live';

const printableText = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) =>
        ![...value].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 31 || codePoint === 127;
        }),
      'Control characters are not allowed.',
    );

const optionalHttpsUrl = z
  .union([z.literal(''), z.string().url().startsWith('https://')])
  .default('');

const decimalString = (minimum: string, maximum: string, scale = 2) =>
  z
    .string()
    .trim()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, 'Use a non-negative decimal value.')
    .refine((value) => {
      const parsed = new Decimal(value);
      return parsed.greaterThanOrEqualTo(minimum) && parsed.lessThanOrEqualTo(maximum);
    }, `Value must be between ${minimum} and ${maximum}.`)
    .transform((value) => new Decimal(value).toDecimalPlaces(scale).toFixed(scale));

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/u);
const serviceCode = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/u);
const measurementKindSchema = z.enum([
  'area_sq_ft',
  'length_linear_ft',
  'height_ft',
  'count',
  'stories',
  'duration_hours',
]);
const primaryMeasurementKindByPricingUnit = {
  flat: 'count',
  sq_ft: 'area_sq_ft',
  linear_ft: 'length_linear_ft',
  each: 'count',
  hour: 'duration_hours',
} as const;

const businessDaySchema = z
  .object({
    day: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
    closed: z.boolean(),
    opensAt: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
    closesAt: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.closed && value.opensAt >= value.closesAt) {
      context.addIssue({
        code: 'custom',
        path: ['closesAt'],
        message: 'Closing time must be after opening time.',
      });
    }
  });

const travelZoneSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,15}$/u),
    name: printableText(2, 60),
    maximumMiles: z.union([z.literal(''), decimalString('0', '250', 1)]).default(''),
    fee: decimalString('0', '1000'),
    postalCodes: z
      .array(
        z
          .string()
          .trim()
          .regex(/^\d{5}$/u, 'Travel-zone mappings require normalized five-digit ZIP codes.'),
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((zone, context) => {
    if (new Set(zone.postalCodes).size !== zone.postalCodes.length) {
      context.addIssue({
        code: 'custom',
        path: ['postalCodes'],
        message: 'A ZIP code may appear only once within a travel zone.',
      });
    }
  });

const pricingAttributeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,79}$/u);

const pricingApprovalSchema = z
  .object({
    reason: z.enum([
      'price_exception',
      'large_discount',
      'margin_below_floor',
      'outside_price_book',
      'outside_sop',
      'refund',
      'legal_message',
      'safety_message',
      'negative_review_response',
      'vendor_action',
      'bank_action',
      'destructive_change',
      'uncertain_scope',
      'stale_availability',
      'weather_exception',
      'campaign_send',
      'other',
    ]),
    summary: printableText(5, 300),
  })
  .strict();

const configuredAddOnSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_]{1,79}$/u),
    name: printableText(2, 100),
    pricingUnit: z.enum(['flat', 'sq_ft', 'linear_ft', 'each', 'hour']),
    unitPrice: decimalString('0', '100000', 6),
    taxable: z.boolean(),
    estimatedUnitCost: decimalString('0', '100000', 6),
    durationMinutesPerUnit: decimalString('0', '10000', 4),
    approval: pricingApprovalSchema.optional(),
  })
  .strict();

const configuredServiceRuleSchema = z
  .object({
    serviceCode,
    pricingUnit: z.enum(['flat', 'sq_ft', 'linear_ft', 'each', 'hour']),
    requiredMeasurementKinds: z.array(measurementKindSchema).min(1).max(10),
    basePrice: decimalString('0', '100000'),
    unitPrice: decimalString('0', '100000', 6),
    includedQuantity: decimalString('0', '10000000', 4),
    serviceMinimum: decimalString('0', '100000'),
    estimatedBaseCost: decimalString('0', '100000'),
    estimatedUnitCost: decimalString('0', '100000', 6),
    durationBaseMinutes: z.number().int().min(0).max(100_000),
    durationMinutesPerUnit: decimalString('0', '10000', 4),
    taxable: z.boolean(),
    allowedAttributeValues: z.record(z.string(), z.array(z.string().min(1).max(80)).min(1).max(30)),
    attributeMultipliers: z
      .array(
        z
          .object({
            attribute: pricingAttributeSchema,
            value: z.string().min(1).max(80),
            multiplier: decimalString('0.0001', '1000', 4),
            approval: pricingApprovalSchema.optional(),
          })
          .strict(),
      )
      .max(200),
    addOns: z.array(configuredAddOnSchema).max(50),
  })
  .strict()
  .superRefine((rule, context) => {
    const expectedPrimaryKind = primaryMeasurementKindByPricingUnit[rule.pricingUnit];
    if (rule.requiredMeasurementKinds[0] !== expectedPrimaryKind) {
      context.addIssue({
        code: 'custom',
        path: ['requiredMeasurementKinds'],
        message: `The first required measurement kind must be ${expectedPrimaryKind} for ${rule.pricingUnit} pricing.`,
      });
    }
    if (new Set(rule.requiredMeasurementKinds).size !== rule.requiredMeasurementKinds.length) {
      context.addIssue({
        code: 'custom',
        path: ['requiredMeasurementKinds'],
        message: 'Required measurement kinds must be unique and primary-first.',
      });
    }
    const allowedPairs = new Set<string>();
    for (const attribute of Object.keys(rule.allowedAttributeValues)) {
      if (!pricingAttributeSchema.safeParse(attribute).success) {
        context.addIssue({
          code: 'custom',
          path: ['allowedAttributeValues', attribute],
          message: 'Pricing attributes must be bounded semantic codes.',
        });
      }
      const values = rule.allowedAttributeValues[attribute] ?? [];
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: 'custom',
          path: ['allowedAttributeValues', attribute],
          message: 'Allowed attribute values must be unique.',
        });
      }
      for (const value of values) {
        allowedPairs.add(`${attribute}\u001f${value}`);
      }
    }
    const multiplierKeys = rule.attributeMultipliers.map(
      (item) => `${item.attribute}\u001f${item.value}`,
    );
    if (new Set(multiplierKeys).size !== multiplierKeys.length) {
      context.addIssue({
        code: 'custom',
        path: ['attributeMultipliers'],
        message: 'Attribute multiplier pairs must be unique.',
      });
    }
    const multiplierKeySet = new Set(multiplierKeys);
    const missingMultipliers = [...allowedPairs].filter((key) => !multiplierKeySet.has(key));
    if (missingMultipliers.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['attributeMultipliers'],
        message: 'Every allowed attribute value requires exactly one multiplier.',
      });
    }
    const extraMultipliers = [...multiplierKeySet].filter((key) => !allowedPairs.has(key));
    if (extraMultipliers.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['attributeMultipliers'],
        message: 'Attribute multipliers cannot reference undeclared attribute values.',
      });
    }
    const addOnCodes = rule.addOns.map((item) => item.code);
    if (new Set(addOnCodes).size !== addOnCodes.length) {
      context.addIssue({
        code: 'custom',
        path: ['addOns'],
        message: 'Add-on codes must be unique within a service rule.',
      });
    }
  });

const configuredPackageSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_]{1,79}$/u),
    name: printableText(2, 100),
    description: printableText(10, 500),
    tier: z.enum(['good', 'better', 'best']),
    components: z
      .array(
        z
          .object({
            serviceCode,
            required: z.boolean(),
            requiredAddOnCodes: z.array(z.string().min(1).max(80)).max(30),
            optionalAddOnCodes: z.array(z.string().min(1).max(80)).max(30),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

const crewMemberSchema = z
  .object({
    id: identifier,
    name: printableText(2, 80),
    role: z.enum(['owner', 'dispatcher', 'technician']),
    skills: z.array(identifier).max(30),
    active: z.boolean(),
  })
  .strict();

const vehicleSchema = z
  .object({
    id: identifier,
    name: printableText(2, 80),
    kind: z.enum(['truck', 'van', 'trailer', 'other']),
    capacityNote: printableText(2, 160),
    active: z.boolean(),
  })
  .strict();

const equipmentSchema = z
  .object({
    id: identifier,
    name: printableText(2, 80),
    equipmentType: identifier,
    quantity: z.number().int().min(1).max(100),
    inspectionStatus: z.enum(['current', 'due', 'out_of_service']),
    active: z.boolean(),
  })
  .strict();

const materialSchema = z
  .object({
    id: identifier,
    name: printableText(2, 100),
    unit: printableText(1, 30),
    requiresSds: z.boolean(),
    sdsStatus: z.enum(['not_required', 'missing', 'in_review', 'approved']),
    sdsReference: optionalHttpsUrl,
    sdsChecksumSha256: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/u)]).default(''),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.requiresSds && value.sdsStatus !== 'not_required') {
      context.addIssue({
        code: 'custom',
        path: ['sdsStatus'],
        message: 'Non-chemical materials must use not_required SDS status.',
      });
    }
    if (
      value.requiresSds &&
      value.sdsStatus === 'approved' &&
      (!value.sdsReference || !value.sdsChecksumSha256)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sdsReference'],
        message: 'Approved SDS records require an HTTPS reference and SHA-256 checksum.',
      });
    }
  });

const reviewEvidenceSchema = z
  .object({
    status: z.enum(['required', 'in_review', 'approved']),
    reviewer: z.string().trim().max(100),
    reviewedAt: z.string().datetime({ offset: true }).or(z.literal('')),
    evidenceReference: z.string().trim().max(240),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === 'approved' &&
      (!value.reviewer || !value.reviewedAt || !value.evidenceReference)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Approved reviews require reviewer, time, and evidence reference.',
      });
    }
  });

const integrationSchema = z
  .object({
    provider: z.enum([
      'openai',
      'twilio',
      'email',
      'stripe',
      'google_calendar',
      'maps',
      'nws',
      'vroom',
      'storage',
      'quickbooks_export',
    ]),
    requestedMode: z.enum(['disabled', 'sandbox', 'live']),
    environmentEnabled: z.boolean(),
    ownerEnabled: z.boolean(),
    health: z.enum(['not_checked', 'healthy', 'degraded', 'blocked']),
  })
  .strict();

export const companyConfigurationInputSchema = z
  .object({
    schemaVersion: z.literal(COMPANY_CONFIGURATION_SCHEMA_VERSION),
    identity: z
      .object({
        legalName: printableText(2, 100),
        displayName: printableText(2, 80),
        ownerName: printableText(2, 80),
        publicEmail: z.string().trim().email(),
        publicPhone: z
          .string()
          .trim()
          .regex(/^\+[1-9]\d{7,14}$/u),
        website: optionalHttpsUrl,
        brand: z
          .object({
            primaryColor: z.string().regex(/^#[0-9a-f]{6}$/u),
            accentColor: z.string().regex(/^#[0-9a-f]{6}$/u),
            logoUrl: optionalHttpsUrl,
          })
          .strict(),
      })
      .strict(),
    territory: z
      .object({
        serviceAddress: z
          .object({
            line1: printableText(2, 120),
            line2: z.string().trim().max(120),
            city: printableText(2, 80),
            region: z
              .string()
              .trim()
              .regex(/^[A-Z]{2}$/u),
            postalCode: z
              .string()
              .trim()
              .regex(/^\d{5}(?:-\d{4})?$/u),
            country: z.literal('US'),
          })
          .strict(),
        timezone: z.string().min(3).max(80),
        serviceAreaNote: printableText(2, 240),
        travelZones: z.array(travelZoneSchema).min(1).max(12),
        travelZoneMappingReview: reviewEvidenceSchema,
      })
      .strict(),
    schedule: z
      .object({
        businessHours: z.array(businessDaySchema).length(7),
        appointmentBufferMinutes: z.number().int().min(0).max(240),
        minimumLeadTimeHours: z.number().int().min(0).max(720),
        maximumBookingDays: z.number().int().min(1).max(730),
      })
      .strict(),
    pricing: z
      .object({
        currency: z.literal('USD'),
        companyMinimum: decimalString('0', '10000'),
        defaultTaxRatePercent: decimalString('0', '25', 4),
        taxEnabled: z.boolean(),
        marginFloorPercent: decimalString('0', '95', 2),
        automaticDiscountLimitPercent: decimalString('0', '100', 2),
        priceBookTemplateVersion: printableText(2, 80),
        enabledServiceCodes: z.array(serviceCode).min(1).max(40),
        serviceRules: z.array(configuredServiceRuleSchema).min(1).max(40),
        packages: z.array(configuredPackageSchema).min(3).max(20),
        taxReview: reviewEvidenceSchema,
      })
      .strict(),
    people: z
      .object({
        crewMembers: z.array(crewMemberSchema).min(1).max(50),
      })
      .strict(),
    resources: z
      .object({
        vehicles: z.array(vehicleSchema).min(1).max(50),
        equipment: z.array(equipmentSchema).min(1).max(100),
      })
      .strict(),
    materials: z
      .object({
        catalog: z.array(materialSchema).min(1).max(100),
      })
      .strict(),
    payments: z
      .object({
        acceptedMethods: z
          .array(z.enum(['card', 'ach', 'cash', 'check']))
          .min(1)
          .max(4),
        depositKind: z.enum(['none', 'percent', 'fixed']),
        depositValue: decimalString('0', '10000'),
        refundsRequireApproval: z.literal(true),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.depositKind === 'percent' && new Decimal(value.depositValue).greaterThan(100)) {
          context.addIssue({
            code: 'custom',
            path: ['depositValue'],
            message: 'Percentage deposits cannot exceed 100%.',
          });
        }
        if (value.depositKind === 'none' && !new Decimal(value.depositValue).isZero()) {
          context.addIssue({
            code: 'custom',
            path: ['depositValue'],
            message: 'No-deposit policy must use a zero value.',
          });
        }
      }),
    policies: z
      .object({
        cancellationHours: z.number().int().min(0).max(720),
        cancellationFee: decimalString('0', '5000'),
        rescheduleHours: z.number().int().min(0).max(720),
        termsText: printableText(40, 20_000),
        retentionDays: z
          .object({
            operational: z.number().int().min(30).max(3650),
            communications: z.number().int().min(30).max(3650),
            aiTraces: z.number().int().min(7).max(730),
            audit: z.number().int().min(365).max(3650),
            safety: z.number().int().min(365).max(3650),
          })
          .strict(),
        legalReview: reviewEvidenceSchema,
        privacyReview: reviewEvidenceSchema,
        safetyReview: reviewEvidenceSchema,
        insuranceReview: reviewEvidenceSchema,
        environmentalReview: reviewEvidenceSchema,
      })
      .strict(),
    engagement: z
      .object({
        reviewRequestEnabled: z.boolean(),
        reviewDelayHours: z.number().int().min(1).max(720),
        reviewUrl: optionalHttpsUrl,
        referralEnabled: z.boolean(),
        referralRewardDescription: z.string().trim().max(240),
        recurringMaintenanceEnabled: z.boolean(),
      })
      .strict(),
    integrations: z
      .object({
        providers: z.array(integrationSchema).length(10),
      })
      .strict(),
  })
  .strict()
  .superRefine((configuration, context) => {
    const days = configuration.schedule.businessHours.map((entry) => entry.day);
    if (new Set(days).size !== 7) {
      context.addIssue({
        code: 'custom',
        path: ['schedule', 'businessHours'],
        message: 'Business hours must contain each day exactly once.',
      });
    }

    const zoneCodes = configuration.territory.travelZones.map((zone) => zone.code);
    if (new Set(zoneCodes).size !== zoneCodes.length) {
      context.addIssue({
        code: 'custom',
        path: ['territory', 'travelZones'],
        message: 'Travel-zone codes must be unique.',
      });
    }
    const mappedPostalCodes = configuration.territory.travelZones.flatMap((zone) =>
      zone.postalCodes.map((postalCode) => postalCode),
    );
    if (new Set(mappedPostalCodes).size !== mappedPostalCodes.length) {
      context.addIssue({
        code: 'custom',
        path: ['territory', 'travelZones'],
        message: 'A ZIP code may map to only one travel zone.',
      });
    }
    for (let index = 1; index < configuration.territory.travelZones.length; index += 1) {
      const previous = configuration.territory.travelZones[index - 1];
      const current = configuration.territory.travelZones[index];
      if (
        previous &&
        current &&
        previous.maximumMiles &&
        current.maximumMiles &&
        new Decimal(current.maximumMiles).lessThanOrEqualTo(previous.maximumMiles)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['territory', 'travelZones', index, 'maximumMiles'],
          message: 'Travel zones must increase by maximum distance.',
        });
      }
    }

    const uniqueFields: Array<[unknown[], PropertyKey[], string]> = [
      [
        configuration.pricing.enabledServiceCodes,
        ['pricing', 'enabledServiceCodes'],
        'Service codes must be unique.',
      ],
      [
        configuration.pricing.serviceRules.map((rule) => rule.serviceCode),
        ['pricing', 'serviceRules'],
        'Configured service-rule codes must be unique.',
      ],
      [
        configuration.pricing.packages.map((servicePackage) => servicePackage.code),
        ['pricing', 'packages'],
        'Configured package codes must be unique.',
      ],
      [
        configuration.people.crewMembers.map((member) => member.id),
        ['people', 'crewMembers'],
        'Crew member IDs must be unique.',
      ],
      [
        configuration.resources.vehicles.map((vehicle) => vehicle.id),
        ['resources', 'vehicles'],
        'Vehicle IDs must be unique.',
      ],
      [
        configuration.resources.equipment.map((equipment) => equipment.id),
        ['resources', 'equipment'],
        'Equipment IDs must be unique.',
      ],
      [
        configuration.materials.catalog.map((material) => material.id),
        ['materials', 'catalog'],
        'Material IDs must be unique.',
      ],
      [
        configuration.integrations.providers.map((provider) => provider.provider),
        ['integrations', 'providers'],
        'Integration providers must be unique.',
      ],
    ];
    for (const [values, path, message] of uniqueFields) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: 'custom', path, message });
      }
    }

    const activeOwnerIndexes = configuration.people.crewMembers.flatMap((member, index) =>
      member.active && member.role === 'owner' ? [index] : [],
    );
    if (activeOwnerIndexes.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['people', 'crewMembers'],
        message:
          'Single-owner V1 requires exactly one active configured owner; other people are planning records until separately onboarded.',
      });
    }

    const enabledServices = new Set(configuration.pricing.enabledServiceCodes);
    const ruleByService = new Map(
      configuration.pricing.serviceRules.map((rule) => [rule.serviceCode, rule]),
    );
    for (const enabledServiceCode of enabledServices) {
      const rule = ruleByService.get(enabledServiceCode);
      const catalogSemantics = getIndustryPackPricingSemantics(
        enabledServiceCode,
        undefined,
        configuration.pricing.priceBookTemplateVersion,
      );
      if (!rule) continue;
      if (!catalogSemantics) {
        const ruleIndex = configuration.pricing.serviceRules.indexOf(rule);
        context.addIssue({
          code: 'custom',
          path: ['pricing', 'serviceRules', ruleIndex],
          message: `Enabled service ${enabledServiceCode} has no resolved industry pack semantics in template ${configuration.pricing.priceBookTemplateVersion}.`,
        });
        continue;
      }
      if (
        rule.pricingUnit !== catalogSemantics.pricingUnit ||
        rule.requiredMeasurementKinds.length !== catalogSemantics.requiredMeasurementKinds.length ||
        rule.requiredMeasurementKinds.some(
          (kind, index) => kind !== catalogSemantics.requiredMeasurementKinds[index],
        )
      ) {
        const ruleIndex = configuration.pricing.serviceRules.indexOf(rule);
        context.addIssue({
          code: 'custom',
          path: ['pricing', 'serviceRules', ruleIndex],
          message: `Enabled service ${enabledServiceCode} must exactly match its catalog pricing unit and primary-first measurement semantics.`,
        });
      }
    }
    const packageSignatures = configuration.pricing.packages.map((servicePackage) =>
      JSON.stringify(
        [...servicePackage.components]
          .sort((left, right) => left.serviceCode.localeCompare(right.serviceCode))
          .map((component) => ({
            serviceCode: component.serviceCode,
            required: component.required,
            requiredAddOnCodes: [...component.requiredAddOnCodes].sort(),
            optionalAddOnCodes: [...component.optionalAddOnCodes].sort(),
          })),
      ),
    );
    if (new Set(packageSignatures).size !== packageSignatures.length) {
      context.addIssue({
        code: 'custom',
        path: ['pricing', 'packages'],
        message:
          'Good, better, and best must have distinct exact package scopes; rename and define an explicit custom package instead of publishing cosmetic tiers.',
      });
    }
    for (const [packageIndex, servicePackage] of configuration.pricing.packages.entries()) {
      const componentServices = servicePackage.components.map((component) => component.serviceCode);
      if (new Set(componentServices).size !== componentServices.length) {
        context.addIssue({
          code: 'custom',
          path: ['pricing', 'packages', packageIndex, 'components'],
          message: 'A service may appear only once in a package.',
        });
      }
      for (const [componentIndex, component] of servicePackage.components.entries()) {
        if (!enabledServices.has(component.serviceCode)) {
          context.addIssue({
            code: 'custom',
            path: [
              'pricing',
              'packages',
              packageIndex,
              'components',
              componentIndex,
              'serviceCode',
            ],
            message: 'Package components must reference enabled services.',
          });
          continue;
        }
        const rule = ruleByService.get(component.serviceCode);
        if (!rule) continue;
        const knownAddOns = new Set(rule.addOns.map((addOn) => addOn.code));
        const referencedAddOns = [...component.requiredAddOnCodes, ...component.optionalAddOnCodes];
        if (
          new Set(referencedAddOns).size !== referencedAddOns.length ||
          referencedAddOns.some((code) => !knownAddOns.has(code))
        ) {
          context.addIssue({
            code: 'custom',
            path: ['pricing', 'packages', packageIndex, 'components', componentIndex],
            message: 'Package add-ons must be unique and resolve to the configured service rule.',
          });
        }
      }
    }
  });

export type CompanyConfigurationInput = z.input<typeof companyConfigurationInputSchema>;
export type CompanyConfiguration = z.output<typeof companyConfigurationInputSchema>;

export const companyConfigurationRecordSchema = z
  .object({
    schemaVersion: z.literal('storyops-company-config-record-v1'),
    status: z.enum(['draft', 'review_required', 'published']),
    revision: z.number().int().nonnegative(),
    draft: companyConfigurationInputSchema,
    published: companyConfigurationInputSchema.optional(),
    updatedAt: z.string().datetime({ offset: true }),
    publishedAt: z.string().datetime({ offset: true }).optional(),
    publicationMode: z.enum(['sandbox', 'live']).optional(),
    publicationReceipt: z
      .object({
        commandId: z.string().uuid(),
        configurationHash: z.string().regex(/^[a-f0-9]{64}$/u),
        reviewReference: z.string().min(5).max(240),
        replayed: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.status === 'published' &&
      (!record.published ||
        !record.publishedAt ||
        !record.publicationMode ||
        !record.publicationReceipt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Published configuration records require a snapshot and publication receipt.',
      });
    }
  });

export type CompanyConfigurationRecord = z.output<typeof companyConfigurationRecordSchema>;

export interface CompanyConfigurationIssue {
  section: CompanyConfigurationSection;
  code: string;
  message: string;
  severity: 'blocking' | 'warning';
}

export interface CompanyConfigurationReadiness {
  completeSections: CompanyConfigurationSection[];
  blockedSections: CompanyConfigurationSection[];
  issues: CompanyConfigurationIssue[];
  score: number;
  publishable: boolean;
}

const providerNames = [
  'openai',
  'twilio',
  'email',
  'stripe',
  'google_calendar',
  'maps',
  'nws',
  'vroom',
  'storage',
  'quickbooks_export',
] as const;

const allProviders: CompanyConfiguration['integrations']['providers'] = providerNames.map(
  (provider) => ({
    provider,
    requestedMode: 'sandbox',
    environmentEnabled: false,
    ownerEnabled: false,
    health: 'not_checked',
  }),
);

export function createExteriorServicesConfiguration(input: {
  legalName: string;
  displayName?: string;
  ownerName: string;
  publicEmail: string;
  publicPhone: string;
  addressLine1: string;
  city: string;
  region?: string;
  postalCode: string;
  enabledServiceCodes: string[];
  serviceRules: CompanyConfiguration['pricing']['serviceRules'];
  packages: CompanyConfiguration['pricing']['packages'];
  priceBookTemplateVersion?: string;
  starterEquipmentType?: string;
  starterSkills?: readonly string[];
}): CompanyConfiguration {
  const starterEquipmentType = input.starterEquipmentType ?? 'pressure-washer';
  return companyConfigurationInputSchema.parse({
    schemaVersion: COMPANY_CONFIGURATION_SCHEMA_VERSION,
    identity: {
      legalName: input.legalName,
      displayName: input.displayName ?? input.legalName,
      ownerName: input.ownerName,
      publicEmail: input.publicEmail,
      publicPhone: input.publicPhone,
      website: '',
      brand: {
        primaryColor: '#174f46',
        accentColor: '#d99545',
        logoUrl: '',
      },
    },
    territory: {
      serviceAddress: {
        line1: input.addressLine1,
        line2: '',
        city: input.city,
        region: input.region ?? 'TX',
        postalCode: input.postalCode,
        country: 'US',
      },
      timezone: 'America/Chicago',
      serviceAreaNote: 'DFW residential properties within the reviewed travel-zone boundaries.',
      travelZones: [
        {
          code: 'DFW-A',
          name: 'Home ZIP service zone',
          maximumMiles: '',
          fee: '0',
          postalCodes: [input.postalCode.slice(0, 5)],
        },
      ],
      travelZoneMappingReview: {
        status: 'required',
        reviewer: '',
        reviewedAt: '',
        evidenceReference: '',
      },
    },
    schedule: {
      businessHours: [
        { day: 'monday', closed: false, opensAt: '08:00', closesAt: '17:00' },
        { day: 'tuesday', closed: false, opensAt: '08:00', closesAt: '17:00' },
        { day: 'wednesday', closed: false, opensAt: '08:00', closesAt: '17:00' },
        { day: 'thursday', closed: false, opensAt: '08:00', closesAt: '17:00' },
        { day: 'friday', closed: false, opensAt: '08:00', closesAt: '17:00' },
        { day: 'saturday', closed: false, opensAt: '09:00', closesAt: '14:00' },
        { day: 'sunday', closed: true, opensAt: '09:00', closesAt: '14:00' },
      ],
      appointmentBufferMinutes: 30,
      minimumLeadTimeHours: 24,
      maximumBookingDays: 60,
    },
    pricing: {
      currency: 'USD',
      companyMinimum: '225',
      defaultTaxRatePercent: '8.2500',
      taxEnabled: true,
      marginFloorPercent: '42',
      automaticDiscountLimitPercent: '10',
      priceBookTemplateVersion: input.priceBookTemplateVersion ?? 'storyops-exterior-dfw-v1.1.0',
      enabledServiceCodes: input.enabledServiceCodes,
      serviceRules: input.serviceRules,
      packages: input.packages,
      taxReview: {
        status: 'required',
        reviewer: '',
        reviewedAt: '',
        evidenceReference: '',
      },
    },
    people: {
      crewMembers: [
        {
          id: 'owner-crew',
          name: input.ownerName,
          role: 'owner',
          skills: input.starterSkills ?? ['scope-verification', 'exterior-cleaning'],
          active: true,
        },
      ],
    },
    resources: {
      vehicles: [
        {
          id: 'service-vehicle-1',
          name: 'Primary service vehicle',
          kind: 'truck',
          capacityNote: 'Owner-confirmed capacity required before live dispatch.',
          active: true,
        },
      ],
      equipment: [
        {
          id: `${starterEquipmentType}-1`,
          name: `Primary ${starterEquipmentType.replaceAll('-', ' ')}`,
          equipmentType: starterEquipmentType,
          quantity: 1,
          inspectionStatus: 'due',
          active: true,
        },
      ],
    },
    materials: {
      catalog: [
        {
          id: 'water',
          name: 'Water',
          unit: 'gallon',
          requiresSds: false,
          sdsStatus: 'not_required',
          sdsReference: '',
          sdsChecksumSha256: '',
        },
      ],
    },
    payments: {
      acceptedMethods: ['card', 'ach', 'check'],
      depositKind: 'percent',
      depositValue: '25',
      refundsRequireApproval: true,
    },
    policies: {
      cancellationHours: 24,
      cancellationFee: '75',
      rescheduleHours: 24,
      termsText:
        'UNAPPROVED STARTER DRAFT. Service is limited to the accepted written scope. Access, water, hazards, weather, cancellation, damage documentation, payment, and stop-work terms require qualified legal and insurance review before live customer use.',
      retentionDays: {
        operational: 1095,
        communications: 730,
        aiTraces: 90,
        audit: 2555,
        safety: 1460,
      },
      legalReview: {
        status: 'required',
        reviewer: '',
        reviewedAt: '',
        evidenceReference: '',
      },
      privacyReview: {
        status: 'required',
        reviewer: '',
        reviewedAt: '',
        evidenceReference: '',
      },
      safetyReview: {
        status: 'required',
        reviewer: '',
        reviewedAt: '',
        evidenceReference: '',
      },
      insuranceReview: {
        status: 'required',
        reviewer: '',
        reviewedAt: '',
        evidenceReference: '',
      },
      environmentalReview: {
        status: 'required',
        reviewer: '',
        reviewedAt: '',
        evidenceReference: '',
      },
    },
    engagement: {
      reviewRequestEnabled: true,
      reviewDelayHours: 24,
      reviewUrl: '',
      referralEnabled: false,
      referralRewardDescription: '',
      recurringMaintenanceEnabled: true,
    },
    integrations: { providers: allProviders },
  });
}

export const createServiceCompanyConfiguration = createExteriorServicesConfiguration;

export function parseCompanyConfiguration(input: unknown): CompanyConfiguration {
  return companyConfigurationInputSchema.parse(input);
}

export function assessCompanyConfiguration(
  input: unknown,
  publicationMode: CompanyConfigurationPublicationMode,
): CompanyConfigurationReadiness {
  const parsed = companyConfigurationInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues: CompanyConfigurationIssue[] = parsed.error.issues.map((issue) => {
      const firstPath = String(issue.path[0] ?? 'identity');
      const section = companyConfigurationSections.includes(
        firstPath as CompanyConfigurationSection,
      )
        ? (firstPath as CompanyConfigurationSection)
        : 'identity';
      return {
        section,
        code: 'schema_invalid',
        message: `${issue.path.join('.') || 'configuration'}: ${issue.message}`,
        severity: 'blocking',
      };
    });
    const blockedSections = [...new Set(issues.map((issue) => issue.section))];
    return {
      completeSections: companyConfigurationSections.filter(
        (section) => !blockedSections.includes(section),
      ),
      blockedSections,
      issues,
      score: Math.round(
        ((companyConfigurationSections.length - blockedSections.length) /
          companyConfigurationSections.length) *
          100,
      ),
      publishable: false,
    };
  }

  const configuration = parsed.data;
  const issues: CompanyConfigurationIssue[] = [];
  const add = (
    section: CompanyConfigurationSection,
    code: string,
    message: string,
    severity: CompanyConfigurationIssue['severity'] = 'blocking',
  ) => issues.push({ section, code, message, severity });

  if (configuration.schedule.businessHours.every((entry) => entry.closed)) {
    add('schedule', 'no_business_hours', 'At least one business day must be open.');
  }
  const ruleCodes = new Set(configuration.pricing.serviceRules.map((rule) => rule.serviceCode));
  const missingRules = configuration.pricing.enabledServiceCodes.filter(
    (code) => !ruleCodes.has(code),
  );
  if (missingRules.length > 0) {
    add(
      'pricing',
      'enabled_service_rule_missing',
      `Enabled services lack deterministic rules: ${missingRules.join(', ')}.`,
    );
  }
  const packageTiers = new Set(
    configuration.pricing.packages.map((servicePackage) => servicePackage.tier),
  );
  if (!(['good', 'better', 'best'] as const).every((tier) => packageTiers.has(tier))) {
    add(
      'pricing',
      'package_tiers_incomplete',
      'Good, better, and best package definitions are all required.',
    );
  }
  for (const servicePackage of configuration.pricing.packages) {
    for (const component of servicePackage.components) {
      const rule = configuration.pricing.serviceRules.find(
        (candidate) => candidate.serviceCode === component.serviceCode,
      );
      if (!rule) {
        add(
          'pricing',
          'package_service_rule_missing',
          `${servicePackage.name} references service ${component.serviceCode} without a deterministic rule.`,
        );
        continue;
      }
      const addOnCodes = new Set(rule.addOns.map((addOn) => addOn.code));
      const missingAddOns = [
        ...component.requiredAddOnCodes,
        ...component.optionalAddOnCodes,
      ].filter((code) => !addOnCodes.has(code));
      if (missingAddOns.length > 0) {
        add(
          'pricing',
          'package_add_on_rule_missing',
          `${servicePackage.name} references unavailable add-ons: ${missingAddOns.join(', ')}.`,
        );
      }
    }
  }
  if (!configuration.people.crewMembers.some((member) => member.active)) {
    add('people', 'no_active_crew', 'At least one active crew member is required.');
  }
  const activeOwner = configuration.people.crewMembers.find(
    (member) => member.active && member.role === 'owner',
  );
  const operationalRequirements = getIndustryPackServiceRequirements(
    configuration.pricing.enabledServiceCodes,
    undefined,
    configuration.pricing.priceBookTemplateVersion,
  );
  const activeOwnerSkills = new Set(activeOwner?.skills ?? []);
  const missingOwnerSkills = operationalRequirements.requiredSkills.filter(
    (skill) => !activeOwnerSkills.has(skill),
  );
  if (missingOwnerSkills.length > 0) {
    add(
      'people',
      'service_skill_coverage_missing',
      `The active configured owner is missing enabled-service skills: ${missingOwnerSkills.join(', ')}.`,
    );
  }
  if (!configuration.resources.vehicles.some((vehicle) => vehicle.active)) {
    add('resources', 'no_active_vehicle', 'At least one active service vehicle is required.');
  }
  if (
    !configuration.resources.equipment.some(
      (equipment) => equipment.active && equipment.inspectionStatus === 'current',
    )
  ) {
    add(
      'resources',
      'no_inspected_equipment',
      'At least one active item of equipment must have a current inspection.',
    );
  }
  const missingEquipmentTypes = operationalRequirements.requiredEquipmentTypes.filter(
    (equipmentType) =>
      !configuration.resources.equipment.some(
        (equipment) =>
          equipment.active &&
          equipment.inspectionStatus === 'current' &&
          equipment.equipmentType === equipmentType,
      ),
  );
  if (missingEquipmentTypes.length > 0) {
    add(
      'resources',
      'service_equipment_coverage_missing',
      `Current active equipment is missing enabled-service requirements: ${missingEquipmentTypes.join(', ')}.`,
    );
  }
  for (const material of configuration.materials.catalog) {
    if (material.requiresSds && material.sdsStatus !== 'approved') {
      add(
        'materials',
        'sds_not_approved',
        `${material.name} requires an approved SDS record before live work.`,
        publicationMode === 'live' ? 'blocking' : 'warning',
      );
    }
  }
  const chemicalServiceEnabled = configuration.pricing.enabledServiceCodes.some((code) =>
    ['soft-wash-house', 'roof-washing'].includes(code),
  );
  if (
    chemicalServiceEnabled &&
    !configuration.materials.catalog.some((material) => material.requiresSds)
  ) {
    add(
      'materials',
      'chemical_material_missing',
      'Enabled soft-wash services require an owner-configured chemical material and SDS record; WashOps cannot infer one.',
      publicationMode === 'live' ? 'blocking' : 'warning',
    );
  }
  if (configuration.engagement.reviewRequestEnabled && !configuration.engagement.reviewUrl) {
    add(
      'engagement',
      'review_url_missing',
      'Review requests are enabled but no HTTPS review destination is configured.',
      'warning',
    );
  }
  if (
    configuration.engagement.referralEnabled &&
    !configuration.engagement.referralRewardDescription
  ) {
    add(
      'engagement',
      'referral_terms_missing',
      'Referral enablement requires a clear reward or no-reward description.',
    );
  }
  if (publicationMode === 'live') {
    const reviews: Array<
      [CompanyConfigurationSection, string, CompanyConfiguration['policies']['legalReview']]
    > = [
      [
        'territory',
        'travel_zone_mapping_review_required',
        configuration.territory.travelZoneMappingReview,
      ],
      ['pricing', 'tax_review_required', configuration.pricing.taxReview],
      ['policies', 'legal_review_required', configuration.policies.legalReview],
      ['policies', 'privacy_review_required', configuration.policies.privacyReview],
      ['policies', 'safety_review_required', configuration.policies.safetyReview],
      ['policies', 'insurance_review_required', configuration.policies.insuranceReview],
      ['policies', 'environmental_review_required', configuration.policies.environmentalReview],
    ];
    for (const [section, code, review] of reviews) {
      if (review.status !== 'approved') {
        add(section, code, 'Qualified review evidence is required for live publication.');
      }
    }
  }

  for (const provider of configuration.integrations.providers) {
    if (provider.requestedMode === 'live') {
      if (!provider.environmentEnabled || !provider.ownerEnabled || provider.health !== 'healthy') {
        add(
          'integrations',
          'live_provider_not_ready',
          `${provider.provider} remains blocked: environment switch, owner switch, and healthy evidence are all required.`,
        );
      }
    }
  }

  const blockedSections = [
    ...new Set(
      issues.filter((issue) => issue.severity === 'blocking').map((issue) => issue.section),
    ),
  ];
  const completeSections = companyConfigurationSections.filter(
    (section) => !blockedSections.includes(section),
  );
  return {
    completeSections,
    blockedSections,
    issues,
    score: Math.round((completeSections.length / companyConfigurationSections.length) * 100),
    publishable: blockedSections.length === 0,
  };
}

export async function hashCompanyConfiguration(
  configuration: CompanyConfiguration,
): Promise<string> {
  const canonical = canonicalize(configuration);
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical))),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}
