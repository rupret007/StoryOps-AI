-- A field-media authorization canary is an internal, non-dispatchable fixture.
-- Its crew may be activated only inside the exact Edge finalization
-- transaction, must be inactive on entry and exit, and must still be inactive
-- when proof is verified or consumed.

create table private.storyops_field_media_canary_crews (
  verification_run_id uuid primary key,
  company_id uuid not null,
  crew_id uuid not null,
  customer_id uuid not null,
  job_id uuid not null,
  visit_id uuid not null,
  capture_authority text not null check (
    capture_authority in ('runtime_transition', 'migration_unverified')
  ),
  captured_at timestamptz not null default clock_timestamp()
);

create index storyops_field_media_canary_crews_company_crew_idx
  on private.storyops_field_media_canary_crews(company_id, crew_id);

revoke all on table private.storyops_field_media_canary_crews
  from public, anon, authenticated, service_role;

create table private.storyops_field_media_canary_registry_quarantine (
  verification_run_id uuid primary key,
  company_id uuid not null,
  observed_crew_id uuid,
  observed_job_id uuid,
  observed_visit_id uuid,
  reason_code text not null check (
    reason_code in ('LEGACY_CREW_MAPPING_UNPROVEN')
  ),
  requires_review boolean not null default true,
  resolution_code text check (
    resolution_code is null
    or resolution_code in (
      'controlled_fixture_retired',
      'observed_crew_confirmed_operational'
    )
  ),
  review_reference text,
  resolved_by_user_id uuid,
  resolution_command_id uuid,
  resolution_request_hash text check (
    resolution_request_hash is null
    or resolution_request_hash ~ '^[a-f0-9]{64}$'
  ),
  resolved_at timestamptz,
  quarantined_at timestamptz not null default clock_timestamp(),
  check (
    (
      requires_review
      and resolution_code is null
      and review_reference is null
      and resolved_by_user_id is null
      and resolution_command_id is null
      and resolution_request_hash is null
      and resolved_at is null
    )
    or (
      not requires_review
      and resolution_code is not null
      and review_reference is not null
      and resolved_by_user_id is not null
      and resolution_command_id is not null
      and resolution_request_hash is not null
      and resolved_at is not null
    )
  )
);

revoke all on table
  private.storyops_field_media_canary_registry_quarantine
  from public, anon, authenticated, service_role;

create table private.storyops_field_media_canary_crew_capabilities (
  capability_token uuid primary key,
  backend_pid integer not null,
  transaction_id bigint not null,
  company_id uuid not null,
  verification_run_id uuid not null,
  crew_id uuid not null,
  actor_user_id uuid not null,
  media_command_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (backend_pid, transaction_id, verification_run_id)
);

revoke all on table private.storyops_field_media_canary_crew_capabilities
  from public, anon, authenticated, service_role;

create or replace function private.capture_storyops_field_media_canary_crew()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  crew_id_value uuid;
  customer_id_value uuid;
begin
  if new.kind <> 'field_media_canary'
    or new.status <> 'awaiting_field_worker'
    or new.visit_id is null
    or new.job_id is null
  then
    return new;
  end if;

  select visit.crew_id, job.customer_id
  into crew_id_value, customer_id_value
  from public.visits visit
  join public.jobs job
    on job.id = new.job_id
   and job.id = visit.job_id
   and job.company_id = new.company_id
  join public.crews crew
    on crew.id = visit.crew_id
   and crew.company_id = new.company_id
  join public.customers customer
    on customer.id = job.customer_id
   and customer.company_id = new.company_id
  where visit.id = new.visit_id
    and visit.company_id = new.company_id
    and not crew.active
    and customer.lifecycle = 'inactive'
    and customer.do_not_contact
    and customer.acquisition_source = 'system_controlled_rehearsal'
    and customer.tags @> array['storyops-controlled-rehearsal']::text[]
    and visit.status in ('on_site', 'paused')
    and job.status = 'in_progress';

  if crew_id_value is null or customer_id_value is null then
    raise exception using
      errcode = '55000',
      message = 'FIELD_MEDIA_CANARY_REGISTRY_CAPTURE_INVALID';
  end if;

  insert into private.storyops_field_media_canary_crews(
    verification_run_id, company_id, crew_id, customer_id, job_id, visit_id,
    capture_authority
  )
  values (
    new.id, new.company_id, crew_id_value, customer_id_value, new.job_id,
    new.visit_id, 'runtime_transition'
  )
  on conflict (verification_run_id) do nothing;

  if not exists (
    select 1
    from private.storyops_field_media_canary_crews registry
    where registry.verification_run_id = new.id
      and registry.company_id = new.company_id
      and registry.crew_id = crew_id_value
      and registry.customer_id = customer_id_value
      and registry.job_id = new.job_id
      and registry.visit_id = new.visit_id
      and registry.capture_authority = 'runtime_transition'
  ) then
    raise exception using
      errcode = '55000',
      message = 'FIELD_MEDIA_CANARY_REGISTRY_CONFLICT';
  end if;

  return new;
end;
$$;

revoke all on function private.capture_storyops_field_media_canary_crew()
  from public, anon, authenticated, service_role;

create trigger trusted_pilot_field_media_registry_capture
after update of status, visit_id, job_id, property_id
on public.trusted_pilot_verification_runs
for each row
when (
  new.kind = 'field_media_canary'
  and new.status = 'awaiting_field_worker'
  and (
    old.status is distinct from new.status
    or old.visit_id is distinct from new.visit_id
    or old.job_id is distinct from new.job_id
  )
)
execute function private.capture_storyops_field_media_canary_crew();

