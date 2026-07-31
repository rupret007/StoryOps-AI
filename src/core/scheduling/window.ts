export interface SchedulingBusinessDay {
  day: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
  closed: boolean;
  opensAt: string;
  closesAt: string;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: SchedulingBusinessDay['day'];
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

function zonedParts(instant: string | Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
  });
  const parts = formatter.formatToParts(typeof instant === 'string' ? new Date(instant) : instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    hour: Number(value('hour')),
    minute: Number(value('minute')),
    weekday: value('weekday').toLowerCase() as ZonedParts['weekday'],
  };
}

function localValue(parts: Omit<ZonedParts, 'weekday'>): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function schedulingLocalDateTimeToIso(value: string, timeZone: string): string {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) throw new Error('Choose a complete appointment date and time.');
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const targetParts = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
  };
  const targetUtc = Date.UTC(
    targetParts.year,
    targetParts.month - 1,
    targetParts.day,
    targetParts.hour,
    targetParts.minute,
  );
  let candidate = targetUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const represented = zonedParts(new Date(candidate), timeZone);
    const representedUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
    );
    candidate += targetUtc - representedUtc;
  }
  const resolved = zonedParts(new Date(candidate), timeZone);
  if (localValue(resolved) !== value) {
    throw new Error(
      `That local time does not exist in ${timeZone}, usually because of a daylight-saving transition.`,
    );
  }
  return new Date(candidate).toISOString();
}

export function schedulingIsoToLocalDateTime(value: string, timeZone: string): string {
  const parts = zonedParts(value, timeZone);
  return localValue(parts);
}

export function suggestNextBusinessStart(input: {
  serverTime: string;
  timeZone: string;
  businessHours: readonly SchedulingBusinessDay[];
  minimumLeadMinutes?: number;
  durationMinutes?: number;
}): string {
  const now = Date.parse(input.serverTime);
  if (!Number.isFinite(now)) throw new Error('Current server time is invalid.');
  const earliest = now + (input.minimumLeadMinutes ?? 120) * 60_000;
  const durationMinutes = input.durationMinutes ?? 60;
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes > 12 * 60) {
    throw new Error('Appointment duration must be between 1 minute and 12 hours.');
  }
  const byDay = new Map(input.businessHours.map((entry) => [entry.day, entry]));

  for (let offset = 0; offset < 15; offset += 1) {
    const probe = new Date(earliest + offset * 24 * 60 * 60 * 1_000);
    const local = zonedParts(probe, input.timeZone);
    const schedule = byDay.get(local.weekday);
    if (!schedule || schedule.closed) continue;
    const [openHour, openMinute] = schedule.opensAt.split(':').map(Number);
    const proposedLocal = localValue({
      year: local.year,
      month: local.month,
      day: local.day,
      hour: openHour ?? 0,
      minute: openMinute ?? 0,
    });
    const proposed = Date.parse(schedulingLocalDateTimeToIso(proposedLocal, input.timeZone));
    const closesLocal = `${String(local.year).padStart(4, '0')}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}T${schedule.closesAt}`;
    const closes = Date.parse(schedulingLocalDateTimeToIso(closesLocal, input.timeZone));
    if (proposed >= earliest && proposed + durationMinutes * 60_000 <= closes) {
      return proposedLocal;
    }

    const rounded = new Date(Math.ceil(earliest / (30 * 60_000)) * 30 * 60_000);
    const roundedParts = zonedParts(rounded, input.timeZone);
    if (
      roundedParts.year === local.year &&
      roundedParts.month === local.month &&
      roundedParts.day === local.day
    ) {
      const roundedLocal = localValue(roundedParts);
      if (Date.parse(rounded.toISOString()) + durationMinutes * 60_000 <= closes) {
        return roundedLocal;
      }
    }
  }
  throw new Error('No open business window was found in the next 15 days.');
}
