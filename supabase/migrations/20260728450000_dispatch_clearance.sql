-- Fresh, live, single-use dispatch clearance.
--
-- Booking evidence proves that a visit was schedulable when booked. It is not
-- permission to leave hours or days later. This boundary rechecks exact current
-- NWS/VROOM facts immediately before confirmed -> en_route and makes every
-- other route into that transition fail closed, including offline replay.

create table public.dispatch_clearance_receipts (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null default 'storyops-dispatch-clearance-v1'
    check (schema_version = 'storyops-dispatch-clearance-v1'),
  company_id uuid not null references public.companies(id) on delete restrict,
  visit_id uuid not null references public.visits(id) on delete restrict,
  visit_version integer not null check (visit_version > 0),
  job_id uuid not null references public.jobs(id) on delete restrict,
  job_version integer not null check (job_version > 0),
  property_id uuid not null references public.properties(id) on delete restrict,
  property_version integer not null check (property_version > 0),
  property_geocoded_at timestamptz not null,
  crew_id uuid not null references public.crews(id) on delete restrict,
  crew_version integer not null check (crew_version > 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  evidence_mode text not null check (evidence_mode = 'live'),
  configuration_revision integer not null check (configuration_revision > 0),
  configuration_hash text not null check (configuration_hash ~ '^[a-f0-9]{64}$'),
  operating_baseline_publication_id uuid not null
    references public.company_operating_baseline_publications(id) on delete restrict,
  operating_baseline_hash text not null check (operating_baseline_hash ~ '^[a-f0-9]{64}$'),
  scheduling_evidence_receipt_id uuid not null
    references public.scheduling_evidence_receipts(id) on delete restrict,
  provider_snapshot_hash text not null check (provider_snapshot_hash ~ '^[a-f0-9]{64}$'),
  provider_bindings jsonb not null check (jsonb_typeof(provider_bindings) = 'array'),
  route_check_id uuid not null references public.route_checks(id) on delete restrict,
  route_disposition text not null check (route_disposition in ('eligible', 'ineligible', 'unknown')),
  route_observed_at timestamptz not null,
  route_expires_at timestamptz not null,
  route_request_hash text not null check (route_request_hash ~ '^[a-f0-9]{64}$'),
  route_response_hash text not null check (route_response_hash ~ '^[a-f0-9]{64}$'),
  weather_check_id uuid not null references public.weather_checks(id) on delete restrict,
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
    check (
      length(btrim(idempotency_key)) between 16 and 160
      and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  trace_id text check (trace_id is null or length(btrim(trace_id)) between 1 and 160),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, configuration_revision)
    references public.company_configuration_versions(company_id, revision)
    on delete restrict,
  check (ends_at > starts_at),
  check (route_expires_at > route_observed_at),
  check (weather_expires_at > weather_observed_at),
  check (expires_at = least(route_expires_at, weather_expires_at)),
  check (
    evidence_mode <> 'live'
    or (
      route_disposition = 'eligible'
      and weather_disposition = 'eligible'
      and cardinality(unknowns) = 0
      and jsonb_array_length(conflicts) = 0
    )
  )
);

create index dispatch_clearance_visit_idx
  on public.dispatch_clearance_receipts(
    company_id, visit_id, expires_at desc, created_at desc, id desc
  );

create table public.dispatch_clearance_consumptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  clearance_receipt_id uuid not null unique
    references public.dispatch_clearance_receipts(id) on delete restrict,
  visit_id uuid not null references public.visits(id) on delete restrict,
  command_id uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  previous_visit_version integer not null check (previous_visit_version > 0),
  resulting_visit_version integer not null
    check (resulting_visit_version = previous_visit_version + 1),
  previous_status text not null check (previous_status = 'confirmed'),
  resulting_status text not null check (resulting_status = 'en_route'),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  consumed_by uuid not null references auth.users(id) on delete restrict,
  consumed_at timestamptz not null default now(),
  unique (company_id, command_id)
);

create index dispatch_clearance_consumption_visit_idx
  on public.dispatch_clearance_consumptions(company_id, visit_id, consumed_at desc);

create table private.dispatch_clearance_transition_authorizations (
  id uuid primary key default gen_random_uuid(),
  backend_pid integer not null,
  transaction_id bigint not null,
  company_id uuid not null,
  visit_id uuid not null,
  clearance_receipt_id uuid not null,
  actor_user_id uuid not null,
  command_id uuid not null,
  expected_visit_version integer not null check (expected_visit_version > 0),
  transition_bound_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (backend_pid, transaction_id),
  unique (company_id, command_id)
);

revoke all on table private.dispatch_clearance_transition_authorizations
  from public, anon, authenticated, service_role;

create or replace function private.storyops_dispatch_actor_authorized(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_visit_id uuid
)
returns public.app_role
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  actor_role public.app_role;
  visit_row public.visits%rowtype;
begin
  if auth.role() not in ('service_role', 'authenticated')
    or (
      auth.role() = 'authenticated'
      and auth.uid() is distinct from p_actor_user_id
    )
  then
    raise exception 'DISPATCH_CLEARANCE_ACTOR_CONTEXT_INVALID';
  end if;
  select membership.role
  into actor_role
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
    and company.status = 'active'
  where membership.company_id = p_company_id
    and membership.user_id = p_actor_user_id
    and membership.active
    and membership.role in ('owner', 'dispatcher', 'technician');
  if actor_role is null then
    raise exception 'DISPATCH_CLEARANCE_ACTIVE_STAFF_REQUIRED';
  end if;
  select *
  into visit_row
  from public.visits visit
  where visit.company_id = p_company_id
    and visit.id = p_visit_id;
  if visit_row.id is null then
    raise exception 'DISPATCH_CLEARANCE_VISIT_NOT_FOUND';
  end if;
  if actor_role = 'technician' and not exists (
    select 1
    from public.crew_members member
    where member.company_id = p_company_id
      and member.crew_id = visit_row.crew_id
      and member.user_id = p_actor_user_id
      and member.starts_on <= visit_row.starts_at::date
      and (member.ends_on is null or member.ends_on >= visit_row.starts_at::date)
  ) then
    raise exception 'DISPATCH_CLEARANCE_ASSIGNMENT_REQUIRED';
  end if;
  return actor_role;
end;
$$;

