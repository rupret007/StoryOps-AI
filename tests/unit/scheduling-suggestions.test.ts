import { describe, expect, it } from 'vitest';
import {
  eligibleCrewsForCandidate,
  generatePolicyCandidateWindows,
  hasExactServiceCatalogCoverage,
  rankCapacityCandidates,
  type SchedulingCapacitySnapshot,
} from '@/core/scheduling/suggestions';
import type { SchedulingBusinessDay } from '@/core/scheduling/window';

const hours: SchedulingBusinessDay[] = [
  { day: 'monday', closed: false, opensAt: '08:00', closesAt: '17:00' },
  { day: 'tuesday', closed: false, opensAt: '08:00', closesAt: '17:00' },
  { day: 'wednesday', closed: false, opensAt: '08:00', closesAt: '17:00' },
  { day: 'thursday', closed: false, opensAt: '08:00', closesAt: '17:00' },
  { day: 'friday', closed: false, opensAt: '08:00', closesAt: '17:00' },
  { day: 'saturday', closed: true, opensAt: '08:00', closesAt: '17:00' },
  { day: 'sunday', closed: true, opensAt: '08:00', closesAt: '17:00' },
];

const crewA = '10000000-0000-4000-8000-000000000601';
const crewB = '10000000-0000-4000-8000-000000000602';

function snapshot(): SchedulingCapacitySnapshot {
  return {
    requiredSkills: ['exterior-cleaning'],
    requiredEquipment: ['pressure-washer'],
    crews: [
      {
        id: crewA,
        name: 'Owner crew',
        active: true,
        skillCodes: ['exterior-cleaning'],
      },
      {
        id: crewB,
        name: 'Relief crew',
        active: true,
        skillCodes: ['exterior-cleaning'],
      },
    ],
    crewMembers: [
      {
        crewId: crewA,
        userId: '10000000-0000-4000-8000-000000000101',
        startsOn: '2026-01-01',
      },
      {
        crewId: crewB,
        userId: '10000000-0000-4000-8000-000000000102',
        startsOn: '2026-01-01',
      },
    ],
    activeFieldMemberships: [
      { userId: '10000000-0000-4000-8000-000000000101', active: true },
      { userId: '10000000-0000-4000-8000-000000000102', active: true },
    ],
    equipment: [
      {
        id: '10000000-0000-4000-8000-000000000701',
        equipmentType: 'pressure-washer',
        status: 'available',
        assignedCrewId: crewA,
        nextInspectionDue: '2026-12-31',
      },
      {
        id: '10000000-0000-4000-8000-000000000702',
        equipmentType: 'pressure-washer',
        status: 'available',
        assignedCrewId: crewB,
        nextInspectionDue: '2026-12-31',
      },
    ],
    reservedEquipmentIds: [],
    conflictingVisits: [],
  };
}

describe('deterministic scheduling suggestions', () => {
  it('requires exact service-catalog membership, not merely matching set sizes', () => {
    expect(hasExactServiceCatalogCoverage(['driveway', 'gutters'], ['driveway', 'gutters'])).toBe(
      true,
    );
    expect(hasExactServiceCatalogCoverage(['driveway', 'gutters'], ['roof', 'windows'])).toBe(
      false,
    );
    expect(hasExactServiceCatalogCoverage(['driveway', 'driveway'], ['driveway'])).toBe(false);
  });

  it('generates bounded business-hour windows after lead time with exact duration', () => {
    const windows = generatePolicyCandidateWindows({
      serverTime: '2026-07-30T14:05:00.000Z',
      timeZone: 'America/Chicago',
      businessHours: hours,
      minimumLeadMinutes: 30,
      maximumBookingDays: 30,
      durationMinutes: 120,
      maximumWindows: 3,
    });

    expect(windows).toEqual([
      {
        start: '2026-07-30T15:00:00.000Z',
        end: '2026-07-30T17:00:00.000Z',
        localStart: '2026-07-30T10:00',
      },
      {
        start: '2026-07-30T15:30:00.000Z',
        end: '2026-07-30T17:30:00.000Z',
        localStart: '2026-07-30T10:30',
      },
      {
        start: '2026-07-30T16:00:00.000Z',
        end: '2026-07-30T18:00:00.000Z',
        localStart: '2026-07-30T11:00',
      },
    ]);
  });

  it('filters conflicting crews and equipment reservations rather than inventing capacity', () => {
    const input = snapshot();
    input.conflictingVisits = [{ crewId: crewA }];
    expect(eligibleCrewsForCandidate(input, '2026-07-30')).toEqual([
      { id: crewB, name: 'Relief crew' },
    ]);

    input.reservedEquipmentIds = ['10000000-0000-4000-8000-000000000702'];
    expect(eligibleCrewsForCandidate(input, '2026-07-30')).toEqual([]);
  });

  it('ranks greater current crew capacity before time and excludes conflicted windows', () => {
    const ranked = rankCapacityCandidates([
      {
        window: {
          start: '2026-08-03T13:00:00.000Z',
          end: '2026-08-03T15:00:00.000Z',
          localStart: '2026-08-03T08:00',
        },
        eligibleCrews: [{ id: crewA, name: 'Owner crew' }],
      },
      {
        window: {
          start: '2026-08-03T13:30:00.000Z',
          end: '2026-08-03T15:30:00.000Z',
          localStart: '2026-08-03T08:30',
        },
        eligibleCrews: [
          { id: crewA, name: 'Owner crew' },
          { id: crewB, name: 'Relief crew' },
        ],
      },
      {
        window: {
          start: '2026-08-03T14:00:00.000Z',
          end: '2026-08-03T16:00:00.000Z',
          localStart: '2026-08-03T09:00',
        },
        eligibleCrews: [],
      },
    ]);

    expect(ranked.map((candidate) => candidate.window.localStart)).toEqual([
      '2026-08-03T08:30',
      '2026-08-03T08:00',
    ]);
  });
});
