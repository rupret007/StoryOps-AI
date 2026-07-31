-- Identity invitation provider authority.
--
-- Supabase Auth invitation delivery is an external customer-contact provider.
-- Deployment configuration, an authorization-grade external read, explicit
-- owner activation, a trusted canary, and controlled launch are independent
-- gates. Credentials and an Edge environment switch never authorize delivery.

alter table public.integration_connections
  drop constraint if exists integration_connections_provider_check;
alter table public.integration_connections
  add constraint integration_connections_provider_check
  check (provider in (
    'openai', 'twilio', 'email', 'supabase_auth', 'stripe',
    'google_calendar', 'maps', 'nws', 'vroom',
    'signed_storage_targets', 'quickbooks_export'
  ));

alter table public.integration_environment_probe_results
  drop constraint if exists
    integration_environment_probe_results_provider_check;
alter table public.integration_environment_probe_results
  add constraint integration_environment_probe_results_provider_check
  check (provider in (
    'openai', 'twilio', 'email', 'supabase_auth', 'stripe',
    'google_calendar', 'maps', 'nws', 'vroom',
    'signed_storage_targets', 'quickbooks_export',
    'scheduling_evidence_gate'
  ));

insert into public.integration_connections(
  company_id,
  provider,
  mode,
  status,
  configuration,
  capabilities
)
select
  company.id,
  'supabase_auth',
  'disabled',
  'disabled',
  '{}'::jsonb,
  '{}'::text[]
from public.companies company
on conflict (company_id, provider) do nothing;

create or replace function private.storyops_seed_identity_invitation_provider()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- The setup wrapper holds this private, transaction-bound capability while
  -- its V1.0 implementation verifies the original finite provider set. The
  -- wrapper adds Supabase Auth immediately after that verification and before
  -- returning, so the company is never externally observable without its
  -- identity-provider row.
  if exists (
    select 1
    from private.storyops_setup_capabilities capability
    where capability.backend_pid = pg_backend_pid()
      and capability.transaction_id = txid_current()
      and capability.company_id = new.id
  ) then
    return new;
  end if;
  insert into public.integration_connections(
    company_id,
    provider,
    mode,
    status,
    configuration,
    capabilities
  )
  values (
    new.id,
    'supabase_auth',
    'disabled',
    'disabled',
    '{}'::jsonb,
    '{}'::text[]
  )
  on conflict (company_id, provider) do nothing;
  return new;
end;
$$;

revoke all on function
  private.storyops_seed_identity_invitation_provider()
  from public, anon, authenticated, service_role;

create trigger storyops_identity_invitation_provider_seed
after insert on public.companies
for each row execute function
  private.storyops_seed_identity_invitation_provider();

