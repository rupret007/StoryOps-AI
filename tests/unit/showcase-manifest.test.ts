import { describe, expect, it } from 'vitest';
import { createDemoState } from '@/state/demoSeed';
import { deriveShowcaseManifest } from '@/core/pilot/showcase';
import type { CompanyConfigurationRecord } from '@/domain/companyConfiguration';

describe('showcase manifest projection', () => {
  it('starts in sandbox-rehearsal checkpoint for fresh seeded data', () => {
    const state = createDemoState();
    const manifest = deriveShowcaseManifest(state);

    expect(manifest.id).toBe('showcase-v1.2');
    expect(manifest.completeCount).toBe(0);
    expect(manifest.whatIsNext?.id).toBe('owner-dashboard');
    expect(manifest.checkpoints[0]!.summary).toContain('Publish sandbox configuration');
    expect(manifest.uncertainty).toContain('Setup is incomplete.');
  });

  it('moves through checkpoints only when deterministic fixtures are complete', () => {
    const state = createDemoState();
    state.setupComplete = true;
    const showcaseConfiguration = {
      schemaVersion: 'storyops-company-config-record-v1',
      status: 'published',
      revision: 1,
      draft: {
        schemaVersion: 'storyops-company-config-v1',
        identity: {
          legalName: 'DFW Premier Exterior',
          displayName: 'DFW Premier Exterior',
          ownerName: 'Alex',
          publicEmail: 'owner@dfw-premier.example.com',
          publicPhone: '214-555-0001',
          website: '',
          brand: {
            primaryColor: '#174f46',
            accentColor: '#d99545',
            logoUrl: '',
          },
        },
        territory: {
          serviceAddress: {
            line1: '1000 Test St',
            line2: '',
            city: 'Dallas',
            region: 'TX',
            postalCode: '75201',
            country: 'US',
          },
          timezone: 'America/Chicago',
          serviceAreaNote: 'Test zone',
          travelZones: [
            {
              code: 'DFW-A',
              name: 'Home ZIP service zone',
              maximumMiles: '25',
              fee: '0',
              postalCodes: ['75201'],
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
            { day: 'saturday', closed: true, opensAt: '00:00', closesAt: '00:00' },
            { day: 'sunday', closed: true, opensAt: '00:00', closesAt: '00:00' },
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
          priceBookTemplateVersion: 'storyops-exterior-dfw-v1.1.0',
          enabledServiceCodes: ['pressure-wash-flatwork', 'gutter-cleaning', 'soft-wash-house'],
          serviceRules: [],
          packages: [],
          taxReview: { status: 'required', reviewer: '', reviewedAt: '', evidenceReference: '' },
        },
        people: { crewMembers: [] },
        resources: { vehicles: [], equipment: [] },
        materials: {
          inventory: [],
          supplierLinks: [],
          defaultSafety: { safetyPpe: [], sdsRequired: false, backflowNotes: '' },
        },
        payments: {
          acceptedPaymentProviders: ['stripe'],
          minimumDepositPercent: '25',
          minimumCash: '100',
          depositPolicyNote: '',
          allowedPaymentStates: [],
          latePaymentPolicy: '',
        },
        policies: {
          quality: '',
          legalTerms: '',
          liability: '',
          cancellation: '',
          weather: '',
          legalReferences: [],
        },
        engagement: {
          communicationChannels: ['sms', 'email', 'chat', 'web'],
          consentPrompts: {
            leadCapture: 'By continuing, you consent to receive synthetic demo updates.',
            beforeWork: 'Please confirm work details and provide access.',
            emergency: 'Emergency conditions may pause this job.',
          },
          quoteDeliveryChannels: ['portal'],
        },
        integrations: {
          providers: [],
        },
      },
      published: {
        schemaVersion: 'storyops-company-config-v1',
        identity: {
          legalName: 'DFW Premier Exterior',
          displayName: 'DFW Premier Exterior',
          ownerName: 'Alex',
          publicEmail: 'owner@dfw-premier.example.com',
          publicPhone: '214-555-0001',
          website: '',
          brand: {
            primaryColor: '#174f46',
            accentColor: '#d99545',
            logoUrl: '',
          },
        },
        territory: {
          serviceAddress: {
            line1: '1000 Test St',
            line2: '',
            city: 'Dallas',
            region: 'TX',
            postalCode: '75201',
            country: 'US',
          },
          timezone: 'America/Chicago',
          serviceAreaNote: 'Test zone',
          travelZones: [
            {
              code: 'DFW-A',
              name: 'Home ZIP service zone',
              maximumMiles: '25',
              fee: '0',
              postalCodes: ['75201'],
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
            { day: 'saturday', closed: true, opensAt: '00:00', closesAt: '00:00' },
            { day: 'sunday', closed: true, opensAt: '00:00', closesAt: '00:00' },
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
          priceBookTemplateVersion: 'storyops-exterior-dfw-v1.1.0',
          enabledServiceCodes: ['pressure-wash-flatwork', 'gutter-cleaning', 'soft-wash-house'],
          serviceRules: [],
          packages: [],
          taxReview: { status: 'required', reviewer: '', reviewedAt: '', evidenceReference: '' },
        },
        people: { crewMembers: [] },
        resources: { vehicles: [], equipment: [] },
        materials: {
          inventory: [],
          supplierLinks: [],
          defaultSafety: { safetyPpe: [], sdsRequired: false, backflowNotes: '' },
        },
        payments: {
          acceptedPaymentProviders: ['stripe'],
          minimumDepositPercent: '25',
          minimumCash: '100',
          depositPolicyNote: '',
          allowedPaymentStates: [],
          latePaymentPolicy: '',
        },
        policies: {
          quality: '',
          legalTerms: '',
          liability: '',
          cancellation: '',
          weather: '',
          legalReferences: [],
        },
        engagement: {
          communicationChannels: ['sms', 'email', 'chat', 'web'],
          consentPrompts: {
            leadCapture: 'By continuing, you consent to receive synthetic demo updates.',
            beforeWork: 'Please confirm work details and provide access.',
            emergency: 'Emergency conditions may pause this job.',
          },
          quoteDeliveryChannels: ['portal'],
        },
        integrations: {
          providers: [],
        },
      },
      updatedAt: '2026-07-28T12:00:00.000Z',
      publishedAt: '2026-07-28T12:00:00.000Z',
      publicationMode: 'sandbox',
      publicationReceipt: {
        commandId: '123e4567-e89b-12d3-a456-426614174000',
        configurationHash: 'a'.repeat(64),
        reviewReference: 'ref-sandbox-1',
        replayed: false,
      },
    } as unknown as CompanyConfigurationRecord;
    state.companyConfiguration = showcaseConfiguration;
    state.leads = state.leads.map((lead) =>
      lead.id === 'lead-morgan'
        ? {
            ...lead,
            stage: 'qualified',
          }
        : lead,
    );

    const afterLead = deriveShowcaseManifest(state);
    expect(afterLead.whatIsNext?.id).toBe('photo-assist');
    expect(afterLead.checkpoints.find((item) => item.id === 'lead-qualification')?.status).toBe(
      'complete',
    );

    state.estimate = {
      ...state.estimate,
      status: 'quoted',
      photoEvidence: {
        ...state.estimate.photoEvidence,
        humanVerified: true,
      },
      durationMinutes: 240,
    };
    state.customerQuoteAccepted = true;
    state.leads = state.leads.map((lead) =>
      lead.id === 'lead-morgan'
        ? {
            ...lead,
            stage: 'booked',
          }
        : lead,
    );
    state.depositPaid = true;
    state.visits = state.visits.map((visit) =>
      visit.jobNumber === 'JOB-1048'
        ? {
            ...visit,
            checklist: visit.checklist.map((item) => ({ ...item, complete: true })),
            beforePhotos: 1,
            afterPhotos: 1,
            signature: true,
            notes: 'Fixture completed.',
            status: 'complete',
          }
        : visit,
    );
    state.invoices = [
      ...state.invoices,
      {
        id: 'invoice-showcase',
        number: 'INV-2048',
        customerName: 'Morgan Ellis',
        jobNumber: 'JOB-1048',
        issueDate: 'Jul 31, 2026',
        dueDate: 'Due today',
        total: state.estimate.total,
        paid: state.estimate.total,
        balance: '0.00',
        status: 'paid',
      },
    ];
    state.reviewRequested = true;
    state.referralInvited = true;
    state.recurringPlanActive = true;

    const complete = deriveShowcaseManifest(state);
    expect(complete.checkpoints.every((item) => item.status === 'complete')).toBe(true);
    expect(complete.whatIsNext).toBeUndefined();
    expect(complete.completeCount).toBe(6);
  });

  it('reports policy boundaries that prevent real-world action', () => {
    const state = createDemoState();
    const manifest = deriveShowcaseManifest(state);
    expect(manifest.whatIsNext?.id).toBe('owner-dashboard');
    expect(manifest.uncertainty).toEqual(
      expect.arrayContaining([
        'Setup is incomplete.',
        'Lead scope/contact/consent has unresolved values.',
      ]),
    );
  });
});
