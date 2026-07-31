-- Provider-backed post-service lifecycle.
-- Authenticated callers reach this model only through finite SECURITY DEFINER
-- RPCs. Review/referral records are queued work, never delivery receipts.

alter table public.recurring_maintenance_plans
  add column source_job_id uuid references public.jobs(id) on delete restrict,
  add column source_invoice_id uuid references public.invoices(id) on delete restrict,
  add column source_estimate_id uuid references public.estimates(id) on delete restrict,
  add column activated_by_user_id uuid references auth.users(id) on delete restrict,
  add column activated_at timestamptz,
  add constraint recurring_active_source_required check (
    status <> 'active'
    or (
      source_job_id is not null
      and source_invoice_id is not null
      and source_estimate_id is not null
      and activated_by_user_id is not null
      and activated_at is not null
      and requires_fresh_estimate
      and cardinality(service_codes) > 0
    )
  );

create unique index recurring_plans_one_active_per_source_job_idx
  on public.recurring_maintenance_plans(company_id, source_job_id)
  where status = 'active' and source_job_id is not null;

alter table public.referrals
  add column source_invoice_id uuid references public.invoices(id) on delete restrict,
  add column source_job_id uuid references public.jobs(id) on delete restrict,
  add column invited_by_user_id uuid references auth.users(id) on delete restrict,
  add column invited_at timestamptz,
  add constraint referrals_invited_source_required check (
    status <> 'invited'
    or (
      source_invoice_id is not null
      and source_job_id is not null
      and invited_by_user_id is not null
      and invited_at is not null
    )
  );

create unique index referrals_one_invite_per_source_invoice_idx
  on public.referrals(company_id, source_invoice_id)
  where source_invoice_id is not null;

create table public.post_service_followups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  job_id uuid not null references public.jobs(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  property_id uuid not null references public.properties(id) on delete restrict,
  action_type text not null
    check (action_type in ('review_request', 'referral_invite')),
  channel text not null check (channel in ('sms', 'email')),
  consent_record_id uuid not null
    references public.consent_records(id) on delete restrict,
  referral_id uuid references public.referrals(id) on delete restrict,
  status text not null default 'queued'
    check (status in ('queued', 'completed', 'failed', 'cancelled')),
  scheduled_at timestamptz not null,
  completed_at timestamptz,
  last_error_code text,
  created_by_user_id uuid not null references auth.users(id) on delete restrict,
  retention_class text not null default 'communication'
    check (retention_class = 'communication'),
  retain_until timestamptz not null,
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (company_id, invoice_id, action_type),
  check (
    (action_type = 'referral_invite' and referral_id is not null)
    or (action_type = 'review_request' and referral_id is null)
  ),
  check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  )
);

create index post_service_followups_queue_idx
  on public.post_service_followups(company_id, scheduled_at)
  where status = 'queued';

