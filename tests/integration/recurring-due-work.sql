\set ON_ERROR_STOP on

begin;

-- Build one rolled-back, source-valid active maintenance plan. The existing
-- authoritative source trigger still verifies completed work, accepted
-- deterministic pricing, and provider-confirmed payment.
update public.visits
set status = 'completed'
where id = '10000000-0000-4000-8000-000000000641';

update public.jobs
set status = 'invoiced'
where id = '10000000-0000-4000-8000-000000000631';

update public.invoices
set
  status = 'paid',
  provider_invoice_id = 'in_recurring_due_fixture',
  amount_paid = total,
  balance_due = 0,
  paid_at = now()
where id = '10000000-0000-4000-8000-000000000651';

with fixture(receipt) as (
  values (jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'stripe',
    'eventId', 'evt_recurring_due_paid',
    'eventType', 'invoice.paid',
    'objectId', 'in_recurring_due_fixture',
    'objectKind', 'invoice',
    'action', 'invoice_paid',
    'companyId', '10000000-0000-4000-8000-000000000001',
    'occurredAt', now()::text,
    'jobId', '10000000-0000-4000-8000-000000000631',
    'amountCents', 52800,
    'amountPaidCents', 52800,
    'amountRemainingCents', 0,
    'currency', 'usd'
  ))
)
insert into public.webhook_events(
  company_id,
  provider,
  provider_event_id,
  event_type,
  payload_hash,
  status,
  payload,
  processed_at
)
select
  '10000000-0000-4000-8000-000000000001',
  'stripe',
  'evt_recurring_due_paid',
  'invoice.paid',
  encode(extensions.digest(receipt::text, 'sha256'), 'hex'),
  'processed',
  receipt,
  now()
from fixture;

