-- Identity invitation submission authority is scoped to the provider identity
-- email within the company, not to one idempotency command or local binding.
-- Two command IDs for the same company/email must never independently reach
-- the external invitation provider while an earlier attempt is unresolved.
-- Role/customer remain recorded as the local binding requested by the
-- provider-owning command, but do not create a second provider authority.

create table public.identity_invitation_attempts (
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
  customer_id uuid references public.customers(id) on delete restrict,
  binding_customer_id uuid generated always as (
    coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) stored,
  provider_command_record_id uuid not null
    references public.identity_provisioning_commands(id) on delete restrict,
  provider_command_id uuid not null,
  provider_request_hash text not null
    check (provider_request_hash ~ '^[a-f0-9]{64}$'),
  status text not null
    check (status in (
      'pending',
      'provider_submission_accepted',
      'provider_submission_failed',
      'provider_submission_unknown',
      'reconciled',
      'expired'
    )),
  authorized_at timestamptz not null,
  observed_at timestamptz,
  expires_at timestamptz not null,
  reconciled_at timestamptz,
  reconciliation_basis text
    check (reconciliation_basis is null or reconciliation_basis in (
      'directory_identity_observed',
      'identity_linked',
      'identity_revoked',
      'authority_expired',
      'migration_expired'
    )),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  version integer not null default 1 check (version > 0),
  check (
    (target_role = 'customer' and customer_id is not null)
    or (target_role in ('dispatcher', 'technician') and customer_id is null)
  ),
  check (expires_at > authorized_at),
  check (
    (
      status in (
        'pending',
        'provider_submission_accepted',
        'provider_submission_failed',
        'provider_submission_unknown'
      )
      and reconciled_at is null
      and reconciliation_basis is null
    )
    or (
      status in ('reconciled', 'expired')
      and reconciled_at is not null
      and reconciliation_basis is not null
    )
  )
);

create index identity_invitation_attempts_company_time_idx
  on public.identity_invitation_attempts(company_id, authorized_at desc, id);

alter table public.identity_invitation_attempts enable row level security;
alter table public.identity_invitation_attempts force row level security;
revoke all on public.identity_invitation_attempts
  from public, anon, authenticated, service_role;

alter table public.identity_provisioning_commands
  add column invitation_attempt_id uuid
    references public.identity_invitation_attempts(id) on delete set null;

-- Preserve already-authorized commands from an upgraded deployment. One
-- conservative target authority is synthesized for each logical tuple. Any
-- incomplete or unknown legacy observation stays unknown; an accepted
-- observation stays accepted; only a known provider rejection is releasable.
with authorized_command as (
  select
    command.*,
    command.response ->> 'deliveryStatus' as delivery_status
  from public.identity_provisioning_commands command
  where command.action = 'invite'
    and command.invite_attempt_authorized_at is not null
),
authority_summary as (
  select
    company_id,
    normalized_email,
    (array_agg(target_role order by invite_attempt_authorized_at, created_at, id))[1]
      as target_role,
    (array_agg(customer_id order by invite_attempt_authorized_at, created_at, id))[1]
      as customer_id,
    (array_agg(id order by invite_attempt_authorized_at, created_at, id))[1]
      as provider_command_record_id,
    (array_agg(command_id order by invite_attempt_authorized_at, created_at, id))[1]
      as provider_command_id,
    (array_agg(request_hash order by invite_attempt_authorized_at, created_at, id))[1]
      as provider_request_hash,
    min(invite_attempt_authorized_at) as authorized_at,
    max(coalesce(completed_at, invite_attempt_authorized_at)) as observed_at,
    max(invite_attempt_authorized_at) + interval '7 days' as expires_at,
    bool_or(
      status = 'pending'
      or response is null
      or delivery_status = 'provider_submission_unknown'
    ) as has_unknown,
    bool_or(delivery_status = 'provider_submission_accepted') as has_accepted
  from authorized_command
  group by
    company_id,
    normalized_email
)
insert into public.identity_invitation_attempts(
  company_id,
  normalized_email,
  target_role,
  customer_id,
  provider_command_record_id,
  provider_command_id,
  provider_request_hash,
  status,
  authorized_at,
  observed_at,
  expires_at,
  reconciled_at,
  reconciliation_basis
)
select
  summary.company_id,
  summary.normalized_email,
  summary.target_role,
  summary.customer_id,
  summary.provider_command_record_id,
  summary.provider_command_id,
  summary.provider_request_hash,
  case
    when summary.expires_at <= clock_timestamp() then 'expired'
    when summary.has_unknown then 'provider_submission_unknown'
    when summary.has_accepted then 'provider_submission_accepted'
    else 'provider_submission_failed'
  end,
  summary.authorized_at,
  summary.observed_at,
  summary.expires_at,
  case
    when summary.expires_at <= clock_timestamp() then clock_timestamp()
    else null
  end,
  case
    when summary.expires_at <= clock_timestamp() then 'migration_expired'
    else null
  end