create or replace function public.set_post_service_followup_retention()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  retention_days integer;
begin
  select nullif(policy.class_rules #>> '{communication,days}', '')::integer
  into retention_days
  from public.retention_policies policy
  where policy.company_id = new.company_id
    and policy.status = 'active'
    and policy.effective_from <= now()
  order by policy.effective_from desc
  limit 1;
  retention_days := greatest(30, least(3650, coalesce(retention_days, 730)));
  new.retention_class := 'communication';
  new.retain_until := coalesce(
    new.retain_until,
    now() + make_interval(days => retention_days)
  );
  new.legal_hold := coalesce(new.legal_hold, false);
  return new;
end;
$$;

create trigger post_service_followups_retention
  before insert on public.post_service_followups
  for each row execute function public.set_post_service_followup_retention();

create trigger post_service_followups_touch
  before update on public.post_service_followups
  for each row execute function public.touch_record();

create trigger post_service_followups_exact_delete_approval
  before delete on public.post_service_followups
  for each row execute function public.require_exact_delete_approval();

alter table public.post_service_followups enable row level security;
alter table public.post_service_followups force row level security;

-- The dedicated read RPC below is the only authenticated projection. This
-- avoids accidentally exposing consent evidence or future delivery metadata.
revoke all on table public.post_service_followups
  from public, anon, authenticated, service_role;
revoke select on table
  public.invoices,
  public.jobs,
  public.visits,
  public.quotes,
  public.estimates,
  public.price_books,
  public.consent_records,
  public.customers,
  public.properties,
  public.recurring_maintenance_plans,
  public.webhook_events,
  public.payments
from service_role;

drop policy if exists recurring_plans_backoffice_write
  on public.recurring_maintenance_plans;

-- Preserve the original, reviewed purge implementation as a private core and
-- wrap it so the new communication-class records participate in the same
-- dry-run inventory, approved purge, evidence hash, and retention run.
alter function public.apply_retention_policy(
  uuid,
  timestamptz,
  boolean,
  uuid
) rename to apply_retention_policy_core;

revoke all on function public.apply_retention_policy_core(
  uuid,
  timestamptz,
  boolean,
  uuid
) from public, anon, authenticated, service_role;

create or replace function public.apply_retention_policy(
  p_company_id uuid,
  p_cutoff_at timestamptz,
  p_dry_run boolean default true,
  p_approval_request_id uuid default null
)
returns table(
  run_id uuid,
  candidate_counts jsonb,
  affected_counts jsonb,
  evidence_sha256 text
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  core_result record;
  policy_id_value uuid;
  post_service_candidates bigint;
  post_service_affected bigint := 0;
  candidates_value jsonb;
  affected_value jsonb;
  evidence_value text;
begin
  select count(*)
  into post_service_candidates
  from public.post_service_followups followup
  where followup.company_id = p_company_id
    and followup.retain_until <= p_cutoff_at
    and not followup.legal_hold;

  select *
  into core_result
  from public.apply_retention_policy_core(
    p_company_id,
    p_cutoff_at,
    p_dry_run,
    p_approval_request_id
  );

  if not p_dry_run then
    perform set_config('storyops.retention_purge', 'on', true);
    delete from public.post_service_followups followup
    where followup.company_id = p_company_id
      and followup.retain_until <= p_cutoff_at
      and not followup.legal_hold;
    get diagnostics post_service_affected = row_count;
  end if;

  candidates_value := core_result.candidate_counts
    || jsonb_build_object('postServiceFollowups', post_service_candidates);
  affected_value := case
    when p_dry_run then '{}'::jsonb
    else core_result.affected_counts
      || jsonb_build_object('postServiceFollowups', post_service_affected)
  end;

  select run.retention_policy_id
  into policy_id_value
  from public.retention_runs run
  where run.id = core_result.run_id
    and run.company_id = p_company_id;
  if policy_id_value is null then
    raise exception 'POST_SERVICE_RETENTION_RUN_REQUIRED';
  end if;

  evidence_value := encode(
    extensions.digest(
      jsonb_build_object(
        'companyId', p_company_id,
        'cutoffAt', p_cutoff_at,
        'policyId', policy_id_value,
        'approvalId', p_approval_request_id,
        'dryRun', p_dry_run,
        'coreEvidenceSha256', core_result.evidence_sha256,
        'candidates', candidates_value,
        'affected', affected_value
      )::text,
      'sha256'
    ),
    'hex'
  );

  update public.retention_runs
  set
    candidate_counts = candidates_value,
    affected_counts = affected_value,
    evidence_sha256 = evidence_value
  where id = core_result.run_id
    and company_id = p_company_id;
  if not found then
    raise exception 'POST_SERVICE_RETENTION_RUN_REQUIRED';
  end if;

  if not p_dry_run and p_approval_request_id is not null then
    perform private.authorize_storyops_approval_consumption(
      p_company_id,
      p_approval_request_id
    );
    update public.approval_requests
    set execution_receipt = jsonb_build_object(
      'runId', core_result.run_id,
      'status', 'succeeded',
      'evidenceSha256', evidence_value,
      'affected', affected_value
    )
    where id = p_approval_request_id
      and company_id = p_company_id
      and consumed_at is not null;

    insert into public.audit_events(
      company_id,
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      after_data,
      retain_until
    )
    values (
      p_company_id,
      case when auth.uid() is null then 'system' else 'user' end,
      coalesce(auth.uid()::text, current_user),
      'retention.post_service_purge',
      'retention_run',
      core_result.run_id,
      jsonb_build_object(
        'policyId', policy_id_value,
        'approvalId', p_approval_request_id,
        'cutoffAt', p_cutoff_at,
        'postServiceFollowups', post_service_affected,
        'evidenceSha256', evidence_value
      ),
      now() + interval '7 years'
    );
  end if;

  return query
  select
    core_result.run_id,
    candidates_value,
    affected_value,
    evidence_value;
end;
$$;

revoke all on function public.apply_retention_policy(
  uuid,
  timestamptz,
  boolean,
  uuid
) from public, anon, authenticated;
grant execute on function public.apply_retention_policy(
  uuid,
  timestamptz,
  boolean,
  uuid
) to service_role;

create or replace function public.storyops_invoice_has_provider_proof(
  p_invoice_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.invoices invoice
    join public.jobs job
      on job.id = invoice.job_id
      and job.company_id = invoice.company_id
    where invoice.id = p_invoice_id
      and invoice.status = 'paid'
      and invoice.total > 0
      and invoice.amount_paid = invoice.total
      and invoice.balance_due = 0
      and invoice.paid_at is not null
      and (
        (
          invoice.provider_invoice_id is not null
          and exists (
            select 1
            from public.webhook_events event
            where event.company_id = invoice.company_id
              and event.provider = 'stripe'
              and event.status = 'processed'
              and event.payload ->> 'action' = 'invoice_paid'
              and event.payload ->> 'objectId' = invoice.provider_invoice_id
              and event.payload ->> 'jobId' = job.id::text
              and event.payload ->> 'amountCents' ~ '^[0-9]+$'
              and event.payload ->> 'amountPaidCents' ~ '^[0-9]+$'
              and event.payload ->> 'amountRemainingCents' ~ '^[0-9]+$'
              and (event.payload ->> 'amountCents')::bigint
                = round(invoice.total * 100)::bigint
              and (event.payload ->> 'amountPaidCents')::bigint
                = round(invoice.total * 100)::bigint
              and (event.payload ->> 'amountRemainingCents')::bigint = 0
          )
        )
        or (
          select coalesce(sum(payment.amount), 0)
          from public.payments payment
          where payment.company_id = invoice.company_id
            and payment.invoice_id = invoice.id
            and payment.provider = 'stripe'
            and payment.payment_type in ('deposit', 'invoice')
            and payment.status = 'succeeded'
            and payment.processed_at is not null
            and payment.provider_payment_id is not null
            and exists (
              select 1
              from public.webhook_events event
              where event.company_id = invoice.company_id
                and event.provider = 'stripe'
                and event.status = 'processed'
                and event.payload ->> 'action' = 'payment_succeeded'
                and event.payload ->> 'quoteId' = job.quote_id::text
                and event.payload ->> 'amountCents' ~ '^[0-9]+$'
                and (event.payload ->> 'amountCents')::bigint
                  = round(payment.amount * 100)::bigint
                and (
                  event.payload ->> 'objectId' = payment.provider_payment_id
                  or event.payload ->> 'paymentIntentId'
                    = payment.provider_payment_id
                )
            )
        ) >= invoice.total
      )
  );
$$;

revoke all on function public.storyops_invoice_has_provider_proof(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.enforce_storyops_recurring_source()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job_row public.jobs%rowtype;
  invoice_row public.invoices%rowtype;
  quote_row public.quotes%rowtype;
  estimate_row public.estimates%rowtype;
begin
  if new.status <> 'active' then
    return new;
  end if;

  select *
  into job_row
  from public.jobs
  where id = new.source_job_id
    and company_id = new.company_id;
  select *
  into invoice_row
  from public.invoices
  where id = new.source_invoice_id
    and company_id = new.company_id
    and job_id = new.source_job_id;
  select *
  into quote_row
  from public.quotes
  where id = job_row.quote_id
    and company_id = new.company_id;
  select *
  into estimate_row
  from public.estimates
  where id = new.source_estimate_id
    and id = quote_row.estimate_id
    and company_id = new.company_id;

  if job_row.id is null
    or invoice_row.id is null
    or quote_row.id is null
    or estimate_row.id is null
    or job_row.customer_id <> new.customer_id
    or job_row.property_id <> new.property_id
    or invoice_row.customer_id <> new.customer_id
    or quote_row.customer_id <> new.customer_id
    or quote_row.property_id <> new.property_id
    or estimate_row.customer_id <> new.customer_id
    or estimate_row.property_id <> new.property_id
    or estimate_row.price_book_id <> new.price_book_id
    or job_row.service_codes <> new.service_codes
    or not new.requires_fresh_estimate
    or not public.storyops_invoice_has_provider_proof(invoice_row.id)
  then
    raise exception 'POST_SERVICE_MAINTENANCE_SOURCE_INVALID';
  end if;

  perform public.assert_storyops_accepted_pricing(
    new.company_id,
    quote_row.id
  );
  return new;
end;
$$;

create trigger recurring_plans_authoritative_source
  before insert or update on public.recurring_maintenance_plans
  for each row execute function public.enforce_storyops_recurring_source();

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
            else 'referral.invite'
          end,
          'domainRecordId', coalesce(followup.referral_id, followup.id),
          'channel', followup.channel,
          'status', followup.status,
          'scheduledAt', followup.scheduled_at,
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
  from public, anon;
grant execute on function public.get_storyops_post_service_status(uuid)
  to authenticated;

comment on function public.get_storyops_post_service_status(uuid) is
  'Role-scoped post-service status projection without consent proof, contact data, or provider-delivery claims.';
