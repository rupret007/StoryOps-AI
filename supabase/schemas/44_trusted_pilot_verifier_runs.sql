-- Authorization-grade pilot verification runs. A proof can only be minted
-- from one server-reserved, immutable, successfully verified run.

create or replace function private.storyops_revoke_launch_before_company_deactivation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if old.status = 'active' and new.status <> 'active' then
    perform private.storyops_append_system_launch_revoke(
      old.id,
      'company-status-left-active'
    );
  end if;
  return new;
end;
$$;

revoke all on function
  private.storyops_revoke_launch_before_company_deactivation()
  from public, anon, authenticated, service_role;

create trigger storyops_00_launch_revoke_before_deactivation
before update of status on public.companies
for each row
when (old.status = 'active' and new.status <> 'active')
execute function private.storyops_revoke_launch_before_company_deactivation();

create table public.trusted_pilot_verification_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  command_id uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  execution_command_id uuid,
  execution_request_hash text check (
    execution_request_hash is null or execution_request_hash ~ '^[a-f0-9]{64}$'
  ),
  kind text not null check (
    kind in ('provider_canary', 'field_media_canary', 'backup_restore')
  ),
  provider text,
  capability text not null check (capability ~ '^[a-z][a-z0-9_]{2,79}$'),
  status text not null check (
    status in (
      'reserved', 'awaiting_field_worker', 'executing', 'unknown',
      'verified', 'failed', 'consumed'
    )
  ),
  requested_by_user_id uuid not null references auth.users(id) on delete restrict,
  assigned_user_id uuid references auth.users(id) on delete restrict,
  field_worker_role text check (
    field_worker_role is null
    or field_worker_role in ('technician', 'owner_field_worker')
  ),
  integration_connection_id uuid
    references public.integration_connections(id) on delete restrict,
  integration_version integer check (
    integration_version is null or integration_version > 0
  ),
  configuration_revision integer not null check (configuration_revision > 0),
  configuration_hash text not null check (
    configuration_hash ~ '^[a-f0-9]{64}$'
  ),
  baseline_id uuid not null
    references public.company_operating_baseline_publications(id) on delete restrict,
  baseline_hash text not null check (baseline_hash ~ '^[a-f0-9]{64}$'),
  visit_id uuid references public.visits(id) on delete restrict,
  job_id uuid references public.jobs(id) on delete restrict,
  property_id uuid references public.properties(id) on delete restrict,
  media_asset_id uuid,
  media_command_id uuid,
  media_captured_at timestamptz,
  object_path text,
  evidence_basis text check (
    evidence_basis is null
    or evidence_basis in (
      'external_read', 'deterministic_local',
      'authenticated_field_media', 'signed_isolated_restore'
    )
  ),
  external_operation text check (
    external_operation is null
    or external_operation ~ '^[a-z][a-z0-9_.-]{2,79}$'
  ),
  evidence_reference text check (
    evidence_reference is null
    or evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{4,119}$'
  ),
  artifact_sha256 text check (
    artifact_sha256 is null or artifact_sha256 ~ '^[a-f0-9]{64}$'
  ),
  observed_at timestamptz,
  expires_at timestamptz,
  failure_code text check (
    failure_code is null or failure_code ~ '^[A-Z][A-Z0-9_]{2,79}$'
  ),
  proof_receipt jsonb,
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  consumed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (company_id, command_id),
  unique (company_id, execution_command_id),
  check (
    (kind = 'provider_canary' and provider is not null)
    or (kind = 'field_media_canary' and provider = 'signed_storage_targets')
    or (kind = 'backup_restore' and provider is null)
  ),
  check (
    (
      kind = 'field_media_canary'
      and assigned_user_id is not null
      and field_worker_role is not null
      and (
        field_worker_role = 'technician'
        or assigned_user_id = requested_by_user_id
      )
    )
    or (
      kind <> 'field_media_canary'
      and assigned_user_id is null
      and field_worker_role is null
    )
  ),
  check (
    (kind = 'field_media_canary' and (
      (
        status in ('reserved', 'failed')
        and visit_id is null and job_id is null and property_id is null
      )
      or (
        visit_id is not null and job_id is not null and property_id is not null
      )
    ))
    or (kind <> 'field_media_canary' and visit_id is null
      and job_id is null and property_id is null)
  ),
  check (
    (status in ('verified', 'consumed')
      and evidence_basis is not null
      and evidence_reference is not null
      and artifact_sha256 is not null
      and observed_at is not null
      and expires_at is not null
      and expires_at > observed_at)
    or status not in ('verified', 'consumed')
  )
);

create index trusted_pilot_verification_runs_company_status_idx
  on public.trusted_pilot_verification_runs(company_id, status, created_at desc);
create index trusted_pilot_verification_runs_expiry_idx
  on public.trusted_pilot_verification_runs(expires_at)
  where status in ('verified', 'consumed');

alter table public.trusted_pilot_verification_runs enable row level security;

create trigger storyops_active_company_mutation_gate
before insert or update or delete
on public.trusted_pilot_verification_runs
for each row execute function
  public.assert_active_company_for_authenticated_mutation();

create policy trusted_pilot_verification_runs_read
  on public.trusted_pilot_verification_runs
  for select
  to authenticated
  using (
    public.has_company_role(
      company_id,
      array['owner']::public.app_role[]
    )
    or assigned_user_id = auth.uid()
  );

revoke all on table public.trusted_pilot_verification_runs
  from public, anon, authenticated, service_role;
grant select on table public.trusted_pilot_verification_runs to authenticated;

create or replace function private.storyops_verifier_run_response(
  p_run public.trusted_pilot_verification_runs,
  p_execute boolean,
  p_replayed boolean
)
returns jsonb
language sql
set search_path = pg_catalog, public
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 'storyops-trusted-verification-run-v1',
    'runId', p_run.id,
    'companyId', p_run.company_id,
    'commandId', p_run.command_id,
    'executionCommandId', p_run.execution_command_id,
    'kind', p_run.kind,
    'provider', p_run.provider,
    'capability', p_run.capability,
    'status', p_run.status,
    'execute', p_execute,
    'replayed', p_replayed,
    'visitId', p_run.visit_id,
    'jobId', p_run.job_id,
    'propertyId', p_run.property_id,
    'assignedUserId', p_run.assigned_user_id,
    'fieldWorkerRole', p_run.field_worker_role,
    'mediaAssetId', p_run.media_asset_id,
    'mediaCommandId', p_run.media_command_id,
    'mediaCapturedAt', p_run.media_captured_at,
    'objectPath', p_run.object_path,
    'failureCode', p_run.failure_code,
    'proofReceipt', p_run.proof_receipt,
    'serverTime', clock_timestamp()
  ))
