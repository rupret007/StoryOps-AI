-- Forward-only residential service-pack cadence expansion.
-- Historical migrations remain immutable; this migration upgrades existing databases.

alter table public.recurring_maintenance_plans
  drop constraint if exists recurring_maintenance_plans_cadence_check;

alter table public.recurring_maintenance_plans
  add constraint recurring_maintenance_plans_cadence_check
  check (
    cadence in (
      'weekly',
      'biweekly',
      'every_four_weeks',
      'monthly',
      'quarterly',
      'semiannual',
      'annual',
      'custom'
    )
  );

create or replace function public.execute_storyops_post_service_action(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_action text,
  p_invoice_id uuid,
  p_expected_version integer,
  p_details jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_role public.app_role;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  invoice_row public.invoices%rowtype;
  job_row public.jobs%rowtype;
  quote_row public.quotes%rowtype;
  estimate_row public.estimates%rowtype;
  consent_row public.consent_records%rowtype;
  followup_row public.post_service_followups%rowtype;
  referral_row public.referrals%rowtype;
  plan_row public.recurring_maintenance_plans%rowtype;
  outbound_decision record;
  normalized_contact text;
  contact_digits text;
  contact_fingerprint text;
  action_type_value text;
  channel_value text;
  cadence_value text;
  interval_days_value integer;
  next_due_date_value date;
  scheduled_at_value timestamptz;
  record_id_value uuid;
  status_value text;
  response_value jsonb;
  already_existed_value boolean := false;
  allowed_keys text[];
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'POST_SERVICE_TRUSTED_EDGE_REQUIRED';
  end if;
  if p_company_id is null
    or p_actor_user_id is null
    or p_command_id is null
    or p_invoice_id is null
    or p_expected_version is null
    or p_expected_version < 1
    or p_details is null
    or jsonb_typeof(p_details) <> 'object'
    or p_action not in (
      'review.request',
      'referral.invite',
      'maintenance.activate'
    )
  then
    raise exception 'POST_SERVICE_INVALID_REQUEST';
  end if;

  allowed_keys := case
    when p_action in ('review.request', 'referral.invite')
      then array['channel']::text[]
    else array['cadence', 'intervalDays', 'nextDueDate']::text[]
  end;
  if exists (
    select 1
    from jsonb_object_keys(p_details) keys(key)
    where not (keys.key = any(allowed_keys))
  ) then
    raise exception 'POST_SERVICE_INVALID_DETAILS';
  end if;

  if p_action in ('review.request', 'referral.invite') then
    if (
      select count(*)
      from jsonb_object_keys(p_details)
    ) <> 1
      or p_details ->> 'channel' not in ('sms', 'email')
    then
      raise exception 'POST_SERVICE_INVALID_DETAILS';
    end if;
    channel_value := p_details ->> 'channel';
  else
    begin
      cadence_value := nullif(p_details ->> 'cadence', '');
      interval_days_value := nullif(p_details ->> 'intervalDays', '')::integer;
      next_due_date_value := nullif(p_details ->> 'nextDueDate', '')::date;
    exception when others then
      raise exception 'POST_SERVICE_INVALID_DETAILS';
    end;
    if cadence_value not in (
      'weekly',
      'biweekly',
      'every_four_weeks',
      'monthly',
      'quarterly',
      'semiannual',
      'annual',
      'custom'
    )
      or next_due_date_value is null
      or next_due_date_value <= current_date
      or next_due_date_value > current_date + 3650
      or (
        cadence_value = 'custom'
        and (
          interval_days_value is null
          or interval_days_value not between 1 and 3650
        )
      )
      or (
        cadence_value <> 'custom'
        and interval_days_value is not null
      )
    then
      raise exception 'POST_SERVICE_INVALID_DETAILS';
    end if;
  end if;

  effective_request_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'action', p_action,
        'invoiceId', p_invoice_id,
        'expectedVersion', p_expected_version,
        'details', p_details
      )::text,
      'sha256'
    ),
    'hex'
  );

  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = p_actor_user_id
    and membership.active;
  if actor_role is null
    or actor_role not in ('owner', 'dispatcher', 'customer')
  then
    raise exception 'POST_SERVICE_ROLE_REQUIRED';
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
    'post-service-action-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'post-service-action-v1'
      and key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception 'POST_SERVICE_IDEMPOTENCY_CONFLICT';
    end if;
    if reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'POST_SERVICE_COMMAND_IN_PROGRESS';
  end if;

  select *
  into invoice_row
  from public.invoices invoice
  where invoice.id = p_invoice_id
    and invoice.company_id = p_company_id
  for update;
  if not found then
    raise exception 'POST_SERVICE_INVOICE_REQUIRED';
  end if;
  if invoice_row.version <> p_expected_version then
    raise exception 'POST_SERVICE_INVOICE_VERSION_CONFLICT';
  end if;
  if invoice_row.status <> 'paid'
    or invoice_row.balance_due <> 0
    or invoice_row.amount_paid <> invoice_row.total
    or invoice_row.paid_at is null
    or not public.storyops_invoice_has_provider_proof(invoice_row.id)
  then
    raise exception 'POST_SERVICE_PROVIDER_PAID_INVOICE_REQUIRED';
  end if;

  select *
  into job_row
  from public.jobs job
  where job.id = invoice_row.job_id
    and job.company_id = p_company_id
    and job.customer_id = invoice_row.customer_id
  for update;
  if not found
    or job_row.status not in ('completed', 'invoiced')
    or cardinality(job_row.service_codes) = 0
    or not exists (
      select 1
      from public.visits visit
      where visit.company_id = p_company_id
        and visit.job_id = job_row.id
        and visit.status = 'completed'
    )
    or exists (
      select 1
      from public.visits visit
      where visit.company_id = p_company_id
        and visit.job_id = job_row.id
        and visit.status not in ('completed', 'cancelled')
    )
  then
    raise exception 'POST_SERVICE_COMPLETED_JOB_REQUIRED';
  end if;

  if actor_role = 'customer'
    and not exists (
      select 1
      from public.customer_portal_users portal
      where portal.company_id = p_company_id
        and portal.user_id = p_actor_user_id
        and portal.customer_id = invoice_row.customer_id
    )
  then
    raise exception 'POST_SERVICE_CUSTOMER_SCOPE_REQUIRED';
  end if;

  select *
  into quote_row
  from public.quotes quote
  where quote.id = job_row.quote_id
    and quote.company_id = p_company_id
    and quote.customer_id = job_row.customer_id
    and quote.property_id = job_row.property_id;
  select *
  into estimate_row
  from public.estimates estimate
  where estimate.id = quote_row.estimate_id
    and estimate.company_id = p_company_id
    and estimate.customer_id = job_row.customer_id
    and estimate.property_id = job_row.property_id;
  if quote_row.id is null or estimate_row.id is null then
    raise exception 'POST_SERVICE_ACCEPTED_PRICING_REQUIRED';
  end if;
  perform public.assert_storyops_accepted_pricing(
    p_company_id,
    quote_row.id
  );

  if p_action in ('review.request', 'referral.invite') then
    select consent.*
    into consent_row
    from public.consent_records consent
    where consent.company_id = p_company_id
      and consent.customer_id = invoice_row.customer_id
      and consent.channel = channel_value
      and consent.purpose = 'marketing'
    order by
      consent.created_at desc,
      consent.captured_at desc,
      case when consent.status = 'granted' then 0 else 1 end desc,
      consent.id desc
    limit 1
    for share;
    if not found
      or consent_row.status <> 'granted'
      or consent_row.withdrawn_at is not null
    then
      raise exception 'POST_SERVICE_CURRENT_CONSENT_REQUIRED';
    end if;

    select case
      when channel_value = 'email'
        then nullif(lower(btrim(customer.email::text)), '')
      else null
    end
    into normalized_contact
    from public.customers customer
    where customer.id = invoice_row.customer_id
      and customer.company_id = p_company_id;
    if channel_value = 'sms' then
      select regexp_replace(coalesce(customer.phone, ''), '[^0-9]', '', 'g')
      into contact_digits
      from public.customers customer
      where customer.id = invoice_row.customer_id
        and customer.company_id = p_company_id;
      normalized_contact := case
        when length(contact_digits) = 10 then '+1' || contact_digits
        when length(contact_digits) = 11 and left(contact_digits, 1) = '1'
          then '+' || contact_digits
        else null
      end;
    end if;
    if normalized_contact is null then
      raise exception 'POST_SERVICE_CURRENT_CONSENT_REQUIRED';
    end if;
    contact_fingerprint := encode(
      extensions.digest(normalized_contact, 'sha256'),
      'hex'
    );
    select *
    into outbound_decision
    from public.authorize_outbound_contact(
      p_company_id,
      channel_value,
      'marketing',
      contact_fingerprint,
      consent_row.id
    );
    if not coalesce(outbound_decision.allowed, false)
      or outbound_decision.consent_record_id <> consent_row.id
      or outbound_decision.latest_consent_record_id <> consent_row.id
    then
      raise exception 'POST_SERVICE_CURRENT_CONSENT_REQUIRED';
    end if;

    action_type_value := case
      when p_action = 'review.request' then 'review_request'
      else 'referral_invite'
    end;
    scheduled_at_value := case
      when p_action = 'review.request' then now() + interval '2 hours'
      else now() + interval '1 day'
    end;

    if p_action = 'referral.invite' then
      select *
      into referral_row
      from public.referrals referral
      where referral.company_id = p_company_id
        and referral.source_invoice_id = invoice_row.id
      for update;
      if found then
        if referral_row.source_job_id <> job_row.id
          or referral_row.referrer_customer_id <> job_row.customer_id
          or referral_row.status <> 'invited'
        then
          raise exception 'POST_SERVICE_ACTION_ALREADY_EXISTS';
        end if;
      else
        insert into public.referrals(
          company_id,
          referrer_customer_id,
          status,
          source_invoice_id,
          source_job_id,
          invited_by_user_id,
          invited_at
        )
        values (
          p_company_id,
          job_row.customer_id,
          'invited',
          invoice_row.id,
          job_row.id,
          p_actor_user_id,
          now()
        )
        returning * into referral_row;
      end if;
    end if;

    select *
    into followup_row
    from public.post_service_followups followup
    where followup.company_id = p_company_id
      and followup.invoice_id = invoice_row.id
      and followup.action_type = action_type_value
    for update;
    if found then
      if followup_row.channel <> channel_value
        or (
          p_action = 'referral.invite'
          and followup_row.referral_id <> referral_row.id
        )
      then
        raise exception 'POST_SERVICE_ACTION_ALREADY_EXISTS';
      end if;
      already_existed_value := true;
    else
      insert into public.post_service_followups(
        company_id,
        invoice_id,
        job_id,
        customer_id,
        property_id,
        action_type,
        channel,
        consent_record_id,
        referral_id,
        status,
        scheduled_at,
        created_by_user_id
      )
      values (
        p_company_id,
        invoice_row.id,
        job_row.id,
        job_row.customer_id,
        job_row.property_id,
        action_type_value,
        channel_value,
        consent_row.id,
        case
          when p_action = 'referral.invite' then referral_row.id
          else null
        end,
        'queued',
        scheduled_at_value,
        p_actor_user_id
      )
      returning * into followup_row;
    end if;

    record_id_value := followup_row.id;
    status_value := followup_row.status;
    response_value := jsonb_build_object(
      'schemaVersion', 'storyops-post-service-v1',
      'companyId', p_company_id,
      'action', p_action,
      'commandId', p_command_id,
      'invoiceId', invoice_row.id,
      'invoiceVersion', invoice_row.version,
      'jobId', job_row.id,
      'recordId', record_id_value,
      'domainRecordId', case
        when p_action = 'referral.invite' then referral_row.id
        else followup_row.id
      end,
      'status', status_value,
      'channel', followup_row.channel,
      'scheduledAt', followup_row.scheduled_at,
      'replayed', false,
      'alreadyExisted', already_existed_value,
      'requestHash', effective_request_hash,
      'serverTime', now()
    );
  else
    select *
    into plan_row
    from public.recurring_maintenance_plans plan
    where plan.company_id = p_company_id
      and plan.source_job_id = job_row.id
      and plan.status = 'active'
    for update;
    if found then
      if plan_row.customer_id <> job_row.customer_id
        or plan_row.property_id <> job_row.property_id
        or plan_row.service_codes <> job_row.service_codes
        or plan_row.cadence <> cadence_value
        or plan_row.interval_days is distinct from interval_days_value
        or plan_row.next_due_date <> next_due_date_value
        or plan_row.price_book_id <> estimate_row.price_book_id
        or plan_row.source_invoice_id <> invoice_row.id
        or plan_row.source_estimate_id <> estimate_row.id
        or not plan_row.requires_fresh_estimate
      then
        raise exception 'POST_SERVICE_ACTION_ALREADY_EXISTS';
      end if;
      already_existed_value := true;
    else
      insert into public.recurring_maintenance_plans(
        company_id,
        customer_id,
        property_id,
        service_codes,
        cadence,
        interval_days,
        next_due_date,
        status,
        price_book_id,
        requires_fresh_estimate,
        source_job_id,
        source_invoice_id,
        source_estimate_id,
        activated_by_user_id,
        activated_at
      )
      values (
        p_company_id,
        job_row.customer_id,
        job_row.property_id,
        job_row.service_codes,
        cadence_value,
        interval_days_value,
        next_due_date_value,
        'active',
        estimate_row.price_book_id,
        true,
        job_row.id,
        invoice_row.id,
        estimate_row.id,
        p_actor_user_id,
        now()
      )
      returning * into plan_row;
    end if;

    record_id_value := plan_row.id;
    status_value := plan_row.status;
    response_value := jsonb_build_object(
      'schemaVersion', 'storyops-post-service-v1',
      'companyId', p_company_id,
      'action', p_action,
      'commandId', p_command_id,
      'invoiceId', invoice_row.id,
      'invoiceVersion', invoice_row.version,
      'jobId', job_row.id,
      'recordId', record_id_value,
      'domainRecordId', plan_row.id,
      'status', status_value,
      'cadence', plan_row.cadence,
      'nextDueDate', plan_row.next_due_date,
      'requiresFreshEstimate', plan_row.requires_fresh_estimate,
      'replayed', false,
      'alreadyExisted', already_existed_value,
      'requestHash', effective_request_hash,
      'serverTime', now()
    );
  end if;

  if not already_existed_value then
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
      case when actor_role = 'customer' then 'customer' else 'user' end,
      p_actor_user_id::text,
      case p_action
        when 'review.request' then 'post_service.review_queued'
        when 'referral.invite' then 'post_service.referral_queued'
        else 'post_service.maintenance_activated'
      end,
      case
        when p_action = 'maintenance.activate'
          then 'recurring_maintenance_plan'
        else 'post_service_followup'
      end,
      record_id_value,
      jsonb_build_object(
        'invoiceId', invoice_row.id,
        'jobId', job_row.id,
        'status', status_value,
        'providerDeliveryClaimed', false
      ),
      p_command_id::text
    );
  end if;

  update public.idempotency_keys
  set
    status = 'completed',
    response = response_value,
    completed_at = now()
  where id = reservation_id
    and status = 'in_progress';
  if not found then
    raise exception 'POST_SERVICE_COMMAND_RESERVATION_LOST';
  end if;
  return response_value;
