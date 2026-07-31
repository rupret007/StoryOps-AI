import { describe, expect, it } from 'vitest';
import {
  schedulingIsoToLocalDateTime,
  schedulingLocalDateTimeToIso,
  suggestNextBusinessStart,
  type SchedulingBusinessDay,
} from '@/core/scheduling/window';

const hours: SchedulingBusinessDay[] = [
  { day: 'monday', closed: false, opensAt: '08:00', closesAt: '17:00' },
  { day: 'tuesday', closed: false, opensAt: '08:00', closesAt: '17:00' },
  { day: 'wednesday', closed: false, opensAt: '08:00', closesAt: '17:00' },
  { day: 'thursday', closed: false, opensAt: '08:00', closesAt: '17:00' },
  { day: 'friday', closed: false, opensAt: '08:00', closesAt: '17:00' },
  { day: 'saturday', closed: true, opensAt: '08:00', closesAt: '17:00' },
  { day: 'sunday', closed: true, opensAt: '08:00', closesAt: '17:00' },
];

describe('scheduling window time-zone conversion', () => {
  it('round-trips a DFW local appointment independently of browser timezone', () => {
    const instant = schedulingLocalDateTimeToIso('2026-07-30T09:30', 'America/Chicago');
    expect(instant).toBe('2026-07-30T14:30:00.000Z');
    expect(schedulingIsoToLocalDateTime(instant, 'America/Chicago')).toBe('2026-07-30T09:30');
  });

  it('rejects a nonexistent daylight-saving local time', () => {
    expect(() => schedulingLocalDateTimeToIso('2026-03-08T02:30', 'America/Chicago')).toThrow(
      /does not exist/u,
    );
  });

  it('suggests the next configured business opening', () => {
    expect(
      suggestNextBusinessStart({
        serverTime: '2026-07-31T22:30:00.000Z',
        timeZone: 'America/Chicago',
        businessHours: hours,
      }),
    ).toBe('2026-08-03T08:00');
  });

  it('suggests a rounded same-day opening when lead time remains inside hours', () => {
    expect(
      suggestNextBusinessStart({
        serverTime: '2026-07-30T14:05:00.000Z',
        timeZone: 'America/Chicago',
        businessHours: hours,
        minimumLeadMinutes: 30,
      }),
    ).toBe('2026-07-30T10:00');
  });
});
