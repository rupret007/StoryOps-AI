import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  eligibleCrewsForCandidate,
  generatePolicyCandidateWindows,
  hasExactServiceCatalogCoverage,
  rankCapacityCandidates,
  schedulingSuggestionUnknowns,
  schedulingSuggestionsRequestSchema,
  schedulingSuggestionsResponseSchema,
  type CandidateWindow,
  type SchedulingCapacitySnapshot,
  type SchedulingSuggestionCandidate,
} from '../../../src/core/scheduling/suggestions.ts';
import { consumeOperationBudget } from '../../../src/core/integrations/operationBudget.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';

type Row = Record<string, unknown>;

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new HttpError(`Server configuration ${name} is missing.`, 503, 'MISCONFIGURED');
  }
  return value;
}

function record(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(`${label} is invalid.`, 503, 'AUTHORITATIVE_DATA_INVALID');
  }
  return value as Row;
}

function records(value: unknown, label: string): Row[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
  ) {
    throw new HttpError(`${label} is invalid.`, 503, 'AUTHORITATIVE_DATA_INVALID');
  }
  return value as Row[];
}

function text(row: Row, key: string, label = key): string {
  const value = row[key];
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  throw new HttpError(`${label} is missing.`, 503, 'AUTHORITATIVE_DATA_INVALID');
}

function optionalText(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integer(row: Row, key: string, label = key): number {
  const value = Number(row[key]);
  if (!Number.isInteger(value)) {
    throw new HttpError(`${label} is invalid.`, 503, 'AUTHORITATIVE_DATA_INVALID');
  }
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HttpError(`${label} is invalid.`, 503, 'AUTHORITATIVE_DATA_INVALID');
  }
  return value;
}

async function authenticate(
  client: SupabaseClient,
  authorization: string | null,
  companyId: string,
): Promise<string> {
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
  }
  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser(authorization.slice('Bearer '.length));
  if (authError || !user) {
    throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
  }
  const { data, error } = await client.rpc('load_storyops_edge_actor', {
    p_company_id: companyId,
    p_actor_user_id: user.id,
  });
  if (error) {
    throw new HttpError('Company membership could not be verified.', 503, 'MEMBERSHIP_UNAVAILABLE');
  }
  const actor = record(data, 'Company membership');
  if (
    actor.company_id !== companyId ||
    actor.user_id !== user.id ||
    actor.active !== true ||
    (actor.role !== 'owner' && actor.role !== 'dispatcher')
  ) {
    throw new HttpError(
      'Only an active owner or dispatcher may request scheduling suggestions.',
      403,
      'ROLE_FORBIDDEN',
    );
  }
  return user.id;
}

async function loadCandidate(
  client: SupabaseClient,
  input: {
    companyId: string;
    actorUserId: string;
    jobId: string;
    window: CandidateWindow;
    crewId?: string;
  },
): Promise<Row> {
  const { data, error } = await client.rpc('load_storyops_scheduling_candidate', {
    p_company_id: input.companyId,
    p_actor_user_id: input.actorUserId,
    p_job_id: input.jobId,
    p_window_start: input.window.start,
    p_window_end: input.window.end,
    p_crew_id: input.crewId ?? null,
  });
  if (error) {
    throw new HttpError(
      'Authoritative scheduling facts could not be loaded.',
      503,
      'SUGGESTION_FACTS_UNAVAILABLE',
    );
  }
  return record(data, 'Scheduling candidate facts');
}

