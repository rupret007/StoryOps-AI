-- Authoritative provider activation and controlled-pilot launch boundary.
--
-- Deployment switches and secret presence are proved by a trusted Edge probe.
-- Owners independently activate a provider connection. Neither fact is
-- sufficient by itself, and health never changes owner activation.

alter table public.integration_connections
  add column if not exists owner_enabled boolean not null default false,
  add column if not exists environment_mode text not null default 'disabled'
    check (environment_mode in ('disabled', 'sandbox', 'live')),
  add column if not exists environment_capabilities text[] not null default '{}',
  add column if not exists environment_status text not null default 'not_configured'
    check (environment_status in (
      'healthy', 'not_configured', 'degraded', 'down'
    )),
  add column if not exists environment_fingerprint text
    check (
      environment_fingerprint is null
      or environment_fingerprint ~ '^[a-f0-9]{64}$'
    ),
  add column if not exists environment_probe_run_id uuid,
  add column if not exists environment_checked_at timestamptz,
  add column if not exists environment_expires_at timestamptz,
  add column if not exists activated_by_user_id uuid
    references auth.users(id) on delete restrict,
  add column if not exists activated_at timestamptz,
  add column if not exists disabled_at timestamptz,
  add column if not exists activation_command_id uuid;

alter table public.integration_connections
  add constraint integration_connections_authoritative_activation_check
  check (
    (
      owner_enabled
      and mode in ('sandbox', 'live')
      and activated_by_user_id is not null
      and activated_at is not null
      and disabled_at is null
    )
    or (
      not owner_enabled
      and mode = 'disabled'
      and disabled_at is not null
    )
    or (
      not owner_enabled
      and activated_by_user_id is null
      and activated_at is null
      and activation_command_id is null
    )
  ) not valid;

create table public.integration_environment_probe_results (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  connection_id uuid references public.integration_connections(id) on delete cascade,
  probe_run_id uuid not null,
  provider text not null check (provider in (
    'openai', 'twilio', 'email', 'stripe', 'google_calendar', 'maps',
    'nws', 'vroom', 'signed_storage_targets', 'quickbooks_export',
    'scheduling_evidence_gate'
  )),
  capability text not null check (capability ~ '^[a-z][a-z0-9_]{2,79}$'),
  environment_mode text not null check (environment_mode in ('disabled', 'sandbox', 'live')),
  status text not null check (status in ('healthy', 'not_configured', 'degraded', 'down')),
  result_code text not null check (result_code in (
    'healthy', 'not_configured', 'degraded', 'down'
  )),
  deployment_fingerprint text not null check (deployment_fingerprint ~ '^[a-f0-9]{64}$'),
  required_settings text[] not null default '{}',
  latency_ms integer not null check (latency_ms between 0 and 120000),
  checked_at timestamptz not null,
  expires_at timestamptz not null,
  recorded_by_user_id uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  unique (company_id, probe_run_id, provider, capability),
  check (expires_at > checked_at),
  check (
    (provider = 'scheduling_evidence_gate' and connection_id is null)
    or (provider <> 'scheduling_evidence_gate' and connection_id is not null)
  )
);

create index integration_probe_current_idx
  on public.integration_environment_probe_results(
    company_id, provider, capability, checked_at desc, recorded_at desc
  );

create table public.company_launch_authorization_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  version integer not null check (version > 0),
  action text not null check (action in ('authorize', 'revoke', 'system_revoke')),
  configuration_revision integer not null check (configuration_revision > 0),
  configuration_hash text not null check (configuration_hash ~ '^[a-f0-9]{64}$'),
  baseline_id uuid not null references public.company_operating_baseline_publications(id)
    on delete restrict,
  baseline_hash text not null check (baseline_hash ~ '^[a-f0-9]{64}$'),
  provider_snapshot_hash text not null check (provider_snapshot_hash ~ '^[a-f0-9]{64}$'),
  proof_snapshot_hash text not null check (proof_snapshot_hash ~ '^[a-f0-9]{64}$'),
  provider_bindings jsonb not null check (jsonb_typeof(provider_bindings) = 'array'),
  proof_event_ids jsonb not null check (jsonb_typeof(proof_event_ids) = 'array'),
  review_reference text not null
    check (
      length(btrim(review_reference)) between 10 and 120
      and btrim(review_reference) ~ '^[A-Za-z0-9][A-Za-z0-9._-]{9,119}$'
    ),
  actor_user_id uuid references auth.users(id) on delete restrict,
  command_id uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz not null default now(),
  unique (company_id, version),
  unique (company_id, command_id),
  check (
    (action in ('authorize', 'revoke') and actor_user_id is not null)
    or (action = 'system_revoke')
  )
);

create index company_launch_events_latest_idx
  on public.company_launch_authorization_events(company_id, version desc);

create trigger storyops_active_company_mutation_gate
before insert or update or delete
on public.integration_environment_probe_results
for each row execute function
  public.assert_active_company_for_authenticated_mutation();

create trigger storyops_active_company_mutation_gate
before insert or update or delete
on public.company_launch_authorization_events
for each row execute function
  public.assert_active_company_for_authenticated_mutation();

alter table public.integration_environment_probe_results enable row level security;
alter table public.company_launch_authorization_events enable row level security;

create policy integration_probe_owner_dispatcher_select
on public.integration_environment_probe_results for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
);

create policy company_launch_owner_dispatcher_select
on public.company_launch_authorization_events for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
);

drop policy if exists integration_connections_owner_insert
  on public.integration_connections;
drop policy if exists integration_connections_owner_update
  on public.integration_connections;
drop policy if exists integration_connections_owner_delete
  on public.integration_connections;

revoke insert, update, delete on public.integration_connections
  from authenticated;
revoke all on public.integration_environment_probe_results
  from public, anon, authenticated, service_role;
revoke all on public.company_launch_authorization_events
  from public, anon, authenticated, service_role;
grant select on public.integration_environment_probe_results
  to authenticated;
grant select on public.company_launch_authorization_events
  to authenticated;

create or replace function private.storyops_canonical_provider(
  p_provider text
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_provider = 'storage' then 'signed_storage_targets'
    else p_provider
  end
$$;

create or replace function private.storyops_current_launch_version(
  p_company_id uuid
)
returns integer
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(max(event.version), 0)::integer
  from public.company_launch_authorization_events event
  where event.company_id = p_company_id
$$;

create or replace function private.storyops_append_system_launch_revoke(
  p_company_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  current_event public.company_launch_authorization_events%rowtype;
  next_version integer;
  event_id uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-launch-authorization:' || p_company_id::text,
    0
  ));
  select *
  into current_event
  from public.company_launch_authorization_events event
  where event.company_id = p_company_id
  order by event.version desc
  limit 1
  for update;
  if current_event.id is null or current_event.action <> 'authorize' then
    return;
  end if;
  next_version := current_event.version + 1;
  insert into public.company_launch_authorization_events(
    id, company_id, version, action, configuration_revision,
    configuration_hash, baseline_id, baseline_hash,
    provider_snapshot_hash, proof_snapshot_hash, provider_bindings,
    proof_event_ids, review_reference, actor_user_id, command_id,
    request_hash, occurred_at
  )
  values (
    event_id, p_company_id, next_version, 'system_revoke',
    current_event.configuration_revision, current_event.configuration_hash,
    current_event.baseline_id, current_event.baseline_hash,
    current_event.provider_snapshot_hash, current_event.proof_snapshot_hash,
    current_event.provider_bindings, current_event.proof_event_ids,
    'system-revoke-' || left(encode(
      extensions.digest(coalesce(p_reason, 'state-change'), 'sha256'), 'hex'
    ), 24),
    null, gen_random_uuid(),
    encode(extensions.digest(
      'storyops-system-launch-revoke-v1' || chr(31)
      || p_company_id::text || chr(31) || next_version::text || chr(31)
      || coalesce(p_reason, 'state-change'),
      'sha256'
    ), 'hex'),
    clock_timestamp()
  );
  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id, retention_class, retain_until
  )
  values (
    p_company_id, 'system', 'provider-launch-boundary',
    'company.launch_system_revoked', 'company_launch_authorization',
    event_id,
    jsonb_build_object(
      'version', next_version,
      'reasonCode', left(encode(
        extensions.digest(coalesce(p_reason, 'state-change'), 'sha256'), 'hex'
      ), 24)
    ),
    event_id::text, 'audit', now() + interval '7 years'
  );