create or replace function
  private.authorize_storyops_field_media_canary_crew_activation(
    p_company_id uuid,
    p_verification_run_id uuid,
    p_crew_id uuid,
    p_actor_user_id uuid,
    p_media_command_id uuid
  )
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  capability_token_value uuid := gen_random_uuid();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'FIELD_MEDIA_CANARY_SERVICE_ROLE_REQUIRED';
  end if;

  if not exists (
    select 1
    from public.trusted_pilot_verification_runs run
    join private.storyops_field_media_canary_crews registry
      on registry.verification_run_id = run.id
     and registry.company_id = run.company_id
    join public.crews crew
      on crew.id = registry.crew_id
     and crew.company_id = registry.company_id
    join public.visits visit
      on visit.id = registry.visit_id
     and visit.id = run.visit_id
     and visit.company_id = registry.company_id
    join public.jobs job
      on job.id = registry.job_id
     and job.id = run.job_id
      and job.id = visit.job_id
     and job.company_id = run.company_id
    join public.customers customer
      on customer.id = registry.customer_id
     and customer.id = job.customer_id
     and customer.company_id = job.company_id
    where run.id = p_verification_run_id
      and run.company_id = p_company_id
      and run.kind = 'field_media_canary'
      and run.status = 'executing'
      and run.assigned_user_id = p_actor_user_id
      and run.media_command_id = p_media_command_id
      and crew.id = p_crew_id
      and registry.capture_authority = 'runtime_transition'
      and not crew.active
      and customer.lifecycle = 'inactive'
      and customer.do_not_contact
      and customer.acquisition_source = 'system_controlled_rehearsal'
      and customer.tags @> array['storyops-controlled-rehearsal']::text[]
      and visit.status in ('on_site', 'paused')
      and job.status = 'in_progress'
  ) then
    raise exception using
      errcode = '55000',
      message = 'FIELD_MEDIA_CANARY_CREW_ISOLATION_INVALID';
  end if;

  delete from private.storyops_field_media_canary_crew_capabilities capability
  where capability.backend_pid = pg_backend_pid()
    and capability.transaction_id = txid_current();

  insert into private.storyops_field_media_canary_crew_capabilities(
    capability_token, backend_pid, transaction_id, company_id,
    verification_run_id, crew_id, actor_user_id, media_command_id
  )
  values (
    capability_token_value, pg_backend_pid(), txid_current(), p_company_id,
    p_verification_run_id, p_crew_id, p_actor_user_id, p_media_command_id
  );

  perform set_config(
    'storyops.field_media_canary_crew_capability',
    capability_token_value::text,
    true
  );
  return capability_token_value;
end;
$$;

revoke all on function
  private.authorize_storyops_field_media_canary_crew_activation(
    uuid, uuid, uuid, uuid, uuid
  )
  from public, anon, authenticated, service_role;

-- No run created before this control existed can prove which crew was
-- transactionally isolated. Capture its current mapping only for containment,
-- mark it untrusted, invalidate every legacy run/proof, and require a fresh
-- post-upgrade canary captured by the transition trigger above.
insert into private.storyops_field_media_canary_crews(
  verification_run_id, company_id, crew_id, customer_id, job_id, visit_id,
  capture_authority
)
select
  run.id,
  run.company_id,
  visit.crew_id,
  job.customer_id,
  run.job_id,
  run.visit_id,
  'migration_unverified'
from public.trusted_pilot_verification_runs run
join public.visits visit
  on visit.id = run.visit_id
 and visit.company_id = run.company_id
join public.jobs job
  on job.id = run.job_id
 and job.id = visit.job_id
 and job.company_id = run.company_id
join public.crews crew
  on crew.id = visit.crew_id
 and crew.id = job.assigned_crew_id
 and crew.company_id = run.company_id
join public.customers customer
  on customer.id = job.customer_id
 and customer.company_id = run.company_id
join public.audit_events creation
  on creation.company_id = run.company_id
 and creation.action = 'pilot.field_media_canary_session_created'
 and creation.entity_type = 'trusted_pilot_verification_run'
 and creation.entity_id = run.id
 and creation.after_data ->> 'controlledRehearsal' = 'true'
 and creation.after_data ->> 'customerVisible' = 'false'
 and creation.after_data ->> 'jobId' = run.job_id::text
 and creation.after_data ->> 'visitId' = run.visit_id::text
where run.kind = 'field_media_canary'
  and crew.name =
    'WashOps controlled rehearsal ' || left(run.id::text, 8)
  and crew.lead_technician_id = run.assigned_user_id
  and crew.home_base_postal_code = '00000'
  and customer.lifecycle = 'inactive'
  and customer.do_not_contact
  and customer.acquisition_source = 'system_controlled_rehearsal'
  and customer.tags @> array['storyops-controlled-rehearsal']::text[]
  and job.job_number = 'CANARY-' || left(run.id::text, 18)
  and job.status = 'in_progress'
  and visit.status in ('on_site', 'paused')
  and visit.internal_notes =
    'Controlled rehearsal only; no customer work or outbound action.'
on conflict (verification_run_id) do nothing;

insert into private.storyops_field_media_canary_registry_quarantine(
  verification_run_id, company_id, observed_crew_id, observed_job_id,
  observed_visit_id, reason_code
)
select
  run.id,
  run.company_id,
  visit.crew_id,
  run.job_id,
  run.visit_id,
  'LEGACY_CREW_MAPPING_UNPROVEN'
from public.trusted_pilot_verification_runs run
left join public.visits visit
  on visit.id = run.visit_id
 and visit.company_id = run.company_id
where run.kind = 'field_media_canary'
  and run.visit_id is not null
  and run.job_id is not null
  and not exists (
    select 1
    from private.storyops_field_media_canary_crews registry
    where registry.verification_run_id = run.id
  )
on conflict (verification_run_id) do nothing;

insert into public.audit_events(
  id, company_id, occurred_at, actor_type, actor_id, action,
  entity_type, entity_id, after_data, request_id,
  retention_class, retain_until
)
select
  gen_random_uuid(),
  run.company_id,
  clock_timestamp(),
  'system',
  'field-media-canary-isolation-upgrade',
  'pilot.field_media_canary_invalidated',
  'trusted_pilot_verification_run',
  run.id,
  jsonb_strip_nulls(jsonb_build_object(
    'reasonCode', case
      when registry.verification_run_id is null
        then 'LEGACY_CREW_MAPPING_QUARANTINED'
      else 'FIELD_MEDIA_CANARY_CONTROL_VERSION_UPGRADE'
    end,
    'verificationRunId', run.id,
    'priorRunStatus', run.status,
    'crewId', registry.crew_id,
    'captureAuthority', registry.capture_authority,
    'requiresReview', registry.verification_run_id is null,
    'freshCanaryRequired', true
  )),
  run.command_id::text,
  'audit',
  clock_timestamp() + interval '7 years'
