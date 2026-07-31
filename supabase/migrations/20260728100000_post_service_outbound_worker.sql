-- Durable post-service outbound worker.
-- Queued review, referral, and maintenance messages are claimed through a
-- lease. Live Twilio sends cross a durable pre-submission boundary before the
-- provider call; an ambiguous outcome is quarantined for manual reconciliation
-- and is never automatically resubmitted. Sandbox receipts have their own
-- terminal state and never become customer-delivery evidence.

alter table public.post_service_followups
  drop constraint post_service_followups_action_type_check,
  drop constraint post_service_followups_status_check,
  drop constraint post_service_followups_check,
  drop constraint post_service_followups_check1,
  drop constraint post_service_followups_company_id_invoice_id_action_type_key;

alter table public.post_service_followups
  add column recurring_plan_id uuid
    references public.recurring_maintenance_plans(id) on delete restrict,
  add column maintenance_due_date date,
  add column communication_message_id uuid
    references public.communication_messages(id) on delete restrict,
  add column provider_mode text
    check (provider_mode is null or provider_mode in ('sandbox', 'live')),
  add column provider_name text
    check (provider_name is null or length(btrim(provider_name)) between 1 and 80),
  add column provider_status text
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
  add column provider_message_id text
    check (
      provider_message_id is null
      or length(btrim(provider_message_id)) between 1 and 255
    ),
  add column attempt_count integer not null default 0
    check (attempt_count >= 0),
  add column reconciliation_count integer not null default 0
    check (reconciliation_count >= 0),
  add column max_attempts integer not null default 6
    check (max_attempts between 1 and 20),
  add column next_attempt_at timestamptz,
  add column last_attempt_at timestamptz,
  add column claimed_by uuid,
  add column claim_token uuid,
  add column claim_operation text
    check (claim_operation is null or claim_operation in ('send', 'reconcile')),
  add column claim_expires_at timestamptz;

update public.post_service_followups
set next_attempt_at = scheduled_at
where next_attempt_at is null;

alter table public.post_service_followups
  alter column next_attempt_at set not null,
  alter column next_attempt_at set default now(),
  add constraint post_service_followups_action_type_check check (
    action_type in ('review_request', 'referral_invite', 'maintenance_reminder')
  ),
  add constraint post_service_followups_status_check check (
    status in (
      'queued',
      'submitted',
      'submitted_unknown',
      'completed',
      'sandboxed',
      'failed',
      'cancelled'
    )
  ),
  add constraint post_service_followups_action_link_check check (
    (
      action_type = 'review_request'
      and referral_id is null
      and recurring_plan_id is null
      and maintenance_due_date is null
    )
    or (
      action_type = 'referral_invite'
      and referral_id is not null
      and recurring_plan_id is null
      and maintenance_due_date is null
    )
    or (
      action_type = 'maintenance_reminder'
      and referral_id is null
      and recurring_plan_id is not null
      and maintenance_due_date is not null
    )
  ),
  add constraint post_service_followups_completion_check check (
    (
      status in ('completed', 'sandboxed')
      and completed_at is not null
    )
    or (
      status not in ('completed', 'sandboxed')
      and completed_at is null
    )
  ),
  add constraint post_service_followups_claim_check check (
    num_nonnulls(claimed_by, claim_token, claim_operation, claim_expires_at)
      in (0, 4)
  ),
  add constraint post_service_followups_provider_check check (
    (
      status = 'sandboxed'
      and provider_mode = 'sandbox'
      and provider_status = 'sandbox_recorded'
      and provider_message_id is null
      and communication_message_id is not null
    )
    or (
      status in ('submitted', 'completed')
      and provider_mode = 'live'
      and provider_message_id is not null
      and communication_message_id is not null
    )
    or (
      status = 'submitted_unknown'
      and provider_mode = 'live'
      and provider_name = 'twilio'
      and provider_status = 'submission_unknown'
      and communication_message_id is not null
    )
    or status in ('queued', 'failed', 'cancelled')
  );

create unique index post_service_followups_invoice_action_idx
  on public.post_service_followups(company_id, invoice_id, action_type)
  where action_type in ('review_request', 'referral_invite');

create unique index post_service_followups_maintenance_due_idx
  on public.post_service_followups(
    company_id,
    recurring_plan_id,
    maintenance_due_date
  )
  where action_type = 'maintenance_reminder';

create unique index post_service_followups_message_idx
  on public.post_service_followups(communication_message_id)
  where communication_message_id is not null;

create or replace function public.protect_communication_provider_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  trusted_provider_context boolean := (
    coalesce((
      session_user = 'postgres'
      and current_setting('role', true) in ('none', 'postgres')
      and auth.role() is null
    ), false)
    or coalesce(current_setting(
      'storyops.provider_evidence_write',
      true
    ) = 'on', false)
  );
  linked_post_service_message boolean := false;
begin
  if tg_op = 'INSERT' then
    if not trusted_provider_context
      and new.direction = 'outbound'
      and (
        new.provider_message_id is not null
        or new.sent_at is not null
        or new.delivery_status <> 'queued'
      )
    then
      raise exception 'COMMUNICATION_PROVIDER_EVIDENCE_TRUSTED_PATH_REQUIRED';
    end if;
    return new;
  end if;

  if not trusted_provider_context
    and (
      new.provider_message_id is distinct from old.provider_message_id
      or new.delivery_status is distinct from old.delivery_status
      or new.sent_at is distinct from old.sent_at
      or new.received_at is distinct from old.received_at
      or new.direction is distinct from old.direction
      or new.channel is distinct from old.channel
    )
  then
    raise exception 'COMMUNICATION_PROVIDER_EVIDENCE_TRUSTED_PATH_REQUIRED';
  end if;

  if not trusted_provider_context then
    select exists (
      select 1
      from public.post_service_followups followup
      where followup.communication_message_id = old.id
    )
    into linked_post_service_message;
    if linked_post_service_message
      and (
        new.sender is distinct from old.sender
        or new.recipients is distinct from old.recipients
        or new.body is distinct from old.body
        or new.risk_class is distinct from old.risk_class
        or new.consent_record_id is distinct from old.consent_record_id
        or new.sent_by_user_id is distinct from old.sent_by_user_id
        or new.sent_by_agent is distinct from old.sent_by_agent
        or new.approval_request_id is distinct from old.approval_request_id
        or new.thread_id is distinct from old.thread_id
        or new.company_id is distinct from old.company_id
      )
    then
      raise exception 'POST_SERVICE_MESSAGE_TRUSTED_PATH_REQUIRED';
    end if;
  end if;
  return new;
end;
$$;

