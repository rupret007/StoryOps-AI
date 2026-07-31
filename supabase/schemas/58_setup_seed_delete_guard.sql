-- The migration-51 setup adapter may remove only the exact untouched
-- Supabase Auth system seed while its private, transaction-bound setup
-- capability is held. Every other destructive delete still consumes an exact
-- owner approval through the original boundary.

create or replace function public.require_exact_delete_approval()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  approval_id_value uuid;
  current_actor_user_id uuid := auth.uid();
  exact_payload jsonb := jsonb_build_object(
    'action', 'delete',
    'entityType', tg_table_name,
    'entityId', old.id
  );
begin
  if current_actor_user_id is null or pg_trigger_depth() > 1 then
    return old;
  end if;

  if tg_table_name = 'integration_connections'
    and exists (
      select 1
      from public.integration_connections connection
      join public.companies company
        on company.id = connection.company_id
       and company.status = 'setup'
      join private.storyops_setup_capabilities capability
        on capability.company_id = connection.company_id
       and capability.backend_pid = pg_backend_pid()
       and capability.transaction_id = txid_current()
       and capability.actor_user_id = current_actor_user_id
      where connection.id = old.id
        and connection.provider = 'supabase_auth'
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
        )
    )
  then
    return old;
  end if;

  select approval.id
  into approval_id_value
  from public.approval_requests approval
  where approval.company_id = old.company_id
    and approval.reason = 'destructive_change'
    and approval.status = 'approved'
    and approval.entity_type = tg_table_name
    and approval.entity_id = old.id
    and approval.action_type = 'delete'
    and approval.action_payload -> 'exactPayload' = exact_payload
    and approval.consumed_at is null
    and (approval.expires_at is null or approval.expires_at > now())
  order by approval.decided_at
  for update skip locked
  limit 1;

  if approval_id_value is null then
    raise exception 'Exact owner approval is required to delete %.%',
      tg_table_name,
      old.id;
  end if;

  perform private.authorize_storyops_approval_consumption(
    old.company_id,
    approval_id_value
  );
  update public.approval_requests
  set consumed_at = now(),
      execution_receipt = jsonb_build_object(
        'action', 'delete',
        'entityType', tg_table_name,
        'entityId', old.id,
        'executedBy', current_actor_user_id,
        'executedAt', now()
      ),
      updated_at = now(),
      version = version + 1
  where id = approval_id_value;

  return old;
end;
$$;

revoke all on function public.require_exact_delete_approval()
  from public, anon, authenticated, service_role;

comment on function public.require_exact_delete_approval() is
  'Exact owner-approval delete fence, with one transaction-bound setup-compatibility exception for an untouched, probe-free Supabase Auth system seed.';