from authority_summary summary;

update public.identity_provisioning_commands command
set invitation_attempt_id = attempt.id
from public.identity_invitation_attempts attempt
where command.action = 'invite'
  and command.invite_attempt_authorized_at is not null
  and attempt.company_id = command.company_id
  and attempt.normalized_email = command.normalized_email;

create unique index
  identity_invitation_attempts_one_unresolved_email_idx
on public.identity_invitation_attempts(
  company_id,
  normalized_email
)
where status in (
  'pending',
  'provider_submission_accepted',
  'provider_submission_unknown'
);

create trigger identity_invitation_attempts_touch
before update on public.identity_invitation_attempts
for each row execute function public.touch_record();

create trigger storyops_active_company_mutation_gate
before insert or update or delete on public.identity_invitation_attempts
for each row execute function
  public.assert_active_company_for_authenticated_mutation();

create or replace function
  private.claim_storyops_identity_invitation_attempt(
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
  attempt_row public.identity_invitation_attempts%rowtype;
  expired_row public.identity_invitation_attempts%rowtype;
  authorized_at_value timestamptz := clock_timestamp();
begin
  perform private.assert_storyops_identity_service();
  perform private.lock_storyops_identity_owner(
    p_company_id,
    p_actor_user_id
  );

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-identity-command:' || p_company_id::text
      || ':' || p_command_id::text,
    0
  ));
  select *
  into command_row
  from public.identity_provisioning_commands command
  where command.company_id = p_company_id
    and command.command_id = p_command_id;
  if not found
    or command_row.actor_user_id <> p_actor_user_id
    or command_row.action <> 'invite'
    or command_row.request_hash <> p_request_hash
    or command_row.status <> 'pending'
  then
    raise exception using message = 'IDENTITY_INVITE_NOT_AUTHORIZED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-identity:' || command_row.company_id::text
      || ':' || command_row.normalized_email,
    0
  ));
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
  perform private.lock_storyops_identity_owner(
    p_company_id,
    p_actor_user_id
  );

  for expired_row in
    update public.identity_invitation_attempts attempt
    set
      status = 'expired',
      reconciled_at = authorized_at_value,
      reconciliation_basis = 'authority_expired'
    where attempt.company_id = command_row.company_id
      and attempt.normalized_email = command_row.normalized_email
      and attempt.status in (
        'pending',
        'provider_submission_accepted',
        'provider_submission_unknown'
      )
      and attempt.expires_at <= authorized_at_value
    returning *
  loop
    insert into public.audit_events(
      company_id,
      occurred_at,
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      after_data,
      request_id
    )
    values (
      expired_row.company_id,
      authorized_at_value,
      'system',
      'identity-invitation-authority',
      'identity.invite.attempt.expired',
      'identity_invitation_attempt',
      expired_row.id,
      jsonb_build_object(
        'email', expired_row.normalized_email,
        'role', expired_row.target_role,
        'customerId', expired_row.customer_id,
        'priorProviderCommandId', expired_row.provider_command_id,
        'reconciliationBasis', 'authority_expired'
      ),
      p_command_id::text
    );
  end loop;

  select *
  into attempt_row
  from public.identity_invitation_attempts attempt
  where attempt.company_id = command_row.company_id
    and attempt.normalized_email = command_row.normalized_email
    and attempt.status in (
      'pending',
      'provider_submission_accepted',
      'provider_submission_unknown'
    )
  for update;

  if found then
    update public.identity_provisioning_commands
    set
      invite_attempt_authorized_at = coalesce(
        invite_attempt_authorized_at,
        attempt_row.authorized_at
      ),
      invitation_attempt_id = attempt_row.id
    where id = command_row.id
    returning * into command_row;

    insert into public.audit_events(
      company_id,
      occurred_at,
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      after_data,
      request_id
    )
    values (
      command_row.company_id,
      authorized_at_value,
      'user',
      p_actor_user_id::text,
      'identity.invite.attempt.blocked',
      'identity_invitation_attempt',
      attempt_row.id,
      jsonb_build_object(
        'email', command_row.normalized_email,
        'role', command_row.target_role,
        'customerId', command_row.customer_id,
        'providerCommandId', attempt_row.provider_command_id,
        'blockedCommandId', command_row.command_id,
        'authorityStatus', attempt_row.status
      ),
      command_row.command_id::text
    );

    return jsonb_build_object(
      'authorized', true,
      'attemptAlreadyAuthorized', true,
      'companyId', command_row.company_id,
      'commandId', command_row.command_id,
      'requestHash', command_row.request_hash,
      'email', command_row.normalized_email,
      'role', command_row.target_role
    );
  end if;

  insert into public.identity_invitation_attempts(
    company_id,
    normalized_email,
    target_role,
    customer_id,
    provider_command_record_id,
    provider_command_id,
    provider_request_hash,
    status,
    authorized_at,
    expires_at
  )
  values (
    command_row.company_id,
    command_row.normalized_email,
    command_row.target_role,
    command_row.customer_id,
    command_row.id,
    command_row.command_id,
    command_row.request_hash,
    'pending',
    authorized_at_value,
    authorized_at_value + interval '7 days'
  )
  returning * into attempt_row;

  update public.identity_provisioning_commands
  set
    invite_attempt_authorized_at = authorized_at_value,
    invitation_attempt_id = attempt_row.id
  where id = command_row.id
  returning * into command_row;

  insert into public.audit_events(
    company_id,
    occurred_at,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data,
    request_id
  )
  values (
    command_row.company_id,
    authorized_at_value,
    'user',
    p_actor_user_id::text,
    'identity.invite.attempt.authorized',
    'identity_invitation_attempt',
    attempt_row.id,
    jsonb_build_object(
      'email', command_row.normalized_email,
      'role', command_row.target_role,
      'customerId', command_row.customer_id,
      'providerCommandId', command_row.command_id,
      'authorityStatus', attempt_row.status,
      'expiresAt', attempt_row.expires_at
    ),
    command_row.command_id::text
  );

  return jsonb_build_object(
    'authorized', true,
    'attemptAlreadyAuthorized', false,
    'companyId', command_row.company_id,
    'commandId', command_row.command_id,
    'requestHash', command_row.request_hash,
    'email', command_row.normalized_email,
    'role', command_row.target_role
  );
