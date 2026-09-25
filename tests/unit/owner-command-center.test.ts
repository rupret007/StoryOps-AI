import { describe, expect, it } from 'vitest';
import {
  deriveOwnerCommandCenter,
  deriveOwnerCommandGlance,
  explainNextOwnerAction,
  ownerActionGlanceLine,
  ownerActionSurface,
  ownerTodayVisitEmptyCopy,
  pickNextOwnerAction,
  type OwnerActionItem,
} from '@/core/pilot/ownerCommandCenter';
import { createExteriorServicesConfiguration } from '@/domain/companyConfiguration';
import { createExteriorConfigurationPricing } from '@/data/exteriorServiceTemplates';
import { createDemoState } from '@/state/demoSeed';
import type { DemoState, LiveTransactionalDelivery } from '@/state/model';

function withPublishedOperatingRecords(state: DemoState): DemoState {
  const enabledServiceCodes = ['pressure-wash-flatwork', 'gutter-cleaning'] as const;
  const configuration = createExteriorServicesConfiguration({
    legalName: 'Pilot Exterior Care',
    ownerName: 'Jeff Story',
    publicEmail: 'owner@example.test',
    publicPhone: '+18175550100',
    addressLine1: '100 Sandbox Service Road',
    city: 'Grapevine',
    postalCode: '76051',
    enabledServiceCodes: [...enabledServiceCodes],
    ...createExteriorConfigurationPricing(enabledServiceCodes),
  });
  state.companyConfiguration = {
    schemaVersion: 'storyops-company-config-record-v1',
    status: 'published',
    revision: 1,
    draft: configuration,
    published: configuration,
    updatedAt: '2026-07-29T12:00:00.000Z',
    publishedAt: '2026-07-29T12:00:00.000Z',
    publicationMode: state.dataMode === 'supabase' ? 'live' : 'sandbox',
    publicationReceipt: {
      commandId: '11111111-1111-4111-8111-111111111111',
      configurationHash: 'a'.repeat(64),
      reviewReference: 'owner-config-review',
      replayed: false,
    },
  };
  state.operatingBaseline = {
    schemaVersion: 'storyops-operating-baseline-state-v1',
    status: 'active',
    companyId: '22222222-2222-4222-8222-222222222222',
    configurationRevision: 1,
    configurationHash: 'a'.repeat(64),
    baselineId: '33333333-3333-4333-8333-333333333333',
    baselineHash: 'b'.repeat(64),
    priceBookId: '44444444-4444-4444-8444-444444444444',
    serviceTermsId: '55555555-5555-4555-8555-555555555555',
    retentionPolicyId: '66666666-6666-4666-8666-666666666666',
    reviewReference: 'owner-operating-review',
    activatedAt: '2026-07-29T12:05:00.000Z',
    providersActivated: false,
    outboundEnabled: false,
    launchAuthorized: false,
    launchVersion: 0,
    launchStatus: 'not_authorized',
    launchProviderSnapshotHash: null,
    launchProofSnapshotHash: null,
  };
  return state;
}

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

  it('names leftover operational holds and prefers the next P0 hold', () => {
    const state = withPublishedOperatingRecords(createDemoState());
    const visit = state.visits[0]!;
    state.dataMode = 'supabase';
    state.estimate.status = 'quoted';
    state.customerQuoteAccepted = true;
    state.depositPaid = true;
    visit.status = 'ready';
    visit.changeRequests = [
      {
        id: 'change-access',
        reasonCode: 'access_blocked',
        summary: 'Gate locked; cannot reach the equipment pad.',
        status: 'submitted',
        createdAt: '2026-07-29T12:00:00.000Z',
        version: 1,
      },
    ];
    state.incidents = [
      {
        id: 'incident-shutter',
        visitId: visit.id,
        jobNumber: visit.jobNumber,
        kind: 'property_damage',
        summary: 'Downspout dented a shutter.',
        status: 'open',
        reportedAt: '2026-07-29T12:00:00.000Z',
        reportedBy: 'technician',
        automationsPaused: true,
      },
    ];
    state.offlineQueue = [
      {
        id: 'packet-complete',
        idempotencyKey: 'packet-complete',
        action: 'visit.complete',
        entityId: visit.id,
        createdAt: '2026-07-29T12:10:00.000Z',
        status: 'failed',
        kind: 'command',
      },
    ];
    const quoteDelivery: LiveTransactionalDelivery = {
      id: 'delivery-quote',
      action: 'quote.delivery',
      entityId: 'quote-1048',
      entityVersion: 1,
      channel: 'sms',
      status: 'submitted_unknown',
      manualReconciliationRequired: true,
      providerSubmissionAsserted: true,
      externalDeliveryClaimed: false,
      requestedAt: '2026-07-29T11:00:00.000Z',
      version: 1,
    };
    state.live = {
      userId: 'owner-user',
      companyId: 'company-a',
      companyName: 'Pilot Exterior Care',
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-29T12:00:00.000Z',
      quoteDelivery,
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
    const byId = Object.fromEntries(projection.actions.map((action) => [action.id, action]));

    expect(byId['open-incidents']).toMatchObject({
      priority: 'P0',
      kind: 'hold',
      href: '/operations#safety',
      blockedBy: 'Owner incident review and factual closure',
    });
    expect(byId['open-incidents']?.entities).toEqual([
      { label: `${visit.jobNumber} · property damage`, href: '/operations#safety' },
    ]);
    expect(byId['field-change-requests']).toMatchObject({
      priority: 'P1',
      kind: 'hold',
      href: '/field',
    });
    expect(byId['field-change-requests']?.fact).toContain('access blocked');
    expect(byId['offline-packet-holds']).toMatchObject({
      priority: 'P0',
      kind: 'hold',
      href: '/field',
      blockedBy: 'Failed device-to-server reconciliation',
    });
    expect(byId['transactional-delivery-holds']).toMatchObject({
      priority: 'P0',
      kind: 'hold',
      href: `/estimates/${state.estimate.id}`,
    });
    expect(byId['transactional-delivery-holds']?.entities?.[0]?.label).toContain('Quote delivery');
    expect(byId['past-due-invoices']?.entities).toEqual(
      expect.arrayContaining([{ label: 'INV-1021', href: '/finance' }]),
    );
    expect(projection.nextAction?.id).toBe('offline-packet-holds');
    expect(projection.holds.map((action) => action.id)).toEqual(
      expect.arrayContaining([
        'open-incidents',
        'field-change-requests',
        'offline-packet-holds',
        'transactional-delivery-holds',
        'past-due-invoices',
      ]),
    );
  });

  it('deepens weather-hold facts with the exact job numbers', () => {
    const state = createDemoState();
    state.visits[0]!.status = 'weather_hold';
    const projection = deriveOwnerCommandCenter(state);
    const weather = projection.actions.find((action) => action.id === 'weather-held-visits');
    expect(weather).toMatchObject({
      kind: 'hold',
      href: '/dispatch',
    });
    expect(weather?.fact).toContain(state.visits[0]!.jobNumber);
    expect(weather?.entities).toEqual([{ label: state.visits[0]!.jobNumber, href: '/dispatch' }]);
  });

  it('picks the first P0 hold before later decisions or follow-ups', () => {
    const actions: OwnerActionItem[] = [
      {
        id: 'review-opportunity',
        priority: 'P2',
        kind: 'follow_up',
        title: 'Review opportunity is eligible',
        fact: 'Paid work exists.',
        recommendation: 'Verify consent.',
        source: 'test',
        href: '/finance',
      },
      {
        id: 'pending-approvals',
        priority: 'P1',
        kind: 'decision',
        title: 'Review held actions',
        fact: 'Approvals pending.',
        recommendation: 'Approve the exact payload.',
        source: 'test',
        href: '/approvals',
      },
      {
        id: 'open-incidents',
        priority: 'P0',
        kind: 'hold',
        title: 'Open incidents pause automation',
        fact: 'One open incident.',
        recommendation: 'Review Safety & incidents.',
        source: 'test',
        href: '/operations#safety',
      },
    ];

    expect(pickNextOwnerAction(actions)?.id).toBe('open-incidents');
    expect(explainNextOwnerAction(actions[2]!)).toBe(
      'This hold stops work. Handle it before any decision or follow-up.',
    );
    expect(explainNextOwnerAction(actions[1]!)).toBe(
      'No hold is in front of this. It needs your yes or no on the exact record.',
    );
    expect(explainNextOwnerAction(actions[0]!)).toBe(
      'No hold is in front of this. This follow-up can wait behind anything that stops work.',
    );
  });

  it('names the surface a hold opens', () => {
    expect(ownerActionSurface('/operations#safety')).toBe('Safety & incidents');
    expect(ownerActionSurface('/operations#recurring')).toBe('Recurring care');
    expect(ownerActionSurface('/estimates/new')).toBe('New estimate');
    expect(ownerActionSurface('/estimates/estimate-1048')).toBe('Estimate');
    expect(ownerActionSurface('/setup')).toBe('Owner configuration');
    expect(ownerActionSurface('/field')).toBe('Field');
    expect(ownerActionSurface('/unknown')).toBe('Workspace');
  });

  it('returns undefined next action and empty groups when no actions exist', () => {
    const actions: OwnerActionItem[] = [];
    expect(pickNextOwnerAction(actions)).toBeUndefined();
  });

  it('sorts actions by priority then id for stable ordering', () => {
    const state = withPublishedOperatingRecords(createDemoState());
    state.dataMode = 'supabase';
    state.estimate.status = 'quoted';
    state.customerQuoteAccepted = true;
    state.depositPaid = true;
    state.invoices[0]!.status = 'past_due';
    state.traces[0]!.result = 'blocked';
    state.integrations = state.integrations.map((i) => ({ ...i, status: 'Degraded' }));
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
    };

    const projection = deriveOwnerCommandCenter(state);

    const priorities = projection.actions.map((a) => a.priority);
    expect(priorities).toEqual([...priorities].sort());

    const p1Actions = projection.actions.filter((a) => a.priority === 'P1');
    const p1Ids = p1Actions.map((a) => a.id);
    expect(p1Ids).toEqual([...p1Ids].sort());
  });

  it('gives a phone-length line that says whether a hold stops work', () => {
    const hold: OwnerActionItem = {
      id: 'open-incidents',
      priority: 'P0',
      kind: 'hold',
      title: 'Open incidents pause automation',
      fact: 'A long fact that should not be the glance line.',
      recommendation: 'Review Safety & incidents.',
      source: 'test',
      href: '/operations#safety',
      entities: [{ label: 'JOB-1 · property damage', href: '/operations#safety' }],
    };
    const line = ownerActionGlanceLine(hold);
    expect(line).toBe('Stops work. Record: JOB-1 · property damage.');
    expect(line.length).toBeLessThan(80);
    expect(line).not.toContain('A long fact');
  });

  it('shows first few record labels when there are 2-3 entities for a more actionable glance', () => {
    const twoEntities: OwnerActionItem = {
      id: 'weather-held-visits',
      priority: 'P0',
      kind: 'hold',
      title: 'Visits are on weather hold',
      fact: 'Two visits blocked.',
      recommendation: 'Review weather evidence.',
      source: 'test',
      href: '/dispatch',
      entities: [
        { label: 'JOB-1048', href: '/dispatch' },
        { label: 'JOB-1049', href: '/dispatch' },
      ],
    };
    expect(ownerActionGlanceLine(twoEntities)).toBe('Stops work. Records: JOB-1048, JOB-1049.');

    const threeEntities: OwnerActionItem = {
      ...twoEntities,
      entities: [
        { label: 'JOB-1048', href: '/dispatch' },
        { label: 'JOB-1049', href: '/dispatch' },
        { label: 'JOB-1050', href: '/dispatch' },
      ],
    };
    expect(ownerActionGlanceLine(threeEntities)).toBe(
      'Stops work. Records: JOB-1048, JOB-1049, JOB-1050.',
    );
  });

  it('shows first entity plus count for 4+ entities to keep the line phone-length', () => {
    const fourEntities: OwnerActionItem = {
      id: 'weather-held-visits',
      priority: 'P0',
      kind: 'hold',
      title: 'Visits are on weather hold',
      fact: 'Four visits blocked.',
      recommendation: 'Review weather evidence.',
      source: 'test',
      href: '/dispatch',
      entities: [
        { label: 'JOB-1048', href: '/dispatch' },
        { label: 'JOB-1049', href: '/dispatch' },
        { label: 'JOB-1050', href: '/dispatch' },
        { label: 'JOB-1051', href: '/dispatch' },
      ],
    };
    const line = ownerActionGlanceLine(fourEntities);
    expect(line).toBe('Stops work. JOB-1048 + 3 more.');
    expect(line.length).toBeLessThan(80);
  });

  it('directs to source when no entities are attached for an actionable next step', () => {
    const noEntities: OwnerActionItem = {
      id: 'configuration-missing',
      priority: 'P0',
      kind: 'hold',
      title: 'Complete the owner configuration',
      fact: 'No configuration record.',
      recommendation: 'Record identity, territory, hours.',
      source: 'test',
      href: '/setup',
    };
    expect(ownerActionGlanceLine(noEntities)).toBe('Stops work. See the source for details.');
  });

  it('withholds counts when the authenticated workspace has no server time', () => {
    const state = withPublishedOperatingRecords(createDemoState());
    state.dataMode = 'supabase';
    state.online = true;
    state.live = {
      userId: 'owner-user',
      companyId: 'company-a',
      companyName: 'Pilot Exterior Care',
      companyTimezone: 'America/Chicago',
      serverTime: 'not-a-time',
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
    expect(projection.freshness).toBe('untimed');
    expect(projection.today.status).toBe('unknown');
    expect(projection.glance.countsKnown).toBe(false);
    expect(projection.glance.holds).toBeNull();
    expect(projection.glance.headline).toBe('WashOps is not current.');
    expect(projection.glance.caveat).toContain('Do not read an empty list as all clear.');
    expect(projection.glance.headline).not.toMatch(/no holds/i);
    expect(ownerTodayVisitEmptyCopy(projection.today, projection.freshness).heading).toBe(
      'Today is unknown',
    );
  });

  it('fails closed when the device is offline even if a server time is stored', () => {
    const state = createDemoState();
    state.dataMode = 'supabase';
    state.online = false;
    state.live = {
      userId: 'owner-user',
      companyId: 'company-a',
      companyName: 'Pilot Exterior Care',
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-31T14:00:00.000Z',
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
    expect(projection.freshness).toBe('offline');
    expect(projection.glance.countsKnown).toBe(false);
    expect(projection.glance.caveat).toContain('offline');
    expect(projection.glance.holds).toBeNull();
  });

  it('names an empty current projection as not a clearance', () => {
    const glance = deriveOwnerCommandGlance({
      freshness: 'current',
      sourcedAt: '2026-07-31T14:00:00.000Z',
      holds: [],
      decisions: [],
      followUps: [],
    });
    expect(glance.headline).toBe('Nothing in this projection is waiting.');
    expect(glance.caveat).toContain('not a clearance');
    expect(glance.holds).toBe(0);
    expect(glance.p0Holds).toBe(0);
  });

  it('counts only P0 holds as stopping work and names the first one', () => {
    const stopping: OwnerActionItem = {
      id: 'open-incidents',
      priority: 'P0',
      kind: 'hold',
      title: 'Open incidents pause automation',
      fact: 'One open incident.',
      recommendation: 'Review Safety & incidents.',
      source: 'test',
      href: '/operations#safety',
    };
    const behind: OwnerActionItem = {
      id: 'past-due-invoices',
      priority: 'P1',
      kind: 'hold',
      title: 'Review past-due invoices',
      fact: 'One invoice.',
      recommendation: 'Reconcile payment.',
      source: 'test',
      href: '/finance',
    };
    const glance = deriveOwnerCommandGlance({
      freshness: 'sandbox',
      sourcedAt: 'fixed local fixture',
      holds: [stopping, behind],
      decisions: [],
      followUps: [],
      nextAction: stopping,
    });
    expect(glance.headline).toBe('1 hold stops work.');
    expect(glance.caveat).toContain('First: Open incidents pause automation.');
    expect(glance.caveat).toContain('1 more hold is behind it.');
    expect(glance.holds).toBe(2);
    expect(glance.p0Holds).toBe(1);
  });

  it('includes the single entity label in the caveat for a more actionable phone glance', () => {
    const stoppingWithEntity: OwnerActionItem = {
      id: 'open-incidents',
      priority: 'P0',
      kind: 'hold',
      title: 'Open incidents pause automation',
      fact: 'One open incident.',
      recommendation: 'Review Safety & incidents.',
      source: 'test',
      href: '/operations#safety',
      entities: [{ label: 'JOB-1048 · property damage', href: '/operations#safety' }],
    };
    const glance = deriveOwnerCommandGlance({
      freshness: 'current',
      sourcedAt: '2026-07-31T14:00:00.000Z',
      holds: [stoppingWithEntity],
      decisions: [],
      followUps: [],
      nextAction: stoppingWithEntity,
    });
    expect(glance.caveat).toBe(
      'First: Open incidents pause automation — JOB-1048 · property damage. This is not a clearance of hidden records.',
    );
  });

  it('omits entity label from caveat when there are multiple entities', () => {
    const stoppingWithMultipleEntities: OwnerActionItem = {
      id: 'weather-held-visits',
      priority: 'P0',
      kind: 'hold',
      title: 'Visits are on weather hold',
      fact: 'Two visits blocked.',
      recommendation: 'Review weather evidence.',
      source: 'test',
      href: '/dispatch',
      entities: [
        { label: 'JOB-1048', href: '/dispatch' },
        { label: 'JOB-1049', href: '/dispatch' },
      ],
    };
    const glance = deriveOwnerCommandGlance({
      freshness: 'current',
      sourcedAt: '2026-07-31T14:00:00.000Z',
      holds: [stoppingWithMultipleEntities],
      decisions: [],
      followUps: [],
      nextAction: stoppingWithMultipleEntities,
    });
    expect(glance.caveat).toBe(
      'First: Visits are on weather hold. This is not a clearance of hidden records.',
    );
    expect(glance.caveat).not.toContain('JOB-1048');
  });
});
