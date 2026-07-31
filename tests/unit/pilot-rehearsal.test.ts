import { describe, expect, it } from 'vitest';
import { deriveSandboxPilotRehearsal } from '@/core/pilot/rehearsal';
import { createExteriorServicesConfiguration } from '@/domain/companyConfiguration';
import { createExteriorConfigurationPricing } from '@/data/exteriorServiceTemplates';
import { getExteriorConfigurationRequirements } from '@/domain/exteriorServiceRequirements';
import { createDemoState } from '@/state/demoSeed';

function preparedSandbox() {
  const state = createDemoState();
  state.setupComplete = true;
  const enabledServiceCodes = ['pressure-wash-flatwork', 'gutter-cleaning'] as const;
  const configuration = createExteriorServicesConfiguration({
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
  const requirements = getExteriorConfigurationRequirements(enabledServiceCodes);
  const owner = configuration.people.crewMembers.find(
    (member) => member.active && member.role === 'owner',
  )!;
  owner.skills = [...new Set([...owner.skills, ...requirements.requiredSkills])];
  for (const equipmentType of requirements.requiredEquipmentTypes) {
    const existing = configuration.resources.equipment.find(
      (equipment) => equipment.equipmentType === equipmentType,
    );
    if (existing) {
      existing.active = true;
      existing.inspectionStatus = 'current';
    } else {
      configuration.resources.equipment.push({
        id: `rehearsal-${equipmentType}`,
        name: `Rehearsal ${equipmentType}`,
        equipmentType,
        quantity: 1,
        inspectionStatus: 'current',
        active: true,
      });
    }
  }
  state.companyConfiguration = {
    schemaVersion: 'storyops-company-config-record-v1',
    status: 'published',
    revision: 1,
    draft: configuration,
    published: configuration,
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
  state.leads = state.leads.map((lead) =>
    lead.id === 'lead-morgan' ? { ...lead, stage: 'qualified' } : lead,
  );
  return state;
}

describe('sandbox pilot rehearsal projection', () => {
  it('shows the first incomplete guarded checkpoint and never claims provider truth', () => {
    const state = preparedSandbox();
    const rehearsal = deriveSandboxPilotRehearsal(state);

    expect(rehearsal.next).toMatchObject({
      id: 'estimate',
      status: 'current',
      href: '/estimates/estimate-1048',
    });
    expect(rehearsal.checkpoints.find((item) => item.id === 'booking')).toMatchObject({
      status: 'blocked',
      detail: expect.stringContaining('separate dispatcher fixture'),
    });
  });

  it('moves a price exception to exact owner approval before portal publication', () => {
    const state = preparedSandbox();
    state.estimate = { ...state.estimate, status: 'pending_approval' };

    const rehearsal = deriveSandboxPilotRehearsal(state);

    expect(rehearsal.next).toMatchObject({
      id: 'approval',
      status: 'current',
      href: '/approvals',
    });
    expect(rehearsal.checkpoints.find((item) => item.id === 'quote')).toMatchObject({
      status: 'blocked',
    });
  });

  it('keeps booking separate from the acceptance and deposit fixtures', () => {
    const state = preparedSandbox();
    state.estimate = { ...state.estimate, status: 'quoted' };
    state.customerQuoteAccepted = true;
    state.depositPaid = true;

    const rehearsal = deriveSandboxPilotRehearsal(state);

    expect(rehearsal.checkpoints.find((item) => item.id === 'acceptance')).toMatchObject({
      status: 'complete',
      detail: expect.stringContaining('no funds moved'),
    });
    expect(rehearsal.next).toMatchObject({ id: 'booking', href: '/dispatch' });
  });

  it('requires completion, invoice, payment, and every post-service fixture', () => {
    const state = preparedSandbox();
    state.estimate = { ...state.estimate, status: 'quoted' };
    state.customerQuoteAccepted = true;
    state.depositPaid = true;
    state.leads = state.leads.map((lead) =>
      lead.id === 'lead-morgan' ? { ...lead, stage: 'booked' } : lead,
    );
    state.visits = state.visits.map((visit) =>
      visit.jobNumber === 'JOB-1048' ? { ...visit, status: 'complete' } : visit,
    );

    expect(deriveSandboxPilotRehearsal(state).next).toMatchObject({ id: 'invoice' });

    state.invoices = [
      ...state.invoices,
      {
        id: 'invoice-morgan',
        number: 'INV-1048',
        customerName: 'Morgan Ellis',
        jobNumber: 'JOB-1048',
        issueDate: 'Jul 31, 2026',
        dueDate: 'Due on receipt',
        total: '613.56',
        paid: '613.56',
        balance: '0.00',
        status: 'paid',
      },
    ];

    expect(deriveSandboxPilotRehearsal(state).next).toMatchObject({ id: 'follow_up' });

    state.reviewRequested = true;
    state.referralInvited = true;
    state.recurringPlanActive = true;

    const completed = deriveSandboxPilotRehearsal(state);
    expect(completed.next).toBeUndefined();
    expect(completed.completeCount).toBe(completed.checkpoints.length);
  });
});