$$;

revoke all on function private.storyops_verifier_run_response(
  public.trusted_pilot_verification_runs, boolean, boolean
) from public, anon, authenticated, service_role;

create or replace function public.reserve_storyops_trusted_pilot_verification(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_kind text,
  p_provider text,
  p_capability text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth, extensions
as $$
declare
  configuration_row public.company_configuration_versions%rowtype;
  baseline_row public.company_operating_baseline_publications%rowtype;
  connection_row public.integration_connections%rowtype;
  run_row public.trusted_pilot_verification_runs%rowtype;
  provider_value text := case
    when p_provider is null then null
    else private.storyops_canonical_provider(p_provider)
  end;
  effective_hash text;
  inserted_id uuid;
  budget_allowed boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'TRUSTED_VERIFICATION_SERVICE_ROLE_REQUIRED';
  end if;
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner']
  );
  if not public.lock_storyops_active_company(p_company_id) then
    raise exception 'TRUSTED_VERIFICATION_ACTIVE_COMPANY_REQUIRED';
  end if;
  if p_command_id is null
    or p_kind not in ('provider_canary', 'backup_restore')
    or p_capability !~ '^[a-z][a-z0-9_]{2,79}$'
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or (
      p_kind = 'provider_canary'
      and provider_value is null
    )
    or (
      p_kind = 'backup_restore'
      and (
        provider_value is not null
        or p_capability <> 'isolated_database_restore'
      )
    )
  then
    raise exception 'TRUSTED_VERIFICATION_INVALID_REQUEST';
  end if;
  effective_hash := p_request_hash;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-trusted-verification:' || p_company_id::text
      || ':' || p_command_id::text,
    0
  ));
  select *
  into run_row
  from public.trusted_pilot_verification_runs run
  where run.company_id = p_company_id
    and run.command_id = p_command_id
  for update;
  if run_row.id is not null then
    if run_row.request_hash <> effective_hash then
      raise exception 'TRUSTED_VERIFICATION_IDEMPOTENCY_CONFLICT';
    end if;
    return private.storyops_verifier_run_response(run_row, false, true);
  end if;

  select *
  into configuration_row
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.status = 'published'
    and configuration.publication_mode = 'live';
  select *
  into baseline_row
  from public.company_operating_baseline_publications baseline
  where baseline.company_id = p_company_id
    and baseline.status = 'active';
  if configuration_row.id is null
    or baseline_row.id is null
    or baseline_row.configuration_revision <> configuration_row.revision
    or baseline_row.configuration_hash <> configuration_row.configuration_hash
  then
    raise exception 'TRUSTED_VERIFICATION_CURRENT_BASELINE_REQUIRED';
  end if;

  if p_kind = 'provider_canary' then
    select *
    into connection_row
    from public.integration_connections connection
    where connection.company_id = p_company_id
      and connection.provider = provider_value;
    if connection_row.id is null
      or not connection_row.owner_enabled
      or connection_row.mode <> 'live'
      or connection_row.environment_mode <> 'live'
      or connection_row.environment_status <> 'healthy'
      or connection_row.environment_probe_run_id is null
      or connection_row.environment_expires_at <= clock_timestamp()
      or not p_capability = any(connection_row.capabilities)
    then
      raise exception 'TRUSTED_VERIFICATION_ACTIVE_PROVIDER_REQUIRED';
    end if;
  end if;

  insert into public.trusted_pilot_verification_runs(
    company_id, command_id, request_hash, kind, provider, capability,
    status, requested_by_user_id, integration_connection_id,
    integration_version, configuration_revision, configuration_hash,
    baseline_id, baseline_hash
  )
  values (
    p_company_id, p_command_id, effective_hash, p_kind, provider_value,
    p_capability, 'reserved', p_actor_user_id, connection_row.id,
    connection_row.version, configuration_row.revision,
    configuration_row.configuration_hash, baseline_row.id,
    baseline_row.baseline_hash
  )
  returning id into inserted_id;

  select budget.allowed
  into budget_allowed
  from public.consume_operation_budget(
    p_company_id,
    'trusted-pilot-verification',
    encode(extensions.digest(
      p_actor_user_id::text || chr(31) || p_kind || chr(31)
        || coalesce(provider_value, '') || chr(31) || p_capability,
      'sha256'
    ), 'hex'),
    12,
    3600,
    1
  ) budget;

  update public.trusted_pilot_verification_runs
  set status = case when budget_allowed then 'executing' else 'failed' end,
    started_at = case when budget_allowed then clock_timestamp() else null end,
    completed_at = case when budget_allowed then null else clock_timestamp() end,
    failure_code = case when budget_allowed then null else 'RATE_LIMITED' end,
    updated_at = clock_timestamp()
  where id = inserted_id
  returning * into run_row;

  return private.storyops_verifier_run_response(
    run_row, budget_allowed, false
  );
end;
$$;

