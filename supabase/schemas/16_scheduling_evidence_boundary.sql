-- Immutable, provider-distinguishing scheduling evidence and the only
-- customer-visible booking promotion boundary.
--
-- This migration deliberately keeps the existing finite golden-path command
-- implementation as a private implementation detail. A new wrapper binds that
-- implementation to one live, fresh, company-owned receipt and uses a
-- protected transaction authorization row so direct DML and custom GUCs cannot
-- spoof a promotion.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create extension if not exists btree_gist with schema extensions;

alter table public.visits
  add constraint visits_no_active_crew_overlap
  exclude using gist (
    company_id with =,
    crew_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  )
  where (status <> 'cancelled');

create or replace function private.storyops_crew_has_authorized_technicians(
  p_company_id uuid,
  p_crew_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    p_ends_at > p_starts_at
    and not exists (
      select 1
      from public.crew_members member
      where member.company_id = p_company_id
        and member.crew_id = p_crew_id
        and member.starts_on <= p_ends_at::date
        and (member.ends_on is null or member.ends_on >= p_starts_at::date)
        and not exists (
          select 1
          from public.company_memberships membership
          where membership.company_id = member.company_id
            and membership.user_id = member.user_id
            and membership.active
            and membership.role = 'technician'
        )
    )
    and not exists (
      select 1
      from generate_series(
        p_starts_at::date,
        p_ends_at::date,
        interval '1 day'
      ) service_day
      where not exists (
        select 1
        from public.crew_members member
        join public.company_memberships membership
          on membership.company_id = member.company_id
          and membership.user_id = member.user_id
          and membership.active
          and membership.role = 'technician'
        where member.company_id = p_company_id
          and member.crew_id = p_crew_id
          and member.starts_on <= service_day::date
          and (
            member.ends_on is null
            or member.ends_on >= service_day::date
          )
      )
    );
$$;

create or replace function private.storyops_route_context_is_current(
  p_company_id uuid,
  p_job_id uuid,
  p_property_id uuid,
  p_crew_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_payload jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  operating_starts_at timestamptz;
  operating_ends_at timestamptz;
  committed_visits jsonb;
  committed_count integer;
  target_property public.properties%rowtype;
begin
  if p_company_id is null
    or p_job_id is null
    or p_property_id is null
    or p_crew_id is null
    or p_starts_at is null
    or p_ends_at is null
    or p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or p_payload ->> 'schemaVersion' <> 'storyops-route-context-v1'
    or p_payload ->> 'jobId' <> p_job_id::text
    or p_payload ->> 'targetRoutingJobId' <> 'candidate:' || p_job_id::text
    or p_payload ->> 'propertyId' <> p_property_id::text
    or p_payload ->> 'crewId' <> p_crew_id::text
    or jsonb_typeof(p_payload -> 'destination') <> 'object'
    or jsonb_typeof(p_payload -> 'operatingWindow') <> 'object'
    or jsonb_typeof(p_payload -> 'committedVisits') <> 'array'
    or jsonb_typeof(p_payload -> 'requiredSkills') <> 'array'
    or jsonb_typeof(p_payload -> 'requiredEquipment') <> 'array'
  then
    return false;
  end if;

  operating_starts_at :=
    (p_payload #>> '{operatingWindow,start}')::timestamptz;
  operating_ends_at :=
    (p_payload #>> '{operatingWindow,end}')::timestamptz;
  committed_visits := p_payload -> 'committedVisits';
  committed_count := jsonb_array_length(committed_visits);
  if (p_payload ->> 'startsAt')::timestamptz <> p_starts_at
    or (p_payload ->> 'endsAt')::timestamptz <> p_ends_at
    or operating_ends_at <= operating_starts_at
    or operating_starts_at > p_starts_at
    or operating_ends_at < p_ends_at
    or committed_count > 50
    or exists (
      select 1
      from jsonb_array_elements(committed_visits) context(value)
      where jsonb_typeof(context.value) <> 'object'
        or jsonb_typeof(context.value -> 'location') <> 'object'
    )
  then
    return false;
  end if;

  select *
  into target_property
  from public.properties property
  where property.id = p_property_id
    and property.company_id = p_company_id;
  if not found
    or target_property.version
      <> (p_payload ->> 'propertyVersion')::integer
    or target_property.latitude is null
    or target_property.longitude is null
    or target_property.geocode_confidence is null
    or target_property.geocode_confidence < 0.8
    or target_property.geocoded_at is null
    or target_property.latitude
      <> (p_payload #>> '{destination,latitude}')::numeric
    or target_property.longitude
      <> (p_payload #>> '{destination,longitude}')::numeric
  then
    return false;
  end if;

  if (
    select count(distinct context.value ->> 'visitId')
    from jsonb_array_elements(committed_visits) context(value)
  ) <> committed_count
  then
    return false;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(committed_visits) context(value)
    left join public.visits visit
      on visit.id = (context.value ->> 'visitId')::uuid
      and visit.company_id = p_company_id
      and visit.crew_id = p_crew_id
    left join public.jobs job
      on job.id = visit.job_id
      and job.company_id = p_company_id
    left join public.properties property
      on property.id = job.property_id
      and property.company_id = p_company_id
    where visit.id is null
      or visit.status = 'cancelled'
      or context.value ->> 'routingJobId'
        <> 'visit:' || visit.id::text
      or (context.value ->> 'visitVersion')::integer <> visit.version
      or context.value ->> 'visitStatus' <> visit.status
      or context.value ->> 'jobId' <> job.id::text
      or (context.value ->> 'jobVersion')::integer <> job.version
      or context.value ->> 'propertyId' <> property.id::text
      or (context.value ->> 'propertyVersion')::integer <> property.version
      or (context.value ->> 'startsAt')::timestamptz <> visit.starts_at
      or (context.value ->> 'endsAt')::timestamptz <> visit.ends_at
      or property.latitude is null
      or property.longitude is null
      or property.geocode_confidence is null
      or property.geocode_confidence < 0.8
      or property.geocoded_at is null
      or property.latitude
        <> (context.value #>> '{location,latitude}')::numeric
      or property.longitude
        <> (context.value #>> '{location,longitude}')::numeric
      or property.geocoded_at
        <> (context.value ->> 'geocodedAt')::timestamptz
  ) then
    return false;
  end if;

  -- Set equality prevents an otherwise valid payload from silently omitting a
  -- preceding or following committed visit for this crew day.
  if (
    select count(*)
    from public.visits visit
    where visit.company_id = p_company_id
      and visit.crew_id = p_crew_id
      and visit.status <> 'cancelled'
      and visit.starts_at < operating_ends_at
      and visit.ends_at > operating_starts_at
  ) <> committed_count
    or exists (
      select 1
      from public.visits visit
      where visit.company_id = p_company_id
        and visit.crew_id = p_crew_id
        and visit.status <> 'cancelled'
        and visit.starts_at < operating_ends_at
        and visit.ends_at > operating_starts_at
        and not exists (
          select 1
          from jsonb_array_elements(committed_visits) context(value)
          where context.value ->> 'visitId' = visit.id::text
        )
    )
  then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end;
$$;

create or replace function private.storyops_route_response_matches_context(
  p_request jsonb,
  p_response jsonb
)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  expected_count integer;
  expected_baseline_service_seconds bigint;
  expected_service_seconds bigint;
begin
  if jsonb_typeof(p_request) <> 'object'
    or jsonb_typeof(p_response) <> 'object'
    or p_request ->> 'schemaVersion' <> 'storyops-route-context-v1'
    or p_response ->> 'provider' <> 'vroom'
    or p_response ->> 'vehicleId' <> p_request ->> 'crewId'
    or jsonb_typeof(p_response -> 'jobIds') <> 'array'
    or jsonb_typeof(p_response -> 'unassignedJobIds') <> 'array'
    or jsonb_typeof(p_response -> 'summary') <> 'object'
    or jsonb_typeof(p_response -> 'baseline') <> 'object'
    or jsonb_typeof(p_response -> 'incremental') <> 'object'
    or jsonb_typeof(p_response #> '{baseline,jobIds}') <> 'array'
    or jsonb_typeof(p_response #> '{baseline,unassignedJobIds}')
      <> 'array'
  then
    return false;
  end if;

  expected_count :=
    jsonb_array_length(p_request -> 'committedVisits') + 1;
  expected_baseline_service_seconds := coalesce((
      select sum(extract(
        epoch from (
          (context.value ->> 'endsAt')::timestamptz
          - (context.value ->> 'startsAt')::timestamptz
        )
      )::bigint)
      from jsonb_array_elements(
        p_request -> 'committedVisits'
      ) context(value)
    ), 0);
  expected_service_seconds :=
    extract(
      epoch from (
        (p_request ->> 'endsAt')::timestamptz
        - (p_request ->> 'startsAt')::timestamptz
      )
    )::bigint
    + expected_baseline_service_seconds;

  if jsonb_array_length(p_response -> 'unassignedJobIds') <> 0
    or jsonb_array_length(p_response -> 'jobIds') <> expected_count
    or (
      select count(distinct value)
      from jsonb_array_elements_text(p_response -> 'jobIds') routed(value)
    ) <> expected_count
    or not (
      p_response -> 'jobIds' ? (p_request ->> 'targetRoutingJobId')
    )
    or exists (
      select 1
      from jsonb_array_elements(
        p_request -> 'committedVisits'
      ) context(value)
      where not (
        p_response -> 'jobIds' ? (context.value ->> 'routingJobId')
      )
    )
    or (p_response ->> 'serviceSeconds')::bigint
      <> expected_service_seconds
    or (p_response #>> '{summary,serviceSeconds}')::bigint
      <> expected_service_seconds
    or jsonb_array_length(
      p_response #> '{baseline,unassignedJobIds}'
    ) <> 0
    or jsonb_array_length(p_response #> '{baseline,jobIds}')
      <> expected_count - 1
    or (
      select count(distinct value)
      from jsonb_array_elements_text(
        p_response #> '{baseline,jobIds}'
      ) routed(value)
    ) <> expected_count - 1
    or exists (
      select 1
      from jsonb_array_elements(
        p_request -> 'committedVisits'
      ) context(value)
      where not (
        p_response #> '{baseline,jobIds}'
          ? (context.value ->> 'routingJobId')
      )
    )
    or (p_response #>> '{baseline,serviceSeconds}')::bigint
      <> expected_baseline_service_seconds
    or (p_response ->> 'travelSeconds')::bigint
      < (p_response #>> '{baseline,travelSeconds}')::bigint
    or (p_response ->> 'distanceMeters')::numeric
      < (p_response #>> '{baseline,distanceMeters}')::numeric
    or (p_response #>> '{incremental,travelSeconds}')::bigint
      <> (p_response ->> 'travelSeconds')::bigint
        - (p_response #>> '{baseline,travelSeconds}')::bigint
    or (p_response #>> '{incremental,distanceMeters}')::numeric
      <> (p_response ->> 'distanceMeters')::numeric
        - (p_response #>> '{baseline,distanceMeters}')::numeric
  then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end;
$$;

create table public.scheduling_evidence_receipts (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null default 'storyops-scheduling-evidence-v1'
    check (schema_version = 'storyops-scheduling-evidence-v1'),
  company_id uuid not null references public.companies(id) on delete restrict,
  job_id uuid not null references public.jobs(id) on delete restrict,
  job_version integer not null check (job_version > 0),
  property_id uuid not null references public.properties(id) on delete restrict,
  crew_id uuid not null references public.crews(id) on delete restrict,
  crew_version integer not null check (crew_version > 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  evidence_mode text not null check (evidence_mode in ('live', 'sandbox')),
  configuration_revision integer not null check (configuration_revision > 0),
  capacity_provider text not null
    check (capacity_provider in ('google_calendar', 'mock')),
  capacity_reference text not null
    check (length(btrim(capacity_reference)) between 1 and 500),
  capacity_disposition text not null
    check (capacity_disposition in ('eligible', 'ineligible', 'unknown')),
  capacity_observed_at timestamptz not null,
  capacity_expires_at timestamptz not null,
  capacity_payload jsonb not null check (jsonb_typeof(capacity_payload) = 'object'),
  capacity_payload_hash text not null
    check (capacity_payload_hash ~ '^[a-f0-9]{64}$'),
  calendar_event_id text
    check (calendar_event_id is null or length(btrim(calendar_event_id)) between 1 and 500),
  calendar_event_status text not null
    check (calendar_event_status in ('confirmed', 'tentative', 'cancelled', 'unknown')),
  calendar_event_etag text
    check (calendar_event_etag is null or length(calendar_event_etag) between 1 and 500),
  calendar_reconciled_at timestamptz,
  calendar_payload_hash text
    check (calendar_payload_hash is null or calendar_payload_hash ~ '^[a-f0-9]{64}$'),
  operating_baseline_publication_id uuid not null
    references public.company_operating_baseline_publications(id) on delete restrict,
  operating_baseline_hash text not null
    check (operating_baseline_hash ~ '^[a-f0-9]{64}$'),
  route_check_id uuid not null
    references public.route_checks(id) on delete restrict,
  route_disposition text not null
    check (route_disposition in ('eligible', 'ineligible', 'unknown')),
  route_observed_at timestamptz not null,
  route_expires_at timestamptz not null,
  route_request_hash text not null check (route_request_hash ~ '^[a-f0-9]{64}$'),
  route_response_hash text not null check (route_response_hash ~ '^[a-f0-9]{64}$'),
  weather_check_id uuid not null
    references public.weather_checks(id) on delete restrict,
  weather_disposition text not null
    check (weather_disposition in ('eligible', 'requires_approval', 'unavailable', 'unknown')),
  weather_observed_at timestamptz not null,
  weather_expires_at timestamptz not null,
  weather_policy_version text not null
    check (length(btrim(weather_policy_version)) between 1 and 128),
  weather_policy_hash text not null check (weather_policy_hash ~ '^[a-f0-9]{64}$'),
  weather_payload_hash text not null check (weather_payload_hash ~ '^[a-f0-9]{64}$'),
  unknowns text[] not null default '{}',
  conflicts jsonb not null default '[]'::jsonb
    check (jsonb_typeof(conflicts) = 'array'),
  expires_at timestamptz not null,
  evidence_hash text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null
    check (length(btrim(idempotency_key)) between 8 and 200),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  trace_id text check (trace_id is null or length(trace_id) between 1 and 200),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  unique (company_id, idempotency_key),
  unique (company_id, id),
  foreign key (company_id, configuration_revision)
    references public.company_configuration_versions(company_id, revision)
    on delete restrict,
  check (ends_at > starts_at),
  check (capacity_expires_at > capacity_observed_at),
  check (route_expires_at > route_observed_at),
  check (weather_expires_at > weather_observed_at),
  check (
    expires_at = least(
      capacity_expires_at,
      route_expires_at,
      weather_expires_at
    )
  ),
  check (
    (evidence_mode = 'live' and capacity_provider = 'google_calendar')
    or (evidence_mode = 'sandbox' and capacity_provider = 'mock')
  ),
  check (
    (
      capacity_disposition = 'eligible'
      and calendar_event_id is not null
      and calendar_event_status = 'confirmed'
      and calendar_event_etag is not null
      and calendar_reconciled_at is not null
      and calendar_payload_hash is not null
    )
    or capacity_disposition <> 'eligible'
  )
);

create index scheduling_evidence_receipts_booking_idx
  on public.scheduling_evidence_receipts(
    company_id, job_id, evidence_mode, expires_at desc, created_at desc
  );

create table public.scheduling_evidence_consumptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  evidence_receipt_id uuid not null unique
    references public.scheduling_evidence_receipts(id) on delete restrict,
  visit_id uuid not null unique references public.visits(id) on delete restrict,
  idempotency_key text not null
    check (length(btrim(idempotency_key)) between 8 and 200),
  consumed_by uuid not null references auth.users(id) on delete restrict,
  consumed_at timestamptz not null default now(),
  unique (company_id, idempotency_key)
);

create table public.scheduling_equipment_reservations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  evidence_receipt_id uuid not null
    references public.scheduling_evidence_receipts(id) on delete restrict,
  equipment_id uuid not null references public.equipment(id) on delete restrict,
  visit_id uuid references public.visits(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'held'
    check (status in ('held', 'consumed', 'released')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (evidence_receipt_id, equipment_id),
  check (ends_at > starts_at),
  check (
    (status = 'held' and visit_id is null and completed_at is null)
    or (
      status = 'consumed'
      and visit_id is not null
      and completed_at is not null
    )
    or (
      status = 'released'
      and visit_id is null
      and completed_at is not null
    )
  ),
  exclude using gist (
    equipment_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  )
  where (status in ('held', 'consumed'))
);

create index scheduling_equipment_reservations_receipt_idx
  on public.scheduling_equipment_reservations(
    company_id,
    evidence_receipt_id,
    status
  );

alter table public.visits
  add column scheduling_evidence_receipt_id uuid
    references public.scheduling_evidence_receipts(id) on delete restrict;

create unique index visits_scheduling_evidence_receipt_idx
  on public.visits(scheduling_evidence_receipt_id)
  where scheduling_evidence_receipt_id is not null;

create table private.scheduling_promotion_authorizations (
  id uuid primary key default gen_random_uuid(),
  backend_pid integer not null,
  transaction_id bigint not null,
  company_id uuid not null,
  job_id uuid not null,
  evidence_receipt_id uuid not null,
  actor_user_id uuid not null,
  command_id uuid not null,
  visit_id uuid,
  visit_bound_at timestamptz,
  dispatch_bound_at timestamptz,
  job_bound_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (backend_pid, transaction_id),
  unique (company_id, command_id)
);

revoke all on table private.scheduling_promotion_authorizations
  from public, anon, authenticated, service_role;

create or replace function public.storyops_scheduling_evidence_hash(
  p_receipt public.scheduling_evidence_receipts
)
returns text
language sql
immutable
strict
set search_path = pg_catalog, public, extensions
as $$
  select encode(
    extensions.digest(
      (to_jsonb(p_receipt) - 'evidence_hash')::text,
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function public.set_storyops_scheduling_evidence_hash()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  new.evidence_hash := public.storyops_scheduling_evidence_hash(new);
  return new;
end;
$$;

create trigger scheduling_evidence_receipts_hash
before insert on public.scheduling_evidence_receipts
for each row execute function public.set_storyops_scheduling_evidence_hash();

create or replace function public.protect_storyops_scheduling_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'SCHEDULING_EVIDENCE_IMMUTABLE';
end;
$$;

create trigger scheduling_evidence_receipts_immutable
before update or delete on public.scheduling_evidence_receipts
for each row execute function public.protect_storyops_scheduling_evidence();

create trigger scheduling_evidence_consumptions_immutable
before update or delete on public.scheduling_evidence_consumptions
for each row execute function public.protect_storyops_scheduling_evidence();

create trigger route_checks_scheduling_evidence_immutable
before update or delete on public.route_checks
for each row execute function public.protect_storyops_scheduling_evidence();

create trigger weather_checks_scheduling_evidence_immutable
before update or delete on public.weather_checks
for each row execute function public.protect_storyops_scheduling_evidence();

-- JSON.stringify-compatible canonicalization for the finite command/evidence
-- envelopes used here. Object keys are bytewise sorted and whitespace is not
-- introduced. Keeping this server-side makes the submitted SHA-256 an actual
-- integrity check instead of a caller-supplied label.
create or replace function public.storyops_canonical_json(p_value jsonb)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog, public
as $$
declare
  value_kind text := jsonb_typeof(p_value);
  canonical_value text;
begin
  if value_kind = 'object' then
    select '{' || coalesce(
      string_agg(
        to_jsonb(entry.key)::text || ':' || public.storyops_canonical_json(entry.value),
        ',' order by entry.key collate "C"
      ),
      ''
    ) || '}'
    into canonical_value
    from jsonb_each(p_value) entry;
    return canonical_value;
  elsif value_kind = 'array' then
    select '[' || coalesce(
      string_agg(
        public.storyops_canonical_json(item.value),
        ',' order by item.ordinality
      ),
      ''
    ) || ']'
    into canonical_value
    from jsonb_array_elements(p_value) with ordinality item(value, ordinality);
    return canonical_value;
  end if;
  return p_value::text;
end;
$$;

create or replace function public.storyops_json_sha256(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = pg_catalog, public, extensions
as $$
  select encode(
    extensions.digest(public.storyops_canonical_json(p_value), 'sha256'),
    'hex'
  );
$$;

create or replace function public.storyops_scheduling_receipt_json(
  p_receipt public.scheduling_evidence_receipts,
  p_replayed boolean default false
)
returns jsonb
language sql
stable
strict
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'schemaVersion', p_receipt.schema_version,
    'receiptId', p_receipt.id,
    'companyId', p_receipt.company_id,
    'jobId', p_receipt.job_id,
    'jobVersion', p_receipt.job_version,
    'propertyId', p_receipt.property_id,
    'crewId', p_receipt.crew_id,
    'crewVersion', p_receipt.crew_version,
    'startsAt', p_receipt.starts_at,
    'endsAt', p_receipt.ends_at,
    'evidenceMode', p_receipt.evidence_mode,
    'configurationRevision', p_receipt.configuration_revision,
    'operatingBaselinePublicationId',
      p_receipt.operating_baseline_publication_id,
    'capacityDisposition', p_receipt.capacity_disposition,
    'routeDisposition', p_receipt.route_disposition,
    'weatherDisposition', p_receipt.weather_disposition,
    'calendarEventId', p_receipt.calendar_event_id,
    'routeCheckId', p_receipt.route_check_id,
    'weatherCheckId', p_receipt.weather_check_id,
    'unknowns', to_jsonb(p_receipt.unknowns),
    'conflicts', p_receipt.conflicts,
    'expiresAt', p_receipt.expires_at,
    'evidenceHash', p_receipt.evidence_hash,
    'requestHash', p_receipt.request_hash,
    'createdAt', p_receipt.created_at,
    'replayed', p_replayed
  );
$$;

-- Trusted scheduling workers call this after they have reconciled the provider
-- reservation. It records provider payloads but does not confirm a visit.
create or replace function public.record_storyops_scheduling_evidence(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  existing_receipt public.scheduling_evidence_receipts%rowtype;
  inserted_receipt public.scheduling_evidence_receipts%rowtype;
  job_row public.jobs%rowtype;
  quote_row public.quotes%rowtype;
  estimate_row public.estimates%rowtype;
  crew_row public.crews%rowtype;
  baseline_row public.company_operating_baseline_publications%rowtype;
  capacity_data jsonb;
  route_data jsonb;
  weather_data jsonb;
  capacity_payload jsonb;
  route_request_payload jsonb;
  route_response_payload jsonb;
  weather_payload jsonb;
  weather_policy jsonb;
  conflicts_value jsonb;
  unknowns_value text[];
  evidence_mode_value text;
  job_id_value uuid;
  property_id_value uuid;
  crew_id_value uuid;
  job_version_value integer;
  crew_version_value integer;
  configuration_revision_value integer;
  baseline_id_value uuid;
  starts_at_value timestamptz;
  ends_at_value timestamptz;
  capacity_observed_at_value timestamptz;
  capacity_expires_at_value timestamptz;
  route_observed_at_value timestamptz;
  route_expires_at_value timestamptz;
  weather_observed_at_value timestamptz;
  weather_expires_at_value timestamptz;
  calendar_reconciled_at_value timestamptz;
  route_check_id_value uuid;
  weather_check_id_value uuid;
  capacity_disposition_value text;
  route_disposition_value text;
  weather_disposition_value text;
  calendar_event_id_value text;
  calendar_event_etag_value text;
  effective_request_hash text;
  unexpected_key text;
  required_skills text[];
  required_equipment text[];
  equipment_type_value text;
  equipment_id_value uuid;
begin
  if p_company_id is null
    or p_actor_user_id is null
    or p_evidence is null
    or jsonb_typeof(p_evidence) <> 'object'
    or octet_length(p_evidence::text) > 131072
    or length(btrim(coalesce(p_idempotency_key, ''))) not between 8 and 200
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception 'SCHEDULING_EVIDENCE_INVALID_REQUEST';
  end if;

  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = p_actor_user_id
      and membership.active
      and membership.role in ('owner', 'dispatcher')
  ) then
    raise exception 'SCHEDULING_EVIDENCE_BACK_OFFICE_ACTOR_REQUIRED';
  end if;

  select key
  into unexpected_key
  from jsonb_object_keys(p_evidence) keys(key)
  where key not in (
    'schemaVersion', 'evidenceMode', 'jobId', 'jobVersion', 'propertyId',
    'crewId', 'crewVersion', 'startsAt', 'endsAt',
    'configurationRevision', 'operatingBaselinePublicationId',
    'capacity', 'route', 'weather', 'unknowns', 'conflicts', 'traceId'
  )
  limit 1;
  if unexpected_key is not null
    or p_evidence ->> 'schemaVersion'
      <> 'storyops-scheduling-evidence-input-v1'
    or jsonb_typeof(p_evidence -> 'capacity') <> 'object'
    or jsonb_typeof(p_evidence -> 'route') <> 'object'
    or jsonb_typeof(p_evidence -> 'weather') <> 'object'
    or jsonb_typeof(p_evidence -> 'unknowns') <> 'array'
    or jsonb_typeof(p_evidence -> 'conflicts') <> 'array'
  then
    raise exception 'SCHEDULING_EVIDENCE_INVALID_ENVELOPE';
  end if;

  capacity_data := p_evidence -> 'capacity';
  route_data := p_evidence -> 'route';
  weather_data := p_evidence -> 'weather';

  select key into unexpected_key
  from jsonb_object_keys(capacity_data) keys(key)
  where key not in (
    'provider', 'reference', 'disposition', 'observedAt', 'expiresAt',
    'calendarEventId', 'calendarEventStatus', 'calendarEventEtag',
    'calendarReconciledAt', 'payload', 'calendarPayload'
  )
  limit 1;
  if unexpected_key is not null then
    raise exception 'SCHEDULING_EVIDENCE_UNSUPPORTED_CAPACITY_FIELD';
  end if;

  select key into unexpected_key
  from jsonb_object_keys(route_data) keys(key)
  where key not in (
    'provider', 'disposition', 'observedAt', 'expiresAt', 'routeFeasible',
    'driveMinutes', 'addedDistanceMiles', 'violations',
    'requestPayload', 'responsePayload'
  )
  limit 1;
  if unexpected_key is not null then
    raise exception 'SCHEDULING_EVIDENCE_UNSUPPORTED_ROUTE_FIELD';
  end if;

  select key into unexpected_key
  from jsonb_object_keys(weather_data) keys(key)
  where key not in (
    'provider', 'disposition', 'observedAt', 'expiresAt', 'forecastIssuedAt',
    'periodStartsAt', 'periodEndsAt', 'temperatureF',
    'precipitationProbability', 'windSpeedMph', 'lightningRisk',
    'conditionCodes', 'policyVersion', 'policy', 'payload'
  )
  limit 1;
  if unexpected_key is not null then
    raise exception 'SCHEDULING_EVIDENCE_UNSUPPORTED_WEATHER_FIELD';
  end if;

  effective_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'actorUserId', p_actor_user_id,
    'companyId', p_company_id,
    'evidence', p_evidence,
    'idempotencyKey', p_idempotency_key
  ));
  if effective_request_hash <> p_request_hash then
    raise exception 'SCHEDULING_EVIDENCE_REQUEST_HASH_MISMATCH';
  end if;

  select *
  into existing_receipt
  from public.scheduling_evidence_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if existing_receipt.request_hash <> effective_request_hash then
      raise exception 'SCHEDULING_EVIDENCE_IDEMPOTENCY_CONFLICT';
    end if;
    return public.storyops_scheduling_receipt_json(existing_receipt, true);
  end if;

  evidence_mode_value := p_evidence ->> 'evidenceMode';
  job_id_value := (p_evidence ->> 'jobId')::uuid;
  property_id_value := (p_evidence ->> 'propertyId')::uuid;
  crew_id_value := (p_evidence ->> 'crewId')::uuid;
  job_version_value := (p_evidence ->> 'jobVersion')::integer;
  crew_version_value := (p_evidence ->> 'crewVersion')::integer;
  configuration_revision_value :=
    (p_evidence ->> 'configurationRevision')::integer;
  baseline_id_value :=
    (p_evidence ->> 'operatingBaselinePublicationId')::uuid;
  starts_at_value := (p_evidence ->> 'startsAt')::timestamptz;
  ends_at_value := (p_evidence ->> 'endsAt')::timestamptz;
  capacity_observed_at_value :=
    (capacity_data ->> 'observedAt')::timestamptz;
  capacity_expires_at_value :=
    (capacity_data ->> 'expiresAt')::timestamptz;
  route_observed_at_value := (route_data ->> 'observedAt')::timestamptz;
  route_expires_at_value := (route_data ->> 'expiresAt')::timestamptz;
  weather_observed_at_value := (weather_data ->> 'observedAt')::timestamptz;
  weather_expires_at_value := (weather_data ->> 'expiresAt')::timestamptz;
  capacity_disposition_value := capacity_data ->> 'disposition';
  route_disposition_value := route_data ->> 'disposition';
  weather_disposition_value := weather_data ->> 'disposition';
  calendar_event_id_value :=
    nullif(btrim(capacity_data ->> 'calendarEventId'), '');
  calendar_event_etag_value :=
    nullif(capacity_data ->> 'calendarEventEtag', '');
  calendar_reconciled_at_value := case
    when nullif(capacity_data ->> 'calendarReconciledAt', '') is null then null
    else (capacity_data ->> 'calendarReconciledAt')::timestamptz
  end;
  capacity_payload := capacity_data -> 'payload';
  route_request_payload := route_data -> 'requestPayload';
  route_response_payload := route_data -> 'responsePayload';
  weather_payload := weather_data -> 'payload';
  weather_policy := weather_data -> 'policy';
  conflicts_value := p_evidence -> 'conflicts';

  -- Serialize every evidence commit for one job. The Edge worker's preflight is
  -- advisory only; this database lock and the post-lock checks close the race
  -- where two distinct windows are evaluated concurrently.
  perform pg_advisory_xact_lock(hashtextextended(
    p_company_id::text || '|scheduling-evidence|' || job_id_value::text,
    0
  ));

  select *
  into existing_receipt
  from public.scheduling_evidence_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if existing_receipt.request_hash <> effective_request_hash then
      raise exception 'SCHEDULING_EVIDENCE_IDEMPOTENCY_CONFLICT';
    end if;
    return public.storyops_scheduling_receipt_json(existing_receipt, true);
  end if;

  if evidence_mode_value = 'live' and exists (
    select 1
    from public.scheduling_evidence_receipts receipt
    where receipt.company_id = p_company_id
      and receipt.job_id = job_id_value
      and receipt.job_version = job_version_value
      and receipt.evidence_mode = 'live'
      and receipt.capacity_disposition = 'eligible'
      and receipt.route_disposition = 'eligible'
      and receipt.weather_disposition = 'eligible'
      and receipt.expires_at > now()
      and not exists (
        select 1
        from public.scheduling_evidence_consumptions consumption
        where consumption.evidence_receipt_id = receipt.id
      )
  ) then
    raise exception 'SCHEDULING_EVIDENCE_ACTIVE_RECEIPT_EXISTS';
  end if;

  if evidence_mode_value not in ('live', 'sandbox')
    or job_version_value < 1
    or crew_version_value < 1
    or configuration_revision_value < 1
    or ends_at_value <= starts_at_value
    or starts_at_value <= now()
    or jsonb_typeof(capacity_payload) <> 'object'
    or capacity_payload ->> 'schemaVersion'
      <> 'storyops-capacity-evidence-v1'
    or jsonb_typeof(capacity_payload -> 'capacity') <> 'object'
    or jsonb_typeof(capacity_payload -> 'freeBusy') <> 'object'
    or jsonb_typeof(capacity_data -> 'calendarPayload') <> 'object'
    or jsonb_typeof(route_request_payload) <> 'object'
    or jsonb_typeof(route_response_payload) <> 'object'
    or jsonb_typeof(route_data -> 'violations') <> 'array'
    or jsonb_typeof(weather_payload) <> 'object'
    or jsonb_typeof(weather_policy) <> 'object'
    or jsonb_typeof(weather_data -> 'conditionCodes') <> 'array'
    or capacity_disposition_value not in ('eligible', 'ineligible', 'unknown')
    or route_disposition_value not in ('eligible', 'ineligible', 'unknown')
    or weather_disposition_value not in (
      'eligible', 'requires_approval', 'unavailable', 'unknown'
    )
  then
    raise exception 'SCHEDULING_EVIDENCE_INVALID_FACTS';
  end if;

  select coalesce(array_agg(value order by ordinality), '{}')
  into unknowns_value
  from jsonb_array_elements_text(p_evidence -> 'unknowns')
    with ordinality unknown_value(value, ordinality);
  if cardinality(unknowns_value) > 20
    or exists (
      select 1 from unnest(unknowns_value) unknown_value
      where length(btrim(unknown_value)) not between 1 and 240
    )
    or jsonb_array_length(conflicts_value) > 20
  then
    raise exception 'SCHEDULING_EVIDENCE_UNBOUNDED_UNCERTAINTY';
  end if;

  select * into job_row
  from public.jobs job
  where job.id = job_id_value
    and job.company_id = p_company_id
  for update;
  if not found
    or job_row.version <> job_version_value
    or job_row.property_id <> property_id_value
    or job_row.status <> 'ready_to_schedule'
  then
    raise exception 'SCHEDULING_EVIDENCE_JOB_NOT_READY';
  end if;

  select * into quote_row
  from public.quotes quote
  where quote.id = job_row.quote_id
    and quote.company_id = p_company_id;
  select * into estimate_row
  from public.estimates estimate
  where estimate.id = quote_row.estimate_id
    and estimate.company_id = p_company_id;
  if ends_at_value <> starts_at_value
      + make_interval(mins => estimate_row.duration_minutes)
  then
    raise exception 'SCHEDULING_EVIDENCE_DURATION_MISMATCH';
  end if;

  select * into crew_row
  from public.crews crew
  where crew.id = crew_id_value
    and crew.company_id = p_company_id
    and crew.active;
  if not found or crew_row.version <> crew_version_value then
    raise exception 'SCHEDULING_EVIDENCE_CREW_VERSION_CONFLICT';
  end if;

  perform 1
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.revision = configuration_revision_value
    and configuration.status = 'published'
    and configuration.publication_mode = evidence_mode_value;
  if not found then
    raise exception 'SCHEDULING_EVIDENCE_CURRENT_CONFIGURATION_REQUIRED';
  end if;

  select * into baseline_row
  from public.company_operating_baseline_publications baseline
  where baseline.id = baseline_id_value
    and baseline.company_id = p_company_id
    and baseline.configuration_revision = configuration_revision_value
    and baseline.status = 'active';
  if not found then
    raise exception 'SCHEDULING_EVIDENCE_ACTIVE_BASELINE_REQUIRED';
  end if;

  if evidence_mode_value = 'live' and (
      capacity_data ->> 'provider' <> 'google_calendar'
      or route_data ->> 'provider' <> 'vroom'
      or weather_data ->> 'provider' <> 'nws'
    )
    or evidence_mode_value = 'sandbox' and (
      capacity_data ->> 'provider' <> 'mock'
      or route_data ->> 'provider' <> 'mock'
      or weather_data ->> 'provider' <> 'mock'
    )
  then
    raise exception 'SCHEDULING_EVIDENCE_PROVIDER_MODE_MISMATCH';
  end if;

  if capacity_observed_at_value not between now() - interval '10 minutes'
      and now() + interval '2 minutes'
    or route_observed_at_value not between now() - interval '30 minutes'
      and now() + interval '2 minutes'
    or weather_observed_at_value not between now() - interval '60 minutes'
      and now() + interval '2 minutes'
    or capacity_expires_at_value <= now()
    or route_expires_at_value <= now()
    or weather_expires_at_value <= now()
    or capacity_expires_at_value
      > capacity_observed_at_value + interval '15 minutes'
    or route_expires_at_value
      > route_observed_at_value + interval '30 minutes'
    or weather_expires_at_value
      > weather_observed_at_value + interval '60 minutes'
    or (weather_data ->> 'forecastIssuedAt')::timestamptz
      < now() - interval '6 hours'
    or (weather_data ->> 'periodStartsAt')::timestamptz > starts_at_value
    or (weather_data ->> 'periodEndsAt')::timestamptz < ends_at_value
  then
    raise exception 'SCHEDULING_EVIDENCE_STALE_OR_OUT_OF_WINDOW';
  end if;

  if route_request_payload ->> 'jobId' <> job_id_value::text
    or route_request_payload ->> 'propertyId' <> property_id_value::text
    or route_request_payload ->> 'crewId' <> crew_id_value::text
    or (route_request_payload ->> 'startsAt')::timestamptz
      <> starts_at_value
    or (route_request_payload ->> 'endsAt')::timestamptz
      <> ends_at_value
    or capacity_payload ->> 'jobId' <> job_id_value::text
    or capacity_payload ->> 'companyId' <> p_company_id::text
    or capacity_payload ->> 'propertyId' <> property_id_value::text
    or capacity_payload ->> 'crewId' <> crew_id_value::text
    or capacity_payload ->> 'mode' <> evidence_mode_value
    or (capacity_payload ->> 'startsAt')::timestamptz
      <> starts_at_value
    or (capacity_payload ->> 'endsAt')::timestamptz
      <> ends_at_value
  then
    raise exception 'SCHEDULING_EVIDENCE_SCOPE_BINDING_MISMATCH';
  end if;

  if evidence_mode_value = 'live' and (
    not private.storyops_route_context_is_current(
      p_company_id,
      job_id_value,
      property_id_value,
      crew_id_value,
      starts_at_value,
      ends_at_value,
      route_request_payload
    )
    or not private.storyops_route_response_matches_context(
      route_request_payload,
      route_response_payload
    )
  ) then
    raise exception 'SCHEDULING_EVIDENCE_ROUTE_CONTEXT_UNCERTAIN';
  end if;

  if route_disposition_value = 'eligible' and (
      not (route_data ->> 'routeFeasible')::boolean
      or jsonb_array_length(route_data -> 'violations') <> 0
    )
    or route_disposition_value <> 'eligible'
      and (route_data ->> 'routeFeasible')::boolean
      and jsonb_array_length(route_data -> 'violations') = 0
  then
    raise exception 'SCHEDULING_EVIDENCE_ROUTE_DISPOSITION_MISMATCH';
  end if;

  if capacity_disposition_value = 'eligible' and (
      cardinality(unknowns_value) <> 0
      or jsonb_array_length(conflicts_value) <> 0
      or calendar_event_id_value is null
      or length(calendar_event_id_value) > 500
      or calendar_event_etag_value is null
      or length(calendar_event_etag_value) > 500
      or capacity_data ->> 'calendarEventStatus' <> 'confirmed'
      or calendar_reconciled_at_value not between now() - interval '10 minutes'
        and now() + interval '2 minutes'
      or capacity_payload -> 'busy' <> 'false'::jsonb
      or capacity_payload -> 'readBackConfirmed' <> 'true'::jsonb
      or capacity_payload #>> '{capacity,disposition}' <> 'eligible'
      or capacity_payload #>> '{freeBusy,disposition}' <> 'eligible'
      or jsonb_typeof(capacity_payload #> '{capacity,eligibleCrewIds}')
        <> 'array'
      or not (
        capacity_payload #> '{capacity,eligibleCrewIds}'
          ? crew_id_value::text
      )
      or jsonb_typeof(capacity_payload #> '{capacity,unknowns}')
        <> 'array'
      or jsonb_array_length(
        capacity_payload #> '{capacity,unknowns}'
      ) <> 0
      or jsonb_typeof(capacity_payload #> '{capacity,conflicts}')
        <> 'array'
      or jsonb_array_length(
        capacity_payload #> '{capacity,conflicts}'
      ) <> 0
      or jsonb_typeof(capacity_payload #> '{freeBusy,sourceCalendarIds}')
        <> 'array'
      or jsonb_array_length(
        capacity_payload #> '{freeBusy,sourceCalendarIds}'
      ) = 0
      or jsonb_typeof(capacity_payload #> '{freeBusy,unknowns}')
        <> 'array'
      or jsonb_array_length(
        capacity_payload #> '{freeBusy,unknowns}'
      ) <> 0
      or jsonb_typeof(capacity_payload #> '{freeBusy,conflicts}')
        <> 'array'
      or jsonb_array_length(
        capacity_payload #> '{freeBusy,conflicts}'
      ) <> 0
      or capacity_payload ->> 'eventId' <> calendar_event_id_value
      or capacity_payload ->> 'eventStatus' <> 'confirmed'
      or capacity_payload ->> 'eventEtag' <> calendar_event_etag_value
    )
  then
    raise exception 'SCHEDULING_EVIDENCE_CAPACITY_NOT_RECONCILED';
  end if;

  select coalesce(array_agg(distinct skill order by skill), '{}')
  into required_skills
  from public.service_catalog catalog
  cross join unnest(catalog.required_skills) skill
  where catalog.company_id = p_company_id
    and catalog.active
    and catalog.code = any(job_row.service_codes);
  select coalesce(array_agg(distinct equipment_type order by equipment_type), '{}')
  into required_equipment
  from public.service_catalog catalog
  cross join unnest(catalog.required_equipment_types) equipment_type
  where catalog.company_id = p_company_id
    and catalog.active
    and catalog.code = any(job_row.service_codes);

  if capacity_disposition_value = 'eligible' and (
    not required_skills <@ crew_row.skill_codes
    or not private.storyops_crew_has_authorized_technicians(
      p_company_id,
      crew_id_value,
      starts_at_value,
      ends_at_value
    )
    or exists (
      select 1
      from unnest(required_equipment) needed(equipment_type)
      where not exists (
        select 1
        from public.equipment equipment
        where equipment.company_id = p_company_id
          and equipment.equipment_type = needed.equipment_type
          and equipment.status in ('available', 'assigned')
          and (
            equipment.assigned_crew_id is null
            or equipment.assigned_crew_id = crew_id_value
          )
          and (
            equipment.next_inspection_due is null
            or equipment.next_inspection_due >= starts_at_value::date
          )
      )
    )
    or exists (
      select 1
      from public.visits visit
      where visit.company_id = p_company_id
        and visit.crew_id = crew_id_value
        and visit.status <> 'cancelled'
        and visit.starts_at < ends_at_value
        and visit.ends_at > starts_at_value
    )
  ) then
    raise exception 'SCHEDULING_EVIDENCE_INTERNAL_CAPACITY_CONFLICT';
  end if;

  insert into public.route_checks(
    company_id, provider, checked_at, route_feasible, drive_minutes,
    added_distance_miles, violations, request_payload, response_payload
  )
  values (
    p_company_id,
    route_data ->> 'provider',
    route_observed_at_value,
    (route_data ->> 'routeFeasible')::boolean,
    (route_data ->> 'driveMinutes')::integer,
    (route_data ->> 'addedDistanceMiles')::numeric,
    array(
      select jsonb_array_elements_text(route_data -> 'violations')
    ),
    route_request_payload,
    route_response_payload
  )
  returning id into route_check_id_value;

  insert into public.weather_checks(
    company_id, property_id, provider, forecast_issued_at, checked_at,
    period_starts_at, period_ends_at, temperature_f,
    precipitation_probability, wind_speed_mph, lightning_risk,
    condition_codes, policy_disposition, raw_forecast
  )
  values (
    p_company_id,
    property_id_value,
    weather_data ->> 'provider',
    (weather_data ->> 'forecastIssuedAt')::timestamptz,
    weather_observed_at_value,
    (weather_data ->> 'periodStartsAt')::timestamptz,
    (weather_data ->> 'periodEndsAt')::timestamptz,
    (weather_data ->> 'temperatureF')::numeric,
    (weather_data ->> 'precipitationProbability')::numeric,
    (weather_data ->> 'windSpeedMph')::numeric,
    weather_data ->> 'lightningRisk',
    array(
      select jsonb_array_elements_text(weather_data -> 'conditionCodes')
    ),
    case
      when weather_disposition_value = 'unknown' then 'unavailable'
      else weather_disposition_value
    end,
    weather_payload
  )
  returning id into weather_check_id_value;

  insert into public.scheduling_evidence_receipts(
    company_id, job_id, job_version, property_id, crew_id, crew_version,
    starts_at, ends_at, evidence_mode, configuration_revision,
    capacity_provider, capacity_reference, capacity_disposition,
    capacity_observed_at, capacity_expires_at, capacity_payload,
    capacity_payload_hash, calendar_event_id, calendar_event_status,
    calendar_event_etag, calendar_reconciled_at, calendar_payload_hash,
    operating_baseline_publication_id, operating_baseline_hash,
    route_check_id, route_disposition, route_observed_at, route_expires_at,
    route_request_hash, route_response_hash, weather_check_id,
    weather_disposition, weather_observed_at, weather_expires_at,
    weather_policy_version, weather_policy_hash, weather_payload_hash,
    unknowns, conflicts, expires_at, evidence_hash, idempotency_key,
    request_hash, trace_id, created_by
  )
  values (
    p_company_id, job_id_value, job_version_value, property_id_value,
    crew_id_value, crew_version_value, starts_at_value, ends_at_value,
    evidence_mode_value, configuration_revision_value,
    capacity_data ->> 'provider',
    capacity_data ->> 'reference',
    capacity_disposition_value,
    capacity_observed_at_value,
    capacity_expires_at_value,
    capacity_payload,
    public.storyops_json_sha256(capacity_payload),
    calendar_event_id_value,
    coalesce(capacity_data ->> 'calendarEventStatus', 'unknown'),
    calendar_event_etag_value,
    calendar_reconciled_at_value,
    public.storyops_json_sha256(capacity_data -> 'calendarPayload'),
    baseline_row.id,
    baseline_row.baseline_hash,
    route_check_id_value,
    route_disposition_value,
    route_observed_at_value,
    route_expires_at_value,
    public.storyops_json_sha256(route_request_payload),
    public.storyops_json_sha256(route_response_payload),
    weather_check_id_value,
    weather_disposition_value,
    weather_observed_at_value,
    weather_expires_at_value,
    weather_data ->> 'policyVersion',
    public.storyops_json_sha256(weather_policy),
    public.storyops_json_sha256(weather_payload),
    unknowns_value,
    conflicts_value,
    least(
      capacity_expires_at_value,
      route_expires_at_value,
      weather_expires_at_value
    ),
    repeat('0', 64),
    p_idempotency_key,
    effective_request_hash,
    nullif(btrim(p_evidence ->> 'traceId'), ''),
    p_actor_user_id
  )
  returning * into inserted_receipt;

  if evidence_mode_value = 'live'
    and capacity_disposition_value = 'eligible'
  then
    -- Expired, unconsumed receipt holds are no longer authoritative. Releasing
    -- them before allocation makes capacity reusable even if the scheduled
    -- cleanup worker has not reached that receipt yet.
    update public.scheduling_equipment_reservations reservation
    set
      status = 'released',
      completed_at = now(),
      updated_at = now()
    where reservation.status = 'held'
      and exists (
        select 1
        from public.scheduling_evidence_receipts expired_receipt
        where expired_receipt.id = reservation.evidence_receipt_id
          and expired_receipt.expires_at <= now()
          and not exists (
            select 1
            from public.scheduling_evidence_consumptions consumption
            where consumption.evidence_receipt_id = expired_receipt.id
          )
      );

    foreach equipment_type_value in array required_equipment
    loop
      equipment_id_value := null;
      select equipment.id
      into equipment_id_value
      from public.equipment equipment
      where equipment.company_id = p_company_id
        and equipment.equipment_type = equipment_type_value
        and equipment.status in ('available', 'assigned')
        and (
          equipment.assigned_crew_id is null
          or equipment.assigned_crew_id = crew_id_value
        )
        and (
          equipment.next_inspection_due is null
          or equipment.next_inspection_due >= starts_at_value::date
        )
        and not exists (
          select 1
          from public.scheduling_equipment_reservations reservation
          where reservation.equipment_id = equipment.id
            and reservation.status in ('held', 'consumed')
            and reservation.starts_at < ends_at_value
            and reservation.ends_at > starts_at_value
        )
      order by
        (equipment.assigned_crew_id = crew_id_value) desc,
        equipment.id
      for update of equipment skip locked
      limit 1;
      if equipment_id_value is null then
        raise exception 'SCHEDULING_EVIDENCE_EQUIPMENT_CAPACITY_CONFLICT';
      end if;

      insert into public.scheduling_equipment_reservations(
        company_id,
        evidence_receipt_id,
        equipment_id,
        starts_at,
        ends_at,
        status
      )
      values (
        p_company_id,
        inserted_receipt.id,
        equipment_id_value,
        starts_at_value,
        ends_at_value,
        'held'
      );
    end loop;
  end if;

  return public.storyops_scheduling_receipt_json(inserted_receipt, false);
exception
  when invalid_text_representation
    or numeric_value_out_of_range
    or datetime_field_overflow
  then
    raise exception 'SCHEDULING_EVIDENCE_INVALID_TYPED_VALUE';
end;
$$;

-- Confirmed scheduling state is legal only while the finite booking command has
-- an unforgeable, transaction-local authorization. This also closes the older
-- generic planned/weather-hold -> confirmed transition.
create or replace function public.enforce_storyops_scheduling_promotion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  authorization_row private.scheduling_promotion_authorizations%rowtype;
  receipt_row public.scheduling_evidence_receipts%rowtype;
  promotion_required boolean := false;
begin
  if tg_table_name = 'visits' then
    promotion_required := new.status = 'confirmed'
      and (tg_op = 'INSERT' or old.status <> 'confirmed');
  elsif tg_table_name = 'dispatch_assignments' then
    promotion_required := new.status = 'confirmed'
      and (tg_op = 'INSERT' or old.status <> 'confirmed');
  elsif tg_table_name = 'jobs' then
    promotion_required := new.status = 'scheduled'
      and (tg_op = 'INSERT' or old.status <> 'scheduled');
  end if;

  if not promotion_required then
    return new;
  end if;

  select *
  into authorization_row
  from private.scheduling_promotion_authorizations promotion_auth
  where promotion_auth.backend_pid = pg_backend_pid()
    and promotion_auth.transaction_id = txid_current()::bigint
  for update;
  if not found then
    raise exception 'SCHEDULING_PROMOTION_EVIDENCE_REQUIRED';
  end if;

  select *
  into receipt_row
  from public.scheduling_evidence_receipts receipt
  where receipt.id = authorization_row.evidence_receipt_id
    and receipt.company_id = authorization_row.company_id
    and receipt.job_id = authorization_row.job_id;
  if not found then
    raise exception 'SCHEDULING_PROMOTION_RECEIPT_INVALID';
  end if;

  if tg_table_name = 'visits' then
    if new.company_id <> authorization_row.company_id
      or new.job_id <> authorization_row.job_id
      or new.scheduling_evidence_receipt_id
        is distinct from authorization_row.evidence_receipt_id
      or new.crew_id <> receipt_row.crew_id
      or new.starts_at <> receipt_row.starts_at
      or new.ends_at <> receipt_row.ends_at
      or new.route_check_id is distinct from receipt_row.route_check_id
      or new.weather_check_id is distinct from receipt_row.weather_check_id
    then
      raise exception 'SCHEDULING_PROMOTION_VISIT_BINDING_MISMATCH';
    end if;
    update private.scheduling_promotion_authorizations
    set visit_id = new.id, visit_bound_at = statement_timestamp()
    where id = authorization_row.id;
  elsif tg_table_name = 'dispatch_assignments' then
    if authorization_row.visit_id is null
      or new.company_id <> authorization_row.company_id
      or new.visit_id <> authorization_row.visit_id
      or new.crew_id <> receipt_row.crew_id
      or new.starts_at <> receipt_row.starts_at
      or new.ends_at <> receipt_row.ends_at
    then
      raise exception 'SCHEDULING_PROMOTION_DISPATCH_BINDING_MISMATCH';
    end if;
    update private.scheduling_promotion_authorizations
    set dispatch_bound_at = statement_timestamp()
    where id = authorization_row.id;
  else
    if new.company_id <> authorization_row.company_id
      or new.id <> authorization_row.job_id
      or new.assigned_crew_id is distinct from receipt_row.crew_id
    then
      raise exception 'SCHEDULING_PROMOTION_JOB_BINDING_MISMATCH';
    end if;
    update private.scheduling_promotion_authorizations
    set job_bound_at = statement_timestamp()
    where id = authorization_row.id;
  end if;

  return new;
end;
$$;

create trigger visits_scheduling_promotion_guard
before insert or update on public.visits
for each row execute function public.enforce_storyops_scheduling_promotion();

create trigger dispatch_assignments_scheduling_promotion_guard
before insert or update on public.dispatch_assignments
for each row execute function public.enforce_storyops_scheduling_promotion();

create trigger jobs_scheduling_promotion_guard
before insert or update on public.jobs
for each row execute function public.enforce_storyops_scheduling_promotion();

-- Retain invoice issuance as a private compatibility implementation. Booking is
-- reimplemented below so every selected fact is the exact fact in the receipt.
alter function public.execute_storyops_golden_path_command(
  uuid, uuid, text, integer, jsonb, text
) rename to execute_storyops_golden_path_command_v1_0;

revoke all on function public.execute_storyops_golden_path_command_v1_0(
  uuid, uuid, text, integer, jsonb, text
) from public, anon, authenticated, service_role;

create or replace function public.execute_storyops_golden_path_command(
  p_company_id uuid,
  p_command_id uuid,
  p_command_type text,
  p_expected_version integer,
  p_payload jsonb,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  receipt_row public.scheduling_evidence_receipts%rowtype;
  route_row public.route_checks%rowtype;
  weather_row public.weather_checks%rowtype;
  job_row public.jobs%rowtype;
  quote_row public.quotes%rowtype;
  estimate_row public.estimates%rowtype;
  crew_row public.crews%rowtype;
  visit_row public.visits%rowtype;
  authorization_row private.scheduling_promotion_authorizations%rowtype;
  required_skills text[];
  required_equipment text[];
  checklist_template_id_value uuid;
  verified_deposit numeric(12,2) := 0;
  job_version_value integer;
  reserved_equipment_count integer;
  unexpected_key text;
  result jsonb;
begin
  if actor_user_id is null
    or p_company_id is null
    or p_command_id is null
    or p_command_type not in ('job.book', 'invoice.issue')
    or p_expected_version < 1
    or p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception 'GOLDEN_PATH_INVALID_COMMAND';
  end if;

  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role not in ('owner', 'dispatcher') then
    raise exception 'GOLDEN_PATH_BACK_OFFICE_REQUIRED';
  end if;

  effective_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'commandType', p_command_type,
    'expectedVersion', p_expected_version,
    'payload', p_payload
  ));
  if effective_request_hash <> p_request_hash then
    raise exception 'GOLDEN_PATH_REQUEST_HASH_MISMATCH';
  end if;

  if p_command_type = 'invoice.issue' then
    result := public.execute_storyops_golden_path_command_v1_0(
      p_company_id,
      p_command_id,
      p_command_type,
      p_expected_version,
      p_payload,
      p_request_hash
    );
    return (result - 'requestHash')
      || jsonb_build_object('requestHash', p_request_hash);
  end if;

  select key
  into unexpected_key
  from jsonb_object_keys(p_payload) keys(key)
  where key not in ('entityId', 'schedulingEvidenceReceiptId')
  limit 1;
  if unexpected_key is not null
    or nullif(p_payload ->> 'entityId', '') is null
    or nullif(p_payload ->> 'schedulingEvidenceReceiptId', '') is null
  then
    raise exception 'GOLDEN_PATH_EXACT_SCHEDULING_RECEIPT_REQUIRED';
  end if;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'golden-path-booking-v2',
    p_command_id::text,
    effective_request_hash,
    now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys idempotency
    where idempotency.company_id = p_company_id
      and idempotency.scope = 'golden-path-booking-v2'
      and idempotency.key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception 'GOLDEN_PATH_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'GOLDEN_PATH_COMMAND_IN_PROGRESS';
  end if;

  select *
  into receipt_row
  from public.scheduling_evidence_receipts receipt
  where receipt.id =
      (p_payload ->> 'schedulingEvidenceReceiptId')::uuid
    and receipt.company_id = p_company_id
    and receipt.job_id = (p_payload ->> 'entityId')::uuid
  for update;
  if not found then
    raise exception 'GOLDEN_PATH_SCHEDULING_RECEIPT_NOT_FOUND';
  end if;

  perform 1
  from public.scheduling_evidence_consumptions consumption
  where consumption.company_id = p_company_id
    and (
      consumption.evidence_receipt_id = receipt_row.id
      or consumption.idempotency_key = p_command_id::text
    );
  if found then
    raise exception 'GOLDEN_PATH_SCHEDULING_RECEIPT_ALREADY_CONSUMED';
  end if;

  select *
  into job_row
  from public.jobs job
  where job.id = receipt_row.job_id
    and job.company_id = p_company_id
  for update;
  if not found
    or job_row.version <> p_expected_version
    or receipt_row.job_version <> p_expected_version
    or job_row.property_id <> receipt_row.property_id
    or job_row.status <> 'ready_to_schedule'
  then
    raise exception 'GOLDEN_PATH_JOB_NOT_BOOKABLE';
  end if;

  if receipt_row.evidence_mode <> 'live'
    or receipt_row.expires_at <= now()
    or receipt_row.capacity_provider <> 'google_calendar'
    or receipt_row.capacity_disposition <> 'eligible'
    or receipt_row.calendar_event_status <> 'confirmed'
    or receipt_row.calendar_event_id is null
    or receipt_row.calendar_event_etag is null
    or receipt_row.calendar_reconciled_at < now() - interval '10 minutes'
    or receipt_row.capacity_payload -> 'busy' <> 'false'::jsonb
    or receipt_row.capacity_payload -> 'readBackConfirmed' <> 'true'::jsonb
    or receipt_row.route_disposition <> 'eligible'
    or receipt_row.weather_disposition <> 'eligible'
    or cardinality(receipt_row.unknowns) <> 0
    or jsonb_array_length(receipt_row.conflicts) <> 0
    or receipt_row.evidence_hash
      <> public.storyops_scheduling_evidence_hash(receipt_row)
  then
    raise exception 'GOLDEN_PATH_LIVE_ELIGIBLE_EVIDENCE_REQUIRED';
  end if;

  if not exists (
      select 1
      from public.company_configuration_versions configuration
      where configuration.company_id = p_company_id
        and configuration.revision = receipt_row.configuration_revision
        and configuration.status = 'published'
        and configuration.publication_mode = 'live'
    )
    or not exists (
      select 1
      from public.company_operating_baseline_publications baseline
      where baseline.id = receipt_row.operating_baseline_publication_id
        and baseline.company_id = p_company_id
        and baseline.configuration_revision =
          receipt_row.configuration_revision
        and baseline.baseline_hash = receipt_row.operating_baseline_hash
        and baseline.status = 'active'
    )
  then
    raise exception 'GOLDEN_PATH_CURRENT_OPERATING_BASELINE_REQUIRED';
  end if;

  select *
  into route_row
  from public.route_checks route
  where route.id = receipt_row.route_check_id
    and route.company_id = p_company_id
    and route.provider = 'vroom'
    and route.checked_at = receipt_row.route_observed_at
    and route.checked_at >= now() - interval '30 minutes'
    and route.route_feasible
    and cardinality(route.violations) = 0
    and public.storyops_json_sha256(route.request_payload)
      = receipt_row.route_request_hash
    and public.storyops_json_sha256(route.response_payload)
      = receipt_row.route_response_hash
    and private.storyops_route_context_is_current(
      p_company_id,
      receipt_row.job_id,
      receipt_row.property_id,
      receipt_row.crew_id,
      receipt_row.starts_at,
      receipt_row.ends_at,
      route.request_payload
    )
    and private.storyops_route_response_matches_context(
      route.request_payload,
      route.response_payload
    );
  if not found then
    raise exception 'GOLDEN_PATH_EXACT_LIVE_ROUTE_REQUIRED';
  end if;

  select *
  into weather_row
  from public.weather_checks weather
  where weather.id = receipt_row.weather_check_id
    and weather.company_id = p_company_id
    and weather.property_id = job_row.property_id
    and weather.provider = 'nws'
    and weather.checked_at = receipt_row.weather_observed_at
    and weather.checked_at >= now() - interval '60 minutes'
    and weather.forecast_issued_at >= now() - interval '6 hours'
    and weather.policy_disposition = 'eligible'
    and weather.period_starts_at <= receipt_row.starts_at
    and weather.period_ends_at >= receipt_row.ends_at
    and public.storyops_json_sha256(weather.raw_forecast)
      = receipt_row.weather_payload_hash;
  if not found then
    raise exception 'GOLDEN_PATH_EXACT_LIVE_WEATHER_REQUIRED';
  end if;

  select *
  into quote_row
  from public.quotes quote
  where quote.id = job_row.quote_id
    and quote.company_id = p_company_id;
  perform public.assert_storyops_accepted_pricing(p_company_id, quote_row.id);
  select *
  into estimate_row
  from public.estimates estimate
  where estimate.id = quote_row.estimate_id
    and estimate.company_id = p_company_id;
  if receipt_row.ends_at <> receipt_row.starts_at
      + make_interval(mins => estimate_row.duration_minutes)
  then
    raise exception 'GOLDEN_PATH_SCHEDULING_DURATION_MISMATCH';
  end if;

  select round(coalesce(sum(payment.amount), 0), 2)
  into verified_deposit
  from public.payments payment
  join public.invoices invoice on invoice.id = payment.invoice_id
  where invoice.company_id = p_company_id
    and invoice.job_id = job_row.id
    and invoice.purpose = 'job'
    and payment.payment_type = 'deposit'
    and public.storyops_payment_has_provider_proof(payment.id, quote_row.id);
  if quote_row.deposit_required > 0
    and verified_deposit < quote_row.deposit_required
  then
    raise exception 'GOLDEN_PATH_VERIFIED_DEPOSIT_REQUIRED';
  end if;

  select coalesce(array_agg(distinct skill order by skill), '{}')
  into required_skills
  from public.service_catalog catalog
  cross join unnest(catalog.required_skills) skill
  where catalog.company_id = p_company_id
    and catalog.active
    and catalog.code = any(job_row.service_codes);
  select coalesce(array_agg(distinct equipment_type order by equipment_type), '{}')
  into required_equipment
  from public.service_catalog catalog
  cross join unnest(catalog.required_equipment_types) equipment_type
  where catalog.company_id = p_company_id
    and catalog.active
    and catalog.code = any(job_row.service_codes);

  if (
    select count(distinct catalog.code)
    from public.service_catalog catalog
    where catalog.company_id = p_company_id
      and catalog.active
      and catalog.code = any(job_row.service_codes)
  ) <> cardinality(job_row.service_codes) then
    raise exception 'GOLDEN_PATH_ACTIVE_SERVICE_CATALOG_REQUIRED';
  end if;

  select min(catalog.default_checklist_template_id::text)::uuid
  into checklist_template_id_value
  from public.service_catalog catalog
  where catalog.company_id = p_company_id
    and catalog.active
    and catalog.code = any(job_row.service_codes)
  having count(distinct catalog.default_checklist_template_id) = 1
    and bool_and(catalog.default_checklist_template_id is not null);
  if checklist_template_id_value is null then
    raise exception 'GOLDEN_PATH_SINGLE_CHECKLIST_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_company_id::text || '|crew-booking|' || receipt_row.crew_id::text,
    0
  ));

  if not private.storyops_route_context_is_current(
    p_company_id,
    receipt_row.job_id,
    receipt_row.property_id,
    receipt_row.crew_id,
    receipt_row.starts_at,
    receipt_row.ends_at,
    route_row.request_payload
  ) then
    raise exception 'GOLDEN_PATH_ROUTE_CONTEXT_CHANGED';
  end if;

  select *
  into crew_row
  from public.crews crew
  where crew.id = receipt_row.crew_id
    and crew.company_id = p_company_id
    and crew.active
    and crew.version = receipt_row.crew_version
    and required_skills <@ crew.skill_codes
    and private.storyops_crew_has_authorized_technicians(
      p_company_id,
      crew.id,
      receipt_row.starts_at,
      receipt_row.ends_at
    )
    and not exists (
      select 1
      from unnest(required_equipment) needed(equipment_type)
      where not exists (
        select 1
        from public.equipment equipment
        where equipment.company_id = p_company_id
          and equipment.equipment_type = needed.equipment_type
          and equipment.status in ('available', 'assigned')
          and (
            equipment.assigned_crew_id is null
            or equipment.assigned_crew_id = crew.id
          )
          and (
            equipment.next_inspection_due is null
            or equipment.next_inspection_due >= receipt_row.starts_at::date
          )
      )
    )
    and not exists (
      select 1
      from public.visits visit
      where visit.company_id = p_company_id
        and visit.crew_id = crew.id
        and visit.status <> 'cancelled'
        and visit.starts_at < receipt_row.ends_at
        and visit.ends_at > receipt_row.starts_at
    )
  for update;
  if not found then
    raise exception 'GOLDEN_PATH_CREW_CAPACITY_UNAVAILABLE';
  end if;

  perform 1
  from public.scheduling_equipment_reservations equipment_reservation
  where equipment_reservation.company_id = p_company_id
    and equipment_reservation.evidence_receipt_id = receipt_row.id
  for update;
  select count(*)
  into reserved_equipment_count
  from public.scheduling_equipment_reservations equipment_reservation
  join public.equipment equipment
    on equipment.id = equipment_reservation.equipment_id
    and equipment.company_id = equipment_reservation.company_id
  where equipment_reservation.company_id = p_company_id
    and equipment_reservation.evidence_receipt_id = receipt_row.id
    and equipment_reservation.status = 'held'
    and equipment_reservation.visit_id is null
    and equipment_reservation.starts_at = receipt_row.starts_at
    and equipment_reservation.ends_at = receipt_row.ends_at
    and equipment.status in ('available', 'assigned')
    and (
      equipment.assigned_crew_id is null
      or equipment.assigned_crew_id = crew_row.id
    )
    and (
      equipment.next_inspection_due is null
      or equipment.next_inspection_due >= receipt_row.starts_at::date
    )
    and equipment.equipment_type = any(required_equipment);
  if reserved_equipment_count <> cardinality(required_equipment)
    or exists (
      select 1
      from unnest(required_equipment) needed(equipment_type)
      where (
        select count(*)
        from public.scheduling_equipment_reservations equipment_reservation
        join public.equipment equipment
          on equipment.id = equipment_reservation.equipment_id
          and equipment.company_id = equipment_reservation.company_id
        where equipment_reservation.company_id = p_company_id
          and equipment_reservation.evidence_receipt_id = receipt_row.id
          and equipment_reservation.status = 'held'
          and equipment.equipment_type = needed.equipment_type
      ) <> 1
    )
  then
    raise exception 'GOLDEN_PATH_EQUIPMENT_RESERVATION_REQUIRED';
  end if;

  insert into private.scheduling_promotion_authorizations(
    backend_pid, transaction_id, company_id, job_id, evidence_receipt_id,
    actor_user_id, command_id
  )
  values (
    pg_backend_pid(), txid_current()::bigint, p_company_id, job_row.id,
    receipt_row.id, actor_user_id, p_command_id
  )
  returning * into authorization_row;

  insert into public.visits(
    company_id, job_id, sequence, status, starts_at, ends_at, crew_id,
    route_check_id, weather_check_id, checklist_template_id,
    scheduling_evidence_receipt_id
  )
  values (
    p_company_id, job_row.id, 1, 'confirmed', receipt_row.starts_at,
    receipt_row.ends_at, crew_row.id, route_row.id, weather_row.id,
    checklist_template_id_value, receipt_row.id
  )
  returning * into visit_row;

  update public.scheduling_equipment_reservations
  set
    status = 'consumed',
    visit_id = visit_row.id,
    completed_at = now(),
    updated_at = now()
  where company_id = p_company_id
    and evidence_receipt_id = receipt_row.id
    and status = 'held';
  if (
    select count(*)
    from public.scheduling_equipment_reservations equipment_reservation
    where equipment_reservation.company_id = p_company_id
      and equipment_reservation.evidence_receipt_id = receipt_row.id
      and equipment_reservation.status = 'consumed'
      and equipment_reservation.visit_id = visit_row.id
  ) <> cardinality(required_equipment)
  then
    raise exception 'GOLDEN_PATH_EQUIPMENT_RESERVATION_LOST';
  end if;

  insert into public.dispatch_assignments(
    company_id, visit_id, crew_id, assigned_by, starts_at, ends_at,
    route_position, status
  )
  values (
    p_company_id, visit_row.id, crew_row.id, actor_user_id,
    receipt_row.starts_at, receipt_row.ends_at, 0, 'confirmed'
  );

  insert into public.visit_checklist_items(
    company_id, visit_id, template_item_id, status
  )
  select p_company_id, visit_row.id, item.id, 'pending'
  from public.checklist_template_items item
  where item.company_id = p_company_id
    and item.template_id = checklist_template_id_value
  order by item.sort_order;

  update public.jobs
  set status = 'scheduled', assigned_crew_id = crew_row.id
  where id = job_row.id
    and company_id = p_company_id
    and version = p_expected_version
    and status = 'ready_to_schedule'
  returning version into job_version_value;
  if not found then
    raise exception 'GOLDEN_PATH_JOB_VERSION_CONFLICT';
  end if;

  select *
  into authorization_row
  from private.scheduling_promotion_authorizations promotion_auth
  where promotion_auth.id = authorization_row.id;
  if authorization_row.visit_id is distinct from visit_row.id
    or authorization_row.visit_bound_at is null
    or authorization_row.dispatch_bound_at is null
    or authorization_row.job_bound_at is null
  then
    raise exception 'GOLDEN_PATH_PROMOTION_AUTHORIZATION_INCOMPLETE';
  end if;

  insert into public.scheduling_evidence_consumptions(
    company_id, evidence_receipt_id, visit_id, idempotency_key, consumed_by
  )
  values (
    p_company_id, receipt_row.id, visit_row.id, p_command_id::text,
    actor_user_id
  );

  delete from private.scheduling_promotion_authorizations
  where id = authorization_row.id;

  result := jsonb_build_object(
    'commandId', p_command_id,
    'commandType', p_command_type,
    'status', 'applied',
    'replayed', false,
    'entityId', visit_row.id,
    'version', visit_row.version,
    'jobId', job_row.id,
    'jobVersion', job_version_value,
    'startsAt', receipt_row.starts_at,
    'endsAt', receipt_row.ends_at,
    'crewId', crew_row.id,
    'routeCheckId', route_row.id,
    'weatherCheckId', weather_row.id,
    'schedulingEvidenceReceiptId', receipt_row.id,
    'calendarEventId', receipt_row.calendar_event_id,
    'requestHash', p_request_hash,
    'serverTime', now()
  );

  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now()
  where id = reservation_id
    and status = 'in_progress';
  if not found then
    raise exception 'GOLDEN_PATH_COMMAND_RESERVATION_LOST';
  end if;
  return result;
exception
  when invalid_text_representation then
    raise exception 'GOLDEN_PATH_INVALID_UUID';
end;
$$;

create or replace function public.get_storyops_booking_candidate(
  p_company_id uuid,
  p_job_id uuid,
  p_job_version integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  candidate public.scheduling_evidence_receipts%rowtype;
begin
  if actor_user_id is null
    or p_company_id is null
    or p_job_id is null
    or p_job_version < 1
    or not public.has_company_role(
      p_company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
  then
    raise exception 'BOOKING_CANDIDATE_BACK_OFFICE_REQUIRED';
  end if;

  select *
  into candidate
  from public.scheduling_evidence_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.job_id = p_job_id
    and receipt.job_version = p_job_version
    and receipt.evidence_mode = 'live'
    and receipt.capacity_disposition = 'eligible'
    and receipt.route_disposition = 'eligible'
    and receipt.weather_disposition = 'eligible'
    and receipt.expires_at > now()
    and cardinality(receipt.unknowns) = 0
    and jsonb_array_length(receipt.conflicts) = 0
    and not exists (
      select 1
      from public.scheduling_evidence_consumptions consumption
      where consumption.evidence_receipt_id = receipt.id
    )
  order by receipt.created_at desc, receipt.id
  limit 1;
  if not found then
    raise exception 'BOOKING_CANDIDATE_LIVE_EVIDENCE_REQUIRED';
  end if;

  return jsonb_build_object(
    'companyId', candidate.company_id,
    'jobId', candidate.job_id,
    'jobVersion', candidate.job_version,
    'schedulingEvidenceReceiptId', candidate.id,
    'expiresAt', candidate.expires_at,
    'evidenceHash', candidate.evidence_hash
  );
end;
$$;

alter table public.scheduling_evidence_receipts enable row level security;
alter table public.scheduling_evidence_receipts force row level security;
alter table public.scheduling_evidence_consumptions enable row level security;
alter table public.scheduling_evidence_consumptions force row level security;
alter table public.scheduling_equipment_reservations enable row level security;
alter table public.scheduling_equipment_reservations force row level security;

create policy scheduling_evidence_receipts_staff_select
on public.scheduling_evidence_receipts
for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
);

create policy scheduling_evidence_consumptions_staff_select
on public.scheduling_evidence_consumptions
for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
);

create policy scheduling_equipment_reservations_staff_select
on public.scheduling_equipment_reservations
for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
);

create trigger scheduling_evidence_receipts_audit
after insert or update or delete on public.scheduling_evidence_receipts
for each row execute function public.audit_mutation();

create trigger scheduling_evidence_consumptions_audit
after insert or update or delete on public.scheduling_evidence_consumptions
for each row execute function public.audit_mutation();

create trigger scheduling_equipment_reservations_audit
after insert or update or delete on public.scheduling_equipment_reservations
for each row execute function public.audit_mutation();

drop policy if exists jobs_backoffice_write on public.jobs;
drop policy if exists visits_backoffice_write on public.visits;
drop policy if exists visits_technician_update on public.visits;
drop policy if exists dispatch_assignments_backoffice_insert
  on public.dispatch_assignments;
drop policy if exists dispatch_assignments_backoffice_update
  on public.dispatch_assignments;
drop policy if exists dispatch_assignments_backoffice_delete
  on public.dispatch_assignments;
drop policy if exists route_checks_backoffice_insert on public.route_checks;
drop policy if exists route_checks_backoffice_update on public.route_checks;
drop policy if exists route_checks_backoffice_delete on public.route_checks;
drop policy if exists weather_checks_backoffice_insert on public.weather_checks;
drop policy if exists weather_checks_backoffice_update on public.weather_checks;
drop policy if exists weather_checks_backoffice_delete on public.weather_checks;

revoke insert, update, delete on table public.jobs
  from anon, authenticated, service_role;
revoke insert, update, delete on table public.visits
  from anon, authenticated, service_role;
revoke insert, update, delete on table public.dispatch_assignments
  from anon, authenticated, service_role;
revoke insert, update, delete on table public.route_checks
  from anon, authenticated, service_role;
revoke insert, update, delete on table public.weather_checks
  from anon, authenticated, service_role;
revoke insert, update, delete on table public.scheduling_evidence_receipts
  from anon, authenticated, service_role;
revoke insert, update, delete on table public.scheduling_evidence_consumptions
  from anon, authenticated, service_role;
revoke insert, update, delete on table public.scheduling_equipment_reservations
  from anon, authenticated, service_role;

grant select on table public.scheduling_evidence_receipts to authenticated;
grant select on table public.scheduling_evidence_consumptions to authenticated;
grant select on table public.scheduling_equipment_reservations
  to authenticated, service_role;

revoke all on function private.storyops_crew_has_authorized_technicians(
  uuid, uuid, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.storyops_route_context_is_current(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz, jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.storyops_route_response_matches_context(
  jsonb, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.storyops_canonical_json(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.storyops_json_sha256(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.storyops_scheduling_evidence_hash(
  public.scheduling_evidence_receipts
) from public, anon, authenticated, service_role;
revoke all on function public.storyops_scheduling_receipt_json(
  public.scheduling_evidence_receipts, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.set_storyops_scheduling_evidence_hash()
  from public, anon, authenticated, service_role;
revoke all on function public.protect_storyops_scheduling_evidence()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_storyops_scheduling_promotion()
  from public, anon, authenticated, service_role;
revoke all on function public.record_storyops_scheduling_evidence(
  uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.get_storyops_booking_candidate(
  uuid, uuid, integer
) from public, anon;
revoke all on function public.execute_storyops_golden_path_command(
  uuid, uuid, text, integer, jsonb, text
) from public, anon;

grant execute on function public.record_storyops_scheduling_evidence(
  uuid, uuid, text, text, jsonb
) to service_role;
grant execute on function public.get_storyops_booking_candidate(
  uuid, uuid, integer
) to authenticated;
grant execute on function public.execute_storyops_golden_path_command(
  uuid, uuid, text, integer, jsonb, text
) to authenticated;

comment on table public.scheduling_evidence_receipts is
  'Immutable provider-distinguishing calendar, route, weather, policy, and resource evidence. Sandbox receipts can never confirm visits.';
comment on table public.scheduling_equipment_reservations is
  'Exact per-asset interval holds created with live scheduling receipts and atomically consumed by booking.';
comment on function private.storyops_crew_has_authorized_technicians(
  uuid, uuid, timestamptz, timestamptz
) is
  'Returns true only when every date-valid crew member has a current active technician company membership.';
comment on function private.storyops_route_context_is_current(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz, jsonb
) is
  'Fail-closed exact-set check for target and committed crew-day visit versions, windows, properties, and reviewed coordinates.';
comment on function public.record_storyops_scheduling_evidence(
  uuid, uuid, text, text, jsonb
) is
  'Service-only idempotent recorder for exact provider evidence; records evidence but never promotes a visit.';
comment on function public.get_storyops_booking_candidate(
  uuid, uuid, integer
) is
  'Returns one unconsumed fresh live scheduling receipt identity to authorized back-office callers; booking still revalidates every fact.';
comment on function public.execute_storyops_golden_path_command(
  uuid, uuid, text, integer, jsonb, text
) is
  'Finite authenticated booking/invoice boundary. Booking consumes one fresh live receipt and atomically revalidates pricing, payment, calendar, route, weather, crew, equipment, and overlap.';
