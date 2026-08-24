import { describe, expect, it } from 'vitest';
import {
  prepareSandboxRehearsalConfiguration,
  sandboxGoldenPathConfigurationIssue,
} from '@/core/pilot/sandboxConfiguration';
import {
  assessCompanyConfiguration,
  createExteriorServicesConfiguration,
} from '@/domain/companyConfiguration';
import { createExteriorConfigurationPricing } from '@/data/exteriorServiceTemplates';
import { createDemoState } from '@/state/demoSeed';

const enabledServiceCodes = ['pressure-wash-flatwork', 'gutter-cleaning'] as const;

function configuration() {
  return createExteriorServicesConfiguration({
    legalName: 'Story Exterior Care',
    ownerName: 'Jeff Story',
    publicEmail: 'owner@example.test',
    publicPhone: '+18175550100',
    addressLine1: '100 Sandbox Service Road',
    city: 'Grapevine',
    postalCode: '76051',
    enabledServiceCodes: [...enabledServiceCodes],
    ...createExteriorConfigurationPricing(enabledServiceCodes),
  });
}

describe('sandbox company configuration prerequisite', () => {
  it('creates explicit local-only resource fixtures without mutating the review draft input', () => {
    const draft = configuration();
    const prepared = prepareSandboxRehearsalConfiguration(draft);

    expect(assessCompanyConfiguration(draft, 'sandbox').publishable).toBe(false);
    expect(assessCompanyConfiguration(prepared, 'sandbox').publishable).toBe(true);
    expect(
      prepared.resources.equipment.filter((equipment) =>
        equipment.name.startsWith('Synthetic rehearsal'),
      ),
    ).not.toHaveLength(0);
  });

  it('fails closed until the exact setup-selected catalog has a publication receipt', () => {
    const state = createDemoState();
    state.setupComplete = true;
    state.setupProfile = {
      businessName: 'Story Exterior Care',
      ownerName: 'Jeff Story',
      homePostalCode: '76051',
      timezone: 'America/Chicago',
      enabledServiceCodes: [...enabledServiceCodes],
      policyAcknowledged: true,
      configuredAt: '2026-07-28T12:00:00.000Z',
    };

    expect(sandboxGoldenPathConfigurationIssue(state)).toMatch(/Publish the exact/u);

    const published = prepareSandboxRehearsalConfiguration(configuration());
    state.companyConfiguration = {
      schemaVersion: 'storyops-company-config-record-v1',
      status: 'published',
      revision: 1,
      draft: published,
      published,
      updatedAt: '2026-07-28T12:00:00.000Z',
      publishedAt: '2026-07-28T12:00:00.000Z',
      publicationMode: 'sandbox',
      publicationReceipt: {
        commandId: '99000000-0000-4000-8000-000000000001',
        configurationHash: '9'.repeat(64),
        reviewReference: 'sandbox-review-v1',
        replayed: false,
      },
    };

    expect(sandboxGoldenPathConfigurationIssue(state, enabledServiceCodes)).toBeUndefined();
    expect(sandboxGoldenPathConfigurationIssue(state, ['roof-washing'])).toMatch(
      /published catalog entries for roof-washing/u,
    );
    state.setupProfile!.enabledServiceCodes = ['gutter-cleaning'];
    expect(sandboxGoldenPathConfigurationIssue(state)).toMatch(/does not exactly match/u);
  });
});