create trigger communication_messages_provider_evidence_guard
  before insert or update on public.communication_messages
  for each row execute function public.protect_communication_provider_evidence();

create or replace function public.protect_customer_contact_suppression()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  trusted_suppression_context boolean := (
    coalesce((
      session_user = 'postgres'
      and current_setting('role', true) in ('none', 'postgres')
      and auth.role() is null
    ), false)
    or coalesce(current_setting(
      'storyops.suppression_review',
      true
    ) = 'on', false)
  );
begin
  if old.do_not_contact
    and not new.do_not_contact
    and not trusted_suppression_context
  then
    raise exception 'CONTACT_SUPPRESSION_REVIEW_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger customers_contact_suppression_guard
  before update on public.customers
  for each row execute function public.protect_customer_contact_suppression();

alter function public.reconcile_provider_webhook(
  uuid,
  text,
  uuid,
  text,
  jsonb
) rename to reconcile_provider_webhook_core;

revoke all on function public.reconcile_provider_webhook_core(
  uuid,
  text,
  uuid,
  text,
  jsonb
) from public, anon, authenticated, service_role;

create or replace function public.reconcile_provider_webhook(
  p_event_id uuid,
  p_payload_hash text,
  p_company_id uuid,
  p_provider text,
  p_reconciliation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  previous_provider_context text := current_setting(
    'storyops.provider_evidence_write',
    true
  );
  result_value jsonb;
begin
  perform set_config('storyops.provider_evidence_write', 'on', true);
  result_value := public.reconcile_provider_webhook_core(
    p_event_id,
    p_payload_hash,
    p_company_id,
    p_provider,
    p_reconciliation
  );
  perform set_config(
    'storyops.provider_evidence_write',
    coalesce(previous_provider_context, 'off'),
    true
  );
  return result_value;
end;
$$;

revoke all on function public.reconcile_provider_webhook(
  uuid,
  text,
  uuid,
  text,
  jsonb
) from public, anon, authenticated;
grant execute on function public.reconcile_provider_webhook(
  uuid,
  text,
  uuid,
  text,
  jsonb
) to service_role;

drop index if exists public.post_service_followups_queue_idx;
create index post_service_followups_queue_idx
  on public.post_service_followups(next_attempt_at, scheduled_at, company_id)
  where status in ('queued', 'submitted');

create or replace function public.queue_storyops_due_maintenance_followups(
  p_company_id uuid,
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  plan_row record;
  consent_row public.consent_records%rowtype;
  channel_value text;
  normalized_contact text;
  contact_digits text;
  contact_fingerprint text;
  outbound_decision record;
  inserted_count integer := 0;
  inserted_id uuid;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'POST_SERVICE_WORKER_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_company_id is null
    or not exists (
      select 1
      from public.companies company
      where company.id = p_company_id
    )
    or p_limit is null
    or p_limit not between 1 and 500
  then
    raise exception 'POST_SERVICE_WORKER_INVALID_LIMIT';
  end if;

  for plan_row in
    select
      plan.*,
      company.timezone as company_timezone,
      customer.email::text as customer_email,
      customer.phone as customer_phone,
      customer.do_not_contact
    from public.recurring_maintenance_plans plan
    join public.companies company
      on company.id = plan.company_id
      and company.status = 'active'
    join public.customers customer
      on customer.id = plan.customer_id
      and customer.company_id = plan.company_id
      and customer.lifecycle = 'active'
    where plan.company_id = p_company_id
      and plan.status = 'active'
      and plan.source_invoice_id is not null
      and plan.source_job_id is not null
      and plan.next_due_date between
        (now() at time zone company.timezone)::date
        and (now() at time zone company.timezone)::date + 14
      and not customer.do_not_contact
      and not exists (
        select 1
        from public.post_service_followups followup
        where followup.company_id = plan.company_id
          and followup.recurring_plan_id = plan.id
          and followup.maintenance_due_date = plan.next_due_date
      )
    order by plan.next_due_date, plan.id
    for update of plan skip locked
    limit p_limit
  loop
    select consent.*
    into consent_row
    from public.consent_records consent
    where consent.company_id = plan_row.company_id
      and consent.customer_id = plan_row.customer_id
      and consent.channel in ('email', 'sms')
      and consent.purpose = 'marketing'
      and consent.status = 'granted'
      and consent.withdrawn_at is null
      and (
        (
          consent.channel = 'email'
          and nullif(lower(btrim(plan_row.customer_email)), '') is not null
        )
        or (
          consent.channel = 'sms'
          and nullif(btrim(plan_row.customer_phone), '') is not null
        )
      )
      and consent.id = (
        select latest.id
        from public.consent_records latest
        where latest.company_id = consent.company_id
          and latest.customer_id = consent.customer_id
          and latest.channel = consent.channel
          and latest.purpose = consent.purpose
        order by
          latest.created_at desc,
          latest.captured_at desc,
          case when latest.status = 'granted' then 0 else 1 end desc,
          latest.id desc
        limit 1
      )
    order by
      case when consent.channel = 'email' then 0 else 1 end,
      consent.created_at desc,
      consent.id desc
    limit 1;
    if not found then
      continue;
    end if;
    channel_value := consent_row.channel;

    if channel_value = 'email' then
      normalized_contact := nullif(lower(btrim(plan_row.customer_email)), '');
    else
      contact_digits := regexp_replace(
        coalesce(plan_row.customer_phone, ''),
        '[^0-9]',
        '',
        'g'
      );
      normalized_contact := case
        when length(contact_digits) = 10 then '+1' || contact_digits
        when length(contact_digits) = 11 and left(contact_digits, 1) = '1'
          then '+' || contact_digits
        else null
      end;
    end if;
    if normalized_contact is null then
      continue;
    end if;
    contact_fingerprint := encode(
      extensions.digest(normalized_contact, 'sha256'),
      'hex'
    );
    select *
    into outbound_decision
    from public.authorize_outbound_contact(
      plan_row.company_id,
      channel_value,
      'marketing',
      contact_fingerprint,
      consent_row.id
    );
    if not coalesce(outbound_decision.allowed, false)
      or outbound_decision.consent_record_id <> consent_row.id
      or outbound_decision.latest_consent_record_id <> consent_row.id
    then
      continue;
    end if;

    inserted_id := null;
    insert into public.post_service_followups(
      company_id,
      invoice_id,
      job_id,
      customer_id,
      property_id,
      action_type,
      channel,
      consent_record_id,
      recurring_plan_id,
      maintenance_due_date,
      status,
      scheduled_at,
      next_attempt_at,
      created_by_user_id
    )
    values (
      plan_row.company_id,
      plan_row.source_invoice_id,
      plan_row.source_job_id,
      plan_row.customer_id,
      plan_row.property_id,
      'maintenance_reminder',
      channel_value,
      consent_row.id,
      plan_row.id,
      plan_row.next_due_date,
      'queued',
      now(),
      now(),
      plan_row.activated_by_user_id
    )
    on conflict do nothing
    returning id into inserted_id;

    if inserted_id is not null then
      inserted_count := inserted_count + 1;
      insert into public.audit_events(
        company_id,
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        after_data
      )
      values (
        plan_row.company_id,
        'system',
        'post-service-worker-v1',
        'post_service.maintenance_reminder_queued',
        'post_service_followup',
        inserted_id,
        jsonb_build_object(
          'planId', plan_row.id,
          'dueDate', plan_row.next_due_date,
          'status', 'queued',
          'providerDeliveryClaimed', false
        )
      );
    end if;
  end loop;
  return inserted_count;
end;
$$;

create or replace function public.claim_storyops_post_service_followup(
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
  followup_row public.post_service_followups%rowtype;
  customer_row public.customers%rowtype;
  company_row public.companies%rowtype;
  consent_row public.consent_records%rowtype;
  plan_row public.recurring_maintenance_plans%rowtype;
  message_row public.communication_messages%rowtype;
  thread_id_value uuid;
  normalized_contact text;
  contact_digits text;
  contact_fingerprint text;
  outbound_decision record;
  body_value text;
  subject_value text;
  token_value uuid;
  operation_value text;
  denial_code text;
  exhausted_row public.post_service_followups%rowtype;
  terminal_error_code text;
  terminal_action text;
  previous_provider_context text;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'POST_SERVICE_WORKER_TRUSTED_ROLE_REQUIRED';
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
    raise exception 'POST_SERVICE_WORKER_INVALID_CLAIM';
  end if;

  perform public.queue_storyops_due_maintenance_followups(
    p_company_id,
    100
  );

  -- A worker may die after a lease is granted but before it reports failure.
  -- Since the attempt counters are incremented when the lease is granted,
  -- those rows must be terminalized explicitly once the final lease expires.
  -- submitted_unknown is intentionally excluded: it is a separate manual
  -- reconciliation quarantine and must never be auto-transitioned.
  for exhausted_row in
    select followup.*
    from public.post_service_followups followup
    where followup.company_id = p_company_id
      and (
        (
          followup.status = 'queued'
          and followup.attempt_count >= followup.max_attempts
        )
        or (
          followup.status = 'submitted'
          and followup.reconciliation_count >= followup.max_attempts
          and followup.last_error_code is distinct from
            'RECONCILIATION_EXHAUSTED'
        )
      )
      and (
        followup.claim_token is null
        or followup.claim_expires_at <= now()
      )
    order by followup.next_attempt_at, followup.id
    for update of followup skip locked
    limit 100
  loop
    terminal_error_code := case exhausted_row.status
      when 'submitted' then 'RECONCILIATION_EXHAUSTED'
      else 'WORKER_LEASE_EXHAUSTED'
    end;
    terminal_action := case exhausted_row.status
      when 'submitted' then 'post_service.reconciliation_exhausted'
      else 'post_service.worker_lease_exhausted'
    end;

    update public.post_service_followups
    set
      status = case exhausted_row.status
        when 'submitted' then 'submitted'
        else 'failed'
      end,
      completed_at = null,
      last_error_code = terminal_error_code,
      claimed_by = null,
      claim_token = null,
      claim_operation = null,
      claim_expires_at = null
    where id = exhausted_row.id;

    if exhausted_row.status = 'queued'
      and exhausted_row.communication_message_id is not null
    then
      previous_provider_context := current_setting(
        'storyops.provider_evidence_write',
        true
      );
      perform set_config('storyops.provider_evidence_write', 'on', true);
      update public.communication_messages
      set delivery_status = 'failed'
      where id = exhausted_row.communication_message_id
        and company_id = exhausted_row.company_id;
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
      exhausted_row.company_id,
      'system',
      'post-service-worker-v1',
      terminal_action,
      'post_service_followup',
      exhausted_row.id,
      jsonb_build_object(
        'status', exhausted_row.status,
        'attemptCount', exhausted_row.attempt_count,
        'reconciliationCount', exhausted_row.reconciliation_count,
        'maxAttempts', exhausted_row.max_attempts,
        'claimExpired',
          exhausted_row.claim_token is not null
          and exhausted_row.claim_expires_at <= now()
      ),
      jsonb_build_object(
        'status', case exhausted_row.status
          when 'submitted' then 'submitted'
          else 'failed'
        end,
        'workflowStatus', case exhausted_row.status
          when 'submitted' then 'reconciliation_required'
          else 'failed'
        end,
        'errorCode', terminal_error_code,
        'manualReconciliationRequired',
          exhausted_row.status = 'submitted',
        'externalDeliveryClaimed', false
      )
    );
  end loop;

  loop
    select followup.*
    into followup_row
    from public.post_service_followups followup
    join public.companies company on company.id = followup.company_id
    where followup.company_id = p_company_id
      and (
        (
          followup.status = 'queued'
          and followup.attempt_count < followup.max_attempts
        )
        or (
          followup.status = 'submitted'
          and followup.reconciliation_count < followup.max_attempts
          and followup.last_error_code is distinct from
            'RECONCILIATION_EXHAUSTED'
        )
      )
      and (
        followup.status = 'submitted'
        or company.status = 'active'
      )
      and followup.scheduled_at <= now()
      and followup.next_attempt_at <= now()
      and (
        followup.claim_token is null
        or followup.claim_expires_at <= now()
      )
      and (now() at time zone company.timezone)::time >= time '08:00'
      and (now() at time zone company.timezone)::time < time '20:00'
    order by followup.next_attempt_at, followup.scheduled_at, followup.id
    for update of followup skip locked
    limit 1;

    if not found then
      return null;
    end if;

    operation_value := case
      when followup_row.status = 'submitted' then 'reconcile'
      else 'send'
    end;
    if operation_value = 'reconcile' then
      token_value := gen_random_uuid();
      update public.post_service_followups
      set
        claimed_by = p_worker_id,
        claim_token = token_value,
        claim_operation = operation_value,
        claim_expires_at = now() + make_interval(secs => p_lease_seconds),
        reconciliation_count = reconciliation_count + 1,
        last_attempt_at = now()
      where id = followup_row.id;
      return jsonb_build_object(
        'schemaVersion', 'storyops-post-service-worker-claim-v1',
        'operation', operation_value,
        'followupId', followup_row.id,
        'companyId', followup_row.company_id,
        'channel', followup_row.channel,
        'claimToken', token_value,
        'idempotencyKey', 'post-service:' || followup_row.id::text,
        'providerMessageId', followup_row.provider_message_id,
        'providerName', followup_row.provider_name,
        'attempt', followup_row.reconciliation_count + 1
      );
    end if;

    select *
    into customer_row
    from public.customers customer
    where customer.id = followup_row.customer_id
      and customer.company_id = followup_row.company_id;
    select *
    into company_row
    from public.companies company
    where company.id = followup_row.company_id;
    select *
    into consent_row
    from public.consent_records consent
    where consent.id = followup_row.consent_record_id
      and consent.company_id = followup_row.company_id;

    if customer_row.id is null
      or company_row.id is null
      or company_row.status <> 'active'
      or customer_row.lifecycle <> 'active'
      or customer_row.do_not_contact
      or consent_row.id is null
    then
      denial_code := 'CONTACT_OR_COMPANY_INELIGIBLE';
    else
      if followup_row.channel = 'email' then
        normalized_contact := nullif(lower(btrim(customer_row.email::text)), '');
      else
        contact_digits := regexp_replace(
          coalesce(customer_row.phone, ''),
          '[^0-9]',
          '',
          'g'
        );
        normalized_contact := case
          when length(contact_digits) = 10 then '+1' || contact_digits
          when length(contact_digits) = 11 and left(contact_digits, 1) = '1'
            then '+' || contact_digits
          else null
        end;
      end if;
      if normalized_contact is null then
        denial_code := 'CONTACT_MISSING';
      else
        contact_fingerprint := encode(
          extensions.digest(normalized_contact, 'sha256'),
          'hex'
        );
        select *
        into outbound_decision
        from public.authorize_outbound_contact(
          followup_row.company_id,
          followup_row.channel,
          'marketing',
          contact_fingerprint,
          followup_row.consent_record_id
        );
        if not coalesce(outbound_decision.allowed, false) then
          denial_code := coalesce(
            outbound_decision.decision_code,
            'CONSENT_NOT_GRANTED'
          );
        end if;
      end if;
    end if;

    if denial_code is not null then
      update public.post_service_followups
      set
        status = 'cancelled',
        last_error_code = denial_code,
        claimed_by = null,
        claim_token = null,
        claim_operation = null,
        claim_expires_at = null
      where id = followup_row.id;
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
        followup_row.company_id,
        'system',
        'post-service-worker-v1',
        'post_service.outbound_cancelled',
        'post_service_followup',
        followup_row.id,
        jsonb_build_object('status', followup_row.status),
        jsonb_build_object(
          'status', 'cancelled',
          'errorCode', denial_code,
          'providerDeliveryClaimed', false
        )
      );
      denial_code := null;
      continue;
    end if;

    if followup_row.communication_message_id is not null then
      select *
      into message_row
      from public.communication_messages message
      where message.id = followup_row.communication_message_id
        and message.company_id = followup_row.company_id;
      if message_row.id is null
        or message_row.channel <> followup_row.channel
        or message_row.direction <> 'outbound'
        or message_row.consent_record_id <> followup_row.consent_record_id
        or message_row.recipients <> array[normalized_contact]
      then
        update public.post_service_followups
        set
          status = 'cancelled',
          last_error_code = 'PREPARED_MESSAGE_STALE'
        where id = followup_row.id;
        continue;
      end if;
      body_value := message_row.body;
      subject_value := coalesce(
        (
          select thread.subject
          from public.communication_threads thread
          where thread.id = message_row.thread_id
        ),
        'StoryOps follow-up'
      );
    else
      subject_value := case followup_row.action_type
        when 'review_request' then 'How did we do?'
        when 'referral_invite' then 'Thank you for choosing us'
        else 'Maintenance reminder'
      end;
      if followup_row.action_type = 'review_request' then
        body_value := format(
          'Thank you for choosing %s. If you would like, reply with honest feedback about your completed service.%s',
          company_row.name,
          case
            when followup_row.channel = 'sms' then ' Reply STOP to opt out.'
            else ''
          end
        );
      elsif followup_row.action_type = 'referral_invite' then
        body_value := format(
          'Thank you for choosing %s. If someone asks for exterior-service help, you may share our contact information. No reward is promised.%s',
          company_row.name,
          case
            when followup_row.channel = 'sms' then ' Reply STOP to opt out.'
            else ''
          end
        );
      else
        select *
        into plan_row
        from public.recurring_maintenance_plans plan
        where plan.id = followup_row.recurring_plan_id
          and plan.company_id = followup_row.company_id
          and plan.status = 'active';
        if plan_row.id is null
          or plan_row.next_due_date <> followup_row.maintenance_due_date
          or not plan_row.requires_fresh_estimate
        then
          update public.post_service_followups
          set
            status = 'cancelled',
            last_error_code = 'MAINTENANCE_PLAN_STALE'
          where id = followup_row.id;
          continue;
        end if;
        body_value := format(
          '%s maintenance is approaching on %s. A fresh estimate is required before booking. Reply if you would like to review options.%s',
          initcap(plan_row.cadence),
          plan_row.next_due_date,
          case
            when followup_row.channel = 'sms' then ' Reply STOP to opt out.'
            else ''
          end
        );
      end if;

      insert into public.communication_threads(
        company_id,
        customer_id,
        subject,
        status
      )
      values (
        followup_row.company_id,
        followup_row.customer_id,
        subject_value,
        'open'
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
        sent_by_agent
      )
      values (
        followup_row.company_id,
        thread_id_value,
        followup_row.channel,
        'outbound',
        company_row.name,
        array[normalized_contact],
        body_value,
        'routine',
        'queued',
        followup_row.consent_record_id,
        'post-service-worker-v1'
      )
      returning * into message_row;
    end if;

    token_value := gen_random_uuid();
    update public.post_service_followups
    set
      communication_message_id = message_row.id,
      claimed_by = p_worker_id,
      claim_token = token_value,
      claim_operation = operation_value,
      claim_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempt_count = attempt_count + 1,
      last_attempt_at = now()
    where id = followup_row.id;

    return jsonb_build_object(
      'schemaVersion', 'storyops-post-service-worker-claim-v1',
      'operation', operation_value,
      'followupId', followup_row.id,
      'companyId', followup_row.company_id,
      'channel', followup_row.channel,
      'claimToken', token_value,
      'idempotencyKey', 'post-service:' || followup_row.id::text,
      'recipient', normalized_contact,
      'subject', subject_value,
      'body', body_value,
      'consentSnapshotId', followup_row.consent_record_id,
      'attempt', followup_row.attempt_count + 1
    );
  end loop;
end;
$$;

create or replace function public.begin_storyops_post_service_submission(
  p_followup_id uuid,
  p_claim_token uuid,
  p_provider_name text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  followup_row public.post_service_followups%rowtype;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'POST_SERVICE_WORKER_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_followup_id is null
    or p_claim_token is null
    or p_provider_name <> 'twilio'
  then
    raise exception 'POST_SERVICE_WORKER_INVALID_SUBMISSION_BOUNDARY';
  end if;

  select *
  into followup_row
  from public.post_service_followups followup
  where followup.id = p_followup_id
  for update;
  if not found
    or followup_row.claim_token is distinct from p_claim_token
    or followup_row.claim_operation <> 'send'
    or followup_row.status <> 'queued'
    or followup_row.channel <> 'sms'
    or followup_row.communication_message_id is null
    or followup_row.provider_mode is not null
    or followup_row.provider_name is not null
    or followup_row.provider_status is not null
    or followup_row.provider_message_id is not null
  then
    raise exception 'POST_SERVICE_WORKER_SUBMISSION_BOUNDARY_LOST';
  end if;

  update public.post_service_followups
  set
    status = 'submitted_unknown',
    provider_mode = 'live',
    provider_name = p_provider_name,
    provider_status = 'submission_unknown',
    last_error_code = 'PROVIDER_SUBMISSION_IN_PROGRESS'
  where id = followup_row.id
    and claim_token = p_claim_token;
  if not found then
    raise exception 'POST_SERVICE_WORKER_SUBMISSION_BOUNDARY_LOST';
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
    followup_row.company_id,
    'system',
    'post-service-worker-v1',
    'post_service.provider_submission_started',
    'post_service_followup',
    followup_row.id,
    jsonb_build_object('status', followup_row.status),
    jsonb_build_object(
      'status', 'submitted_unknown',
      'providerMode', 'live',
      'provider', p_provider_name,
      'providerStatus', 'submission_unknown',
      'manualReconciliationRequired', true,
      'externalDeliveryClaimed', false
    )
  );

  return jsonb_build_object(
    'schemaVersion', 'storyops-post-service-worker-result-v1',
    'followupId', followup_row.id,
    'status', 'submitted_unknown',
    'providerMode', 'live',
    'providerStatus', 'submission_unknown',
    'retryScheduled', false,
    'externalDeliveryClaimed', false
  );
end;
$$;

create or replace function public.mark_storyops_post_service_submission_unknown(
  p_followup_id uuid,
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
  followup_row public.post_service_followups%rowtype;
  provider_id_value text := nullif(btrim(p_provider_message_id), '');
  previous_provider_context text;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'POST_SERVICE_WORKER_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_followup_id is null
    or p_claim_token is null
    or p_error_code is null
    or p_error_code !~ '^[A-Z0-9_.:-]{1,120}$'
    or p_provider_name <> 'twilio'
    or length(provider_id_value) > 255
    or position('SANDBOX' in upper(coalesce(provider_id_value, ''))) > 0
  then
    raise exception 'POST_SERVICE_WORKER_INVALID_UNKNOWN_SUBMISSION';
  end if;

  select *
  into followup_row
  from public.post_service_followups followup
  where followup.id = p_followup_id
  for update;
  if not found
    or followup_row.claim_token is distinct from p_claim_token
    or followup_row.claim_operation <> 'send'
    or followup_row.status <> 'submitted_unknown'
    or followup_row.channel <> 'sms'
    or followup_row.provider_mode <> 'live'
    or followup_row.provider_name <> p_provider_name
    or followup_row.provider_status <> 'submission_unknown'
  then
    raise exception 'POST_SERVICE_WORKER_SUBMISSION_BOUNDARY_LOST';
  end if;

  update public.post_service_followups
  set
    provider_message_id = provider_id_value,
    last_error_code = p_error_code,
    claimed_by = null,
    claim_token = null,
    claim_operation = null,
    claim_expires_at = null
  where id = followup_row.id
    and claim_token = p_claim_token;
  if not found then
    raise exception 'POST_SERVICE_WORKER_SUBMISSION_BOUNDARY_LOST';
  end if;

  if provider_id_value is not null then
    previous_provider_context := current_setting(
      'storyops.provider_evidence_write',
      true
    );
    perform set_config('storyops.provider_evidence_write', 'on', true);
    update public.communication_messages
    set provider_message_id = provider_id_value
    where id = followup_row.communication_message_id
      and company_id = followup_row.company_id
      and (
        provider_message_id is null
        or provider_message_id = provider_id_value
      );
    if not found then
      raise exception 'POST_SERVICE_WORKER_PROVIDER_CORRELATION_CONFLICT';
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
    followup_row.company_id,
    'system',
    'post-service-worker-v1',
    'post_service.provider_submission_unknown',
    'post_service_followup',
    followup_row.id,
    jsonb_build_object(
      'status', followup_row.status,
      'claimOperation', followup_row.claim_operation
    ),
    jsonb_build_object(
      'status', 'submitted_unknown',
      'providerMode', 'live',
      'provider', p_provider_name,
      'providerStatus', 'submission_unknown',
      'providerMessageId', provider_id_value,
      'errorCode', p_error_code,
      'manualReconciliationRequired', true,
      'retryScheduled', false,
      'externalDeliveryClaimed', false
    )
  );

  return jsonb_build_object(
    'schemaVersion', 'storyops-post-service-worker-result-v1',
    'followupId', followup_row.id,
    'status', 'submitted_unknown',
    'providerMode', 'live',
    'providerStatus', 'submission_unknown',
    'errorCode', p_error_code,
    'retryScheduled', false,
    'externalDeliveryClaimed', false
  );
end;
$$;

create or replace function public.complete_storyops_post_service_followup(
  p_followup_id uuid,
  p_claim_token uuid,
  p_receipt jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  followup_row public.post_service_followups%rowtype;
  mode_value text;
  provider_value text;
  provider_id_value text;
  provider_status_value text;
  idempotency_value text;
  occurred_at_value timestamptz;
  followup_status_value text;
  message_status_value text;
  external_delivery_value boolean;
  previous_provider_context text;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'POST_SERVICE_WORKER_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_followup_id is null
    or p_claim_token is null
    or p_receipt is null
    or jsonb_typeof(p_receipt) <> 'object'
    or (
      select count(*)
      from jsonb_object_keys(p_receipt)
    ) <> 6
    or exists (
      select 1
      from jsonb_object_keys(p_receipt) keys(key)
      where keys.key not in (
        'provider',
        'providerId',
        'mode',
        'status',
        'occurredAt',
        'idempotencyKey'
      )
    )
  then
    raise exception 'POST_SERVICE_WORKER_INVALID_RECEIPT';
  end if;

  select *
  into followup_row
  from public.post_service_followups followup
  where followup.id = p_followup_id
  for update;
  if not found
    or followup_row.claim_token is distinct from p_claim_token
    or followup_row.claim_operation is null
  then
    raise exception 'POST_SERVICE_WORKER_CLAIM_LOST';
  end if;

  mode_value := p_receipt ->> 'mode';
  provider_value := nullif(btrim(p_receipt ->> 'provider'), '');
  provider_id_value := nullif(btrim(p_receipt ->> 'providerId'), '');
  provider_status_value := p_receipt ->> 'status';
  idempotency_value := p_receipt ->> 'idempotencyKey';
  begin
    occurred_at_value := nullif(p_receipt ->> 'occurredAt', '')::timestamptz;
  exception when others then
    raise exception 'POST_SERVICE_WORKER_INVALID_RECEIPT';
  end;
  if mode_value not in ('sandbox', 'live')
    or provider_value is null
    or length(provider_value) > 80
    or provider_id_value is null
    or length(provider_id_value) > 255
    or provider_status_value not in (
      'accepted',
      'queued',
      'sent',
      'delivered',
      'failed'
    )
    or idempotency_value <> 'post-service:' || followup_row.id::text
    or occurred_at_value is null
    or occurred_at_value > now() + interval '5 minutes'
  then
    raise exception 'POST_SERVICE_WORKER_INVALID_RECEIPT';
  end if;

  if mode_value = 'sandbox' then
    if followup_row.claim_operation <> 'send'
      or followup_row.status <> 'queued'
      or followup_row.provider_mode is not null
      or followup_row.provider_name is not null
      or followup_row.provider_status is not null
      or followup_row.provider_message_id is not null
      or position('SANDBOX' in upper(provider_id_value)) = 0
    then
      raise exception 'POST_SERVICE_WORKER_INVALID_SANDBOX_RECEIPT';
    end if;
    followup_status_value := 'sandboxed';
    message_status_value := 'queued';
    provider_status_value := 'sandbox_recorded';
    external_delivery_value := false;
  else
    if position('SANDBOX' in upper(provider_id_value)) > 0 then
      raise exception 'POST_SERVICE_WORKER_INVALID_LIVE_RECEIPT';
    end if;
    if (
        followup_row.claim_operation = 'send'
        and (
          followup_row.status <> 'submitted_unknown'
          or followup_row.channel <> 'sms'
          or followup_row.provider_mode <> 'live'
          or followup_row.provider_name <> provider_value
          or followup_row.provider_status <> 'submission_unknown'
          or followup_row.provider_message_id is not null
        )
      )
      or (
        followup_row.claim_operation = 'reconcile'
        and (
          followup_row.status <> 'submitted'
          or followup_row.provider_mode <> 'live'
          or followup_row.provider_name <> provider_value
          or followup_row.provider_message_id <> provider_id_value
        )
      )
      or followup_row.claim_operation not in ('send', 'reconcile')
    then
      raise exception 'POST_SERVICE_WORKER_LIVE_SUBMISSION_BOUNDARY_REQUIRED';
    end if;
    followup_status_value := case provider_status_value
      when 'delivered' then 'completed'
      when 'failed' then 'failed'
      else 'submitted'
    end;
    message_status_value := case provider_status_value
      when 'delivered' then 'delivered'
      when 'failed' then 'failed'
      when 'sent' then 'sent'
      else 'queued'
    end;
    external_delivery_value := provider_status_value = 'delivered';
  end if;

  update public.post_service_followups
  set
    status = followup_status_value,
    completed_at = case
      when followup_status_value in ('completed', 'sandboxed') then now()
      else null
    end,
    provider_mode = mode_value,
    provider_name = provider_value,
    provider_status = provider_status_value,
    provider_message_id = case
      when mode_value = 'live' then provider_id_value
      else null
    end,
    next_attempt_at = case
      when followup_status_value = 'submitted' then now() + interval '15 minutes'
      else next_attempt_at
    end,
    last_error_code = case
      when followup_status_value = 'failed' then 'PROVIDER_REPORTED_FAILED'
      else null
    end,
    claimed_by = null,
    claim_token = null,
    claim_operation = null,
    claim_expires_at = null
  where id = followup_row.id
    and claim_token = p_claim_token;
  if not found then
    raise exception 'POST_SERVICE_WORKER_CLAIM_LOST';
  end if;

  previous_provider_context := current_setting(
    'storyops.provider_evidence_write',
    true
  );
  perform set_config('storyops.provider_evidence_write', 'on', true);
  update public.communication_messages
  set
    provider_message_id = case
      when mode_value = 'live' then provider_id_value
      else null
    end,
    delivery_status = message_status_value,
    sent_at = case
      when mode_value = 'live'
        and provider_status_value in ('sent', 'delivered')
        then now()
      else sent_at
    end
  where id = followup_row.communication_message_id
    and company_id = followup_row.company_id;
  perform set_config(
    'storyops.provider_evidence_write',
    coalesce(previous_provider_context, 'off'),
    true
  );

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
    followup_row.company_id,
    'system',
    'post-service-worker-v1',
    case
      when mode_value = 'sandbox'
        then 'post_service.sandbox_receipt_recorded'
      else 'post_service.provider_receipt_recorded'
    end,
    'post_service_followup',
    followup_row.id,
    jsonb_build_object('status', followup_row.status),
    jsonb_build_object(
      'status', followup_status_value,
      'providerMode', mode_value,
      'provider', provider_value,
      'providerStatus', provider_status_value,
      'providerMessageId', case
        when mode_value = 'live' then provider_id_value
        else null
      end,
      'externalDeliveryClaimed', external_delivery_value
    )
  );

  return jsonb_build_object(
    'schemaVersion', 'storyops-post-service-worker-result-v1',
    'followupId', followup_row.id,
    'status', followup_status_value,
    'providerMode', mode_value,
    'providerStatus', provider_status_value,
    'externalDeliveryClaimed', external_delivery_value
  );
end;
$$;

create or replace function public.fail_storyops_post_service_followup(
  p_followup_id uuid,
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
  followup_row public.post_service_followups%rowtype;
  status_value text;
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
    raise exception 'POST_SERVICE_WORKER_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_followup_id is null
    or p_claim_token is null
    or p_error_code is null
    or p_error_code !~ '^[A-Z0-9_.:-]{1,120}$'
    or p_retryable is null
  then
    raise exception 'POST_SERVICE_WORKER_INVALID_FAILURE';
  end if;

  select *
  into followup_row
  from public.post_service_followups followup
  where followup.id = p_followup_id
  for update;
  if not found
    or followup_row.claim_token is distinct from p_claim_token
    or followup_row.claim_operation is null
  then
    raise exception 'POST_SERVICE_WORKER_CLAIM_LOST';
  end if;
  if followup_row.status = 'submitted_unknown'
    and p_error_code not in (
      'CONSENT_NOT_GRANTED',
      'STALE_CONSENT',
      'OPTED_OUT',
      'CONSENT_CONTACT_MISMATCH',
      'CONSENT_UNKNOWN',
      'CONSENT_UNAVAILABLE',
      'RATE_LIMITED'
    )
  then
    raise exception
      'POST_SERVICE_WORKER_AMBIGUOUS_SUBMISSION_REQUIRES_RECONCILIATION';
  end if;

  status_value := case
    when p_error_code in (
      'CONSENT_NOT_GRANTED',
      'STALE_CONSENT',
      'OPTED_OUT',
      'CONSENT_CONTACT_MISMATCH',
      'CONSENT_UNKNOWN',
      'LIVE_EMAIL_MARKETING_UNSUBSCRIBE_REQUIRED'
    ) then 'cancelled'
    when p_error_code in (
      'PROVIDER_DISABLED',
      'LIVE_PROVIDER_REQUIRED_FOR_RECONCILIATION'
    ) then followup_row.status
    when followup_row.status = 'submitted_unknown'
      and p_error_code in ('CONSENT_UNAVAILABLE', 'RATE_LIMITED')
      and p_retryable
      and followup_row.attempt_count < followup_row.max_attempts
      then 'queued'
    when p_retryable
      and (
        (
          followup_row.claim_operation = 'send'
          and followup_row.attempt_count < followup_row.max_attempts
        )
        or (
          followup_row.claim_operation = 'reconcile'
          and followup_row.reconciliation_count < followup_row.max_attempts
        )
      )
      then followup_row.status
    when followup_row.claim_operation = 'reconcile'
      then 'submitted'
    else 'failed'
  end;
  retry_scheduled := p_retryable
    and status_value in ('queued', 'submitted')
    and p_error_code not in (
      'PROVIDER_DISABLED',
      'LIVE_PROVIDER_REQUIRED_FOR_RECONCILIATION'
    )
    and (
      (
        followup_row.claim_operation = 'send'
        and followup_row.attempt_count < followup_row.max_attempts
      )
      or (
        followup_row.claim_operation = 'reconcile'
        and followup_row.reconciliation_count < followup_row.max_attempts
      )
    );
  manual_reconciliation_required :=
    followup_row.claim_operation = 'reconcile'
    and status_value = 'submitted'
    and not retry_scheduled
    and p_error_code not in (
      'PROVIDER_DISABLED',
      'LIVE_PROVIDER_REQUIRED_FOR_RECONCILIATION'
    );
  retry_delay_seconds := least(
    3600,
    30 * (2 ^ greatest(
      0,
      case
        when followup_row.claim_operation = 'send'
          then followup_row.attempt_count - 1
        else followup_row.reconciliation_count - 1
      end
    ))::integer
  );

  update public.post_service_followups
  set
    status = status_value,
    attempt_count = case
      when p_error_code = 'PROVIDER_DISABLED'
        and followup_row.claim_operation = 'send'
        then greatest(0, attempt_count - 1)
      else attempt_count
    end,
    reconciliation_count = case
      when p_error_code in (
        'PROVIDER_DISABLED',
        'LIVE_PROVIDER_REQUIRED_FOR_RECONCILIATION'
      )
        and followup_row.claim_operation = 'reconcile'
        then greatest(0, reconciliation_count - 1)
      else reconciliation_count
    end,
    completed_at = null,
    provider_mode = case
      when followup_row.status = 'submitted_unknown' then null
      else provider_mode
    end,
    provider_name = case
      when followup_row.status = 'submitted_unknown' then null
      else provider_name
    end,
    provider_status = case
      when followup_row.status = 'submitted_unknown' then null
      else provider_status
    end,
    provider_message_id = case
      when followup_row.status = 'submitted_unknown' then null
      else provider_message_id
    end,
    last_error_code = case
      when manual_reconciliation_required
        then 'RECONCILIATION_EXHAUSTED'
      else p_error_code
    end,
    next_attempt_at = case
      when retry_scheduled
        then now() + make_interval(secs => retry_delay_seconds)
      else next_attempt_at
    end,
    claimed_by = null,
    claim_token = null,
    claim_operation = null,
    claim_expires_at = null
  where id = followup_row.id
    and claim_token = p_claim_token;

  if status_value = 'failed' then
    previous_provider_context := current_setting(
      'storyops.provider_evidence_write',
      true
    );
    perform set_config('storyops.provider_evidence_write', 'on', true);
    update public.communication_messages
    set delivery_status = 'failed'
    where id = followup_row.communication_message_id
      and company_id = followup_row.company_id;
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
    followup_row.company_id,
    'system',
    'post-service-worker-v1',
    case
      when retry_scheduled
        then 'post_service.outbound_retry_scheduled'
      when manual_reconciliation_required
        then 'post_service.reconciliation_required'
      when status_value = 'cancelled'
        then 'post_service.outbound_cancelled'
      else 'post_service.outbound_failed'
    end,
    'post_service_followup',
    followup_row.id,
    jsonb_build_object('status', followup_row.status),
    jsonb_build_object(
      'status', status_value,
      'errorCode', case
        when manual_reconciliation_required
          then 'RECONCILIATION_EXHAUSTED'
        else p_error_code
      end,
      'providerReadErrorCode', case
        when manual_reconciliation_required then p_error_code
        else null
      end,
      'retryable', p_retryable,
      'manualReconciliationRequired',
        manual_reconciliation_required,
      'externalDeliveryClaimed', false
    )
  );

  return jsonb_build_object(
    'schemaVersion', 'storyops-post-service-worker-result-v1',
    'followupId', followup_row.id,
    'status', status_value,
    'errorCode', case
      when manual_reconciliation_required
        then 'RECONCILIATION_EXHAUSTED'
      else p_error_code
    end,
    'providerReadErrorCode', case
      when manual_reconciliation_required then p_error_code
      else null
    end,
    'retryScheduled', retry_scheduled,
    'manualReconciliationRequired',
      manual_reconciliation_required,
    'externalDeliveryClaimed', false
  );
end;
$$;

create or replace function public.reconcile_storyops_post_service_delivery()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  followup_row public.post_service_followups%rowtype;
  new_status text;
begin
  if new.delivery_status is not distinct from old.delivery_status then
    return new;
  end if;
  select *
  into followup_row
  from public.post_service_followups followup
  where followup.communication_message_id = new.id
    and followup.provider_mode = 'live'
  for update;
  if not found then
    return new;
  end if;

  new_status := case new.delivery_status
    when 'delivered' then 'completed'
    when 'failed' then 'failed'
    else 'submitted'
  end;
  update public.post_service_followups
  set
    status = new_status,
    completed_at = case when new_status = 'completed' then now() else null end,
    provider_status = new.delivery_status,
    last_error_code = case
      when new_status = 'failed' then 'PROVIDER_DELIVERY_FAILED'
      else null
    end,
    claimed_by = null,
    claim_token = null,
    claim_operation = null,
    claim_expires_at = null
  where id = followup_row.id;

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
    followup_row.company_id,
    'system',
    'provider-reconciliation',
    'post_service.delivery_reconciled',
    'post_service_followup',
    followup_row.id,
    jsonb_build_object(
      'status', followup_row.status,
      'providerStatus', followup_row.provider_status
    ),
    jsonb_build_object(
      'status', new_status,
      'providerStatus', new.delivery_status,
      'providerMessageId', new.provider_message_id,
      'externalDeliveryClaimed', new.delivery_status = 'delivered'
    )
  );
  return new;