end;
$$;

revoke all on function
  private.claim_storyops_identity_invitation_attempt(
    uuid, uuid, uuid, text
  )
  from public, anon, authenticated, service_role;

create or replace function public.authorize_storyops_identity_invite(
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
begin
  perform private.lock_storyops_identity_owner(
    p_company_id,
    p_actor_user_id
  );
  select *
  into command_row
  from public.identity_provisioning_commands command
  where command.company_id = p_company_id
    and command.command_id = p_command_id;
  if not found
    or command_row.actor_user_id <> p_actor_user_id
    or command_row.action <> 'invite'
    or command_row.request_hash <> p_request_hash
    or command_row.status <> 'pending'
    or p_deployment_fingerprint !~ '^[a-f0-9]{64}$'
  then
    raise exception using message = 'IDENTITY_INVITE_NOT_AUTHORIZED';
  end if;

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

  return private.claim_storyops_identity_invitation_attempt(
    p_company_id,
    p_actor_user_id,
    p_command_id,
    p_request_hash
  );
end;
$$;

revoke all on function public.authorize_storyops_identity_invite(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.authorize_storyops_identity_invite(
  uuid, uuid, uuid, text, text
) to service_role;

create or replace function
  private.sync_storyops_identity_invitation_attempt()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  attempt_row public.identity_invitation_attempts%rowtype;
  prior_status text;
  next_status text;
  outcome_code_value text := new.response ->> 'outcomeCode';
  delivery_status_value text := new.response ->> 'deliveryStatus';
begin
  if old.status = 'completed' or new.status <> 'completed' then
    return new;
  end if;

  if new.action = 'invite'
    and new.invitation_attempt_id is not null
    and delivery_status_value in (
      'provider_submission_accepted',
      'provider_submission_failed',
      'provider_submission_unknown'
    )
  then
    select *
    into attempt_row
    from public.identity_invitation_attempts attempt
    where attempt.id = new.invitation_attempt_id
    for update;

    if found and attempt_row.provider_command_id = new.command_id then
      next_status := delivery_status_value;
      prior_status := attempt_row.status;
      if prior_status in ('pending', 'provider_submission_unknown')
        and prior_status is distinct from next_status
      then
        update public.identity_invitation_attempts
        set
          status = next_status,
          observed_at = clock_timestamp(),
          expires_at = greatest(
            expires_at,
            clock_timestamp() + interval '7 days'
          )
        where id = attempt_row.id
        returning * into attempt_row;

        insert into public.audit_events(
          company_id,
          occurred_at,
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
          new.company_id,
          clock_timestamp(),
          'user',
          new.actor_user_id::text,
          'identity.invite.attempt.observed',
          'identity_invitation_attempt',
          attempt_row.id,
          jsonb_build_object('authorityStatus', prior_status),
          jsonb_build_object(
            'authorityStatus', attempt_row.status,
            'deliveryStatus', delivery_status_value,
            'externalDeliveryClaimed', false
          ),
          new.command_id::text
        );
      end if;
    end if;
  end if;

  if outcome_code_value in (
    'existing_identity_requires_link',
    'identity_linked',
    'identity_revoked'
  ) then
    for attempt_row in
      update public.identity_invitation_attempts attempt
      set
        status = 'reconciled',
        reconciled_at = clock_timestamp(),
        reconciliation_basis = case outcome_code_value
          when 'existing_identity_requires_link'
            then 'directory_identity_observed'
          when 'identity_linked' then 'identity_linked'
          else 'identity_revoked'
        end
      where attempt.company_id = new.company_id
        and attempt.normalized_email = new.normalized_email
        and attempt.status in (
          'pending',
          'provider_submission_accepted',
          'provider_submission_unknown'
        )
      returning *
    loop
      insert into public.audit_events(
        company_id,
        occurred_at,
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        after_data,
        request_id
      )
      values (
        new.company_id,
        clock_timestamp(),
        'user',
        new.actor_user_id::text,
        'identity.invite.attempt.reconciled',
        'identity_invitation_attempt',
        attempt_row.id,
        jsonb_build_object(
          'email', attempt_row.normalized_email,
          'role', attempt_row.target_role,
          'customerId', attempt_row.customer_id,
          'reconciliationBasis', attempt_row.reconciliation_basis,
          'externalDeliveryClaimed', false
        ),
        new.command_id::text
      );
    end loop;
  end if;

  return new;
end;
$$;

revoke all on function
  private.sync_storyops_identity_invitation_attempt()
  from public, anon, authenticated, service_role;

create trigger identity_provisioning_commands_invitation_attempt
after update on public.identity_provisioning_commands
for each row execute function
  private.sync_storyops_identity_invitation_attempt();

create or replace function
  public.record_storyops_identity_invite_blocked(
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
  attempt_row public.identity_invitation_attempts%rowtype;
  completed_at_value timestamptz := clock_timestamp();
  result jsonb;
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
    or command_row.action <> 'invite'
    or command_row.request_hash <> p_request_hash
  then
    raise exception using message = 'IDENTITY_INVITE_NOT_AUTHORIZED';
  end if;
  if command_row.status = 'completed' then
    return command_row.response || jsonb_build_object('replayed', true);
  end if;
  if command_row.invite_attempt_authorized_at is null
    or command_row.invitation_attempt_id is null
  then
    raise exception using
      message = 'IDENTITY_INVITE_ATTEMPT_NOT_AUTHORIZED';
  end if;

  select *
  into attempt_row
  from public.identity_invitation_attempts attempt
  where attempt.id = command_row.invitation_attempt_id
    and attempt.company_id = command_row.company_id
    and attempt.normalized_email = command_row.normalized_email
  for update;
  if not found then
    raise exception using
      message = 'IDENTITY_INVITE_ATTEMPT_NOT_AUTHORIZED';
  end if;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-receipt-v1',
    'companyId', command_row.company_id,
    'commandId', command_row.command_id,
    'requestHash', command_row.request_hash,
    'action', command_row.action,
    'email', command_row.normalized_email,
    'role', command_row.target_role,
    'customerId', command_row.customer_id,
    'status', 'pending',
    'deliveryStatus', 'provider_submission_unknown',
    'externalDeliveryClaimed', false,
    'membershipActive', false,
    'portalLinked', false,
    'outcomeCode', 'invite_submission_unknown',
    'replayed', false,
    'serverTime', completed_at_value
  );

  update public.identity_provisioning_commands
  set
    status = 'completed',
    response = result,
    completed_at = completed_at_value
  where id = command_row.id;

  insert into public.audit_events(
    company_id,
    occurred_at,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data,
    request_id
  )
  values (
    command_row.company_id,
    completed_at_value,
    'user',
    p_actor_user_id::text,
    'identity.invite.submission_blocked_by_target_authority',
    'identity_invitation_attempt',
    attempt_row.id,
    jsonb_build_object(
      'email', command_row.normalized_email,
      'role', command_row.target_role,
      'customerId', command_row.customer_id,
      'providerCommandId', attempt_row.provider_command_id,
      'blockedCommandId', command_row.command_id,
      'authorityStatus', attempt_row.status,
      'deliveryStatus', 'provider_submission_unknown',
      'externalDeliveryClaimed', false
    ),
    command_row.command_id::text
  );

  return result;
end;
$$;

revoke all on function
  public.record_storyops_identity_invite_blocked(
    uuid, uuid, uuid, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.record_storyops_identity_invite_blocked(
    uuid, uuid, uuid, text
  )
  to service_role;

create or replace function
  public.load_storyops_identity_invitation_attempt_state(
    p_company_id uuid,
    p_actor_user_id uuid
  )
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  company_status_value text;
  unresolved_attempts jsonb;
begin
  company_status_value := private.assert_storyops_identity_owner(
    p_company_id,
    p_actor_user_id,
    false
  );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', attempt.id,
        'email', attempt.normalized_email,
        'originatingRole', attempt.target_role,
        'originatingCustomerId', attempt.customer_id,
        'providerCommandId', attempt.provider_command_id,
        'authorityStatus', attempt.status,
        'authorizedAt', attempt.authorized_at,
        'observedAt', attempt.observed_at,
        'expiresAt', attempt.expires_at,
        'retryEligible', attempt.expires_at <= clock_timestamp(),
        'reconciliationRequired', true
      )
      order by attempt.authorized_at, attempt.id
    ),
    '[]'::jsonb
  )
  into unresolved_attempts
  from (
    select *
    from public.identity_invitation_attempts attempt
    where attempt.company_id = p_company_id
      and attempt.status in (
        'pending',
        'provider_submission_accepted',
        'provider_submission_unknown'
      )
    order by attempt.authorized_at, attempt.id
    limit 200
  ) attempt;

  return jsonb_build_object(
    'schemaVersion',
      'storyops-identity-invitation-attempt-state-v1',
    'companyId', p_company_id,
    'companyStatus', company_status_value,
    'unresolvedAttempts', unresolved_attempts,
    'serverTime', clock_timestamp()
  );
