-- Pausing a company is an operational kill switch, not a presentation flag.
-- Authenticated users keep read access needed for recovery and owner review, but
-- every tenant-table mutation is rejected until an owner explicitly reactivates
-- the company row. Trusted service-role reconciliation remains available so an
-- already accepted provider event is never discarded merely because operations
-- were paused.

create or replace function public.lock_storyops_active_company(target_company_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  perform 1
  from public.companies company
  where company.id = target_company_id
    and company.status = 'active'
  for share;
  return found;
end;
$$;

revoke all on function public.lock_storyops_active_company(uuid) from public;
revoke all on function public.lock_storyops_active_company(uuid)
  from anon, authenticated, service_role;
grant execute on function public.lock_storyops_active_company(uuid)
  to authenticated, service_role;

create table private.storyops_setup_capabilities (
  capability_token uuid primary key,
  backend_pid integer not null,
  transaction_id bigint not null,
  company_id uuid not null,
  actor_user_id uuid not null,
  created_at timestamptz not null default now(),
  unique (backend_pid, transaction_id)
);
revoke all on table private.storyops_setup_capabilities
  from public, anon, authenticated, service_role;

-- Setup, configuration publication, and the one-time operating baseline are
-- finite reviewed commands that legitimately populate tenant rows while the
-- company is still in `setup`. Their wrappers hold an unforgeable capability
-- in a private table for only the nested SECURITY DEFINER call. The generic
-- trigger recognizes that exact backend/transaction/company/actor tuple only
-- while the company remains in setup status.
alter function public.complete_storyops_setup(
  uuid, uuid, text, text, text, text, text, text[], boolean
) rename to complete_storyops_setup_v1_0;
revoke all on function public.complete_storyops_setup_v1_0(
  uuid, uuid, text, text, text, text, text, text[], boolean
) from public, anon, authenticated, service_role;

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

alter function public.save_company_configuration_draft(
  uuid, uuid, integer, jsonb, text
) rename to save_company_configuration_draft_v1_0;
revoke all on function public.save_company_configuration_draft_v1_0(
  uuid, uuid, integer, jsonb, text
) from public, anon, authenticated, service_role;

create or replace function public.save_company_configuration_draft(
  p_company_id uuid,
  p_command_id uuid,
  p_expected_revision integer,
  p_configuration jsonb,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  actor_user_id uuid := auth.uid();
  capability_token_value uuid := extensions.gen_random_uuid();
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
    result := public.save_company_configuration_draft_v1_0(
      p_company_id,
      p_command_id,
      p_expected_revision,
      p_configuration,
      p_request_hash
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

alter function public.publish_company_configuration(
  uuid, uuid, integer, text, text, text
) rename to publish_company_configuration_v1_0;
revoke all on function public.publish_company_configuration_v1_0(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated, service_role;

create or replace function public.publish_company_configuration(
  p_company_id uuid,
  p_command_id uuid,
  p_expected_revision integer,
  p_publication_mode text,
  p_review_reference text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  actor_user_id uuid := auth.uid();
  capability_token_value uuid := extensions.gen_random_uuid();
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
    result := public.publish_company_configuration_v1_0(
      p_company_id,
      p_command_id,
      p_expected_revision,
      p_publication_mode,
      p_review_reference,
      p_request_hash
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

alter function public.publish_company_operating_baseline(
  uuid, uuid, integer, text, text
) rename to publish_company_operating_baseline_v1_0;
revoke all on function public.publish_company_operating_baseline_v1_0(
  uuid, uuid, integer, text, text
) from public, anon, authenticated, service_role;

create or replace function public.publish_company_operating_baseline(
  p_company_id uuid,
  p_command_id uuid,
  p_configuration_revision integer,
  p_review_reference text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  actor_user_id uuid := auth.uid();
  capability_token_value uuid := extensions.gen_random_uuid();
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
    result := public.publish_company_operating_baseline_v1_0(
      p_company_id,
      p_command_id,
      p_configuration_revision,
      p_review_reference,
      p_request_hash
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

revoke all on function public.complete_storyops_setup(
  uuid, uuid, text, text, text, text, text, text[], boolean
) from public, anon, authenticated, service_role;
grant execute on function public.complete_storyops_setup(
  uuid, uuid, text, text, text, text, text, text[], boolean
) to authenticated;
revoke all on function public.save_company_configuration_draft(
  uuid, uuid, integer, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.save_company_configuration_draft(
  uuid, uuid, integer, jsonb, text
) to authenticated;
revoke all on function public.publish_company_configuration(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.publish_company_configuration(
  uuid, uuid, integer, text, text, text
) to authenticated;
revoke all on function public.publish_company_operating_baseline(
  uuid, uuid, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.publish_company_operating_baseline(
  uuid, uuid, integer, text, text
) to authenticated;

create or replace function public.assert_active_company_for_authenticated_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  claimed_role text := auth.role();
  old_row jsonb := case
    when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old)
    else '{}'::jsonb
  end;
  new_row jsonb := case
    when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new)
    else '{}'::jsonb
  end;
  old_company_id uuid;
  new_company_id uuid;
  target_company_id uuid;
  service_requires_active boolean := false;
  idempotency_scope text;
begin
  old_company_id := nullif(old_row ->> 'company_id', '')::uuid;
  new_company_id := nullif(new_row ->> 'company_id', '')::uuid;

  -- Migrations and backup/restore do not operate with request JWT claims.
  if claimed_role is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if claimed_role not in ('authenticated', 'service_role') then
    raise exception using
      errcode = '42501',
      message = 'STORYOPS_AUTHENTICATED_MUTATION_REQUIRED';
  end if;

  -- A tenant row never changes companies through an application or provider
  -- boundary. Besides preventing a paused-A -> active-B bypass, immutability
  -- removes reverse lock-order deadlocks for cross-company updates.
  if tg_op = 'UPDATE'
    and old_company_id is distinct from new_company_id
  then
    raise exception using
      errcode = '42501',
      message = 'STORYOPS_COMPANY_SCOPE_IMMUTABLE';
  end if;

  target_company_id := case
    when tg_op = 'INSERT' then new_company_id
    else old_company_id
  end;

  if target_company_id is null then
    raise exception using
      errcode = '42501',
      message = 'STORYOPS_COMPANY_SCOPE_REQUIRED';
  end if;

  if claimed_role = 'authenticated'
    and exists (
      select 1
      from private.storyops_setup_capabilities capability
      join public.companies company
        on company.id = capability.company_id
       and company.status = 'setup'
      where capability.backend_pid = pg_backend_pid()
        and capability.transaction_id = txid_current()
        and capability.company_id = target_company_id
        and capability.actor_user_id = auth.uid()
    )
  then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- service_role has no generic table ACLs and reaches these rows only through
  -- finite SECURITY DEFINER RPCs. New user-caused work is gated at its durable
  -- reservation or exact pre-provider transition. Provider confirmations,
  -- webhook reconciliation, failure recording, retention, and orphan cleanup
  -- intentionally remain available while paused so accepted external truth is
  -- never lost.
  if claimed_role = 'service_role' then
    idempotency_scope := coalesce(
      new_row ->> 'scope',
      old_row ->> 'scope'
    );

    service_requires_active := (
      tg_table_name = 'idempotency_keys'
      and (
        (
          tg_op = 'INSERT'
          and idempotency_scope in (
            'deposit-checkout-v1',
            'edge:ai-office',
            'edge:photo-analyze',
            'field-media-finalize-v1',
            'golden-path-booking-v2',
            'golden-path-command-v1',
            'invoice-checkout-v1',
            'post-service-action-v1',
            'priced-estimate-v1',
            'scope-photo-measurement-v1',
            'scope-photo-request-v1',
            'scope-photo-review-v1',
            'workspace-command-v1'
          )
        )
        or (
          tg_op = 'UPDATE'
          and new_row ->> 'status' = 'in_progress'
          and old_row ->> 'status' is distinct from 'in_progress'
          and idempotency_scope in (
            'deposit-checkout-v1',
            'edge:ai-office',
            'edge:photo-analyze',
            'field-media-finalize-v1',
            'golden-path-booking-v2',
            'golden-path-command-v1',
            'invoice-checkout-v1',
            'post-service-action-v1',
            'priced-estimate-v1',
            'scope-photo-measurement-v1',
            'scope-photo-request-v1',
            'scope-photo-review-v1',
            'workspace-command-v1'
          )
        )
      )
    ) or (
      tg_table_name = 'scheduling_calendar_booking_attempts'
      and (
        (
          tg_op = 'INSERT'
          and new_row ->> 'status' = 'prepared'
        )
        or (
          tg_op = 'UPDATE'
          and old_row ->> 'status' = 'prepared'
          and new_row ->> 'status' = 'provider_unknown'
          and nullif(new_row ->> 'provider_call_started_at', '') is not null
        )
      )
    ) or (
      tg_table_name = 'automation_runs'
      and coalesce(
        new_row ->> 'automation_key',
        old_row ->> 'automation_key'
      ) like 'ai-office:%'
      and (
        (
          tg_op = 'INSERT'
          and new_row ->> 'status' = 'running'
        )
        or (
          tg_op = 'UPDATE'
          and new_row ->> 'status' in (
            'running',
            'succeeded',
            'waiting_approval'
          )
          and new_row ->> 'status' is distinct from old_row ->> 'status'
        )
      )
    ) or (
      tg_table_name = 'approval_requests'
      and tg_op = 'INSERT'
      and new_row ->> 'entity_type' = 'ai_action'
      and new_row ->> 'status' = 'pending'
    ) or (
      tg_table_name = 'approved_action_executions'
      and (
        tg_op = 'INSERT'
        or (
          tg_op = 'UPDATE'
          and new_row ->> 'status' = 'in_progress'
          and (
            old_row ->> 'status' is distinct from 'in_progress'
            or new_row ->> 'execution_token'
              is distinct from old_row ->> 'execution_token'
          )
        )
      )
    ) or (
      tg_table_name = 'post_service_followups'
      and tg_op = 'UPDATE'
      and (
        (
          new_row ->> 'claim_operation' = 'send'
          and nullif(new_row ->> 'claim_token', '') is not null
          and new_row ->> 'claim_token'
            is distinct from old_row ->> 'claim_token'
        )
        or (
          old_row ->> 'status' = 'queued'
          and new_row ->> 'status' = 'submitted_unknown'
          and new_row ->> 'provider_mode' = 'live'
          and new_row ->> 'provider_status' = 'submission_unknown'
        )
      )
    ) or (
      tg_table_name = 'scope_photo_upload_reservations'
      and (
        (
          tg_op = 'INSERT'
          and new_row ->> 'status' = 'prepared'
        )
        or (
          tg_op = 'UPDATE'
          and old_row ->> 'status' = 'prepared'
          and new_row ->> 'status' = 'finalized'
        )
      )
    ) or (
      tg_table_name = 'scope_photo_submissions'
      and (
        tg_op = 'INSERT'
        or (
          tg_op = 'UPDATE'
          and nullif(old_row ->> 'analysis_id', '') is null
          and nullif(new_row ->> 'analysis_id', '') is not null
        )
      )
    ) or (
      tg_table_name = 'photo_analyses'
      and tg_op = 'INSERT'
    );

    if not service_requires_active then
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    end if;
  end if;

  if not public.lock_storyops_active_company(target_company_id) then
    raise exception using
      errcode = '42501',
      message = 'STORYOPS_COMPANY_NOT_ACTIVE';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- `companies` is the tenant root and therefore has no company_id column for the
-- generic trigger loop. Keep this trigger SECURITY INVOKER so it can
-- distinguish an ordinary authenticated owner from the reviewed
-- SECURITY DEFINER setup/baseline/lifecycle commands.
create or replace function public.assert_active_company_profile_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, auth
as $$
declare
  claimed_role text := auth.role();
  trusted_function_owner name;
begin
  select pg_get_userbyid(routine.proowner)::name
  into trusted_function_owner
  from pg_proc routine
  where routine.oid =
    'public.set_storyops_company_operational_status(uuid,uuid,text,text,text,text,text)'::regprocedure;

  if claimed_role is null
    or current_user = trusted_function_owner
  then
    return new;
  end if;
  if claimed_role <> 'authenticated' then
    raise exception using
      errcode = '42501',
      message = 'STORYOPS_AUTHENTICATED_MUTATION_REQUIRED';
  end if;
  if old.status is distinct from new.status then
    raise exception using
      errcode = '42501',
      message = 'STORYOPS_COMPANY_STATUS_FINITE_COMMAND_REQUIRED';
  end if;
  if not public.lock_storyops_active_company(old.id) then
    raise exception using
      errcode = '42501',
      message = 'STORYOPS_COMPANY_NOT_ACTIVE';
  end if;
  return new;
end;
$$;

drop trigger if exists storyops_active_company_profile_gate
  on public.companies;
create trigger storyops_active_company_profile_gate
before update on public.companies
for each row execute function public.assert_active_company_profile_mutation();

create or replace function public.enforce_active_company_approved_action_start()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not public.lock_storyops_active_company(new.company_id) then
    raise exception using message = 'APPROVED_ACTION_OWNER_REQUIRED';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_active_company_lead_approval_consumption()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.consumed_at is null
    and new.consumed_at is not null
    and new.action_type in ('records.create_lead', 'records.update_lead')
    and not public.lock_storyops_active_company(new.company_id)
  then
    raise exception using message = 'APPROVED_LEAD_OWNER_REQUIRED';
  end if;
  return new;
end;
$$;

create or replace function public.can_upload_job_media_object(target_name text)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, storage
as $$
declare
  folders text[] := storage.foldername(target_name);
  target_company_id uuid;
  scope_id uuid;
begin
  if cardinality(folders) < 3
    or folders[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or folders[3] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    return false;
  end if;
  target_company_id := folders[1]::uuid;
  scope_id := folders[3]::uuid;
  if not public.lock_storyops_active_company(target_company_id) then
    return false;
  end if;
  if public.has_company_role(
    target_company_id,
    array['owner', 'dispatcher']::public.app_role[]
  ) then
    return folders[2] in ('visits', 'customers', 'incidents', 'scope');
  end if;
  if folders[2] = 'visits'
    and public.has_company_role(
      target_company_id,
      array['technician']::public.app_role[]
    )
  then
    return public.is_assigned_technician_for_visit(scope_id);
  end if;
  return false;
exception
  when invalid_text_representation then
    return false;
end;
$$;

revoke all on function public.can_upload_job_media_object(text) from public;
grant execute on function public.can_upload_job_media_object(text)
  to authenticated, service_role;

-- Customer-visible package catalogs are company-wide, but their RLS policies
-- must not query the private portal-mapping table as the browser role. Keep
-- that exact mapping and active-company check behind a finite predicate.
create or replace function public.is_active_company_portal_user(
  p_company_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.customer_portal_users portal
    join public.company_memberships membership
      on membership.company_id = portal.company_id
     and membership.user_id = portal.user_id
    join public.companies company
      on company.id = portal.company_id
    where portal.company_id = p_company_id
      and portal.user_id = auth.uid()
      and membership.active
      and membership.role = 'customer'
      and company.status = 'active'
  );
$$;

revoke all on function public.is_active_company_portal_user(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.is_active_company_portal_user(uuid)
  to authenticated;

drop policy if exists service_packages_company_read
on public.service_packages;
create policy service_packages_company_read
on public.service_packages for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher', 'technician']::public.app_role[]
  )
  or public.is_active_company_portal_user(company_id)
);

drop policy if exists service_package_components_company_read
on public.service_package_components;
create policy service_package_components_company_read
on public.service_package_components for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher', 'technician']::public.app_role[]
  )
  or public.is_active_company_portal_user(company_id)
);

create or replace function public.resolve_scope_photo_actor(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_customer_id uuid
)
returns text
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  actor_role public.app_role;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;

  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = p_actor_user_id
    and membership.active;

  if actor_role in ('owner', 'dispatcher') then
    return actor_role::text;
  end if;
  if actor_role = 'customer'
    and exists (
      select 1
      from public.customer_portal_users portal
      where portal.company_id = p_company_id
        and portal.customer_id = p_customer_id
        and portal.user_id = p_actor_user_id
    )
  then
    return 'customer';
  end if;
  raise exception 'SCOPE_PHOTO_ROLE_REQUIRED';
end;
$$;

revoke all on function public.resolve_scope_photo_actor(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_scope_photo_actor(uuid, uuid, uuid)
  to service_role;

-- Preparing an upload can replay an existing reservation without inserting a
-- row. Since the Edge layer mints a fresh signed token from that replay, take
-- the active-company lock at the finite RPC boundary as well as on new rows.
alter function public.prepare_scope_photo_upload(
  uuid, uuid, uuid, text, uuid, text, bigint, text, timestamptz, uuid, text
) rename to prepare_scope_photo_upload_v1_0;
revoke all on function public.prepare_scope_photo_upload_v1_0(
  uuid, uuid, uuid, text, uuid, text, bigint, text, timestamptz, uuid, text
) from public, anon, authenticated, service_role;

create or replace function public.prepare_scope_photo_upload(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_checklist_item_code text,
  p_asset_id uuid,
  p_content_type text,
  p_byte_size bigint,
  p_checksum_sha256 text,
  p_captured_at timestamptz,
  p_command_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  if not public.lock_storyops_active_company(p_company_id) then
    raise exception using message = 'STORYOPS_COMPANY_NOT_ACTIVE';
  end if;
  return public.prepare_scope_photo_upload_v1_0(
    p_company_id,
    p_actor_user_id,
    p_request_id,
    p_checklist_item_code,
    p_asset_id,
    p_content_type,
    p_byte_size,
    p_checksum_sha256,
    p_captured_at,
    p_command_id,
    p_request_hash
  );
end;
$$;

revoke all on function public.prepare_scope_photo_upload(
  uuid, uuid, uuid, text, uuid, text, bigint, text, timestamptz, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_scope_photo_upload(
  uuid, uuid, uuid, text, uuid, text, bigint, text, timestamptz, uuid, text
) to service_role;

create table public.company_lifecycle_receipts (
  command_id uuid primary key,
  company_id uuid not null references public.companies(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  expected_status text not null check (expected_status in ('active', 'paused')),
  target_status text not null check (target_status in ('active', 'paused')),
  reason text not null check (length(btrim(reason)) between 10 and 1000),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  unique (company_id, command_id),
  check (expected_status <> target_status)
);

alter table public.company_lifecycle_receipts enable row level security;
revoke all on table public.company_lifecycle_receipts
  from public, anon, authenticated, service_role;

create or replace function public.get_storyops_company_control_state(
  p_company_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, auth
as $$
declare
  current_actor_user_id uuid := auth.uid();
  company_row public.companies%rowtype;
  recent_events jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or current_actor_user_id is null
  then
    raise exception using message = 'COMPANY_CONTROL_AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = current_actor_user_id
      and membership.active
      and membership.role = 'owner'
  ) then
    raise exception using message = 'COMPANY_CONTROL_OWNER_REQUIRED';
  end if;

  select *
  into company_row
  from public.companies company
  where company.id = p_company_id;
  if not found then
    raise exception using message = 'COMPANY_CONTROL_NOT_FOUND';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'commandId', event.command_id,
        'previousStatus', event.expected_status,
        'status', event.target_status,
        'reason', event.reason,
        'changedAt', event.created_at,
        'changedByCurrentOwner',
          event.actor_user_id = current_actor_user_id,
        'requestHash', event.request_hash
      )
      order by event.created_at desc, event.command_id desc
    ),
    '[]'::jsonb
  )
  into recent_events
  from (
    select receipt.*
    from public.company_lifecycle_receipts receipt
    where receipt.company_id = p_company_id
    order by receipt.created_at desc, receipt.command_id desc
    limit 20
  ) event;

  return jsonb_build_object(
    'schemaVersion', 'storyops-company-control-state-v1',
    'companyId', company_row.id,
    'userId', current_actor_user_id,
    'companyName', company_row.name,
    'timezone', company_row.timezone,
    'status', company_row.status,
    'canPause', company_row.status = 'active',
    'canReactivate', company_row.status = 'paused',
    'recentEvents', recent_events,
    'serverTime', now()
  );
end;
$$;

create or replace function public.set_storyops_company_operational_status(
  p_company_id uuid,
  p_command_id uuid,
  p_expected_status text,
  p_target_status text,
  p_reason text,
  p_canonical_request text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  company_row public.companies%rowtype;
  existing_receipt public.company_lifecycle_receipts%rowtype;
  normalized_reason text := btrim(coalesce(p_reason, ''));
  parsed_request jsonb;
  expected_request jsonb;
  effective_hash text;
  changed_at_value timestamptz := clock_timestamp();
  result jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
  then
    raise exception using message = 'COMPANY_CONTROL_AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = actor_user_id
      and membership.active
      and membership.role = 'owner'
  ) then
    raise exception using message = 'COMPANY_CONTROL_OWNER_REQUIRED';
  end if;
  if p_company_id is null
    or p_command_id is null
    or p_expected_status not in ('active', 'paused')
    or p_target_status not in ('active', 'paused')
    or p_expected_status = p_target_status
    or length(normalized_reason) not between 10 and 1000
    or normalized_reason ~ '[[:cntrl:]]'
    or p_canonical_request is null
    or length(p_canonical_request) > 4096
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception using message = 'COMPANY_CONTROL_INVALID_REQUEST';
  end if;

  begin
    parsed_request := p_canonical_request::jsonb;
  exception when others then
    raise exception using message = 'COMPANY_CONTROL_CANONICAL_REQUEST_INVALID';
  end;
  expected_request := jsonb_build_object(
    'action',
    'company.operational_status.set',
    'payload',
    jsonb_build_object(
      'expectedStatus',
      p_expected_status,
      'reason',
      normalized_reason,
      'targetStatus',
      p_target_status
    )
  );
  effective_hash := encode(
    extensions.digest(convert_to(p_canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  if parsed_request <> expected_request
    or effective_hash <> p_request_hash
  then
    raise exception using message = 'COMPANY_CONTROL_REQUEST_HASH_MISMATCH';
  end if;

  select *
  into company_row
  from public.companies company
  where company.id = p_company_id
  for update;
  if not found then
    raise exception using message = 'COMPANY_CONTROL_NOT_FOUND';
  end if;

  select *
  into existing_receipt
  from public.company_lifecycle_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.command_id = p_command_id;
  if found then
    if existing_receipt.request_hash <> p_request_hash
      or existing_receipt.actor_user_id <> actor_user_id
      or existing_receipt.expected_status <> p_expected_status
      or existing_receipt.target_status <> p_target_status
      or existing_receipt.reason <> normalized_reason
    then
      raise exception using message = 'COMPANY_CONTROL_IDEMPOTENCY_CONFLICT';
    end if;
    return existing_receipt.response || jsonb_build_object('replayed', true);
  end if;

  if company_row.status <> p_expected_status then
    raise exception using message = 'COMPANY_CONTROL_STATUS_CONFLICT';
  end if;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-company-control-receipt-v1',
    'companyId', p_company_id,
    'commandId', p_command_id,
    'previousStatus', p_expected_status,
    'status', p_target_status,
    'reason', normalized_reason,
    'requestHash', p_request_hash,
    'changedAt', changed_at_value,
    'replayed', false
  );

  if p_target_status = 'paused' then
    insert into public.company_lifecycle_receipts(
      command_id,
      company_id,
      actor_user_id,
      request_hash,
      expected_status,
      target_status,
      reason,
      response,
      created_at
    )
    values (
      p_command_id,
      p_company_id,
      actor_user_id,
      p_request_hash,
      p_expected_status,
      p_target_status,
      normalized_reason,
      result,
      changed_at_value
    );
    insert into public.audit_events(
      company_id,
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      before_data,
      after_data,
      request_id
    )
    values (
      p_company_id,
      'user',
      actor_user_id::text,
      'company.operational_paused',
      'company',
      p_company_id,
      jsonb_build_object('status', p_expected_status),
      jsonb_build_object(
        'status',
        p_target_status,
        'reason',
        normalized_reason,
        'requestHash',
        p_request_hash
      ),
      p_command_id::text
    );
    update public.companies
    set status = p_target_status,
        updated_at = changed_at_value
    where id = p_company_id;
  else
    update public.companies
    set status = p_target_status,
        updated_at = changed_at_value
    where id = p_company_id;
    insert into public.company_lifecycle_receipts(
      command_id,
      company_id,
      actor_user_id,
      request_hash,
      expected_status,
      target_status,
      reason,
      response,
      created_at
    )
    values (
      p_command_id,
      p_company_id,
      actor_user_id,
      p_request_hash,
      p_expected_status,
      p_target_status,
      normalized_reason,
      result,
      changed_at_value
    );
    insert into public.audit_events(
      company_id,
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      before_data,
      after_data,
      request_id
    )
    values (
      p_company_id,
      'user',
      actor_user_id::text,
      'company.operational_reactivated',
      'company',
      p_company_id,
      jsonb_build_object('status', p_expected_status),
      jsonb_build_object(
        'status',
        p_target_status,
        'reason',
        normalized_reason,
        'requestHash',
        p_request_hash
      ),
      p_command_id::text
    );
  end if;

  return result;
end;
$$;

revoke all on function public.get_storyops_company_control_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_storyops_company_control_state(uuid)
  to authenticated;
revoke all on function public.set_storyops_company_operational_status(
  uuid, uuid, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.set_storyops_company_operational_status(
  uuid, uuid, text, text, text, text, text
) to authenticated;

drop policy if exists sds_owner_insert on storage.objects;
create policy sds_owner_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'sds'
  and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  and public.lock_storyops_active_company(
    ((storage.foldername(name))[1])::uuid
  )
  and public.has_company_role(
    ((storage.foldername(name))[1])::uuid,
    array['owner']::public.app_role[]
  )
);

drop policy if exists sds_owner_update on storage.objects;
create policy sds_owner_update on storage.objects for update to authenticated
using (
  bucket_id = 'sds'
  and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  and public.lock_storyops_active_company(
    ((storage.foldername(name))[1])::uuid
  )
  and public.has_company_role(
    ((storage.foldername(name))[1])::uuid,
    array['owner']::public.app_role[]
  )
)
with check (
  bucket_id = 'sds'
  and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  and public.lock_storyops_active_company(
    ((storage.foldername(name))[1])::uuid
  )
  and public.has_company_role(
    ((storage.foldername(name))[1])::uuid,
    array['owner']::public.app_role[]
  )
);

drop policy if exists company_assets_owner_insert on storage.objects;
create policy company_assets_owner_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'company-assets'
  and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  and public.lock_storyops_active_company(
    ((storage.foldername(name))[1])::uuid
  )
  and public.has_company_role(
    ((storage.foldername(name))[1])::uuid,
    array['owner']::public.app_role[]
  )
);

drop policy if exists company_assets_owner_update on storage.objects;
create policy company_assets_owner_update on storage.objects for update to authenticated
using (
  bucket_id = 'company-assets'
  and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  and public.lock_storyops_active_company(
    ((storage.foldername(name))[1])::uuid
  )
  and public.has_company_role(
    ((storage.foldername(name))[1])::uuid,
    array['owner']::public.app_role[]
  )
)
with check (
  bucket_id = 'company-assets'
  and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  and public.lock_storyops_active_company(
    ((storage.foldername(name))[1])::uuid
  )
  and public.has_company_role(
    ((storage.foldername(name))[1])::uuid,
    array['owner']::public.app_role[]
  )
);

-- Approval consumption is reachable only through exact finite commands. A
-- browser can forge a custom GUC, so the trigger also requires a
-- transaction/backend-bound token in the private schema that only the revoked
-- internal consumer can create.
create table if not exists private.storyops_approval_consumption_capabilities (
  backend_pid integer not null,
  transaction_id bigint not null,
  company_id uuid not null,
  approval_request_id uuid not null,
  token uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (backend_pid, transaction_id, approval_request_id)
);

revoke all on table private.storyops_approval_consumption_capabilities
  from public, anon, authenticated, service_role;

create or replace function public.protect_approval_request()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  immutable_old jsonb;
  immutable_new jsonb;
  capability_setting text;
  capability_token uuid;
begin
  immutable_old := to_jsonb(old) - array[
    'status', 'decided_by', 'decided_at', 'decision_note',
    'consumed_at', 'execution_receipt', 'updated_at', 'version'
  ];
  immutable_new := to_jsonb(new) - array[
    'status', 'decided_by', 'decided_at', 'decision_note',
    'consumed_at', 'execution_receipt', 'updated_at', 'version'
  ];
  if immutable_new <> immutable_old then
    raise exception 'Approval scope and exact action payload are immutable';
  end if;

  if old.status <> 'pending' and (
    new.status <> old.status
    or new.decided_by is distinct from old.decided_by
    or new.decided_at is distinct from old.decided_at
    or new.decision_note is distinct from old.decision_note
  ) then
    raise exception 'An approval decision is final';
  end if;

  if old.status = 'pending' and new.status <> 'pending' then
    if new.status in ('approved', 'rejected') and not exists (
      select 1
      from public.company_memberships membership
      where membership.company_id = old.company_id
        and membership.user_id = new.decided_by
        and membership.role = 'owner'
        and membership.active
    ) then
      raise exception 'Approval decisions require an active owner';
    end if;
  elsif old.status = 'pending' and new.status = 'pending' and (
    new.decided_by is not null
    or new.decided_at is not null
    or new.decision_note is not null
  ) then
    raise exception 'Pending approvals cannot contain decision evidence';
  end if;

  if new.consumed_at is distinct from old.consumed_at
    or new.execution_receipt is distinct from old.execution_receipt
  then
    capability_setting := current_setting(
      'storyops.approval_consumption_token',
      true
    );
    if capability_setting ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then
      capability_token := capability_setting::uuid;
    end if;
    if capability_token is null or not exists (
      select 1
      from private.storyops_approval_consumption_capabilities capability
      where capability.backend_pid = pg_backend_pid()
        and capability.transaction_id = txid_current()
        and capability.company_id = old.company_id
        and capability.approval_request_id = old.id
        and capability.token = capability_token
    ) then
      raise exception 'Approval consumption is server-controlled';
    end if;
    delete from private.storyops_approval_consumption_capabilities capability
    where capability.backend_pid = pg_backend_pid()
      and capability.transaction_id = txid_current()
      and capability.company_id = old.company_id
      and capability.approval_request_id = old.id
      and capability.token = capability_token;
    perform set_config('storyops.approval_consumption_token', '', true);
  end if;
  return new;
end;
$$;

revoke all on function public.protect_approval_request()
  from public, anon, authenticated, service_role;

create or replace function public.consume_exact_action_approval(
  p_company_id uuid,
  p_approval_request_id uuid,
  p_reason text,
  p_action_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_exact_payload jsonb,
  p_execution_receipt jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  capability_token uuid := extensions.gen_random_uuid();
begin
  insert into private.storyops_approval_consumption_capabilities(
    backend_pid,
    transaction_id,
    company_id,
    approval_request_id,
    token
  )
  values (
    pg_backend_pid(),
    txid_current(),
    p_company_id,
    p_approval_request_id,
    capability_token
  );
  perform set_config(
    'storyops.approval_consumption_token',
    capability_token::text,
    true
  );

  update public.approval_requests
  set
    consumed_at = now(),
    execution_receipt = p_execution_receipt
  where id = p_approval_request_id
    and company_id = p_company_id
    and status = 'approved'
    and reason::text = p_reason
    and action_type = p_action_type
    and entity_type = p_entity_type
    and entity_id is not distinct from p_entity_id
    and consumed_at is null
    and (expires_at is null or expires_at > now())
    and coalesce(action_payload -> 'exactPayload', 'null'::jsonb) = p_exact_payload
    and coalesce(action_payload ->> 'payloadHash', '') ~ '^[a-f0-9]{64}$';
  if not found then
    raise exception 'Missing, expired, consumed, or payload-mismatched approval';
  end if;

  delete from private.storyops_approval_consumption_capabilities capability
  where capability.backend_pid = pg_backend_pid()
    and capability.transaction_id = txid_current()
    and capability.company_id = p_company_id
    and capability.approval_request_id = p_approval_request_id
    and capability.token = capability_token;
  perform set_config('storyops.approval_consumption_token', '', true);
exception
  when others then
    delete from private.storyops_approval_consumption_capabilities capability
    where capability.backend_pid = pg_backend_pid()
      and capability.transaction_id = txid_current()
      and capability.company_id = p_company_id
      and capability.approval_request_id = p_approval_request_id
      and capability.token = capability_token;
    perform set_config('storyops.approval_consumption_token', '', true);
    raise;
end;
$$;

revoke all on function public.consume_exact_action_approval(
  uuid, uuid, text, text, text, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role;

revoke all on function public.assert_active_company_for_authenticated_mutation() from public;
revoke all on function public.assert_active_company_for_authenticated_mutation()
  from anon, authenticated, service_role;
revoke all on function public.assert_active_company_profile_mutation()
  from public, anon, authenticated, service_role;

comment on function public.assert_active_company_for_authenticated_mutation() is
  'Fail-closed trigger boundary: authenticated tenant mutations require companies.status=active; trusted service-role reconciliation remains separately allowlisted.';
comment on function public.assert_active_company_profile_mutation() is
  'Tenant-root boundary: paused owners retain read/control access but ordinary company profile/settings writes require active status; lifecycle changes remain finite-command-only.';

do $$
declare
  relation_name text;
begin
  for relation_name in
    select column_record.table_name
    from information_schema.columns column_record
    join information_schema.tables table_record
      on table_record.table_schema = column_record.table_schema
     and table_record.table_name = column_record.table_name
    where column_record.table_schema = 'public'
      and column_record.column_name = 'company_id'
      and table_record.table_type = 'BASE TABLE'
    order by column_record.table_name
  loop
    execute format(
      'drop trigger if exists storyops_active_company_mutation_gate on public.%I',
      relation_name
    );
    execute format(
      'create trigger storyops_active_company_mutation_gate
         before insert or update or delete on public.%I
         for each row execute function public.assert_active_company_for_authenticated_mutation()',
      relation_name
    );
  end loop;
end;
$$;
