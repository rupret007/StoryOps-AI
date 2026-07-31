import { describe, expect, it } from 'vitest';
import { deriveOwnerCommandCenter } from '@/core/pilot/ownerCommandCenter';
import { createDemoState } from '@/state/demoSeed';

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
});
