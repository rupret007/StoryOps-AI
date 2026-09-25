-- Transactional quote-delivery and on-my-way communication lifecycle.
--
-- Portal publication, durable queueing, provider submission, and verified
-- delivery are deliberately separate facts. Browser roles can request one
-- finite message from current server facts, but provider evidence is writable
-- only through the trusted worker/webhook paths.

create table public.transactional_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  action_type text not null
    check (action_type in ('quote_delivery', 'on_my_way')),
  quote_id uuid references public.quotes(id) on delete restrict,
  visit_id uuid references public.visits(id) on delete restrict,
  entity_version integer not null check (entity_version > 0),
  customer_id uuid not null references public.customers(id) on delete restrict,
  channel text not null check (channel in ('sms', 'email')),
  consent_record_id uuid not null
    references public.consent_records(id) on delete restrict,
  communication_message_id uuid not null
    references public.communication_messages(id) on delete restrict,
  command_id uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'queued'
    check (
      status in (
        'queued',
        'submitting',
        'submitted',
        'submitted_unknown',
        'delivered',
        'sandboxed',
        'failed',
        'cancelled'
      )
    ),
  provider_mode text
    check (provider_mode is null or provider_mode in ('sandbox', 'live')),
  provider_name text
    check (
      provider_name is null
      or length(btrim(provider_name)) between 1 and 80
    ),
  provider_status text
    check (
      provider_status is null
      or provider_status in (
        'accepted',
        'queued',
        'sent',
        'delivered',
        'failed',
        'submission_unknown',
        'sandbox_recorded'
      )
    ),
  provider_message_id text
    check (
      provider_message_id is null
      or length(btrim(provider_message_id)) between 1 and 255
    ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  reconciliation_count integer not null default 0
    check (reconciliation_count >= 0),
  max_attempts integer not null default 6 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  last_error_code text
    check (
      last_error_code is null
      or length(btrim(last_error_code)) between 1 and 120
    ),
  claimed_by uuid,
  claim_token uuid,
  claim_operation text
    check (claim_operation is null or claim_operation in ('send', 'reconcile')),
  claim_expires_at timestamptz,
  requested_by_user_id uuid not null references auth.users(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  constraint transactional_delivery_attempts_entity_check check (
    (
      action_type = 'quote_delivery'
      and quote_id is not null
      and visit_id is null
    )
    or (
      action_type = 'on_my_way'
      and quote_id is null
      and visit_id is not null
    )
  ),
  constraint transactional_delivery_attempts_claim_check check (
    num_nonnulls(claimed_by, claim_token, claim_operation, claim_expires_at)
      in (0, 4)
  ),
  constraint transactional_delivery_attempts_completion_check check (
    (
      status in ('delivered', 'sandboxed', 'failed', 'cancelled')
      and completed_at is not null
    )
    or (
      status not in ('delivered', 'sandboxed', 'failed', 'cancelled')
      and completed_at is null
    )
  ),
  unique (company_id, command_id),
  unique (communication_message_id)
);

create unique index transactional_delivery_quote_channel_idx
  on public.transactional_delivery_attempts(company_id, quote_id)
  where action_type = 'quote_delivery'
    and status not in ('failed', 'cancelled');

create unique index transactional_delivery_visit_channel_idx
  on public.transactional_delivery_attempts(company_id, visit_id)
  where action_type = 'on_my_way'
    and status not in ('failed', 'cancelled');

create index transactional_delivery_queue_idx
  on public.transactional_delivery_attempts(
    next_attempt_at,
    created_at,
    company_id
  )
  where status in ('queued', 'submitted');

create index transactional_delivery_expired_submission_idx
  on public.transactional_delivery_attempts(
    claim_expires_at,
    created_at,
    company_id
  )
  where status = 'submitting';

alter table public.transactional_delivery_attempts enable row level security;
alter table public.transactional_delivery_attempts force row level security;

revoke all on table public.transactional_delivery_attempts
  from public, anon, authenticated, service_role;
grant select on table public.transactional_delivery_attempts to authenticated;

create policy transactional_delivery_staff_select
  on public.transactional_delivery_attempts
  for select
  using (
    public.has_company_role(
      company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
    or (
      action_type = 'on_my_way'
      and visit_id is not null
      and public.is_assigned_technician_for_visit(visit_id)
    )
  );

create trigger transactional_delivery_attempts_touch
  before update on public.transactional_delivery_attempts
  for each row execute function public.touch_record();

create trigger storyops_active_company_mutation_gate
  before insert or update or delete on public.transactional_delivery_attempts
  for each row execute function
    public.assert_active_company_for_authenticated_mutation();

create or replace function public.protect_transactional_delivery_message()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1
    from public.transactional_delivery_attempts attempt
    where attempt.communication_message_id = old.id
  )
    and (
      new.company_id is distinct from old.company_id
      or new.thread_id is distinct from old.thread_id
      or new.channel is distinct from old.channel
      or new.direction is distinct from old.direction
      or new.sender is distinct from old.sender
      or new.recipients is distinct from old.recipients
      or new.body is distinct from old.body
      or new.risk_class is distinct from old.risk_class
      or new.consent_record_id is distinct from old.consent_record_id
      or new.sent_by_user_id is distinct from old.sent_by_user_id
      or new.sent_by_agent is distinct from old.sent_by_agent
      or new.approval_request_id is distinct from old.approval_request_id
    )
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_MESSAGE_TRUSTED_PATH_REQUIRED';
  end if;
  return new;
end;
$$;

revoke all on function public.protect_transactional_delivery_message()
  from public, anon, authenticated, service_role;

create trigger communication_messages_transactional_delivery_guard
  before update on public.communication_messages
  for each row execute function public.protect_transactional_delivery_message();

create or replace function public.queue_storyops_transactional_delivery(
  p_company_id uuid,
  p_command_id uuid,
  p_action_type text,
  p_entity_id uuid,
  p_expected_version integer,
  p_channel text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  inserted_reservation_id uuid;
  company_row public.companies%rowtype;
  customer_row public.customers%rowtype;
  quote_row public.quotes%rowtype;
  visit_row public.visits%rowtype;
  consent_row public.consent_records%rowtype;
  normalized_recipient text;
  contact_digits text;
  contact_fingerprint text;
  outbound_decision record;
  subject_value text;
  body_value text;
  thread_id_value uuid;
  message_id_value uuid;
  attempt_id_value uuid;
  response_value jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_AUTHENTICATION_REQUIRED';
  end if;
  if p_company_id is null
    or p_command_id is null
    or p_entity_id is null
    or p_expected_version is null
    or p_expected_version <= 0
    or p_action_type not in ('quote.delivery', 'visit.on_my_way')
    or p_channel not in ('sms', 'email')
    or p_request_hash is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_INVALID_COMMAND';
  end if;

  effective_request_hash := encode(
    extensions.digest(
      p_action_type || '|' || p_entity_id::text || '|'
        || p_expected_version::text || '|' || p_channel,
      'sha256'
    ),
    'hex'
  );
  if effective_request_hash <> p_request_hash then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_REQUEST_HASH_MISMATCH';
  end if;

  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role is null then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_MEMBERSHIP_REQUIRED';
  end if;

  select company.*
  into company_row
  from public.companies company
  where company.id = p_company_id
  for share;
  if not found or company_row.status <> 'active' then
    raise exception using message = 'STORYOPS_COMPANY_NOT_ACTIVE';
  end if;

  insert into public.idempotency_keys(
    company_id,
    scope,
    key,
    request_hash,
    expires_at
  )
  values (
    p_company_id,
    'transactional-delivery-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into inserted_reservation_id;

  if inserted_reservation_id is null then
    select key_row.*
    into reservation
    from public.idempotency_keys key_row
    where key_row.company_id = p_company_id
      and key_row.scope = 'transactional-delivery-v1'
      and key_row.key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception using message =
        'TRANSACTIONAL_DELIVERY_IDEMPOTENCY_CONFLICT';
    end if;
    if reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_ALREADY_IN_PROGRESS';
  end if;

  if p_action_type = 'quote.delivery' then
    if actor_role not in ('owner', 'dispatcher') then
      raise exception using message =
        'TRANSACTIONAL_DELIVERY_BACKOFFICE_REQUIRED';
    end if;
    select quote.*
    into quote_row
    from public.quotes quote
    where quote.id = p_entity_id
      and quote.company_id = p_company_id
    for update;
    if not found
      or quote_row.version <> p_expected_version
      or quote_row.status not in ('sent', 'viewed')
      or quote_row.portal_published_at is null
      or quote_row.valid_until < current_date
    then
      raise exception using message =
        'TRANSACTIONAL_DELIVERY_QUOTE_NOT_PUBLISHED_OR_STALE';
    end if;
    select customer.*
    into customer_row
    from public.customers customer
    where customer.id = quote_row.customer_id
      and customer.company_id = p_company_id
      and customer.lifecycle = 'active'
    for share;
    subject_value := 'Quote ' || quote_row.quote_number || ' is ready';
    body_value := 'Your quote ' || quote_row.quote_number
      || ' is ready in your WashOps customer portal. '
      || 'Review the exact scope, price, and terms there before accepting.';
  else
    if actor_role not in ('owner', 'dispatcher', 'technician') then
      raise exception using message =
        'TRANSACTIONAL_DELIVERY_FIELD_ROLE_REQUIRED';
    end if;
    select visit.*
    into visit_row
    from public.visits visit
    where visit.id = p_entity_id
      and visit.company_id = p_company_id
    for update;
    if not found
      or visit_row.version <> p_expected_version
      or visit_row.status <> 'en_route'
      or visit_row.ends_at <= now()
      or visit_row.starts_at < now() - interval '12 hours'
      or visit_row.starts_at > now() + interval '24 hours'
      or (
        actor_role = 'technician'
        and not public.is_assigned_technician_for_visit(visit_row.id)
      )
    then
      raise exception using message =
        'TRANSACTIONAL_DELIVERY_VISIT_NOT_CURRENT_EN_ROUTE';
    end if;
    select customer.*
    into customer_row
    from public.jobs job
    join public.customers customer
      on customer.id = job.customer_id
     and customer.company_id = job.company_id
    where job.id = visit_row.job_id
      and job.company_id = p_company_id
      and customer.lifecycle = 'active'
    for share of customer;
    subject_value := 'Your WashOps crew is on the way';
    body_value := 'Your WashOps crew is on the way for the scheduled visit. '
      || 'This message does not promise an arrival time; check the customer '
      || 'portal or contact the office if access conditions changed.';
  end if;

  if not found or customer_row.do_not_contact then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_CONTACT_SUPPRESSED';
  end if;

  if p_channel = 'email' then
    normalized_recipient := nullif(lower(btrim(customer_row.email::text)), '');
  else
    contact_digits := regexp_replace(
      coalesce(customer_row.phone, ''),
      '[^0-9]',
      '',
      'g'
    );
    normalized_recipient := case
      when length(contact_digits) = 10 then '+1' || contact_digits
      when length(contact_digits) = 11 and left(contact_digits, 1) = '1'
        then '+' || contact_digits
      when left(btrim(coalesce(customer_row.phone, '')), 1) = '+'
        and length(contact_digits) >= 8
        then '+' || contact_digits
      else null
    end;
  end if;
  if normalized_recipient is null then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_CONTACT_UNAVAILABLE';
  end if;

  select consent.*
  into consent_row
  from public.consent_records consent
  where consent.company_id = p_company_id
    and consent.customer_id = customer_row.id
    and consent.channel = p_channel
    and consent.purpose = 'transactional'
  order by
    consent.created_at desc,
    consent.captured_at desc,
    case when consent.status = 'granted' then 0 else 1 end desc,
    consent.id desc
  limit 1;
  if not found
    or consent_row.status <> 'granted'
    or consent_row.withdrawn_at is not null
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_CONSENT_NOT_GRANTED';
  end if;

  contact_fingerprint := encode(
    extensions.digest(normalized_recipient, 'sha256'),
    'hex'
  );
  select *
  into outbound_decision
  from public.authorize_outbound_contact(
    p_company_id,
    p_channel,
    'transactional',
    contact_fingerprint,
    consent_row.id
  );
  if not coalesce(outbound_decision.allowed, false)
    or outbound_decision.decision_code <> 'ALLOWED'
    or outbound_decision.consent_record_id <> consent_row.id
    or outbound_decision.latest_consent_record_id <> consent_row.id
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_CONSENT_REJECTED';
  end if;

  insert into public.communication_threads(
    company_id,
    customer_id,
    subject,
    status,
    assigned_user_id
  )
  values (
    p_company_id,
    customer_row.id,
    subject_value,
    'open',
    actor_user_id
  )
  returning id into thread_id_value;

  insert into public.communication_messages(
    company_id,
    thread_id,
    channel,
    direction,
    sender,
    recipients,
    body,
    risk_class,
    delivery_status,
    consent_record_id,
    sent_by_user_id
  )
  values (
    p_company_id,
    thread_id_value,
    p_channel,
    'outbound',
    company_row.name,
    array[normalized_recipient],
    body_value,
    'routine',
    'queued',
    consent_row.id,
    actor_user_id
  )
  returning id into message_id_value;

  insert into public.transactional_delivery_attempts(
    company_id,
    action_type,
    quote_id,
    visit_id,
    entity_version,
    customer_id,
    channel,
    consent_record_id,
    communication_message_id,
    command_id,
    request_hash,
    requested_by_user_id
  )
  values (
    p_company_id,
    case
      when p_action_type = 'quote.delivery' then 'quote_delivery'
      else 'on_my_way'
    end,
    case when p_action_type = 'quote.delivery' then p_entity_id else null end,
    case when p_action_type = 'visit.on_my_way' then p_entity_id else null end,
    p_expected_version,
    customer_row.id,
    p_channel,
    consent_row.id,
    message_id_value,
    p_command_id,
    effective_request_hash,
    actor_user_id
  )
  returning id into attempt_id_value;

  response_value := jsonb_build_object(
    'schemaVersion', 'storyops-transactional-delivery-command-v1',
    'companyId', p_company_id,
    'commandId', p_command_id,
    'requestHash', effective_request_hash,
    'attemptId', attempt_id_value,
    'action', p_action_type,
    'entityId', p_entity_id,
    'entityVersion', p_expected_version,
    'channel', p_channel,
    'status', 'queued',
    'portalPublicationAsserted',
      p_action_type = 'quote.delivery',
    'providerSubmissionAsserted', false,
    'externalDeliveryClaimed', false,
    'replayed', false,
    'serverTime', now()
  );

  update public.idempotency_keys
  set
    status = 'completed',
    response = response_value,
    completed_at = now()
  where id = inserted_reservation_id
    and status = 'in_progress';
  if not found then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_RESERVATION_LOST';
  end if;

  insert into public.audit_events(
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data,
    request_id
  )
  values (
    p_company_id,
    'user',
    actor_user_id::text,
    case
      when p_action_type = 'quote.delivery'
        then 'quote.delivery_queued'
      else 'visit.on_my_way_queued'
    end,
    'transactional_delivery_attempt',
    attempt_id_value,
    jsonb_build_object(
      'action', p_action_type,
      'entityId', p_entity_id,
      'entityVersion', p_expected_version,
      'channel', p_channel,
      'status', 'queued',
      'consentRecordId', consent_row.id,
      'providerSubmissionAsserted', false,
      'externalDeliveryClaimed', false
    ),
    p_command_id::text
  );
  return response_value;
exception
  when unique_violation then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_ACTIVE_ATTEMPT_EXISTS';
end;
$$;

revoke all on function public.queue_storyops_transactional_delivery(
  uuid, uuid, text, uuid, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.queue_storyops_transactional_delivery(
  uuid, uuid, text, uuid, integer, text, text
) to authenticated;

create or replace function public.claim_storyops_transactional_delivery(
  p_company_id uuid,
  p_worker_id uuid,
  p_lease_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  attempt_row public.transactional_delivery_attempts%rowtype;
  company_status text;
  quote_row public.quotes%rowtype;
  visit_row public.visits%rowtype;
  customer_row public.customers%rowtype;
  consent_row public.consent_records%rowtype;
  message_snapshot record;
  current_recipient text;
  contact_digits text;
  contact_fingerprint text;
  outbound_decision record;
  operation_value text;
  token_value uuid;
  invalid_code text;
  previous_provider_context text;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_WORKER_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_company_id is null
    or not exists (
      select 1
      from public.companies company
      where company.id = p_company_id
    )
    or p_worker_id is null
    or p_lease_seconds is null
    or p_lease_seconds not between 30 and 300
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_INVALID_CLAIM';
  end if;

  loop
    select attempt.*
    into attempt_row
    from public.transactional_delivery_attempts attempt
    where attempt.company_id = p_company_id
      and not (
        attempt.status = 'submitted'
        and attempt.last_error_code is not distinct from
          'RECONCILIATION_EXHAUSTED'
      )
      and (
        (
          attempt.status in ('queued', 'submitted')
          and attempt.next_attempt_at <= now()
          and (
            attempt.claim_token is null
            or attempt.claim_expires_at <= now()
          )
        )
        or (
          attempt.status = 'submitting'
          and attempt.claim_expires_at <= now()
        )
      )
    order by attempt.next_attempt_at, attempt.created_at, attempt.id
    for update skip locked
    limit 1;
    if not found then
      return null;
    end if;

    -- Crossing the live submission boundary makes a crash ambiguous. Never
    -- resend it: quarantine the expired lease for owner reconciliation.
    if attempt_row.status = 'submitting' then
      update public.transactional_delivery_attempts
      set
        status = 'submitted_unknown',
        provider_status = 'submission_unknown',
        completed_at = null,
        last_error_code = 'SUBMISSION_BOUNDARY_LEASE_EXPIRED',
        claimed_by = null,
        claim_token = null,
        claim_operation = null,
        claim_expires_at = null
      where id = attempt_row.id;
      insert into public.audit_events(
        company_id,
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        before_data,
        after_data
      )
      values (
        attempt_row.company_id,
        'system',
        'transactional-outbound-worker-v1',
        'transactional_delivery.submission_unknown',
        'transactional_delivery_attempt',
        attempt_row.id,
        jsonb_build_object('status', 'submitting'),
        jsonb_build_object(
          'status', 'submitted_unknown',
          'errorCode', 'SUBMISSION_BOUNDARY_LEASE_EXPIRED',
          'providerStatus', 'submission_unknown',
          'manualReconciliationRequired', true,
          'externalDeliveryClaimed', false
        )
      );
      continue;
    end if;

    invalid_code := null;
    select company.status
    into company_status
    from public.companies company
    where company.id = attempt_row.company_id;
    if attempt_row.status = 'queued'
      and company_status is distinct from 'active'
    then
      invalid_code := 'COMPANY_NOT_ACTIVE';
    end if;

    if invalid_code is null
      and attempt_row.status = 'queued'
      and attempt_row.action_type = 'quote_delivery'
    then
      select quote.*
      into quote_row
      from public.quotes quote
      where quote.id = attempt_row.quote_id
        and quote.company_id = attempt_row.company_id;
      if not found
        or quote_row.version <> attempt_row.entity_version
        or quote_row.status not in ('sent', 'viewed')
        or quote_row.portal_published_at is null
        or quote_row.valid_until < current_date
      then
        invalid_code := 'QUOTE_NO_LONGER_DELIVERABLE';
      end if;
    elsif invalid_code is null
      and attempt_row.status = 'queued'
      and attempt_row.action_type = 'on_my_way'
    then
      select visit.*
      into visit_row
      from public.visits visit
      where visit.id = attempt_row.visit_id
        and visit.company_id = attempt_row.company_id;
      if not found
        or visit_row.version <> attempt_row.entity_version
        or visit_row.status <> 'en_route'
        or visit_row.ends_at <= now()
        or visit_row.starts_at < now() - interval '12 hours'
        or visit_row.starts_at > now() + interval '24 hours'
      then
        invalid_code := 'VISIT_NO_LONGER_EN_ROUTE';
      end if;
    end if;

    if invalid_code is null and attempt_row.status = 'queued' then
      select customer.*
      into customer_row
      from public.customers customer
      where customer.id = attempt_row.customer_id
        and customer.company_id = attempt_row.company_id
        and customer.lifecycle = 'active';
      if not found or customer_row.do_not_contact then
        invalid_code := 'CONTACT_SUPPRESSED';
      end if;
    end if;

    if invalid_code is null then
      select message.*, thread.subject as thread_subject
      into message_snapshot
      from public.communication_messages message
      join public.communication_threads thread
        on thread.id = message.thread_id
       and thread.company_id = message.company_id
      where message.id = attempt_row.communication_message_id
        and message.company_id = attempt_row.company_id;
      if not found
        or message_snapshot.channel <> attempt_row.channel
        or message_snapshot.direction <> 'outbound'
        or (
          attempt_row.status = 'queued'
          and message_snapshot.delivery_status <> 'queued'
        )
        or (
          attempt_row.status = 'submitted'
          and message_snapshot.delivery_status not in ('queued', 'sent')
        )
        or (
          attempt_row.status = 'queued'
          and message_snapshot.provider_message_id is not null
        )
        or (
          attempt_row.status = 'submitted'
          and message_snapshot.provider_message_id
            is distinct from attempt_row.provider_message_id
        )
        or (
          attempt_row.status = 'submitted'
          and (
            attempt_row.provider_mode <> 'live'
            or attempt_row.provider_name is null
            or attempt_row.provider_message_id is null
          )
        )
        or message_snapshot.consent_record_id <> attempt_row.consent_record_id
        or cardinality(message_snapshot.recipients) <> 1
        or length(btrim(message_snapshot.body)) not between 1 and 1600
      then
        invalid_code := 'MESSAGE_SNAPSHOT_INVALID';
      end if;
    end if;

    if invalid_code is null and attempt_row.status = 'queued' then
      if attempt_row.channel = 'email' then
        current_recipient := nullif(
          lower(btrim(customer_row.email::text)),
          ''
        );
      else
        contact_digits := regexp_replace(
          coalesce(customer_row.phone, ''),
          '[^0-9]',
          '',
          'g'
        );
        current_recipient := case
          when length(contact_digits) = 10 then '+1' || contact_digits
          when length(contact_digits) = 11 and left(contact_digits, 1) = '1'
            then '+' || contact_digits
          when left(btrim(coalesce(customer_row.phone, '')), 1) = '+'
            and length(contact_digits) >= 8
            then '+' || contact_digits
          else null
        end;
      end if;
      if current_recipient is null
        or current_recipient <> message_snapshot.recipients[1]
      then
        invalid_code := 'CONTACT_CHANGED';
      end if;
    end if;

    if invalid_code is null and attempt_row.status = 'queued' then
      select consent.*
      into consent_row
      from public.consent_records consent
      where consent.id = attempt_row.consent_record_id
        and consent.company_id = attempt_row.company_id;
      if not found then
        invalid_code := 'CONSENT_NOT_GRANTED';
      else
        contact_fingerprint := encode(
          extensions.digest(message_snapshot.recipients[1], 'sha256'),
          'hex'
        );
        select *
        into outbound_decision
        from public.authorize_outbound_contact(
          attempt_row.company_id,
          attempt_row.channel,
          'transactional',
          contact_fingerprint,
          consent_row.id
        );
        if not coalesce(outbound_decision.allowed, false)
          or outbound_decision.decision_code <> 'ALLOWED'
          or outbound_decision.consent_record_id
            <> consent_row.id
          or outbound_decision.latest_consent_record_id
            <> consent_row.id
        then
          invalid_code := 'CONSENT_NO_LONGER_CURRENT';
        end if;
      end if;
    end if;

    if invalid_code is not null then
      update public.transactional_delivery_attempts
      set
        status = 'cancelled',
        completed_at = now(),
        last_error_code = invalid_code,
        claimed_by = null,
        claim_token = null,
        claim_operation = null,
        claim_expires_at = null
      where id = attempt_row.id;
      insert into public.audit_events(
        company_id,
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        before_data,
        after_data
      )
      values (
        attempt_row.company_id,
        'system',
        'transactional-outbound-worker-v1',
        'transactional_delivery.cancelled_before_provider',
        'transactional_delivery_attempt',
        attempt_row.id,
        jsonb_build_object('status', attempt_row.status),
        jsonb_build_object(
          'status', 'cancelled',
          'errorCode', invalid_code,
          'providerSubmissionAsserted', false,
          'externalDeliveryClaimed', false
        )
      );
      continue;
    end if;

    operation_value := case
      when attempt_row.status = 'queued' then 'send'
      else 'reconcile'
    end;
    if (
      operation_value = 'send'
      and attempt_row.attempt_count >= attempt_row.max_attempts
    ) or (
      operation_value = 'reconcile'
      and attempt_row.reconciliation_count >= attempt_row.max_attempts
    ) then
      update public.transactional_delivery_attempts
      set
        status = case
          when operation_value = 'reconcile' then 'submitted'
          else 'failed'
        end,
        completed_at = case
          when operation_value = 'reconcile' then null
          else now()
        end,
        last_error_code = case
          when operation_value = 'send' then 'SEND_ATTEMPTS_EXHAUSTED'
          else 'RECONCILIATION_EXHAUSTED'
        end,
        claimed_by = null,
        claim_token = null,
        claim_operation = null,
        claim_expires_at = null
      where id = attempt_row.id;

      if operation_value = 'send' then
        previous_provider_context := current_setting(
          'storyops.provider_evidence_write',
          true
        );
        perform set_config('storyops.provider_evidence_write', 'on', true);
        update public.communication_messages
        set delivery_status = 'failed'
        where id = attempt_row.communication_message_id
          and company_id = attempt_row.company_id;
        perform set_config(
          'storyops.provider_evidence_write',
          coalesce(previous_provider_context, 'off'),
          true
        );
      end if;

      insert into public.audit_events(
        company_id,
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        before_data,
        after_data
      )
      values (
        attempt_row.company_id,
        'system',
        'transactional-outbound-worker-v1',
        case
          when operation_value = 'reconcile'
            then 'transactional_delivery.reconciliation_required'
          else 'transactional_delivery.send_attempts_exhausted'
        end,
        'transactional_delivery_attempt',
        attempt_row.id,
        jsonb_build_object(
          'status', attempt_row.status,
          'attemptCount', attempt_row.attempt_count,
          'reconciliationCount', attempt_row.reconciliation_count,
          'maxAttempts', attempt_row.max_attempts
        ),
        jsonb_build_object(
          'status', case
            when operation_value = 'reconcile' then 'submitted'
            else 'failed'
          end,
          'errorCode', case
            when operation_value = 'reconcile'
              then 'RECONCILIATION_EXHAUSTED'
            else 'SEND_ATTEMPTS_EXHAUSTED'
          end,
          'manualReconciliationRequired',
            operation_value = 'reconcile',
          'externalDeliveryClaimed', false
        )
      );
      continue;
    end if;

    token_value := extensions.gen_random_uuid();
    update public.transactional_delivery_attempts
    set
      attempt_count = attempt_count
        + case when operation_value = 'send' then 1 else 0 end,
      reconciliation_count = reconciliation_count
        + case when operation_value = 'reconcile' then 1 else 0 end,
      last_attempt_at = now(),
      claimed_by = p_worker_id,
      claim_token = token_value,
      claim_operation = operation_value,
      claim_expires_at = now() + make_interval(secs => p_lease_seconds),
      last_error_code = null
    where id = attempt_row.id;

    if operation_value = 'send' then
      return jsonb_build_object(
        'schemaVersion', 'storyops-transactional-worker-claim-v1',
        'operation', 'send',
        'attemptId', attempt_row.id,
        'companyId', attempt_row.company_id,
        'action', case
          when attempt_row.action_type = 'quote_delivery'
            then 'quote.delivery'
          else 'visit.on_my_way'
        end,
        'channel', attempt_row.channel,
        'claimToken', token_value,
        'idempotencyKey', 'transactional:' || attempt_row.id::text,
        'attempt', attempt_row.attempt_count + 1,
        'recipient', message_snapshot.recipients[1],
        'subject', coalesce(
          nullif(btrim(message_snapshot.thread_subject), ''),
          'WashOps customer update'
        ),
        'body', message_snapshot.body,
        'consentSnapshotId', attempt_row.consent_record_id
      );
    end if;
    return jsonb_build_object(
      'schemaVersion', 'storyops-transactional-worker-claim-v1',
      'operation', 'reconcile',
      'attemptId', attempt_row.id,
      'companyId', attempt_row.company_id,
      'action', case
        when attempt_row.action_type = 'quote_delivery'
          then 'quote.delivery'
        else 'visit.on_my_way'
      end,
      'channel', attempt_row.channel,
      'claimToken', token_value,
      'idempotencyKey', 'transactional:' || attempt_row.id::text,
      'attempt', attempt_row.reconciliation_count + 1,
      'providerMessageId', attempt_row.provider_message_id,
      'providerName', attempt_row.provider_name
    );
  end loop;
end;
$$;

create or replace function public.begin_storyops_transactional_submission(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_provider_name text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt_row public.transactional_delivery_attempts%rowtype;
  provider_name_value text := nullif(btrim(p_provider_name), '');
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_WORKER_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_attempt_id is null
    or p_claim_token is null
    or provider_name_value is null
    or length(provider_name_value) > 80
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_INVALID_SUBMISSION_BOUNDARY';
  end if;

  select attempt.*
  into attempt_row
  from public.transactional_delivery_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.status = 'queued'
    and attempt.claim_token = p_claim_token
    and attempt.claim_operation = 'send'
    and attempt.claim_expires_at > now()
  for update;
  if not found then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_CLAIM_NOT_CURRENT';
  end if;
  if not public.lock_storyops_active_company(attempt_row.company_id) then
    raise exception using message = 'STORYOPS_COMPANY_NOT_ACTIVE';
  end if;
  if (
    attempt_row.action_type = 'quote_delivery'
    and not exists (
      select 1
      from public.quotes quote
      where quote.id = attempt_row.quote_id
        and quote.company_id = attempt_row.company_id
        and quote.version = attempt_row.entity_version
        and quote.status in ('sent', 'viewed')
        and quote.portal_published_at is not null
        and quote.valid_until >= current_date
    )
  ) or (
    attempt_row.action_type = 'on_my_way'
    and not exists (
      select 1
      from public.visits visit
      where visit.id = attempt_row.visit_id
        and visit.company_id = attempt_row.company_id
        and visit.version = attempt_row.entity_version
        and visit.status = 'en_route'
        and visit.ends_at > now()
        and visit.starts_at >= now() - interval '12 hours'
        and visit.starts_at <= now() + interval '24 hours'
    )
  ) then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_ENTITY_CHANGED_BEFORE_SUBMISSION';
  end if;

  update public.transactional_delivery_attempts
  set
    status = 'submitting',
    provider_mode = 'live',
    provider_name = provider_name_value,
    provider_status = null,
    provider_message_id = null
  where id = attempt_row.id
    and claim_token = p_claim_token;
  return jsonb_build_object(
    'schemaVersion', 'storyops-transactional-worker-result-v1',
    'attemptId', attempt_row.id,
    'status', 'submitting',
    'providerMode', 'live',
    'externalDeliveryClaimed', false
  );
end;
$$;

create or replace function public.complete_storyops_transactional_delivery(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_receipt jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt_row public.transactional_delivery_attempts%rowtype;
  mode_value text := nullif(p_receipt ->> 'mode', '');
  provider_value text := nullif(btrim(p_receipt ->> 'provider'), '');
  provider_id_value text := nullif(btrim(p_receipt ->> 'providerId'), '');
  provider_status_value text := nullif(p_receipt ->> 'status', '');
  idempotency_value text := nullif(p_receipt ->> 'idempotencyKey', '');
  occurred_at_value timestamptz;
  resulting_status text;
  message_status text;
  previous_provider_context text;
  delivery_claimed boolean;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_WORKER_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_attempt_id is null
    or p_claim_token is null
    or p_receipt is null
    or jsonb_typeof(p_receipt) <> 'object'
    or mode_value not in ('sandbox', 'live')
    or provider_value is null
    or length(provider_value) > 80
    or provider_id_value is null
    or length(provider_id_value) > 255
    or provider_status_value not in (
      'accepted', 'queued', 'sent', 'delivered', 'failed'
    )
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_INVALID_PROVIDER_RECEIPT';
  end if;
  begin
    occurred_at_value := (p_receipt ->> 'occurredAt')::timestamptz;
  exception when others then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_INVALID_PROVIDER_RECEIPT';
  end;

  select attempt.*
  into attempt_row
  from public.transactional_delivery_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.claim_token = p_claim_token
    and attempt.claim_expires_at > now()
    and (
      (
        attempt.claim_operation = 'send'
        and attempt.status in ('queued', 'submitting')
      )
      or (
        attempt.claim_operation = 'reconcile'
        and attempt.status = 'submitted'
      )
    )
  for update;
  if not found then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_CLAIM_NOT_CURRENT';
  end if;
  if idempotency_value is distinct from
    'transactional:' || attempt_row.id::text
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_RECEIPT_IDEMPOTENCY_MISMATCH';
  end if;
  if attempt_row.status = 'submitting'
    and (
      mode_value <> 'live'
      or attempt_row.provider_name <> provider_value
    )
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_PROVIDER_BOUNDARY_MISMATCH';
  end if;
  if attempt_row.claim_operation = 'reconcile'
    and (
      mode_value <> 'live'
      or attempt_row.provider_name <> provider_value
      or attempt_row.provider_message_id <> provider_id_value
    )
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_RECONCILIATION_MISMATCH';
  end if;

  if mode_value = 'sandbox' then
    resulting_status := 'sandboxed';
    message_status := 'queued';
    delivery_claimed := false;
  else
    resulting_status := case provider_status_value
      when 'delivered' then 'delivered'
      when 'failed' then 'failed'
      else 'submitted'
    end;
    message_status := case provider_status_value
      when 'delivered' then 'delivered'
      when 'failed' then 'failed'
      when 'sent' then 'sent'
      else 'queued'
    end;
    delivery_claimed := provider_status_value = 'delivered';
  end if;

  update public.transactional_delivery_attempts
  set
    status = resulting_status,
    provider_mode = mode_value,
    provider_name = provider_value,
    provider_status = case
      when mode_value = 'sandbox' then 'sandbox_recorded'
      else provider_status_value
    end,
    provider_message_id = case
      when mode_value = 'sandbox' then null
      else provider_id_value
    end,
    completed_at = case
      when resulting_status in ('delivered', 'sandboxed', 'failed')
        then now()
      else null
    end,
    next_attempt_at = case
      when resulting_status = 'submitted'
        then now() + interval '30 seconds'
      else next_attempt_at
    end,
    last_error_code = case
      when resulting_status = 'failed' then 'PROVIDER_DELIVERY_FAILED'
      else null
    end,
    claimed_by = null,
    claim_token = null,
    claim_operation = null,
    claim_expires_at = null
  where id = attempt_row.id
    and claim_token = p_claim_token;

  if mode_value = 'live' then
    previous_provider_context := current_setting(
      'storyops.provider_evidence_write',
      true
    );
    perform set_config('storyops.provider_evidence_write', 'on', true);
    update public.communication_messages
    set
      provider_message_id = provider_id_value,
      delivery_status = message_status,
      sent_at = case
        when message_status in ('sent', 'delivered')
          then coalesce(sent_at, occurred_at_value)
        else sent_at
      end
    where id = attempt_row.communication_message_id
      and company_id = attempt_row.company_id
      and (
        provider_message_id is null
        or provider_message_id = provider_id_value
      );
    if not found then
      raise exception using message =
        'TRANSACTIONAL_DELIVERY_MESSAGE_RECEIPT_CONFLICT';
    end if;
    perform set_config(
      'storyops.provider_evidence_write',
      coalesce(previous_provider_context, 'off'),
      true
    );
  end if;

  insert into public.audit_events(
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data
  )
  values (
    attempt_row.company_id,
    'system',
    'transactional-outbound-worker-v1',
    case
      when mode_value = 'sandbox'
        then 'transactional_delivery.sandbox_recorded'
      when resulting_status = 'delivered'
        then 'transactional_delivery.delivered'
      when resulting_status = 'failed'
        then 'transactional_delivery.provider_failed'
      else 'transactional_delivery.submitted'
    end,
    'transactional_delivery_attempt',
    attempt_row.id,
    jsonb_build_object('status', attempt_row.status),
    jsonb_build_object(
      'status', resulting_status,
      'providerMode', mode_value,
      'providerStatus', case
        when mode_value = 'sandbox' then 'sandbox_recorded'
        else provider_status_value
      end,
      'providerSubmissionAsserted', mode_value = 'live',
      'externalDeliveryClaimed', delivery_claimed
    )
  );
  return jsonb_build_object(
    'schemaVersion', 'storyops-transactional-worker-result-v1',
    'attemptId', attempt_row.id,
    'status', resulting_status,
    'providerMode', mode_value,
    'providerStatus', case
      when mode_value = 'sandbox' then 'sandbox_recorded'
      else provider_status_value
    end,
    'externalDeliveryClaimed', delivery_claimed
  );
end;
$$;

create or replace function public.mark_storyops_transactional_submission_unknown(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_provider_name text,
  p_provider_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt_row public.transactional_delivery_attempts%rowtype;
  error_code_value text := nullif(btrim(p_error_code), '');
  provider_name_value text := nullif(btrim(p_provider_name), '');
  provider_id_value text := nullif(btrim(p_provider_message_id), '');
  previous_provider_context text;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_WORKER_TRUSTED_ROLE_REQUIRED';
  end if;
  if error_code_value is null
    or length(error_code_value) > 120
    or provider_name_value is null
    or length(provider_name_value) > 80
    or (provider_id_value is not null and length(provider_id_value) > 255)
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_INVALID_UNKNOWN_SUBMISSION';
  end if;
  select attempt.*
  into attempt_row
  from public.transactional_delivery_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.status = 'submitting'
    and attempt.claim_token = p_claim_token
    and attempt.claim_operation = 'send'
    and attempt.claim_expires_at > now()
    and attempt.provider_mode = 'live'
    and attempt.provider_name = provider_name_value
  for update;
  if not found then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_CLAIM_NOT_CURRENT';
  end if;

  update public.transactional_delivery_attempts
  set
    status = 'submitted_unknown',
    provider_status = 'submission_unknown',
    provider_message_id = provider_id_value,
    last_error_code = error_code_value,
    completed_at = null,
    claimed_by = null,
    claim_token = null,
    claim_operation = null,
    claim_expires_at = null
  where id = attempt_row.id
    and claim_token = p_claim_token;

  if provider_id_value is not null then
    previous_provider_context := current_setting(
      'storyops.provider_evidence_write',
      true
    );
    perform set_config('storyops.provider_evidence_write', 'on', true);
    update public.communication_messages
    set provider_message_id = provider_id_value
    where id = attempt_row.communication_message_id
      and company_id = attempt_row.company_id
      and (
        provider_message_id is null
        or provider_message_id = provider_id_value
      );
    if not found then
      raise exception using message =
        'TRANSACTIONAL_DELIVERY_MESSAGE_RECEIPT_CONFLICT';
    end if;
    perform set_config(
      'storyops.provider_evidence_write',
      coalesce(previous_provider_context, 'off'),
      true
    );
  end if;

  insert into public.audit_events(
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data
  )
  values (
    attempt_row.company_id,
    'system',
    'transactional-outbound-worker-v1',
    'transactional_delivery.submission_unknown',
    'transactional_delivery_attempt',
    attempt_row.id,
    jsonb_build_object('status', attempt_row.status),
    jsonb_build_object(
      'status', 'submitted_unknown',
      'errorCode', error_code_value,
      'providerStatus', 'submission_unknown',
      'manualReconciliationRequired', true,
      'externalDeliveryClaimed', false
    )
  );
  return jsonb_build_object(
    'schemaVersion', 'storyops-transactional-worker-result-v1',
    'attemptId', attempt_row.id,
    'status', 'submitted_unknown',
    'providerMode', 'live',
    'providerStatus', 'submission_unknown',
    'errorCode', error_code_value,
    'manualReconciliationRequired', true,
    'externalDeliveryClaimed', false
  );
end;
$$;

create or replace function public.fail_storyops_transactional_delivery(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt_row public.transactional_delivery_attempts%rowtype;
  error_code_value text := nullif(btrim(p_error_code), '');
  resulting_status text;
  retry_delay_seconds integer;
  previous_provider_context text;
  retry_scheduled boolean;
  manual_reconciliation_required boolean;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_WORKER_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_attempt_id is null
    or p_claim_token is null
    or error_code_value is null
    or length(error_code_value) > 120
    or p_retryable is null
  then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_INVALID_FAILURE';
  end if;
  select attempt.*
  into attempt_row
  from public.transactional_delivery_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.claim_token = p_claim_token
    and attempt.claim_expires_at > now()
    and attempt.status in ('queued', 'submitting', 'submitted')
  for update;
  if not found then
    raise exception using message =
      'TRANSACTIONAL_DELIVERY_CLAIM_NOT_CURRENT';
  end if;

  retry_delay_seconds := least(
    3600,
    30 * (2 ^ greatest(
      0,
      case
        when attempt_row.claim_operation = 'send'
          then attempt_row.attempt_count - 1
        else attempt_row.reconciliation_count - 1
      end
    ))::integer
  );
  retry_scheduled := p_retryable and (
    (
      attempt_row.claim_operation = 'send'
      and attempt_row.attempt_count < attempt_row.max_attempts
    )
    or (
      attempt_row.claim_operation = 'reconcile'
      and attempt_row.reconciliation_count < attempt_row.max_attempts
    )
  );
  manual_reconciliation_required :=
    attempt_row.claim_operation = 'reconcile'
    and not retry_scheduled;
  resulting_status := case
    when retry_scheduled
      and attempt_row.claim_operation = 'send'
      then 'queued'
    when retry_scheduled
      and attempt_row.claim_operation = 'reconcile'
      then 'submitted'
    when manual_reconciliation_required
      then 'submitted'
    else 'failed'
  end;

  update public.transactional_delivery_attempts
  set
    status = resulting_status,
    provider_mode = case
      when attempt_row.status = 'submitting' then null
      else provider_mode
    end,
    provider_name = case
      when attempt_row.status = 'submitting' then null
      else provider_name
    end,
    provider_status = case
      when attempt_row.status = 'submitting' then null
      else provider_status
    end,
    provider_message_id = case
      when attempt_row.status = 'submitting' then null
      else provider_message_id
    end,
    last_error_code = case
      when manual_reconciliation_required
        then 'RECONCILIATION_EXHAUSTED'
      else error_code_value
    end,
    next_attempt_at = case
      when resulting_status in ('queued', 'submitted')
        then now() + make_interval(secs => retry_delay_seconds)
      else next_attempt_at
    end,
    completed_at = case
      when resulting_status = 'failed' then now()
      else null
    end,
    claimed_by = null,
    claim_token = null,
    claim_operation = null,
    claim_expires_at = null
  where id = attempt_row.id
    and claim_token = p_claim_token;

  if resulting_status = 'failed' then
    previous_provider_context := current_setting(
      'storyops.provider_evidence_write',
      true
    );
    perform set_config('storyops.provider_evidence_write', 'on', true);
    update public.communication_messages
    set delivery_status = 'failed'
    where id = attempt_row.communication_message_id
      and company_id = attempt_row.company_id;
    perform set_config(
      'storyops.provider_evidence_write',
      coalesce(previous_provider_context, 'off'),
      true
    );
  end if;

  insert into public.audit_events(
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data
  )
  values (
    attempt_row.company_id,
    'system',
    'transactional-outbound-worker-v1',
    case
      when retry_scheduled
        then 'transactional_delivery.retry_scheduled'
      when manual_reconciliation_required
        then 'transactional_delivery.reconciliation_required'
      else 'transactional_delivery.failed'
    end,
    'transactional_delivery_attempt',
    attempt_row.id,
    jsonb_build_object('status', attempt_row.status),
    jsonb_build_object(
      'status', resulting_status,
      'errorCode', case
        when manual_reconciliation_required
          then 'RECONCILIATION_EXHAUSTED'
        else error_code_value
      end,
      'providerReadErrorCode', case
        when manual_reconciliation_required then error_code_value
        else null
      end,
      'retryable', p_retryable,
      'manualReconciliationRequired',
        manual_reconciliation_required,
      'providerSubmissionAsserted',
        attempt_row.status in ('submitting', 'submitted'),
      'externalDeliveryClaimed', false
    )
  );
  return jsonb_build_object(
    'schemaVersion', 'storyops-transactional-worker-result-v1',
    'attemptId', attempt_row.id,
    'status', resulting_status,
    'errorCode', case
      when manual_reconciliation_required
        then 'RECONCILIATION_EXHAUSTED'
      else error_code_value
    end,
    'providerReadErrorCode', case
      when manual_reconciliation_required then error_code_value
      else null
    end,
    'retryScheduled', retry_scheduled,
    'manualReconciliationRequired',
      manual_reconciliation_required,
    'externalDeliveryClaimed', false
  );
end;
$$;

create or replace function public.reconcile_storyops_transactional_delivery()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt_row public.transactional_delivery_attempts%rowtype;
  resulting_status text;
begin
  if new.delivery_status is not distinct from old.delivery_status then
    return new;
  end if;
  select attempt.*
  into attempt_row
  from public.transactional_delivery_attempts attempt
  where attempt.communication_message_id = new.id
    and attempt.provider_mode = 'live'
    and attempt.provider_message_id is not null
    and attempt.provider_message_id = new.provider_message_id
    and attempt.status not in ('sandboxed', 'cancelled')
  for update;
  if not found then
    return new;
  end if;

  resulting_status := case new.delivery_status
    when 'delivered' then 'delivered'
    when 'failed' then 'failed'
    else 'submitted'
  end;
  update public.transactional_delivery_attempts
  set
    status = resulting_status,
    provider_status = new.delivery_status,
    completed_at = case
      when resulting_status in ('delivered', 'failed') then now()
      else null
    end,
    last_error_code = case
      when resulting_status = 'failed' then 'PROVIDER_DELIVERY_FAILED'
      else null
    end,
    claimed_by = null,
    claim_token = null,
    claim_operation = null,
    claim_expires_at = null
  where id = attempt_row.id;

  if attempt_row.status is distinct from resulting_status
    or attempt_row.provider_status is distinct from new.delivery_status
  then
    insert into public.audit_events(
      company_id,
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      before_data,
      after_data
    )
    values (
      attempt_row.company_id,
      'system',
      'provider-reconciliation',
      'transactional_delivery.delivery_reconciled',
      'transactional_delivery_attempt',
      attempt_row.id,
      jsonb_build_object(
        'status', attempt_row.status,
        'providerStatus', attempt_row.provider_status
      ),
      jsonb_build_object(
        'status', resulting_status,
        'providerStatus', new.delivery_status,
        'providerMessageId', new.provider_message_id,
        'externalDeliveryClaimed', new.delivery_status = 'delivered'
      )
    );
  end if;
  return new;
end;
$$;

revoke all on function public.reconcile_storyops_transactional_delivery()
  from public, anon, authenticated, service_role;

create trigger communication_messages_transactional_delivery_reconcile
  after update of delivery_status on public.communication_messages
  for each row
  when (old.delivery_status is distinct from new.delivery_status)
  execute function public.reconcile_storyops_transactional_delivery();

revoke all on function public.claim_storyops_transactional_delivery(
  uuid, uuid, integer
) from public, anon, authenticated;
revoke all on function public.begin_storyops_transactional_submission(
  uuid, uuid, text
) from public, anon, authenticated;
revoke all on function public.complete_storyops_transactional_delivery(
  uuid, uuid, jsonb
) from public, anon, authenticated;
revoke all on function public.mark_storyops_transactional_submission_unknown(
  uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.fail_storyops_transactional_delivery(
  uuid, uuid, text, boolean
) from public, anon, authenticated;

grant execute on function public.claim_storyops_transactional_delivery(
  uuid, uuid, integer
) to service_role;
grant execute on function public.begin_storyops_transactional_submission(
  uuid, uuid, text
) to service_role;
grant execute on function public.complete_storyops_transactional_delivery(
  uuid, uuid, jsonb
) to service_role;
grant execute on function public.mark_storyops_transactional_submission_unknown(
  uuid, uuid, text, text, text
) to service_role;
grant execute on function public.fail_storyops_transactional_delivery(
  uuid, uuid, text, boolean
) to service_role;

alter function public.get_storyops_workspace(uuid)
  rename to get_storyops_workspace_before_transactional_delivery;

revoke all on function
  public.get_storyops_workspace_before_transactional_delivery(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_storyops_workspace(
  p_company_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
begin
  result :=
    public.get_storyops_workspace_before_transactional_delivery(p_company_id);
  if result #>> '{session,companyId}' is distinct from p_company_id::text
    or result #>> '{session,userId}' is distinct from auth.uid()::text
  then
    raise exception using message =
      'Workspace identity did not match the authenticated scope';
  end if;

  if result #>> '{session,role}' in ('owner', 'dispatcher', 'technician') then
    result := result || jsonb_build_object(
      'transactionalDeliveries',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', attempt.id,
          'action', case
            when attempt.action_type = 'quote_delivery'
              then 'quote.delivery'
            else 'visit.on_my_way'
          end,
          'entityId', coalesce(attempt.quote_id, attempt.visit_id),
          'entityVersion', attempt.entity_version,
          'customerId', attempt.customer_id,
          'channel', attempt.channel,
          'status', attempt.status,
          'providerMode', attempt.provider_mode,
          'providerName', attempt.provider_name,
          'providerStatus', attempt.provider_status,
          'attemptCount', attempt.attempt_count,
          'reconciliationCount', attempt.reconciliation_count,
          'lastErrorCode', attempt.last_error_code,
          'manualReconciliationRequired',
            attempt.status = 'submitted_unknown'
            or (
              attempt.status = 'submitted'
              and attempt.last_error_code = 'RECONCILIATION_EXHAUSTED'
            ),
          'portalPublicationAsserted',
            attempt.action_type = 'quote_delivery',
          'providerSubmissionAsserted',
            attempt.provider_mode = 'live'
            and attempt.status in (
              'submitted',
              'submitted_unknown',
              'delivered',
              'failed'
            ),
          'externalDeliveryClaimed',
            attempt.provider_mode = 'live'
            and attempt.status = 'delivered'
            and attempt.provider_status = 'delivered',
          'requestedAt', attempt.created_at,
          'completedAt', attempt.completed_at,
          'version', attempt.version
        ) order by attempt.created_at desc, attempt.id desc)
        from public.transactional_delivery_attempts attempt
        where attempt.company_id = p_company_id
          and (
            result #>> '{session,role}' in ('owner', 'dispatcher')
            or (
              attempt.action_type = 'on_my_way'
              and attempt.visit_id is not null
              and public.is_assigned_technician_for_visit(attempt.visit_id)
            )
          )
      ), '[]'::jsonb)
    );
  end if;
  return result;
end;
$$;

revoke all on function public.get_storyops_workspace(uuid)
  from public, anon, service_role;
grant execute on function public.get_storyops_workspace(uuid)
  to authenticated;

comment on table public.transactional_delivery_attempts is
  'Finite transactional message attempts. Portal publication, durable queueing, provider submission, sandbox recording, and verified external delivery remain separate states.';
comment on function public.queue_storyops_transactional_delivery(
  uuid, uuid, text, uuid, integer, text, text
) is
  'Queues one current quote-delivery or assigned en-route visit message from authoritative customer/contact/consent facts; it never asserts provider submission or delivery.';
comment on function public.begin_storyops_transactional_submission(
  uuid, uuid, text
) is
  'Persists the exact live-provider pre-submission boundary after rechecking active company and entity freshness.';