from public.trusted_pilot_verification_runs run
left join private.storyops_field_media_canary_crews registry
  on registry.verification_run_id = run.id
 and registry.company_id = run.company_id
where run.kind = 'field_media_canary'
  and not (
    run.status in ('reserved', 'failed')
    and run.visit_id is null
    and run.job_id is null
  )
  and not exists (
    select 1
    from public.audit_events invalidation
    where invalidation.company_id = run.company_id
      and invalidation.action = 'pilot.field_media_canary_invalidated'
      and invalidation.entity_type = 'trusted_pilot_verification_run'
      and invalidation.entity_id = run.id
  );

-- Migration 43 accepted caller-supplied proof facts without a verifier-run
-- binding. Keep that history but append an explicit invalidation; the selector
-- below also requires an exact consumed run, so these events can never regain
-- launch authority.
insert into public.audit_events(
  id, company_id, occurred_at, actor_type, actor_id, action,
  entity_type, entity_id, after_data, request_id,
  retention_class, retain_until
)
select
  gen_random_uuid(),
  legacy.company_id,
  clock_timestamp(),
  'system',
  'field-media-canary-isolation-upgrade',
  'pilot.legacy_trusted_proof_invalidated',
  'pilot_release_evidence',
  legacy.entity_id,
  jsonb_build_object(
    'reasonCode', 'VERIFICATION_RUN_BINDING_REQUIRED',
    'legacyAuditEventId', legacy.id,
    'legacyEvidenceId', legacy.entity_id,
    'kind', legacy.after_data ->> 'kind',
    'freshCanaryRequired',
      legacy.after_data ->> 'kind' = 'field_media_canary'
  ),
  legacy.request_id,
  'audit',
  clock_timestamp() + interval '7 years'