revoke all on function public.reserve_storyops_trusted_pilot_verification(
  uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.reserve_storyops_trusted_pilot_verification(
  uuid, uuid, uuid, text, text, text, text
) to service_role;

create or replace function public.reserve_storyops_field_media_verification(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_field_worker_user_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth, extensions
as $$
declare
  configuration_row public.company_configuration_versions%rowtype;
  baseline_row public.company_operating_baseline_publications%rowtype;
  connection_row public.integration_connections%rowtype;
  run_row public.trusted_pilot_verification_runs%rowtype;
  price_book_id_value uuid;
  price_book_version_value text;
  checklist_template_id_value uuid;
  run_id_value uuid := gen_random_uuid();
  customer_id_value uuid := gen_random_uuid();
  property_id_value uuid := gen_random_uuid();
  estimate_id_value uuid := gen_random_uuid();
  quote_id_value uuid := gen_random_uuid();
  crew_id_value uuid := gen_random_uuid();
  job_id_value uuid := gen_random_uuid();
  visit_id_value uuid := gen_random_uuid();
  asset_id_value uuid := gen_random_uuid();
  media_command_id_value uuid := gen_random_uuid();
  measurement_id_value uuid := gen_random_uuid();
  effective_hash text;
  object_path_value text;
  travel_zone_evidence_value jsonb;
  service_code_value text;
  scope_evidence_policy_value text;
  budget_allowed boolean;
  fixture_available boolean;
  field_worker_role_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'TRUSTED_VERIFICATION_SERVICE_ROLE_REQUIRED';
  end if;
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner']
  );
  if not public.lock_storyops_active_company(p_company_id) then
    raise exception 'TRUSTED_VERIFICATION_ACTIVE_COMPANY_REQUIRED';
  end if;
  if p_command_id is null
    or p_field_worker_user_id is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'TRUSTED_VERIFICATION_INVALID_REQUEST';
  end if;
  select case
    when membership.role = 'technician' then 'technician'
    when membership.role = 'owner'
      and membership.user_id = p_actor_user_id
      then 'owner_field_worker'
    else null
  end
  into field_worker_role_value
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = p_field_worker_user_id
    and membership.active;
  if field_worker_role_value is null then
    raise exception 'TRUSTED_VERIFICATION_FIELD_WORKER_REQUIRED';
  end if;
  effective_hash := p_request_hash;
  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-trusted-verification:' || p_company_id::text
      || ':' || p_command_id::text,
    0
  ));
  select * into run_row
  from public.trusted_pilot_verification_runs run
  where run.company_id = p_company_id
    and run.command_id = p_command_id
  for update;
  if run_row.id is not null then
    if run_row.request_hash <> effective_hash then
      raise exception 'TRUSTED_VERIFICATION_IDEMPOTENCY_CONFLICT';
    end if;
    return private.storyops_verifier_run_response(run_row, false, true);
  end if;

  select * into configuration_row
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.status = 'published'
    and configuration.publication_mode = 'live';
  select * into baseline_row
  from public.company_operating_baseline_publications baseline
  where baseline.company_id = p_company_id
    and baseline.status = 'active';
  select * into connection_row
  from public.integration_connections connection
  where connection.company_id = p_company_id
    and connection.provider = 'signed_storage_targets';
  select price_book.id, price_book.version_label
  into price_book_id_value, price_book_version_value
  from public.price_books price_book
  where price_book.company_id = p_company_id
    and price_book.status = 'active'
  limit 1;
  select template.id into checklist_template_id_value
  from public.checklist_templates template
  where template.company_id = p_company_id
    and template.active
  order by template.created_at, template.id
  limit 1;
  select catalog.code, catalog.scope_evidence_policy
  into service_code_value, scope_evidence_policy_value
  from public.service_catalog catalog
  where catalog.company_id = p_company_id
    and catalog.active
  order by catalog.code
  limit 1;
  if configuration_row.id is null
    or baseline_row.id is null
    or baseline_row.configuration_revision <> configuration_row.revision
    or baseline_row.configuration_hash <> configuration_row.configuration_hash
  then
    raise exception 'TRUSTED_VERIFICATION_CURRENT_BASELINE_REQUIRED';
  end if;
  if connection_row.id is null
    or not connection_row.owner_enabled
    or connection_row.mode <> 'live'
    or connection_row.environment_mode <> 'live'
    or connection_row.environment_status <> 'healthy'
    or connection_row.environment_expires_at <= clock_timestamp()
    or not 'server_signed_targets' = any(connection_row.capabilities)
  then
    raise exception 'TRUSTED_VERIFICATION_ACTIVE_PROVIDER_REQUIRED';
  end if;
  fixture_available := price_book_id_value is not null
    and checklist_template_id_value is not null
    and service_code_value is not null
    and scope_evidence_policy_value is not null;

  insert into public.trusted_pilot_verification_runs(
    id, company_id, command_id, request_hash, kind, provider, capability,
    status, requested_by_user_id, assigned_user_id, field_worker_role,
    integration_connection_id, integration_version,
    configuration_revision, configuration_hash, baseline_id, baseline_hash
  )
  values (
    run_id_value, p_company_id, p_command_id, effective_hash,
    'field_media_canary', 'signed_storage_targets',
    'private_media_roundtrip', 'reserved', p_actor_user_id,
    p_field_worker_user_id, field_worker_role_value,
    connection_row.id, connection_row.version,
    configuration_row.revision, configuration_row.configuration_hash,
    baseline_row.id, baseline_row.baseline_hash
  );

  select budget.allowed into budget_allowed
  from public.consume_operation_budget(
    p_company_id,
    'trusted-pilot-field-media',
    encode(extensions.digest(
      p_actor_user_id::text || chr(31) || p_field_worker_user_id::text
        || chr(31) || field_worker_role_value || chr(31) || 'field-media',
      'sha256'
    ), 'hex'),
    4,
    3600,
    1
  ) budget;
  if not budget_allowed or not fixture_available then
    update public.trusted_pilot_verification_runs
    set status = 'failed',
      failure_code = case
        when not budget_allowed then 'RATE_LIMITED'
        else 'FIELD_CANARY_FIXTURE_UNAVAILABLE'
      end,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where id = run_id_value
    returning * into run_row;
    return private.storyops_verifier_run_response(run_row, false, false);
  end if;

  travel_zone_evidence_value := public.resolve_reviewed_travel_zone(
    p_company_id,
    price_book_id_value,
    '75001'
  );
  object_path_value := p_company_id::text || '/visits/'
    || visit_id_value::text || '/' || asset_id_value::text
    || '-431ced6916a2a21a-field-worker-canary.png';

  insert into public.customers(
    id, company_id, kind, display_name, lifecycle, tags,
    acquisition_source, do_not_contact, notes
  )
  values (
    customer_id_value, p_company_id, 'business',
    'StoryOps controlled rehearsal', 'inactive',
    array['storyops-controlled-rehearsal'],
    'system_controlled_rehearsal', true,
    'Non-customer, non-outbound field-media authorization canary fixture.'
  );
  insert into public.properties(
    id, company_id, customer_id, name, property_type, service_address,
    access_instructions, known_hazards
  )
  values (
    property_id_value, p_company_id, customer_id_value,
    'StoryOps controlled rehearsal property', 'other',
    jsonb_build_object(
      'line1', 'Internal controlled rehearsal only',
      'city', 'Internal',
      'region', 'TX',
      'postalCode', '75001'
    ),
    'No customer site or outbound work.', '{}'
  );
  insert into public.estimates(
    id, company_id, estimate_number, customer_id, property_id,
    price_book_id, price_book_version, status, service_subtotal,
    minimum_adjustment, travel_fee, manual_adjustment, discount,
    taxable_subtotal, tax, total, deposit_required, estimated_cost,
    estimated_margin_pct, duration_minutes, calculation_version,
    calculation_input, calculation_issues, calculated_at
  )
  values (
    estimate_id_value, p_company_id,
    'CANARY-' || left(run_id_value::text, 18),
    customer_id_value, property_id_value, price_book_id_value,
    price_book_version_value, 'draft', 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 15, 'storyops-controlled-rehearsal-v1',
    jsonb_build_object(
      'controlledRehearsal', true,
      'travelZoneCode', travel_zone_evidence_value ->> 'code',
      'travelZoneEvidence', travel_zone_evidence_value,
      'services', jsonb_build_array(jsonb_build_object(
        'serviceCode', service_code_value,
        'measurementId', measurement_id_value
      )),
      'scopeEvidencePolicies', jsonb_build_array(jsonb_build_object(
        'serviceCode', service_code_value,
        'policy', scope_evidence_policy_value
      )),
      'scopeEvidenceDisposition', case
        when scope_evidence_policy_value = 'photo_required'
          then 'human_review_required'
        else 'not_applicable'
      end
    ),
    '[]',
    clock_timestamp()
  );
  insert into public.quotes(
    id, company_id, quote_number, estimate_id, customer_id, property_id,
    status, valid_until, terms_version, terms_snapshot, total,
    deposit_required
  )
  values (
    quote_id_value, p_company_id,
    'CANARY-' || left(run_id_value::text, 18),
    estimate_id_value, customer_id_value, property_id_value, 'draft',
    current_date + 1, 'controlled-rehearsal-v1',
    'Internal controlled rehearsal. Not a customer quote.', 0, 0
  );
  insert into public.crews(
    id, company_id, name, active, lead_technician_id,
    skill_codes, home_base_postal_code
  )
  values (
    crew_id_value, p_company_id,
    'StoryOps controlled rehearsal ' || left(run_id_value::text, 8),
    false, p_field_worker_user_id, '{}', '00000'
  );
  insert into public.crew_members(
    company_id, crew_id, user_id, starts_on
  )
  values (
    p_company_id, crew_id_value, p_field_worker_user_id, current_date
  );
  insert into public.jobs(
    id, company_id, job_number, quote_id, customer_id, property_id,
    status, priority, service_codes, estimated_duration_minutes,
    estimated_revenue, estimated_cost, assigned_crew_id
  )
  values (
    job_id_value, p_company_id,
    'CANARY-' || left(run_id_value::text, 18),
    quote_id_value, customer_id_value, property_id_value, 'in_progress',
    'routine', '{}', 15, 0, 0, crew_id_value
  );
  insert into public.visits(
    id, company_id, job_id, sequence, status, starts_at, ends_at,
    crew_id, checklist_template_id, internal_notes
  )
  values (
    visit_id_value, p_company_id, job_id_value, 1, 'on_site',
    clock_timestamp() - interval '1 minute',
    clock_timestamp() + interval '14 minutes',
    crew_id_value, checklist_template_id_value,
    'Controlled rehearsal only; no customer work or outbound action.'
  );
  update public.trusted_pilot_verification_runs
  set status = 'awaiting_field_worker', visit_id = visit_id_value,
    job_id = job_id_value, property_id = property_id_value,
    media_asset_id = asset_id_value,
    media_command_id = media_command_id_value,
    object_path = object_path_value,
    updated_at = clock_timestamp()
  where id = run_id_value
  returning * into run_row;
  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id, retention_class, retain_until
  )
  values (
    p_company_id, 'user', p_actor_user_id::text,
    'pilot.field_media_canary_session_created',
    'trusted_pilot_verification_run', run_id_value,
    jsonb_build_object(
      'initiatorRole', 'owner',
      'completionRole', field_worker_role_value,
      'assignedUserId', p_field_worker_user_id,
      'controlledRehearsal', true,
      'customerVisible', false,
      'jobId', job_id_value,
      'visitId', visit_id_value
    ),
    p_command_id::text, 'audit', clock_timestamp() + interval '7 years'
  );
  return private.storyops_verifier_run_response(run_row, false, false);