end;
$$;

revoke all on function public.execute_storyops_post_service_action(
  uuid,
  uuid,
  uuid,
  text,
  uuid,
  integer,
  jsonb
) from public, anon, authenticated;
grant execute on function public.execute_storyops_post_service_action(
  uuid,
  uuid,
  uuid,
  text,
  uuid,
  integer,
  jsonb
) to service_role;

comment on function public.execute_storyops_post_service_action(
  uuid,
  uuid,
  uuid,
  text,
  uuid,
  integer,
  jsonb
) is
  'Trusted Edge-only post-service action boundary. It requires provider-backed paid invoices, completed jobs, current marketing consent, exact portal scope, optimistic invoice versions, and durable command receipts.';

create or replace function public.create_storyops_recurring_due_work(
  p_company_id uuid,
  p_command_id uuid,
  p_plan_id uuid,
  p_expected_plan_version integer,
  p_due_date date,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role text;
  company_timezone text;
  local_today date;
  plan_row public.recurring_maintenance_plans%rowtype;
  occurrence_row public.recurring_due_occurrences%rowtype;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  next_due_date_value date;
  cadence_months integer;
  elapsed_months integer;
  period_count integer;
  effective_request_hash text;
  response_value jsonb;
  already_existed_value boolean := false;
begin
  if actor_user_id is null then
    raise exception 'RECURRING_DUE_AUTHENTICATION_REQUIRED';
  end if;
  if p_company_id is null
    or p_command_id is null
    or p_plan_id is null
    or p_expected_plan_version is null
    or p_expected_plan_version < 1
    or p_due_date is null
    or p_request_hash is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'RECURRING_DUE_INVALID_REQUEST';
  end if;

  select membership.role::text, company.timezone
  into actor_role, company_timezone
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
   and company.status = 'active'
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active
    and membership.role in ('owner', 'dispatcher');
  if actor_role is null or not public.lock_storyops_active_company(p_company_id) then
    raise exception 'RECURRING_DUE_ACTIVE_STAFF_REQUIRED';
  end if;
  local_today := (now() at time zone company_timezone)::date;

  effective_request_hash := encode(
    extensions.digest(
      array_to_string(
        array[
          'storyops-recurring-due-work-v1',
          p_company_id::text,
          p_plan_id::text,
          p_expected_plan_version::text,
          p_due_date::text
        ],
        chr(31)
      ),
      'sha256'
    ),
    'hex'
  );
  if p_request_hash <> effective_request_hash then
    raise exception 'RECURRING_DUE_REQUEST_HASH_MISMATCH';
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
    'recurring-due-work-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '730 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys key_record
    where key_record.company_id = p_company_id
      and key_record.scope = 'recurring-due-work-v1'
      and key_record.key = p_command_id::text
    for update;
    if reservation.id is null then
      raise exception 'RECURRING_DUE_RESERVATION_LOST';
    end if;
    if reservation.request_hash <> effective_request_hash then
      raise exception 'RECURRING_DUE_IDEMPOTENCY_CONFLICT';
    end if;
    if reservation.status = 'completed' and reservation.response is not null then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'RECURRING_DUE_COMMAND_IN_PROGRESS';
  end if;

  select *
  into plan_row
  from public.recurring_maintenance_plans plan
  where plan.id = p_plan_id
    and plan.company_id = p_company_id
  for update;
  if plan_row.id is null then
    raise exception 'RECURRING_DUE_PLAN_NOT_FOUND';
  end if;

  select *
  into occurrence_row
  from public.recurring_due_occurrences occurrence
  where occurrence.company_id = p_company_id
    and occurrence.recurring_plan_id = p_plan_id
    and occurrence.plan_due_date = p_due_date;

  if occurrence_row.id is not null then
    if occurrence_row.source_plan_version <> p_expected_plan_version
      or occurrence_row.customer_id <> plan_row.customer_id
      or occurrence_row.property_id <> plan_row.property_id
      or occurrence_row.service_codes <> plan_row.service_codes
      or occurrence_row.status not in ('fresh_estimate_required', 'estimate_created')
    then
      raise exception 'RECURRING_DUE_EXISTING_OCCURRENCE_MISMATCH';
    end if;
    already_existed_value := true;
  else
    if plan_row.status <> 'active'
      or not plan_row.requires_fresh_estimate
      or plan_row.version <> p_expected_plan_version
      or plan_row.next_due_date <> p_due_date
      or p_due_date > local_today
      or cardinality(plan_row.service_codes) = 0
    then
      raise exception 'RECURRING_DUE_PLAN_NOT_ELIGIBLE';
    end if;

    cadence_months := case plan_row.cadence
      when 'weekly' then null
      when 'biweekly' then null
      when 'every_four_weeks' then null
      when 'monthly' then 1
      when 'quarterly' then 3
      when 'semiannual' then 6
      when 'annual' then 12
      else null
    end;
    if plan_row.cadence = 'custom' then
      period_count := ((local_today - p_due_date) / plan_row.interval_days) + 1;
      next_due_date_value := p_due_date + (period_count * plan_row.interval_days);
    elsif cadence_months is not null then
      elapsed_months :=
        (extract(year from age(local_today, p_due_date))::integer * 12)
        + extract(month from age(local_today, p_due_date))::integer;
      period_count := greatest(1, elapsed_months / cadence_months);
      next_due_date_value := (
        p_due_date + make_interval(months => period_count * cadence_months)
      )::date;
      if next_due_date_value <= local_today then
        period_count := period_count + 1;
        next_due_date_value := (
          p_due_date + make_interval(months => period_count * cadence_months)
        )::date;
      end if;
    elsif plan_row.cadence = 'weekly' then
      period_count := ((local_today - p_due_date) / 7) + 1;
      next_due_date_value := p_due_date + (period_count * 7);
    elsif plan_row.cadence = 'biweekly' then
      period_count := ((local_today - p_due_date) / 14) + 1;
      next_due_date_value := p_due_date + (period_count * 14);
    elsif plan_row.cadence = 'every_four_weeks' then
      period_count := ((local_today - p_due_date) / 28) + 1;
      next_due_date_value := p_due_date + (period_count * 28);
    else
      next_due_date_value := null;
    end if;
    if next_due_date_value is null or next_due_date_value <= p_due_date then
      raise exception 'RECURRING_DUE_CADENCE_INVALID';
    end if;

    insert into public.recurring_due_occurrences(
      company_id,
      recurring_plan_id,
      plan_due_date,
      customer_id,
      property_id,
      service_codes,
      source_plan_version,
      created_by_user_id
    )
    values (
      p_company_id,
      plan_row.id,
      p_due_date,
      plan_row.customer_id,
      plan_row.property_id,
      plan_row.service_codes,
      plan_row.version,
      actor_user_id
    )
    returning * into occurrence_row;

    update public.recurring_maintenance_plans
    set next_due_date = next_due_date_value
    where id = plan_row.id
      and company_id = p_company_id
      and version = p_expected_plan_version;
    if not found then
      raise exception 'RECURRING_DUE_PLAN_CONFLICT';
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
      'recurring.due_work_created',
      'recurring_due_occurrence',
      occurrence_row.id,
      jsonb_build_object(
        'recurringPlanId', occurrence_row.recurring_plan_id,
        'planDueDate', occurrence_row.plan_due_date,
        'sourcePlanVersion', occurrence_row.source_plan_version,
        'status', occurrence_row.status,
        'freshEstimateRequired', true,
        'historicalPriceCopied', false,
        'estimateCreated', false,
        'quoteAccepted', false,
        'depositVerified', false,
        'schedulingEvidenceVerified', false,
        'visitCreated', false,
        'customerContacted', false,
        'bookingBoundary', 'job.book'
      ),
      p_command_id::text
    );
  end if;

  response_value := jsonb_build_object(
    'schemaVersion', 'storyops-recurring-due-work-receipt-v1',
    'companyId', p_company_id,
    'commandId', p_command_id,
    'requestHash', effective_request_hash,
    'workItemId', occurrence_row.id,
    'recurringPlanId', occurrence_row.recurring_plan_id,
    'sourcePlanVersion', occurrence_row.source_plan_version,
    'planDueDate', occurrence_row.plan_due_date,
    'status', 'fresh_estimate_required',
    'freshEstimateRequired', true,
    'historicalPriceCopied', false,
    'estimateCreated', false,
    'quoteAccepted', false,
    'depositVerified', false,
    'schedulingEvidenceVerified', false,
    'visitCreated', false,
    'customerContacted', false,
    'bookingBoundary', 'job.book',
    'alreadyExisted', already_existed_value,
    'replayed', false,
    'serverTime', now()
  );

  update public.idempotency_keys
  set
    status = 'completed',
    response = response_value,
    completed_at = now()
  where id = reservation_id
    and status = 'in_progress';
  if not found then
    raise exception 'RECURRING_DUE_RESERVATION_LOST';
  end if;
  return response_value;
end;
$$;

revoke all on function public.create_storyops_recurring_due_work(
  uuid, uuid, uuid, integer, date, text
) from public, anon, service_role;
grant execute on function public.create_storyops_recurring_due_work(
  uuid, uuid, uuid, integer, date, text
) to authenticated;

comment on function public.create_storyops_recurring_due_work(
  uuid, uuid, uuid, integer, date, text
) is
  'Creates one idempotent internal fresh-estimate task for an actually due active maintenance plan and advances only the plan due date; it never prices, quotes, contacts, schedules, books, or creates a visit.';
