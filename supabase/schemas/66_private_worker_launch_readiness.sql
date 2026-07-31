-- Company/deployment-bound readiness for every private production worker.
--
-- Environment inspection alone is not execution proof. These controls require
-- four exact workers, dedicated credential/configuration hashes, a successful
-- scheduled heartbeat, finite queue evidence, and a fresh immutable snapshot.
-- Launch events bind the stable worker configuration hash and a minimum
-- evidence version; later refreshes may advance the version only when the
-- deployment/configuration hash remains identical.

alter table public.company_launch_authorization_events
  add column if not exists private_worker_evidence_version integer
    check (
      private_worker_evidence_version is null
      or private_worker_evidence_version > 0
    ),
  add column if not exists private_worker_evidence_hash text
    check (
      private_worker_evidence_hash is null
      or private_worker_evidence_hash ~ '^[a-f0-9]{64}$'
    ),
  add column if not exists private_worker_evidence_expires_at timestamptz;

create or replace function private.storyops_assert_no_ambiguous_worker_upgrade_state()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if exists (
    select 1
    from public.transactional_delivery_attempts attempt
    join public.communication_messages message
      on message.id = attempt.communication_message_id
     and message.company_id = attempt.company_id
    where attempt.status = 'failed'
      and attempt.last_error_code = 'PROVIDER_DELIVERY_FAILED'
      and attempt.provider_mode = 'live'
      and attempt.provider_message_id is not null
      and attempt.provider_status = 'failed'
      and message.provider_message_id = attempt.provider_message_id
      and message.delivery_status = 'failed'
      and exists (
        select 1
        from public.audit_events event
        where event.company_id = attempt.company_id
          and event.entity_type = 'transactional_delivery_attempt'
          and event.entity_id = attempt.id
          and event.actor_id = 'transactional-outbound-worker-v1'
          and event.action = 'transactional_delivery.failed'
          and event.before_data ->> 'status' = 'submitted'
          and event.after_data ->> 'status' = 'failed'
          and event.after_data ->> 'externalDeliveryClaimed' = 'false'
      )
  ) then
    raise exception using message =
      'PRIVATE_WORKER_UPGRADE_TRANSACTIONAL_PROVIDER_TRUTH_RECONCILIATION_REQUIRED';
  end if;

  if exists (
    select 1
    from public.post_service_followups followup
    join public.communication_messages message
      on message.id = followup.communication_message_id
     and message.company_id = followup.company_id
    where followup.status = 'failed'
      and followup.last_error_code = 'PROVIDER_DELIVERY_FAILED'
      and followup.provider_mode = 'live'
      and followup.provider_message_id is not null
      and followup.provider_status = 'failed'
      and message.provider_message_id = followup.provider_message_id
      and message.delivery_status = 'failed'
      and exists (
        select 1
        from public.audit_events event
        where event.company_id = followup.company_id
          and event.entity_type = 'post_service_followup'
          and event.entity_id = followup.id
          and event.actor_id = 'post-service-worker-v1'
          and event.action = 'post_service.outbound_failed'
          and event.before_data ->> 'status' = 'submitted'
          and event.after_data ->> 'status' = 'failed'
          and event.after_data ->> 'externalDeliveryClaimed' = 'false'
      )
  ) then
    raise exception using message =
      'PRIVATE_WORKER_UPGRADE_POST_SERVICE_PROVIDER_TRUTH_RECONCILIATION_REQUIRED';
  end if;
end;
$$;

revoke all on function
  private.storyops_assert_no_ambiguous_worker_upgrade_state()
  from public, anon, authenticated, service_role;
select private.storyops_assert_no_ambiguous_worker_upgrade_state();

-- Migration 39 formerly terminalized claim-time receipt-read exhaustion.
-- Rows with a still-known live provider identity and unchanged queued/sent
-- message truth are safe to converge automatically. The fail-RPC corruption
-- above is deliberately not guessed: it stops the upgrade for reconciliation.
-- Any active cross-channel duplicate makes the entity-level unique index fail
-- the migration instead of choosing which customer contact to trust.
with repaired_post_service_reconciliation as (
  update public.post_service_followups followup
  set
    status = 'submitted',
    completed_at = null
  from public.communication_messages message
  where followup.status = 'failed'
    and followup.last_error_code = 'RECONCILIATION_EXHAUSTED'
    and followup.provider_mode = 'live'
    and followup.provider_message_id is not null
    and message.id = followup.communication_message_id
    and message.company_id = followup.company_id
    and message.provider_message_id = followup.provider_message_id
    and message.delivery_status in ('queued', 'sent')
  returning
    followup.company_id,
    followup.id,
    followup.provider_status,
    followup.provider_message_id
)
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
select
  repaired.company_id,
  'system',
  'private-worker-readiness-migration-v1',
  'post_service.reconciliation_state_repaired',
  'post_service_followup',
  repaired.id,
  jsonb_build_object(
    'status', 'failed',
    'errorCode', 'RECONCILIATION_EXHAUSTED'
  ),
  jsonb_build_object(
    'status', 'submitted',
    'errorCode', 'RECONCILIATION_EXHAUSTED',
    'providerStatus', repaired.provider_status,
    'providerMessageId', repaired.provider_message_id,
    'manualReconciliationRequired', true,
    'externalDeliveryClaimed', false
  )
from repaired_post_service_reconciliation repaired;

with repaired_transactional_reconciliation as (
  update public.transactional_delivery_attempts attempt
  set
    status = 'submitted',
    completed_at = null
  from public.communication_messages message
  where attempt.status = 'failed'
    and attempt.last_error_code = 'RECONCILIATION_EXHAUSTED'
    and attempt.provider_mode = 'live'
    and attempt.provider_message_id is not null
    and message.id = attempt.communication_message_id
    and message.company_id = attempt.company_id
    and message.provider_message_id = attempt.provider_message_id
    and message.delivery_status in ('queued', 'sent')
  returning
    attempt.company_id,
    attempt.id,
    attempt.provider_status,
    attempt.provider_message_id
)
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
select
  repaired.company_id,
  'system',
  'private-worker-readiness-migration-v1',
  'transactional_delivery.reconciliation_state_repaired',
  'transactional_delivery_attempt',
  repaired.id,
  jsonb_build_object(
    'status', 'failed',
    'errorCode', 'RECONCILIATION_EXHAUSTED'
  ),
  jsonb_build_object(
    'status', 'submitted',
    'errorCode', 'RECONCILIATION_EXHAUSTED',
    'providerStatus', repaired.provider_status,
    'providerMessageId', repaired.provider_message_id,
    'manualReconciliationRequired', true,
    'externalDeliveryClaimed', false
  )
from repaired_transactional_reconciliation repaired;

drop index if exists public.transactional_delivery_quote_channel_idx;
drop index if exists public.transactional_delivery_visit_channel_idx;
create unique index transactional_delivery_quote_channel_idx
  on public.transactional_delivery_attempts(company_id, quote_id)
  where action_type = 'quote_delivery'
    and status not in ('failed', 'cancelled');
create unique index transactional_delivery_visit_channel_idx
  on public.transactional_delivery_attempts(company_id, visit_id)
  where action_type = 'on_my_way'
    and status not in ('failed', 'cancelled');

-- Exact-company private-worker claim boundaries (upgrade-safe from migration 65).
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