function validatedStaticFacts(
  snapshot: Row,
  expectedJobVersion: number,
): {
  timeZone: string;
  durationMinutes: number;
  configuration: Row;
  requiredSkills: string[];
  requiredEquipment: string[];
} {
  const job = record(snapshot.job, 'Scheduling job');
  const company = record(snapshot.company, 'Scheduling company');
  const configurationVersion = record(snapshot.configuration, 'Scheduling configuration');
  const estimate = record(snapshot.estimate, 'Scheduling estimate');
  const baseline = record(snapshot.baseline, 'Scheduling operating baseline');
  const catalog = records(snapshot.catalog, 'Scheduling service catalog');
  const serviceCodes = strings(job.service_codes, 'Job service codes');

  if (job.status !== 'ready_to_schedule' || integer(job, 'version') !== expectedJobVersion) {
    throw new HttpError(
      'The selected job is no longer ready at the expected version.',
      409,
      'JOB_VERSION_OR_STATUS_CONFLICT',
    );
  }
  if (company.status !== 'active') {
    throw new HttpError(
      'The company is not active for scheduling suggestions.',
      409,
      'COMPANY_NOT_ACTIVE',
    );
  }
  if (
    configurationVersion.status !== 'published' ||
    configurationVersion.publication_mode !== 'live' ||
    baseline.status !== 'active' ||
    integer(baseline, 'configuration_revision') !== integer(configurationVersion, 'revision')
  ) {
    throw new HttpError(
      'A matching live published configuration and operating baseline are required.',
      409,
      'ACTIVE_BASELINE_REQUIRED',
    );
  }
  if (
    !hasExactServiceCatalogCoverage(
      serviceCodes,
      catalog.map((service) => text(service, 'code')),
    )
  ) {
    throw new HttpError(
      'Every job service must resolve to a current active catalog requirement.',
      422,
      'SERVICE_REQUIREMENTS_MISSING',
    );
  }
  const durationMinutes = integer(estimate, 'duration_minutes');
  if (durationMinutes <= 0 || durationMinutes > 12 * 60) {
    throw new HttpError(
      'The deterministic estimate duration is unavailable.',
      422,
      'DURATION_MISSING',
    );
  }
  return {
    timeZone: text(company, 'timezone'),
    durationMinutes,
    configuration: record(configurationVersion.configuration, 'Configuration payload'),
    requiredSkills: [
      ...new Set(catalog.flatMap((service) => strings(service.required_skills, 'Required skills'))),
    ].sort(),
    requiredEquipment: [
      ...new Set(
        catalog.flatMap((service) =>
          strings(service.required_equipment_types, 'Required equipment'),
        ),
      ),
    ].sort(),
  };
}

