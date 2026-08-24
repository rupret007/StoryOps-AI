import { describe, expect, it } from 'vitest';
import { prepareSandboxRehearsalConfiguration } from '@/core/pilot/sandboxConfiguration';
import {
  getCanonicalPricingConfiguration,
  getIndustryPackRuntimeForCode,
  getIndustryPackRuntimeForInput,
} from '@/data/industryPackRuntime';
import { RESIDENTIAL_SERVICE_CODES } from '@/data/residentialServiceTemplates';
import {
  assessCompanyConfiguration,
  createExteriorServicesConfiguration,
} from '@/domain/companyConfiguration';
import {
  assertAllEnabledServicesArePackBound,
  getIndustryPackServiceRequirements,
  resolveIndustryPack,
} from '@/domain/industryPackRequirements';

describe('industry-pack runtime and readiness', () => {
  it('resolves only complete, internally consistent pack selections', () => {
    expect(resolveIndustryPack({ enabledServiceCodes: RESIDENTIAL_SERVICE_CODES })?.code).toBe(
      'residential-cleaning',
    );
    expect(
      resolveIndustryPack({
        enabledServiceCodes: ['standard-recurring-clean', 'gutter-cleaning'],
      }),
    ).toBeUndefined();
    expect(
      resolveIndustryPack({
        enabledServiceCodes: RESIDENTIAL_SERVICE_CODES,
        priceBookTemplateVersion: 'storyops-exterior-dfw-v1.1.0',
      }),
    ).toBeUndefined();
    expect(
      assertAllEnabledServicesArePackBound(
        RESIDENTIAL_SERVICE_CODES,
        undefined,
        'storyops-residential-cleaning-v1.0.0',
      ),
    ).toBe(true);
  });

  it('exposes residential pricing through the same selected runtime as readiness', () => {
    const runtime = getIndustryPackRuntimeForCode('residential-cleaning');
    expect(runtime).toBeDefined();
    if (!runtime) throw new Error('Expected the residential runtime.');

    const pricing = getCanonicalPricingConfiguration(runtime, RESIDENTIAL_SERVICE_CODES);
    const requirements = getIndustryPackServiceRequirements(
      RESIDENTIAL_SERVICE_CODES,
      undefined,
      runtime.packVersion,
    );

    expect(pricing.packages.map((servicePackage) => servicePackage.tier)).toEqual([
      'good',
      'better',
      'best',
    ]);
    expect(requirements.requiredSkills).toContain('home-cleaning');
    expect(requirements.requiredEquipmentTypes).toContain('vacuum');
    expect(
      getIndustryPackRuntimeForInput({
        enabledServiceCodes: RESIDENTIAL_SERVICE_CODES,
        priceBookTemplateVersion: runtime.packVersion,
      })?.packCode,
    ).toBe('residential-cleaning');
    expect(() => runtime.buildPackages(['standard-recurring-clean', 'gutter-cleaning'])).toThrow(
      /does not contain/u,
    );
  });

  it('creates a residential draft that becomes sandbox-publishable only after pack requirements are prepared', () => {
    const runtime = getIndustryPackRuntimeForCode('residential-cleaning');
    if (!runtime) throw new Error('Expected the residential runtime.');
    const draft = createExteriorServicesConfiguration({
      legalName: 'Story Home Care LLC',
      ownerName: 'Home Care Owner',
      publicEmail: 'owner@example.test',
      publicPhone: '+18175550100',
      addressLine1: '100 Sandbox Service Road',
      city: 'Grapevine',
      postalCode: '76051',
      enabledServiceCodes: [...RESIDENTIAL_SERVICE_CODES],
      priceBookTemplateVersion: runtime.packVersion,
      starterEquipmentType: runtime.starterEquipmentType,
      starterSkills: runtime.starterSkills,
      ...getCanonicalPricingConfiguration(runtime, RESIDENTIAL_SERVICE_CODES),
    });

    expect(assessCompanyConfiguration(draft, 'sandbox').publishable).toBe(false);
    expect(draft.people.crewMembers[0]?.skills).not.toContain('exterior-cleaning');
    const prepared = prepareSandboxRehearsalConfiguration(draft);
    expect(assessCompanyConfiguration(prepared, 'sandbox').publishable).toBe(true);
    expect(prepared.people.crewMembers[0]?.skills).toContain('home-cleaning');
    expect(
      prepared.resources.equipment.some(
        (equipment) =>
          equipment.equipmentType === 'vacuum' && equipment.inspectionStatus === 'current',
      ),
    ).toBe(true);
  });
});