from public.audit_events legacy
where legacy.action = 'pilot.evidence_recorded'
  and legacy.entity_type = 'pilot_release_evidence'
  and legacy.after_data ->> 'verificationBasis' = 'trusted_system_proof'
  and nullif(legacy.after_data #>> '{binding,verificationRunId}', '') is null
  and not exists (
    select 1
    from public.audit_events invalidation
    where invalidation.company_id = legacy.company_id
      and invalidation.action = 'pilot.legacy_trusted_proof_invalidated'
      and invalidation.entity_type = 'pilot_release_evidence'
      and invalidation.entity_id = legacy.entity_id
  );

do $$
declare
  company_id_value uuid;
begin
  for company_id_value in
    select distinct invalidation.company_id
    from public.audit_events invalidation
    where invalidation.action in (
        'pilot.field_media_canary_invalidated',
        'pilot.legacy_trusted_proof_invalidated'
      )
      and invalidation.actor_id = 'field-media-canary-isolation-upgrade'
  loop
    perform private.storyops_append_system_launch_revoke(
      company_id_value,
      'trusted-proof-control-version-upgrade'
    );
  end loop;
end;
$$;

update public.trusted_pilot_verification_runs run
set status = 'failed',
  failure_code = 'CANARY_CONTROL_VERSION_UPGRADE',
  completed_at = coalesce(run.completed_at, clock_timestamp()),
  updated_at = clock_timestamp()
where run.kind = 'field_media_canary'
  and run.status not in ('failed', 'consumed');

update public.crews crew
set active = false
where crew.active
  and exists (
    select 1
    from private.storyops_field_media_canary_crews registry
    where registry.company_id = crew.company_id
      and registry.crew_id = crew.id
      and registry.capture_authority = 'migration_unverified'
  );

-- Unresolved ambiguity is a launch blocker. Wrap the cumulative launch
-- effectiveness predicate from migration 61 and also guard the authorization
-- event insert so neither a stale event nor a new owner action can bypass it.
alter function private.storyops_launch_authorization_effective(uuid)
  rename to storyops_launch_authorization_base_before_canary_quarantine;

create or replace function private.storyops_launch_authorization_effective(
  p_company_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, private
as $$
  select
    private.storyops_launch_authorization_base_before_canary_quarantine(
      p_company_id
    )
    and not exists (
      select 1
      from private.storyops_field_media_canary_registry_quarantine quarantine
      where quarantine.company_id = p_company_id
        and quarantine.requires_review
    )
$$;

create or replace function
  private.enforce_storyops_canary_quarantine_launch_gate()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if new.action = 'authorize'
    and exists (
      select 1
      from private.storyops_field_media_canary_registry_quarantine quarantine
      where quarantine.company_id = new.company_id
        and quarantine.requires_review
    )
  then
    raise exception using
      errcode = '55000',
      message = 'FIELD_MEDIA_CANARY_QUARANTINE_REVIEW_REQUIRED';
  end if;
  return new;
end;
$$;

revoke all on function
  private.storyops_launch_authorization_base_before_canary_quarantine(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_launch_authorization_effective(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  private.enforce_storyops_canary_quarantine_launch_gate()
  from public, anon, authenticated, service_role;

create trigger storyops_00_canary_quarantine_launch_gate
before insert on public.company_launch_authorization_events
for each row
execute function private.enforce_storyops_canary_quarantine_launch_gate();

create or replace function
  public.get_storyops_field_media_canary_quarantine_state(
    p_company_id uuid
  )
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  actor_user_id uuid := auth.uid();
  items_value jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
    or not public.has_company_role(
      p_company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
  then
    raise exception using
      errcode = '42501',
      message = 'FIELD_MEDIA_CANARY_QUARANTINE_ACCESS_DENIED';
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'verificationRunId', quarantine.verification_run_id,
    'observedCrewId', quarantine.observed_crew_id,
    'observedJobId', quarantine.observed_job_id,
    'observedVisitId', quarantine.observed_visit_id,
    'reasonCode', quarantine.reason_code,
    'requiresReview', quarantine.requires_review,
    'resolutionCode', quarantine.resolution_code,
    'reviewReference', quarantine.review_reference,
    'quarantinedAt', quarantine.quarantined_at,
    'resolvedAt', quarantine.resolved_at
  )) order by quarantine.quarantined_at, quarantine.verification_run_id),
    '[]'::jsonb)
  into items_value
  from private.storyops_field_media_canary_registry_quarantine quarantine
  where quarantine.company_id = p_company_id;

  return jsonb_build_object(
    'schemaVersion', 'storyops-field-media-canary-quarantine-state-v1',
    'companyId', p_company_id,
    'launchBlocked', exists (
      select 1
      from private.storyops_field_media_canary_registry_quarantine quarantine
      where quarantine.company_id = p_company_id
        and quarantine.requires_review
    ),
    'items', items_value
  );
end;
$$;

revoke all on function
  public.get_storyops_field_media_canary_quarantine_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.get_storyops_field_media_canary_quarantine_state(uuid)
  to authenticated;

create or replace function
  public.resolve_storyops_field_media_canary_quarantine(
    p_company_id uuid,
    p_verification_run_id uuid,
    p_command_id uuid,
    p_resolution_code text,
    p_review_reference text,
    p_request_hash text
  )
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  effective_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  quarantine_row
    private.storyops_field_media_canary_registry_quarantine%rowtype;
  observed_crew_row public.crews%rowtype;
  response_value jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
    or not public.has_company_role(
      p_company_id,
      array['owner']::public.app_role[]
    )
  then
    raise exception using
      errcode = '42501',
      message = 'FIELD_MEDIA_CANARY_QUARANTINE_OWNER_REQUIRED';
  end if;
  if not public.lock_storyops_active_company(p_company_id) then
    raise exception using
      errcode = '42501',
      message = 'FIELD_MEDIA_CANARY_QUARANTINE_ACTIVE_COMPANY_REQUIRED';
  end if;
  if p_verification_run_id is null
    or p_command_id is null
    or p_resolution_code is null
    or p_resolution_code not in (
      'controlled_fixture_retired',
      'observed_crew_confirmed_operational'
    )
    or p_review_reference is null
    or length(btrim(p_review_reference)) not between 10 and 120
    or btrim(p_review_reference)
      !~ '^[A-Za-z0-9][A-Za-z0-9._-]{9,119}$'
    or p_request_hash is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'FIELD_MEDIA_CANARY_QUARANTINE_INVALID_REQUEST';
  end if;

  effective_hash := encode(extensions.digest(array_to_string(array[
    'storyops-field-media-canary-quarantine-resolution-v1',
    p_verification_run_id::text,
    p_resolution_code,
    btrim(p_review_reference)
  ], chr(31)), 'sha256'), 'hex');
  if p_request_hash <> effective_hash then
    raise exception
      'FIELD_MEDIA_CANARY_QUARANTINE_REQUEST_HASH_MISMATCH';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-field-media-canary-quarantine:'
      || p_company_id::text || ':' || p_verification_run_id::text,
    0
  ));
  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'field-media-canary-quarantine-resolution-v1',
    p_command_id::text,
    effective_hash,
    clock_timestamp() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys key_record
    where key_record.company_id = p_company_id
      and key_record.scope =
        'field-media-canary-quarantine-resolution-v1'
      and key_record.key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_hash then
      raise exception
        'FIELD_MEDIA_CANARY_QUARANTINE_IDEMPOTENCY_CONFLICT';
    end if;
    if reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception
      'FIELD_MEDIA_CANARY_QUARANTINE_COMMAND_IN_PROGRESS';
  end if;

  select *
  into quarantine_row
  from private.storyops_field_media_canary_registry_quarantine quarantine
  where quarantine.verification_run_id = p_verification_run_id
    and quarantine.company_id = p_company_id
  for update;
  if quarantine_row.verification_run_id is null then
    raise exception 'FIELD_MEDIA_CANARY_QUARANTINE_NOT_FOUND';
  end if;
  if not quarantine_row.requires_review then
    raise exception 'FIELD_MEDIA_CANARY_QUARANTINE_ALREADY_RESOLVED';
  end if;

  select *
  into observed_crew_row
  from public.crews crew
  where crew.id = quarantine_row.observed_crew_id
    and crew.company_id = p_company_id
  for update;
  if not found then
    raise exception 'FIELD_MEDIA_CANARY_QUARANTINE_CREW_NOT_FOUND';
  end if;

  perform 1
  from public.jobs job
  join public.visits visit
    on visit.id = quarantine_row.observed_visit_id
   and visit.job_id = job.id
   and visit.company_id = job.company_id
  where job.id = quarantine_row.observed_job_id
    and job.company_id = p_company_id
  for update of job, visit;
  if not found then
    raise exception 'FIELD_MEDIA_CANARY_QUARANTINE_WORK_NOT_FOUND';
  end if;

  -- A review reference is evidence of a human decision, not permission to
  -- mutate arbitrary work. Both dispositions require the exact, deterministic
  -- non-customer fixture graph to remain intact at the time it is retired.
  if not exists (
    select 1
    from public.trusted_pilot_verification_runs run
    join public.jobs job
      on job.id = quarantine_row.observed_job_id
     and job.id = run.job_id
     and job.company_id = run.company_id
    join public.visits visit
      on visit.id = quarantine_row.observed_visit_id
     and visit.id = run.visit_id
     and visit.job_id = job.id
     and visit.company_id = run.company_id
    join public.customers customer
      on customer.id = job.customer_id
     and customer.company_id = run.company_id
    join public.quotes quote
      on quote.id = job.quote_id
     and quote.company_id = run.company_id
     and quote.customer_id = customer.id
     and quote.property_id = job.property_id
    join public.estimates estimate
      on estimate.id = quote.estimate_id
     and estimate.company_id = run.company_id
     and estimate.customer_id = customer.id
     and estimate.property_id = job.property_id
    where run.id = p_verification_run_id
      and run.company_id = p_company_id
      and run.kind = 'field_media_canary'
      and customer.lifecycle = 'inactive'
      and customer.do_not_contact
      and customer.acquisition_source = 'system_controlled_rehearsal'
      and customer.tags
        @> array['storyops-controlled-rehearsal']::text[]
      and estimate.calculation_input ->> 'controlledRehearsal' = 'true'
      and quote.terms_version = 'controlled-rehearsal-v1'
      and quote.terms_snapshot =
        'Internal controlled rehearsal. Not a customer quote.'
      and job.job_number = 'CANARY-' || left(run.id::text, 18)
      and job.status = 'in_progress'
      and visit.status in ('on_site', 'paused')
      and visit.internal_notes =
        'Controlled rehearsal only; no customer work or outbound action.'
      and job.assigned_crew_id = quarantine_row.observed_crew_id
      and visit.crew_id = quarantine_row.observed_crew_id
  ) then
    raise exception
      'FIELD_MEDIA_CANARY_QUARANTINE_FIXTURE_NOT_PROVEN';
  end if;

  if p_resolution_code = 'controlled_fixture_retired'
    and (
      quarantine_row.observed_crew_id is null
      or not exists (
        select 1
        from public.trusted_pilot_verification_runs run
        join public.crews crew
          on crew.id = quarantine_row.observed_crew_id
         and crew.company_id = run.company_id
        where run.id = p_verification_run_id
          and run.company_id = p_company_id
          and crew.name =
            'WashOps controlled rehearsal ' || left(run.id::text, 8)
          and crew.lead_technician_id = run.assigned_user_id
          and crew.home_base_postal_code = '00000'
          and not crew.active
      )
    )
  then
    raise exception
      'FIELD_MEDIA_CANARY_QUARANTINE_CONTROLLED_CREW_NOT_PROVEN';
  end if;
  if p_resolution_code = 'observed_crew_confirmed_operational'
    and (
      quarantine_row.observed_crew_id is null
      or not exists (
      select 1
      from public.crews crew
      where crew.id = quarantine_row.observed_crew_id
        and crew.company_id = p_company_id
        and crew.active
        and crew.name <>
          'WashOps controlled rehearsal '
            || left(p_verification_run_id::text, 8)
        and crew.home_base_postal_code <> '00000'
      )
    )
  then
    raise exception
      'FIELD_MEDIA_CANARY_QUARANTINE_OPERATIONAL_CREW_NOT_PROVEN';
  end if;

  perform private.storyops_append_system_launch_revoke(
    p_company_id,
    'field-media-canary-quarantine-resolution'
  );

  -- Retire the synthetic work before clearing quarantine. The quarantine row
  -- becomes the immutable authority used by the guards below, so neither the
  -- job nor visit can later be returned to a field/dispatch state.
  if p_resolution_code = 'controlled_fixture_retired' then
    update public.crews
    set active = false,
      updated_at = clock_timestamp()
    where id = observed_crew_row.id
      and company_id = p_company_id;
  end if;
  update public.dispatch_assignments
  set status = 'cancelled',
    updated_at = clock_timestamp()
  where company_id = p_company_id
    and visit_id = quarantine_row.observed_visit_id
    and status <> 'cancelled';
  update public.visits
  set status = 'cancelled',
    updated_at = clock_timestamp()
  where id = quarantine_row.observed_visit_id
    and company_id = p_company_id
    and status in ('on_site', 'paused');
  if not found then
    raise exception
      'FIELD_MEDIA_CANARY_QUARANTINE_VISIT_RETIREMENT_FAILED';
  end if;
  update public.jobs
  set status = 'cancelled',
    assigned_crew_id = null,
    updated_at = clock_timestamp()
  where id = quarantine_row.observed_job_id
    and company_id = p_company_id
    and status = 'in_progress'
    and assigned_crew_id = quarantine_row.observed_crew_id;
  if not found then
    raise exception
      'FIELD_MEDIA_CANARY_QUARANTINE_JOB_RETIREMENT_FAILED';
  end if;

  update private.storyops_field_media_canary_registry_quarantine
  set requires_review = false,
    resolution_code = p_resolution_code,
    review_reference = btrim(p_review_reference),
    resolved_by_user_id = actor_user_id,
    resolution_command_id = p_command_id,
    resolution_request_hash = effective_hash,
    resolved_at = clock_timestamp()
  where verification_run_id = p_verification_run_id
    and company_id = p_company_id
    and requires_review
  returning * into quarantine_row;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id, retention_class, retain_until
  )
  values (
    p_company_id,
    'user',
    actor_user_id::text,
    'pilot.field_media_canary_quarantine_resolved',
    'trusted_pilot_verification_run',
    p_verification_run_id,
    jsonb_strip_nulls(jsonb_build_object(
      'resolutionCode', p_resolution_code,
      'reviewReference', btrim(p_review_reference),
      'observedCrewId', quarantine_row.observed_crew_id,
      'freshCanaryRequired', true
    )),
    p_command_id::text,
    'audit',
    clock_timestamp() + interval '7 years'
  );

  response_value := jsonb_build_object(
    'schemaVersion',
      'storyops-field-media-canary-quarantine-resolution-receipt-v1',
    'companyId', p_company_id,
    'verificationRunId', p_verification_run_id,
    'commandId', p_command_id,
    'resolutionCode', p_resolution_code,
    'requiresReview', false,
    'freshCanaryRequired', true,
    'replayed', false,
    'resolvedAt', quarantine_row.resolved_at
  );
  update public.idempotency_keys
  set status = 'completed',
    response = response_value,
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = reservation_id
    and status = 'in_progress';
  return response_value;
