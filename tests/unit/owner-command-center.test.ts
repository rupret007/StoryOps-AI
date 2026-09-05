import { describe, expect, it } from 'vitest';
import { deriveOwnerCommandCenter, describeVisitClearance } from '@/core/pilot/ownerCommandCenter';
import { createDemoState } from '@/state/demoSeed';
import type { BackOfficeQuoteChangeRequest, PaymentAllocationConflict } from '@/state/model';
import type { DispatchOriginRetentionProjection } from '@/core/integrations/dispatchOriginRetention';
import type { OutboundWorkerHealthProjection } from '@/core/integrations/outboundWorkerHealth';

describe('owner command center projection', () => {
  it('separates facts, safe next actions, blockers, and known unknowns', () => {
    const state = createDemoState();
    state.dataMode = 'supabase';
    state.estimate.status = 'quoted';
    state.customerQuoteAccepted = true;
    state.depositPaid = false;
    state.visits[0]!.status = 'weather_hold';
    state.invoices[0]!.status = 'paid';
    state.invoices[0]!.paid = state.invoices[0]!.total;
    state.invoices[0]!.balance = '0.00';
    state.reviewRequested = false;
    state.recurringPlanActive = false;
    state.traces[0]!.result = 'blocked';
    state.live = {
      userId: 'owner-user',
      companyId: 'company-a',
      companyName: 'Pilot Exterior Care',
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-29T12:00:00.000Z',
      postServiceReviewStatus: 'reconciliation_required',
      invoiceVersions: {},
      leadVersions: {},
      checklistItems: {},
      checklistDefinitions: {},
      incidentVersions: {},
      notificationVersions: {},
      approvalVersions: {},
      materials: [],
      customers: [],
      properties: [],
    };

    const projection = deriveOwnerCommandCenter(state);
    const actionIds = projection.actions.map((action) => action.id);

    expect(actionIds).toEqual(
      expect.arrayContaining([
        'deposit-awaiting-reconciliation',
        'weather-held-visits',
        'provider-reconciliation',
        'review-opportunity',
        'maintenance-opportunity',
        'ai-blocked-actions',
      ]),
    );
    expect(
      projection.actions.find((action) => action.id === 'deposit-awaiting-reconciliation'),
    ).toMatchObject({
      priority: 'P0',
      href: '/finance',
      blockedBy: 'Signed provider payment evidence',
    });
    expect(projection.unknowns).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Provider-side payment and delivery state are unknown'),
      ]),
    );
  });

  it('uses the company timezone for today and conditions route/weather briefing facts on evidence', () => {
    const state = createDemoState();
    const first = state.visits[0]!;
    const second = { ...state.visits[1]!, id: 'visit-after-midnight', jobNumber: 'JOB-2050' };
    state.dataMode = 'supabase';
    state.visits = [
      {
        ...first,
        route: {
          provider: 'vroom',
          evidenceMode: 'live',
          freshness: 'current',
          feasible: true,
          driveMinutes: 18,
          checkedAt: '2026-07-30T04:20:00.000Z',
        },
        weather: {
          provider: 'nws',
          evidenceMode: 'live',
          freshness: 'current',
          policyDisposition: 'eligible',
          checkedAt: '2026-07-30T04:15:00.000Z',
        },
      },
      second,
    ];
    state.live = {
      userId: 'owner-user',
      companyId: 'company-a',
      companyName: 'Pilot Exterior Care',
      companyTimezone: 'America/Chicago',
      // 11:30 PM on July 29 in the company timezone.
      serverTime: '2026-07-30T04:30:00.000Z',
      fieldVisitReferences: {
        [first.id]: {
          visit: { id: first.id, version: 1 },
          visitStatus: 'confirmed',
          visitStartsAt: '2026-07-30T04:45:00.000Z',
          visitEndsAt: '2026-07-30T05:00:00.000Z',
          job: { id: 'job-1', version: 1 },
          jobId: 'job-1',
          propertyId: 'property-1',
          checklistItems: {},
        },
        [second.id]: {
          visit: { id: second.id, version: 1 },
          visitStatus: 'confirmed',
          visitStartsAt: '2026-07-30T05:15:00.000Z',
          visitEndsAt: '2026-07-30T06:15:00.000Z',
          job: { id: 'job-2', version: 1 },
          jobId: 'job-2',
          propertyId: 'property-2',
          checklistItems: {},
        },
      },
      invoiceVersions: {},
      leadVersions: {},
      checklistItems: {},
      checklistDefinitions: {},
      incidentVersions: {},
      notificationVersions: {},
      approvalVersions: {},
      materials: [],
      customers: [],
      properties: [],
    };

    const projection = deriveOwnerCommandCenter(state);

    expect(projection.today.localDate).toBe('2026-07-29');
    expect(projection.today.visits.map((visit) => visit.id)).toEqual([first.id]);
    expect(projection.today.evidenceFacts).toEqual([
      expect.stringContaining(`${first.jobNumber} route is feasible`),
      expect.stringContaining(`${first.jobNumber} weather is eligible`),
    ]);
    expect(
      projection.unknowns.some(
        (unknown) =>
          unknown.includes(`${first.jobNumber} route`) ||
          unknown.includes(`${first.jobNumber} service-window weather`),
      ),
    ).toBe(false);
  });

  it('labels missing route and weather only for company-local today visits', () => {
    const state = createDemoState();
    const visit = state.visits[0]!;
    state.dataMode = 'supabase';
    state.visits = [{ ...visit, route: {}, weather: {} }];
    state.live = {
      userId: 'owner-user',
      companyId: 'company-a',
      companyName: 'Pilot Exterior Care',
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-29T12:00:00.000Z',
      fieldVisitReferences: {
        [visit.id]: {
          visit: { id: visit.id, version: 1 },
          visitStatus: 'confirmed',
          visitStartsAt: '2026-07-29T14:00:00.000Z',
          visitEndsAt: '2026-07-29T15:00:00.000Z',
          job: { id: 'job-1', version: 1 },
          jobId: 'job-1',
          propertyId: 'property-1',
          checklistItems: {},
        },
      },
      invoiceVersions: {},
      leadVersions: {},
      checklistItems: {},
      checklistDefinitions: {},
      incidentVersions: {},
      notificationVersions: {},
      approvalVersions: {},
      materials: [],
      customers: [],
      properties: [],
    };

    const projection = deriveOwnerCommandCenter(state);

    expect(projection.today.visits).toHaveLength(1);
    expect(projection.unknowns).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${visit.jobNumber} route and travel time are unknown`),
        expect.stringContaining(`${visit.jobNumber} service-window weather is unknown`),
      ]),
    );
  });

  it('surfaces collection holds, quote changes, portal requests, and blocked workers', () => {
    const state = createDemoState();
    state.dataMode = 'supabase';
    state.customerPortalRequests = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        customerId: '22222222-2222-4222-8222-222222222222',
        propertyId: '33333333-3333-4333-8333-333333333333',
        requestType: 'reschedule',
        status: 'submitted',
        requestedServiceCodes: [],
        requestNotes: 'Prefer Tuesday morning.',
        createdAt: '2026-07-29T12:00:00.000Z',
        updatedAt: '2026-07-29T12:00:00.000Z',
        version: 1,
      },
    ];
    const paymentHold: PaymentAllocationConflict = {
      id: '44444444-4444-4444-8444-444444444444',
      paymentId: '55555555-5555-4555-8555-555555555555',
      invoiceId: '66666666-6666-4666-8666-666666666666',
      invoiceNumber: 'INV-1021',
      customerId: '22222222-2222-4222-8222-222222222222',
      providerEventId: 'evt_hold',
      conflictCode: 'retired_checkout_succeeded',
      intendedAmount: '438.70',
      verifiedAmount: '438.70',
      invoiceBalanceAtEvent: '438.70',
      providerPaymentId: 'pi_hold',
      providerOccurredAt: '2026-07-29T12:00:00.000Z',
      status: 'open',
      createdAt: '2026-07-29T12:00:00.000Z',
      version: 1,
      resolutionAction: 'payment.allocation.apply_exact_current_balance',
      canApplyExactCurrentBalance: true,
      nextAction: 'Approve the exact current-balance action, then apply verified funds.',
    };
    const quoteChange: BackOfficeQuoteChangeRequest = {
      id: '77777777-7777-4777-8777-777777777777',
      customerId: '22222222-2222-4222-8222-222222222222',
      propertyId: '33333333-3333-4333-8333-333333333333',
      quoteId: '88888888-8888-4888-8888-888888888888',
      quoteNumber: 'Q-1048',
      quoteVersion: 1,
      requestedServiceCodes: ['gutter-cleaning'],
      requestedAddOnCodes: [],
      requestNotes: 'Add downspouts.',
      status: 'submitted',
      createdAt: '2026-07-29T12:00:00.000Z',
      version: 1,
      nextAction: 'Review the exact requested codes against the current quote version.',
    };
    state.live = {
      userId: 'owner-user',
      companyId: 'company-a',
      companyName: 'Pilot Exterior Care',
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-29T12:00:00.000Z',
      invoiceVersions: {},
      leadVersions: {},
      checklistItems: {},
      checklistDefinitions: {},
      incidentVersions: {},
      notificationVersions: {},
      approvalVersions: {},
      materials: [],
      customers: [],
      properties: [],
      paymentAllocationConflicts: [paymentHold],
      customerQuoteChangeRequests: [quoteChange],
    };
    state.outboundWorkers = {
      status: 'blocked',
      workers: [
        { worker: 'post_service', status: 'blocked' },
        { worker: 'transactional_outbound', status: 'healthy' },
        { worker: 'scheduling_reconciliation', status: 'healthy' },
        { worker: 'scope_photo_cleanup', status: 'healthy' },
      ],
    } as OutboundWorkerHealthProjection;
    state.dispatchOriginRetention = {
      p0ReleaseCheck: 'blocked',
    } as DispatchOriginRetentionProjection;

    const projection = deriveOwnerCommandCenter(state);
    const byId = Object.fromEntries(projection.actions.map((action) => [action.id, action]));

    expect(byId['payment-allocation-holds']).toMatchObject({
      priority: 'P0',
      href: '/finance',
      blockedBy: 'Exact owner current-balance resolver',
      recommendation: paymentHold.nextAction,
    });
    expect(byId['quote-change-requests']).toMatchObject({
      priority: 'P1',
      href: `/estimates/${state.estimate.id}`,
      recommendation: quoteChange.nextAction,
    });
    expect(byId['customer-portal-requests']).toMatchObject({
      priority: 'P1',
      href: '/portal',
    });
    expect(byId['private-workers-blocked']).toMatchObject({
      priority: 'P0',
      href: '/integrations',
      fact: expect.stringContaining('post service'),
    });
    expect(byId['dispatch-origin-retention']).toMatchObject({
      priority: 'P0',
      href: '/integrations',
    });
  });

  it('labels sandbox visit weather and route as non-dispatch evidence', () => {
    const state = createDemoState();
    const visit = state.visits[1]!;
    const badges = describeVisitClearance(visit);
    expect(badges).toEqual([
      {
        key: 'weather',
        label: 'sandbox weather · not dispatch evidence',
        tone: 'neutral',
        evidence: 'sandbox',
      },
      {
        key: 'route',
        label: 'sandbox route · not dispatch evidence',
        tone: 'neutral',
        evidence: 'sandbox',
      },
    ]);
  });
});