create or replace function private.storyops_dispatch_provider_bindings(
  p_company_id uuid
)
returns jsonb
language sql
security definer
stable
set search_path = pg_catalog, public, private
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'connectionId', connection.id,
    'provider', connection.provider,
    'connectionVersion', connection.version,
    'ownerEnabled', connection.owner_enabled,
    'ownerMode', connection.mode,
    'ownerStatus', connection.status,
    'environmentMode', connection.environment_mode,
    'environmentStatus', connection.environment_status,
    'environmentFingerprint', connection.environment_fingerprint,
    'environmentProbeRunId', connection.environment_probe_run_id,
    'environmentCheckedAt', connection.environment_checked_at,
    'environmentExpiresAt', connection.environment_expires_at,
    'capabilities', to_jsonb(connection.capabilities),
    'environmentCapabilities', to_jsonb(connection.environment_capabilities)
  ) order by connection.provider), '[]'::jsonb)
  from public.integration_connections connection
  where connection.company_id = p_company_id
    and connection.provider in ('nws', 'vroom')
$$;

create or replace function private.storyops_dispatch_provider_snapshot_hash(
  p_company_id uuid
)
returns text
language sql
security definer
stable
set search_path = pg_catalog, public, private
as $$
  select public.storyops_json_sha256(jsonb_build_object(
    'schemaVersion', 'storyops-dispatch-provider-snapshot-v1',
    'companyId', p_company_id,
    'bindings', private.storyops_dispatch_provider_bindings(p_company_id)
  ))
$$;

create or replace function public.storyops_dispatch_clearance_hash(
  p_receipt public.dispatch_clearance_receipts
)
returns text
language sql
immutable
strict
set search_path = pg_catalog, public, extensions
as $$
  select encode(
    extensions.digest((to_jsonb(p_receipt) - 'evidence_hash')::text, 'sha256'),
    'hex'
  )
$$;

create or replace function public.set_storyops_dispatch_clearance_hash()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  new.evidence_hash := public.storyops_dispatch_clearance_hash(new);
  return new;
end;
$$;

create trigger dispatch_clearance_receipts_hash
before insert on public.dispatch_clearance_receipts
for each row execute function public.set_storyops_dispatch_clearance_hash();

create or replace function public.protect_storyops_dispatch_clearance()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'DISPATCH_CLEARANCE_IMMUTABLE';
end;
$$;

create trigger dispatch_clearance_receipts_immutable
before update or delete on public.dispatch_clearance_receipts
for each row execute function public.protect_storyops_dispatch_clearance();

create trigger dispatch_clearance_consumptions_immutable
before update or delete on public.dispatch_clearance_consumptions
for each row execute function public.protect_storyops_dispatch_clearance();

create or replace function public.storyops_dispatch_clearance_receipt_json(
  p_receipt public.dispatch_clearance_receipts,
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
    'visitId', p_receipt.visit_id,
    'visitVersion', p_receipt.visit_version,
    'jobId', p_receipt.job_id,
    'jobVersion', p_receipt.job_version,
    'propertyId', p_receipt.property_id,
    'propertyVersion', p_receipt.property_version,
    'crewId', p_receipt.crew_id,
    'crewVersion', p_receipt.crew_version,
    'startsAt', p_receipt.starts_at,
    'endsAt', p_receipt.ends_at,
    'evidenceMode', p_receipt.evidence_mode,
    'configurationRevision', p_receipt.configuration_revision,
    'configurationHash', p_receipt.configuration_hash,
    'operatingBaselinePublicationId',
      p_receipt.operating_baseline_publication_id,
    'operatingBaselineHash', p_receipt.operating_baseline_hash,
    'schedulingEvidenceReceiptId', p_receipt.scheduling_evidence_receipt_id,
    'providerSnapshotHash', p_receipt.provider_snapshot_hash,
    'routeCheckId', p_receipt.route_check_id,
    'routeDisposition', p_receipt.route_disposition,
    'routeObservedAt', p_receipt.route_observed_at,
    'routeExpiresAt', p_receipt.route_expires_at,
    'weatherCheckId', p_receipt.weather_check_id,
    'weatherDisposition', p_receipt.weather_disposition,
    'weatherObservedAt', p_receipt.weather_observed_at,
    'weatherExpiresAt', p_receipt.weather_expires_at,
    'unknowns', to_jsonb(p_receipt.unknowns),
    'conflicts', p_receipt.conflicts,
    'expiresAt', p_receipt.expires_at,
    'evidenceHash', p_receipt.evidence_hash,
    'requestHash', p_receipt.request_hash,
    'createdAt', p_receipt.created_at,
    'replayed', p_replayed
  )
$$;