end;
$$;

revoke all on function private.storyops_canonical_provider(text)
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_current_launch_version(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_append_system_launch_revoke(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function private.storyops_revoke_launch_on_binding_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if tg_table_name = 'company_configuration_versions'
    and (
      new.status = 'published'
      or (tg_op = 'UPDATE' and old.status = 'published')
    )
  then
    perform private.storyops_append_system_launch_revoke(
      new.company_id,
      'published-configuration-changed'
    );
  elsif tg_table_name = 'company_operating_baseline_publications'
    and (
      new.status = 'active'
      or (tg_op = 'UPDATE' and old.status = 'active')
    )
  then
    perform private.storyops_append_system_launch_revoke(
      new.company_id,
      'operating-baseline-changed'
    );
  end if;
  return new;
end;
$$;

revoke all on function private.storyops_revoke_launch_on_binding_change()
  from public, anon, authenticated, service_role;

create trigger company_configuration_launch_invalidation
after insert or update of status
on public.company_configuration_versions
for each row execute function
  private.storyops_revoke_launch_on_binding_change();

create trigger operating_baseline_launch_invalidation
after insert or update of status
on public.company_operating_baseline_publications
for each row execute function
  private.storyops_revoke_launch_on_binding_change();

create or replace function public.record_storyops_integration_environment_probe(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_probe_run_id uuid,
  p_deployment_fingerprint text,
  p_results jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  item jsonb;
  provider_value text;
  connection_provider text;
  capability_value text;
  mode_value text;
  status_value text;
  checked_value timestamptz;
  latency_value integer;
  required_value text[];
  connection_row public.integration_connections%rowtype;
  provider_record record;
  normalized jsonb := '[]'::jsonb;
  material_provider_change boolean;
  provider_was_owner_enabled boolean;
  launch_invalidating_provider_change boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'PROVIDER_PROBE_SERVICE_ROLE_REQUIRED';
  end if;
  perform private.assert_storyops_edge_actor(
    p_company_id,
    p_actor_user_id,
    array['owner', 'dispatcher']
  );
  if p_probe_run_id is null
    or p_deployment_fingerprint !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_results) <> 'array'
    or jsonb_array_length(p_results) not between 1 and 20
  then
    raise exception 'PROVIDER_PROBE_INVALID_REQUEST';
  end if;
  if (
    select count(*)
    from jsonb_array_elements(p_results) value
  ) <> (
    select count(distinct (
      private.storyops_canonical_provider(value ->> 'provider'),
      value ->> 'capability'
    ))
    from jsonb_array_elements(p_results) value
  ) then
    raise exception 'PROVIDER_PROBE_DUPLICATE_CAPABILITY';
  end if;

  for item in
    select value
    from jsonb_array_elements(p_results) value
    order by
      private.storyops_canonical_provider(value ->> 'provider'),
      value ->> 'capability'
  loop
    if not (
      item ?& array[
        'provider', 'capability', 'mode', 'status', 'checkedAt',
        'latencyMs', 'requiredEnvironment'
      ]
    ) or item - array[
      'provider', 'capability', 'mode', 'status', 'checkedAt',
      'latencyMs', 'requiredEnvironment'
    ]::text[] <> '{}'::jsonb
    then
      raise exception 'PROVIDER_PROBE_UNSUPPORTED_FIELDS';
    end if;
    provider_value := item ->> 'provider';
    connection_provider := private.storyops_canonical_provider(provider_value);
    capability_value := item ->> 'capability';
    mode_value := item ->> 'mode';
    status_value := item ->> 'status';
    begin
      checked_value := (item ->> 'checkedAt')::timestamptz;
      latency_value := (item ->> 'latencyMs')::integer;
      select coalesce(array_agg(setting order by setting), '{}'::text[])
      into required_value
      from jsonb_array_elements_text(item -> 'requiredEnvironment') setting;
    exception when others then
      raise exception 'PROVIDER_PROBE_INVALID_RESULT';
    end;
    if provider_value not in (
      'openai', 'twilio', 'email', 'stripe', 'google_calendar', 'maps',
      'nws', 'vroom', 'signed_storage_targets', 'storage',
      'quickbooks_export', 'scheduling_evidence_gate'
    )
      or capability_value !~ '^[a-z][a-z0-9_]{2,79}$'
      or mode_value not in ('disabled', 'sandbox', 'live')
      or status_value not in ('healthy', 'not_configured', 'degraded', 'down')
      or checked_value < now() - interval '5 minutes'
      or checked_value > now() + interval '1 minute'
      or latency_value not between 0 and 120000
      or cardinality(required_value) > 40
      or exists (
        select 1 from unnest(required_value) setting
        where setting !~ '^[A-Z][A-Z0-9_]{1,79}$'
      )
    then
      raise exception 'PROVIDER_PROBE_INVALID_RESULT';
    end if;

    connection_row := null;
    if provider_value <> 'scheduling_evidence_gate' then
      select *
      into connection_row
      from public.integration_connections connection
      where connection.company_id = p_company_id
        and connection.provider = connection_provider
      for update;
      if connection_row.id is null then
        raise exception 'PROVIDER_PROBE_CONNECTION_MISSING';
      end if;
    end if;

    insert into public.integration_environment_probe_results(
      company_id, connection_id, probe_run_id, provider, capability,
      environment_mode, status, result_code, deployment_fingerprint,
      required_settings, latency_ms, checked_at, expires_at,
      recorded_by_user_id
    )
    values (
      p_company_id, connection_row.id, p_probe_run_id,
      case when provider_value = 'storage' then 'signed_storage_targets'
        else provider_value end,
      capability_value, mode_value, status_value, status_value,
      p_deployment_fingerprint, required_value, latency_value,
      checked_value, checked_value + interval '15 minutes',
      p_actor_user_id
    );
  end loop;

  for provider_record in
    select
      connection.id,
      connection.provider,
      bool_and(result.environment_mode = 'live') as all_live,
      bool_and(result.environment_mode = 'sandbox') as all_sandbox,
      bool_and(result.status = 'healthy') as all_healthy,
      array_agg(result.capability order by result.capability) as capabilities,
      min(result.checked_at) as checked_at,
      min(result.expires_at) as expires_at
    from public.integration_connections connection
    join public.integration_environment_probe_results result
      on result.connection_id = connection.id
     and result.probe_run_id = p_probe_run_id
    where connection.company_id = p_company_id
    group by connection.id, connection.provider
  loop
    select
      (
        connection.environment_mode <> case
          when provider_record.all_live then 'live'
          when provider_record.all_sandbox then 'sandbox'
          else 'disabled'
        end
        or connection.environment_fingerprint is distinct from
          p_deployment_fingerprint
        or connection.environment_capabilities is distinct from
          provider_record.capabilities
      ),
      connection.owner_enabled
    into material_provider_change, provider_was_owner_enabled
    from public.integration_connections connection
    where connection.id = provider_record.id;
    if material_provider_change and provider_was_owner_enabled then
      launch_invalidating_provider_change := true;
    end if;
    update public.integration_connections connection
    set
      mode = case
        when material_provider_change then 'disabled'
        else connection.mode
      end,
      owner_enabled = case
        when material_provider_change then false
        else connection.owner_enabled
      end,
      environment_mode = case
        when provider_record.all_live then 'live'
        when provider_record.all_sandbox then 'sandbox'
        else 'disabled'
      end,
      environment_fingerprint = p_deployment_fingerprint,
      environment_probe_run_id = p_probe_run_id,
      environment_capabilities = provider_record.capabilities,
      environment_checked_at = provider_record.checked_at,
      environment_expires_at = provider_record.expires_at,
      environment_status = case
        when provider_record.all_healthy then 'healthy'
        when exists (
          select 1
          from public.integration_environment_probe_results result
          where result.connection_id = provider_record.id
            and result.probe_run_id = p_probe_run_id
            and result.status in ('degraded', 'down')
        ) then 'degraded'
        else 'not_configured'
      end,
      status = case
        when material_provider_change or not connection.owner_enabled then 'disabled'
        when provider_record.all_healthy then 'healthy'
        when exists (
          select 1
          from public.integration_environment_probe_results result
          where result.connection_id = provider_record.id
            and result.probe_run_id = p_probe_run_id
            and result.status in ('degraded', 'down')
        ) then 'degraded'
        else 'misconfigured'
      end,
      last_checked_at = provider_record.checked_at,
      last_error = case
        when provider_record.all_healthy then null
        else 'ENVIRONMENT_PROBE_NOT_HEALTHY'
      end,
      configuration = jsonb_build_object(
        'source', 'trusted_environment_probe',
        'probeRunId', p_probe_run_id
      ),
      secret_reference = case
        when provider_record.all_healthy
          and (
            provider_record.all_live
            or provider_record.all_sandbox
          )
        then 'deployment-env/' || connection.provider || '/'
          || left(p_deployment_fingerprint, 16)
        else connection.secret_reference
      end,
      capabilities = case
        when material_provider_change then '{}'::text[]
        else connection.capabilities
      end,
      disabled_at = case
        when material_provider_change then now()
        else connection.disabled_at
      end,
      updated_at = now(),
      version = connection.version + case
        when material_provider_change then 1
        else 0
      end
    where connection.id = provider_record.id;
    if material_provider_change and provider_was_owner_enabled then
      insert into public.audit_events(
        company_id, actor_type, actor_id, action, entity_type, entity_id,
        after_data, request_id, retention_class, retain_until
      )
      values (
        p_company_id, 'system', 'provider-environment-probe',
        'integration.provider_activation_invalidated',
        'integration_connection', provider_record.id,
        jsonb_build_object(
          'provider', provider_record.provider,
          'reasonCode', 'MATERIAL_ENVIRONMENT_GENERATION_CHANGED'
        ),
        p_probe_run_id::text, 'audit', now() + interval '7 years'
      );
    end if;
  end loop;

  if launch_invalidating_provider_change or exists (
    select 1
    from public.integration_connections connection
    where connection.company_id = p_company_id
      and connection.owner_enabled
      and (
        connection.environment_status <> 'healthy'
        or connection.environment_expires_at <= now()
        or connection.environment_mode <> connection.mode
        or connection.environment_capabilities is distinct from connection.capabilities
      )
  ) then
    perform private.storyops_append_system_launch_revoke(
      p_company_id,
      'provider-environment-proof-changed'
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider', result.provider,
    'capability', result.capability,
    'mode', result.environment_mode,
    'status', result.status,
    'checkedAt', result.checked_at,
    'expiresAt', result.expires_at,
    'latencyMs', result.latency_ms,
    'probeRunId', result.probe_run_id
  ) order by result.provider, result.capability), '[]'::jsonb)
  into normalized
  from public.integration_environment_probe_results result
  where result.company_id = p_company_id
    and result.probe_run_id = p_probe_run_id;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id, retention_class, retain_until
  )
  values (
    p_company_id, 'user', p_actor_user_id::text,
    'integration.environment_probe_recorded', 'integration_probe_run',
    p_probe_run_id,
    jsonb_build_object(
      'probeRunId', p_probe_run_id,
      'resultCount', jsonb_array_length(normalized),
      'deploymentFingerprintPrefix', left(p_deployment_fingerprint, 12)
    ),
    p_probe_run_id::text, 'audit', now() + interval '7 years'
  );

  return jsonb_build_object(
    'schemaVersion', 'storyops-provider-probe-receipt-v1',
    'companyId', p_company_id,
    'probeRunId', p_probe_run_id,
    'providers', normalized,
    'serverTime', now()
  );