create or replace function public.claim_scope_photo_orphans(
  p_company_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  if p_company_id is null
    or not exists (
      select 1
      from public.companies company
      where company.id = p_company_id
    )
    or p_limit not between 1 and 200
  then
    raise exception 'SCOPE_PHOTO_CLEANUP_LIMIT_INVALID';
  end if;

  update public.scope_photo_requests request
  set status = 'expired', updated_at = now()
  where request.company_id = p_company_id
    and request.status in ('open', 'submitted')
    and request.expires_at <= now();

  with candidates as (
    select reservation.id
    from public.scope_photo_upload_reservations reservation
    where reservation.company_id = p_company_id
      and (
        (
          reservation.status = 'prepared'
          and reservation.expires_at <= now()
        )
        or (
          reservation.status = 'cleanup_failed'
          and reservation.cleanup_attempts < 10
          and reservation.updated_at <= now() - interval '15 minutes'
        )
      )
    order by reservation.expires_at
    for update skip locked
    limit p_limit
  ),
  claimed as (
    update public.scope_photo_upload_reservations reservation
    set status = 'cleanup_claimed',
        cleanup_attempts = cleanup_attempts + 1,
        cleanup_claimed_at = now(),
        cleanup_error = null,
        updated_at = now()
    from candidates
    where reservation.id = candidates.id
    returning reservation.command_id, reservation.object_path
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'commandId', command_id,
      'companyId', p_company_id,
      'objectPath', object_path
    )),
    '[]'::jsonb
  )
  into result
  from claimed;
  return result;
end;
$$;

create or replace function public.claim_storyops_scheduling_reconciliation(
  p_company_id uuid,
  p_worker_id uuid,
  p_lease_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  expired_case public.scheduling_reconciliation_cases%rowtype;
  consumed_case public.scheduling_reconciliation_cases%rowtype;
  invalid_case public.scheduling_reconciliation_cases%rowtype;
  candidate public.scheduling_reconciliation_cases%rowtype;
  booking_attempt public.scheduling_calendar_booking_attempts%rowtype;
  token_value uuid;
  operation_value text;
  next_attempt_number integer;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'SCHEDULING_RECONCILIATION_TRUSTED_ROLE_REQUIRED';
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
    raise exception 'SCHEDULING_RECONCILIATION_INVALID_CLAIM';
  end if;

  -- A worker can disappear after a provider mutation but before durable
  -- completion. An expired lease is therefore provider-unknown, not a retry or
  -- a success. The next operation is a read-back reconciliation.
  for expired_case in
    select reconciliation.*
    from public.scheduling_reconciliation_cases reconciliation
    where reconciliation.company_id = p_company_id
      and reconciliation.status = 'leased'
      and reconciliation.claim_expires_at <= now()
    order by reconciliation.claim_expires_at, reconciliation.id
    for update of reconciliation skip locked
    limit 100
  loop
    update public.scheduling_reconciliation_attempts
    set
      status = case
        when expired_case.attempt_count >= expired_case.max_attempts
          then 'manual_required'
        else 'provider_unknown'
      end,
      error_code = 'WORKER_LEASE_EXPIRED',
      completed_at = now()
    where case_id = expired_case.id
      and attempt_number = expired_case.attempt_count
      and status = 'leased';

    update public.scheduling_reconciliation_cases
    set
      status = case
        when expired_case.attempt_count >= expired_case.max_attempts
          then 'manual_required'
        else 'provider_unknown'
      end,
      next_attempt_at = now(),
      last_error_code = 'WORKER_LEASE_EXPIRED',
      claimed_by = null,
      claim_token = null,
      claim_operation = null,
      claim_expires_at = null,
      completed_at = case
        when expired_case.attempt_count >= expired_case.max_attempts
          then now()
        else null
      end,
      updated_at = now()
    where id = expired_case.id;

    update public.scheduling_calendar_booking_attempts
    set
      status = case
        when expired_case.attempt_count >= expired_case.max_attempts
          then 'manual_required'
        else 'provider_unknown'
      end,
      completed_at = case
        when expired_case.attempt_count >= expired_case.max_attempts
          then now()
        else null
      end,
      last_error_code = 'WORKER_LEASE_EXPIRED',
      reconcile_after = now(),
      updated_at = now()
    where id = expired_case.calendar_attempt_id
      and receipt_id is null
      and status in ('prepared', 'provider_unknown', 'confirmed');
  end loop;

  -- A receipt consumed through the booking transaction must never have its
  -- calendar event removed. This repair covers a disabled trigger or a receipt
  -- consumed before this migration was installed.
  for consumed_case in
    select reconciliation.*
    from public.scheduling_reconciliation_cases reconciliation
    where reconciliation.company_id = p_company_id
      and reconciliation.status in (
      'pending', 'retry_wait', 'provider_unknown'
    )
      and exists (
        select 1
        from public.scheduling_evidence_consumptions consumption
        where consumption.evidence_receipt_id = reconciliation.receipt_id
      )
    order by reconciliation.next_attempt_at, reconciliation.id
    for update of reconciliation skip locked
    limit 100
  loop
    update public.scheduling_reconciliation_cases
    set
      status = 'no_action',
      completed_at = now(),
      last_error_code = null,
      updated_at = now()
    where id = consumed_case.id;
  end loop;

  -- Provider IDs are deterministic from the exact scheduling idempotency key.
  -- A mismatched identity is quarantined without making a provider call.
  for invalid_case in
    select reconciliation.*
    from public.scheduling_reconciliation_cases reconciliation
    join public.scheduling_calendar_booking_attempts attempt
      on attempt.id = reconciliation.calendar_attempt_id
      and attempt.company_id = reconciliation.company_id
    left join public.scheduling_evidence_receipts due_receipt
      on due_receipt.id = reconciliation.receipt_id
      and due_receipt.company_id = reconciliation.company_id
    where reconciliation.company_id = p_company_id
      and reconciliation.status in (
      'pending', 'retry_wait', 'provider_unknown'
    )
      and reconciliation.next_attempt_at <= now()
      and (
        attempt.event_id
          <> private.storyops_calendar_event_id(
            attempt.provider_idempotency_key
          )
        or attempt.provider_idempotency_key
          <> attempt.scheduling_idempotency_key || ':calendar'
        or attempt.status in ('cancelled', 'manual_required')
        or (
          reconciliation.receipt_id is not null
          and (
            due_receipt.id is null
            or due_receipt.evidence_mode <> 'live'
            or due_receipt.capacity_provider <> 'google_calendar'
            or due_receipt.capacity_disposition <> 'eligible'
            or due_receipt.calendar_event_status <> 'confirmed'
            or due_receipt.calendar_event_id <> attempt.event_id
            or due_receipt.calendar_event_etag is null
            or due_receipt.idempotency_key
              <> attempt.scheduling_idempotency_key
          )
        )
      )
    order by reconciliation.next_attempt_at, reconciliation.id
    for update of reconciliation skip locked
    limit 100
  loop
    update public.scheduling_reconciliation_cases
    set
      status = 'manual_required',
      completed_at = now(),
      last_error_code = 'CALENDAR_IDENTITY_MISMATCH',
      updated_at = now()
    where id = invalid_case.id;

    update public.scheduling_calendar_booking_attempts
    set
      status = 'manual_required',
      completed_at = now(),
      last_error_code = 'CALENDAR_IDENTITY_MISMATCH',
      updated_at = now()
    where id = invalid_case.calendar_attempt_id
      and status not in ('cancelled', 'manual_required');
  end loop;

  select reconciliation.*
  into candidate
  from public.scheduling_reconciliation_cases reconciliation
  join public.scheduling_calendar_booking_attempts attempt
    on attempt.id = reconciliation.calendar_attempt_id
    and attempt.company_id = reconciliation.company_id
  left join public.scheduling_evidence_receipts due_receipt
    on due_receipt.id = reconciliation.receipt_id
    and due_receipt.company_id = reconciliation.company_id
  where reconciliation.company_id = p_company_id
    and reconciliation.status in ('pending', 'retry_wait', 'provider_unknown')
    and reconciliation.next_attempt_at <= now()
    and attempt.status in (
      'prepared', 'provider_unknown', 'confirmed', 'receipt_linked'
    )
    and attempt.event_id
      = private.storyops_calendar_event_id(
        attempt.provider_idempotency_key
      )
    and (
      (
        reconciliation.receipt_id is null
        and attempt.receipt_id is null
        and attempt.reconcile_after <= now()
      )
      or (
        reconciliation.receipt_id is not null
        and attempt.receipt_id = reconciliation.receipt_id
        and attempt.status = 'receipt_linked'
        and due_receipt.expires_at <= now()
        and due_receipt.evidence_mode = 'live'
        and due_receipt.capacity_provider = 'google_calendar'
        and due_receipt.capacity_disposition = 'eligible'
        and due_receipt.calendar_event_status = 'confirmed'
        and due_receipt.calendar_event_id = attempt.event_id
        and due_receipt.calendar_event_etag = attempt.event_etag
      )
    )
    and not exists (
      select 1
      from public.scheduling_evidence_consumptions consumption
      where consumption.evidence_receipt_id = reconciliation.receipt_id
    )
  order by reconciliation.next_attempt_at, reconciliation.created_at,
    reconciliation.id
  for update of reconciliation skip locked
  limit 1;

  if not found then
    return null;
  end if;

  -- The case row was locked by the candidate SELECT. A booking transaction
  -- that obtained the same fence first closes it as no_action; this defensive
  -- recheck prevents a stale predicate from ever publishing a cleanup lease.
  if exists (
    select 1
    from public.scheduling_evidence_consumptions consumption
    where consumption.evidence_receipt_id = candidate.receipt_id
  ) then
    update public.scheduling_equipment_reservations reservation
    set
      status = 'consumed',
      visit_id = consumption.visit_id,
      completed_at = now(),
      updated_at = now()
    from public.scheduling_evidence_consumptions consumption
    where consumption.evidence_receipt_id = candidate.receipt_id
      and reservation.evidence_receipt_id = candidate.receipt_id
      and reservation.company_id = candidate.company_id
      and reservation.status = 'held';

    update public.scheduling_reconciliation_cases
    set
      status = 'no_action',
      completed_at = now(),
      last_error_code = null,
      updated_at = now()
    where id = candidate.id
    returning * into candidate;
    return null;
  end if;

  if candidate.attempt_count >= candidate.max_attempts then
    update public.scheduling_reconciliation_cases
    set
      status = 'manual_required',
      completed_at = now(),
      last_error_code = 'RECONCILIATION_ATTEMPTS_EXHAUSTED',
      updated_at = now()
    where id = candidate.id
    returning * into candidate;

    update public.scheduling_calendar_booking_attempts
    set
      status = 'manual_required',
      completed_at = now(),
      last_error_code = 'RECONCILIATION_ATTEMPTS_EXHAUSTED',
      updated_at = now()
    where id = candidate.calendar_attempt_id
      and status not in ('cancelled', 'manual_required');

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
      candidate.company_id,
      'system',
      'scheduling-reconciliation-v1',
      'scheduling_reconciliation.manual_required',
      'scheduling_reconciliation_case',
      candidate.id,
      jsonb_build_object(
        'receiptId', candidate.receipt_id,
        'jobId', candidate.job_id,
        'errorCode', candidate.last_error_code,
        'attemptCount', candidate.attempt_count
      )
    );
    return null;
  end if;

  select *
  into booking_attempt
  from public.scheduling_calendar_booking_attempts attempt
  where attempt.id = candidate.calendar_attempt_id
    and attempt.company_id = candidate.company_id
  for update;
  if not found then
    raise exception 'SCHEDULING_RECONCILIATION_CALENDAR_ATTEMPT_LOST';
  end if;

  operation_value := case
    when candidate.status = 'provider_unknown'
      or candidate.receipt_id is null
      then 'reconcile'
    else 'cancel'
  end;
  token_value := gen_random_uuid();
  next_attempt_number := candidate.attempt_count + 1;

  update public.scheduling_reconciliation_cases
  set
    status = 'leased',
    attempt_count = next_attempt_number,
    last_attempt_at = now(),
    claimed_by = p_worker_id,
    claim_token = token_value,
    claim_operation = operation_value,
    claim_expires_at = now() + make_interval(secs => p_lease_seconds),
    completed_at = null,
    updated_at = now()
  where id = candidate.id
  returning * into candidate;

  insert into public.scheduling_reconciliation_attempts(
    company_id,
    case_id,
    receipt_id,
    attempt_number,
    operation,
    status
  )
  values (
    candidate.company_id,
    candidate.id,
    candidate.receipt_id,
    next_attempt_number,
    operation_value,
    'leased'
  );

  return jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 'storyops-scheduling-reconciliation-claim-v1',
    'caseId', candidate.id,
    'receiptId', candidate.receipt_id,
    'companyId', candidate.company_id,
    'jobId', candidate.job_id,
    'claimToken', token_value,
    'operation', operation_value,
    'attempt', next_attempt_number,
    'calendarId', booking_attempt.calendar_id,
    'eventId', booking_attempt.event_id,
    'eventEtag', booking_attempt.event_etag,
    'idempotencyKey', booking_attempt.provider_idempotency_key,
    'window', jsonb_build_object(
      'start', booking_attempt.starts_at,
      'end', booking_attempt.ends_at
    ),
    'receiptExpiresAt', case
      when candidate.receipt_id is null then null
      else (
        select due_receipt.expires_at
        from public.scheduling_evidence_receipts due_receipt
        where due_receipt.id = candidate.receipt_id
      )
    end,
    'leaseExpiresAt', candidate.claim_expires_at
  ));