-- Setup V1.0 predates the Supabase Auth provider and deliberately verifies its
-- original ten-provider set. Keep that immutable implementation, but seed the
-- eleventh provider within the same private setup capability and return the
-- current authoritative count. This also upgrades already-deployed databases
-- when migration 51 is applied.
create or replace function public.complete_storyops_setup(
  p_company_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_business_name text,
  p_owner_name text,
  p_home_postal_code text,
  p_timezone text,
  p_enabled_service_codes text[],
  p_policy_acknowledged boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  actor_user_id uuid := auth.uid();
  capability_token_value uuid := extensions.gen_random_uuid();
  disabled_integration_count integer;
  result jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
  then
    raise exception using message = 'STORYOPS_SETUP_AUTHENTICATION_REQUIRED';
  end if;
  insert into private.storyops_setup_capabilities(
    capability_token,
    backend_pid,
    transaction_id,
    company_id,
    actor_user_id
  )
  values (
    capability_token_value,
    pg_backend_pid(),
    txid_current(),
    p_company_id,
    actor_user_id
  );
  begin
    -- Migration 51 backfills this one system row into pre-created setup
    -- companies. V1.0 correctly rejects every integration as non-pristine, so
    -- remove only the byte-for-byte semantic seed while its setup capability
    -- is held. Any owner/provider modification makes the predicate fail and
    -- leaves V1.0's fail-closed administrative-migration error intact.
    delete from public.integration_connections connection
    using public.companies company
    where connection.company_id = p_company_id
      and connection.provider = 'supabase_auth'
      and company.id = connection.company_id
      and company.status = 'setup'
      and not coalesce(
        (company.settings ->> 'setupWizardCompleted')::boolean,
        false
      )
      and connection.mode = 'disabled'
      and connection.status = 'disabled'
      and connection.secret_reference is null
      and connection.configuration = '{}'::jsonb
      and cardinality(connection.capabilities) = 0
      and connection.last_checked_at is null
      and connection.last_error is null
      and connection.version = 1
      and not connection.owner_enabled
      and connection.environment_mode = 'disabled'
      and cardinality(connection.environment_capabilities) = 0
      and connection.environment_status = 'not_configured'
      and connection.environment_fingerprint is null
      and connection.environment_probe_run_id is null
      and connection.environment_checked_at is null
      and connection.environment_expires_at is null
      and connection.activated_by_user_id is null
      and connection.activated_at is null
      and connection.disabled_at is null
      and connection.activation_command_id is null
      and not exists (
        select 1
        from public.integration_environment_probe_results probe
        where probe.connection_id = connection.id
      );
    result := public.complete_storyops_setup_v1_0(
      p_company_id,
      p_command_id,
      p_request_hash,
      p_business_name,
      p_owner_name,
      p_home_postal_code,
      p_timezone,
      p_enabled_service_codes,
      p_policy_acknowledged
    );
    insert into public.integration_connections(
      company_id,
      provider,
      mode,
      status,
      configuration,
      capabilities
    )
    values (
      p_company_id,
      'supabase_auth',
      'disabled',
      'disabled',
      '{}'::jsonb,
      '{}'::text[]
    )
    on conflict (company_id, provider) do nothing;
    select count(*)::integer
    into disabled_integration_count
    from public.integration_connections connection
    where connection.company_id = p_company_id
      and connection.mode = 'disabled'
      and connection.status = 'disabled';
    result := jsonb_set(
      result,
      '{integrationsDisabled}',
      to_jsonb(disabled_integration_count),
      true
    );
  exception when others then
    delete from private.storyops_setup_capabilities
    where capability_token = capability_token_value;
    raise;
  end;
  delete from private.storyops_setup_capabilities
  where capability_token = capability_token_value;
  return result;
end;
$$;

comment on function public.complete_storyops_setup(
  uuid, uuid, text, text, text, text, text, text[], boolean
) is
  'Completes fail-closed setup and atomically seeds the disabled Supabase Auth invitation provider added by migration 51.';

create or replace function
  public.record_storyops_identity_invitation_environment_probe(
    p_company_id uuid,
    p_actor_user_id uuid,
    p_probe_run_id uuid,
    p_deployment_fingerprint text,
    p_result jsonb
  )
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  connection_row public.integration_connections%rowtype;
  checked_value timestamptz;
  latency_value integer;
  required_value text[];
  mode_value text;
  status_value text;
  material_provider_change boolean;
  provider_was_owner_enabled boolean;
  normalized jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'IDENTITY_INVITATION_PROBE_SERVICE_ROLE_REQUIRED';
  end if;
  perform private.assert_storyops_edge_actor(
    p_company_id,
    p_actor_user_id,
    array['owner', 'dispatcher']
  );
  if not public.lock_storyops_active_company(p_company_id) then
    raise exception 'IDENTITY_INVITATION_PROBE_ACTIVE_COMPANY_REQUIRED';
  end if;
  if p_probe_run_id is null
    or p_deployment_fingerprint !~ '^[a-f0-9]{64}$'
    or p_result is null
    or jsonb_typeof(p_result) is distinct from 'object'
    or not (
      p_result ?& array[
        'provider', 'capability', 'mode', 'status', 'checkedAt',
        'latencyMs', 'requiredEnvironment'
      ]
    )
    or p_result - array[
      'provider', 'capability', 'mode', 'status', 'checkedAt',
      'latencyMs', 'requiredEnvironment'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(p_result -> 'requiredEnvironment')
      is distinct from 'array'
  then
    raise exception 'IDENTITY_INVITATION_PROBE_INVALID_REQUEST';
  end if;

  begin
    checked_value := (p_result ->> 'checkedAt')::timestamptz;
    latency_value := (p_result ->> 'latencyMs')::integer;
    select coalesce(array_agg(setting order by setting), '{}'::text[])
    into required_value
    from jsonb_array_elements_text(
      p_result -> 'requiredEnvironment'
    ) setting;
  exception when others then
    raise exception 'IDENTITY_INVITATION_PROBE_INVALID_RESULT';
  end;

  mode_value := p_result ->> 'mode';
  status_value := p_result ->> 'status';
  if p_result ->> 'provider' <> 'supabase_auth'
    or p_result ->> 'capability' <> 'identity_invitation'
    or mode_value not in ('disabled', 'sandbox', 'live')
    or status_value not in (
      'healthy', 'not_configured', 'degraded', 'down'
    )
    or checked_value < now() - interval '5 minutes'
    or checked_value > now() + interval '1 minute'
    or latency_value not between 0 and 120000
    or not (
      required_value @> array[
        'STORYOPS_IDENTITY_INVITE_LIVE_ENABLED',
        'STORYOPS_IDENTITY_INVITE_MODE'
      ]::text[]
    )
    or not (
      required_value <@ array[
        'STORYOPS_IDENTITY_INVITE_LIVE_ENABLED',
        'STORYOPS_IDENTITY_INVITE_MODE',
        'STORYOPS_IDENTITY_INVITE_REDIRECT_URL',
        'SUPABASE_SERVICE_ROLE_KEY',
        'SUPABASE_URL'
      ]::text[]
    )
    or cardinality(required_value) <> (
      select count(distinct setting)
      from unnest(required_value) setting
    )
    or (
      mode_value = 'disabled'
      and status_value <> 'not_configured'
    )
    or (
      mode_value = 'sandbox'
      and status_value <> 'healthy'
    )
    or (
      mode_value in ('sandbox', 'live')
      and required_value is distinct from array[
        'STORYOPS_IDENTITY_INVITE_LIVE_ENABLED',
        'STORYOPS_IDENTITY_INVITE_MODE',
        'STORYOPS_IDENTITY_INVITE_REDIRECT_URL',
        'SUPABASE_SERVICE_ROLE_KEY',
        'SUPABASE_URL'
      ]::text[]
    )
  then
    raise exception 'IDENTITY_INVITATION_PROBE_INVALID_RESULT';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-provider-activation:' || p_company_id::text
      || ':supabase_auth',
    0
  ));
  select *
  into connection_row
  from public.integration_connections connection
  where connection.company_id = p_company_id
    and connection.provider = 'supabase_auth'
  for update;
  if connection_row.id is null then
    raise exception 'IDENTITY_INVITATION_PROBE_CONNECTION_MISSING';
  end if;

  insert into public.integration_environment_probe_results(
    company_id,
    connection_id,
    probe_run_id,
    provider,
    capability,
    environment_mode,
    status,
    result_code,
    deployment_fingerprint,
    required_settings,
    latency_ms,
    checked_at,
    expires_at,
    recorded_by_user_id
  )
  values (
    p_company_id,
    connection_row.id,
    p_probe_run_id,
    'supabase_auth',
    'identity_invitation',
    mode_value,
    status_value,
    status_value,
    p_deployment_fingerprint,
    required_value,
    latency_value,
    checked_value,
    checked_value + interval '15 minutes',
    p_actor_user_id
  );

  material_provider_change :=
    connection_row.environment_mode <> mode_value
    or connection_row.environment_fingerprint is distinct from
      p_deployment_fingerprint
    or connection_row.environment_capabilities is distinct from
      array['identity_invitation']::text[];
  provider_was_owner_enabled := connection_row.owner_enabled;

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
    environment_mode = mode_value,
    environment_fingerprint = p_deployment_fingerprint,
    environment_probe_run_id = p_probe_run_id,
    environment_capabilities = array['identity_invitation']::text[],
    environment_checked_at = checked_value,
    environment_expires_at = checked_value + interval '15 minutes',
    environment_status = status_value,
    status = case
      when material_provider_change or not connection.owner_enabled
        then 'disabled'
      when status_value = 'healthy' then 'healthy'
      when status_value in ('degraded', 'down') then 'degraded'
      else 'misconfigured'
    end,
    last_checked_at = checked_value,
    last_error = case
      when status_value = 'healthy' then null
      else 'IDENTITY_INVITATION_ENVIRONMENT_PROBE_NOT_HEALTHY'
    end,
    configuration = jsonb_build_object(
      'source', 'trusted_environment_probe',
      'probeRunId', p_probe_run_id
    ),
    secret_reference = case
      when status_value = 'healthy'
        and mode_value in ('live', 'sandbox')
      then 'deployment-env/supabase_auth/'
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
  where connection.id = connection_row.id
  returning * into connection_row;

  if material_provider_change and provider_was_owner_enabled then
    insert into public.audit_events(
      company_id,
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      after_data,
      request_id,
      retention_class,
      retain_until
    )
    values (
      p_company_id,
      'system',
      'identity-invitation-environment-probe',
      'integration.provider_activation_invalidated',
      'integration_connection',
      connection_row.id,
      jsonb_build_object(
        'provider', 'supabase_auth',
        'capability', 'identity_invitation',
        'reasonCode', 'MATERIAL_ENVIRONMENT_GENERATION_CHANGED'
      ),
      p_probe_run_id::text,
      'audit',
      now() + interval '7 years'
    );
  end if;

  if (material_provider_change and provider_was_owner_enabled)
    or (
      connection_row.owner_enabled
      and (
        connection_row.environment_status <> 'healthy'
        or connection_row.environment_expires_at <= now()
        or connection_row.environment_mode <> connection_row.mode
        or connection_row.environment_capabilities
          is distinct from connection_row.capabilities
      )
    )
  then
    perform private.storyops_append_system_launch_revoke(
      p_company_id,
      'identity-invitation-environment-proof-changed'
    );
  end if;

  normalized := jsonb_build_object(
    'provider', 'supabase_auth',
    'capability', 'identity_invitation',
    'mode', mode_value,
    'status', status_value,
    'checkedAt', checked_value,
    'expiresAt', checked_value + interval '15 minutes',
    'latencyMs', latency_value,
    'probeRunId', p_probe_run_id
  );
  insert into public.audit_events(
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data,
    request_id,
    retention_class,
    retain_until
  )
  values (
    p_company_id,
    'user',
    p_actor_user_id::text,
    'integration.identity_invitation_environment_probe_recorded',
    'integration_probe_run',
    p_probe_run_id,
    jsonb_build_object(
      'probeRunId', p_probe_run_id,
      'provider', 'supabase_auth',
      'capability', 'identity_invitation',
      'mode', mode_value,
      'status', status_value,
      'deploymentFingerprintPrefix',
        left(p_deployment_fingerprint, 12)
    ),
    p_probe_run_id::text,
    'audit',
    now() + interval '7 years'
  );

  return jsonb_build_object(
    'schemaVersion', 'storyops-provider-probe-receipt-v1',
    'companyId', p_company_id,
    'probeRunId', p_probe_run_id,
    'providers', jsonb_build_array(normalized),
    'serverTime', now()
  );