end;
$$;

revoke all on function public.record_storyops_integration_environment_probe(
  uuid, uuid, uuid, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_storyops_integration_environment_probe(
  uuid, uuid, uuid, text, jsonb
) to service_role;

create or replace function public.set_storyops_provider_activation(
  p_company_id uuid,
  p_command_id uuid,
  p_provider text,
  p_expected_version integer,
  p_target_mode text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, extensions, private
as $$
declare
  actor_user_id uuid := auth.uid();
  provider_value text := private.storyops_canonical_provider(p_provider);
  connection_row public.integration_connections%rowtype;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  effective_hash text;
  response_value jsonb;
  current_launch_version integer;
  original_claim_role text := auth.role();
begin
  if auth.role() is distinct from 'authenticated' or actor_user_id is null then
    raise exception 'PROVIDER_ACTIVATION_AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = actor_user_id
      and membership.active
      and membership.role = 'owner'
  ) then
    raise exception 'PROVIDER_ACTIVATION_OWNER_REQUIRED';
  end if;
  if p_company_id is null
    or p_command_id is null
    or p_expected_version < 1
    or p_target_mode not in ('disabled', 'sandbox', 'live')
    or provider_value not in (
      'openai', 'twilio', 'email', 'stripe', 'google_calendar', 'maps',
      'nws', 'vroom', 'signed_storage_targets', 'quickbooks_export'
    )
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'PROVIDER_ACTIVATION_INVALID_REQUEST';
  end if;
  effective_hash := encode(extensions.digest(
    array_to_string(array[
      'storyops-provider-activation-v1',
      provider_value,
      p_expected_version::text,
      p_target_mode
    ], chr(31)),
    'sha256'
  ), 'hex');
  if p_request_hash <> effective_hash then
    raise exception 'PROVIDER_ACTIVATION_REQUEST_HASH_MISMATCH';
  end if;

  begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id, 'provider-activation-v1', p_command_id::text,
    effective_hash, now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;
  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys key_record
    where key_record.company_id = p_company_id
      and key_record.scope = 'provider-activation-v1'
      and key_record.key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_hash then
      raise exception 'PROVIDER_ACTIVATION_IDEMPOTENCY_CONFLICT';
    end if;
    if reservation.status = 'completed' then
      perform set_config(
        'request.jwt.claim.role',
        original_claim_role,
        true
      );
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'PROVIDER_ACTIVATION_COMMAND_IN_PROGRESS';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-provider-activation:' || p_company_id::text || ':' || provider_value,
    0
  ));
  select *
  into connection_row
  from public.integration_connections connection
  where connection.company_id = p_company_id
    and connection.provider = provider_value
  for update;
  if connection_row.id is null then
    raise exception 'PROVIDER_ACTIVATION_CONNECTION_MISSING';
  end if;
  if connection_row.version <> p_expected_version then
    raise exception 'PROVIDER_ACTIVATION_VERSION_CONFLICT';
  end if;
  if p_target_mode <> 'disabled' and not exists (
    select 1 from public.companies company
    where company.id = p_company_id
      and company.status = 'active'
  ) then
    raise exception 'PROVIDER_ACTIVATION_COMPANY_UNAVAILABLE';
  end if;
  if p_target_mode <> 'disabled' and (
    connection_row.environment_mode <> p_target_mode
    or connection_row.environment_status <> 'healthy'
    or connection_row.environment_fingerprint is null
    or connection_row.environment_probe_run_id is null
    or cardinality(connection_row.environment_capabilities) < 1
    or connection_row.environment_checked_at < now() - interval '15 minutes'
    or connection_row.environment_checked_at > now() + interval '1 minute'
    or connection_row.environment_expires_at <= now()
    or exists (
      select 1
      from unnest(connection_row.environment_capabilities) capability
      where not exists (
        select 1
        from public.integration_environment_probe_results result
        where result.connection_id = connection_row.id
          and result.probe_run_id = connection_row.environment_probe_run_id
          and result.deployment_fingerprint = connection_row.environment_fingerprint
          and result.capability = capability
          and result.environment_mode = p_target_mode
          and result.status = 'healthy'
          and result.expires_at > now()
      )
    )
  ) then
    raise exception 'PROVIDER_ACTIVATION_CURRENT_ENVIRONMENT_PROOF_REQUIRED';
  end if;

  update public.integration_connections connection
  set
    mode = p_target_mode,
    owner_enabled = p_target_mode <> 'disabled',
    status = case
      when p_target_mode = 'disabled' then 'disabled'
      else case
        when connection_row.environment_status = 'healthy' then 'healthy'
        when connection_row.environment_status in ('degraded', 'down') then 'degraded'
        else 'misconfigured'
      end
    end,
    capabilities = case
      when p_target_mode = 'disabled' then connection.capabilities
      else (
        connection.environment_capabilities
      )
    end,
    activated_by_user_id = case
      when p_target_mode = 'disabled' then connection.activated_by_user_id
      else actor_user_id
    end,
    activated_at = case
      when p_target_mode = 'disabled' then connection.activated_at
      else now()
    end,
    disabled_at = case
      when p_target_mode = 'disabled' then now()
      else null
    end,
    activation_command_id = p_command_id,
    updated_at = now(),
    version = connection.version + 1
  where connection.id = connection_row.id;

  perform private.storyops_append_system_launch_revoke(
    p_company_id,
    'provider-activation-changed-' || provider_value
  );
  current_launch_version := private.storyops_current_launch_version(p_company_id);

  select *
  into connection_row
  from public.integration_connections connection
  where connection.id = connection_row.id;
  response_value := jsonb_build_object(
    'schemaVersion', 'storyops-provider-activation-receipt-v1',
    'companyId', p_company_id,
    'provider', connection_row.provider,
    'mode', connection_row.mode,
    'ownerEnabled', connection_row.owner_enabled,
    'environmentMode', connection_row.environment_mode,
    'health', connection_row.environment_status,
    'capabilities', connection_row.capabilities,
    'version', connection_row.version,
    'launchVersion', current_launch_version,
    'commandId', p_command_id,
    'requestHash', effective_hash,
    'replayed', false,
    'serverTime', now()
  );
  update public.idempotency_keys
  set status = 'completed', response = response_value,
    completed_at = now(), updated_at = now()
  where id = reservation_id and status = 'in_progress';
  if not found then
    raise exception 'PROVIDER_ACTIVATION_RESERVATION_LOST';
  end if;
  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id, retention_class, retain_until
  )
  values (
    p_company_id, 'user', actor_user_id::text,
    case when p_target_mode = 'disabled'
      then 'integration.provider_disabled'
      else 'integration.provider_activated'
    end,
    'integration_connection', connection_row.id,
    response_value - array['companyId', 'serverTime']::text[],
    p_command_id::text, 'audit', now() + interval '7 years'
  );
  perform set_config('request.jwt.claim.role', original_claim_role, true);
  return response_value;
  exception when others then
    perform set_config(
      'request.jwt.claim.role',
      original_claim_role,
      true
    );
    raise;
  end;
