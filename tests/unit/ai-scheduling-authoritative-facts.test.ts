import {
  evaluateSchedulingPrerequisites,
  schedulingBookingFactsFromRows,
  schedulingTrustedFactsFromRows,
  type ActionProposal,
  type OfficeRunRequest,
  type SchedulingReceiptRow,
  type SchedulingRouteCheckRow,
  type SchedulingConsumptionRow,
  type SchedulingJobRow,
  type SchedulingVisitRow,
  type SchedulingWeatherCheckRow,
} from '@/core/ai';

const companyId = 'company-1';
const jobId = 'job-1';
const propertyId = 'property-1';
const crewId = 'crew-1';
const startsAt = '2026-07-30T15:00:00.000Z';
const endsAt = '2026-07-30T17:00:00.000Z';

function rows(): {
  receipts: SchedulingReceiptRow[];
  routeChecks: SchedulingRouteCheckRow[];
  weatherChecks: SchedulingWeatherCheckRow[];
} {
  return {
    receipts: [
      {
        id: 'receipt-1',
        company_id: companyId,
        job_id: jobId,
        property_id: propertyId,
        crew_id: crewId,
        starts_at: startsAt,
        ends_at: endsAt,
        evidence_mode: 'live',
        capacity_provider: 'google_calendar',
        capacity_reference: 'google-freebusy-1',
        capacity_disposition: 'eligible',
        capacity_observed_at: '2026-07-29T11:58:00.000Z',
        capacity_expires_at: '2026-07-29T12:03:00.000Z',
        capacity_payload: {
          schemaVersion: 'storyops-capacity-evidence-v1',
          companyId,
          jobId,
          propertyId,
          crewId,
          startsAt,
          endsAt,
          mode: 'live',
          capacity: {
            disposition: 'eligible',
            eligibleCrewIds: [crewId],
            requiredSkillCodes: ['pressure_washing'],
            requiredEquipmentTypes: ['pressure_washer'],
            unknowns: [],
            conflicts: [],
          },
          freeBusy: {
            disposition: 'eligible',
            sourceCalendarIds: ['primary'],
            busyWindows: [],
            unknowns: [],
            conflicts: [],
          },
        },
        route_check_id: 'route-1',
        route_disposition: 'eligible',
        route_observed_at: '2026-07-29T11:45:00.000Z',
        route_expires_at: '2026-07-29T12:15:00.000Z',
        weather_check_id: 'weather-1',
        weather_disposition: 'eligible',
        weather_observed_at: '2026-07-29T11:30:00.000Z',
        weather_expires_at: '2026-07-29T12:30:00.000Z',
        weather_policy_version: 'dfw-weather-v1',
        unknowns: [],
        conflicts: [],
        expires_at: '2026-07-29T12:03:00.000Z',
      },
    ],
    routeChecks: [
      {
        id: 'route-1',
        company_id: companyId,
        provider: 'vroom',
        route_feasible: true,
        violations: [],
      },
    ],
    weatherChecks: [
      {
        id: 'weather-1',
        company_id: companyId,
        provider: 'nws',
        forecast_issued_at: '2026-07-29T10:00:00.000Z',
        policy_disposition: 'eligible',
      },
    ],
  };
}

describe('authoritative scheduling fact adapter', () => {
  it('maps one persisted receipt into three exact facts accepted by the AI boundary', () => {
    const trustedFacts = schedulingTrustedFactsFromRows(rows());
    expect(trustedFacts.map((fact) => fact.name)).toEqual([
      'scheduling.capacity_eligibility',
      'scheduling.weather_eligibility',
      'scheduling.route_eligibility',
    ]);
    expect(new Set(trustedFacts.map((fact) => fact.source))).toEqual(new Set(['database']));

    const proposal: ActionProposal = {
      actionId: 'booking-1',
      toolName: 'calendar.create_booking',
      purpose: 'Create the exact persisted evidence-backed booking.',
      payload: {
        title: 'Exterior cleaning',
        window: { start: startsAt, end: endsAt },
        timeZone: 'America/Chicago',
        jobId,
      },
      risk: 'low',
      reversible: false,
      sourceFactIds: trustedFacts.map((fact) => fact.id),
    };
    const request: OfficeRunRequest = {
      runId: 'run-1',
      companyId,
      agent: 'scheduling',
      objective: 'Book the exact persisted window.',
      actor: { id: 'owner-1', role: 'owner' },
      trustedFacts,
      untrustedContent: [],
      idempotencyKey: 'scheduling-authoritative-key',
      requestedAt: '2026-07-29T12:00:00.000Z',
    };

    expect(
      evaluateSchedulingPrerequisites({
        request,
        proposal,
        now: new Date(request.requestedAt),
      }),
    ).toMatchObject({
      required: true,
      eligible: true,
      evidenceMode: 'live',
    });
  });

  it('emits confirmation truth only after exact receipt consumption and local scheduling', () => {
    const base = rows();
    const consumptions: SchedulingConsumptionRow[] = [
      {
        company_id: companyId,
        evidence_receipt_id: 'receipt-1',
        visit_id: 'visit-1',
        consumed_at: '2026-07-29T12:00:00.000Z',
      },
    ];
    const jobs: SchedulingJobRow[] = [
      {
        id: jobId,
        company_id: companyId,
        assigned_crew_id: crewId,
        status: 'scheduled',
      },
    ];
    const visits: SchedulingVisitRow[] = [
      {
        id: 'visit-1',
        company_id: companyId,
        job_id: jobId,
        crew_id: crewId,
        starts_at: startsAt,
        ends_at: endsAt,
        status: 'planned',
        scheduling_evidence_receipt_id: 'receipt-1',
      },
    ];

    const confirmed = schedulingBookingFactsFromRows({
      receipts: base.receipts,
      consumptions,
      jobs,
      visits,
    });
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      name: 'scheduling.booking_confirmation',
      source: 'database',
      value: { receiptId: 'receipt-1', jobStatus: 'scheduled', visitStatus: 'planned' },
    });

    jobs[0] = { ...jobs[0]!, status: 'ready_to_schedule' };
    expect(
      schedulingBookingFactsFromRows({
        receipts: base.receipts,
        consumptions,
        jobs,
        visits,
      }),
    ).toEqual([]);
  });

  it('fails the authoritative adapter closed on cross-company linked evidence', () => {
    const input = rows();
    input.routeChecks[0] = {
      ...input.routeChecks[0]!,
      company_id: 'company-2',
    };

    expect(() => schedulingTrustedFactsFromRows(input)).toThrow(/cross-company/);
  });
});