end;
$$;

revoke all on function
  public.record_storyops_identity_invitation_environment_probe(
    uuid, uuid, uuid, text, jsonb
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.record_storyops_identity_invitation_environment_probe(
    uuid, uuid, uuid, text, jsonb
  )
  to service_role;

comment on function
  public.record_storyops_identity_invitation_environment_probe(
    uuid, uuid, uuid, text, jsonb
  ) is
  'Persists one exact, secret-safe Supabase Auth invitation environment proof; service role only.';

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
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
  then
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
      'openai', 'twilio', 'email', 'supabase_auth', 'stripe',
      'google_calendar', 'maps', 'nws', 'vroom',
      'signed_storage_targets', 'quickbooks_export'
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
    company_id,
    scope,
    key,
    request_hash,
    expires_at
  )
  values (
    p_company_id,
    'provider-activation-v1',
    p_command_id::text,
    effective_hash,
    now() + interval '90 days'
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
      return reservation.response
        || jsonb_build_object('replayed', true);
    end if;
    raise exception 'PROVIDER_ACTIVATION_COMMAND_IN_PROGRESS';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-provider-activation:' || p_company_id::text
      || ':' || provider_value,
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
  if p_target_mode <> 'disabled'
    and not public.lock_storyops_active_company(p_company_id)
  then
    raise exception 'PROVIDER_ACTIVATION_COMPANY_UNAVAILABLE';
  end if;
  if p_target_mode <> 'disabled' and (
    connection_row.environment_mode <> p_target_mode
    or connection_row.environment_status <> 'healthy'
    or connection_row.environment_fingerprint is null
    or connection_row.environment_probe_run_id is null
    or cardinality(connection_row.environment_capabilities) < 1
    or connection_row.environment_checked_at
      < now() - interval '15 minutes'
    or connection_row.environment_checked_at
      > now() + interval '1 minute'
    or connection_row.environment_expires_at <= now()
    or exists (
      select 1
      from unnest(
        connection_row.environment_capabilities
      ) capability
      where not exists (
        select 1
        from public.integration_environment_probe_results result
        where result.connection_id = connection_row.id
          and result.probe_run_id =
            connection_row.environment_probe_run_id
          and result.deployment_fingerprint =
            connection_row.environment_fingerprint
          and result.capability = capability
          and result.environment_mode = p_target_mode
          and result.status = 'healthy'
          and result.expires_at > now()
      )
    )
  ) then
    raise exception
      'PROVIDER_ACTIVATION_CURRENT_ENVIRONMENT_PROOF_REQUIRED';
  end if;
  if provider_value = 'supabase_auth'
    and p_target_mode <> 'disabled'
    and connection_row.environment_capabilities
      is distinct from array['identity_invitation']::text[]
  then
    raise exception
      'PROVIDER_ACTIVATION_CURRENT_ENVIRONMENT_PROOF_REQUIRED';
  end if;

  update public.integration_connections connection
  set
    mode = p_target_mode,
    owner_enabled = p_target_mode <> 'disabled',
    status = case
      when p_target_mode = 'disabled' then 'disabled'
      when connection_row.environment_status = 'healthy'
        then 'healthy'
      when connection_row.environment_status in ('degraded', 'down')
        then 'degraded'
      else 'misconfigured'
    end,
    capabilities = case
      when p_target_mode = 'disabled' then connection.capabilities
      else connection.environment_capabilities
    end,
    activated_by_user_id = case
      when p_target_mode = 'disabled'
        then connection.activated_by_user_id
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
  current_launch_version :=
    private.storyops_current_launch_version(p_company_id);

  select *
  into connection_row
  from public.integration_connections connection
  where connection.id = connection_row.id;
  response_value := jsonb_build_object(
    'schemaVersion',
      'storyops-provider-activation-receipt-v1',
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
  set
    status = 'completed',
    response = response_value,
    completed_at = now(),
    updated_at = now()
  where id = reservation_id
    and status = 'in_progress';
  if not found then
    raise exception 'PROVIDER_ACTIVATION_RESERVATION_LOST';
  end if;
  insert into public.audit_events(
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data,
    request_id,
    retention_class,
    retain_until
  )
  values (
    p_company_id,
    'user',
    actor_user_id::text,
    case
      when p_target_mode = 'disabled'
        then 'integration.provider_disabled'
      else 'integration.provider_activated'
    end,
    'integration_connection',
    connection_row.id,
    response_value - array['companyId', 'serverTime']::text[],
    p_command_id::text,
    'audit',
    now() + interval '7 years'
  );
  perform set_config(
    'request.jwt.claim.role',
    original_claim_role,
    true
  );
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

comment on function public.set_storyops_provider_activation(
  uuid, uuid, text, integer, text, text
) is
  'Owner-only, idempotent activation boundary for current provider environment proof, including Supabase Auth invitation delivery.';

create or replace function
  private.storyops_live_configuration_matches_provider_authority(
    p_company_id uuid,
    p_configuration jsonb
  )
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce((
    jsonb_typeof(
      p_configuration #> '{integrations,providers}'
    ) = 'array'
    and not exists (
      select 1
      from public.integration_connections connection
      where connection.company_id = p_company_id
        and connection.owner_enabled
        -- Supabase Auth is an internal identity-delivery control plane,
        -- not a user-authored business integration configuration.
        and connection.provider <> 'supabase_auth'
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
            and connection.environment_checked_at
              >= now() - interval '15 minutes'
            and connection.environment_checked_at
              <= now() + interval '1 minute'
            and connection.environment_expires_at > now()
        )
    )
  ), false)
$$;

revoke all on function
  private.storyops_live_configuration_matches_provider_authority(
    uuid, jsonb
  )
  from public, anon, authenticated, service_role;

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
  provider_value text :=
    private.storyops_canonical_provider(p_provider);
  connection_row public.integration_connections%rowtype;
  launch_required boolean :=
    p_operation_class = 'launch_start';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'PROVIDER_INVOCATION_SERVICE_ROLE_REQUIRED';
  end if;
  if provider_value not in (
    'openai', 'twilio', 'email', 'supabase_auth', 'stripe',
    'google_calendar', 'maps', 'nws', 'vroom',
    'signed_storage_targets', 'quickbooks_export'
  )
    or p_capability !~ '^[a-z][a-z0-9_]{2,79}$'
    or p_operation_class not in (
      'internal', 'launch_start', 'recovery'
    )
    or p_deployment_fingerprint !~ '^[a-f0-9]{64}$'
    or (
      provider_value = 'supabase_auth'
      and p_capability <> 'identity_invitation'
    )
  then
    raise exception 'PROVIDER_INVOCATION_INVALID_REQUEST';
  end if;

  select *
  into connection_row
  from public.integration_connections connection
  where connection.company_id = p_company_id
    and connection.provider = provider_value;
  if connection_row.id is null
    or connection_row.environment_mode <> 'live'
    or connection_row.environment_status <> 'healthy'
    or connection_row.environment_checked_at
      < now() - interval '15 minutes'
    or connection_row.environment_checked_at
      > now() + interval '1 minute'
    or connection_row.environment_expires_at <= now()
    or connection_row.environment_fingerprint
      <> p_deployment_fingerprint
    or not (
      p_capability = any(
        connection_row.environment_capabilities
      )
    )
    or not exists (
      select 1
      from public.integration_environment_probe_results result
      where result.connection_id = connection_row.id
        and result.probe_run_id =
          connection_row.environment_probe_run_id
        and result.deployment_fingerprint =
          connection_row.environment_fingerprint
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
    or not (
      p_capability = any(connection_row.capabilities)
    )
  ) then
    raise exception 'PROVIDER_INVOCATION_NOT_AUTHORIZED';
  end if;
  if p_operation_class <> 'recovery'
    and not exists (
      select 1
      from public.companies company
      where company.id = p_company_id
        and company.status = 'active'
    )
  then
    raise exception 'PROVIDER_INVOCATION_COMPANY_NOT_ACTIVE';
  end if;
  if launch_required
    and not private.storyops_launch_authorization_effective(
      p_company_id
    )
  then
    raise exception
      'PROVIDER_INVOCATION_LAUNCH_NOT_AUTHORIZED';
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

revoke all on function public.assert_storyops_provider_invocation(
  uuid, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.assert_storyops_provider_invocation(
  uuid, text, text, text, text
) to service_role;

comment on function public.assert_storyops_provider_invocation(
  uuid, text, text, text, text
) is
  'Service-role assertion for exact live provider authority; Supabase Auth invitation use requires current environment and owner authority plus controlled launch.';

create or replace function
  public.complete_storyops_provider_canary_verification(
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
    raise exception
      'TRUSTED_VERIFICATION_SERVICE_ROLE_REQUIRED';
  end if;
  if p_deployment_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception
      'TRUSTED_VERIFICATION_DEPLOYMENT_FINGERPRINT_INVALID';
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
    return private.storyops_verifier_run_response(
      run_row,
      false,
      true
    );
  end if;
  if run_row.kind <> 'provider_canary'
    or run_row.status <> 'executing'
  then
    raise exception
      'TRUSTED_VERIFICATION_PROVIDER_RUN_REQUIRED';
  end if;
  if not public.lock_storyops_active_company(
    run_row.company_id
  ) then
    raise exception
      'TRUSTED_VERIFICATION_ACTIVE_COMPANY_REQUIRED';
  end if;

  expected_operation := case
    when run_row.provider = 'openai'
      and run_row.capability in (
        'structured_ai', 'photo_analysis'
      )
      then 'openai.model.retrieve'
    when run_row.provider = 'twilio'
      and run_row.capability = 'sms_voice'
      then 'twilio.account.retrieve'
    when run_row.provider = 'email'
      and run_row.capability = 'email'
      then 'email.health.retrieve'
    when run_row.provider = 'supabase_auth'
      and run_row.capability = 'identity_invitation'
      then 'supabase_auth.admin_directory.retrieve'
    when run_row.provider = 'stripe'
      and run_row.capability = 'payments'
      then 'stripe.balance.retrieve'
    when run_row.provider = 'google_calendar'
      and run_row.capability = 'calendar'
      then 'google_calendar.list.retrieve'
    when run_row.provider = 'maps'
      and run_row.capability = 'geocoding'
      then 'google_maps.geocode.retrieve'
    when run_row.provider = 'nws'
      and run_row.capability = 'weather'
      then 'nws.points.retrieve'
    when run_row.provider = 'vroom'
      and run_row.capability = 'routing'
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
    or p_probe_evidence is null
    or jsonb_typeof(p_probe_evidence)
      is distinct from 'object'
    or not (
      p_probe_evidence ?& array[
        'schemaVersion', 'basis', 'operation', 'responseDigest'
      ]
    )
    or exists (
      select 1
      from jsonb_object_keys(
        p_probe_evidence
      ) keys(key_name)
      where key_name <> all(array[
        'schemaVersion', 'basis', 'operation', 'responseDigest'
      ])
    )
    or p_probe_evidence ->> 'schemaVersion'
      <> 'storyops-integration-probe-evidence-v1'
    or p_probe_evidence ->> 'basis' <> expected_basis
    or p_probe_evidence ->> 'operation'
      <> expected_operation
    or p_probe_evidence ->> 'responseDigest'
      !~ '^[a-f0-9]{64}$'
  then
    raise exception
      'TRUSTED_VERIFICATION_PROBE_EVIDENCE_INVALID';
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
      and connection.environment_fingerprint =
        p_deployment_fingerprint
      and connection.environment_checked_at
        >= clock_timestamp() - interval '15 minutes'
      and connection.environment_checked_at
        <= clock_timestamp() + interval '1 minute'
      and connection.environment_expires_at
        > clock_timestamp()
      and run_row.capability = any(connection.capabilities)
      and exists (
        select 1
        from public.integration_environment_probe_results result
        where result.connection_id = connection.id
          and result.probe_run_id =
            connection.environment_probe_run_id
          and result.deployment_fingerprint =
            connection.environment_fingerprint
          and result.capability = run_row.capability
          and result.environment_mode = 'live'
          and result.status = 'healthy'
          and result.expires_at > clock_timestamp()
      )
  ) then
    raise exception
      'TRUSTED_VERIFICATION_PROVIDER_BINDING_CHANGED';
  end if;

  update public.trusted_pilot_verification_runs
  set
    status = 'verified',
    evidence_basis = expected_basis,
    external_operation = expected_operation,
    evidence_reference = 'verify-' || id::text,
    artifact_sha256 = encode(
      extensions.digest(p_probe_evidence::text, 'sha256'),
      'hex'
    ),
    observed_at = clock_timestamp(),
    expires_at = clock_timestamp() + interval '7 days',
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = p_run_id
  returning * into run_row;
  return private.storyops_verifier_run_response(
    run_row,
    false,
    false
  );
end;
$$;

revoke all on function
  public.complete_storyops_provider_canary_verification(
    uuid, jsonb, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.complete_storyops_provider_canary_verification(
    uuid, jsonb, text
  )
  to service_role;

comment on function
  public.complete_storyops_provider_canary_verification(
    uuid, jsonb, text
  ) is
  'Completes a reserved provider canary from exact current external-read evidence, including Supabase Auth admin-directory read evidence.';

revoke all on function public.authorize_storyops_identity_invite(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
drop function public.authorize_storyops_identity_invite(
  uuid, uuid, uuid, text
);

create function public.authorize_storyops_identity_invite(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_deployment_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  command_row public.identity_provisioning_commands%rowtype;
  attempt_already_authorized boolean;
begin
  perform private.lock_storyops_identity_owner(
    p_company_id,
    p_actor_user_id
  );
  select *
  into command_row
  from public.identity_provisioning_commands command
  where command.company_id = p_company_id
    and command.command_id = p_command_id
  for update;
  if not found
    or command_row.actor_user_id <> p_actor_user_id
    or command_row.action <> 'invite'
    or command_row.request_hash <> p_request_hash
    or command_row.status <> 'pending'
    or p_deployment_fingerprint !~ '^[a-f0-9]{64}$'
  then
    raise exception using
      message = 'IDENTITY_INVITE_NOT_AUTHORIZED';
  end if;

  -- Match provider mutation lock order, then hold launch authority through
  -- the durable invitation-attempt marker. A concurrent provider disable,
  -- health generation change, launch revocation, or company pause either
  -- completes first and blocks this marker or waits until it is committed.
  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-provider-activation:' || p_company_id::text
      || ':supabase_auth',
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-launch-authorization:' || p_company_id::text,
    0
  ));
  perform public.assert_storyops_provider_invocation(
    p_company_id,
    'supabase_auth',
    'identity_invitation',
    'launch_start',
    p_deployment_fingerprint
  );
  perform public.assert_storyops_launch_start(
    p_company_id,
    'customer_contact'
  );

  attempt_already_authorized :=
    command_row.invite_attempt_authorized_at is not null;
  -- This remains the final database operation before the Admin API call.
  -- Re-lock the active owner after waiting for provider/launch authority.
  perform private.lock_storyops_identity_owner(
    p_company_id,
    p_actor_user_id
  );
  update public.identity_provisioning_commands
  set invite_attempt_authorized_at = coalesce(
    invite_attempt_authorized_at,
    clock_timestamp()
  )
  where id = command_row.id
  returning * into command_row;

  return jsonb_build_object(
    'authorized', true,
    'attemptAlreadyAuthorized', attempt_already_authorized,
    'companyId', p_company_id,
    'commandId', p_command_id,
    'requestHash', p_request_hash,
    'email', command_row.normalized_email,
    'role', command_row.target_role
  );
end;
$$;

revoke all on function public.authorize_storyops_identity_invite(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.authorize_storyops_identity_invite(
  uuid, uuid, uuid, text, text
) to service_role;

comment on function public.authorize_storyops_identity_invite(
  uuid, uuid, uuid, text, text
) is
  'Final durable invitation-attempt marker; reasserts the exact deployment-bound Supabase Auth provider under its mutation lock and requires effective customer-contact launch authority.';
