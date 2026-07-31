import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CompanyPanel, MoneyPanel, OperationsPanel } from '@/pages/CompanyConfigurationStudio';
import {
  companyConfigurationInputSchema,
  createExteriorServicesConfiguration,
  type CompanyConfiguration,
} from '@/domain/companyConfiguration';
import { createExteriorConfigurationPricing } from '@/data/exteriorServiceTemplates';

function ConfigurationEditorHarness({ panel }: { panel: 'company' | 'operations' | 'money' }) {
  const [draft, setDraft] = useState(() => {
    const configuration = createExteriorServicesConfiguration({
      legalName: 'North Texas Exterior Care LLC',
      ownerName: 'Dana Owner',
      publicEmail: 'owner@example.test',
      publicPhone: '+18175550123',
      addressLine1: '100 Main Street',
      city: 'Grapevine',
      postalCode: '76051',
      enabledServiceCodes: ['pressure-wash-flatwork', 'gutter-cleaning'],
      ...createExteriorConfigurationPricing(['pressure-wash-flatwork', 'gutter-cleaning']),
    });
    configuration.resources.equipment[0]!.inspectionStatus = 'current';
    return configuration;
  });
  const update = (mutate: (configuration: CompanyConfiguration) => void) =>
    setDraft((current) => {
      const next = structuredClone(current);
      mutate(next);
      return next;
    });

  return (
    <>
      {panel === 'company' ? <CompanyPanel draft={draft} update={update} /> : null}
      {panel === 'operations' ? <OperationsPanel draft={draft} update={update} /> : null}
      {panel === 'money' ? <MoneyPanel draft={draft} update={update} /> : null}
      <output data-testid="configuration-json">{JSON.stringify(draft)}</output>
    </>
  );
}

function currentConfiguration(): CompanyConfiguration {
  return JSON.parse(
    screen.getByTestId('configuration-json').textContent ?? '{}',
  ) as CompanyConfiguration;
}

describe('company configuration studio resource editor', () => {
  it('edits optional HTTPS branding', () => {
    render(<ConfigurationEditorHarness panel="company" />);
    fireEvent.change(screen.getByLabelText('Logo URL (optional HTTPS)'), {
      target: { value: 'https://example.test/brand/logo.svg' },
    });
    const configuration = currentConfiguration();
    expect(configuration.identity.brand.logoUrl).toBe('https://example.test/brand/logo.svg');
    expect(companyConfigurationInputSchema.safeParse(configuration).success).toBe(true);
  });

  it('manages crew, vehicles, equipment, and material/SDS records with stable identifiers', () => {
    render(<ConfigurationEditorHarness panel="operations" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add crew member' }));
    fireEvent.change(screen.getAllByLabelText('Crew member name')[1]!, {
      target: { value: 'Taylor Technician' },
    });
    fireEvent.change(screen.getAllByLabelText('Role')[1]!, {
      target: { value: 'technician' },
    });
    fireEvent.change(screen.getAllByLabelText('Skills (comma separated)')[1]!, {
      target: { value: 'gutter cleaning, route lead' },
    });
    expect(screen.getByText(/planning personnel cannot satisfy this gate/iu)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Add vehicle' }));
    fireEvent.change(screen.getAllByLabelText('Vehicle name')[1]!, {
      target: { value: 'Soft-wash van' },
    });
    fireEvent.change(screen.getAllByLabelText('Vehicle kind')[1]!, {
      target: { value: 'van' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add equipment' }));
    fireEvent.change(screen.getAllByLabelText('Equipment name')[1]!, {
      target: { value: 'Gutter vacuum' },
    });
    fireEvent.change(screen.getAllByLabelText('Quantity')[1]!, {
      target: { value: '2' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add material' }));
    fireEvent.change(screen.getAllByLabelText('Material name')[1]!, {
      target: { value: 'Owner-reviewed surfactant' },
    });
    fireEvent.click(screen.getAllByLabelText('Chemical material requires SDS')[1]!);

    const configuration = currentConfiguration();
    expect(configuration.people.crewMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'owner-crew',
          name: 'Dana Owner',
          role: 'owner',
        }),
        expect.objectContaining({
          id: 'crew-2',
          name: 'Taylor Technician',
          role: 'technician',
          skills: ['gutter-cleaning', 'route-lead'],
        }),
      ]),
    );
    expect(configuration.resources.vehicles[1]).toMatchObject({
      id: 'vehicle-2',
      name: 'Soft-wash van',
      kind: 'van',
    });
    expect(configuration.resources.equipment[1]).toMatchObject({
      id: 'equipment-2',
      name: 'Gutter vacuum',
      quantity: 2,
      inspectionStatus: 'due',
    });
    expect(configuration.materials.catalog[1]).toMatchObject({
      id: 'material-2',
      name: 'Owner-reviewed surfactant',
      requiresSds: true,
      sdsStatus: 'missing',
    });
    expect(companyConfigurationInputSchema.safeParse(configuration).success).toBe(true);
  });

  it('edits the tax policy', () => {
    render(<ConfigurationEditorHarness panel="money" />);
    fireEvent.click(screen.getByLabelText('Apply configured tax to taxable line items'));

    const configuration = currentConfiguration();
    expect(configuration.pricing.taxEnabled).toBe(false);
    expect(companyConfigurationInputSchema.safeParse(configuration).success).toBe(true);
  });

  it('atomically repairs package scopes when a service is disabled', () => {
    render(<ConfigurationEditorHarness panel="money" />);
    fireEvent.click(screen.getByLabelText(/House exterior soft wash/iu));
    fireEvent.click(screen.getByLabelText(/Window cleaning/iu));
    fireEvent.click(screen.getByLabelText(/Gutter and downspout cleaning/iu));

    const configuration = currentConfiguration();
    expect(configuration.pricing.enabledServiceCodes).toEqual([
      'pressure-wash-flatwork',
      'soft-wash-house',
      'window-cleaning',
    ]);
    expect(
      configuration.pricing.packages.every((servicePackage) =>
        servicePackage.components.every((component) => component.serviceCode !== 'gutter-cleaning'),
      ),
    ).toBe(true);
    expect(
      configuration.pricing.packages.flatMap((servicePackage) =>
        servicePackage.components.flatMap((component) => component.requiredAddOnCodes),
      ),
    ).toEqual([]);
    expect(screen.getByText(/regenerated from the canonical package policy/iu)).toBeVisible();
    expect(companyConfigurationInputSchema.safeParse(configuration).success).toBe(true);
  });

  it('keeps only service sets that can form materially distinct canonical tiers', () => {
    render(<ConfigurationEditorHarness panel="money" />);

    expect(screen.getByLabelText(/Driveway and flatwork pressure wash/iu)).toBeDisabled();
    expect(screen.getByLabelText(/Gutter and downspout cleaning/iu)).toBeDisabled();
    expect(
      screen.getByText(/keep at least three services, or two including gutter cleaning/iu),
    ).toBeVisible();
  });
});
