import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from '@/router';
import { CompanyConfigurationStudio } from '@/pages/CompanyConfigurationStudio';
import type { CompanyConfiguration } from '@/domain/companyConfiguration';

const mocks = vi.hoisted(() => ({
  saveCompanyConfigurationDraft: vi.fn(),
}));

vi.mock('@/state/StoryOpsProvider', () => ({
  useStoryOps: () => ({
    state: {
      dataMode: 'supabase',
      setupProfile: {
        businessName: 'North Texas Exterior Care',
        ownerName: 'Dana Owner',
        homePostalCode: '76051',
        timezone: 'America/Chicago',
        enabledServiceCodes: ['pressure-wash-flatwork', 'gutter-cleaning'],
        policyAcknowledged: true,
        configuredAt: '2026-07-29T12:00:00.000Z',
      },
      live: {
        companyName: 'North Texas Exterior Care',
      },
      companyConfiguration: undefined,
      operatingBaseline: undefined,
    },
    actions: {
      saveCompanyConfigurationDraft: mocks.saveCompanyConfigurationDraft,
      publishCompanyConfiguration: vi.fn(),
      publishOperatingBaseline: vi.fn(),
    },
  }),
}));

describe('authenticated company-configuration bootstrap', () => {
  beforeEach(() => {
    mocks.saveCompanyConfigurationDraft.mockReset();
    mocks.saveCompanyConfigurationDraft.mockResolvedValue({
      schemaVersion: 'storyops-company-config-receipt-v1',
      commandType: 'company.configuration.save',
      status: 'draft',
      companyId: '10000000-0000-4000-8000-000000000001',
      revision: 1,
      configurationHash: 'a'.repeat(64),
      issues: [],
      replayed: false,
      commandId: '99100000-0000-4000-8000-000000000001',
      serverTime: '2026-07-29T12:00:00.000Z',
    });
  });

  it('saves and opens an incomplete review draft without inventing inspection readiness', async () => {
    render(
      <MemoryRouter initialEntries={['/setup']}>
        <CompanyConfigurationStudio />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Public email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Public phone (E.164)'), {
      target: { value: '+18175550123' },
    });
    fireEvent.change(screen.getByLabelText('Service-base street'), {
      target: { value: '100 Main Street' },
    });
    fireEvent.change(screen.getByLabelText('City'), {
      target: { value: 'Grapevine' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create review draft' }));

    await waitFor(() => expect(mocks.saveCompanyConfigurationDraft).toHaveBeenCalledOnce());
    const configuration = mocks.saveCompanyConfigurationDraft.mock
      .calls[0]![0] as CompanyConfiguration;
    expect(
      configuration.resources.equipment.every((equipment) => equipment.inspectionStatus === 'due'),
    ).toBe(true);
    expect(configuration.people.crewMembers).toEqual([
      expect.objectContaining({ role: 'owner', active: true }),
    ]);
    expect(screen.getByRole('heading', { name: 'Crew and permissions' })).toBeVisible();
    expect(screen.getByText(/planning records only/iu)).toBeVisible();
  });
});