create or replace function public.load_storyops_dispatch_clearance_candidate(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_visit_id uuid,
  p_expected_visit_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  actor_role public.app_role;
  visit_row public.visits%rowtype;
  job_row public.jobs%rowtype;
  property_row public.properties%rowtype;
  crew_row public.crews%rowtype;
  company_row public.companies%rowtype;
  configuration_row public.company_configuration_versions%rowtype;
  baseline_row public.company_operating_baseline_publications%rowtype;
  scheduling_row public.scheduling_evidence_receipts%rowtype;
  scheduling_route_row public.route_checks%rowtype;
  existing_row public.dispatch_clearance_receipts%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DISPATCH_CLEARANCE_SERVICE_ROLE_REQUIRED';
  end if;
  if p_company_id is null
    or p_actor_user_id is null
    or p_visit_id is null
    or p_expected_visit_version < 1
    or p_idempotency_key is null
    or length(btrim(p_idempotency_key)) not between 16 and 160
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  then
    raise exception 'DISPATCH_CLEARANCE_INVALID_REQUEST';
  end if;

  actor_role := private.storyops_dispatch_actor_authorized(
    p_company_id, p_actor_user_id, p_visit_id
  );

  select * into visit_row
  from public.visits visit
  where visit.company_id = p_company_id and visit.id = p_visit_id;
  select * into job_row
  from public.jobs job
  where job.company_id = p_company_id and job.id = visit_row.job_id;
  select * into property_row
  from public.properties property
  where property.company_id = p_company_id and property.id = job_row.property_id;
  select * into crew_row
  from public.crews crew
  where crew.company_id = p_company_id and crew.id = visit_row.crew_id;
  select * into company_row
  from public.companies company
  where company.id = p_company_id;
  select * into configuration_row
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.status = 'published';
  select * into baseline_row
  from public.company_operating_baseline_publications baseline
  where baseline.company_id = p_company_id
    and baseline.status = 'active';
  select * into scheduling_row
  from public.scheduling_evidence_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.id = visit_row.scheduling_evidence_receipt_id;
  select * into scheduling_route_row
  from public.route_checks route
  where route.company_id = p_company_id
    and route.id = scheduling_row.route_check_id;
  select * into existing_row
  from public.dispatch_clearance_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.idempotency_key = p_idempotency_key;

  if visit_row.id is null
    or visit_row.version <> p_expected_visit_version
    or job_row.id is null
    or property_row.id is null
    or not private.storyops_property_has_reviewed_geocode(
      p_company_id,
      property_row.id
    )
    or crew_row.id is null
    or company_row.id is null
  then
    raise exception 'DISPATCH_CLEARANCE_SCOPE_OR_VERSION_CONFLICT';
  end if;
  if existing_row.id is not null and (
    existing_row.visit_id <> p_visit_id
    or existing_row.visit_version <> p_expected_visit_version
    or existing_row.created_by <> p_actor_user_id
  ) then
    raise exception 'DISPATCH_CLEARANCE_IDEMPOTENCY_CONFLICT';
  end if;

  return jsonb_build_object(
    'actor', jsonb_build_object(
      'user_id', p_actor_user_id,
      'role', actor_role,
      'active', true
    ),
    'company', to_jsonb(company_row),
    'visit', to_jsonb(visit_row),
    'job', to_jsonb(job_row),
    'property', to_jsonb(property_row),
    'crew', to_jsonb(crew_row),
    'configuration', case
      when configuration_row.id is null then null
      else to_jsonb(configuration_row)
    end,
    'baseline', case
      when baseline_row.id is null then null
      else to_jsonb(baseline_row)
    end,
    'scheduling_receipt', case
      when scheduling_row.id is null then null
      else to_jsonb(scheduling_row)
    end,
    'scheduling_route', case
      when scheduling_route_row.id is null then null
      else to_jsonb(scheduling_route_row)
    end,
    'provider_bindings',
      private.storyops_dispatch_provider_bindings(p_company_id),
    'provider_snapshot_hash',
      private.storyops_dispatch_provider_snapshot_hash(p_company_id),
    'launch_authorized',
      private.storyops_launch_authorization_effective(p_company_id),
    'existing_receipt', case
      when existing_row.id is null then null
      else public.storyops_dispatch_clearance_receipt_json(existing_row, true)
    end,
    'server_time', now()
  );
end;
$$;

create or replace function public.record_storyops_dispatch_clearance(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions, auth
as $$
declare
  actor_role public.app_role;
  existing_row public.dispatch_clearance_receipts%rowtype;
  inserted_row public.dispatch_clearance_receipts%rowtype;
  visit_row public.visits%rowtype;
  job_row public.jobs%rowtype;
  property_row public.properties%rowtype;
  crew_row public.crews%rowtype;
  company_row public.companies%rowtype;
  configuration_row public.company_configuration_versions%rowtype;
  baseline_row public.company_operating_baseline_publications%rowtype;
  scheduling_row public.scheduling_evidence_receipts%rowtype;
  scheduling_route_row public.route_checks%rowtype;
  route_data jsonb;
  route_request jsonb;
  route_response jsonb;
  weather_data jsonb;
  weather_policy jsonb;
  current_weather_policy jsonb;
  provider_bindings_value jsonb;
  provider_snapshot_hash_value text;
  route_check_id_value uuid;
  weather_check_id_value uuid;
  effective_request_hash text;
  unexpected_key text;
  visit_id_value uuid;
  route_observed_at_value timestamptz;
  route_expires_at_value timestamptz;
  weather_observed_at_value timestamptz;
  weather_expires_at_value timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DISPATCH_CLEARANCE_SERVICE_ROLE_REQUIRED';
  end if;
  if p_company_id is null
    or p_actor_user_id is null
    or p_idempotency_key is null
    or length(btrim(p_idempotency_key)) not between 16 and 160
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_evidence is null
    or jsonb_typeof(p_evidence) <> 'object'
  then
    raise exception 'DISPATCH_CLEARANCE_INVALID_REQUEST';
  end if;

  effective_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'actorUserId', p_actor_user_id,
    'companyId', p_company_id,
    'expectedVisitVersion', (p_evidence ->> 'visitVersion')::integer,
    'idempotencyKey', p_idempotency_key,
    'schemaVersion', 'storyops-dispatch-clearance-request-v1',
    'visitId', p_evidence ->> 'visitId'
  ));
  if effective_request_hash <> p_request_hash then
    raise exception 'DISPATCH_CLEARANCE_REQUEST_HASH_MISMATCH';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-dispatch-clearance-refresh:'
      || p_company_id::text || ':' || p_idempotency_key,
    0
  ));
  select * into existing_row
  from public.dispatch_clearance_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.idempotency_key = p_idempotency_key;
  if existing_row.id is not null then
    if existing_row.request_hash <> p_request_hash
      or existing_row.visit_id::text <> p_evidence ->> 'visitId'
      or existing_row.visit_version <> (p_evidence ->> 'visitVersion')::integer
      or existing_row.created_by <> p_actor_user_id
    then
      raise exception 'DISPATCH_CLEARANCE_IDEMPOTENCY_CONFLICT';
    end if;
    return public.storyops_dispatch_clearance_receipt_json(existing_row, true);
  end if;

  select key into unexpected_key
  from jsonb_object_keys(p_evidence) keys(key)
  where key not in (
    'schemaVersion', 'evidenceMode', 'visitId', 'visitVersion',
    'jobId', 'jobVersion', 'propertyId', 'propertyVersion',
    'propertyGeocodedAt', 'crewId', 'crewVersion', 'startsAt', 'endsAt',
    'configurationRevision', 'configurationHash',
    'operatingBaselinePublicationId', 'operatingBaselineHash',
    'schedulingEvidenceReceiptId', 'providerSnapshotHash',
    'route', 'weather', 'unknowns', 'conflicts', 'traceId'
  )
  limit 1;
  if unexpected_key is not null
    or p_evidence ->> 'schemaVersion'
      <> 'storyops-dispatch-clearance-evidence-v1'
    or p_evidence ->> 'evidenceMode' <> 'live'
    or jsonb_typeof(p_evidence -> 'route') <> 'object'
    or jsonb_typeof(p_evidence -> 'weather') <> 'object'
    or jsonb_typeof(p_evidence -> 'unknowns') <> 'array'
    or jsonb_array_length(p_evidence -> 'unknowns') <> 0
    or jsonb_typeof(p_evidence -> 'conflicts') <> 'array'
    or jsonb_array_length(p_evidence -> 'conflicts') <> 0
  then
    raise exception 'DISPATCH_CLEARANCE_EVIDENCE_INVALID';
  end if;

  visit_id_value := (p_evidence ->> 'visitId')::uuid;
  actor_role := private.storyops_dispatch_actor_authorized(
    p_company_id, p_actor_user_id, visit_id_value
  );

  select * into visit_row
  from public.visits visit
  where visit.company_id = p_company_id and visit.id = visit_id_value
  for update;
  select * into job_row
  from public.jobs job
  where job.company_id = p_company_id and job.id = visit_row.job_id;
  select * into property_row
  from public.properties property
  where property.company_id = p_company_id and property.id = job_row.property_id;
  select * into crew_row
  from public.crews crew
  where crew.company_id = p_company_id and crew.id = visit_row.crew_id;
  select * into company_row
  from public.companies company
  where company.id = p_company_id;
  select * into configuration_row
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.status = 'published';
  select * into baseline_row
  from public.company_operating_baseline_publications baseline
  where baseline.company_id = p_company_id
    and baseline.status = 'active';
  select * into scheduling_row
  from public.scheduling_evidence_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.id = visit_row.scheduling_evidence_receipt_id;
  select * into scheduling_route_row
  from public.route_checks route
  where route.company_id = p_company_id
    and route.id = scheduling_row.route_check_id;

  if company_row.status <> 'active'
    or not private.storyops_launch_authorization_effective(p_company_id)
    or visit_row.status <> 'confirmed'
    or visit_row.version <> (p_evidence ->> 'visitVersion')::integer
    or visit_row.job_id <> (p_evidence ->> 'jobId')::uuid
    or visit_row.crew_id <> (p_evidence ->> 'crewId')::uuid
    or visit_row.starts_at <> (p_evidence ->> 'startsAt')::timestamptz
    or visit_row.ends_at <> (p_evidence ->> 'endsAt')::timestamptz
    or job_row.id is null
    or job_row.version <> (p_evidence ->> 'jobVersion')::integer
    or job_row.property_id <> (p_evidence ->> 'propertyId')::uuid
    or job_row.assigned_crew_id is distinct from visit_row.crew_id
    or job_row.status not in ('scheduled', 'in_progress')
    or property_row.id is null
    or not private.storyops_property_has_reviewed_geocode(
      p_company_id,
      property_row.id
    )
    or property_row.version <> (p_evidence ->> 'propertyVersion')::integer
    or property_row.geocoded_at
      is distinct from (p_evidence ->> 'propertyGeocodedAt')::timestamptz
    or property_row.latitude is null
    or property_row.longitude is null
    or property_row.geocode_confidence is null
    or property_row.geocode_confidence < 0.8
    or crew_row.id is null
    or crew_row.version <> (p_evidence ->> 'crewVersion')::integer
  then
    raise exception 'DISPATCH_CLEARANCE_CURRENT_SCOPE_CONFLICT';
  end if;

  if configuration_row.id is null
    or configuration_row.publication_mode <> 'live'
    or configuration_row.revision <> (p_evidence ->> 'configurationRevision')::integer
    or configuration_row.configuration_hash <> p_evidence ->> 'configurationHash'
    or baseline_row.id is null
    or baseline_row.configuration_revision <> configuration_row.revision
    or baseline_row.configuration_hash <> configuration_row.configuration_hash
    or baseline_row.id
      <> (p_evidence ->> 'operatingBaselinePublicationId')::uuid
    or baseline_row.baseline_hash <> p_evidence ->> 'operatingBaselineHash'
  then
    raise exception 'DISPATCH_CLEARANCE_CONFIGURATION_CHANGED';
  end if;

  if scheduling_row.id is null
    or scheduling_route_row.id is null
    or scheduling_row.id
      <> (p_evidence ->> 'schedulingEvidenceReceiptId')::uuid
    or scheduling_row.company_id <> p_company_id
    or scheduling_row.job_id <> job_row.id
    or scheduling_row.property_id <> property_row.id
    or scheduling_row.crew_id <> crew_row.id
    or scheduling_row.starts_at <> visit_row.starts_at
    or scheduling_row.ends_at <> visit_row.ends_at
    or scheduling_row.evidence_mode <> 'live'
    or scheduling_row.configuration_revision <> configuration_row.revision
    or scheduling_row.operating_baseline_publication_id <> baseline_row.id
    or scheduling_row.route_disposition <> 'eligible'
    or scheduling_row.weather_disposition <> 'eligible'
    or cardinality(scheduling_row.unknowns) <> 0
    or jsonb_array_length(scheduling_row.conflicts) <> 0
    or scheduling_row.evidence_hash
      <> public.storyops_scheduling_evidence_hash(scheduling_row)
  then
    raise exception 'DISPATCH_CLEARANCE_BOOKING_BINDING_INVALID';
  end if;

  provider_bindings_value :=
    private.storyops_dispatch_provider_bindings(p_company_id);
  provider_snapshot_hash_value :=
    private.storyops_dispatch_provider_snapshot_hash(p_company_id);
  if jsonb_array_length(provider_bindings_value) <> 2
    or exists (
      select 1
      from jsonb_array_elements(provider_bindings_value) binding
      where (binding ->> 'ownerEnabled')::boolean is not true
        or binding ->> 'ownerMode' <> 'live'
        or binding ->> 'ownerStatus' <> 'healthy'
        or binding ->> 'environmentMode' <> 'live'
        or binding ->> 'environmentStatus' <> 'healthy'
        or (binding ->> 'environmentCheckedAt')::timestamptz
          < now() - interval '15 minutes'
        or (binding ->> 'environmentCheckedAt')::timestamptz
          > now() + interval '1 minute'
        or (binding ->> 'environmentExpiresAt')::timestamptz <= now()
        or (
          binding ->> 'provider' = 'nws'
          and (
            not ((binding -> 'capabilities') ? 'weather')
            or not ((binding -> 'environmentCapabilities') ? 'weather')
          )
        )
        or (
          binding ->> 'provider' = 'vroom'
          and (
            not ((binding -> 'capabilities') ? 'routing')
            or not ((binding -> 'environmentCapabilities') ? 'routing')
          )
        )
    )
    or p_evidence ->> 'providerSnapshotHash'
      <> provider_snapshot_hash_value
  then
    raise exception 'DISPATCH_CLEARANCE_PROVIDER_AUTHORITY_CHANGED';
  end if;

  route_data := p_evidence -> 'route';
  route_request := route_data -> 'requestPayload';
  route_response := route_data -> 'responsePayload';
  route_observed_at_value := (route_data ->> 'observedAt')::timestamptz;
  route_expires_at_value := (route_data ->> 'expiresAt')::timestamptz;
  if route_data ->> 'provider' <> 'vroom'
    or route_data ->> 'disposition' <> 'eligible'
    or route_data ->> 'routeFeasible' <> 'true'
    or jsonb_typeof(route_data -> 'violations') <> 'array'
    or jsonb_array_length(route_data -> 'violations') <> 0
    or route_observed_at_value < now() - interval '2 minutes'
    or route_observed_at_value > now() + interval '1 minute'
    or route_expires_at_value
      <> route_observed_at_value + interval '10 minutes'
    or route_expires_at_value <= now()
    or route_request ->> 'schemaVersion'
      <> 'storyops-dispatch-route-request-v1'
    or route_request ->> 'companyId' <> p_company_id::text
    or route_request ->> 'visitId' <> visit_row.id::text
    or (route_request ->> 'visitVersion')::integer <> visit_row.version
    or route_request ->> 'jobId' <> job_row.id::text
    or (route_request ->> 'jobVersion')::integer <> job_row.version
    or route_request ->> 'propertyId' <> property_row.id::text
    or (route_request ->> 'propertyVersion')::integer <> property_row.version
    or route_request ->> 'crewId' <> crew_row.id::text
    or (route_request ->> 'crewVersion')::integer <> crew_row.version
    or route_request -> 'origin'
      is distinct from scheduling_route_row.request_payload -> 'origin'
    or (route_request #>> '{destination,latitude}')::numeric
      <> property_row.latitude
    or (route_request #>> '{destination,longitude}')::numeric
      <> property_row.longitude
    or (route_request ->> 'departureAt')::timestamptz
      <> route_observed_at_value
    or (route_request ->> 'arrivalDeadline')::timestamptz
      <> visit_row.starts_at
    or (route_request #>> '{visitWindow,start}')::timestamptz
      <> visit_row.starts_at
    or (route_request #>> '{visitWindow,end}')::timestamptz
      <> visit_row.ends_at
    or route_request ->> 'routingJobId'
      <> 'dispatch:' || visit_row.id::text
    or route_response ->> 'provider' <> 'vroom'
    or route_response ->> 'mode' <> 'live'
    or route_response ->> 'vehicleId' <> crew_row.id::text
    or route_response -> 'jobIds'
      <> jsonb_build_array('dispatch:' || visit_row.id::text)
    or route_response -> 'unassignedJobIds' <> '[]'::jsonb
    or (route_response ->> 'travelSeconds')::numeric < 0
    or (route_response ->> 'serviceSeconds')::numeric
      <> extract(epoch from (visit_row.ends_at - visit_row.starts_at))
    or (route_response ->> 'distanceMeters')::numeric < 0
    or (route_response #>> '{summary,travelSeconds}')::numeric
      <> (route_response ->> 'travelSeconds')::numeric
    or (route_response #>> '{summary,serviceSeconds}')::numeric
      <> (route_response ->> 'serviceSeconds')::numeric
    or (route_response #>> '{summary,distanceMeters}')::numeric
      <> (route_response ->> 'distanceMeters')::numeric
  then
    raise exception 'DISPATCH_CLEARANCE_ROUTE_INVALID';
  end if;

  weather_data := p_evidence -> 'weather';
  weather_policy := weather_data -> 'policy';
  current_weather_policy := company_row.settings -> 'weatherPolicy'
    || jsonb_build_object(
      'reviewReference',
        configuration_row.configuration #>>
          '{policies,safetyReview,evidenceReference}',
      'reviewedAt',
        configuration_row.configuration #>>
          '{policies,safetyReview,reviewedAt}',
      'configurationRevision', configuration_row.revision
    );
  weather_observed_at_value := (weather_data ->> 'observedAt')::timestamptz;
  weather_expires_at_value := (weather_data ->> 'expiresAt')::timestamptz;
  if weather_data ->> 'provider' <> 'nws'
    or weather_data ->> 'disposition' <> 'eligible'
    or weather_observed_at_value < now() - interval '2 minutes'
    or weather_observed_at_value > now() + interval '1 minute'
    or weather_expires_at_value
      <> weather_observed_at_value + interval '20 minutes'
    or weather_expires_at_value <= now()
    or (weather_data ->> 'forecastIssuedAt')::timestamptz
      < now() - interval '6 hours'
    or (weather_data ->> 'forecastIssuedAt')::timestamptz
      > now() + interval '2 minutes'
    or (weather_data ->> 'periodStartsAt')::timestamptz > visit_row.starts_at
    or (weather_data ->> 'periodEndsAt')::timestamptz < visit_row.ends_at
    or (weather_data ->> 'precipitationProbability')::numeric not between 0 and 1
    or (weather_data ->> 'windSpeedMph')::numeric < 0
    or weather_data ->> 'lightningRisk'
      not in ('none', 'low', 'elevated', 'severe', 'unknown')
    or weather_policy is distinct from current_weather_policy
    or weather_data ->> 'policyHash'
      <> public.storyops_json_sha256(weather_policy)
  then
    raise exception 'DISPATCH_CLEARANCE_WEATHER_INVALID';
  end if;

  insert into public.route_checks(
    company_id, provider, checked_at, route_feasible, drive_minutes,
    added_distance_miles, violations, request_payload, response_payload
  )
  values (
    p_company_id, 'vroom', route_observed_at_value, true,
    (route_data ->> 'driveMinutes')::integer,
    (route_data ->> 'distanceMiles')::numeric,
    '{}', route_request, route_response
  )
  returning id into route_check_id_value;

  insert into public.weather_checks(
    company_id, property_id, provider, forecast_issued_at, checked_at,
    period_starts_at, period_ends_at, temperature_f,
    precipitation_probability, wind_speed_mph, lightning_risk,
    condition_codes, policy_disposition, raw_forecast
  )
  values (
    p_company_id, property_row.id, 'nws',
    (weather_data ->> 'forecastIssuedAt')::timestamptz,
    weather_observed_at_value,
    (weather_data ->> 'periodStartsAt')::timestamptz,
    (weather_data ->> 'periodEndsAt')::timestamptz,
    (weather_data ->> 'temperatureF')::numeric,
    (weather_data ->> 'precipitationProbability')::numeric,
    (weather_data ->> 'windSpeedMph')::numeric,
    weather_data ->> 'lightningRisk',
    array(select jsonb_array_elements_text(weather_data -> 'conditionCodes')),
    'eligible', weather_data -> 'payload'
  )
  returning id into weather_check_id_value;

  insert into public.dispatch_clearance_receipts(
    company_id, visit_id, visit_version, job_id, job_version,
    property_id, property_version, property_geocoded_at,
    crew_id, crew_version, starts_at, ends_at, evidence_mode,
    configuration_revision, configuration_hash,
    operating_baseline_publication_id, operating_baseline_hash,
    scheduling_evidence_receipt_id, provider_snapshot_hash,
    provider_bindings, route_check_id, route_disposition,
    route_observed_at, route_expires_at, route_request_hash,
    route_response_hash, weather_check_id, weather_disposition,
    weather_observed_at, weather_expires_at, weather_policy_version,
    weather_policy_hash, weather_payload_hash, unknowns, conflicts,
    expires_at, evidence_hash, idempotency_key, request_hash,
    trace_id, created_by
  )
  values (
    p_company_id, visit_row.id, visit_row.version, job_row.id, job_row.version,
    property_row.id, property_row.version, property_row.geocoded_at,
    crew_row.id, crew_row.version, visit_row.starts_at, visit_row.ends_at, 'live',
    configuration_row.revision, configuration_row.configuration_hash,
    baseline_row.id, baseline_row.baseline_hash,
    scheduling_row.id, provider_snapshot_hash_value, provider_bindings_value,
    route_check_id_value, 'eligible', route_observed_at_value,
    route_expires_at_value, public.storyops_json_sha256(route_request),
    public.storyops_json_sha256(route_response), weather_check_id_value,
    'eligible', weather_observed_at_value, weather_expires_at_value,
    weather_data ->> 'policyVersion', weather_data ->> 'policyHash',
    public.storyops_json_sha256(weather_data -> 'payload'),
    '{}', '[]'::jsonb, least(route_expires_at_value, weather_expires_at_value),
    repeat('0', 64), p_idempotency_key, p_request_hash,
    nullif(btrim(p_evidence ->> 'traceId'), ''), p_actor_user_id
  )
  returning * into inserted_row;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id, retention_class, retain_until
  )
  values (
    p_company_id, 'user', p_actor_user_id::text,
    'visit.dispatch_clearance_refreshed', 'dispatch_clearance_receipt',
    inserted_row.id,
    jsonb_build_object(
      'visitId', inserted_row.visit_id,
      'visitVersion', inserted_row.visit_version,
      'routeCheckId', inserted_row.route_check_id,
      'weatherCheckId', inserted_row.weather_check_id,
      'expiresAt', inserted_row.expires_at,
      'actorRole', actor_role
    ),
    p_idempotency_key, 'audit', now() + interval '7 years'
  );

  return public.storyops_dispatch_clearance_receipt_json(inserted_row, false);
end;
$$;

create or replace function public.enforce_storyops_dispatch_clearance_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  authorization_row private.dispatch_clearance_transition_authorizations%rowtype;
  receipt_row public.dispatch_clearance_receipts%rowtype;
  clearance_required boolean;
begin
  clearance_required := new.status = 'en_route'
    and (tg_op = 'INSERT' or old.status is distinct from 'en_route');
  if not clearance_required then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'DISPATCH_CLEARANCE_CONFIRMED_VISIT_REQUIRED';
  end if;

  select * into authorization_row
  from private.dispatch_clearance_transition_authorizations transition_auth
  where transition_auth.backend_pid = pg_backend_pid()
    and transition_auth.transaction_id = txid_current()::bigint
    and transition_auth.company_id = new.company_id
    and transition_auth.visit_id = new.id
  for update;
  if authorization_row.id is null then
    raise exception 'DISPATCH_CLEARANCE_RECEIPT_REQUIRED';
  end if;

  select * into receipt_row
  from public.dispatch_clearance_receipts receipt
  where receipt.company_id = authorization_row.company_id
    and receipt.id = authorization_row.clearance_receipt_id
    and receipt.visit_id = authorization_row.visit_id;
  if receipt_row.id is null
    or old.status <> 'confirmed'
    or new.status <> 'en_route'
    or old.version <> authorization_row.expected_visit_version
    or receipt_row.visit_version <> authorization_row.expected_visit_version
    or new.company_id <> receipt_row.company_id
    or new.id <> receipt_row.visit_id
    or new.job_id <> receipt_row.job_id
    or new.crew_id <> receipt_row.crew_id
    or new.starts_at <> receipt_row.starts_at
    or new.ends_at <> receipt_row.ends_at
  then
    raise exception 'DISPATCH_CLEARANCE_TRANSITION_BINDING_MISMATCH';
  end if;

  update private.dispatch_clearance_transition_authorizations
  set transition_bound_at = statement_timestamp()
  where id = authorization_row.id;
  return new;
end;
$$;

create trigger visits_dispatch_clearance_guard
before insert or update on public.visits
for each row execute function public.enforce_storyops_dispatch_clearance_transition();

create or replace function public.consume_storyops_dispatch_clearance(
  p_company_id uuid,
  p_command_id uuid,
  p_expected_visit_version integer,
  p_clearance_receipt_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions, auth
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  effective_request_hash text;
  prior_consumption public.dispatch_clearance_consumptions%rowtype;
  receipt_row public.dispatch_clearance_receipts%rowtype;
  visit_row public.visits%rowtype;
  job_row public.jobs%rowtype;
  property_row public.properties%rowtype;
  crew_row public.crews%rowtype;
  configuration_row public.company_configuration_versions%rowtype;
  baseline_row public.company_operating_baseline_publications%rowtype;
  route_row public.route_checks%rowtype;
  weather_row public.weather_checks%rowtype;
  authorization_id uuid;
  resulting_visit_version integer;
  response_value jsonb;
begin
  if actor_user_id is null
    or p_company_id is null
    or p_command_id is null
    or p_expected_visit_version < 1
    or p_clearance_receipt_id is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'DISPATCH_CLEARANCE_CONSUME_INVALID_REQUEST';
  end if;

  effective_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'clearanceReceiptId', p_clearance_receipt_id,
    'companyId', p_company_id,
    'expectedVisitVersion', p_expected_visit_version,
    'operation', 'visit.dispatch_clearance.consume'
  ));
  if effective_request_hash <> p_request_hash then
    raise exception 'DISPATCH_CLEARANCE_CONSUME_HASH_MISMATCH';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-dispatch-clearance-consume:'
      || p_company_id::text || ':' || p_command_id::text,
    0
  ));
  select * into prior_consumption
  from public.dispatch_clearance_consumptions consumption
  where consumption.company_id = p_company_id
    and consumption.command_id = p_command_id;
  if prior_consumption.id is not null then
    if prior_consumption.request_hash <> p_request_hash
      or prior_consumption.clearance_receipt_id <> p_clearance_receipt_id
      or prior_consumption.previous_visit_version <> p_expected_visit_version
      or prior_consumption.consumed_by <> actor_user_id
    then
      raise exception 'DISPATCH_CLEARANCE_CONSUME_IDEMPOTENCY_CONFLICT';
    end if;
    return prior_consumption.response || jsonb_build_object('replayed', true);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-launch-authorization:' || p_company_id::text,
    0
  ));
  if not private.storyops_launch_authorization_effective(p_company_id) then
    raise exception 'DISPATCH_CLEARANCE_LAUNCH_NOT_AUTHORIZED';
  end if;

  select * into receipt_row
  from public.dispatch_clearance_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.id = p_clearance_receipt_id
  for update;
  if receipt_row.id is null then
    raise exception 'DISPATCH_CLEARANCE_RECEIPT_NOT_FOUND';
  end if;
  perform 1
  from public.dispatch_clearance_consumptions consumption
  where consumption.clearance_receipt_id = receipt_row.id;
  if found then
    raise exception 'DISPATCH_CLEARANCE_RECEIPT_ALREADY_CONSUMED';
  end if;

  actor_role := private.storyops_dispatch_actor_authorized(
    p_company_id, actor_user_id, receipt_row.visit_id
  );

  select * into visit_row
  from public.visits visit
  where visit.company_id = p_company_id and visit.id = receipt_row.visit_id
  for update;
  select * into job_row
  from public.jobs job
  where job.company_id = p_company_id and job.id = receipt_row.job_id
  for share;
  select * into property_row
  from public.properties property
  where property.company_id = p_company_id and property.id = receipt_row.property_id
  for share;
  select * into crew_row
  from public.crews crew
  where crew.company_id = p_company_id and crew.id = receipt_row.crew_id
  for share;
  select * into configuration_row
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.status = 'published';
  select * into baseline_row
  from public.company_operating_baseline_publications baseline
  where baseline.company_id = p_company_id
    and baseline.status = 'active';
  select * into route_row
  from public.route_checks route
  where route.company_id = p_company_id and route.id = receipt_row.route_check_id;
  select * into weather_row
  from public.weather_checks weather
  where weather.company_id = p_company_id
    and weather.id = receipt_row.weather_check_id;

  if visit_row.id is null
    or visit_row.status <> 'confirmed'
    or visit_row.version <> p_expected_visit_version
    or receipt_row.visit_version <> p_expected_visit_version
    or visit_row.job_id <> receipt_row.job_id
    or visit_row.crew_id <> receipt_row.crew_id
    or visit_row.starts_at <> receipt_row.starts_at
    or visit_row.ends_at <> receipt_row.ends_at
    or job_row.id is null
    or job_row.version <> receipt_row.job_version
    or job_row.property_id <> receipt_row.property_id
    or job_row.assigned_crew_id is distinct from receipt_row.crew_id
    or job_row.status not in ('scheduled', 'in_progress')
    or property_row.id is null
    or not private.storyops_property_has_reviewed_geocode(
      p_company_id,
      property_row.id
    )
    or property_row.version <> receipt_row.property_version
    or property_row.geocoded_at is distinct from receipt_row.property_geocoded_at
    or crew_row.id is null
    or crew_row.version <> receipt_row.crew_version
  then
    raise exception 'DISPATCH_CLEARANCE_SCOPE_CHANGED';
  end if;

  if configuration_row.id is null
    or configuration_row.publication_mode <> 'live'
    or configuration_row.revision <> receipt_row.configuration_revision
    or configuration_row.configuration_hash <> receipt_row.configuration_hash
    or baseline_row.id is null
    or baseline_row.id <> receipt_row.operating_baseline_publication_id
    or baseline_row.configuration_revision <> receipt_row.configuration_revision
    or baseline_row.configuration_hash <> receipt_row.configuration_hash
    or baseline_row.baseline_hash <> receipt_row.operating_baseline_hash
    or private.storyops_dispatch_provider_snapshot_hash(p_company_id)
      <> receipt_row.provider_snapshot_hash
    or private.storyops_dispatch_provider_bindings(p_company_id)
      is distinct from receipt_row.provider_bindings
    or exists (
      select 1
      from jsonb_array_elements(receipt_row.provider_bindings) binding
      where (binding ->> 'ownerEnabled')::boolean is not true
        or binding ->> 'ownerMode' <> 'live'
        or binding ->> 'ownerStatus' <> 'healthy'
        or binding ->> 'environmentMode' <> 'live'
        or binding ->> 'environmentStatus' <> 'healthy'
        or (binding ->> 'environmentCheckedAt')::timestamptz
          < now() - interval '15 minutes'
        or (binding ->> 'environmentCheckedAt')::timestamptz
          > now() + interval '1 minute'
        or (binding ->> 'environmentExpiresAt')::timestamptz <= now()
    )
  then
    raise exception 'DISPATCH_CLEARANCE_AUTHORITY_CHANGED';
  end if;

  if receipt_row.evidence_mode <> 'live'
    or receipt_row.route_disposition <> 'eligible'
    or receipt_row.weather_disposition <> 'eligible'
    or receipt_row.expires_at <= now()
    or receipt_row.route_observed_at < now() - interval '10 minutes'
    or receipt_row.weather_observed_at < now() - interval '20 minutes'
    or cardinality(receipt_row.unknowns) <> 0
    or jsonb_array_length(receipt_row.conflicts) <> 0
    or receipt_row.evidence_hash
      <> public.storyops_dispatch_clearance_hash(receipt_row)
    or route_row.id is null
    or route_row.provider <> 'vroom'
    or not route_row.route_feasible
    or cardinality(route_row.violations) <> 0
    or route_row.checked_at <> receipt_row.route_observed_at
    or public.storyops_json_sha256(route_row.request_payload)
      <> receipt_row.route_request_hash
    or public.storyops_json_sha256(route_row.response_payload)
      <> receipt_row.route_response_hash
    or weather_row.id is null
    or weather_row.provider <> 'nws'
    or weather_row.policy_disposition <> 'eligible'
    or weather_row.checked_at <> receipt_row.weather_observed_at
    or public.storyops_json_sha256(weather_row.raw_forecast)
      <> receipt_row.weather_payload_hash
  then
    raise exception 'DISPATCH_CLEARANCE_LIVE_FRESH_EVIDENCE_REQUIRED';
  end if;

  insert into private.dispatch_clearance_transition_authorizations(
    backend_pid, transaction_id, company_id, visit_id,
    clearance_receipt_id, actor_user_id, command_id,
    expected_visit_version
  )
  values (
    pg_backend_pid(), txid_current()::bigint, p_company_id,
    visit_row.id, receipt_row.id, actor_user_id, p_command_id,
    p_expected_visit_version
  )
  returning id into authorization_id;

  update public.visits visit
  set status = 'en_route',
      offline_revision = visit.offline_revision + 1,
      last_synced_at = now()
  where visit.id = visit_row.id
    and visit.company_id = p_company_id
    and visit.version = p_expected_visit_version
    and visit.status = 'confirmed'
  returning version into resulting_visit_version;
  if resulting_visit_version is null then
    raise exception 'DISPATCH_CLEARANCE_VISIT_VERSION_CONFLICT';
  end if;
  if not exists (
    select 1
    from private.dispatch_clearance_transition_authorizations transition_auth
    where transition_auth.id = authorization_id
      and transition_auth.transition_bound_at is not null
  ) then
    raise exception 'DISPATCH_CLEARANCE_TRANSITION_NOT_BOUND';
  end if;

  response_value := jsonb_build_object(
    'schemaVersion', 'storyops-dispatch-clearance-consumption-v1',
    'operation', 'visit.dispatch_clearance.consume',
    'companyId', p_company_id,
    'visitId', visit_row.id,
    'clearanceReceiptId', receipt_row.id,
    'commandId', p_command_id,
    'status', 'applied',
    'previousStatus', 'confirmed',
    'currentStatus', 'en_route',
    'previousVersion', p_expected_visit_version,
    'resultingVersion', resulting_visit_version,
    'requestHash', p_request_hash,
    'serverTime', now(),
    'replayed', false
  );

  insert into public.dispatch_clearance_consumptions(
    company_id, clearance_receipt_id, visit_id, command_id,
    request_hash, previous_visit_version, resulting_visit_version,
    previous_status, resulting_status, response, consumed_by
  )
  values (
    p_company_id, receipt_row.id, visit_row.id, p_command_id,
    p_request_hash, p_expected_visit_version, resulting_visit_version,
    'confirmed', 'en_route', response_value, actor_user_id
  );

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    before_data, after_data, request_id, retention_class, retain_until
  )
  values (
    p_company_id, 'user', actor_user_id::text,
    'visit.dispatch_clearance_consumed', 'visit', visit_row.id,
    jsonb_build_object(
      'status', 'confirmed',
      'version', p_expected_visit_version
    ),
    jsonb_build_object(
      'status', 'en_route',
      'version', resulting_visit_version,
      'clearanceReceiptId', receipt_row.id,
      'routeCheckId', receipt_row.route_check_id,
      'weatherCheckId', receipt_row.weather_check_id,
      'actorRole', actor_role
    ),
    p_command_id::text, 'audit', now() + interval '7 years'
  );

  return response_value;
