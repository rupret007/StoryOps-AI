import { z } from 'zod';
import {
  schedulingIsoToLocalDateTime,
  schedulingLocalDateTimeToIso,
  type SchedulingBusinessDay,
} from './window.ts';

const uuidSchema = z.string().uuid();
const dateTimeSchema = z.string().datetime({ offset: true });

export const schedulingSuggestionsRequestSchema = z
  .object({
    companyId: uuidSchema,
    jobId: uuidSchema,
    expectedJobVersion: z.number().int().positive(),
    crewId: uuidSchema.optional(),
  })
  .strict();

export type SchedulingSuggestionsRequest = z.infer<typeof schedulingSuggestionsRequestSchema>;

const schedulingSuggestionCandidateSchema = z
  .object({
    rank: z.number().int().positive(),
    window: z.object({ start: dateTimeSchema, end: dateTimeSchema }).strict(),
    localStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u),
    crewId: uuidSchema,
    crewName: z.string().min(1).max(160),
    eligibleCrewCount: z.number().int().positive().max(100),
    appointmentBufferMinutes: z.number().int().min(0).max(240),
    requiredSkills: z.array(z.string().min(1).max(100)).max(100),
    requiredEquipment: z.array(z.string().min(1).max(100)).max(100),
    internalEvidence: z
      .object({
        businessHours: z.literal('eligible'),
        leadTime: z.literal('eligible'),
        crew: z.literal('eligible'),
        equipment: z.literal('eligible'),
        visitCapacity: z.literal('eligible'),
      })
      .strict(),
    liveValidation: z
      .object({
        providerCalendar: z.literal('unknown'),
        route: z.literal('unknown'),
        weather: z.literal('unknown'),
      })
      .strict(),
    reasons: z.array(z.string().min(1).max(300)).min(1).max(10),
  })
  .strict();

export type SchedulingSuggestionCandidate = z.infer<typeof schedulingSuggestionCandidateSchema>;

export const schedulingSuggestionsResponseSchema = z
  .object({
    schemaVersion: z.literal('storyops-scheduling-suggestions-v1'),
    operation: z.literal('scheduling.suggestions'),
    status: z.enum(['suggestions_ready', 'no_eligible_candidates']),
    bookable: z.literal(false),
    companyId: uuidSchema,
    jobId: uuidSchema,
    jobVersion: z.number().int().positive(),
    generatedAt: dateTimeSchema,
    timeZone: z.string().min(3).max(80),
    durationMinutes: z
      .number()
      .int()
      .positive()
      .max(12 * 60),
    scannedWindowCount: z.number().int().nonnegative().max(96),
    candidates: z.array(schedulingSuggestionCandidateSchema).max(5),
    unknowns: z.array(z.string().min(1).max(300)).min(3).max(10),
    message: z.string().min(1).max(500),
  })
  .strict()
  .superRefine((response, context) => {
    if (
      (response.status === 'suggestions_ready' && response.candidates.length === 0) ||
      (response.status === 'no_eligible_candidates' && response.candidates.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'Suggestion status must match the candidate list.',
      });
    }
    const ranks = response.candidates.map((candidate) => candidate.rank);
    if (ranks.some((rank, index) => rank !== index + 1)) {
      context.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'Suggestion ranks must be contiguous and ordered.',
      });
    }
  });

export type SchedulingSuggestionsResponse = z.infer<typeof schedulingSuggestionsResponseSchema>;

export interface CandidateWindow {
  start: string;
  end: string;
  localStart: string;
}

export function hasExactServiceCatalogCoverage(
  jobServiceCodes: readonly string[],
  catalogServiceCodes: readonly string[],
): boolean {
  const jobs = new Set(jobServiceCodes);
  const catalog = new Set(catalogServiceCodes);
  return (
    jobServiceCodes.length > 0 &&
    jobs.size === jobServiceCodes.length &&
    catalog.size === catalogServiceCodes.length &&
    jobs.size === catalog.size &&
    [...jobs].every((code) => catalog.has(code))
  );
}

function localDateKey(instant: string, timeZone: string): string {
  return schedulingIsoToLocalDateTime(instant, timeZone).slice(0, 10);
}

function addLocalDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
  return `${String(value.getUTCFullYear()).padStart(4, '0')}-${String(
    value.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function weekdayForLocalDate(localDate: string, timeZone: string): SchedulingBusinessDay['day'] {
  const noon = schedulingLocalDateTimeToIso(`${localDate}T12:00`, timeZone);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
  })
    .format(new Date(noon))
    .toLowerCase() as SchedulingBusinessDay['day'];
}

function validDuration(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 12 * 60;
}

/**
 * Produces bounded, deterministic policy windows only. It does not claim
 * capacity, provider-calendar availability, route feasibility, or weather.
 */
export function generatePolicyCandidateWindows(input: {
  serverTime: string;
  timeZone: string;
  businessHours: readonly SchedulingBusinessDay[];
  minimumLeadMinutes: number;
  maximumBookingDays: number;
  durationMinutes: number;
  intervalMinutes?: number;
  maximumWindows?: number;
}): CandidateWindow[] {
  const serverTime = Date.parse(input.serverTime);
  if (!Number.isFinite(serverTime)) throw new Error('Current server time is invalid.');
  if (!validDuration(input.durationMinutes)) {
    throw new Error('Appointment duration must be between 1 minute and 12 hours.');
  }
  if (!Number.isInteger(input.minimumLeadMinutes) || input.minimumLeadMinutes < 0) {
    throw new Error('Minimum scheduling lead time is invalid.');
  }
  if (
    !Number.isInteger(input.maximumBookingDays) ||
    input.maximumBookingDays < 1 ||
    input.maximumBookingDays > 730
  ) {
    throw new Error('Maximum booking horizon is invalid.');
  }
  const intervalMinutes = input.intervalMinutes ?? 30;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 240) {
    throw new Error('Scheduling interval must be between 15 and 240 minutes.');
  }
  const maximumWindows = input.maximumWindows ?? 32;
  if (!Number.isInteger(maximumWindows) || maximumWindows < 1 || maximumWindows > 96) {
    throw new Error('Scheduling candidate bound must be between 1 and 96.');
  }

  const earliest = serverTime + input.minimumLeadMinutes * 60_000;
  const horizon = serverTime + input.maximumBookingDays * 24 * 60 * 60_000;
  const firstDate = localDateKey(new Date(earliest).toISOString(), input.timeZone);
  const hoursByDay = new Map(input.businessHours.map((entry) => [entry.day, entry]));
  const candidates: CandidateWindow[] = [];

  for (
    let offset = 0;
    offset <= input.maximumBookingDays && candidates.length < maximumWindows;
    offset += 1
  ) {
    const localDate = addLocalDays(firstDate, offset);
    const schedule = hoursByDay.get(weekdayForLocalDate(localDate, input.timeZone));
    if (!schedule || schedule.closed) continue;
    const opening = Date.parse(
      schedulingLocalDateTimeToIso(`${localDate}T${schedule.opensAt}`, input.timeZone),
    );
    const closing = Date.parse(
      schedulingLocalDateTimeToIso(`${localDate}T${schedule.closesAt}`, input.timeZone),
    );
    const intervalMs = intervalMinutes * 60_000;
    let start = Math.max(opening, Math.ceil(earliest / intervalMs) * intervalMs);
    while (
      start + input.durationMinutes * 60_000 <= closing &&
      start <= horizon &&
      candidates.length < maximumWindows
    ) {
      const startIso = new Date(start).toISOString();
      candidates.push({
        start: startIso,
        end: new Date(start + input.durationMinutes * 60_000).toISOString(),
        localStart: schedulingIsoToLocalDateTime(startIso, input.timeZone),
      });
      start += intervalMs;
    }
  }
  return candidates;
}

export interface SchedulingSnapshotCrew {
  id: string;
  name: string;
  active: boolean;
  skillCodes: string[];
}

export interface SchedulingSnapshotCrewMember {
  crewId: string;
  userId: string;
  startsOn: string;
  endsOn?: string;
}

export interface SchedulingSnapshotMembership {
  userId: string;
  active: boolean;
}

export interface SchedulingSnapshotEquipment {
  id: string;
  equipmentType: string;
  status: string;
  assignedCrewId?: string;
  nextInspectionDue?: string;
}

export interface SchedulingSnapshotVisit {
  crewId: string;
}

export interface SchedulingCapacitySnapshot {
  requiredSkills: string[];
  requiredEquipment: string[];
  crews: SchedulingSnapshotCrew[];
  crewMembers: SchedulingSnapshotCrewMember[];
  activeFieldMemberships: SchedulingSnapshotMembership[];
  equipment: SchedulingSnapshotEquipment[];
  reservedEquipmentIds: string[];
  conflictingVisits: SchedulingSnapshotVisit[];
}

export interface EligibleCrewCapacity {
  id: string;
  name: string;
}

export interface EvaluatedSchedulingCandidate {
  window: CandidateWindow;
  eligibleCrews: EligibleCrewCapacity[];
}

export function rankCapacityCandidates(
  candidates: readonly EvaluatedSchedulingCandidate[],
  limit = 5,
): EvaluatedSchedulingCandidate[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('Scheduling suggestion rank limit must be between 1 and 20.');
  }
  return candidates
    .filter((candidate) => candidate.eligibleCrews.length > 0)
    .sort(
      (left, right) =>
        right.eligibleCrews.length - left.eligibleCrews.length ||
        Date.parse(left.window.start) - Date.parse(right.window.start) ||
        left.eligibleCrews[0]!.id.localeCompare(right.eligibleCrews[0]!.id),
    )
    .slice(0, limit);
}

/**
 * Applies the same internal crew/equipment/open-window conditions that the
 * write-capable scheduling-evidence boundary rechecks later. This result is a
 * read-only candidate fact and can never authorize a booking.
 */
export function eligibleCrewsForCandidate(
  snapshot: SchedulingCapacitySnapshot,
  localServiceDate: string,
  requestedCrewId?: string,
): EligibleCrewCapacity[] {
  const activeFieldWorkerIds = new Set(
    snapshot.activeFieldMemberships
      .filter((membership) => membership.active)
      .map((membership) => membership.userId),
  );
  const reservedEquipmentIds = new Set(snapshot.reservedEquipmentIds);
  const conflictingCrewIds = new Set(snapshot.conflictingVisits.map((visit) => visit.crewId));
  const requiredSkills = [...new Set(snapshot.requiredSkills)];
  const requiredEquipment = [...new Set(snapshot.requiredEquipment)];

  return snapshot.crews
    .filter((crew) => crew.active && (!requestedCrewId || crew.id === requestedCrewId))
    .filter((crew) => requiredSkills.every((skill) => crew.skillCodes.includes(skill)))
    .filter((crew) => {
      const scheduledMembers = snapshot.crewMembers.filter(
        (member) =>
          member.crewId === crew.id &&
          member.startsOn <= localServiceDate &&
          (!member.endsOn || member.endsOn >= localServiceDate),
      );
      return (
        scheduledMembers.length > 0 &&
        scheduledMembers.every((member) => activeFieldWorkerIds.has(member.userId))
      );
    })
    .filter((crew) =>
      requiredEquipment.every((equipmentType) =>
        snapshot.equipment.some(
          (equipment) =>
            equipment.equipmentType === equipmentType &&
            !reservedEquipmentIds.has(equipment.id) &&
            (equipment.status === 'available' || equipment.status === 'assigned') &&
            (!equipment.assignedCrewId || equipment.assignedCrewId === crew.id) &&
            (!equipment.nextInspectionDue || equipment.nextInspectionDue >= localServiceDate),
        ),
      ),
    )
    .filter((crew) => !conflictingCrewIds.has(crew.id))
    .map((crew) => ({ id: crew.id, name: crew.name }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export const schedulingSuggestionUnknowns = [
  'Google Calendar free/busy is unknown until the operator verifies this exact window.',
  'Route feasibility and travel time are unknown until VROOM validates this exact crew-day route.',
  'Service-window weather is unknown until fresh NWS evidence is evaluated against policy.',
] as const;
