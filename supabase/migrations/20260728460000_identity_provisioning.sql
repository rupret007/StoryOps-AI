-- Trusted identity provisioning boundary.
--
-- Browser callers never receive service-role credentials and cannot mutate
-- memberships or portal mappings directly. A finite Edge workflow resolves an
-- exact normalized email through the Supabase Admin API, then these RPCs
-- recheck the active owner and company immediately before local access changes.

create table public.identity_provisioning_targets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  normalized_email text not null
    check (
      normalized_email = lower(btrim(normalized_email))
      and length(normalized_email) between 3 and 254
      and normalized_email !~ '[[:cntrl:][:space:]]'
      and normalized_email ~
        '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$'
    ),
  target_role public.app_role not null
    check (target_role in ('dispatcher', 'technician', 'customer')),
  customer_id uuid references public.customers(id) on delete cascade,
  binding_customer_id uuid generated always as (
    coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) stored,
  target_user_id uuid references auth.users(id) on delete set null,
  status text not null
    check (status in ('pending', 'invited', 'linked', 'revoked')),
  delivery_status text not null
    check (delivery_status in (
      'not_requested',
      'disabled',
      'provider_submission_accepted',
      'provider_submission_failed',
      'provider_submission_unknown'
    )),
  outcome_code text not null
    check (outcome_code in (
      'invite_delivery_disabled',
      'existing_identity_requires_link',
      'invite_submission_accepted',
      'invite_submission_failed',
      'invite_submission_unknown',
      'identity_not_found',
      'identity_confirmation_required',
      'identity_linked',
      'identity_revoked'
    )),
  external_delivery_claimed boolean not null default false
    check (not external_delivery_claimed),
  invited_at timestamptz,
  linked_at timestamptz,
  revoked_at timestamptz,
  last_command_id uuid not null,
  created_by_user_id uuid not null references auth.users(id) on delete restrict,
  updated_by_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (company_id, normalized_email, target_role, binding_customer_id),
  check (
    (target_role = 'customer' and customer_id is not null)
    or (target_role in ('dispatcher', 'technician') and customer_id is null)
  ),
  check (
    (status = 'invited'
      and delivery_status = 'provider_submission_accepted'
      and target_user_id is not null
      and invited_at is not null)
    or status <> 'invited'
  ),
  check (
    (status = 'linked' and target_user_id is not null and linked_at is not null)
    or status <> 'linked'
  ),
  check ((status = 'revoked' and revoked_at is not null) or status <> 'revoked')
);

create index identity_provisioning_targets_company_updated_idx
  on public.identity_provisioning_targets(company_id, updated_at desc, id);
create index identity_provisioning_targets_user_idx
  on public.identity_provisioning_targets(company_id, target_user_id)
  where target_user_id is not null;

create table public.identity_provisioning_commands (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  command_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in ('invite', 'link', 'revoke')),
  normalized_email text not null,
  target_role public.app_role not null
    check (target_role in ('dispatcher', 'technician', 'customer')),
  customer_id uuid references public.customers(id) on delete restrict,
  canonical_request text not null
    check (octet_length(canonical_request) between 2 and 4096),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'completed')),
  target_id uuid references public.identity_provisioning_targets(id) on delete restrict,
  invite_attempt_authorized_at timestamptz,
  response jsonb check (response is null or jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (company_id, command_id),
  check (
    (target_role = 'customer' and customer_id is not null)
    or (target_role in ('dispatcher', 'technician') and customer_id is null)
  ),
  check (invite_attempt_authorized_at is null or action = 'invite'),
  check (
    (status = 'pending' and response is null and completed_at is null)
    or (status = 'completed' and response is not null and completed_at is not null)
  )
);

create index identity_provisioning_commands_company_time_idx
  on public.identity_provisioning_commands(company_id, created_at desc, id);

alter table public.identity_provisioning_targets enable row level security;
alter table public.identity_provisioning_targets force row level security;
alter table public.identity_provisioning_commands enable row level security;
alter table public.identity_provisioning_commands force row level security;

revoke all on public.identity_provisioning_targets
  from public, anon, authenticated, service_role;
revoke all on public.identity_provisioning_commands
  from public, anon, authenticated, service_role;
revoke insert, update, delete on public.company_memberships
  from public, anon, authenticated;
revoke insert, update, delete on public.customer_portal_users
  from public, anon, authenticated;

create or replace function private.assert_storyops_identity_service()
returns void
language plpgsql
security definer
stable
set search_path = pg_catalog, auth
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'IDENTITY_SERVICE_ROLE_REQUIRED';
  end if;
end;
$$;