end;
$$;

create trigger communication_messages_post_service_reconcile
  after update of delivery_status on public.communication_messages
  for each row
  when (old.delivery_status is distinct from new.delivery_status)
  execute function public.reconcile_storyops_post_service_delivery();

revoke all on function public.queue_storyops_due_maintenance_followups(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.claim_storyops_post_service_followup(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.begin_storyops_post_service_submission(
  uuid,
  uuid,
  text
) from public, anon, authenticated;
revoke all on function public.mark_storyops_post_service_submission_unknown(
  uuid,
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;
revoke all on function public.complete_storyops_post_service_followup(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_storyops_post_service_followup(
  uuid,
  uuid,
  text,
  boolean
) from public, anon, authenticated;

grant execute on function public.queue_storyops_due_maintenance_followups(uuid, integer)
  to service_role;
grant execute on function public.claim_storyops_post_service_followup(uuid, uuid, integer)
  to service_role;
grant execute on function public.begin_storyops_post_service_submission(
  uuid,
  uuid,
  text
) to service_role;
grant execute on function public.mark_storyops_post_service_submission_unknown(
  uuid,
  uuid,
  text,
  text,
  text
) to service_role;
grant execute on function public.complete_storyops_post_service_followup(uuid, uuid, jsonb)
  to service_role;
grant execute on function public.fail_storyops_post_service_followup(
  uuid,
  uuid,
  text,
  boolean
) to service_role;

comment on function public.claim_storyops_post_service_followup(uuid, uuid, integer) is
  'Service-role-only company-scoped leased claimant. It revalidates exact current marketing consent and prepares one deterministic routine message without exposing it to authenticated clients.';
comment on function public.begin_storyops_post_service_submission(uuid, uuid, text) is
  'Persists a fail-safe live Twilio submission boundary before the external create call. A crash after this point cannot produce an automatic resend.';
comment on function public.mark_storyops_post_service_submission_unknown(
  uuid,
  uuid,
  text,
  text,
  text
) is
  'Quarantines an ambiguous live Twilio create result for manual reconciliation, preserving an exact provider SID when one is available and scheduling no retry.';
comment on function public.complete_storyops_post_service_followup(uuid, uuid, jsonb) is
  'Records an exact provider receipt. Sandbox receipts terminate as sandboxed and never update communication delivery state or claim external delivery.';

create or replace function public.get_storyops_post_service_status(
  p_company_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
begin
  if actor_user_id is null then
    raise exception 'POST_SERVICE_AUTHENTICATION_REQUIRED';
  end if;
  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role is null
    or actor_role not in ('owner', 'dispatcher', 'customer')
  then
    raise exception 'POST_SERVICE_STATUS_ROLE_REQUIRED';
  end if;

  return jsonb_build_object(
    'schemaVersion', 'storyops-post-service-status-v1',
    'companyId', p_company_id,
    'serverTime', now(),
    'followups', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', followup.id,
          'invoiceId', followup.invoice_id,
          'jobId', followup.job_id,
          'customerId', followup.customer_id,
          'propertyId', followup.property_id,
          'action', case followup.action_type
            when 'review_request' then 'review.request'
            when 'referral_invite' then 'referral.invite'
            else 'maintenance.reminder'
          end,
          'domainRecordId', coalesce(
            followup.referral_id,
            followup.recurring_plan_id,
            followup.id
          ),
          'channel', followup.channel,
          'status', case
            when followup.status = 'submitted'
              and followup.last_error_code = 'RECONCILIATION_EXHAUSTED'
              then 'reconciliation_required'
            else followup.status
          end,
          'scheduledAt', followup.scheduled_at,
          'providerMode', followup.provider_mode,
          'providerStatus', followup.provider_status,
          'manualReconciliationRequired',
            followup.status = 'submitted_unknown'
            or (
              followup.status = 'submitted'
              and followup.last_error_code = 'RECONCILIATION_EXHAUSTED'
            ),
          'externalDeliveryClaimed',
            coalesce(
              followup.provider_mode = 'live'
              and followup.provider_status = 'delivered',
              false
            ),
          'version', followup.version
        )
        order by followup.created_at desc
      )
      from public.post_service_followups followup
      where followup.company_id = p_company_id
        and (
          actor_role in ('owner', 'dispatcher')
          or (
            actor_role = 'customer'
            and exists (
              select 1
              from public.customer_portal_users portal
              where portal.company_id = p_company_id
                and portal.user_id = actor_user_id
                and portal.customer_id = followup.customer_id
            )
          )
        )
    ), '[]'::jsonb),
    'maintenancePlans', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', plan.id,
          'invoiceId', plan.source_invoice_id,
          'jobId', plan.source_job_id,
          'customerId', plan.customer_id,
          'propertyId', plan.property_id,
          'status', plan.status,
          'cadence', plan.cadence,
          'nextDueDate', plan.next_due_date,
          'serviceCodes', plan.service_codes,
          'requiresFreshEstimate', plan.requires_fresh_estimate,
          'version', plan.version
        )
        order by plan.next_due_date
      )
      from public.recurring_maintenance_plans plan
      where plan.company_id = p_company_id
        and plan.status = 'active'
        and plan.source_invoice_id is not null
        and (
          actor_role in ('owner', 'dispatcher')
          or (
            actor_role = 'customer'
            and exists (
              select 1
              from public.customer_portal_users portal
              where portal.company_id = p_company_id
                and portal.user_id = actor_user_id
                and portal.customer_id = plan.customer_id
            )
          )
        )
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.get_storyops_post_service_status(uuid) is
  'Role-scoped lifecycle and outbound disposition projection. Sandbox receipts are explicit and external delivery is true only for a live delivered provider receipt.';