end;
$$;

alter table public.dispatch_clearance_receipts enable row level security;
alter table public.dispatch_clearance_receipts force row level security;
alter table public.dispatch_clearance_consumptions enable row level security;
alter table public.dispatch_clearance_consumptions force row level security;

create policy dispatch_clearance_receipts_staff_select
on public.dispatch_clearance_receipts
for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
  or (
    public.has_company_role(
      company_id,
      array['technician']::public.app_role[]
    )
    and public.is_assigned_technician_for_visit(visit_id)
  )
);

create policy dispatch_clearance_consumptions_staff_select
on public.dispatch_clearance_consumptions
for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
  or (
    public.has_company_role(
      company_id,
      array['technician']::public.app_role[]
    )
    and public.is_assigned_technician_for_visit(visit_id)
  )
);

create trigger storyops_active_company_mutation_gate
before insert or update or delete on public.dispatch_clearance_receipts
for each row execute function
  public.assert_active_company_for_authenticated_mutation();

create trigger storyops_active_company_mutation_gate
before insert or update or delete on public.dispatch_clearance_consumptions
for each row execute function
  public.assert_active_company_for_authenticated_mutation();

create trigger dispatch_clearance_receipts_audit
after insert or update or delete on public.dispatch_clearance_receipts
for each row execute function public.audit_mutation();

