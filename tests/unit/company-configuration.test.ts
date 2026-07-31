import { describe, expect, it } from 'vitest';
import {
  assessCompanyConfiguration,
  companyConfigurationInputSchema,
  companyConfigurationRecordSchema,
  createExteriorServicesConfiguration,
  hashCompanyConfiguration,
} from '@/domain/companyConfiguration';
import {
  assertConfigurationPublishable,
  buildCompanyConfigurationCommand,
} from '@/state/companyConfiguration';
import {
  createExteriorConfigurationPricing,
  exteriorServiceTemplates,
} from '@/data/exteriorServiceTemplates';
import {
  exteriorServiceOperationalRequirements,
  exteriorServicePricingSemantics,
  getExteriorConfigurationRequirements,
} from '@/domain/exteriorServiceRequirements';
import {
  buildOperatingBaselineCommand,
  operatingBaselineReceiptSchema,
} from '@/state/operatingBaseline';

const enabledServiceCodes = ['pressure-wash-flatwork', 'gutter-cleaning'] as const;

const identity = {
  legalName: 'North Texas Exterior Care LLC',
  ownerName: 'Dana Owner',
  publicEmail: 'owner@example.test',
  publicPhone: '+18175550123',
  addressLine1: '100 Main Street',
  city: 'Grapevine',
  postalCode: '76051',
  enabledServiceCodes: [...enabledServiceCodes],
  ...createExteriorConfigurationPricing(enabledServiceCodes),
};

function addRequiredOwnerCapabilities(
  configuration: ReturnType<typeof createExteriorServicesConfiguration>,
) {
  const requirements = getExteriorConfigurationRequirements(
    configuration.pricing.enabledServiceCodes,
  );
  const owner = configuration.people.crewMembers.find(
    (member) => member.active && member.role === 'owner',
  );
  if (!owner) throw new Error('Expected one active owner fixture.');
  owner.skills = [...new Set([...owner.skills, ...requirements.requiredSkills])];
  for (const equipmentType of requirements.requiredEquipmentTypes) {
    const existing = configuration.resources.equipment.find(
      (equipment) => equipment.equipmentType === equipmentType,
    );
    if (existing) {
      existing.active = true;
      existing.inspectionStatus = 'current';
      continue;
    }
    configuration.resources.equipment.push({
      id: `${equipmentType}-fixture`,
      name: `${equipmentType.replaceAll('-', ' ')} fixture`,
      equipmentType,
      quantity: 1,
      inspectionStatus: 'current',
      active: true,
    });
  }
}

function reviewedConfiguration() {
  const configuration = createExteriorServicesConfiguration(identity);
  addRequiredOwnerCapabilities(configuration);
  const reviewedAt = '2026-07-29T12:00:00.000Z';
  configuration.territory.travelZoneMappingReview = {
    status: 'approved',
    reviewer: 'Owner territory reviewer',
    reviewedAt,
    evidenceReference: 'territory-mapping-review-2026-07',
  };
  configuration.pricing.taxReview = {
    status: 'approved',
    reviewer: 'Texas tax professional',
    reviewedAt,
    evidenceReference: 'tax-review-2026-07',
  };
  configuration.policies.legalReview = {
    status: 'approved',
    reviewer: 'Qualified counsel',
    reviewedAt,
    evidenceReference: 'terms-review-2026-07',
  };
  configuration.policies.privacyReview = {
    status: 'approved',
    reviewer: 'Qualified privacy reviewer',
    reviewedAt,
    evidenceReference: 'privacy-review-2026-07',
  };
  configuration.policies.safetyReview = {
    status: 'approved',
    reviewer: 'Qualified safety reviewer',
    reviewedAt,
    evidenceReference: 'safety-review-2026-07',
  };
  configuration.policies.insuranceReview = {
    status: 'approved',
    reviewer: 'Qualified insurance reviewer',
    reviewedAt,
    evidenceReference: 'insurance-review-2026-07',
  };
  configuration.policies.environmentalReview = {
    status: 'approved',
    reviewer: 'Qualified environmental reviewer',
    reviewedAt,
    evidenceReference: 'environmental-review-2026-07',
  };
  return configuration;
}