function capacitySnapshot(
  snapshot: Row,
  requiredSkills: string[],
  requiredEquipment: string[],
): SchedulingCapacitySnapshot {
  return {
    requiredSkills,
    requiredEquipment,
    crews: records(snapshot.crews, 'Crews').map((crew) => ({
      id: text(crew, 'id'),
      name: text(crew, 'name'),
      active: crew.active === true,
      skillCodes: strings(crew.skill_codes, 'Crew skill codes'),
    })),
    crewMembers: records(snapshot.crew_members, 'Crew members').map((member) => ({
      crewId: text(member, 'crew_id'),
      userId: text(member, 'user_id'),
      startsOn: text(member, 'starts_on'),
      endsOn: optionalText(member, 'ends_on'),
    })),
    activeFieldMemberships: records(
      snapshot.technician_memberships,
      'Field worker memberships',
    ).map((membership) => ({
      userId: text(membership, 'user_id'),
      active: membership.active === true,
    })),
    equipment: records(snapshot.equipment, 'Equipment').map((equipment) => ({
      id: text(equipment, 'id'),
      equipmentType: text(equipment, 'equipment_type'),
      status: text(equipment, 'status'),
      assignedCrewId: optionalText(equipment, 'assigned_crew_id'),
      nextInspectionDue: optionalText(equipment, 'next_inspection_due'),
    })),
    reservedEquipmentIds: records(snapshot.equipment_reservations, 'Equipment reservations').map(
      (reservation) => text(reservation, 'equipment_id'),
    ),
    conflictingVisits: records(snapshot.visits, 'Conflicting visits').map((visit) => ({
      crewId: text(visit, 'crew_id'),
    })),
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }

  try {
    const rawBody = await readTextBody(request, 8_192);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = schedulingSuggestionsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        'Request must contain only company, job version, and optional crew identity.',
        400,
        'INVALID_REQUEST',
      );
    }
    const input = parsed.data;
    const serviceClient = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const actorUserId = await authenticate(
      serviceClient,
      request.headers.get('authorization'),
      input.companyId,
    );
    const budget = await consumeOperationBudget({
      client: serviceClient,
      companyId: input.companyId,
      scope: 'scheduling-suggestions:user:hour',
      subject: actorUserId,
      limit: 20,
      windowSeconds: 3_600,
    });
    if (!budget.allowed) {
      throw new HttpError(
        `Scheduling suggestion limit reached; retry after ${budget.reset_at}.`,
        429,
        'RATE_LIMITED',
      );
    }

    const generatedAt = new Date().toISOString();
    const bootstrapWindow: CandidateWindow = {
      start: generatedAt,
      end: new Date(Date.parse(generatedAt) + 60_000).toISOString(),
      localStart: '',
    };
    const bootstrap = await loadCandidate(serviceClient, {
      companyId: input.companyId,
      actorUserId,
      jobId: input.jobId,
      window: bootstrapWindow,
      ...(input.crewId ? { crewId: input.crewId } : {}),
    });
    const staticFacts = validatedStaticFacts(bootstrap, input.expectedJobVersion);
    const schedule = record(staticFacts.configuration.schedule, 'Schedule configuration');
    const businessHours = records(schedule.businessHours, 'Business hours').map((day) => ({
      day: text(day, 'day') as
        'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday',
      closed: day.closed === true,
      opensAt: text(day, 'opensAt'),
      closesAt: text(day, 'closesAt'),
    }));
    const appointmentBufferMinutes = integer(schedule, 'appointmentBufferMinutes');
    const policyWindows = generatePolicyCandidateWindows({
      serverTime: generatedAt,
      timeZone: staticFacts.timeZone,
      businessHours,
      minimumLeadMinutes: integer(schedule, 'minimumLeadTimeHours') * 60,
      maximumBookingDays: integer(schedule, 'maximumBookingDays'),
      durationMinutes: staticFacts.durationMinutes,
      intervalMinutes: 30,
      maximumWindows: 32,
    });

    const evaluated = await Promise.all(
      policyWindows.map(async (window) => {
        const snapshot = await loadCandidate(serviceClient, {
          companyId: input.companyId,
          actorUserId,
          jobId: input.jobId,
          window,
          ...(input.crewId ? { crewId: input.crewId } : {}),
        });
        validatedStaticFacts(snapshot, input.expectedJobVersion);
        const eligibleCrews = eligibleCrewsForCandidate(
          capacitySnapshot(snapshot, staticFacts.requiredSkills, staticFacts.requiredEquipment),
          window.localStart.slice(0, 10),
          input.crewId,
        );
        return { window, eligibleCrews };
      }),
    );

    const candidates: SchedulingSuggestionCandidate[] = rankCapacityCandidates(evaluated).map(
      (candidate, index) => {
        const selectedCrew = candidate.eligibleCrews[0];
        if (!selectedCrew) {
          throw new HttpError(
            'Scheduling candidate ranking lost its eligible crew.',
            503,
            'AUTHORITATIVE_DATA_INVALID',
          );
        }
        return {
          rank: index + 1,
          window: { start: candidate.window.start, end: candidate.window.end },
          localStart: candidate.window.localStart,
          crewId: selectedCrew.id,
          crewName: selectedCrew.name,
          eligibleCrewCount: candidate.eligibleCrews.length,
          appointmentBufferMinutes,
          requiredSkills: staticFacts.requiredSkills,
          requiredEquipment: staticFacts.requiredEquipment,
          internalEvidence: {
            businessHours: 'eligible',
            leadTime: 'eligible',
            crew: 'eligible',
            equipment: 'eligible',
            visitCapacity: 'eligible',
          },
          liveValidation: {
            providerCalendar: 'unknown',
            route: 'unknown',
            weather: 'unknown',
          },
          reasons: [
            `${candidate.eligibleCrews.length} current crew${candidate.eligibleCrews.length === 1 ? '' : 's'} satisfy internal skills, membership, equipment, inspection, reservation, visit-conflict, and ${appointmentBufferMinutes}-minute buffer checks.`,
            'Google Calendar, VROOM, and NWS remain unknown until this exact candidate is verified.',
          ],
        };
      },
    );

    return jsonResponse(
      schedulingSuggestionsResponseSchema.parse({
        schemaVersion: 'storyops-scheduling-suggestions-v1',
        operation: 'scheduling.suggestions',
        status: candidates.length > 0 ? 'suggestions_ready' : 'no_eligible_candidates',
        bookable: false,
        companyId: input.companyId,
        jobId: input.jobId,
        jobVersion: input.expectedJobVersion,
        generatedAt,
        timeZone: staticFacts.timeZone,
        durationMinutes: staticFacts.durationMinutes,
        scannedWindowCount: policyWindows.length,
        candidates,
        unknowns: schedulingSuggestionUnknowns,
        message:
          candidates.length > 0
            ? 'Ranked internal-capacity candidates are ready for operator review. None is available or bookable until exact live validation succeeds.'
            : 'No internally eligible candidate was found in the bounded search. No availability was inferred.',
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
});