end;
$$;

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
          'StoryOps customer update'
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

revoke all on function public.queue_storyops_due_maintenance_followups(
  uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function public.claim_storyops_post_service_followup(
  uuid, uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function public.claim_scope_photo_orphans(
  uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function public.claim_storyops_scheduling_reconciliation(
  uuid, uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function public.claim_storyops_transactional_delivery(
  uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.queue_storyops_due_maintenance_followups(
  uuid, integer
) to service_role;
grant execute on function public.claim_storyops_post_service_followup(
  uuid, uuid, integer
) to service_role;
grant execute on function public.claim_scope_photo_orphans(
  uuid, integer
) to service_role;
grant execute on function public.claim_storyops_scheduling_reconciliation(
  uuid, uuid, integer
) to service_role;
grant execute on function public.claim_storyops_transactional_delivery(
  uuid, uuid, integer
) to service_role;
drop function if exists public.claim_storyops_post_service_followup(uuid, integer);
drop function if exists public.queue_storyops_due_maintenance_followups(integer);
drop function if exists public.claim_scope_photo_orphans(integer);
drop function if exists public.claim_storyops_scheduling_reconciliation(uuid, integer);
drop function if exists public.claim_storyops_transactional_delivery(uuid, integer);
comment on function public.claim_storyops_post_service_followup(
  uuid, uuid, integer
) is
  'Service-role-only exact-company leased claimant. It cannot select or mutate another company.';
comment on function public.claim_scope_photo_orphans(uuid, integer) is
  'Service-role-only exact-company orphan cleanup claimant.';
comment on function public.claim_storyops_scheduling_reconciliation(
  uuid, uuid, integer
) is
  'Service-role-only exact-company scheduling reconciliation claimant.';
comment on function public.claim_storyops_transactional_delivery(
  uuid, uuid, integer
) is
  'Service-role-only exact-company transactional outbound claimant.';

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

revoke all on function public.fail_storyops_post_service_followup(
  uuid, uuid, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.fail_storyops_post_service_followup(
  uuid, uuid, text, boolean
) to service_role;
revoke all on function public.fail_storyops_transactional_delivery(
  uuid, uuid, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.fail_storyops_transactional_delivery(
  uuid, uuid, text, boolean
) to service_role;

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

revoke all on function public.get_storyops_post_service_status(uuid)
  from public, anon, service_role;
grant execute on function public.get_storyops_post_service_status(uuid)
  to authenticated;

create or replace function public.get_storyops_workspace_before_deposit_truth(
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

revoke all on function public.get_storyops_workspace_before_deposit_truth(uuid)
  from public, anon, authenticated, service_role;

create table private.storyops_private_worker_heartbeats (
  company_id uuid not null
    references public.companies(id) on delete cascade,
  worker text not null check (worker in (
    'post_service',
    'transactional_outbound',
    'scheduling_reconciliation',
    'scope_photo_cleanup'
  )),
  deployment_fingerprint text not null
    check (deployment_fingerprint ~ '^[a-f0-9]{64}$'),
  configuration_hash text not null
    check (configuration_hash ~ '^[a-f0-9]{64}$'),
  trigger text not null check (trigger in ('manual', 'scheduled')),
  status text not null check (status in ('succeeded', 'failed')),
  observed_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (company_id, worker)
);

create table private.storyops_private_worker_readiness_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null
    references public.companies(id) on delete cascade,
  evidence_version integer not null check (evidence_version > 0),
  probe_run_id uuid not null,
  deployment_fingerprint text not null
    check (deployment_fingerprint ~ '^[a-f0-9]{64}$'),
  evidence_hash text not null
    check (evidence_hash ~ '^[a-f0-9]{64}$'),
  checked_at timestamptz not null,
  expires_at timestamptz not null,
  live_ready boolean not null,
  status text not null check (status in ('healthy', 'degraded', 'blocked')),
  projection jsonb not null check (jsonb_typeof(projection) = 'object'),
  evidence_source text not null default 'staff_probe'
    check (evidence_source in ('staff_probe', 'scheduled_refresh')),
  baseline_verified_by_user_id uuid not null
    references auth.users(id) on delete restrict,
  recorded_by_user_id uuid
    references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (company_id, evidence_version),
  unique (company_id, probe_run_id),
  check (expires_at > checked_at),
  check (
    (
      evidence_source = 'staff_probe'
      and recorded_by_user_id is not null
      and recorded_by_user_id = baseline_verified_by_user_id
    )
    or (
      evidence_source = 'scheduled_refresh'
      and recorded_by_user_id is null
    )
  )
);

create index storyops_private_worker_readiness_latest_idx
  on private.storyops_private_worker_readiness_snapshots(
    company_id, evidence_version desc
  );
create index storyops_private_worker_refresh_retention_idx
  on private.storyops_private_worker_readiness_snapshots(
    company_id, evidence_version desc
  )
  where evidence_source = 'scheduled_refresh';

revoke all on table private.storyops_private_worker_heartbeats
  from public, anon, authenticated, service_role;
revoke all on table private.storyops_private_worker_readiness_snapshots
  from public, anon, authenticated, service_role;

create or replace function private.storyops_missing_private_worker_projection(
  p_company_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'schemaVersion', 'storyops-private-worker-readiness-v2',
    'companyId', p_company_id,
    'checkedAt', now(),
    'expiresAt', now() + interval '1 second',
    'evidenceVersion', 1,
    'evidenceHash', repeat('0', 64),
    'deploymentFingerprint', repeat('0', 64),
    'alertAfterSeconds', 900,
    'status', 'blocked',
    'liveReady', false,
    'safeDisabled', false,
    'workers', (
      select jsonb_agg(jsonb_build_object(
        'worker', required.worker,
        'configurationEnabled', false,
        'activationMode', 'invalid',
        'credentialStatus', 'missing',
        'acceptedTrigger', null,
        'scheduleIntervalSeconds', null,
        'configurationHash', repeat('0', 64),
        'deploymentIdentityStatus', 'missing',
        'deploymentFingerprint', repeat('0', 64),
        'heartbeat', jsonb_build_object(
          'status', 'missing',
          'observedAt', null,
          'trigger', null
        ),
        'schedulerEvidence', 'missing',
        'status', 'blocked',
        'liveReady', false,
        'blockers', jsonb_build_array('WORKER_HEARTBEAT_MISSING'),
        'queue', jsonb_build_object(
          'availability', 'unavailable',
          'reasonCode', required.queue_reason
        )
      ) order by required.ordinality)
      from unnest(
        array[
          'post_service',
          'transactional_outbound',
          'scheduling_reconciliation',
          'scope_photo_cleanup'
        ]::text[],
        array[
          'POST_SERVICE_QUEUE_PROJECTION_UNAVAILABLE',
          'TRANSACTIONAL_QUEUE_PROJECTION_UNAVAILABLE',
          'SCHEDULING_RECONCILIATION_QUEUE_PROJECTION_UNAVAILABLE',
          'SCOPE_PHOTO_CLEANUP_QUEUE_PROJECTION_UNAVAILABLE'
        ]::text[]
      ) with ordinality as required(worker, queue_reason, ordinality)
    )
  )
$$;

create or replace function private.storyops_private_worker_snapshot(
  p_company_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, private
as $$
  select coalesce(
    (
      select snapshot.projection
      from private.storyops_private_worker_readiness_snapshots snapshot
      where snapshot.company_id = p_company_id
      order by snapshot.evidence_version desc
      limit 1
    ),
    private.storyops_missing_private_worker_projection(p_company_id)
  )
$$;

create or replace function public.record_storyops_private_worker_heartbeat(
  p_company_id uuid,
  p_worker text,
  p_deployment_fingerprint text,
  p_configuration_hash text,
  p_trigger text,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  observed_at_value timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'PRIVATE_WORKER_HEARTBEAT_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_worker not in (
      'post_service',
      'transactional_outbound',
      'scheduling_reconciliation',
      'scope_photo_cleanup'
    )
    or p_deployment_fingerprint !~ '^[a-f0-9]{64}$'
    or p_configuration_hash !~ '^[a-f0-9]{64}$'
    or p_trigger not in ('manual', 'scheduled')
    or p_status not in ('succeeded', 'failed')
  then
    raise exception 'PRIVATE_WORKER_HEARTBEAT_INVALID';
  end if;
  if not exists (
    select 1
    from public.companies company
    where company.id = p_company_id
  ) then
    raise exception 'PRIVATE_WORKER_HEARTBEAT_COMPANY_REQUIRED';
  end if;

  insert into private.storyops_private_worker_heartbeats(
    company_id,
    worker,
    deployment_fingerprint,
    configuration_hash,
    trigger,
    status,
    observed_at
  )
  values (
    p_company_id,
    p_worker,
    p_deployment_fingerprint,
    p_configuration_hash,
    p_trigger,
    p_status,
    observed_at_value
  )
  on conflict (company_id, worker) do update
  set
    deployment_fingerprint = excluded.deployment_fingerprint,
    configuration_hash = excluded.configuration_hash,
    trigger = excluded.trigger,
    status = excluded.status,
    observed_at = excluded.observed_at,
    recorded_at = clock_timestamp();

  return jsonb_build_object(
    'worker', p_worker,
    'status', p_status,
    'observedAt', observed_at_value
  );
end;
$$;

create or replace function public.load_storyops_private_worker_queue_evidence(
  p_company_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'PRIVATE_WORKER_QUEUE_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_actor_user_id is null
    or not exists (
      select 1
      from public.company_memberships membership
      where membership.company_id = p_company_id
        and membership.user_id = p_actor_user_id
        and membership.active
        and membership.role in ('owner', 'dispatcher')
    )
  then
    raise exception 'PRIVATE_WORKER_QUEUE_ACTIVE_STAFF_REQUIRED';
  end if;
  return jsonb_build_object(
    'postService', jsonb_build_object(
      'availability', 'verified',
      'backlogCount', (
        select count(*)::integer
        from public.post_service_followups followup
        where followup.company_id = p_company_id
          and followup.status in (
            'queued',
            'submitted',
            'submitted_unknown'
          )
      ),
      'dueCount', (
        select count(*)::integer
        from public.post_service_followups followup
        where followup.company_id = p_company_id
          and followup.status in ('queued', 'submitted')
          and followup.next_attempt_at <= now()
      ),
      'submissionUnknownCount', (
        select count(*)::integer
        from public.post_service_followups followup
        where followup.company_id = p_company_id
          and (
            followup.status = 'submitted_unknown'
            or (
              followup.status = 'submitted'
              and followup.last_error_code = 'RECONCILIATION_EXHAUSTED'
            )
          )
      ),
      'oldestQueuedAt', (
        select min(followup.scheduled_at)
        from public.post_service_followups followup
        where followup.company_id = p_company_id
          and followup.status in (
            'queued',
            'submitted',
            'submitted_unknown'
          )
      ),
      'oldestQueuedAgeSeconds', (
        select case
          when min(followup.scheduled_at) is null then null
          else greatest(
            0,
            floor(extract(epoch from (now() - min(followup.scheduled_at))))
          )::integer
        end
        from public.post_service_followups followup
        where followup.company_id = p_company_id
          and followup.status in (
            'queued',
            'submitted',
            'submitted_unknown'
          )
      ),
      'actionCounts', jsonb_build_object(
        'postService', (
          select count(*)::integer
          from public.post_service_followups followup
          where followup.company_id = p_company_id
            and followup.status in (
              'queued',
              'submitted',
              'submitted_unknown'
            )
        ),
        'quoteDelivery', 0,
        'onMyWay', 0,
        'schedulingReconciliation', 0,
        'scopePhotoCleanup', 0
      )
    ),
    'transactionalOutbound', jsonb_build_object(
      'availability', 'verified',
      'backlogCount', (
        select count(*)::integer
        from public.transactional_delivery_attempts delivery
        where delivery.company_id = p_company_id
          and (
            delivery.status in (
              'queued',
              'submitting',
              'submitted',
              'submitted_unknown'
            )
            or (
              delivery.status = 'failed'
              and delivery.last_error_code = 'RECONCILIATION_EXHAUSTED'
            )
          )
      ),
      'dueCount', (
        select count(*)::integer
        from public.transactional_delivery_attempts delivery
        where delivery.company_id = p_company_id
          and delivery.status in ('queued', 'submitted')
          and delivery.next_attempt_at <= now()
      ),
      'submissionUnknownCount', (
        select count(*)::integer
        from public.transactional_delivery_attempts delivery
        where delivery.company_id = p_company_id
          and (
            delivery.status = 'submitted_unknown'
            or (
              delivery.status = 'submitting'
              and delivery.claim_expires_at <= now()
            )
            or (
              delivery.status = 'submitted'
              and delivery.last_error_code = 'RECONCILIATION_EXHAUSTED'
            )
            or (
              delivery.status = 'failed'
              and delivery.last_error_code = 'RECONCILIATION_EXHAUSTED'
            )
          )
      ),
      'oldestQueuedAt', (
        select min(delivery.created_at)
        from public.transactional_delivery_attempts delivery
        where delivery.company_id = p_company_id
          and (
            delivery.status in (
              'queued',
              'submitting',
              'submitted',
              'submitted_unknown'
            )
            or (
              delivery.status = 'failed'
              and delivery.last_error_code = 'RECONCILIATION_EXHAUSTED'
            )
          )
      ),
      'oldestQueuedAgeSeconds', (
        select case
          when min(delivery.created_at) is null then null
          else greatest(
            0,
            floor(extract(epoch from (now() - min(delivery.created_at))))
          )::integer
        end
        from public.transactional_delivery_attempts delivery
        where delivery.company_id = p_company_id
          and (
            delivery.status in (
              'queued',
              'submitting',
              'submitted',
              'submitted_unknown'
            )
            or (
              delivery.status = 'failed'
              and delivery.last_error_code = 'RECONCILIATION_EXHAUSTED'
            )
          )
      ),
      'actionCounts', jsonb_build_object(
        'postService', 0,
        'quoteDelivery', (
          select count(*)::integer
          from public.transactional_delivery_attempts delivery
          where delivery.company_id = p_company_id
            and delivery.action_type = 'quote_delivery'
            and (
              delivery.status in (
                'queued',
                'submitting',
                'submitted',
                'submitted_unknown'
              )
              or (
                delivery.status = 'failed'
                and delivery.last_error_code = 'RECONCILIATION_EXHAUSTED'
              )
            )
        ),
        'onMyWay', (
          select count(*)::integer
          from public.transactional_delivery_attempts delivery
          where delivery.company_id = p_company_id
            and delivery.action_type = 'on_my_way'
            and (
              delivery.status in (
                'queued',
                'submitting',
                'submitted',
                'submitted_unknown'
              )
              or (
                delivery.status = 'failed'
                and delivery.last_error_code = 'RECONCILIATION_EXHAUSTED'
              )
            )
        ),
        'schedulingReconciliation', 0,
        'scopePhotoCleanup', 0
      )
    ),
    'schedulingReconciliation', jsonb_build_object(
      'availability', 'verified',
      'backlogCount', (
        select count(*)::integer
        from public.scheduling_reconciliation_cases reconciliation
        where reconciliation.company_id = p_company_id
          and reconciliation.status in (
            'pending',
            'retry_wait',
            'provider_unknown',
            'leased',
            'manual_required'
          )
      ),
      'dueCount', (
        select count(*)::integer
        from public.scheduling_reconciliation_cases reconciliation
        where reconciliation.company_id = p_company_id
          and reconciliation.status in (
            'pending',
            'retry_wait',
            'provider_unknown'
          )
          and reconciliation.next_attempt_at <= now()
      ),
      'submissionUnknownCount', (
        select count(*)::integer
        from public.scheduling_reconciliation_cases reconciliation
        where reconciliation.company_id = p_company_id
          and (
            reconciliation.status in ('provider_unknown', 'manual_required')
            or (
              reconciliation.status = 'leased'
              and reconciliation.claim_expires_at <= now()
            )
          )
      ),
      'oldestQueuedAt', (
        select min(reconciliation.created_at)
        from public.scheduling_reconciliation_cases reconciliation
        where reconciliation.company_id = p_company_id
          and reconciliation.status in (
            'pending',
            'retry_wait',
            'provider_unknown',
            'leased',
            'manual_required'
          )
      ),
      'oldestQueuedAgeSeconds', (
        select case
          when min(reconciliation.created_at) is null then null
          else greatest(
            0,
            floor(extract(epoch from (now() - min(reconciliation.created_at))))
          )::integer
        end
        from public.scheduling_reconciliation_cases reconciliation
        where reconciliation.company_id = p_company_id
          and reconciliation.status in (
            'pending',
            'retry_wait',
            'provider_unknown',
            'leased',
            'manual_required'
          )
      ),
      'actionCounts', jsonb_build_object(
        'postService', 0,
        'quoteDelivery', 0,
        'onMyWay', 0,
        'schedulingReconciliation', (
          select count(*)::integer
          from public.scheduling_reconciliation_cases reconciliation
          where reconciliation.company_id = p_company_id
            and reconciliation.status in (
              'pending',
              'retry_wait',
              'provider_unknown',
              'leased',
              'manual_required'
            )
        ),
        'scopePhotoCleanup', 0
      )
    ),
    'scopePhotoCleanup', jsonb_build_object(
      'availability', 'verified',
      'backlogCount', (
        select count(*)::integer
        from public.scope_photo_upload_reservations reservation
        where reservation.company_id = p_company_id
          and reservation.status in (
            'prepared',
            'cleanup_failed',
            'cleanup_claimed'
          )
      ),
      'dueCount', (
        select count(*)::integer
        from public.scope_photo_upload_reservations reservation
        where reservation.company_id = p_company_id
          and (
            (
              reservation.status = 'prepared'
              and reservation.expires_at <= now()
            )
            or (
              reservation.status = 'cleanup_failed'
              and reservation.cleanup_attempts < 10
              and reservation.updated_at <= now() - interval '15 minutes'
            )
          )
      ),
      'submissionUnknownCount', (
        select count(*)::integer
        from public.scope_photo_upload_reservations reservation
        where reservation.company_id = p_company_id
          and (
            reservation.status = 'cleanup_failed'
            or (
              reservation.status = 'cleanup_claimed'
              and reservation.cleanup_claimed_at
                <= now() - interval '15 minutes'
            )
          )
      ),
      'oldestQueuedAt', (
        select min(reservation.expires_at)
        from public.scope_photo_upload_reservations reservation
        where reservation.company_id = p_company_id
          and reservation.status in (
            'prepared',
            'cleanup_failed',
            'cleanup_claimed'
          )
      ),
      'oldestQueuedAgeSeconds', (
        select case
          when min(reservation.expires_at) is null then null
          else greatest(
            0,
            floor(extract(epoch from (now() - min(reservation.expires_at))))
          )::integer
        end
        from public.scope_photo_upload_reservations reservation
        where reservation.company_id = p_company_id
          and reservation.status in (
            'prepared',
            'cleanup_failed',
            'cleanup_claimed'
          )
      ),
      'actionCounts', jsonb_build_object(
        'postService', 0,
        'quoteDelivery', 0,
        'onMyWay', 0,
        'schedulingReconciliation', 0,
        'scopePhotoCleanup', (
          select count(*)::integer
          from public.scope_photo_upload_reservations reservation
          where reservation.company_id = p_company_id
            and reservation.status in (
              'prepared',
              'cleanup_failed',
              'cleanup_claimed'
            )
        )
      )
    )
  );
end;
$$;

create or replace function public.record_storyops_private_worker_readiness(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_probe_run_id uuid,
  p_deployment_fingerprint text,
  p_checked_at timestamptz,
  p_alert_after_seconds integer,
  p_workers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth, extensions
as $$
declare
  required_workers constant text[] := array[
    'post_service',
    'transactional_outbound',
    'scheduling_reconciliation',
    'scope_photo_cleanup'
  ]::text[];
  worker_name text;
  worker_input jsonb;
  worker_projection jsonb;
  workers_projection jsonb := '[]'::jsonb;
  heartbeat private.storyops_private_worker_heartbeats%rowtype;
  activation_mode text;
  credential_status text;
  accepted_trigger text;
  schedule_interval integer;
  configuration_hash text;
  deployment_identity_status text;
  queue_value jsonb;
  queue_availability text;
  backlog_count integer;
  due_count integer;
  unknown_count integer;
  oldest_age integer;
  heartbeat_status text;
  scheduler_evidence text;
  worker_status text;
  blockers text[];
  worker_live_ready boolean;
  all_live_ready boolean := true;
  all_disabled boolean := true;
  snapshot_status text;
  snapshot_hash text;
  snapshot_version integer;
  snapshot_expires_at timestamptz := p_checked_at + interval '5 minutes';
  worker_expires_at timestamptz;
  projection_value jsonb;
  existing_projection jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'PRIVATE_WORKER_READINESS_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_actor_user_id is null
    or not exists (
      select 1
      from public.company_memberships membership
      where membership.company_id = p_company_id
        and membership.user_id = p_actor_user_id
        and membership.active
        and membership.role in ('owner', 'dispatcher')
    )
  then
    raise exception 'PRIVATE_WORKER_READINESS_ACTIVE_STAFF_REQUIRED';
  end if;
  if p_probe_run_id is null
    or p_deployment_fingerprint !~ '^[a-f0-9]{64}$'
    or p_checked_at < now() - interval '2 minutes'
    or p_checked_at > now() + interval '1 minute'
    or p_alert_after_seconds not between 60 and 86400
    or jsonb_typeof(p_workers) <> 'array'
    or jsonb_array_length(p_workers) <> 4
    or (
      select count(distinct item ->> 'worker')
      from jsonb_array_elements(p_workers) item
    ) <> 4
    or exists (
      select 1
      from jsonb_array_elements(p_workers) item
      where item ->> 'worker' <> all(required_workers)
    )
  then
    raise exception 'PRIVATE_WORKER_READINESS_INVALID';
  end if;

  select snapshot.projection
  into existing_projection
  from private.storyops_private_worker_readiness_snapshots snapshot
  where snapshot.company_id = p_company_id
    and snapshot.probe_run_id = p_probe_run_id;
  if existing_projection is not null then
    return existing_projection;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'storyops-private-worker-readiness:' || p_company_id::text,
      0
    )
  );
  select coalesce(max(snapshot.evidence_version), 0) + 1
  into snapshot_version
  from private.storyops_private_worker_readiness_snapshots snapshot
  where snapshot.company_id = p_company_id;

  foreach worker_name in array required_workers loop
    select item into worker_input
    from jsonb_array_elements(p_workers) item
    where item ->> 'worker' = worker_name;

    if worker_input is null
      or (worker_input - array[
        'worker',
        'activationMode',
        'credentialStatus',
        'acceptedTrigger',
        'scheduleIntervalSeconds',
        'configurationHash',
        'deploymentIdentityStatus',
        'queue'
      ]::text[]) <> '{}'::jsonb
    then
      raise exception 'PRIVATE_WORKER_READINESS_WORKER_SHAPE_INVALID';
    end if;

    activation_mode := worker_input ->> 'activationMode';
    credential_status := worker_input ->> 'credentialStatus';
    accepted_trigger := worker_input ->> 'acceptedTrigger';
    configuration_hash := worker_input ->> 'configurationHash';
    deployment_identity_status :=
      worker_input ->> 'deploymentIdentityStatus';
    queue_value := worker_input -> 'queue';
    schedule_interval := case
      when jsonb_typeof(worker_input -> 'scheduleIntervalSeconds') = 'number'
      then (worker_input ->> 'scheduleIntervalSeconds')::integer
      else null
    end;

    if activation_mode not in ('disabled', 'manual', 'scheduled', 'invalid')
      or credential_status not in (
        'valid',
        'missing',
        'too_short',
        'surrounding_whitespace',
        'service_role_reuse',
        'peer_worker_reuse'
      )
      or (
        accepted_trigger is not null
        and accepted_trigger not in ('manual', 'scheduled')
      )
      or configuration_hash !~ '^[a-f0-9]{64}$'
      or deployment_identity_status not in ('valid', 'missing', 'invalid')
      or jsonb_typeof(queue_value) <> 'object'
    then
      raise exception 'PRIVATE_WORKER_READINESS_WORKER_VALUE_INVALID';
    end if;

    blockers := array[]::text[];
    if deployment_identity_status = 'missing' then
      blockers := array_append(
        blockers,
        'WORKER_DEPLOYMENT_IDENTITY_MISSING'
      );
    elsif deployment_identity_status = 'invalid' then
      blockers := array_append(
        blockers,
        'WORKER_DEPLOYMENT_IDENTITY_INVALID'
      );
    end if;
    if activation_mode = 'disabled' then
      blockers := array_append(blockers, 'WORKER_INACTIVE');
    elsif activation_mode = 'invalid' then
      blockers := array_append(blockers, 'WORKER_ACTIVATION_INVALID');
    elsif activation_mode <> 'scheduled'
      or accepted_trigger is distinct from 'scheduled'
      or schedule_interval is null
      or schedule_interval not between 15 and 3600
    then
      blockers := array_append(blockers, 'WORKER_SCHEDULE_REQUIRED');
    end if;
    if credential_status <> 'valid'
      and not (
        activation_mode = 'disabled'
        and credential_status = 'missing'
      )
    then
      blockers := array_append(blockers, 'WORKER_CREDENTIAL_INVALID');
    end if;

    select * into heartbeat
    from private.storyops_private_worker_heartbeats current_heartbeat
    where current_heartbeat.company_id = p_company_id
      and current_heartbeat.worker = worker_name;

    if activation_mode = 'disabled' then
      heartbeat_status := 'missing';
      scheduler_evidence := 'not_required';
    elsif heartbeat.company_id is null then
      heartbeat_status := 'missing';
      scheduler_evidence := 'missing';
      blockers := array_append(blockers, 'WORKER_HEARTBEAT_MISSING');
    elsif heartbeat.deployment_fingerprint <> p_deployment_fingerprint then
      heartbeat_status := 'deployment_drift';
      scheduler_evidence := 'deployment_drift';
      blockers := array_append(blockers, 'WORKER_DEPLOYMENT_DRIFT');
    elsif heartbeat.configuration_hash <> configuration_hash then
      heartbeat_status := 'configuration_drift';
      scheduler_evidence := 'configuration_drift';
      blockers := array_append(
        blockers,
        'WORKER_CONFIGURATION_HASH_DRIFT'
      );
    elsif heartbeat.status <> 'succeeded'
      or heartbeat.trigger <> 'scheduled'
    then
      heartbeat_status := 'failed';
      scheduler_evidence := 'failed';
      blockers := array_append(blockers, 'WORKER_HEARTBEAT_FAILED');
    elsif schedule_interval is null
      or heartbeat.observed_at < p_checked_at
        - make_interval(secs => greatest(schedule_interval * 2, 120))
      or heartbeat.observed_at > p_checked_at + interval '1 minute'
    then
      heartbeat_status := 'stale';
      scheduler_evidence := 'stale';
      blockers := array_append(blockers, 'WORKER_HEARTBEAT_STALE');
    else
      heartbeat_status := 'verified';
      scheduler_evidence := 'verified';
      worker_expires_at := least(
        p_checked_at + interval '5 minutes',
        heartbeat.observed_at
          + make_interval(secs => greatest(schedule_interval * 2, 120))
      );
      snapshot_expires_at := least(snapshot_expires_at, worker_expires_at);
    end if;

    queue_availability := queue_value ->> 'availability';
    if queue_availability <> 'verified' then
      blockers := array_append(blockers, 'WORKER_QUEUE_UNAVAILABLE');
    else
      if (queue_value - array[
          'availability',
          'backlogCount',
          'dueCount',
          'submissionUnknownCount',
          'oldestQueuedAt',
          'oldestQueuedAgeSeconds',
          'actionCounts'
        ]::text[]) <> '{}'::jsonb
      then
        raise exception 'PRIVATE_WORKER_READINESS_QUEUE_SHAPE_INVALID';
      end if;
      backlog_count := (queue_value ->> 'backlogCount')::integer;
      due_count := (queue_value ->> 'dueCount')::integer;
      unknown_count := (queue_value ->> 'submissionUnknownCount')::integer;
      oldest_age := case
        when jsonb_typeof(queue_value -> 'oldestQueuedAgeSeconds') = 'number'
        then (queue_value ->> 'oldestQueuedAgeSeconds')::integer
        else null
      end;
      if backlog_count < 0
        or due_count < 0
        or due_count > backlog_count
        or unknown_count < 0
        or unknown_count > backlog_count
      then
        raise exception 'PRIVATE_WORKER_READINESS_QUEUE_VALUE_INVALID';
      end if;
      if unknown_count > 0 then
        blockers := array_append(blockers, 'WORKER_SUBMISSION_UNKNOWN');
      end if;
      if oldest_age is not null
        and oldest_age > p_alert_after_seconds
      then
        blockers := array_append(blockers, 'WORKER_QUEUE_STALE');
      end if;
    end if;

    select coalesce(array_agg(distinct blocker order by blocker), array[]::text[])
    into blockers
    from unnest(blockers) blocker;

    worker_live_ready := cardinality(blockers) = 0
      and activation_mode = 'scheduled'
      and credential_status = 'valid'
      and heartbeat_status = 'verified'
      and scheduler_evidence = 'verified';
    worker_status := case
      when worker_live_ready then 'healthy'
      when activation_mode = 'disabled'
        and blockers = array['WORKER_INACTIVE']::text[]
      then 'inactive'
      else 'blocked'
    end;
    all_live_ready := all_live_ready and worker_live_ready;
    all_disabled := all_disabled and worker_status = 'inactive';

    worker_projection := jsonb_build_object(
      'worker', worker_name,
      'configurationEnabled',
        activation_mode in ('manual', 'scheduled')
        and credential_status = 'valid',
      'activationMode', activation_mode,
      'credentialStatus', credential_status,
      'acceptedTrigger', accepted_trigger,
      'scheduleIntervalSeconds', schedule_interval,
      'configurationHash', configuration_hash,
      'deploymentIdentityStatus', deployment_identity_status,
      'deploymentFingerprint', p_deployment_fingerprint,
      'heartbeat', jsonb_build_object(
        'status', heartbeat_status,
        'observedAt', heartbeat.observed_at,
        'trigger', heartbeat.trigger
      ),
      'schedulerEvidence', scheduler_evidence,
      'status', worker_status,
      'liveReady', worker_live_ready,
      'blockers', to_jsonb(blockers),
      'queue', queue_value
    );
    workers_projection := workers_projection || jsonb_build_array(
      worker_projection
    );
    heartbeat := null;
  end loop;

  snapshot_status := case when all_live_ready then 'healthy' else 'blocked' end;
  if not all_live_ready then
    snapshot_expires_at := p_checked_at + interval '1 minute';
  end if;
  snapshot_hash := encode(
    extensions.digest(
      (
        select jsonb_build_object(
          'alertAfterSeconds', p_alert_after_seconds,
          'workers', jsonb_agg(jsonb_build_object(
            'worker', worker ->> 'worker',
            'activationMode', worker ->> 'activationMode',
            'credentialStatus', worker ->> 'credentialStatus',
            'scheduleIntervalSeconds', worker -> 'scheduleIntervalSeconds',
            'configurationHash', worker ->> 'configurationHash',
            'deploymentIdentityStatus',
              worker ->> 'deploymentIdentityStatus',
            'deploymentFingerprint', worker ->> 'deploymentFingerprint'
          ) order by worker ->> 'worker')
        )::text
        from jsonb_array_elements(workers_projection) worker
      ),
      'sha256'
    ),
    'hex'
  );
  projection_value := jsonb_build_object(
    'schemaVersion', 'storyops-private-worker-readiness-v2',
    'companyId', p_company_id,
    'checkedAt', p_checked_at,
    'expiresAt', snapshot_expires_at,
    'evidenceVersion', snapshot_version,
    'evidenceHash', snapshot_hash,
    'deploymentFingerprint', p_deployment_fingerprint,
    'alertAfterSeconds', p_alert_after_seconds,
    'status', snapshot_status,
    'liveReady', all_live_ready,
    'safeDisabled', all_disabled,
    'workers', workers_projection
  );

  insert into private.storyops_private_worker_readiness_snapshots(
    company_id,
    evidence_version,
    probe_run_id,
    deployment_fingerprint,
    evidence_hash,
    checked_at,
    expires_at,
    live_ready,
    status,
    projection,
    baseline_verified_by_user_id,
    recorded_by_user_id
  )
  values (
    p_company_id,
    snapshot_version,
    p_probe_run_id,
    p_deployment_fingerprint,
    snapshot_hash,
    p_checked_at,
    snapshot_expires_at,
    all_live_ready,
    snapshot_status,
    projection_value,
    p_actor_user_id,
    p_actor_user_id
  );
  return projection_value;
end;
$$;

create or replace function
  private.prune_storyops_private_worker_refresh_history(
    p_company_id uuid,
    p_retain_recent integer default 2048
  )
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  deleted_count integer;
begin
  if p_company_id is null
    or p_retain_recent not between 256 and 8192
  then
    raise exception 'PRIVATE_WORKER_REFRESH_RETENTION_INVALID';
  end if;

  with ranked as materialized (
    select
      snapshot.id,
      snapshot.evidence_version,
      row_number() over (
        order by snapshot.evidence_version desc
      ) as recency_rank
    from private.storyops_private_worker_readiness_snapshots snapshot
    where snapshot.company_id = p_company_id
      and snapshot.evidence_source = 'scheduled_refresh'
  ),
  deleted as (
    delete from private.storyops_private_worker_readiness_snapshots snapshot
    using ranked candidate
    where snapshot.id = candidate.id
      and candidate.recency_rank > p_retain_recent
      and snapshot.id <> (
        select latest.id
        from private.storyops_private_worker_readiness_snapshots latest
        where latest.company_id = p_company_id
        order by latest.evidence_version desc
        limit 1
      )
      and not exists (
        select 1
        from public.company_launch_authorization_events event
        where event.company_id = p_company_id
          and event.private_worker_evidence_version =
            candidate.evidence_version
      )
    returning 1
  )
  select count(*)::integer into deleted_count from deleted;
  return deleted_count;
end;
$$;

create or replace function
  private.refresh_storyops_private_worker_readiness()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  prior_snapshot private.storyops_private_worker_readiness_snapshots%rowtype;
  actor_user_id uuid;
  queue_evidence jsonb;
  workers_input jsonb;
  refresh_run_id uuid := gen_random_uuid();
  refresh_unprotected_count integer;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      'storyops-private-worker-readiness:' || new.company_id::text,
      0
    )
  );
  select * into prior_snapshot
  from private.storyops_private_worker_readiness_snapshots snapshot
  where snapshot.company_id = new.company_id
  order by snapshot.evidence_version desc
  limit 1;
  if prior_snapshot.id is null then
    return new;
  end if;
  actor_user_id := prior_snapshot.baseline_verified_by_user_id;
  if actor_user_id is null
    or not exists (
      select 1
      from public.company_memberships membership
      where membership.company_id = new.company_id
        and membership.user_id = actor_user_id
        and membership.active
        and membership.role in ('owner', 'dispatcher')
    )
  then
    return new;
  end if;

  queue_evidence :=
    public.load_storyops_private_worker_queue_evidence(
      new.company_id,
      actor_user_id
    );
  select jsonb_agg(
    (
      worker - array[
        'configurationEnabled',
        'deploymentFingerprint',
        'heartbeat',
        'schedulerEvidence',
        'status',
        'liveReady',
        'blockers',
        'queue'
      ]::text[]
    ) || jsonb_build_object(
      'queue',
      queue_evidence -> case worker ->> 'worker'
        when 'post_service' then 'postService'
        when 'transactional_outbound' then 'transactionalOutbound'
        when 'scheduling_reconciliation' then 'schedulingReconciliation'
        when 'scope_photo_cleanup' then 'scopePhotoCleanup'
      end
    )
    order by ordinality
  )
  into workers_input
  from jsonb_array_elements(
    prior_snapshot.projection -> 'workers'
  ) with ordinality as projected(worker, ordinality);

  perform public.record_storyops_private_worker_readiness(
    new.company_id,
    actor_user_id,
    refresh_run_id,
    prior_snapshot.deployment_fingerprint,
    clock_timestamp(),
    (prior_snapshot.projection ->> 'alertAfterSeconds')::integer,
    workers_input
  );
  update private.storyops_private_worker_readiness_snapshots
  set
    evidence_source = 'scheduled_refresh',
    recorded_by_user_id = null
  where company_id = new.company_id
    and probe_run_id = refresh_run_id;
  select count(*)::integer
  into refresh_unprotected_count
  from private.storyops_private_worker_readiness_snapshots snapshot
  where snapshot.company_id = new.company_id
    and snapshot.evidence_source = 'scheduled_refresh'
    and not exists (
      select 1
      from public.company_launch_authorization_events event
      where event.company_id = new.company_id
        and event.private_worker_evidence_version =
          snapshot.evidence_version
    );
  if refresh_unprotected_count > 2111 then
    perform private.prune_storyops_private_worker_refresh_history(
      new.company_id,
      2048
    );
  end if;
  return new;
end;
$$;

create trigger storyops_private_worker_heartbeat_refresh
after insert or update on private.storyops_private_worker_heartbeats
for each row
execute function private.refresh_storyops_private_worker_readiness();

revoke all on function public.record_storyops_private_worker_heartbeat(
  uuid, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_storyops_private_worker_heartbeat(
  uuid, text, text, text, text, text
) to service_role;
revoke all on function public.load_storyops_private_worker_queue_evidence(
  uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_private_worker_queue_evidence(
  uuid, uuid
) to service_role;
revoke all on function public.record_storyops_private_worker_readiness(
  uuid, uuid, uuid, text, timestamptz, integer, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_storyops_private_worker_readiness(
  uuid, uuid, uuid, text, timestamptz, integer, jsonb
) to service_role;
revoke all on function private.storyops_missing_private_worker_projection(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_private_worker_snapshot(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  private.refresh_storyops_private_worker_readiness()
  from public, anon, authenticated, service_role;
revoke all on function
  private.prune_storyops_private_worker_refresh_history(uuid, integer)
  from public, anon, authenticated, service_role;

-- Existing authorization events intentionally lack this new evidence binding
-- and therefore become ineffective. New owner authorizations are stamped by
-- this trigger only after all four workers are currently live-ready.
create or replace function private.enforce_storyops_private_worker_launch_gate()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  snapshot private.storyops_private_worker_readiness_snapshots%rowtype;
begin
  if new.action <> 'authorize' then
    return new;
  end if;
  select * into snapshot
  from private.storyops_private_worker_readiness_snapshots current_snapshot
  where current_snapshot.company_id = new.company_id
  order by current_snapshot.evidence_version desc
  limit 1;
  if snapshot.id is null
    or not snapshot.live_ready
    or snapshot.status <> 'healthy'
    or snapshot.expires_at <= now()
    or snapshot.checked_at < now() - interval '5 minutes'
    or snapshot.checked_at > now() + interval '1 minute'
  then
    raise exception using
      errcode = '55000',
      message = 'PRIVATE_WORKER_READINESS_REQUIRED';
  end if;
  new.private_worker_evidence_version := snapshot.evidence_version;
  new.private_worker_evidence_hash := snapshot.evidence_hash;
  new.private_worker_evidence_expires_at := snapshot.expires_at;
  return new;
end;
$$;

create trigger storyops_01_private_worker_launch_gate
before insert on public.company_launch_authorization_events
for each row
execute function private.enforce_storyops_private_worker_launch_gate();

alter function private.storyops_launch_authorization_effective(uuid)
  rename to storyops_launch_authorization_base_before_private_workers;

create or replace function
  private.storyops_private_worker_launch_binding_effective(
    p_company_id uuid
  )
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select exists (
    select 1
    from lateral (
      select event.*
      from public.company_launch_authorization_events event
      where event.company_id = p_company_id
      order by event.version desc
      limit 1
    ) event
    join lateral (
      select snapshot.*
      from private.storyops_private_worker_readiness_snapshots snapshot
      where snapshot.company_id = p_company_id
      order by snapshot.evidence_version desc
      limit 1
    ) current_snapshot on true
    where event.action = 'authorize'
      and event.private_worker_evidence_version is not null
      and event.private_worker_evidence_hash is not null
      and event.private_worker_evidence_expires_at is not null
      and current_snapshot.live_ready
      and current_snapshot.status = 'healthy'
      and current_snapshot.expires_at > now()
      and current_snapshot.checked_at >= now() - interval '5 minutes'
      and current_snapshot.checked_at <= now() + interval '1 minute'
      and current_snapshot.evidence_version
        >= event.private_worker_evidence_version
      and current_snapshot.evidence_hash
        = event.private_worker_evidence_hash
  )
$$;

create or replace function private.storyops_launch_authorization_effective(
  p_company_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select
    private.storyops_launch_authorization_base_before_private_workers(
      p_company_id
    )
    and private.storyops_private_worker_launch_binding_effective(
      p_company_id
    )
$$;

revoke all on function
  private.storyops_launch_authorization_base_before_private_workers(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_launch_authorization_effective(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  private.storyops_private_worker_launch_binding_effective(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  private.enforce_storyops_private_worker_launch_gate()
  from public, anon, authenticated, service_role;

alter function public.get_storyops_provider_launch_state(uuid)
  rename to get_storyops_provider_launch_state_before_private_workers;

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
  base_state jsonb;
  worker_state jsonb;
begin
  base_state :=
    public.get_storyops_provider_launch_state_before_private_workers(
      p_company_id
    );
  worker_state := private.storyops_private_worker_snapshot(p_company_id);
  return base_state || jsonb_build_object(
    'privateWorkers', worker_state
  );
end;
$$;

revoke all on function
  public.get_storyops_provider_launch_state_before_private_workers(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_storyops_provider_launch_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_storyops_provider_launch_state(uuid)
  to authenticated;

comment on table private.storyops_private_worker_heartbeats is
  'Secret-free, company/deployment/configuration-bound proof that a dedicated private worker endpoint actually ran.';
comment on table private.storyops_private_worker_readiness_snapshots is
  'Immutable four-worker readiness snapshots. Queue uncertainty, stale heartbeats, configuration drift, or any missing worker fail closed.';
comment on function public.record_storyops_private_worker_readiness(
  uuid, uuid, uuid, text, timestamptz, integer, jsonb
) is
  'Service-only readiness recorder. Persists four exact workers and independently joins their durable scheduler heartbeats.';