describe('company configuration contract', () => {
  it('creates every required reusable service-business section with normalized decimals', () => {
    const configuration = createExteriorServicesConfiguration(identity);

    expect(companyConfigurationInputSchema.parse(configuration)).toMatchObject({
      schemaVersion: 'storyops-company-config-v1',
      pricing: {
        companyMinimum: '225.00',
        defaultTaxRatePercent: '8.2500',
        marginFloorPercent: '42.00',
        automaticDiscountLimitPercent: '10.00',
        priceBookTemplateVersion: 'storyops-exterior-dfw-v1.1.0',
      },
      payments: { depositKind: 'percent', depositValue: '25.00' },
      territory: {
        travelZones: [
          {
            code: 'DFW-A',
            maximumMiles: '',
            postalCodes: ['76051'],
          },
        ],
      },
    });
    expect(Object.keys(configuration)).toEqual([
      'schemaVersion',
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
    ]);
    expect(
      configuration.pricing.packages.every((servicePackage) =>
        servicePackage.components.every((component) =>
          enabledServiceCodes.includes(
            component.serviceCode as (typeof enabledServiceCodes)[number],
          ),
        ),
      ),
    ).toBe(true);
  });

  it('keeps client capability gates exactly aligned with every starter catalog item', () => {
    for (const template of exteriorServiceTemplates) {
      expect(
        exteriorServiceOperationalRequirements[
          template.catalogItem.code as keyof typeof exteriorServiceOperationalRequirements
        ],
      ).toEqual({
        requiredSkills: template.catalogItem.requiredSkills,
        requiredEquipmentTypes: template.catalogItem.requiredEquipmentTypes,
      });
      expect(exteriorServicePricingSemantics[template.catalogItem.code]).toEqual({
        pricingUnit: template.priceRule.pricingUnit,
        requiredMeasurementKinds: template.catalogItem.requiredMeasurementKinds,
      });
    }
  });

  it('rejects catalog-unit drift and every non-total multiplier matrix', () => {
    const cases: Array<{
      name: string;
      mutate(configuration: ReturnType<typeof createExteriorServicesConfiguration>): void;
      message: RegExp;
    }> = [
      {
        name: 'configured unit differs from catalog',
        mutate(configuration) {
          configuration.pricing.serviceRules[0]!.pricingUnit = 'each';
        },
        message: /first required measurement kind must be count|catalog pricing unit/iu,
      },
      {
        name: 'configured unit and claimed kinds both differ from catalog',
        mutate(configuration) {
          configuration.pricing.serviceRules[0]!.pricingUnit = 'each';
          configuration.pricing.serviceRules[0]!.requiredMeasurementKinds = ['count'];
        },
        message: /exactly match its catalog pricing unit/iu,
      },
      {
        name: 'required measurement kind is duplicated',
        mutate(configuration) {
          configuration.pricing.serviceRules[0]!.requiredMeasurementKinds = [
            'area_sq_ft',
            'area_sq_ft',
          ];
        },
        message: /required measurement kinds must be unique/iu,
      },
      {
        name: 'allowed value lacks a multiplier',
        mutate(configuration) {
          configuration.pricing.serviceRules[0]!.attributeMultipliers =
            configuration.pricing.serviceRules[0]!.attributeMultipliers.slice(1);
        },
        message: /every allowed attribute value requires exactly one multiplier/iu,
      },
      {
        name: 'multiplier references an undeclared value',
        mutate(configuration) {
          configuration.pricing.serviceRules[0]!.attributeMultipliers.push({
            attribute: 'risk',
            value: 'invented',
            multiplier: '1.0000',
          });
        },
        message: /cannot reference undeclared attribute values/iu,
      },
      {
        name: 'allowed value is duplicated',
        mutate(configuration) {
          configuration.pricing.serviceRules[0]!.allowedAttributeValues.risk = [
            'standard',
            'standard',
            'elevated',
          ];
        },
        message: /allowed attribute values must be unique/iu,
      },
      {
        name: 'multiplier pair is duplicated',
        mutate(configuration) {
          configuration.pricing.serviceRules[0]!.attributeMultipliers.push({
            ...configuration.pricing.serviceRules[0]!.attributeMultipliers[0]!,
          });
        },
        message: /multiplier pairs must be unique/iu,
      },
    ];

    for (const testCase of cases) {
      const configuration = createExteriorServicesConfiguration(identity);
      testCase.mutate(configuration);
      const result = companyConfigurationInputSchema.safeParse(configuration);
      expect(result.success, testCase.name).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.message).join(' ')).toMatch(
          testCase.message,
        );
      }
    }
  });

  it('rejects reordered duplicate package scopes as cosmetic tiers', () => {
    const configuration = createExteriorServicesConfiguration(identity);
    const better = configuration.pricing.packages.find(
      (servicePackage) => servicePackage.tier === 'better',
    )!;
    const best = configuration.pricing.packages.find(
      (servicePackage) => servicePackage.tier === 'best',
    )!;
    best.components = structuredClone([...better.components].reverse());

    const result = companyConfigurationInputSchema.safeParse(configuration);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(' ')).toMatch(
        /distinct exact package scopes/iu,
      );
    }
  });

  it('requires exact active-owner skills and current equipment before review-only publication', () => {
    const configuration = createExteriorServicesConfiguration(identity);
    const sandboxBeforeInspection = assessCompanyConfiguration(configuration, 'sandbox');

    expect(sandboxBeforeInspection.publishable).toBe(false);
    expect(sandboxBeforeInspection.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'no_inspected_equipment', severity: 'blocking' }),
        expect.objectContaining({
          code: 'service_skill_coverage_missing',
          severity: 'blocking',
        }),
        expect.objectContaining({
          code: 'service_equipment_coverage_missing',
          severity: 'blocking',
        }),
      ]),
    );

    configuration.resources.equipment[0]!.inspectionStatus = 'current';
    expect(assessCompanyConfiguration(configuration, 'sandbox')).toMatchObject({
      publishable: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'service_skill_coverage_missing' }),
        expect.objectContaining({ code: 'service_equipment_coverage_missing' }),
      ]),
    });

    addRequiredOwnerCapabilities(configuration);
    const sandbox = assessCompanyConfiguration(configuration, 'sandbox');
    const live = assessCompanyConfiguration(configuration, 'live');

    expect(sandbox.publishable).toBe(true);
    expect(live.publishable).toBe(false);
    expect(live.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'travel_zone_mapping_review_required',
        'tax_review_required',
        'legal_review_required',
        'privacy_review_required',
        'safety_review_required',
        'insurance_review_required',
        'environmental_review_required',
      ]),
    );
  });

  it('does not let planning-personnel skills satisfy the active-owner gate', () => {
    const configuration = reviewedConfiguration();
    const owner = configuration.people.crewMembers.find((member) => member.role === 'owner')!;
    owner.skills = owner.skills.filter((skill) => skill !== 'ladder-safety');
    configuration.people.crewMembers.push({
      id: 'planned-ladder-technician',
      name: 'Planned Ladder Technician',
      role: 'technician',
      skills: ['ladder-safety'],
      active: true,
    });

    expect(assessCompanyConfiguration(configuration, 'live')).toMatchObject({
      publishable: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          section: 'people',
          code: 'service_skill_coverage_missing',
          message: expect.stringMatching(/ladder-safety/iu),
        }),
      ]),
    });
  });

  it('requires exactly one active owner while retaining other people as planning records', () => {
    const configuration = createExteriorServicesConfiguration(identity);
    configuration.people.crewMembers.push({
      id: 'planned-technician',
      name: 'Planned Technician',
      role: 'technician',
      skills: ['ladder-safety'],
      active: true,
    });
    expect(companyConfigurationInputSchema.safeParse(configuration).success).toBe(true);

    configuration.people.crewMembers[1]!.role = 'owner';
    expect(companyConfigurationInputSchema.safeParse(configuration)).toMatchObject({
      success: false,
    });
    expect(assessCompanyConfiguration(configuration, 'sandbox').issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'schema_invalid',
          message: expect.stringMatching(/exactly one active configured owner/iu),
        }),
      ]),
    );
  });

  it('requires exact, non-overlapping normalized ZIP mappings for deterministic travel fees', () => {
    const configuration = createExteriorServicesConfiguration(identity);
    configuration.territory.travelZones.push({
      code: 'DFW-B',
      name: 'Second reviewed zone',
      maximumMiles: '',
      fee: '35.00',
      postalCodes: ['76051'],
    });

    expect(companyConfigurationInputSchema.safeParse(configuration)).toMatchObject({
      success: false,
    });
    expect(
      assessCompanyConfiguration(configuration, 'sandbox').issues.map((issue) => issue.message),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/only one travel zone/iu)]));

    configuration.territory.travelZones[1]!.postalCodes = [];
    expect(companyConfigurationInputSchema.safeParse(configuration)).toMatchObject({
      success: false,
    });
  });

  it('requires an owner-configured chemical and SDS record when soft-wash work is enabled', () => {
    const configuration = reviewedConfiguration();
    configuration.pricing.enabledServiceCodes.push('soft-wash-house');

    expect(assessCompanyConfiguration(configuration, 'live').issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          section: 'materials',
          code: 'chemical_material_missing',
          severity: 'blocking',
        }),
      ]),
    );

    configuration.materials.catalog[0] = {
      id: 'reviewed-cleaner',
      name: 'Owner-selected reviewed cleaner',
      unit: 'gallon',
      requiresSds: true,
      sdsStatus: 'approved',
      sdsReference: 'https://example.test/sds/reviewed-cleaner.pdf',
      sdsChecksumSha256: 'a'.repeat(64),
    };
    addRequiredOwnerCapabilities(configuration);
    expect(assessCompanyConfiguration(configuration, 'live').publishable).toBe(true);
  });

  it('fails closed when a requested live provider lacks either switch or healthy evidence', () => {
    const configuration = reviewedConfiguration();
    const twilio = configuration.integrations.providers.find(
      (provider) => provider.provider === 'twilio',
    )!;
    twilio.requestedMode = 'live';
    twilio.ownerEnabled = true;
    twilio.environmentEnabled = false;
    twilio.health = 'healthy';

    expect(() => assertConfigurationPublishable(configuration, 'live')).toThrow(
      /environment switch, owner switch, and healthy evidence/iu,
    );

    twilio.environmentEnabled = true;
    expect(() => assertConfigurationPublishable(configuration, 'live')).not.toThrow();
  });

  it('derives stable exact-payload command IDs and hashes without accepting changed reuse', async () => {
    const configuration = reviewedConfiguration();
    const input = {
      companyId: '98000000-0000-4000-8000-000000000001',
      userId: '10000000-0000-4000-8000-000000000102',
      action: 'save' as const,
      expectedRevision: 0,
      configuration,
    };
    const first = await buildCompanyConfigurationCommand(input);
    const replay = await buildCompanyConfigurationCommand(structuredClone(input));
    const changed = structuredClone(input);
    changed.configuration.pricing.companyMinimum = '250.00';

    expect(replay).toEqual(first);
    await expect(buildCompanyConfigurationCommand(changed)).resolves.not.toEqual(first);
    await expect(hashCompanyConfiguration(configuration)).resolves.toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects forged publication state without an immutable receipt snapshot', () => {
    const configuration = reviewedConfiguration();
    expect(() =>
      companyConfigurationRecordSchema.parse({
        schemaVersion: 'storyops-company-config-record-v1',
        status: 'published',
        revision: 2,
        draft: configuration,
        updatedAt: '2026-07-29T12:00:00.000Z',
      }),
    ).toThrow(/Published configuration records require/iu);
  });

  it('builds a stable separate operating-baseline command and parses a truthful receipt', async () => {
    const input = {
      companyId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      configurationRevision: 3,
      reviewReference: 'owner-operating-review-2026-07',
    };
    const first = await buildOperatingBaselineCommand(input);
    const replay = await buildOperatingBaselineCommand({ ...input });
    expect(replay).toEqual(first);
    expect(first.requestHash).toMatch(/^[a-f0-9]{64}$/u);

    expect(
      operatingBaselineReceiptSchema.parse({
        schemaVersion: 'storyops-operating-baseline-receipt-v1',
        commandType: 'company.operating_baseline.publish',
        status: 'active',
        companyId: input.companyId,
        configurationRevision: input.configurationRevision,
        configurationHash: 'a'.repeat(64),
        baselineId: '33333333-3333-4333-8333-333333333333',
        baselineHash: 'b'.repeat(64),
        priceBookId: '44444444-4444-4444-8444-444444444444',
        priceBookVersion: 'config-r3-aaaaaaaaaaaa',
        serviceTermsId: '55555555-5555-4555-8555-555555555555',
        serviceTermsVersion: 'config-r3-aaaaaaaaaaaa',
        retentionPolicyId: '66666666-6666-4666-8666-666666666666',
        retentionPolicyVersion: 'config-r3-aaaaaaaaaaaa',
        serviceCount: 2,
        packageCount: 3,
        providersActivated: false,
        outboundEnabled: false,
        launchAuthorized: false,
        reviewReference: input.reviewReference,
        commandId: first.commandId,
        requestHash: first.requestHash,
        replayed: false,
        serverTime: '2026-07-29T12:00:00.000Z',
      }),
    ).toMatchObject({
      configurationRevision: 3,
      providersActivated: false,
      outboundEnabled: false,
    });
  });
});
