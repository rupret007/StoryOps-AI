import { describe, expect, it } from 'vitest';
import { selectReadyDispatchJobId, selectRoleScopedVisitId } from '@/state/visitSelection';

const completedId = '10000000-0000-4000-8000-000000000641';
const firstUpcomingId = '10000000-0000-4000-8000-000000000642';
const secondUpcomingId = '10000000-0000-4000-8000-000000000643';

describe('role-scoped visit selection', () => {
  const technicianProjection = [
    {
      id: completedId,
      status: 'completed',
      startsAt: '2026-07-29T14:00:00.000Z',
      endsAt: '2026-07-29T16:00:00.000Z',
    },
    {
      id: firstUpcomingId,
      status: 'confirmed',
      startsAt: '2026-07-30T15:00:00.000Z',
      endsAt: '2026-07-30T17:00:00.000Z',
    },
    {
      id: secondUpcomingId,
      status: 'confirmed',
      startsAt: '2026-07-31T14:00:00.000Z',
      endsAt: '2026-07-31T16:00:00.000Z',
    },
  ] as const;

  it('defaults past completed + two assigned upcoming visits to today, not array position', () => {
    expect(
      selectRoleScopedVisitId(technicianProjection, {
        serverTime: '2026-07-30T13:00:00.000Z',
        timeZone: 'America/Chicago',
      }),
    ).toBe(firstUpcomingId);
  });

  it('preserves an explicit visible visit across reload and rejects an out-of-scope preference', () => {
    expect(
      selectRoleScopedVisitId(technicianProjection, {
        preferredVisitId: secondUpcomingId,
        serverTime: '2026-07-30T13:00:00.000Z',
        timeZone: 'America/Chicago',
      }),
    ).toBe(secondUpcomingId);
    expect(
      selectRoleScopedVisitId(technicianProjection, {
        preferredVisitId: '90000000-0000-4000-8000-000000000999',
        serverTime: '2026-07-30T13:00:00.000Z',
        timeZone: 'America/Chicago',
      }),
    ).toBe(firstUpcomingId);
  });

  it('prioritizes exact active work over today and future visits', () => {
    expect(
      selectRoleScopedVisitId(
        [
          ...technicianProjection,
          {
            id: '10000000-0000-4000-8000-000000000644',
            status: 'on_site',
            startsAt: '2026-07-29T18:00:00.000Z',
            endsAt: '2026-07-29T20:00:00.000Z',
          },
        ],
        {
          serverTime: '2026-07-30T13:00:00.000Z',
          timeZone: 'America/Chicago',
        },
      ),
    ).toBe('10000000-0000-4000-8000-000000000644');
  });
});

describe('repeat-use dispatch selection', () => {
  it('selects ready work independently of historical visits and advances when a job is booked', () => {
    const jobs = [
      { id: '20000000-0000-4000-8000-000000000631', status: 'completed' },
      { id: '20000000-0000-4000-8000-000000000632', status: 'ready_to_schedule' },
      { id: '20000000-0000-4000-8000-000000000633', status: 'ready_to_schedule' },
    ];
    expect(selectReadyDispatchJobId(jobs)).toBe('20000000-0000-4000-8000-000000000632');
    expect(selectReadyDispatchJobId(jobs, '20000000-0000-4000-8000-000000000633')).toBe(
      '20000000-0000-4000-8000-000000000633',
    );
    expect(
      selectReadyDispatchJobId(
        jobs.map((job) =>
          job.id === '20000000-0000-4000-8000-000000000633' ? { ...job, status: 'scheduled' } : job,
        ),
        '20000000-0000-4000-8000-000000000633',
      ),
    ).toBe('20000000-0000-4000-8000-000000000632');
  });
});