end;
$$;

revoke all on function public.reserve_storyops_field_media_verification(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.reserve_storyops_field_media_verification(
  uuid, uuid, uuid, uuid, text
) to service_role;

create or replace function public.claim_storyops_field_media_verification(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_verification_run_id uuid,
  p_command_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  run_row public.trusted_pilot_verification_runs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'TRUSTED_VERIFICATION_SERVICE_ROLE_REQUIRED';
  end if;
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'technician']
  );
  if p_verification_run_id is null
    or p_command_id is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'TRUSTED_VERIFICATION_INVALID_REQUEST';
  end if;
  if not public.lock_storyops_active_company(p_company_id) then
    raise exception 'TRUSTED_VERIFICATION_ACTIVE_COMPANY_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-trusted-verification-run:' || p_verification_run_id::text,
    0
  ));
  select * into run_row
  from public.trusted_pilot_verification_runs run
  where run.id = p_verification_run_id
    and run.company_id = p_company_id
  for update;
  if run_row.id is null
    or run_row.kind <> 'field_media_canary'
    or run_row.assigned_user_id <> p_actor_user_id
    or not exists (
      select 1
      from public.company_memberships membership
      where membership.company_id = run_row.company_id
        and membership.user_id = p_actor_user_id
        and membership.active
        and (
          (
            run_row.field_worker_role = 'technician'
            and membership.role = 'technician'
          )
          or (
            run_row.field_worker_role = 'owner_field_worker'
            and membership.role = 'owner'
            and run_row.requested_by_user_id = p_actor_user_id
          )
        )
    )
  then
    raise exception 'TRUSTED_VERIFICATION_ASSIGNED_FIELD_WORKER_REQUIRED';
  end if;
  if run_row.execution_command_id is not null
    and (
      run_row.execution_command_id <> p_command_id
      or run_row.execution_request_hash <> p_request_hash
    )
  then
    raise exception 'TRUSTED_VERIFICATION_EXECUTION_IDEMPOTENCY_CONFLICT';
  end if;
  if run_row.status = 'awaiting_field_worker' then
    update public.trusted_pilot_verification_runs
    set status = 'executing',
      execution_command_id = p_command_id,
      execution_request_hash = p_request_hash,
      media_captured_at = clock_timestamp(),
      started_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where id = run_row.id
    returning * into run_row;
    return private.storyops_verifier_run_response(run_row, true, false);
  end if;
  if run_row.execution_command_id is null then
    raise exception 'TRUSTED_VERIFICATION_EXECUTION_NOT_CLAIMED';
  end if;
  return private.storyops_verifier_run_response(run_row, false, true);