end;
$$;

revoke all on function
  public.resolve_storyops_field_media_canary_quarantine(
    uuid, uuid, uuid, text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.resolve_storyops_field_media_canary_quarantine(
    uuid, uuid, uuid, text, text, text
  )
  to authenticated;

create or replace function
  public.enforce_storyops_controlled_rehearsal_crew_inactive()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  verification_run_id_value uuid;
  capability_token_value uuid;
  retired_fixture_crew boolean := false;
begin
  if not new.active then
    return new;
  end if;
  if tg_op = 'UPDATE'
    and old.active is not distinct from new.active
  then
    return new;
  end if;

  select authority.verification_run_id, authority.retired
  into verification_run_id_value, retired_fixture_crew
  from (
    select
      registry.verification_run_id,
      false as retired,
      registry.captured_at as authority_at
    from private.storyops_field_media_canary_crews registry
    where registry.company_id = new.company_id
      and registry.crew_id = new.id
    union all
    select
      quarantine.verification_run_id,
      true as retired,
      quarantine.resolved_at as authority_at
    from private.storyops_field_media_canary_registry_quarantine quarantine
    where quarantine.company_id = new.company_id
      and quarantine.observed_crew_id = new.id
      and not quarantine.requires_review
      and quarantine.resolution_code = 'controlled_fixture_retired'
  ) authority
  order by authority.retired desc, authority.authority_at desc,
    authority.verification_run_id
  limit 1;

  if verification_run_id_value is null then
    return new;
  end if;
  if retired_fixture_crew then
    raise exception using
      errcode = '42501',
      message = 'RETIRED_CONTROLLED_REHEARSAL_CREW_ACTIVATION_FORBIDDEN';
  end if;

  begin
    capability_token_value := nullif(
      current_setting(
        'storyops.field_media_canary_crew_capability',
        true
      ),
      ''
    )::uuid;
  exception
    when invalid_text_representation then
      capability_token_value := null;
  end;

  if capability_token_value is null
    or not exists (
      select 1
      from private.storyops_field_media_canary_crew_capabilities capability
      join public.trusted_pilot_verification_runs run
        on run.id = capability.verification_run_id
       and run.company_id = capability.company_id
      where capability.capability_token = capability_token_value
        and capability.backend_pid = pg_backend_pid()
        and capability.transaction_id = txid_current()
        and capability.company_id = new.company_id
        and capability.verification_run_id = verification_run_id_value
        and capability.crew_id = new.id
        and run.kind = 'field_media_canary'
        and run.status = 'executing'
        and run.assigned_user_id = capability.actor_user_id
        and run.media_command_id = capability.media_command_id
    )
  then
    raise exception using
      errcode = '42501',
      message = 'CONTROLLED_REHEARSAL_CREW_ACTIVATION_FORBIDDEN';
  end if;

  return new;
end;
$$;

revoke all on function
  public.enforce_storyops_controlled_rehearsal_crew_inactive()
  from public, anon, authenticated, service_role;

create trigger crews_controlled_rehearsal_inactive
before insert or update of active on public.crews
for each row
execute function public.enforce_storyops_controlled_rehearsal_crew_inactive();

create or replace function
  private.enforce_storyops_retired_field_media_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  target_job_id uuid;
begin
  target_job_id := case when tg_op = 'DELETE' then old.id else new.id end;
  if not exists (
    select 1
    from private.storyops_field_media_canary_registry_quarantine quarantine
    where quarantine.observed_job_id = target_job_id
      and not quarantine.requires_review
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE'
    or new.status <> 'cancelled'
    or new.assigned_crew_id is not null
    or new.company_id is distinct from old.company_id
    or new.id is distinct from old.id
  then
    raise exception using
      errcode = '42501',
      message = 'RETIRED_FIELD_MEDIA_CANARY_JOB_IMMUTABLE';
  end if;
  return new;
end;
$$;

revoke all on function
  private.enforce_storyops_retired_field_media_job()
  from public, anon, authenticated, service_role;

create trigger jobs_retired_field_media_canary_guard
before update or delete on public.jobs
for each row execute function
  private.enforce_storyops_retired_field_media_job();

create or replace function
  private.enforce_storyops_retired_field_media_visit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  target_visit_id uuid;
begin
  target_visit_id := case when tg_op = 'DELETE' then old.id else new.id end;
  if not exists (
    select 1
    from private.storyops_field_media_canary_registry_quarantine quarantine
    where quarantine.observed_visit_id = target_visit_id
      and not quarantine.requires_review
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE'
    or new.status <> 'cancelled'
    or new.company_id is distinct from old.company_id
    or new.id is distinct from old.id
    or new.job_id is distinct from old.job_id
    or new.crew_id is distinct from old.crew_id
  then
    raise exception using
      errcode = '42501',
      message = 'RETIRED_FIELD_MEDIA_CANARY_VISIT_IMMUTABLE';
  end if;
  return new;
end;
$$;

revoke all on function
  private.enforce_storyops_retired_field_media_visit()
  from public, anon, authenticated, service_role;

create trigger visits_retired_field_media_canary_guard
before update or delete on public.visits
for each row execute function
  private.enforce_storyops_retired_field_media_visit();

create or replace function
  private.enforce_storyops_retired_field_media_dispatch()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  target_visit_id uuid;
begin
  if tg_op = 'UPDATE' then
    if exists (
      select 1
      from private.storyops_field_media_canary_registry_quarantine quarantine
      where quarantine.observed_visit_id in (old.visit_id, new.visit_id)
        and not quarantine.requires_review
    ) then
      raise exception using
        errcode = '42501',
        message = 'RETIRED_FIELD_MEDIA_CANARY_DISPATCH_FORBIDDEN';
    end if;
    return new;
  end if;

  target_visit_id := case
    when tg_op = 'INSERT' then new.visit_id
    else old.visit_id
  end;
  if exists (
    select 1
    from private.storyops_field_media_canary_registry_quarantine quarantine
    where quarantine.observed_visit_id = target_visit_id
      and not quarantine.requires_review
  ) then
    raise exception using
      errcode = '42501',
      message = 'RETIRED_FIELD_MEDIA_CANARY_DISPATCH_FORBIDDEN';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function
  private.enforce_storyops_retired_field_media_dispatch()
  from public, anon, authenticated, service_role;

create trigger dispatch_retired_field_media_canary_guard
before insert or update or delete on public.dispatch_assignments
for each row execute function
  private.enforce_storyops_retired_field_media_dispatch();

create or replace function public.finalize_storyops_media_upload_from_edge(
  p_company_id uuid,
  p_command_id uuid,
  p_actor_user_id uuid,
  p_payload jsonb,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  canary_run_id uuid;
  canary_crew_id uuid;
  canary_crew_was_active boolean;
  canary_fixture_valid boolean;
  changed_rows integer;
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'FIELD_MEDIA_EDGE_SERVICE_ROLE_REQUIRED';
  end if;

  select run.id
  into canary_run_id
  from public.trusted_pilot_verification_runs run
  where run.company_id = p_company_id
    and run.kind = 'field_media_canary'
    and run.status = 'executing'
    and run.assigned_user_id = p_actor_user_id
    and run.media_command_id = p_command_id
    and run.media_asset_id::text = p_payload ->> 'entityId'
    and run.visit_id::text = p_payload ->> 'visitId'
    and run.job_id::text = p_payload ->> 'jobId'
    and run.property_id::text = p_payload ->> 'propertyId'
    and run.object_path = p_payload ->> 'objectPath'
    and run.execution_command_id is not null
  for update;

  if canary_run_id is not null then
    select
      registry.crew_id,
      crew.active,
      registry.capture_authority = 'runtime_transition'
        and registry.visit_id::text = p_payload ->> 'visitId'
        and registry.job_id::text = p_payload ->> 'jobId'
        and visit.id = registry.visit_id
        and visit.crew_id = registry.crew_id
        and visit.job_id = registry.job_id
        and visit.status in ('on_site', 'paused')
        and job.id = registry.job_id
        and job.assigned_crew_id = registry.crew_id
        and job.customer_id = registry.customer_id
        and job.status = 'in_progress'
        and customer.id = registry.customer_id
        and customer.lifecycle = 'inactive'
        and customer.do_not_contact
        and customer.acquisition_source = 'system_controlled_rehearsal'
        and customer.tags
          @> array['storyops-controlled-rehearsal']::text[]
    into
      canary_crew_id,
      canary_crew_was_active,
      canary_fixture_valid
    from private.storyops_field_media_canary_crews registry
    join public.crews crew
      on crew.id = registry.crew_id
     and crew.company_id = registry.company_id
    left join public.visits visit
      on visit.id = registry.visit_id
     and visit.company_id = registry.company_id
    left join public.jobs job
      on job.id = registry.job_id
     and job.company_id = registry.company_id
    left join public.customers customer
      on customer.id = registry.customer_id
     and customer.company_id = registry.company_id
    where registry.verification_run_id = canary_run_id
      and registry.company_id = p_company_id
    for update of crew;

    if canary_crew_id is null
      or not coalesce(canary_fixture_valid, false)
      or coalesce(canary_crew_was_active, true)
      or exists (
        select 1
        from public.audit_events invalidation
        where invalidation.company_id = p_company_id
          and invalidation.action = 'pilot.field_media_canary_invalidated'
          and invalidation.entity_type = 'trusted_pilot_verification_run'
          and invalidation.entity_id = canary_run_id
      )
    then
      raise exception using
        errcode = '55000',
        message = 'FIELD_MEDIA_CANARY_CREW_ISOLATION_INVALID';
    end if;

    perform private.authorize_storyops_field_media_canary_crew_activation(
      p_company_id,
      canary_run_id,
      canary_crew_id,
      p_actor_user_id,
      p_command_id
    );
    update public.crews
    set active = true
    where id = canary_crew_id
      and company_id = p_company_id
      and not active;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using
        errcode = '55000',
        message = 'FIELD_MEDIA_CANARY_CREW_ACTIVATION_FAILED';
    end if;
  end if;

  result := public.finalize_storyops_media_upload(
    p_company_id,
    p_command_id,
    p_actor_user_id,
    p_payload,
    p_request_hash
  );

  if canary_run_id is not null then
    update public.crews
    set active = false
    where id = canary_crew_id
      and company_id = p_company_id
      and active;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using
        errcode = '55000',
        message = 'FIELD_MEDIA_CANARY_CREW_DEACTIVATION_FAILED';
    end if;

    delete from private.storyops_field_media_canary_crew_capabilities capability
    where capability.backend_pid = pg_backend_pid()
      and capability.transaction_id = txid_current()
      and capability.verification_run_id = canary_run_id
      and capability.crew_id = canary_crew_id;
    perform set_config(
      'storyops.field_media_canary_crew_capability',
      '',
      true
    );
  end if;

  return result;
end;
$$;

revoke all on function public.finalize_storyops_media_upload_from_edge(
  uuid, uuid, uuid, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_storyops_media_upload_from_edge(
  uuid, uuid, uuid, jsonb, text
) to service_role;

comment on function public.finalize_storyops_media_upload_from_edge(
  uuid, uuid, uuid, jsonb, text
) is
  'Service-role-only Edge adapter. An exact controlled field-media canary must enter and leave with an inactive crew; its finite activation is authorized by a transaction-bound private capability.';

create or replace function
  public.enforce_storyops_field_media_canary_completion_isolation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  crew_id_value uuid;
  crew_active_value boolean;
  fixture_valid_value boolean;
begin
  if new.kind <> 'field_media_canary'
    or new.status not in ('verified', 'consumed')
    or new.status is not distinct from old.status
  then
    return new;
  end if;

  select
    registry.crew_id,
    crew.active,
    registry.capture_authority = 'runtime_transition'
      and registry.visit_id = new.visit_id
      and registry.job_id = new.job_id
      and visit.id = registry.visit_id
      and visit.crew_id = registry.crew_id
      and visit.job_id = registry.job_id
      and job.id = registry.job_id
      and job.assigned_crew_id = registry.crew_id
      and job.customer_id = registry.customer_id
      and customer.id = registry.customer_id
      and customer.lifecycle = 'inactive'
      and customer.do_not_contact
      and customer.acquisition_source = 'system_controlled_rehearsal'
      and customer.tags @> array['storyops-controlled-rehearsal']::text[]
      and visit.status in ('on_site', 'paused')
      and job.status = 'in_progress'
  into crew_id_value, crew_active_value, fixture_valid_value
  from private.storyops_field_media_canary_crews registry
  join public.crews crew
    on crew.id = registry.crew_id
   and crew.company_id = registry.company_id
  left join public.visits visit
    on visit.id = registry.visit_id
   and visit.company_id = registry.company_id
  left join public.jobs job
    on job.id = registry.job_id
   and job.company_id = registry.company_id
  left join public.customers customer
    on customer.id = registry.customer_id
   and customer.company_id = registry.company_id
  where registry.verification_run_id = new.id
    and registry.company_id = new.company_id
  for update of crew;

  if crew_id_value is null
    or crew_active_value
    or not coalesce(fixture_valid_value, false)
    or exists (
      select 1
      from public.audit_events invalidation
      where invalidation.company_id = new.company_id
        and invalidation.action = 'pilot.field_media_canary_invalidated'
        and invalidation.entity_type = 'trusted_pilot_verification_run'
        and invalidation.entity_id = new.id
    )
  then
    raise exception using
      errcode = '55000',
      message = 'FIELD_MEDIA_CANARY_COMPLETION_NOT_ISOLATED';
  end if;

  return new;
end;
$$;

revoke all on function
  public.enforce_storyops_field_media_canary_completion_isolation()
  from public, anon, authenticated, service_role;

create trigger trusted_pilot_field_media_completion_isolation
before update of status on public.trusted_pilot_verification_runs
for each row
when (
  new.kind = 'field_media_canary'
  and new.status in ('verified', 'consumed')
  and old.status is distinct from new.status
)
execute function
  public.enforce_storyops_field_media_canary_completion_isolation();

create or replace function private.storyops_current_trusted_proofs(
  p_company_id uuid
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  with evidence as (
    select distinct on (
      audit.after_data ->> 'kind',
      coalesce(audit.after_data ->> 'provider', ''),
      audit.after_data #>> '{binding,capability}'
    )
      audit.id,
      audit.entity_id,
      audit.occurred_at,
      audit.after_data
    from public.audit_events audit
    where audit.company_id = p_company_id
      and audit.action = 'pilot.evidence_recorded'
      and audit.entity_type = 'pilot_release_evidence'
      and audit.after_data ->> 'verificationBasis' = 'trusted_system_proof'
      and audit.after_data #>> '{binding,verificationRunId}'
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and exists (
        select 1
        from public.trusted_pilot_verification_runs run
        where run.id =
            (audit.after_data #>> '{binding,verificationRunId}')::uuid
          and run.company_id = audit.company_id
          and run.kind = audit.after_data ->> 'kind'
          and coalesce(run.provider, '') =
            coalesce(audit.after_data ->> 'provider', '')
          and run.capability =
            audit.after_data #>> '{binding,capability}'
          and run.status = 'consumed'
          and run.proof_receipt ->> 'evidenceId' = audit.entity_id::text
          and run.evidence_reference =
            audit.after_data ->> 'evidenceReference'
          and run.artifact_sha256 =
            audit.after_data ->> 'artifactSha256'
          and (
            run.kind <> 'field_media_canary'
            or exists (
              select 1
              from private.storyops_field_media_canary_crews registry
              join public.crews crew
                on crew.id = registry.crew_id
               and crew.company_id = registry.company_id
              where registry.verification_run_id = run.id
                and registry.company_id = run.company_id
                and registry.capture_authority = 'runtime_transition'
                and registry.visit_id = run.visit_id
                and registry.job_id = run.job_id
                and not crew.active
            )
          )
      )
      and (audit.after_data #>> '{binding,configurationRevision}')::integer = (
        select configuration.revision
        from public.company_configuration_versions configuration
        where configuration.company_id = p_company_id
          and configuration.status = 'published'
          and configuration.publication_mode = 'live'
      )
      and audit.after_data #>> '{binding,configurationHash}' = (
        select configuration.configuration_hash
        from public.company_configuration_versions configuration
        where configuration.company_id = p_company_id
          and configuration.status = 'published'
          and configuration.publication_mode = 'live'
      )
      and (audit.after_data #>> '{binding,baselineId}')::uuid = (
        select baseline.id
        from public.company_operating_baseline_publications baseline
        where baseline.company_id = p_company_id
          and baseline.status = 'active'
      )
      and audit.after_data #>> '{binding,baselineHash}' = (
        select baseline.baseline_hash
        from public.company_operating_baseline_publications baseline
        where baseline.company_id = p_company_id
          and baseline.status = 'active'
      )
      and not exists (
        select 1
        from public.audit_events invalidation
        where invalidation.company_id = audit.company_id
          and invalidation.action = 'pilot.field_media_canary_invalidated'
          and invalidation.entity_type = 'trusted_pilot_verification_run'
          and invalidation.entity_id =
            (audit.after_data #>> '{binding,verificationRunId}')::uuid
      )
    order by
      audit.after_data ->> 'kind',
      coalesce(audit.after_data ->> 'provider', ''),
      audit.after_data #>> '{binding,capability}',
      audit.occurred_at desc,
      case when audit.after_data ->> 'outcome' = 'failed' then 0 else 1 end,
      audit.id desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'auditEventId', evidence.id,
    'evidenceId', evidence.entity_id,
    'kind', evidence.after_data ->> 'kind',
    'provider', evidence.after_data ->> 'provider',
    'capability', evidence.after_data #>> '{binding,capability}',
    'outcome', evidence.after_data ->> 'outcome',
    'expiresAt', evidence.after_data ->> 'expiresAt',
    'artifactSha256', evidence.after_data ->> 'artifactSha256',
    'binding', evidence.after_data -> 'binding'
  ) order by
    evidence.after_data ->> 'kind',
    coalesce(evidence.after_data ->> 'provider', ''),
    evidence.after_data #>> '{binding,capability}'
  ), '[]'::jsonb)
  from evidence
$$;

revoke all on function private.storyops_current_trusted_proofs(uuid)
  from public, anon, authenticated, service_role;