insert into public.recurring_maintenance_plans(
  id,
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
  '41000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000211',
  array['pressure-wash-flatwork', 'gutter-cleaning'],
  'semiannual',
  null,
  (
    (
      now() at time zone (
        select company.timezone
        from public.companies company
        where company.id = '10000000-0000-4000-8000-000000000001'
      )
    )::date - interval '2 years'
  )::date,
  'active',
  '10000000-0000-4000-8000-000000000401',
  true,
  '10000000-0000-4000-8000-000000000631',
  '10000000-0000-4000-8000-000000000651',
  '10000000-0000-4000-8000-000000000501',
  '10000000-0000-4000-8000-000000000101',
  now()
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

\echo '1/9 owner creates one exact due work item without downstream truth claims'
do $$
declare
  due_date_value date;
  plan_version_value integer;
  request_hash_value text;
  receipt jsonb;
  replay jsonb;
  projection jsonb;
  local_today date;
begin
  projection := public.get_storyops_recurring_due_work(
    '10000000-0000-4000-8000-000000000001'
  );
  local_today := (projection ->> 'localDate')::date;
  due_date_value := (projection #>> '{plans,0,nextDueDate}')::date;
  plan_version_value := (projection #>> '{plans,0,planVersion}')::integer;

  request_hash_value := encode(
    extensions.digest(
      array_to_string(
        array[
          'storyops-recurring-due-work-v1',
          '10000000-0000-4000-8000-000000000001',
          '41000000-0000-4000-8000-000000000001',
          plan_version_value::text,
          due_date_value::text
        ],
        chr(31)
      ),
      'sha256'
    ),
    'hex'
  );

  receipt := public.create_storyops_recurring_due_work(
    '10000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000101',
    '41000000-0000-4000-8000-000000000001',
    plan_version_value,
    due_date_value,
    request_hash_value
  );
  replay := public.create_storyops_recurring_due_work(
    '10000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000101',
    '41000000-0000-4000-8000-000000000001',
    plan_version_value,
    due_date_value,
    request_hash_value
  );
  projection := public.get_storyops_recurring_due_work(
    '10000000-0000-4000-8000-000000000001'
  );

  if receipt ->> 'schemaVersion' <> 'storyops-recurring-due-work-receipt-v1'
    or receipt ->> 'status' <> 'fresh_estimate_required'
    or receipt ->> 'freshEstimateRequired' <> 'true'
    or receipt ->> 'historicalPriceCopied' <> 'false'
    or receipt ->> 'estimateCreated' <> 'false'
    or receipt ->> 'quoteAccepted' <> 'false'
    or receipt ->> 'depositVerified' <> 'false'
    or receipt ->> 'schedulingEvidenceVerified' <> 'false'
    or receipt ->> 'visitCreated' <> 'false'
    or receipt ->> 'customerContacted' <> 'false'
    or receipt ->> 'bookingBoundary' <> 'job.book'
    or replay ->> 'replayed' <> 'true'
    or jsonb_array_length(projection -> 'workItems') <> 1
    or projection #>> '{workItems,0,recurringPlanId}'
      <> '41000000-0000-4000-8000-000000000001'
    or (projection #>> '{workItems,0,planDueDate}')::date <> due_date_value
  then
    raise exception 'Recurring due-work receipt fabricated downstream truth: %, %',
      receipt, replay;
  end if;

  if (projection #>> '{plans,0,nextDueDate}')::date <= local_today
    or (projection #>> '{plans,0,nextDueDate}')::date
      <> (due_date_value + interval '30 months')::date
  then
    raise exception 'Overdue recurring plan did not advance to the first future cadence';
  end if;
end;
$$;

\echo '2/9 only a newly persisted same-scope deterministic estimate can close the estimate task'
reset role;
insert into public.estimates(
  id,
  company_id,
  estimate_number,
  customer_id,
  property_id,
  price_book_id,
  price_book_version,
  status,
  service_subtotal,
  minimum_adjustment,
  travel_fee,
  manual_adjustment,
  discount,
  taxable_subtotal,
  tax,
  total,
  deposit_required,
  estimated_cost,
  estimated_margin_pct,
  duration_minutes,
  calculation_version,
  calculation_input,
  calculation_issues,
  evidence_analysis_ids,
  calculated_at
)
select
  '41000000-0000-4000-8000-000000000501',
  source.company_id,
  'EST-RECURRING-DUE-1',
  source.customer_id,
  source.property_id,
  source.price_book_id,
  source.price_book_version,
  'approved',
  source.service_subtotal,
  source.minimum_adjustment,
  source.travel_fee,
  source.manual_adjustment,
  source.discount,
  source.taxable_subtotal,
  source.tax,
  source.total,
  source.deposit_required,
  source.estimated_cost,
  source.estimated_margin_pct,
  source.duration_minutes,
  source.calculation_version,
  source.calculation_input,
  source.calculation_issues,
  source.evidence_analysis_ids,
  now()
from public.estimates source
where source.id = '10000000-0000-4000-8000-000000000501';

insert into public.estimate_lines(
  id,
  company_id,
  estimate_id,
  line_kind,
  service_code,
  add_on_code,
  description,
  quantity,
  unit,
  unit_price,
  multiplier,
  subtotal,
  taxable,
  estimated_cost,
  source_measurement_ids,
  sort_order
)
select
  gen_random_uuid(),
  line.company_id,
  '41000000-0000-4000-8000-000000000501',
  line.line_kind,
  line.service_code,
  line.add_on_code,
  line.description,
  line.quantity,
  line.unit,
  line.unit_price,
  line.multiplier,
  line.subtotal,
  line.taxable,
  line.estimated_cost,
  line.source_measurement_ids,
  line.sort_order
from public.estimate_lines line
where line.estimate_id = '10000000-0000-4000-8000-000000000501';

insert into public.quotes(
  id,
  company_id,
  quote_number,
  estimate_id,
  customer_id,
  property_id,
  status,
  valid_until,
  terms_version,
  terms_snapshot,
  total,
  deposit_required
)
select
  '41000000-0000-4000-8000-000000000521',
  quote.company_id,
  'Q-RECURRING-DUE-1',
  '41000000-0000-4000-8000-000000000501',
  quote.customer_id,
  quote.property_id,
  'draft',
  current_date + 14,
  quote.terms_version,
  quote.terms_snapshot,
  quote.total,
  quote.deposit_required
from public.quotes quote
where quote.id = '10000000-0000-4000-8000-000000000521';

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
do $$
declare
  company_id_value uuid := '10000000-0000-4000-8000-000000000001';
  work_item_id uuid;
  work_item_version integer;
  projection jsonb;
  request_hash_value text;
  source_hash_value text;
  receipt jsonb;
  replay jsonb;
  source_blocked boolean := false;
begin
  projection := public.get_storyops_recurring_due_work(company_id_value);
  work_item_id := (projection #>> '{workItems,0,id}')::uuid;
  work_item_version := (projection #>> '{workItems,0,version}')::integer;
  source_hash_value := encode(
    extensions.digest(
      array_to_string(
        array[
          'storyops-recurring-due-estimate-v1',
          company_id_value::text,
          work_item_id::text,
          work_item_version::text,
          '10000000-0000-4000-8000-000000000501'
        ],
        chr(31)
      ),
      'sha256'
    ),
    'hex'
  );
  begin
    perform public.attach_storyops_recurring_due_estimate(
      company_id_value,
      '41000000-0000-4000-8000-000000000201',
      work_item_id,
      work_item_version,
      '10000000-0000-4000-8000-000000000501',
      source_hash_value
    );
  exception when others then
    source_blocked := sqlerrm = 'RECURRING_DUE_FRESH_ESTIMATE_REQUIRED';
  end;
  request_hash_value := encode(
    extensions.digest(
      array_to_string(
        array[
          'storyops-recurring-due-estimate-v1',
          company_id_value::text,
          work_item_id::text,
          work_item_version::text,
          '41000000-0000-4000-8000-000000000501'
        ],
        chr(31)
      ),
      'sha256'
    ),
    'hex'
  );
  receipt := public.attach_storyops_recurring_due_estimate(
    company_id_value,
    '41000000-0000-4000-8000-000000000202',
    work_item_id,
    work_item_version,
    '41000000-0000-4000-8000-000000000501',
    request_hash_value
  );
  replay := public.attach_storyops_recurring_due_estimate(
    company_id_value,
    '41000000-0000-4000-8000-000000000202',
    work_item_id,
    work_item_version,
    '41000000-0000-4000-8000-000000000501',
    request_hash_value
  );
  if not source_blocked
    or receipt ->> 'status' <> 'estimate_created'
    or receipt ->> 'estimateCreated' <> 'true'
    or receipt ->> 'quoteAccepted' <> 'false'
    or receipt ->> 'visitCreated' <> 'false'
    or receipt ->> 'customerContacted' <> 'false'
    or replay ->> 'replayed' <> 'true'
  then
    raise exception 'Recurring fresh-estimate association is invalid: %, %',
      receipt, replay;
  end if;
end;
$$;

\echo '3/9 dispatcher reconciles a duplicate command without a second item or due-date advance'
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000102', true);
do $$
declare
  plan_id_value uuid;
  source_plan_version_value integer;
  plan_due_date_value date;
  work_item_id uuid;
  advanced_due_date date;
  projection jsonb;
  request_hash_value text;
  receipt jsonb;
begin
  projection := public.get_storyops_recurring_due_work(
    '10000000-0000-4000-8000-000000000001'
  );
  plan_id_value := (projection #>> '{workItems,0,recurringPlanId}')::uuid;
  source_plan_version_value :=
    (projection #>> '{workItems,0,sourcePlanVersion}')::integer;
  plan_due_date_value := (projection #>> '{workItems,0,planDueDate}')::date;
  work_item_id := (projection #>> '{workItems,0,id}')::uuid;
  advanced_due_date := (projection #>> '{plans,0,nextDueDate}')::date;
  request_hash_value := encode(
    extensions.digest(
      array_to_string(
        array[
          'storyops-recurring-due-work-v1',
          '10000000-0000-4000-8000-000000000001',
          plan_id_value::text,
          source_plan_version_value::text,
          plan_due_date_value::text
        ],
        chr(31)
      ),
      'sha256'
    ),
    'hex'
  );
  receipt := public.create_storyops_recurring_due_work(
    '10000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000102',
    plan_id_value,
    source_plan_version_value,
    plan_due_date_value,
    request_hash_value
  );
  projection := public.get_storyops_recurring_due_work(
    '10000000-0000-4000-8000-000000000001'
  );
  if receipt ->> 'alreadyExisted' <> 'true'
    or receipt ->> 'workItemId' <> work_item_id::text
    or (projection #>> '{plans,0,nextDueDate}')::date <> advanced_due_date
  then
    raise exception 'Dispatcher duplicate reconciliation was not idempotent: %', receipt;
  end if;
end;
$$;

\echo '4/9 customer reads only its own review state and cannot create staff work'
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
do $$
declare
  projection jsonb;
  plan_id_value uuid;
  source_plan_version_value integer;
  plan_due_date_value date;
  request_hash_value text;
  blocked boolean := false;
begin
  projection := public.get_storyops_recurring_due_work(
    '10000000-0000-4000-8000-000000000001'
  );
  if projection ->> 'role' <> 'customer'
    or jsonb_array_length(projection -> 'plans') <> 1
    or jsonb_array_length(projection -> 'workItems') <> 1
    or projection #>> '{workItems,0,customerContacted}' <> 'false'
    or projection #>> '{workItems,0,bookingBoundary}' <> 'job.book'
  then
    raise exception 'Customer recurring projection is invalid: %', projection;
  end if;
  plan_id_value := (projection #>> '{workItems,0,recurringPlanId}')::uuid;
  source_plan_version_value :=
    (projection #>> '{workItems,0,sourcePlanVersion}')::integer;
  plan_due_date_value := (projection #>> '{workItems,0,planDueDate}')::date;
  request_hash_value := encode(
    extensions.digest(
      array_to_string(
        array[
          'storyops-recurring-due-work-v1',
          '10000000-0000-4000-8000-000000000001',
          plan_id_value::text,
          source_plan_version_value::text,
          plan_due_date_value::text
        ],
        chr(31)
      ),
      'sha256'
    ),
    'hex'
  );
  begin
    perform public.create_storyops_recurring_due_work(
      '10000000-0000-4000-8000-000000000001',
      '41000000-0000-4000-8000-000000000103',
      plan_id_value,
      source_plan_version_value,
      plan_due_date_value,
      request_hash_value
    );
  exception when others then
    blocked := sqlerrm = 'RECURRING_DUE_ACTIVE_STAFF_REQUIRED';
  end;
  if not blocked then
    raise exception 'Customer created a staff recurring work item';
  end if;
end;
$$;

\echo '5/9 technician and cross-tenant reads fail closed'
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000103', true);
do $$
declare
  blocked_technician boolean := false;
  blocked_tenant boolean := false;
begin
  begin
    perform public.get_storyops_recurring_due_work(
      '10000000-0000-4000-8000-000000000001'
    );
  exception when others then
    blocked_technician := sqlerrm = 'RECURRING_DUE_ACTIVE_ROLE_REQUIRED';
  end;
  begin
    perform public.get_storyops_recurring_due_work(
      '10000000-0000-4000-8000-000000000002'
    );
  exception when others then
    blocked_tenant := sqlerrm = 'RECURRING_DUE_ACTIVE_ROLE_REQUIRED';
  end;
  if not blocked_technician or not blocked_tenant then
    raise exception 'Recurring due-work read escaped role or tenant scope';
  end if;
end;
$$;

\echo '6/9 future due dates, stale versions, forged hashes, and command conflicts fail closed'
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
do $$
declare
  company_id_value uuid := '10000000-0000-4000-8000-000000000001';
  plan_id_value uuid;
  plan_version_value integer;
  next_due_date_value date;
  projection jsonb;
  future_hash text;
  blocked_future boolean := false;
  blocked_stale boolean := false;
  blocked_hash boolean := false;
  blocked_conflict boolean := false;
begin
  projection := public.get_storyops_recurring_due_work(company_id_value);
  plan_id_value := (projection #>> '{plans,0,planId}')::uuid;
  plan_version_value := (projection #>> '{plans,0,planVersion}')::integer;
  next_due_date_value := (projection #>> '{plans,0,nextDueDate}')::date;
  future_hash := encode(
    extensions.digest(
      array_to_string(
        array[
          'storyops-recurring-due-work-v1',
          company_id_value::text,
          plan_id_value::text,
          plan_version_value::text,
          next_due_date_value::text
        ],
        chr(31)
      ),
      'sha256'
    ),
    'hex'
  );
  begin
    perform public.create_storyops_recurring_due_work(
      company_id_value,
      '41000000-0000-4000-8000-000000000104',
      plan_id_value,
      plan_version_value,
      next_due_date_value,
      future_hash
    );
  exception when others then
    blocked_future := sqlerrm = 'RECURRING_DUE_PLAN_NOT_ELIGIBLE';
  end;
  begin
    perform public.create_storyops_recurring_due_work(
      company_id_value,
      '41000000-0000-4000-8000-000000000105',
      plan_id_value,
      plan_version_value - 1,
      next_due_date_value,
      encode(
        extensions.digest(
          array_to_string(
            array[
              'storyops-recurring-due-work-v1',
              company_id_value::text,
              plan_id_value::text,
              (plan_version_value - 1)::text,
              next_due_date_value::text
            ],
            chr(31)
          ),
          'sha256'
        ),
        'hex'
      )
    );
  exception when others then
    blocked_stale := sqlerrm = 'RECURRING_DUE_PLAN_NOT_ELIGIBLE';
  end;
  begin
    perform public.create_storyops_recurring_due_work(
      company_id_value,
      '41000000-0000-4000-8000-000000000106',
      plan_id_value,
      plan_version_value,
      next_due_date_value,
      repeat('f', 64)
    );
  exception when others then
    blocked_hash := sqlerrm = 'RECURRING_DUE_REQUEST_HASH_MISMATCH';
  end;
  begin
    perform public.create_storyops_recurring_due_work(
      company_id_value,
      '41000000-0000-4000-8000-000000000101',
      plan_id_value,
      plan_version_value,
      next_due_date_value,
      future_hash
    );
  exception when others then
    blocked_conflict := sqlerrm = 'RECURRING_DUE_IDEMPOTENCY_CONFLICT';
  end;
  if not blocked_future or not blocked_stale or not blocked_hash or not blocked_conflict then
    raise exception 'A recurring due-work guard failed closed: %, %, %, %',
      blocked_future, blocked_stale, blocked_hash, blocked_conflict;
  end if;
end;
$$;

\echo '7/9 upgraded weekly cadences advance to the first future service date'
reset role;
update public.recurring_maintenance_plans
set status = 'paused'
where id = '41000000-0000-4000-8000-000000000001';

insert into public.recurring_maintenance_plans(
  id,
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
  '41000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000211',
  array['pressure-wash-flatwork', 'gutter-cleaning'],
  'weekly',
  null,
  (
    now() at time zone (
      select company.timezone
      from public.companies company
      where company.id = '10000000-0000-4000-8000-000000000001'
    )
  )::date - 35,
  'active',
  '10000000-0000-4000-8000-000000000401',
  true,
  '10000000-0000-4000-8000-000000000631',
  '10000000-0000-4000-8000-000000000651',
  '10000000-0000-4000-8000-000000000501',
  '10000000-0000-4000-8000-000000000101',
  now()
);

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  cadence_case record;
  iteration integer := 0;
  local_today date := (
    now() at time zone (
      select company.timezone
      from public.companies company
      where company.id = '10000000-0000-4000-8000-000000000001'
    )
  )::date;
  due_date_value date;
  next_due_date_value date;
  plan_version_value integer;
  request_hash_value text;
begin
  for cadence_case in
    select *
    from (
      values
        ('weekly'::text, 35, 7, '41000000-0000-4000-8000-000000000111'::uuid),
        ('biweekly'::text, 36, 6, '41000000-0000-4000-8000-000000000112'::uuid),
        ('every_four_weeks'::text, 37, 19, '41000000-0000-4000-8000-000000000113'::uuid)
    ) fixture(cadence, days_overdue, expected_days_ahead, command_id)
  loop
    iteration := iteration + 1;
    due_date_value := local_today - cadence_case.days_overdue;
    if iteration > 1 then
      update public.recurring_maintenance_plans
      set
        cadence = cadence_case.cadence,
        next_due_date = due_date_value
      where id = '41000000-0000-4000-8000-000000000011';
    end if;

    select version
    into plan_version_value
    from public.recurring_maintenance_plans
    where id = '41000000-0000-4000-8000-000000000011';

    request_hash_value := encode(
      extensions.digest(
        array_to_string(
          array[
            'storyops-recurring-due-work-v1',
            '10000000-0000-4000-8000-000000000001',
            '41000000-0000-4000-8000-000000000011',
            plan_version_value::text,
            due_date_value::text
          ],
          chr(31)
        ),
        'sha256'
      ),
      'hex'
    );
    perform public.create_storyops_recurring_due_work(
      '10000000-0000-4000-8000-000000000001',
      cadence_case.command_id,
      '41000000-0000-4000-8000-000000000011',
      plan_version_value,
      due_date_value,
      request_hash_value
    );

    select next_due_date
    into next_due_date_value
    from public.recurring_maintenance_plans
    where id = '41000000-0000-4000-8000-000000000011';
    if next_due_date_value <> local_today + cadence_case.expected_days_ahead then
      raise exception 'Upgraded % cadence advanced to %, expected %',
        cadence_case.cadence,
        next_due_date_value,
        local_today + cadence_case.expected_days_ahead;
    end if;
  end loop;
end;
$$;

\echo '8/9 paused companies cannot create or read recurring due work'
reset role;
update public.companies
set status = 'paused'
where id = '10000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
do $$
declare
  blocked_read boolean := false;
  blocked_write boolean := false;
begin
  begin
    perform public.get_storyops_recurring_due_work(
      '10000000-0000-4000-8000-000000000001'
    );
  exception when others then
    blocked_read := sqlerrm = 'RECURRING_DUE_ACTIVE_ROLE_REQUIRED';
  end;
  begin
    perform public.create_storyops_recurring_due_work(
      '10000000-0000-4000-8000-000000000001',
      '41000000-0000-4000-8000-000000000107',
      '41000000-0000-4000-8000-000000000001',
      1,
      current_date,
      repeat('a', 64)
    );
  exception when others then
    blocked_write := sqlerrm = 'RECURRING_DUE_ACTIVE_STAFF_REQUIRED';
  end;
  if not blocked_read or not blocked_write then
    raise exception 'Paused-company recurring boundary remained operational';
  end if;
end;
$$;

\echo '9/9 only authenticated finite RPCs are exposed'
reset role;
do $$
begin
  if has_table_privilege('authenticated', 'public.recurring_due_occurrences', 'select')
    or has_table_privilege('authenticated', 'public.recurring_due_occurrences', 'insert')
    or has_table_privilege('service_role', 'public.recurring_due_occurrences', 'select')
    or has_function_privilege(
      'service_role',
      'public.create_storyops_recurring_due_work(uuid,uuid,uuid,integer,date,text)',
      'execute'
    )
    or not has_function_privilege(
      'authenticated',
      'public.create_storyops_recurring_due_work(uuid,uuid,uuid,integer,date,text)',
      'execute'
    )
    or not has_function_privilege(
      'authenticated',
      'public.get_storyops_recurring_due_work(uuid)',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'public.attach_storyops_recurring_due_estimate(uuid,uuid,uuid,integer,uuid,text)',
      'execute'
    )
    or not has_function_privilege(
      'authenticated',
      'public.attach_storyops_recurring_due_estimate(uuid,uuid,uuid,integer,uuid,text)',
      'execute'
    )
  then
    raise exception 'Recurring due-work ACL boundary is invalid';
  end if;
end;
$$;

rollback;