end;
$$;

revoke all on function
  public.load_storyops_identity_invitation_attempt_state(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.load_storyops_identity_invitation_attempt_state(uuid, uuid)
  to service_role;

comment on table public.identity_invitation_attempts is
  'Durable one-at-a-time provider submission authority for one company/email provider identity. The provider-owning local role/customer binding is recorded, while pending, accepted, and unknown attempts block every same-email command until trusted reconciliation or expiry.';
comment on function
  private.claim_storyops_identity_invitation_attempt(
    uuid, uuid, uuid, text
  ) is
  'Atomically claims or reuses one unresolved company/email identity invitation authority under the provider identity email lock.';
comment on function public.authorize_storyops_identity_invite(
  uuid, uuid, uuid, text, text
) is
  'Reasserts deployment-bound provider and launch authority, then atomically claims the company/email provider identity before Edge may call Supabase Auth.';
comment on function
  public.record_storyops_identity_invite_blocked(
    uuid, uuid, uuid, text
  ) is
  'Completes a command conservatively without changing target truth when another unresolved same-email invitation attempt already owns provider submission authority.';
comment on function
  public.load_storyops_identity_invitation_attempt_state(uuid, uuid)
  is
  'Owner-scoped projection of unresolved same-email provider authority, age, observed status, and deterministic retry eligibility without exposing base-table access.';
