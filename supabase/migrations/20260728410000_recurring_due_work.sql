-- Recurring maintenance due-work boundary.
--
-- A due occurrence is an internal fresh-estimate task only. Creating one never
-- copies a historical price, creates an estimate/quote/job/visit, reserves
-- capacity, contacts a customer, or claims payment/deposit state. The normal
-- deterministic estimate, policy, quote acceptance, deposit, live scheduling
-- evidence, and `job.book` boundaries remain authoritative.

create table public.recurring_due_occurrences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recurring_plan_id uuid not null
    references public.recurring_maintenance_plans(id) on delete restrict,
  plan_due_date date not null,
  customer_id uuid not null references public.customers(id) on delete restrict,
  property_id uuid not null references public.properties(id) on delete restrict,
  service_codes text[] not null,
  source_plan_version integer not null check (source_plan_version > 0),
  status text not null default 'fresh_estimate_required'
    check (status in ('fresh_estimate_required', 'estimate_created')),
  estimate_id uuid references public.estimates(id) on delete restrict,
  estimate_linked_by_user_id uuid references auth.users(id) on delete restrict,
  estimate_linked_at timestamptz,
  created_by_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (company_id, recurring_plan_id, plan_due_date),
  check (cardinality(service_codes) > 0),
  check (
    (
      status = 'fresh_estimate_required'
      and estimate_id is null
      and estimate_linked_by_user_id is null
      and estimate_linked_at is null
    )
    or (
      status = 'estimate_created'
      and estimate_id is not null
      and estimate_linked_by_user_id is not null
      and estimate_linked_at is not null
    )
  )
);

create index recurring_due_occurrences_staff_queue_idx
  on public.recurring_due_occurrences(company_id, plan_due_date, created_at);

create constraint trigger recurring_due_occurrences_plan_company
  after insert or update on public.recurring_due_occurrences
  deferrable initially immediate
  for each row execute function public.assert_same_company_reference(
    'recurring_plan_id',
    'recurring_maintenance_plans'
  );

create constraint trigger recurring_due_occurrences_customer_company
  after insert or update on public.recurring_due_occurrences
  deferrable initially immediate
  for each row execute function public.assert_same_company_reference(
    'customer_id',
    'customers'
  );

create constraint trigger recurring_due_occurrences_property_company
  after insert or update on public.recurring_due_occurrences
  deferrable initially immediate
  for each row execute function public.assert_same_company_reference(
    'property_id',
    'properties'
  );

create constraint trigger recurring_due_occurrences_estimate_company
  after insert or update on public.recurring_due_occurrences
  deferrable initially immediate
  for each row execute function public.assert_same_company_reference(
    'estimate_id',
    'estimates'
  );

create or replace function public.enforce_storyops_recurring_due_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.company_id <> old.company_id
    or new.recurring_plan_id <> old.recurring_plan_id
    or new.plan_due_date <> old.plan_due_date
    or new.customer_id <> old.customer_id
    or new.property_id <> old.property_id
    or new.service_codes <> old.service_codes
    or new.source_plan_version <> old.source_plan_version
    or new.created_by_user_id <> old.created_by_user_id
    or new.created_at <> old.created_at
    or old.status <> 'fresh_estimate_required'
    or new.status <> 'estimate_created'
    or old.estimate_id is not null
    or new.estimate_id is null
    or old.estimate_linked_by_user_id is not null
    or new.estimate_linked_by_user_id is null
    or old.estimate_linked_at is not null
    or new.estimate_linked_at is null
  then
    raise exception 'RECURRING_DUE_TRANSITION_INVALID';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_storyops_recurring_due_transition()
  from public, anon, authenticated, service_role;

create trigger recurring_due_occurrences_exact_transition
  before update on public.recurring_due_occurrences
  for each row execute function public.enforce_storyops_recurring_due_transition();

create trigger recurring_due_occurrences_touch
  before update on public.recurring_due_occurrences
  for each row execute function public.touch_record();

create trigger storyops_active_company_mutation_gate
  before insert or update or delete on public.recurring_due_occurrences
  for each row execute function public.assert_active_company_for_authenticated_mutation();

alter table public.recurring_due_occurrences enable row level security;
alter table public.recurring_due_occurrences force row level security;