create trigger dispatch_clearance_consumptions_audit
after insert or update or delete on public.dispatch_clearance_consumptions
for each row execute function public.audit_mutation();

revoke all on table public.dispatch_clearance_receipts
  from public, anon, authenticated, service_role;
revoke all on table public.dispatch_clearance_consumptions
  from public, anon, authenticated, service_role;
grant select on table public.dispatch_clearance_receipts to authenticated;
grant select on table public.dispatch_clearance_consumptions to authenticated;

revoke all on function private.storyops_dispatch_actor_authorized(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function private.storyops_dispatch_provider_bindings(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_dispatch_provider_snapshot_hash(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.storyops_dispatch_clearance_hash(
  public.dispatch_clearance_receipts
) from public, anon, authenticated, service_role;
revoke all on function public.set_storyops_dispatch_clearance_hash()
  from public, anon, authenticated, service_role;
revoke all on function public.protect_storyops_dispatch_clearance()
  from public, anon, authenticated, service_role;
revoke all on function public.storyops_dispatch_clearance_receipt_json(
  public.dispatch_clearance_receipts, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.load_storyops_dispatch_clearance_candidate(
  uuid, uuid, uuid, integer, text
) from public, anon, authenticated, service_role;
revoke all on function public.record_storyops_dispatch_clearance(
  uuid, uuid, text, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.enforce_storyops_dispatch_clearance_transition()
  from public, anon, authenticated, service_role;
revoke all on function public.consume_storyops_dispatch_clearance(
  uuid, uuid, integer, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.load_storyops_dispatch_clearance_candidate(
  uuid, uuid, uuid, integer, text
) to service_role;
grant execute on function public.record_storyops_dispatch_clearance(
  uuid, uuid, text, text, jsonb
) to service_role;
grant execute on function public.consume_storyops_dispatch_clearance(
  uuid, uuid, integer, uuid, text
) to authenticated;

comment on table public.dispatch_clearance_receipts is
  'Immutable, short-lived, exact-visit NWS/VROOM clearance. Live eligible receipts are single-use and never authorize offline departure.';
comment on function public.consume_storyops_dispatch_clearance(
  uuid, uuid, integer, uuid, text
) is
  'Atomically consumes one fresh exact dispatch receipt for confirmed -> en_route with role, version, assignment, provider, configuration, and replay checks.';