revoke all on function private.assert_storyops_identity_service()
  from public, anon, authenticated, service_role;

create or replace function private.assert_storyops_identity_owner(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_require_active_company boolean
)
returns text
language plpgsql
security definer
stable
set search_path = pg_catalog, public, auth
as $$
declare
  company_status text;
begin
  perform private.assert_storyops_identity_service();
  select company.status
  into company_status
  from public.companies company
  join public.company_memberships membership
    on membership.company_id = company.id
   and membership.user_id = p_actor_user_id
   and membership.active
   and membership.role = 'owner'
  where company.id = p_company_id;

  if company_status is null
    or (p_require_active_company and company_status <> 'active')
  then
    raise exception using message = 'IDENTITY_ACTIVE_OWNER_REQUIRED';
  end if;
  return company_status;
end;
$$;

revoke all on function private.assert_storyops_identity_owner(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;

create or replace function private.lock_storyops_identity_owner(
  p_company_id uuid,
  p_actor_user_id uuid
)
returns void
language plpgsql
security definer
volatile
set search_path = pg_catalog, public, private, auth
as $$
begin
  perform private.assert_storyops_identity_service();
  perform 1
  from public.companies company
  join public.company_memberships membership
    on membership.company_id = company.id
   and membership.user_id = p_actor_user_id
   and membership.active
   and membership.role = 'owner'
  where company.id = p_company_id
    and company.status = 'active'
  for share of company, membership;
  if not found then
    raise exception using message = 'IDENTITY_ACTIVE_OWNER_REQUIRED';
  end if;
end;
$$;

revoke all on function private.lock_storyops_identity_owner(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function private.assert_storyops_identity_customer(
  p_company_id uuid,
  p_role public.app_role,
  p_customer_id uuid
)
returns void
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
begin
  if (p_role = 'customer') is distinct from (p_customer_id is not null) then
    raise exception using message = 'IDENTITY_CUSTOMER_BINDING_INVALID';
  end if;
  if p_customer_id is not null
    and not exists (
      select 1
      from public.customers customer
      where customer.company_id = p_company_id
        and customer.id = p_customer_id
        and customer.lifecycle <> 'blocked'
    )
  then
    raise exception using message = 'IDENTITY_CUSTOMER_BINDING_NOT_FOUND';
  end if;
end;
$$;

revoke all on function private.assert_storyops_identity_customer(
  uuid, public.app_role, uuid
) from public, anon, authenticated, service_role;

create or replace function private.storyops_identity_target_company_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.customer_id is not null
    and not exists (
      select 1
      from public.customers customer
      where customer.id = new.customer_id
        and customer.company_id = new.company_id
    )
  then
    raise exception using message = 'IDENTITY_CUSTOMER_COMPANY_MISMATCH';
  end if;
  return new;
end;
$$;

revoke all on function private.storyops_identity_target_company_guard()
  from public, anon, authenticated, service_role;

create constraint trigger identity_provisioning_targets_customer_company
  after insert or update
  on public.identity_provisioning_targets
  deferrable initially immediate
  for each row execute function private.storyops_identity_target_company_guard();

create constraint trigger identity_provisioning_commands_customer_company
  after insert or update
  on public.identity_provisioning_commands
  deferrable initially immediate
  for each row execute function private.storyops_identity_target_company_guard();

create trigger identity_provisioning_targets_touch
  before update on public.identity_provisioning_targets
  for each row execute function public.touch_record();

create or replace function private.storyops_identity_receipt(
  p_command public.identity_provisioning_commands,
  p_target public.identity_provisioning_targets,
  p_membership_active boolean,
  p_portal_linked boolean,
  p_replayed boolean,
  p_server_time timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-receipt-v1',
    'companyId', p_command.company_id,
    'commandId', p_command.command_id,
    'requestHash', p_command.request_hash,
    'action', p_command.action,
    'email', p_command.normalized_email,
    'role', p_command.target_role,
    'customerId', p_command.customer_id,
    'status', p_target.status,
    'deliveryStatus', p_target.delivery_status,
    'externalDeliveryClaimed', false,
    'membershipActive', p_membership_active,
    'portalLinked', p_portal_linked,
    'outcomeCode', p_target.outcome_code,
    'replayed', p_replayed,
    'serverTime', p_server_time
  )
$$;

revoke all on function private.storyops_identity_receipt(
  public.identity_provisioning_commands,
  public.identity_provisioning_targets,
  boolean,
  boolean,
  boolean,
  timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.begin_storyops_identity_provisioning(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_action text,
  p_normalized_email text,
  p_target_role text,
  p_customer_id uuid,
  p_canonical_request text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth, extensions
as $$
declare
  target_role_value public.app_role;
  parsed_request jsonb;
  expected_request jsonb;
  existing_command public.identity_provisioning_commands%rowtype;
  existing_target public.identity_provisioning_targets%rowtype;
  effective_hash text;
  requested_at timestamptz := clock_timestamp();
begin
  perform private.lock_storyops_identity_owner(
    p_company_id, p_actor_user_id
  );
  begin
    target_role_value := p_target_role::public.app_role;
  exception when others then
    raise exception using message = 'IDENTITY_REQUEST_INVALID';
  end;
  if p_company_id is null
    or p_actor_user_id is null
    or p_command_id is null
    or p_action not in ('invite', 'link', 'revoke')
    or target_role_value not in ('dispatcher', 'technician', 'customer')
    or p_normalized_email is null
    or p_normalized_email <> lower(btrim(p_normalized_email))
    or length(p_normalized_email) not between 3 and 254
    or p_normalized_email ~ '[[:cntrl:][:space:]]'
    or p_normalized_email !~
      '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$'
    or octet_length(coalesce(p_canonical_request, '')) not between 2 and 4096
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception using message = 'IDENTITY_REQUEST_INVALID';
  end if;
  perform private.assert_storyops_identity_customer(
    p_company_id, target_role_value, p_customer_id
  );

  expected_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', p_company_id,
    'commandId', p_command_id,
    'action', p_action,
    'email', p_normalized_email,
    'role', target_role_value,
    'customerId', p_customer_id
  );
  begin
    parsed_request := p_canonical_request::jsonb;
  exception when others then
    raise exception using message = 'IDENTITY_CANONICAL_REQUEST_INVALID';
  end;
  effective_hash := encode(
    extensions.digest(convert_to(p_canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  if parsed_request <> expected_request or effective_hash <> p_request_hash then
    raise exception using message = 'IDENTITY_REQUEST_HASH_MISMATCH';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-identity-command:' || p_company_id::text || ':' || p_command_id::text,
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-identity:' || p_company_id::text || ':' || p_normalized_email,
    0
  ));
  select *
  into existing_command
  from public.identity_provisioning_commands command
  where command.company_id = p_company_id
    and command.command_id = p_command_id
  for update;
  if found then
    if existing_command.actor_user_id <> p_actor_user_id
      or existing_command.action <> p_action
      or existing_command.normalized_email <> p_normalized_email
      or existing_command.target_role <> target_role_value
      or existing_command.customer_id is distinct from p_customer_id
      or existing_command.canonical_request <> p_canonical_request
      or existing_command.request_hash <> p_request_hash
    then
      raise exception using message = 'IDENTITY_IDEMPOTENCY_CONFLICT';
    end if;
    if existing_command.status = 'completed' then
      return existing_command.response || jsonb_build_object('replayed', true);
    end if;
    select *
    into existing_target
    from public.identity_provisioning_targets target
    where target.company_id = p_company_id
      and target.normalized_email = p_normalized_email
      and target.target_role = target_role_value
      and target.binding_customer_id = coalesce(
        p_customer_id,
        '00000000-0000-0000-0000-000000000000'::uuid
      );
    return jsonb_build_object(
      'schemaVersion', 'storyops-identity-provisioning-command-v1',
      'companyId', p_company_id,
      'actorUserId', p_actor_user_id,
      'commandId', p_command_id,
      'requestHash', p_request_hash,
      'action', p_action,
      'email', p_normalized_email,
      'role', target_role_value,
      'customerId', p_customer_id,
      'targetUserId', existing_target.target_user_id,
      'inviteAttemptAuthorized',
        existing_command.invite_attempt_authorized_at is not null,
      'terminal', false,
      'replayed', true
    );
  end if;

  select *
  into existing_target
  from public.identity_provisioning_targets target
  where target.company_id = p_company_id
    and target.normalized_email = p_normalized_email
    and target.target_role = target_role_value
    and target.binding_customer_id = coalesce(
      p_customer_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    );
  if p_action in ('invite', 'link') and existing_target.status = 'linked' then
    raise exception using message = 'IDENTITY_ALREADY_LINKED';
  end if;

  -- Repeat the active-owner assertion immediately before the durable request.
  perform private.lock_storyops_identity_owner(
    p_company_id, p_actor_user_id
  );
  insert into public.identity_provisioning_commands(
    company_id, command_id, actor_user_id, action, normalized_email,
    target_role, customer_id, canonical_request, request_hash
  )
  values (
    p_company_id, p_command_id, p_actor_user_id, p_action,
    p_normalized_email, target_role_value, p_customer_id,
    p_canonical_request, p_request_hash
  )
  returning * into existing_command;

  insert into public.audit_events(
    company_id, occurred_at, actor_type, actor_id, action,
    entity_type, entity_id, after_data, request_id
  )
  values (
    p_company_id, requested_at, 'user', p_actor_user_id::text,
    'identity.provisioning.requested', 'identity_provisioning_command',
    existing_command.id,
    jsonb_build_object(
      'action', p_action,
      'email', p_normalized_email,
      'role', target_role_value,
      'customerId', p_customer_id,
      'requestHash', p_request_hash,
      'status', 'pending'
    ),
    p_command_id::text
  );

  select *
  into existing_target
  from public.identity_provisioning_targets target
  where target.company_id = p_company_id
    and target.normalized_email = p_normalized_email
    and target.target_role = target_role_value
    and target.binding_customer_id = coalesce(
      p_customer_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    );
  return jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-command-v1',
    'companyId', p_company_id,
    'actorUserId', p_actor_user_id,
    'commandId', p_command_id,
    'requestHash', p_request_hash,
    'action', p_action,
    'email', p_normalized_email,
    'role', target_role_value,
    'customerId', p_customer_id,
    'targetUserId', existing_target.target_user_id,
    'inviteAttemptAuthorized', false,
    'terminal', false,
    'replayed', false
  );
end;
$$;

revoke all on function public.begin_storyops_identity_provisioning(
  uuid, uuid, uuid, text, text, text, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.begin_storyops_identity_provisioning(
  uuid, uuid, uuid, text, text, text, uuid, text, text
) to service_role;

create or replace function public.authorize_storyops_identity_invite(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_request_hash text
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
    p_company_id, p_actor_user_id
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
  then
    raise exception using message = 'IDENTITY_INVITE_NOT_AUTHORIZED';
  end if;
  attempt_already_authorized :=
    command_row.invite_attempt_authorized_at is not null;
  -- This is deliberately the final database operation before Admin API use.
  perform private.lock_storyops_identity_owner(
    p_company_id, p_actor_user_id
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
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.authorize_storyops_identity_invite(
  uuid, uuid, uuid, text
) to service_role;

create or replace function public.record_storyops_identity_observation(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_target_user_id uuid,
  p_status text,
  p_delivery_status text,
  p_outcome_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  command_row public.identity_provisioning_commands%rowtype;
  target_row public.identity_provisioning_targets%rowtype;
  auth_email text;
  completed_at_value timestamptz := clock_timestamp();
  result jsonb;
  membership_active boolean := false;
  portal_linked boolean := false;
begin
  perform private.assert_storyops_identity_service();
  select *
  into command_row
  from public.identity_provisioning_commands command
  where command.company_id = p_company_id
    and command.command_id = p_command_id
  for update;
  if not found
    or command_row.actor_user_id <> p_actor_user_id
    or command_row.request_hash <> p_request_hash
  then
    raise exception using message = 'IDENTITY_COMMAND_NOT_FOUND';
  end if;
  if command_row.status = 'completed' then
    return command_row.response || jsonb_build_object('replayed', true);
  end if;
  if (
    command_row.action = 'invite'
    and p_status = 'pending'
    and p_delivery_status = 'disabled'
    and p_outcome_code = 'invite_delivery_disabled'
    and p_target_user_id is null
  ) or (
    command_row.action = 'invite'
    and p_status = 'pending'
    and p_delivery_status = 'not_requested'
    and p_outcome_code = 'existing_identity_requires_link'
    and p_target_user_id is not null
  ) or (
    command_row.action = 'invite'
    and p_status = 'invited'
    and p_delivery_status = 'provider_submission_accepted'
    and p_outcome_code = 'invite_submission_accepted'
    and p_target_user_id is not null
  ) or (
    command_row.action = 'invite'
    and p_status = 'pending'
    and p_delivery_status = 'provider_submission_failed'
    and p_outcome_code = 'invite_submission_failed'
  ) or (
    command_row.action = 'invite'
    and p_status = 'pending'
    and p_delivery_status = 'provider_submission_unknown'
    and p_outcome_code = 'invite_submission_unknown'
  ) or (
    command_row.action = 'link'
    and p_status = 'pending'
    and p_delivery_status = 'not_requested'
    and p_outcome_code in ('identity_not_found', 'identity_confirmation_required')
  ) then
    null;
  else
    raise exception using message = 'IDENTITY_OBSERVATION_INVALID';
  end if;
  if p_delivery_status in (
    'provider_submission_accepted',
    'provider_submission_failed',
    'provider_submission_unknown'
  ) and command_row.invite_attempt_authorized_at is null then
    raise exception using message = 'IDENTITY_INVITE_ATTEMPT_NOT_AUTHORIZED';
  end if;

  if p_target_user_id is not null then
    select lower(btrim(user_row.email))
    into auth_email
    from auth.users user_row
    where user_row.id = p_target_user_id;
    if auth_email is distinct from command_row.normalized_email then
      raise exception using message = 'IDENTITY_AUTH_EMAIL_MISMATCH';
    end if;
  end if;

  -- Every post-attempt provider observation must be recorded even if the
  -- requesting owner was offboarded in the distributed gap. Other target
  -- mutations still require the active owner and active company at this point.
  if not (
    command_row.action = 'invite'
    and command_row.invite_attempt_authorized_at is not null
    and p_delivery_status in (
      'provider_submission_accepted',
      'provider_submission_failed',
      'provider_submission_unknown'
    )
  ) then
    perform private.lock_storyops_identity_owner(
      p_company_id, p_actor_user_id
    );
  end if;

  insert into public.identity_provisioning_targets(
    company_id, normalized_email, target_role, customer_id, target_user_id,
    status, delivery_status, outcome_code, external_delivery_claimed,
    invited_at, linked_at, revoked_at, last_command_id,
    created_by_user_id, updated_by_user_id
  )
  values (
    p_company_id, command_row.normalized_email, command_row.target_role,
    command_row.customer_id, p_target_user_id, p_status, p_delivery_status,
    p_outcome_code, false,
    case when p_status = 'invited' then completed_at_value else null end,
    null, null, p_command_id, p_actor_user_id, p_actor_user_id
  )
  on conflict (
    company_id, normalized_email, target_role, binding_customer_id
  )
  do update set
    target_user_id = coalesce(
      excluded.target_user_id,
      identity_provisioning_targets.target_user_id
    ),
    status = excluded.status,
    delivery_status = excluded.delivery_status,
    outcome_code = excluded.outcome_code,
    invited_at = coalesce(
      excluded.invited_at,
      identity_provisioning_targets.invited_at
    ),
    linked_at = case
      when excluded.status = 'pending' then null
      else identity_provisioning_targets.linked_at
    end,
    revoked_at = null,
    last_command_id = excluded.last_command_id,
    updated_by_user_id = excluded.updated_by_user_id
  returning * into target_row;

  select exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = target_row.target_user_id
      and membership.role = command_row.target_role
      and membership.active
  )
  into membership_active;
  if command_row.target_role = 'customer' then
    select exists (
      select 1
      from public.customer_portal_users portal
      where portal.company_id = p_company_id
        and portal.user_id = target_row.target_user_id
        and portal.customer_id = command_row.customer_id
    )
    into portal_linked;
  end if;

  result := private.storyops_identity_receipt(
    command_row, target_row, membership_active, portal_linked,
    false, completed_at_value
  );
  update public.identity_provisioning_commands
  set status = 'completed',
      target_id = target_row.id,
      response = result,
      completed_at = completed_at_value
  where id = command_row.id;

  insert into public.audit_events(
    company_id, occurred_at, actor_type, actor_id, action,
    entity_type, entity_id, after_data, request_id
  )
  values (
    p_company_id, completed_at_value, 'user', p_actor_user_id::text,
    case
      when p_outcome_code = 'invite_submission_accepted'
        then 'identity.invite.submission_accepted'
      when p_outcome_code = 'invite_submission_failed'
        then 'identity.invite.submission_failed'
      when p_outcome_code = 'invite_submission_unknown'
        then 'identity.invite.submission_unknown'
      else 'identity.provisioning.pending'
    end,
    'identity_provisioning_target', target_row.id,
    jsonb_build_object(
      'email', target_row.normalized_email,
      'role', target_row.target_role,
      'customerId', target_row.customer_id,
      'status', target_row.status,
      'deliveryStatus', target_row.delivery_status,
      'externalDeliveryClaimed', false,
      'outcomeCode', target_row.outcome_code
    ),
    p_command_id::text
  );
  return result;
end;
$$;

revoke all on function public.record_storyops_identity_observation(
  uuid, uuid, uuid, text, uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_storyops_identity_observation(
  uuid, uuid, uuid, text, uuid, text, text, text
) to service_role;

create or replace function public.link_storyops_identity(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_target_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  command_row public.identity_provisioning_commands%rowtype;
  target_row public.identity_provisioning_targets%rowtype;
  membership_row public.company_memberships%rowtype;
  auth_email text;
  auth_confirmed_at timestamptz;
  linked_at_value timestamptz := clock_timestamp();
  result jsonb;
  portal_linked boolean := false;
begin
  perform private.lock_storyops_identity_owner(
    p_company_id, p_actor_user_id
  );
  select *
  into command_row
  from public.identity_provisioning_commands command
  where command.company_id = p_company_id
    and command.command_id = p_command_id
  for update;
  if not found
    or command_row.actor_user_id <> p_actor_user_id
    or command_row.action <> 'link'
    or command_row.request_hash <> p_request_hash
  then
    raise exception using message = 'IDENTITY_LINK_NOT_AUTHORIZED';
  end if;
  if command_row.status = 'completed' then
    return command_row.response || jsonb_build_object('replayed', true);
  end if;
  if p_target_user_id is null then
    raise exception using message = 'IDENTITY_LINK_USER_REQUIRED';
  end if;

  select lower(btrim(user_row.email)), user_row.email_confirmed_at
  into auth_email, auth_confirmed_at
  from auth.users user_row
  where user_row.id = p_target_user_id;
  if auth_email is distinct from command_row.normalized_email then
    raise exception using message = 'IDENTITY_AUTH_EMAIL_MISMATCH';
  end if;
  if auth_confirmed_at is null then
    raise exception using message = 'IDENTITY_EMAIL_NOT_CONFIRMED';
  end if;
  perform private.assert_storyops_identity_customer(
    p_company_id, command_row.target_role, command_row.customer_id
  );
  select *
  into target_row
  from public.identity_provisioning_targets target
  where target.company_id = p_company_id
    and target.normalized_email = command_row.normalized_email
    and target.target_role = command_row.target_role
    and target.binding_customer_id = coalesce(
      command_row.customer_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  for update;
  if target_row.target_user_id is not null
    and target_row.target_user_id <> p_target_user_id
  then
    raise exception using message = 'IDENTITY_TARGET_USER_CONFLICT';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-identity-user:' || p_company_id::text || ':' || p_target_user_id::text,
    0
  ));
  select *
  into membership_row
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = p_target_user_id
  for update;
  if found and membership_row.role <> command_row.target_role then
    raise exception using message = 'IDENTITY_MEMBERSHIP_ROLE_CONFLICT';
  end if;

  -- Exact active owner/company recheck immediately before granting access.
  perform private.lock_storyops_identity_owner(
    p_company_id, p_actor_user_id
  );
  if membership_row.id is null then
    insert into public.company_memberships(
      company_id, user_id, role, active
    )
    values (
      p_company_id, p_target_user_id, command_row.target_role, true
    )
    returning * into membership_row;
  else
    update public.company_memberships
    set active = true
    where id = membership_row.id
    returning * into membership_row;
  end if;
  if command_row.target_role = 'customer' then
    insert into public.customer_portal_users(company_id, user_id, customer_id)
    values (p_company_id, p_target_user_id, command_row.customer_id)
    on conflict (company_id, user_id, customer_id) do nothing;
    portal_linked := true;
  end if;

  insert into public.identity_provisioning_targets(
    company_id, normalized_email, target_role, customer_id, target_user_id,
    status, delivery_status, outcome_code, external_delivery_claimed,
    invited_at, linked_at, revoked_at, last_command_id,
    created_by_user_id, updated_by_user_id
  )
  values (
    p_company_id, command_row.normalized_email, command_row.target_role,
    command_row.customer_id, p_target_user_id, 'linked', 'not_requested',
    'identity_linked', false, null, linked_at_value, null, p_command_id,
    p_actor_user_id, p_actor_user_id
  )
  on conflict (
    company_id, normalized_email, target_role, binding_customer_id
  )
  do update set
    target_user_id = excluded.target_user_id,
    status = 'linked',
    delivery_status = case
      when identity_provisioning_targets.delivery_status =
        'provider_submission_accepted'
      then identity_provisioning_targets.delivery_status
      else 'not_requested'
    end,
    outcome_code = 'identity_linked',
    linked_at = excluded.linked_at,
    revoked_at = null,
    last_command_id = excluded.last_command_id,
    updated_by_user_id = excluded.updated_by_user_id
  returning * into target_row;

  result := private.storyops_identity_receipt(
    command_row, target_row, true, portal_linked, false, linked_at_value
  );
  update public.identity_provisioning_commands
  set status = 'completed',
      target_id = target_row.id,
      response = result,
      completed_at = linked_at_value
  where id = command_row.id;
  insert into public.audit_events(
    company_id, occurred_at, actor_type, actor_id, action,
    entity_type, entity_id, after_data, request_id
  )
  values (
    p_company_id, linked_at_value, 'user', p_actor_user_id::text,
    'identity.linked', 'identity_provisioning_target', target_row.id,
    jsonb_build_object(
      'email', target_row.normalized_email,
      'role', target_row.target_role,
      'customerId', target_row.customer_id,
      'membershipActive', true,
      'portalLinked', portal_linked,
      'externalDeliveryClaimed', false
    ),
    p_command_id::text
  );
  return result;
end;
$$;

revoke all on function public.link_storyops_identity(
  uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.link_storyops_identity(
  uuid, uuid, uuid, text, uuid
) to service_role;

create or replace function public.revoke_storyops_identity(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_target_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  command_row public.identity_provisioning_commands%rowtype;
  target_row public.identity_provisioning_targets%rowtype;
  membership_row public.company_memberships%rowtype;
  effective_user_id uuid;
  auth_email text;
  revoked_at_value timestamptz := clock_timestamp();
  result jsonb;
  membership_active boolean := false;
  portal_was_linked boolean := false;
begin
  perform private.lock_storyops_identity_owner(
    p_company_id, p_actor_user_id
  );
  select *
  into command_row
  from public.identity_provisioning_commands command
  where command.company_id = p_company_id
    and command.command_id = p_command_id
  for update;
  if not found
    or command_row.actor_user_id <> p_actor_user_id
    or command_row.action <> 'revoke'
    or command_row.request_hash <> p_request_hash
  then
    raise exception using message = 'IDENTITY_REVOKE_NOT_AUTHORIZED';
  end if;
  if command_row.status = 'completed' then
    return command_row.response || jsonb_build_object('replayed', true);
  end if;

  select *
  into target_row
  from public.identity_provisioning_targets target
  where target.company_id = p_company_id
    and target.normalized_email = command_row.normalized_email
    and target.target_role = command_row.target_role
    and target.binding_customer_id = coalesce(
      command_row.customer_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  for update;
  -- A durable target is the authority for offboarding. If the provider email
  -- was changed or reused, revoke the recorded tenant binding rather than a
  -- newly resolved account that never received this access.
  effective_user_id := coalesce(target_row.target_user_id, p_target_user_id);
  if effective_user_id is not null then
    if target_row.target_user_id is null then
      select lower(btrim(user_row.email))
      into auth_email
      from auth.users user_row
      where user_row.id = effective_user_id;
      if auth_email is distinct from command_row.normalized_email then
        raise exception using message = 'IDENTITY_AUTH_EMAIL_MISMATCH';
      end if;
    end if;
    select *
    into membership_row
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = effective_user_id
    for update;
    if found and membership_row.role <> command_row.target_role then
      raise exception using message = 'IDENTITY_MEMBERSHIP_ROLE_CONFLICT';
    end if;
    if command_row.target_role = 'customer' then
      select exists (
        select 1
        from public.customer_portal_users portal
        where portal.company_id = p_company_id
          and portal.user_id = effective_user_id
          and portal.customer_id = command_row.customer_id
      )
      into portal_was_linked;
    end if;
  end if;

  -- Exact active owner/company recheck immediately before revoking access.
  perform private.lock_storyops_identity_owner(
    p_company_id, p_actor_user_id
  );
  if effective_user_id is not null and command_row.target_role = 'customer' then
    delete from public.customer_portal_users portal
    where portal.company_id = p_company_id
      and portal.user_id = effective_user_id
      and portal.customer_id = command_row.customer_id;
    if membership_row.id is not null
      and not exists (
        select 1
        from public.customer_portal_users portal
        where portal.company_id = p_company_id
          and portal.user_id = effective_user_id
      )
    then
      update public.company_memberships
      set active = false
      where id = membership_row.id;
    end if;
  elsif membership_row.id is not null then
    update public.company_memberships
    set active = false
    where id = membership_row.id;
  end if;

  insert into public.identity_provisioning_targets(
    company_id, normalized_email, target_role, customer_id, target_user_id,
    status, delivery_status, outcome_code, external_delivery_claimed,
    invited_at, linked_at, revoked_at, last_command_id,
    created_by_user_id, updated_by_user_id
  )
  values (
    p_company_id, command_row.normalized_email, command_row.target_role,
    command_row.customer_id, effective_user_id, 'revoked', 'not_requested',
    'identity_revoked', false, null, null, revoked_at_value, p_command_id,
    p_actor_user_id, p_actor_user_id
  )
  on conflict (
    company_id, normalized_email, target_role, binding_customer_id
  )
  do update set
    target_user_id = coalesce(
      excluded.target_user_id,
      identity_provisioning_targets.target_user_id
    ),
    status = 'revoked',
    delivery_status = 'not_requested',
    outcome_code = 'identity_revoked',
    revoked_at = excluded.revoked_at,
    last_command_id = excluded.last_command_id,
    updated_by_user_id = excluded.updated_by_user_id
  returning * into target_row;

  if effective_user_id is not null then
    select exists (
      select 1
      from public.company_memberships membership
      where membership.company_id = p_company_id
        and membership.user_id = effective_user_id
        and membership.active
        and membership.role = command_row.target_role
    )
    into membership_active;
  end if;
  result := private.storyops_identity_receipt(
    command_row, target_row, membership_active, false,
    false, revoked_at_value
  );
  update public.identity_provisioning_commands
  set status = 'completed',
      target_id = target_row.id,
      response = result,
      completed_at = revoked_at_value
  where id = command_row.id;
  insert into public.audit_events(
    company_id, occurred_at, actor_type, actor_id, action,
    entity_type, entity_id, before_data, after_data, request_id
  )
  values (
    p_company_id, revoked_at_value, 'user', p_actor_user_id::text,
    'identity.revoked', 'identity_provisioning_target', target_row.id,
    jsonb_build_object(
      'membershipActive', coalesce(membership_row.active, false),
      'portalLinked', portal_was_linked
    ),
    jsonb_build_object(
      'email', target_row.normalized_email,
      'role', target_row.target_role,
      'customerId', target_row.customer_id,
      'membershipActive', membership_active,
      'portalLinked', false,
      'externalDeliveryClaimed', false
    ),
    p_command_id::text
  );
  return result;
end;
$$;

revoke all on function public.revoke_storyops_identity(
  uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.revoke_storyops_identity(
  uuid, uuid, uuid, text, uuid
) to service_role;

create or replace function public.load_storyops_identity_provisioning_state(
  p_company_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  company_status text;
  targets jsonb;
  customers jsonb;
begin
  company_status := private.assert_storyops_identity_owner(
    p_company_id, p_actor_user_id, false
  );
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', target.id,
      'email', target.normalized_email,
      'role', target.target_role,
      'customerId', target.customer_id,
      'customerDisplayName', customer.display_name,
      'status', target.status,
      'deliveryStatus', target.delivery_status,
      'outcomeCode', target.outcome_code,
      'membershipActive', exists (
        select 1
        from public.company_memberships membership
        where membership.company_id = target.company_id
          and membership.user_id = target.target_user_id
          and membership.role = target.target_role
          and membership.active
      ),
      'portalLinked', target.target_role = 'customer' and exists (
        select 1
        from public.customer_portal_users portal
        where portal.company_id = target.company_id
          and portal.user_id = target.target_user_id
          and portal.customer_id = target.customer_id
      ),
      'invitedAt', target.invited_at,
      'linkedAt', target.linked_at,
      'revokedAt', target.revoked_at,
      'updatedAt', target.updated_at
    )
    order by target.updated_at desc, target.id
  ), '[]'::jsonb)
  into targets
  from (
    select *
    from public.identity_provisioning_targets target
    where target.company_id = p_company_id
    order by target.updated_at desc, target.id
    limit 200
  ) target
  left join public.customers customer
    on customer.company_id = target.company_id
   and customer.id = target.customer_id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', customer.id,
      'displayName', customer.display_name
    )
    order by lower(customer.display_name), customer.id
  ), '[]'::jsonb)
  into customers
  from (
    select id, display_name
    from public.customers customer
    where customer.company_id = p_company_id
      and customer.lifecycle <> 'blocked'
    order by lower(customer.display_name), customer.id
    limit 500
  ) customer;

  return jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-state-v1',
    'companyId', p_company_id,
    'companyStatus', company_status,
    'customers', customers,
    'targets', targets,
    'serverTime', now()
  );
end;
$$;

revoke all on function public.load_storyops_identity_provisioning_state(
  uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_identity_provisioning_state(
  uuid, uuid
) to service_role;

comment on table public.identity_provisioning_targets is
  'Exact company/email/role/customer identity bindings. Delivery status records provider submission only and never inbox delivery.';
comment on table public.identity_provisioning_commands is
  'Full-request-hashed, owner-requested identity provisioning commands. Base-table access is denied to browser and service roles.';
comment on function public.authorize_storyops_identity_invite(
  uuid, uuid, uuid, text
) is
  'Final active-company and active-owner recheck immediately before the Edge function may call the Supabase Admin invite API.';
comment on function public.link_storyops_identity(
  uuid, uuid, uuid, text, uuid
) is
  'Atomically links one confirmed exact auth email to one permitted company role and optional exact customer portal binding.';
comment on function public.revoke_storyops_identity(
  uuid, uuid, uuid, text, uuid
) is
  'Atomically revokes the exact tenant membership or customer portal binding without deleting a possibly shared auth identity.';