end;
$$;

revoke all on function public.set_storyops_provider_activation(
  uuid, uuid, text, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.set_storyops_provider_activation(
  uuid, uuid, text, integer, text, text
) to authenticated;

create or replace function public.record_storyops_trusted_pilot_proof(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_kind text,
  p_provider text,
  p_capability text,
  p_outcome text,
  p_evidence_reference text,
  p_artifact_sha256 text,
  p_observed_at timestamptz,
  p_expires_at timestamptz
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
  provider_value text := case
    when p_provider is null then null
    else private.storyops_canonical_provider(p_provider)
  end;
  evidence_id uuid := gen_random_uuid();
  effective_hash text;
  response_value jsonb;
  binding_value jsonb;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'TRUSTED_PILOT_PROOF_SERVICE_ROLE_REQUIRED';
  end if;
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner']
  );
  if p_command_id is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_kind not in ('provider_canary', 'field_media_canary', 'backup_restore')
    or p_outcome not in ('passed', 'failed')
    or p_capability !~ '^[a-z][a-z0-9_]{2,79}$'
    or p_evidence_reference !~ '^[A-Za-z0-9][A-Za-z0-9._-]{4,119}$'
    or p_artifact_sha256 !~ '^[a-f0-9]{64}$'
    or p_observed_at < now() - interval '30 days'
    or p_observed_at > now()
    or p_expires_at <= now()
    or p_expires_at <= p_observed_at
    or p_expires_at > p_observed_at + (case
      when p_kind = 'provider_canary' then interval '7 days'
      else interval '30 days'
    end)
    or (
      p_kind = 'provider_canary'
      and provider_value is null
    )
    or (
      p_kind = 'field_media_canary'
      and (
        provider_value <> 'signed_storage_targets'
        or p_capability <> 'private_media_roundtrip'
      )
    )
    or (
      p_kind = 'backup_restore'
      and (
        provider_value is not null
        or p_capability <> 'isolated_database_restore'
      )
    )
  then
    raise exception 'TRUSTED_PILOT_PROOF_INVALID_REQUEST';
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
    raise exception 'TRUSTED_PILOT_PROOF_CURRENT_BASELINE_REQUIRED';
  end if;
  if provider_value is not null then
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
      or connection_row.environment_expires_at <= now()
      or not (
        p_capability = any(connection_row.capabilities)
        or (
          p_kind = 'field_media_canary'
          and 'server_signed_targets' = any(connection_row.capabilities)
        )
      )
    then
      raise exception 'TRUSTED_PILOT_PROOF_ACTIVE_PROVIDER_REQUIRED';
    end if;
  end if;
  effective_hash := encode(extensions.digest(array_to_string(array[
    'storyops-trusted-pilot-proof-v1',
    p_kind, coalesce(provider_value, ''), p_capability, p_outcome,
    p_evidence_reference, p_artifact_sha256,
    to_char(p_observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char(p_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ], chr(31)), 'sha256'), 'hex');
  if p_request_hash <> effective_hash then
    raise exception 'TRUSTED_PILOT_PROOF_REQUEST_HASH_MISMATCH';
  end if;
  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id, 'trusted-pilot-proof-v1', p_command_id::text,
    effective_hash, now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;
  if reservation_id is null then
    select * into reservation
    from public.idempotency_keys key_record
    where key_record.company_id = p_company_id
      and key_record.scope = 'trusted-pilot-proof-v1'
      and key_record.key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_hash then
      raise exception 'TRUSTED_PILOT_PROOF_IDEMPOTENCY_CONFLICT';
    end if;
    if reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'TRUSTED_PILOT_PROOF_COMMAND_IN_PROGRESS';
  end if;

  binding_value := jsonb_strip_nulls(jsonb_build_object(
    'configurationRevision', configuration_row.revision,
    'configurationHash', configuration_row.configuration_hash,
    'baselineId', baseline_row.id,
    'baselineHash', baseline_row.baseline_hash,
    'capability', p_capability,
    'integrationProvider', provider_value,
    'integrationVersion', connection_row.version
  ));
  insert into public.audit_events(
    id, company_id, occurred_at, actor_type, actor_id, action,
    entity_type, entity_id, after_data, request_id,
    retention_class, retain_until
  )
  values (
    gen_random_uuid(), p_company_id, now(), 'system',
    'trusted-canary-worker', 'pilot.evidence_recorded',
    'pilot_release_evidence', evidence_id,
    jsonb_strip_nulls(jsonb_build_object(
      'kind', p_kind,
      'provider', provider_value,
      'outcome', p_outcome,
      'source', case
        when p_kind = 'provider_canary' then 'external_provider_receipt'
        when p_kind = 'field_media_canary' then 'storage_roundtrip'
        else 'isolated_restore_drill'
      end,
      'evidenceReference', p_evidence_reference,
      'artifactSha256', p_artifact_sha256,
      'observedAt', p_observed_at,
      'expiresAt', p_expires_at,
      'reviewedByUserId', p_actor_user_id,
      'verificationBasis', 'trusted_system_proof',
      'binding', binding_value,
      'reviewNote', 'trusted-system-proof'
    )),
    p_command_id::text, 'audit', now() + interval '7 years'
  );
  perform private.storyops_append_system_launch_revoke(
    p_company_id,
    'trusted-pilot-proof-changed'
  );
  response_value := jsonb_build_object(
    'schemaVersion', 'storyops-trusted-pilot-proof-receipt-v1',
    'companyId', p_company_id,
    'commandId', p_command_id,
    'requestHash', effective_hash,
    'evidenceId', evidence_id,
    'binding', binding_value,
    'replayed', false,
    'serverTime', now()
  );
  update public.idempotency_keys
  set status = 'completed', response = response_value,
    completed_at = now(), updated_at = now()
  where id = reservation_id and status = 'in_progress';
  return response_value;
end;
$$;

revoke all on function public.record_storyops_trusted_pilot_proof(
  uuid, uuid, uuid, text, text, text, text, text, text, text,
  timestamptz, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.record_storyops_trusted_pilot_proof(
  uuid, uuid, uuid, text, text, text, text, text, text, text,
  timestamptz, timestamptz
) to service_role;

create or replace function private.storyops_provider_snapshot(
  p_company_id uuid
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', connection.id,
    'provider', connection.provider,
    'mode', connection.mode,
    'ownerEnabled', connection.owner_enabled,
    'environmentMode', connection.environment_mode,
    'environmentFingerprint', connection.environment_fingerprint,
    'capabilities', connection.capabilities,
    'version', connection.version
  ) order by connection.provider), '[]'::jsonb)
  from public.integration_connections connection
  where connection.company_id = p_company_id
    and connection.owner_enabled
    and connection.mode = 'live'
$$;

create or replace function private.storyops_live_configuration_matches_provider_authority(
  p_company_id uuid,
  p_configuration jsonb
)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce((
    jsonb_typeof(p_configuration #> '{integrations,providers}') = 'array'
    and not exists (
      select 1
      from public.integration_connections connection
      where connection.company_id = p_company_id
        and connection.owner_enabled
        and not exists (
          select 1
          from jsonb_array_elements(
            p_configuration #> '{integrations,providers}'
          ) configured
          where case
            when configured ->> 'provider' = 'storage'
              then 'signed_storage_targets'
            else configured ->> 'provider'
          end = connection.provider
            and configured ->> 'requestedMode' = 'live'
        )
    )
    and not exists (
      select 1
      from jsonb_array_elements(
        p_configuration #> '{integrations,providers}'
      ) configured
      where configured ->> 'requestedMode' = 'live'
        and not exists (
          select 1
          from public.integration_connections connection
          where connection.company_id = p_company_id
            and connection.provider = case
              when configured ->> 'provider' = 'storage'
                then 'signed_storage_targets'
              else configured ->> 'provider'
            end
            and connection.owner_enabled
            and connection.mode = 'live'
            and connection.environment_mode = 'live'
            and connection.environment_status = 'healthy'
            and connection.environment_checked_at >= now() - interval '15 minutes'
            and connection.environment_checked_at <= now() + interval '1 minute'
            and connection.environment_expires_at > now()
        )
    )
  ), false)
$$;

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

create or replace function private.storyops_launch_authorization_effective(
  p_company_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private, auth, extensions
as $$
declare
  event_row public.company_launch_authorization_events%rowtype;
  configuration_row public.company_configuration_versions%rowtype;
  baseline_row public.company_operating_baseline_publications%rowtype;
  provider_snapshot jsonb;
  proof_snapshot jsonb;
begin
  select * into event_row
  from public.company_launch_authorization_events event
  where event.company_id = p_company_id
  order by event.version desc
  limit 1;
  if event_row.id is null or event_row.action <> 'authorize' then
    return false;
  end if;
  if not exists (
    select 1 from public.companies company
    where company.id = p_company_id and company.status = 'active'
  ) then
    return false;
  end if;
  select * into configuration_row
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.status = 'published'
    and configuration.publication_mode = 'live';
  select * into baseline_row
  from public.company_operating_baseline_publications baseline
  where baseline.company_id = p_company_id and baseline.status = 'active';
  if configuration_row.revision is distinct from event_row.configuration_revision
    or configuration_row.configuration_hash is distinct from event_row.configuration_hash
    or baseline_row.id is distinct from event_row.baseline_id
    or baseline_row.baseline_hash is distinct from event_row.baseline_hash
  then
    return false;
  end if;
  if not private.storyops_live_configuration_matches_provider_authority(
    p_company_id,
    configuration_row.configuration
  ) then
    return false;
  end if;
  if exists (
    select 1
    from public.integration_connections connection
    where connection.company_id = p_company_id
      and connection.owner_enabled
      and (
        connection.mode <> 'live'
        or connection.environment_mode <> 'live'
        or connection.environment_status <> 'healthy'
        or connection.environment_probe_run_id is null
        or cardinality(connection.environment_capabilities) < 1
        or connection.environment_capabilities is distinct from connection.capabilities
        or connection.environment_checked_at < now() - interval '15 minutes'
        or connection.environment_checked_at > now() + interval '1 minute'
        or connection.environment_expires_at <= now()
        or exists (
          select 1
          from unnest(connection.environment_capabilities) capability
          where not exists (
            select 1
            from public.integration_environment_probe_results result
            where result.connection_id = connection.id
              and result.probe_run_id = connection.environment_probe_run_id
              and result.deployment_fingerprint =
                connection.environment_fingerprint
              and result.capability = capability
              and result.environment_mode = 'live'
              and result.status = 'healthy'
              and result.expires_at > now()
          )
        )
      )
  ) then
    return false;
  end if;
  if not exists (
    select 1
    from public.integration_environment_probe_results result
    where result.company_id = p_company_id
      and result.provider = 'scheduling_evidence_gate'
      and result.capability = 'calendar_weather_route_booking_evidence'
      and result.environment_mode = 'live'
      and result.status = 'healthy'
      and result.checked_at >= now() - interval '15 minutes'
      and result.checked_at <= now() + interval '1 minute'
      and result.expires_at > now()
  ) then
    return false;
  end if;
  provider_snapshot := private.storyops_provider_snapshot(p_company_id);
  if encode(extensions.digest(provider_snapshot::text, 'sha256'), 'hex')
    <> event_row.provider_snapshot_hash
  then
    return false;
  end if;
  proof_snapshot := private.storyops_current_trusted_proofs(p_company_id);
  if encode(extensions.digest(proof_snapshot::text, 'sha256'), 'hex')
    <> event_row.proof_snapshot_hash
    or exists (
      select 1
      from jsonb_array_elements(proof_snapshot) proof
      where proof ->> 'outcome' <> 'passed'
        or (proof ->> 'expiresAt')::timestamptz <= now()
        or (proof #>> '{binding,configurationRevision}')::integer
          <> event_row.configuration_revision
        or proof #>> '{binding,configurationHash}'
          <> event_row.configuration_hash
        or (proof #>> '{binding,baselineId}')::uuid
          <> event_row.baseline_id
        or proof #>> '{binding,baselineHash}'
          <> event_row.baseline_hash
    )
  then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function private.storyops_provider_snapshot(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  private.storyops_live_configuration_matches_provider_authority(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_current_trusted_proofs(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_launch_authorization_effective(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.set_storyops_company_launch_authorization(
  p_company_id uuid,
  p_command_id uuid,
  p_expected_version integer,
  p_action text,
  p_review_reference text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, private, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  configuration_row public.company_configuration_versions%rowtype;
  baseline_row public.company_operating_baseline_publications%rowtype;
  current_event public.company_launch_authorization_events%rowtype;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  next_version integer;
  effective_hash text;
  provider_snapshot jsonb;
  proof_snapshot jsonb;
  provider_hash text;
  proof_hash text;
  event_id uuid := gen_random_uuid();
  response_value jsonb;
  original_claim_role text := auth.role();
begin
  if auth.role() is distinct from 'authenticated' or actor_user_id is null then
    raise exception 'LAUNCH_AUTHORIZATION_AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1 from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = actor_user_id
      and membership.active and membership.role = 'owner'
  ) then
    raise exception 'LAUNCH_AUTHORIZATION_OWNER_REQUIRED';
  end if;
  if p_command_id is null
    or p_expected_version < 0
    or p_action not in ('authorize', 'revoke')
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or length(btrim(p_review_reference)) not between 10 and 120
    or btrim(p_review_reference) !~ '^[A-Za-z0-9][A-Za-z0-9._-]{9,119}$'
  then
    raise exception 'LAUNCH_AUTHORIZATION_INVALID_REQUEST';
  end if;
  effective_hash := encode(extensions.digest(array_to_string(array[
    'storyops-launch-authorization-v1',
    p_action, p_expected_version::text, btrim(p_review_reference)
  ], chr(31)), 'sha256'), 'hex');
  if p_request_hash <> effective_hash then
    raise exception 'LAUNCH_AUTHORIZATION_REQUEST_HASH_MISMATCH';
  end if;
  begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id, 'launch-authorization-v1', p_command_id::text,
    effective_hash, now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;
  if reservation_id is null then
    select * into reservation
    from public.idempotency_keys key_record
    where key_record.company_id = p_company_id
      and key_record.scope = 'launch-authorization-v1'
      and key_record.key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_hash then
      raise exception 'LAUNCH_AUTHORIZATION_IDEMPOTENCY_CONFLICT';
    end if;
    if reservation.status = 'completed' then
      perform set_config(
        'request.jwt.claim.role',
        original_claim_role,
        true
      );
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'LAUNCH_AUTHORIZATION_COMMAND_IN_PROGRESS';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-launch-authorization:' || p_company_id::text, 0
  ));
  select * into current_event
  from public.company_launch_authorization_events event
  where event.company_id = p_company_id
  order by event.version desc limit 1 for update;
  if coalesce(current_event.version, 0) <> p_expected_version then
    raise exception 'LAUNCH_AUTHORIZATION_VERSION_CONFLICT';
  end if;
  if p_action = 'revoke' and current_event.action is distinct from 'authorize' then
    raise exception 'LAUNCH_AUTHORIZATION_NOT_ACTIVE';
  end if;

  if p_action = 'authorize' then
    select * into configuration_row
    from public.company_configuration_versions configuration
    where configuration.company_id = p_company_id
      and configuration.status = 'published'
      and configuration.publication_mode = 'live';
    select * into baseline_row
    from public.company_operating_baseline_publications baseline
    where baseline.company_id = p_company_id and baseline.status = 'active';
    if configuration_row.id is null
      or baseline_row.id is null
      or baseline_row.configuration_revision <> configuration_row.revision
      or baseline_row.configuration_hash <> configuration_row.configuration_hash
    then
      raise exception 'LAUNCH_AUTHORIZATION_CURRENT_BASELINE_REQUIRED';
    end if;
    provider_snapshot := private.storyops_provider_snapshot(p_company_id);
    proof_snapshot := private.storyops_current_trusted_proofs(p_company_id);
    provider_hash := encode(
      extensions.digest(provider_snapshot::text, 'sha256'),
      'hex'
    );
    proof_hash := encode(
      extensions.digest(proof_snapshot::text, 'sha256'),
      'hex'
    );
    if not exists (
      select 1 from public.companies company
      where company.id = p_company_id and company.status = 'active'
    ) then
      raise exception 'LAUNCH_AUTHORIZATION_ACTIVE_COMPANY_REQUIRED';
    end if;
    if not (
      configuration_row.configuration #>> '{pricing,taxReview,status}' = 'approved'
      and configuration_row.configuration #>> '{policies,legalReview,status}' = 'approved'
      and configuration_row.configuration #>> '{policies,privacyReview,status}' = 'approved'
      and configuration_row.configuration #>> '{policies,safetyReview,status}' = 'approved'
      and configuration_row.configuration #>> '{policies,insuranceReview,status}' = 'approved'
      and configuration_row.configuration #>> '{policies,environmentalReview,status}' = 'approved'
    ) then
      raise exception 'LAUNCH_AUTHORIZATION_REVIEWS_REQUIRED';
    end if;
    if not private.storyops_live_configuration_matches_provider_authority(
      p_company_id,
      configuration_row.configuration
    ) then
      raise exception
        'LAUNCH_AUTHORIZATION_CONFIGURATION_PROVIDER_BINDING_REQUIRED';
    end if;
    if not exists (
      select 1 from public.integration_connections connection
      where connection.company_id = p_company_id
        and connection.provider in ('twilio', 'email')
        and connection.owner_enabled
        and connection.mode = 'live'
        and connection.environment_mode = 'live'
        and connection.environment_status = 'healthy'
        and connection.environment_expires_at > now()
    ) or exists (
      select required.provider
      from unnest(array[
        'stripe', 'google_calendar', 'maps', 'nws', 'vroom',
        'signed_storage_targets'
      ]::text[]) required(provider)
      where not exists (
        select 1 from public.integration_connections connection
        where connection.company_id = p_company_id
          and connection.provider = required.provider
          and connection.owner_enabled
          and connection.mode = 'live'
          and connection.environment_mode = 'live'
          and connection.environment_status = 'healthy'
          and connection.environment_checked_at >= now() - interval '15 minutes'
          and connection.environment_checked_at <= now() + interval '1 minute'
          and connection.environment_expires_at > now()
      )
    ) then
      raise exception 'LAUNCH_AUTHORIZATION_REQUIRED_PROVIDERS_NOT_READY';
    end if;
    if not exists (
      select 1
      from public.integration_environment_probe_results result
      where result.company_id = p_company_id
        and result.provider = 'scheduling_evidence_gate'
        and result.capability = 'calendar_weather_route_booking_evidence'
        and result.environment_mode = 'live'
        and result.status = 'healthy'
        and result.expires_at > now()
    ) then
      raise exception 'LAUNCH_AUTHORIZATION_SCHEDULING_GATE_REQUIRED';
    end if;
    if not exists (
      select 1 from jsonb_array_elements(proof_snapshot) proof
      where proof ->> 'kind' = 'field_media_canary'
        and proof ->> 'outcome' = 'passed'
        and (proof ->> 'expiresAt')::timestamptz > now()
    ) or not exists (
      select 1 from jsonb_array_elements(proof_snapshot) proof
      where proof ->> 'kind' = 'backup_restore'
        and proof ->> 'outcome' = 'passed'
        and (proof ->> 'expiresAt')::timestamptz > now()
    ) or exists (
      select 1
      from jsonb_array_elements(provider_snapshot) provider
      cross join lateral jsonb_array_elements_text(provider -> 'capabilities') capability
      where not exists (
        select 1 from jsonb_array_elements(proof_snapshot) proof
        where proof ->> 'kind' = 'provider_canary'
          and proof ->> 'provider' = provider ->> 'provider'
          and proof ->> 'capability' = capability
          and proof ->> 'outcome' = 'passed'
          and (proof ->> 'expiresAt')::timestamptz > now()
          and (proof #>> '{binding,integrationVersion}')::integer
            = (provider ->> 'version')::integer
      )
    ) then
      raise exception 'LAUNCH_AUTHORIZATION_TRUSTED_PROOFS_REQUIRED';
    end if;
  else
    configuration_row.revision := current_event.configuration_revision;
    configuration_row.configuration_hash := current_event.configuration_hash;
    baseline_row.id := current_event.baseline_id;
    baseline_row.baseline_hash := current_event.baseline_hash;
    provider_snapshot := current_event.provider_bindings;
    proof_snapshot := '[]'::jsonb;
    provider_hash := current_event.provider_snapshot_hash;
    proof_hash := current_event.proof_snapshot_hash;
  end if;

  next_version := p_expected_version + 1;
  insert into public.company_launch_authorization_events(
    id, company_id, version, action, configuration_revision,
    configuration_hash, baseline_id, baseline_hash,
    provider_snapshot_hash, proof_snapshot_hash, provider_bindings,
    proof_event_ids, review_reference, actor_user_id, command_id,
    request_hash
  )
  values (
    event_id, p_company_id, next_version, p_action,
    configuration_row.revision, configuration_row.configuration_hash,
    baseline_row.id, baseline_row.baseline_hash,
    provider_hash, proof_hash, provider_snapshot,
    case when p_action = 'revoke'
      then current_event.proof_event_ids
      else coalesce((
        select jsonb_agg(
          proof ->> 'auditEventId'
          order by proof ->> 'auditEventId'
        )
        from jsonb_array_elements(proof_snapshot) proof
      ), '[]'::jsonb)
    end,
    btrim(p_review_reference), actor_user_id, p_command_id, effective_hash
  );
  response_value := jsonb_build_object(
    'schemaVersion', 'storyops-launch-authorization-receipt-v1',
    'companyId', p_company_id,
    'version', next_version,
    'status', case when p_action = 'authorize' then 'authorized' else 'revoked' end,
    'launchAuthorized', p_action = 'authorize',
    'configurationRevision', configuration_row.revision,
    'configurationHash', configuration_row.configuration_hash,
    'baselineId', baseline_row.id,
    'baselineHash', baseline_row.baseline_hash,
    'providerSnapshotHash', provider_hash,
    'proofSnapshotHash', proof_hash,
    'reviewReference', btrim(p_review_reference),
    'commandId', p_command_id,
    'requestHash', effective_hash,
    'replayed', false,
    'serverTime', now()
  );
  update public.idempotency_keys
  set status = 'completed', response = response_value,
    completed_at = now(), updated_at = now()
  where id = reservation_id and status = 'in_progress';
  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id, retention_class, retain_until
  )
  values (
    p_company_id, 'user', actor_user_id::text,
    case when p_action = 'authorize'
      then 'company.launch_authorized'
      else 'company.launch_revoked'
    end,
    'company_launch_authorization', event_id,
    response_value - array['companyId', 'serverTime']::text[],
    p_command_id::text, 'audit', now() + interval '7 years'
  );
  perform set_config('request.jwt.claim.role', original_claim_role, true);
  return response_value;
  exception when others then
    perform set_config(
      'request.jwt.claim.role',
      original_claim_role,
      true
    );
    raise;
  end;
end;
$$;

revoke all on function public.set_storyops_company_launch_authorization(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.set_storyops_company_launch_authorization(
  uuid, uuid, integer, text, text, text
) to authenticated;

-- The scheduling evidence boundary remains the source of truth for booking,
-- but a first-time booking promotion is also a controlled-launch start.
-- Completed idempotency receipts stay readable after revocation so callers do
-- not mistake an acknowledged booking for a failed command.
alter function public.execute_storyops_golden_path_command(
  uuid, uuid, text, integer, jsonb, text
) rename to execute_storyops_golden_path_command_before_launch_authority;

revoke all on function
  public.execute_storyops_golden_path_command_before_launch_authority(
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
set search_path = pg_catalog, public, private, extensions, auth
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
begin
  -- Invoice issuance completes already-performed work and is intentionally not
  -- a new controlled-launch start.
  if p_command_type <> 'job.book' then
    return
      public.execute_storyops_golden_path_command_before_launch_authority(
        p_company_id,
        p_command_id,
        p_command_type,
        p_expected_version,
        p_payload,
        p_request_hash
      );
  end if;

  if actor_user_id is null
    or p_company_id is null
    or p_command_id is null
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

  select *
  into reservation
  from public.idempotency_keys idempotency
  where idempotency.company_id = p_company_id
    and idempotency.scope = 'golden-path-booking-v2'
    and idempotency.key = p_command_id::text;
  if reservation.id is not null then
    if reservation.request_hash <> effective_request_hash then
      raise exception 'GOLDEN_PATH_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'GOLDEN_PATH_COMMAND_IN_PROGRESS';
  end if;

  -- Launch authorize/revoke and every automatic invalidation take the same
  -- transaction lock. A booking therefore linearizes wholly before or after a
  -- launch-state transition.
  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-launch-authorization:' || p_company_id::text,
    0
  ));

  -- The command may have completed while this transaction waited for the
  -- launch lock. Recheck before applying the launch gate or delegating.
  select *
  into reservation
  from public.idempotency_keys idempotency
  where idempotency.company_id = p_company_id
    and idempotency.scope = 'golden-path-booking-v2'
    and idempotency.key = p_command_id::text
  for update;
  if reservation.id is not null then
    if reservation.request_hash <> effective_request_hash then
      raise exception 'GOLDEN_PATH_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'GOLDEN_PATH_COMMAND_IN_PROGRESS';
  end if;

  if not private.storyops_launch_authorization_effective(p_company_id) then
    raise exception 'GOLDEN_PATH_LAUNCH_NOT_AUTHORIZED';
  end if;

  return public.execute_storyops_golden_path_command_before_launch_authority(
    p_company_id,
    p_command_id,
    p_command_type,
    p_expected_version,
    p_payload,
    p_request_hash
  );
end;
$$;

revoke all on function public.execute_storyops_golden_path_command(
  uuid, uuid, text, integer, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.execute_storyops_golden_path_command(
  uuid, uuid, text, integer, jsonb, text
) to authenticated;

create or replace function public.assert_storyops_provider_invocation(
  p_company_id uuid,
  p_provider text,
  p_capability text,
  p_operation_class text,
  p_deployment_fingerprint text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  provider_value text := private.storyops_canonical_provider(p_provider);
  connection_row public.integration_connections%rowtype;
  launch_required boolean := p_operation_class = 'launch_start';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'PROVIDER_INVOCATION_SERVICE_ROLE_REQUIRED';
  end if;
  if provider_value not in (
    'openai', 'twilio', 'email', 'stripe', 'google_calendar', 'maps',
    'nws', 'vroom', 'signed_storage_targets', 'quickbooks_export'
  )
    or p_capability !~ '^[a-z][a-z0-9_]{2,79}$'
    or p_operation_class not in ('internal', 'launch_start', 'recovery')
    or p_deployment_fingerprint !~ '^[a-f0-9]{64}$'
  then
    raise exception 'PROVIDER_INVOCATION_INVALID_REQUEST';
  end if;
  select * into connection_row
  from public.integration_connections connection
  where connection.company_id = p_company_id
    and connection.provider = provider_value;
  if connection_row.id is null
    or connection_row.environment_mode <> 'live'
    or connection_row.environment_status <> 'healthy'
    or connection_row.environment_checked_at < now() - interval '15 minutes'
    or connection_row.environment_checked_at > now() + interval '1 minute'
    or connection_row.environment_expires_at <= now()
    or connection_row.environment_fingerprint <> p_deployment_fingerprint
    or not (p_capability = any(connection_row.environment_capabilities))
    or not exists (
      select 1
      from public.integration_environment_probe_results result
      where result.connection_id = connection_row.id
        and result.probe_run_id = connection_row.environment_probe_run_id
        and result.deployment_fingerprint = connection_row.environment_fingerprint
        and result.capability = p_capability
        and result.environment_mode = 'live'
        and result.status = 'healthy'
        and result.expires_at > now()
    )
  then
    raise exception 'PROVIDER_INVOCATION_ENVIRONMENT_NOT_READY';
  end if;
  if p_operation_class <> 'recovery' and (
    not connection_row.owner_enabled
    or connection_row.mode <> 'live'
    or connection_row.status <> 'healthy'
    or not (p_capability = any(connection_row.capabilities))
  ) then
    raise exception 'PROVIDER_INVOCATION_NOT_AUTHORIZED';
  end if;
  if p_operation_class <> 'recovery' and not exists (
    select 1 from public.companies company
    where company.id = p_company_id and company.status = 'active'
  ) then
    raise exception 'PROVIDER_INVOCATION_COMPANY_NOT_ACTIVE';
  end if;
  if launch_required
    and not private.storyops_launch_authorization_effective(p_company_id)
  then
    raise exception 'PROVIDER_INVOCATION_LAUNCH_NOT_AUTHORIZED';
  end if;
  return jsonb_build_object(
    'authorized', true,
    'companyId', p_company_id,
    'provider', connection_row.provider,
    'capability', p_capability,
    'connectionVersion', connection_row.version,
    'launchRequired', launch_required,
    'serverTime', now()
  );
end;
$$;

create or replace function public.assert_storyops_launch_start(
  p_company_id uuid,
  p_capability text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'LAUNCH_START_SERVICE_ROLE_REQUIRED';
  end if;
  if p_capability not in (
    'inbound_lead_intake', 'customer_contact', 'payment_collection',
    'live_scheduling'
  ) then
    raise exception 'LAUNCH_START_INVALID_CAPABILITY';
  end if;
  if not private.storyops_launch_authorization_effective(p_company_id) then
    raise exception 'LAUNCH_START_NOT_AUTHORIZED';
  end if;
  return jsonb_build_object(
    'authorized', true,
    'companyId', p_company_id,
    'capability', p_capability,
    'serverTime', now()
  );
end;
$$;

revoke all on function public.assert_storyops_provider_invocation(
  uuid, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.assert_storyops_provider_invocation(
  uuid, text, text, text, text
) to service_role;
revoke all on function public.assert_storyops_launch_start(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.assert_storyops_launch_start(uuid, text)
  to service_role;

create or replace function public.get_storyops_provider_launch_state(
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
  actor_role public.app_role;
  latest_event public.company_launch_authorization_events%rowtype;
begin
  select membership.role into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_user_id is null or actor_role not in ('owner', 'dispatcher') then
    raise exception 'PROVIDER_LAUNCH_ACTIVE_STAFF_REQUIRED';
  end if;
  select * into latest_event
  from public.company_launch_authorization_events event
  where event.company_id = p_company_id
  order by event.version desc limit 1;
  return jsonb_build_object(
    'schemaVersion', 'storyops-provider-launch-state-v1',
    'companyId', p_company_id,
    'role', actor_role,
    'connections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', connection.id,
        'provider', connection.provider,
        'mode', connection.mode,
        'ownerEnabled', connection.owner_enabled,
        'environmentMode', connection.environment_mode,
        'environmentStatus', connection.environment_status,
        'environmentCheckedAt', connection.environment_checked_at,
        'environmentExpiresAt', connection.environment_expires_at,
        'environmentCapabilities', connection.environment_capabilities,
        'capabilities', connection.capabilities,
        'version', connection.version,
        'canActivateLive',
          connection.environment_mode = 'live'
          and connection.environment_status = 'healthy'
          and connection.environment_checked_at >= now() - interval '15 minutes'
          and connection.environment_checked_at <= now() + interval '1 minute'
          and connection.environment_expires_at > now(),
        'canActivateSandbox',
          connection.environment_mode = 'sandbox'
          and connection.environment_status = 'healthy'
          and connection.environment_checked_at >= now() - interval '15 minutes'
          and connection.environment_expires_at > now()
      ) order by connection.provider)
      from public.integration_connections connection
      where connection.company_id = p_company_id
    ), '[]'::jsonb),
    'schedulingGate', (
      select jsonb_build_object(
        'provider', result.provider,
        'capability', result.capability,
        'mode', result.environment_mode,
        'status', result.status,
        'checkedAt', result.checked_at,
        'expiresAt', result.expires_at,
        'current',
          result.environment_mode = 'live'
          and result.status = 'healthy'
          and result.checked_at >= now() - interval '15 minutes'
          and result.checked_at <= now() + interval '1 minute'
          and result.expires_at > now()
      )
      from public.integration_environment_probe_results result
      where result.company_id = p_company_id
        and result.provider = 'scheduling_evidence_gate'
        and result.capability = 'calendar_weather_route_booking_evidence'
      order by result.checked_at desc, result.recorded_at desc, result.id desc
      limit 1
    ),
    'launch', case when latest_event.id is null then jsonb_build_object(
      'version', 0,
      'status', 'not_authorized',
      'launchAuthorized', false
    ) else jsonb_build_object(
      'version', latest_event.version,
      'status', case
        when latest_event.action = 'authorize'
          and private.storyops_launch_authorization_effective(p_company_id)
        then 'authorized'
        when latest_event.action = 'authorize' then 'invalidated'
        else 'revoked'
      end,
      'launchAuthorized',
        latest_event.action = 'authorize'
        and private.storyops_launch_authorization_effective(p_company_id),
      'configurationRevision', latest_event.configuration_revision,
      'configurationHash', latest_event.configuration_hash,
      'baselineId', latest_event.baseline_id,
      'baselineHash', latest_event.baseline_hash,
      'providerSnapshotHash', latest_event.provider_snapshot_hash,
      'proofSnapshotHash', latest_event.proof_snapshot_hash,
      'reviewReference', latest_event.review_reference,
      'occurredAt', latest_event.occurred_at
    ) end,
    'serverTime', now()
  );
end;
$$;

revoke all on function public.get_storyops_provider_launch_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_storyops_provider_launch_state(uuid)
  to authenticated;

-- Provider fields embedded in Studio are request intent only. The original
-- validator now sees authoritative owner/environment/health evidence.
alter function public.validate_company_configuration(uuid, jsonb, text)
  rename to validate_company_configuration_before_provider_authority;

revoke all on function
  public.validate_company_configuration_before_provider_authority(uuid, jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function public.validate_company_configuration(
  p_company_id uuid,
  p_configuration jsonb,
  p_publication_mode text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_configuration jsonb := p_configuration;
  normalized_providers jsonb;
begin
  if jsonb_typeof(p_configuration #> '{integrations,providers}') = 'array' then
    select jsonb_agg(
      provider_config || jsonb_build_object(
        'environmentEnabled',
          connection.environment_mode = provider_config ->> 'requestedMode'
          and connection.environment_status = 'healthy'
          and connection.environment_checked_at >= now() - interval '15 minutes'
          and connection.environment_expires_at > now(),
        'ownerEnabled',
          connection.owner_enabled
          and connection.mode = provider_config ->> 'requestedMode',
        'health', case
          when connection.environment_status = 'healthy'
            and connection.environment_expires_at > now()
          then 'healthy'
          when connection.environment_status in ('degraded', 'down') then 'degraded'
          else 'blocked'
        end
      )
      order by provider_config ->> 'provider'
    )
    into normalized_providers
    from jsonb_array_elements(
      p_configuration #> '{integrations,providers}'
    ) as provider_entry(provider_config)
    left join public.integration_connections connection
      on connection.company_id = p_company_id
     and connection.provider = case
       when provider_config ->> 'provider' = 'storage'
       then 'signed_storage_targets'
       else provider_config ->> 'provider'
     end;
    normalized_configuration := jsonb_set(
      p_configuration,
      '{integrations,providers}',
      coalesce(normalized_providers, '[]'::jsonb),
      true
    );
  end if;
  return public.validate_company_configuration_before_provider_authority(
    p_company_id,
    normalized_configuration,
    p_publication_mode
  );
end;
$$;

revoke all on function public.validate_company_configuration(uuid, jsonb, text)
  from public, anon, service_role;
grant execute on function public.validate_company_configuration(uuid, jsonb, text)
  to authenticated;

-- Extend the baseline projection with the effective launch record without
-- rewriting immutable baseline history.
alter function public.get_company_operating_baseline_state(uuid)
  rename to get_company_operating_baseline_state_before_launch_authority;

revoke all on function
  public.get_company_operating_baseline_state_before_launch_authority(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_company_operating_baseline_state(
  p_company_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  result jsonb;
  launch_state jsonb;
begin
  result :=
    public.get_company_operating_baseline_state_before_launch_authority(
      p_company_id
    );
  if result is null then return null; end if;
  launch_state := public.get_storyops_provider_launch_state(p_company_id) -> 'launch';
  return result || jsonb_build_object(
    'launchAuthorized',
      coalesce((launch_state ->> 'launchAuthorized')::boolean, false),
    'launchVersion', coalesce((launch_state ->> 'version')::integer, 0),
    'launchStatus', coalesce(launch_state ->> 'status', 'not_authorized'),
    'launchProviderSnapshotHash', launch_state ->> 'providerSnapshotHash',
    'launchProofSnapshotHash', launch_state ->> 'proofSnapshotHash'
  );
end;
$$;

revoke all on function public.get_company_operating_baseline_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_company_operating_baseline_state(uuid)
  to authenticated;

comment on table public.integration_environment_probe_results is
  'Append-only, secret-safe provider+capability environment probe facts. A healthy row never changes owner activation.';
comment on table public.company_launch_authorization_events is
  'Immutable controlled-pilot authorize/revoke ledger bound to exact configuration, baseline, provider, and trusted proof snapshots.';
comment on function public.set_storyops_provider_activation(
  uuid, uuid, text, integer, text, text
) is
  'Finite owner-only provider activation command. Live activation requires a current trusted environment proof and invalidates any prior launch authorization.';
comment on function public.set_storyops_company_launch_authorization(
  uuid, uuid, integer, text, text, text
) is
  'Finite owner-only controlled-launch command. Authorization requires current authoritative providers, reviews, baseline, and trusted capability-bound proofs.';
comment on function public.assert_storyops_provider_invocation(
  uuid, text, text, text, text
) is
  'Service-only preflight for live provider calls. The current Edge deployment fingerprint must exact-match the owner-reviewed probe generation; recovery class does not require launch or active-company state.';
comment on function public.assert_storyops_launch_start(uuid, text) is
  'Service-only gate for inbound lead intake, customer contact, payment collection, and live scheduling starts.';
