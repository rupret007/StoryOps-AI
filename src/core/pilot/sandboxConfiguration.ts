import {
  assessCompanyConfiguration,
  parseCompanyConfiguration,
  type CompanyConfiguration,
} from '@/domain/companyConfiguration';
import { getIndustryPackServiceRequirements } from '@/domain/industryPackRequirements';
import type { DemoState } from '@/state/model';

type SandboxConfigurationState = Pick<
  DemoState,
  'dataMode' | 'setupComplete' | 'setupProfile' | 'companyConfiguration'
>;

/**
 * Adds visibly synthetic people/resource evidence to the local-only owner draft.
 * This is never called for an authenticated workspace and cannot authorize live work.
 */
export function prepareSandboxRehearsalConfiguration(
  configuration: CompanyConfiguration,
): CompanyConfiguration {
  const next = structuredClone(configuration);
  const requirements = getIndustryPackServiceRequirements(
    next.pricing.enabledServiceCodes,
    undefined,
    next.pricing.priceBookTemplateVersion,
  );
  const owner = next.people.crewMembers.find((member) => member.active && member.role === 'owner');
  if (owner) {
    owner.skills = [...new Set([...owner.skills, ...requirements.requiredSkills])];
  }
  for (const equipmentType of requirements.requiredEquipmentTypes) {
    const current = next.resources.equipment.find(
      (equipment) =>
        equipment.active &&
        equipment.inspectionStatus === 'current' &&
        equipment.equipmentType === equipmentType,
    );
    if (current) continue;
    next.resources.equipment.push({
      id: `sandbox-rehearsal-${equipmentType}`,
      name: `Synthetic rehearsal ${equipmentType}`,
      equipmentType,
      quantity: 1,
      inspectionStatus: 'current',
      active: true,
    });
  }
  return parseCompanyConfiguration(next);
}

/**
 * Returns a human-readable fail-closed reason when a local golden-path action
 * is not bound to the exact setup-selected, explicitly published snapshot.
 */
export function sandboxGoldenPathConfigurationIssue(
  state: SandboxConfigurationState,
  requiredServiceCodes: readonly string[] = [],
): string | undefined {
  if (state.dataMode !== 'sandbox') return undefined;
  if (!state.setupComplete || !state.setupProfile) {
    return 'Complete the local sandbox profile before running golden-path fixtures.';
  }
  const record = state.companyConfiguration;
  if (
    !record ||
    record.status !== 'published' ||
    record.publicationMode !== 'sandbox' ||
    !record.published ||
    !record.publicationReceipt
  ) {
    return 'Publish the exact sandbox company configuration before running this downstream fixture.';
  }
  const readiness = assessCompanyConfiguration(record.published, 'sandbox');
  if (!readiness.publishable) {
    return 'The published sandbox configuration no longer passes deterministic readiness checks.';
  }
  const selected = [...state.setupProfile.enabledServiceCodes].sort();
  const published = [...record.published.pricing.enabledServiceCodes].sort();
  if (
    selected.length !== published.length ||
    selected.some((serviceCode, index) => serviceCode !== published[index])
  ) {
    return 'The published catalog does not exactly match the services selected in the sandbox profile. Save and publish a matching revision.';
  }
  const missing = requiredServiceCodes.filter((serviceCode) => !published.includes(serviceCode));
  if (missing.length > 0) {
    return `This synthetic pilot fixture requires published catalog entries for ${missing.join(', ')}.`;
  }
  return undefined;
}