revoke all on table public.recurring_due_occurrences
  from public, anon, authenticated, service_role;

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

create or replace function public.attach_storyops_recurring_due_estimate(
  p_company_id uuid,
  p_command_id uuid,
  p_work_item_id uuid,
  p_expected_work_item_version integer,
  p_estimate_id uuid,
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
  occurrence_row public.recurring_due_occurrences%rowtype;
  estimate_row public.estimates%rowtype;
  source_estimate_id_value uuid;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  effective_request_hash text;
  response_value jsonb;
  already_attached_value boolean := false;
begin
  if actor_user_id is null then
    raise exception 'RECURRING_DUE_AUTHENTICATION_REQUIRED';
  end if;
  if p_company_id is null
    or p_command_id is null
    or p_work_item_id is null
    or p_expected_work_item_version is null
    or p_expected_work_item_version < 1
    or p_estimate_id is null
    or p_request_hash is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'RECURRING_DUE_ESTIMATE_INVALID_REQUEST';
  end if;

  select membership.role::text
  into actor_role
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

  effective_request_hash := encode(
    extensions.digest(
      array_to_string(
        array[
          'storyops-recurring-due-estimate-v1',
          p_company_id::text,
          p_work_item_id::text,
          p_expected_work_item_version::text,
          p_estimate_id::text
        ],
        chr(31)
      ),
      'sha256'
    ),
    'hex'
  );
  if p_request_hash <> effective_request_hash then
    raise exception 'RECURRING_DUE_ESTIMATE_REQUEST_HASH_MISMATCH';
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
    'recurring-due-estimate-v1',
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
      and key_record.scope = 'recurring-due-estimate-v1'
      and key_record.key = p_command_id::text
    for update;
    if reservation.id is null then
      raise exception 'RECURRING_DUE_ESTIMATE_RESERVATION_LOST';
    end if;
    if reservation.request_hash <> effective_request_hash then
      raise exception 'RECURRING_DUE_ESTIMATE_IDEMPOTENCY_CONFLICT';
    end if;
    if reservation.status = 'completed' and reservation.response is not null then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'RECURRING_DUE_ESTIMATE_COMMAND_IN_PROGRESS';
  end if;

  select *
  into occurrence_row
  from public.recurring_due_occurrences occurrence
  where occurrence.id = p_work_item_id
    and occurrence.company_id = p_company_id
  for update;
  if occurrence_row.id is null then
    raise exception 'RECURRING_DUE_WORK_ITEM_NOT_FOUND';
  end if;
  if occurrence_row.status = 'estimate_created' then
    if occurrence_row.estimate_id <> p_estimate_id
      or occurrence_row.version <> p_expected_work_item_version + 1
    then
      raise exception 'RECURRING_DUE_ESTIMATE_ALREADY_ATTACHED';
    end if;
    already_attached_value := true;
  elsif occurrence_row.status <> 'fresh_estimate_required'
    or occurrence_row.version <> p_expected_work_item_version
  then
    raise exception 'RECURRING_DUE_WORK_ITEM_VERSION_CONFLICT';
  end if;

  select plan.source_estimate_id
  into source_estimate_id_value
  from public.recurring_maintenance_plans plan
  where plan.id = occurrence_row.recurring_plan_id
    and plan.company_id = p_company_id;

  select *
  into estimate_row
  from public.estimates estimate
  where estimate.id = p_estimate_id
    and estimate.company_id = p_company_id
    and estimate.customer_id = occurrence_row.customer_id
    and estimate.property_id = occurrence_row.property_id;
  if estimate_row.id is null
    or estimate_row.id = source_estimate_id_value
    or estimate_row.created_at < occurrence_row.created_at
    or estimate_row.calculated_at < occurrence_row.created_at
    or estimate_row.status not in ('approved', 'pending_approval')
    or nullif(btrim(estimate_row.calculation_version), '') is null
    or jsonb_typeof(estimate_row.calculation_input) <> 'object'
    or not exists (
      select 1
      from public.estimate_lines line
      where line.company_id = p_company_id
        and line.estimate_id = estimate_row.id
    )
    or not exists (
      select 1
      from public.quotes quote
      where quote.company_id = p_company_id
        and quote.estimate_id = estimate_row.id
        and quote.customer_id = occurrence_row.customer_id
        and quote.property_id = occurrence_row.property_id
        and quote.status in ('draft', 'pending_approval')
        and quote.accepted_at is null
    )
  then
    raise exception 'RECURRING_DUE_FRESH_ESTIMATE_REQUIRED';
  end if;

  if not already_attached_value then
    update public.recurring_due_occurrences
    set
      status = 'estimate_created',
      estimate_id = estimate_row.id,
      estimate_linked_by_user_id = actor_user_id,
      estimate_linked_at = now()
    where id = occurrence_row.id
      and company_id = p_company_id
      and version = p_expected_work_item_version
    returning * into occurrence_row;
    if occurrence_row.id is null then
      raise exception 'RECURRING_DUE_WORK_ITEM_VERSION_CONFLICT';
    end if;

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
      'recurring.due_estimate_attached',
      'recurring_due_occurrence',
      occurrence_row.id,
      jsonb_build_object(
        'status', 'fresh_estimate_required',
        'estimateCreated', false
      ),
      jsonb_build_object(
        'status', occurrence_row.status,
        'estimateId', occurrence_row.estimate_id,
        'estimateCreated', true,
        'historicalPriceCopied', false,
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
    'schemaVersion', 'storyops-recurring-due-estimate-receipt-v1',
    'companyId', p_company_id,
    'commandId', p_command_id,
    'requestHash', effective_request_hash,
    'workItemId', occurrence_row.id,
    'workItemVersion', occurrence_row.version,
    'estimateId', estimate_row.id,
    'status', occurrence_row.status,
    'estimateCreated', true,
    'historicalPriceCopied', false,
    'quoteAccepted', false,
    'depositVerified', false,
    'schedulingEvidenceVerified', false,
    'visitCreated', false,
    'customerContacted', false,
    'bookingBoundary', 'job.book',
    'alreadyAttached', already_attached_value,
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
    raise exception 'RECURRING_DUE_ESTIMATE_RESERVATION_LOST';
  end if;
  return response_value;
end;
$$;

revoke all on function public.attach_storyops_recurring_due_estimate(
  uuid, uuid, uuid, integer, uuid, text
) from public, anon, service_role;
grant execute on function public.attach_storyops_recurring_due_estimate(
  uuid, uuid, uuid, integer, uuid, text
) to authenticated;

comment on function public.attach_storyops_recurring_due_estimate(
  uuid, uuid, uuid, integer, uuid, text
) is
  'Associates one newly persisted same-customer/property deterministic estimate with recurring due work. It does not assert approval, quote acceptance, deposit, scheduling evidence, booking, visit creation, or customer contact.';

create or replace function public.get_storyops_recurring_due_work(
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
  actor_role text;
  company_timezone text;
  local_today date;
begin
  if actor_user_id is null then
    raise exception 'RECURRING_DUE_AUTHENTICATION_REQUIRED';
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

  if actor_role is null and exists (
    select 1
    from public.customer_portal_users portal
    join public.company_memberships membership
      on membership.company_id = portal.company_id
     and membership.user_id = portal.user_id
     and membership.role = 'customer'
     and membership.active
    join public.companies company
      on company.id = portal.company_id
     and company.status = 'active'
    where portal.company_id = p_company_id
      and portal.user_id = actor_user_id
  ) then
    actor_role := 'customer';
    select company.timezone
    into company_timezone
    from public.companies company
    where company.id = p_company_id;
  end if;
  if actor_role is null then
    raise exception 'RECURRING_DUE_ACTIVE_ROLE_REQUIRED';
  end if;
  local_today := (now() at time zone company_timezone)::date;

  return jsonb_build_object(
    'schemaVersion', 'storyops-recurring-due-work-state-v1',
    'companyId', p_company_id,
    'role', actor_role,
    'localDate', local_today,
    'plans', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'planId', plan.id,
          'planVersion', plan.version,
          'customerId', plan.customer_id,
          'customerName', customer.display_name,
          'propertyId', plan.property_id,
          'propertyName', property.name,
          'cadence', plan.cadence,
          'nextDueDate', plan.next_due_date,
          'serviceCodes', plan.service_codes,
          'requiresFreshEstimate', true,
          'dueNow', plan.next_due_date <= local_today,
          'generationAction', case
            when actor_role in ('owner', 'dispatcher')
              and plan.next_due_date <= local_today
              then 'create_fresh_estimate_work_item'
            else 'not_available'
          end
        )
        order by plan.next_due_date, plan.id
      )
      from public.recurring_maintenance_plans plan
      join public.customers customer
        on customer.id = plan.customer_id
       and customer.company_id = p_company_id
      join public.properties property
        on property.id = plan.property_id
       and property.company_id = p_company_id
      where plan.company_id = p_company_id
        and plan.status = 'active'
        and plan.requires_fresh_estimate
        and (
          actor_role in ('owner', 'dispatcher')
          or exists (
            select 1
            from public.customer_portal_users portal
            where portal.company_id = p_company_id
              and portal.user_id = actor_user_id
              and portal.customer_id = plan.customer_id
          )
        )
    ), '[]'::jsonb),
    'workItems', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', occurrence.id,
          'recurringPlanId', occurrence.recurring_plan_id,
          'planDueDate', occurrence.plan_due_date,
          'customerId', occurrence.customer_id,
          'customerName', customer.display_name,
          'propertyId', occurrence.property_id,
          'propertyName', property.name,
          'serviceCodes', occurrence.service_codes,
          'sourcePlanVersion', occurrence.source_plan_version,
          'status', occurrence.status,
          'estimateId', occurrence.estimate_id,
          'estimateLinkedAt', occurrence.estimate_linked_at,
          'createdAt', occurrence.created_at,
          'version', occurrence.version,
          'freshEstimateRequired', true,
          'historicalPriceCopied', false,
          'estimateCreated', occurrence.status = 'estimate_created',
          'quoteAccepted', false,
          'depositVerified', false,
          'schedulingEvidenceVerified', false,
          'visitCreated', false,
          'customerContacted', false,
          'bookingBoundary', 'job.book',
          'nextAction', case
            when occurrence.status = 'estimate_created'
              and actor_role in ('owner', 'dispatcher')
              then 'Review policy disposition and publish the new quote through the normal workflow.'
            when occurrence.status = 'estimate_created'
              then 'The office prepared a new estimate; a new quote still must be published and accepted before booking.'
            when actor_role in ('owner', 'dispatcher')
              then 'Capture current measurements and create a new deterministic estimate.'
            else 'The office must prepare and send a new quote before any service can be booked.'
          end
        )
        order by occurrence.plan_due_date desc, occurrence.created_at desc
      )
      from public.recurring_due_occurrences occurrence
      join public.customers customer
        on customer.id = occurrence.customer_id
       and customer.company_id = p_company_id
      join public.properties property
        on property.id = occurrence.property_id
       and property.company_id = p_company_id
      where occurrence.company_id = p_company_id
        and (
          actor_role in ('owner', 'dispatcher')
          or exists (
            select 1
            from public.customer_portal_users portal
            where portal.company_id = p_company_id
              and portal.user_id = actor_user_id
              and portal.customer_id = occurrence.customer_id
          )
        )
    ), '[]'::jsonb),
    'guardrails', jsonb_build_object(
      'historicalPriceCopied', false,
      'estimateCreated', false,
      'quoteAccepted', false,
      'depositVerified', false,
      'availabilityVerified', false,
      'visitCreated', false,
      'customerContacted', false,
      'requiredSequence', jsonb_build_array(
        'fresh_deterministic_estimate',
        'policy_approval_if_required',
        'quote_acceptance',
        'deposit_verification_if_required',
        'live_scheduling_evidence',
        'job.book'
      )
    ),
    'serverTime', now()
  );
end;
$$;

revoke all on function public.get_storyops_recurring_due_work(uuid)
  from public, anon, service_role;
grant execute on function public.get_storyops_recurring_due_work(uuid)
  to authenticated;

comment on function public.get_storyops_recurring_due_work(uuid) is
  'Role-scoped recurring due-work projection. Customer rows are limited to the authenticated portal mapping and never imply a quote, price, booking, visit, availability, payment, or customer contact.';