end;
$$;

revoke all on function public.claim_storyops_field_media_verification(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.claim_storyops_field_media_verification(
  uuid, uuid, uuid, uuid, text
) to service_role;

create or replace function public.fail_storyops_trusted_pilot_verification(
  p_run_id uuid,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  run_row public.trusted_pilot_verification_runs%rowtype;
  negative_evidence boolean;
  observed_value timestamptz;
  artifact_value text;
  binding_value jsonb;
  source_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'TRUSTED_VERIFICATION_SERVICE_ROLE_REQUIRED';
  end if;
  if p_failure_code !~ '^[A-Z][A-Z0-9_]{2,79}$' then
    raise exception 'TRUSTED_VERIFICATION_FAILURE_CODE_INVALID';
  end if;
  select * into run_row
  from public.trusted_pilot_verification_runs run
  where run.id = p_run_id
  for update;
  if run_row.id is null then
    raise exception 'TRUSTED_VERIFICATION_RUN_NOT_FOUND';
  end if;
  if run_row.status in ('failed', 'consumed') then
    return private.storyops_verifier_run_response(run_row, false, true);
  end if;
  if run_row.status not in ('executing', 'unknown') then
    raise exception 'TRUSTED_VERIFICATION_RUN_NOT_FAILABLE';
  end if;
  negative_evidence := (
    run_row.kind = 'provider_canary'
    and p_failure_code = 'EXTERNAL_READ_CANARY_FAILED'
  ) or (
    run_row.kind = 'field_media_canary'
    and p_failure_code = 'FIELD_MEDIA_ROUNDTRIP_FAILED'
  );
  observed_value := clock_timestamp();
  artifact_value := encode(extensions.digest(array_to_string(array[
    'storyops-trusted-verification-negative-v1',
    run_row.id::text,
    p_failure_code
  ], chr(31)), 'sha256'), 'hex');
  update public.trusted_pilot_verification_runs
  set status = 'failed', failure_code = p_failure_code,
    evidence_basis = case
      when negative_evidence and run_row.kind = 'provider_canary'
        and run_row.provider = 'quickbooks_export'
        then 'deterministic_local'
      when negative_evidence and run_row.kind = 'provider_canary'
        then 'external_read'
      when negative_evidence then 'authenticated_field_media'
      else evidence_basis
    end,
    evidence_reference = case
      when negative_evidence then 'verify-' || id::text
      else evidence_reference
    end,
    artifact_sha256 = case
      when negative_evidence then artifact_value
      else artifact_sha256
    end,
    observed_at = case
      when negative_evidence then observed_value
      else observed_at
    end,
    expires_at = case
      when negative_evidence then observed_value + case
        when run_row.kind = 'provider_canary' then interval '7 days'
        else interval '30 days'
      end
      else expires_at
    end,
    completed_at = observed_value, updated_at = observed_value
  where id = p_run_id
  returning * into run_row;
  if negative_evidence then
    binding_value := jsonb_strip_nulls(jsonb_build_object(
      'configurationRevision', run_row.configuration_revision,
      'configurationHash', run_row.configuration_hash,
      'baselineId', run_row.baseline_id,
      'baselineHash', run_row.baseline_hash,
      'capability', run_row.capability,
      'integrationProvider', run_row.provider,
      'integrationVersion', run_row.integration_version,
      'verificationRunId', run_row.id,
      'visitId', run_row.visit_id,
      'mediaAssetId', run_row.media_asset_id,
      'fieldWorkerRole', run_row.field_worker_role
    ));
    source_value := case
      when run_row.kind = 'field_media_canary'
        then 'authenticated_field_media_roundtrip'
      when run_row.provider = 'quickbooks_export'
        then 'deterministic_local_canary'
      else 'external_provider_read_canary'
    end;
    insert into public.audit_events(
      id, company_id, occurred_at, actor_type, actor_id, action,
      entity_type, entity_id, after_data, request_id,
      retention_class, retain_until
    )
    values (
      gen_random_uuid(), run_row.company_id, observed_value, 'system',
      'trusted-verification-run', 'pilot.evidence_recorded',
      'pilot_release_evidence', gen_random_uuid(),
      jsonb_strip_nulls(jsonb_build_object(
        'kind', run_row.kind,
        'provider', run_row.provider,
        'outcome', 'failed',
        'source', source_value,
        'evidenceReference', run_row.evidence_reference,
        'artifactSha256', run_row.artifact_sha256,
        'observedAt', run_row.observed_at,
        'expiresAt', run_row.expires_at,
        'reviewedByUserId', run_row.requested_by_user_id,
        'verificationBasis', 'trusted_system_proof',
        'verificationRunId', run_row.id,
        'binding', binding_value,
        'reviewNote', 'trusted-verifier-run'
      )),
      run_row.command_id::text, 'audit', observed_value + interval '7 years'
    );
    update public.integration_connections connection
    set status = 'degraded',
      last_error = 'trusted-canary-failed',
      last_checked_at = observed_value,
      updated_at = observed_value,
      version = connection.version + 1
    where connection.id = run_row.integration_connection_id
      and connection.company_id = run_row.company_id;
    perform private.storyops_append_system_launch_revoke(
      run_row.company_id,
      'trusted-canary-failed-' || coalesce(run_row.provider, run_row.kind)
    );
  end if;
  return private.storyops_verifier_run_response(run_row, false, false);
end;
$$;

revoke all on function public.fail_storyops_trusted_pilot_verification(
  uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.fail_storyops_trusted_pilot_verification(
  uuid, text
) to service_role;

create or replace function public.complete_storyops_provider_canary_verification(
  p_run_id uuid,
  p_probe_evidence jsonb,
  p_deployment_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth, extensions
as $$
declare
  run_row public.trusted_pilot_verification_runs%rowtype;
  expected_operation text;
  expected_basis text := 'external_read';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'TRUSTED_VERIFICATION_SERVICE_ROLE_REQUIRED';
  end if;
  if p_deployment_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'TRUSTED_VERIFICATION_DEPLOYMENT_FINGERPRINT_INVALID';
  end if;
  select *
  into run_row
  from public.trusted_pilot_verification_runs run
  where run.id = p_run_id
  for update;
  if run_row.id is null then
    raise exception 'TRUSTED_VERIFICATION_RUN_NOT_FOUND';
  end if;
  if run_row.status in ('verified', 'consumed') then
    return private.storyops_verifier_run_response(run_row, false, true);
  end if;
  if run_row.kind <> 'provider_canary' or run_row.status <> 'executing' then
    raise exception 'TRUSTED_VERIFICATION_PROVIDER_RUN_REQUIRED';
  end if;
  if not public.lock_storyops_active_company(run_row.company_id) then
    raise exception 'TRUSTED_VERIFICATION_ACTIVE_COMPANY_REQUIRED';
  end if;
  expected_operation := case
    when run_row.provider = 'openai'
      and run_row.capability in ('structured_ai', 'photo_analysis')
      then 'openai.model.retrieve'
    when run_row.provider = 'twilio' and run_row.capability = 'sms_voice'
      then 'twilio.account.retrieve'
    when run_row.provider = 'email' and run_row.capability = 'email'
      then 'email.health.retrieve'
    when run_row.provider = 'stripe' and run_row.capability = 'payments'
      then 'stripe.balance.retrieve'
    when run_row.provider = 'google_calendar' and run_row.capability = 'calendar'
      then 'google_calendar.list.retrieve'
    when run_row.provider = 'maps' and run_row.capability = 'geocoding'
      then 'google_maps.geocode.retrieve'
    when run_row.provider = 'nws' and run_row.capability = 'weather'
      then 'nws.points.retrieve'
    when run_row.provider = 'vroom' and run_row.capability = 'routing'
      then 'vroom.health.retrieve'
    when run_row.provider = 'signed_storage_targets'
      and run_row.capability = 'server_signed_targets'
      then 'supabase_storage.bucket.retrieve'
    when run_row.provider = 'quickbooks_export'
      and run_row.capability = 'accounting_export'
      then 'quickbooks_export.adapter.validate'
    else null
  end;
  if run_row.provider = 'quickbooks_export' then
    expected_basis := 'deterministic_local';
  end if;
  if expected_operation is null
    or jsonb_typeof(p_probe_evidence) <> 'object'
    or not p_probe_evidence ?& array[
      'schemaVersion', 'basis', 'operation', 'responseDigest'
    ]
    or exists (
      select 1
      from jsonb_object_keys(p_probe_evidence) keys(key_name)
      where key_name <> all(array[
        'schemaVersion', 'basis', 'operation', 'responseDigest'
      ])
    )
    or p_probe_evidence ->> 'schemaVersion'
      <> 'storyops-integration-probe-evidence-v1'
    or p_probe_evidence ->> 'basis' <> expected_basis
    or p_probe_evidence ->> 'operation' <> expected_operation
    or p_probe_evidence ->> 'responseDigest' !~ '^[a-f0-9]{64}$'
  then
    raise exception 'TRUSTED_VERIFICATION_PROBE_EVIDENCE_INVALID';
  end if;
  if not exists (
    select 1
    from public.integration_connections connection
    where connection.id = run_row.integration_connection_id
      and connection.company_id = run_row.company_id
      and connection.version = run_row.integration_version
      and connection.owner_enabled
      and connection.mode = 'live'
      and connection.environment_mode = 'live'
      and connection.environment_status = 'healthy'
      and connection.environment_fingerprint = p_deployment_fingerprint
      and connection.environment_expires_at > clock_timestamp()
      and run_row.capability = any(connection.capabilities)
  ) then
    raise exception 'TRUSTED_VERIFICATION_PROVIDER_BINDING_CHANGED';
  end if;

  update public.trusted_pilot_verification_runs
  set status = 'verified',
    evidence_basis = expected_basis,
    external_operation = expected_operation,
    evidence_reference = 'verify-' || id::text,
    artifact_sha256 = encode(
      extensions.digest(p_probe_evidence::text, 'sha256'), 'hex'
    ),
    observed_at = clock_timestamp(),
    expires_at = clock_timestamp() + interval '7 days',
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = p_run_id
  returning * into run_row;
  return private.storyops_verifier_run_response(run_row, false, false);
end;
$$;

revoke all on function public.complete_storyops_provider_canary_verification(
  uuid, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.complete_storyops_provider_canary_verification(
  uuid, jsonb, text
) to service_role;

create or replace function public.complete_storyops_field_media_verification(
  p_run_id uuid,
  p_deployment_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth, storage, extensions
as $$
declare
  run_row public.trusted_pilot_verification_runs%rowtype;
  asset_row public.media_assets%rowtype;
  attestation_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'TRUSTED_VERIFICATION_SERVICE_ROLE_REQUIRED';
  end if;
  if p_deployment_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'TRUSTED_VERIFICATION_DEPLOYMENT_FINGERPRINT_INVALID';
  end if;
  select * into run_row
  from public.trusted_pilot_verification_runs run
  where run.id = p_run_id
  for update;
  if run_row.id is null then
    raise exception 'TRUSTED_VERIFICATION_RUN_NOT_FOUND';
  end if;
  if run_row.status in ('verified', 'consumed') then
    return private.storyops_verifier_run_response(run_row, false, true);
  end if;
  if run_row.kind <> 'field_media_canary'
    or run_row.status <> 'executing'
    or run_row.execution_command_id is null
    or run_row.assigned_user_id is null
    or run_row.field_worker_role is null
  then
    raise exception 'TRUSTED_VERIFICATION_FIELD_MEDIA_RUN_REQUIRED';
  end if;
  if not public.lock_storyops_active_company(run_row.company_id) then
    raise exception 'TRUSTED_VERIFICATION_ACTIVE_COMPANY_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.integration_connections connection
    where connection.id = run_row.integration_connection_id
      and connection.company_id = run_row.company_id
      and connection.version = run_row.integration_version
      and connection.owner_enabled
      and connection.mode = 'live'
      and connection.status = 'healthy'
      and connection.environment_mode = 'live'
      and connection.environment_status = 'healthy'
      and connection.environment_fingerprint = p_deployment_fingerprint
      and connection.environment_expires_at > clock_timestamp()
      and 'server_signed_targets' = any(connection.capabilities)
  ) then
    raise exception 'TRUSTED_VERIFICATION_PROVIDER_BINDING_CHANGED';
  end if;
  select * into asset_row
  from public.media_assets asset
  where asset.id = run_row.media_asset_id
    and asset.company_id = run_row.company_id
    and asset.property_id = run_row.property_id
    and asset.job_id = run_row.job_id
    and asset.visit_id = run_row.visit_id
    and asset.purpose = 'before'
    and asset.object_path = run_row.object_path
    and asset.content_type = 'image/png'
    and asset.byte_size = 68
    and asset.checksum_sha256 =
      '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460'
    and asset.captured_at = run_row.media_captured_at
    and asset.captured_by = run_row.assigned_user_id
    and not asset.customer_visible
    and asset.offline_client_id = run_row.media_command_id::text
    and asset.sync_state = 'synced';
  select attestation.id into attestation_id
  from public.media_upload_attestations attestation
  where attestation.company_id = run_row.company_id
    and attestation.command_id = run_row.media_command_id
    and attestation.actor_user_id = run_row.assigned_user_id
    and attestation.asset_id = run_row.media_asset_id
    and attestation.object_path = run_row.object_path
    and attestation.checksum_sha256 =
      '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460'
    and attestation.byte_size = 68
    and attestation.content_type = 'image/png'
    and attestation.consumed_at is not null;
  if asset_row.id is null
    or attestation_id is null
    or not exists (
      select 1
      from storage.objects object
      where object.bucket_id = 'job-media'
        and object.name = run_row.object_path
        and object.owner_id = run_row.assigned_user_id::text
        and (object.metadata ->> 'size')::bigint = 68
        and coalesce(
          object.metadata ->> 'mimetype',
          object.metadata ->> 'contentType'
        ) = 'image/png'
    )
  then
    raise exception 'TRUSTED_VERIFICATION_FIELD_MEDIA_EVIDENCE_INVALID';
  end if;

  update public.trusted_pilot_verification_runs
  set status = 'verified',
    evidence_basis = 'authenticated_field_media',
    external_operation = 'field_media.field_worker_roundtrip',
    evidence_reference = 'verify-' || id::text,
    artifact_sha256 = encode(extensions.digest(array_to_string(array[
      'storyops-field-media-verification-v1',
      asset_row.id::text,
      asset_row.object_path,
      asset_row.checksum_sha256,
      attestation_id::text,
      run_row.assigned_user_id::text,
      run_row.field_worker_role
    ], chr(31)), 'sha256'), 'hex'),
    observed_at = clock_timestamp(),
    expires_at = clock_timestamp() + interval '30 days',
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = run_row.id
  returning * into run_row;
  return private.storyops_verifier_run_response(run_row, false, false);
end;
$$;

revoke all on function public.complete_storyops_field_media_verification(
  uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.complete_storyops_field_media_verification(
  uuid, text
) to service_role;

create or replace function public.complete_storyops_restore_verification(
  p_run_id uuid,
  p_signed_request_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  run_row public.trusted_pilot_verification_runs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'TRUSTED_VERIFICATION_SERVICE_ROLE_REQUIRED';
  end if;
  if p_signed_request_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'TRUSTED_VERIFICATION_RESTORE_DIGEST_INVALID';
  end if;
  select *
  into run_row
  from public.trusted_pilot_verification_runs run
  where run.id = p_run_id
  for update;
  if run_row.id is null then
    raise exception 'TRUSTED_VERIFICATION_RUN_NOT_FOUND';
  end if;
  if run_row.status in ('verified', 'consumed') then
    return private.storyops_verifier_run_response(run_row, false, true);
  end if;
  if run_row.kind <> 'backup_restore' or run_row.status <> 'executing' then
    raise exception 'TRUSTED_VERIFICATION_RESTORE_RUN_REQUIRED';
  end if;
  if not public.lock_storyops_active_company(run_row.company_id) then
    raise exception 'TRUSTED_VERIFICATION_ACTIVE_COMPANY_REQUIRED';
  end if;
  update public.trusted_pilot_verification_runs
  set status = 'verified',
    evidence_basis = 'signed_isolated_restore',
    external_operation = 'backup_restore.verify',
    evidence_reference = 'verify-' || id::text,
    artifact_sha256 = p_signed_request_sha256,
    observed_at = clock_timestamp(),
    expires_at = clock_timestamp() + interval '30 days',
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = p_run_id
  returning * into run_row;
  return private.storyops_verifier_run_response(run_row, false, false);
end;
$$;

revoke all on function public.complete_storyops_restore_verification(
  uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.complete_storyops_restore_verification(
  uuid, text
) to service_role;

drop function public.record_storyops_trusted_pilot_proof(
  uuid, uuid, uuid, text, text, text, text, text, text, text,
  timestamptz, timestamptz
);

create or replace function public.record_storyops_trusted_pilot_proof(
  p_verification_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  run_row public.trusted_pilot_verification_runs%rowtype;
  connection_row public.integration_connections%rowtype;
  evidence_id uuid := gen_random_uuid();
  binding_value jsonb;
  response_value jsonb;
  source_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'TRUSTED_PILOT_PROOF_SERVICE_ROLE_REQUIRED';
  end if;
  select *
  into run_row
  from public.trusted_pilot_verification_runs run
  where run.id = p_verification_run_id
  for update;
  if run_row.id is null then
    raise exception 'TRUSTED_PILOT_PROOF_VERIFICATION_RUN_NOT_FOUND';
  end if;
  if run_row.status = 'consumed' then
    return run_row.proof_receipt || jsonb_build_object('replayed', true);
  end if;
  if run_row.status <> 'verified'
    or run_row.observed_at is null
    or run_row.expires_at <= clock_timestamp()
  then
    raise exception 'TRUSTED_PILOT_PROOF_VERIFIED_RUN_REQUIRED';
  end if;
  if not public.lock_storyops_active_company(run_row.company_id) then
    raise exception 'TRUSTED_PILOT_PROOF_ACTIVE_COMPANY_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.company_configuration_versions configuration
    join public.company_operating_baseline_publications baseline
      on baseline.company_id = configuration.company_id
     and baseline.status = 'active'
     and baseline.id = run_row.baseline_id
     and baseline.baseline_hash = run_row.baseline_hash
     and baseline.configuration_revision = configuration.revision
     and baseline.configuration_hash = configuration.configuration_hash
    where configuration.company_id = run_row.company_id
      and configuration.status = 'published'
      and configuration.publication_mode = 'live'
      and configuration.revision = run_row.configuration_revision
      and configuration.configuration_hash = run_row.configuration_hash
  ) then
    raise exception 'TRUSTED_PILOT_PROOF_BINDING_CHANGED';
  end if;
  if run_row.provider is not null then
    select *
    into connection_row
    from public.integration_connections connection
    where connection.id = run_row.integration_connection_id
      and connection.company_id = run_row.company_id;
    if connection_row.id is null
      or connection_row.version <> run_row.integration_version
      or not connection_row.owner_enabled
      or connection_row.mode <> 'live'
      or connection_row.environment_mode <> 'live'
      or connection_row.environment_status <> 'healthy'
      or connection_row.environment_expires_at <= clock_timestamp()
      or not (
        run_row.capability = any(connection_row.capabilities)
        or (
          run_row.kind = 'field_media_canary'
          and 'server_signed_targets' = any(connection_row.capabilities)
        )
      )
    then
      raise exception 'TRUSTED_PILOT_PROOF_PROVIDER_BINDING_CHANGED';
    end if;
  end if;

  binding_value := jsonb_strip_nulls(jsonb_build_object(
    'configurationRevision', run_row.configuration_revision,
    'configurationHash', run_row.configuration_hash,
    'baselineId', run_row.baseline_id,
    'baselineHash', run_row.baseline_hash,
    'capability', run_row.capability,
    'integrationProvider', run_row.provider,
    'integrationVersion', run_row.integration_version,
    'verificationRunId', run_row.id,
    'visitId', run_row.visit_id,
    'mediaAssetId', run_row.media_asset_id,
    'fieldWorkerRole', run_row.field_worker_role
  ));
  source_value := case
    when run_row.kind = 'provider_canary'
      and run_row.evidence_basis = 'external_read'
      then 'external_provider_read_canary'
    when run_row.kind = 'provider_canary'
      then 'deterministic_local_canary'
    when run_row.kind = 'field_media_canary'
      then 'authenticated_field_media_roundtrip'
    else 'signed_isolated_restore_drill'
  end;

  insert into public.audit_events(
    id, company_id, occurred_at, actor_type, actor_id, action,
    entity_type, entity_id, after_data, request_id,
    retention_class, retain_until
  )
  values (
    gen_random_uuid(), run_row.company_id, clock_timestamp(), 'system',
    'trusted-verification-run', 'pilot.evidence_recorded',
    'pilot_release_evidence', evidence_id,
    jsonb_strip_nulls(jsonb_build_object(
      'kind', run_row.kind,
      'provider', run_row.provider,
      'outcome', 'passed',
      'source', source_value,
      'evidenceReference', run_row.evidence_reference,
      'artifactSha256', run_row.artifact_sha256,
      'observedAt', run_row.observed_at,
      'expiresAt', run_row.expires_at,
      'reviewedByUserId', run_row.requested_by_user_id,
      'verificationBasis', 'trusted_system_proof',
      'verificationRunId', run_row.id,
      'externalOperation', run_row.external_operation,
      'binding', binding_value,
      'reviewNote', 'trusted-verifier-run'
    )),
    run_row.command_id::text, 'audit', clock_timestamp() + interval '7 years'
  );
  perform private.storyops_append_system_launch_revoke(
    run_row.company_id,
    'trusted-pilot-proof-changed'
  );
  response_value := jsonb_build_object(
    'schemaVersion', 'storyops-trusted-pilot-proof-receipt-v2',
    'companyId', run_row.company_id,
    'commandId', run_row.command_id,
    'verificationRunId', run_row.id,
    'evidenceId', evidence_id,
    'binding', binding_value,
    'replayed', false,
    'serverTime', clock_timestamp()
  );
  update public.trusted_pilot_verification_runs
  set status = 'consumed', proof_receipt = response_value,
    consumed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = run_row.id;
  return response_value;
end;
$$;

revoke all on function public.record_storyops_trusted_pilot_proof(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.record_storyops_trusted_pilot_proof(uuid)
  to service_role;

comment on table public.trusted_pilot_verification_runs is
  'Server-reserved authorization-grade canary runs. Provider/storage work occurs at most once per command and proof facts are derived only after a verified run.';
comment on function public.reserve_storyops_trusted_pilot_verification(
  uuid, uuid, uuid, text, text, text, text
) is
  'Reserves idempotency and durable budget before any provider canary or restore proof verification.';
comment on function public.record_storyops_trusted_pilot_proof(uuid) is
  'Consumes one immutable verified run; callers cannot supply proof outcome, timestamps, reference, or artifact facts.';
