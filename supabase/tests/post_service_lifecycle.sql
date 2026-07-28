\set ON_ERROR_STOP on

-- Provider-backed lifecycle, role scope, consent, domain linkage, retention,
-- and durable idempotency contract. All mutable fixtures roll back.

begin;

\echo '1/6 trusted RPC and raw-table privilege boundary'
do $$
begin
  if has_function_privilege(
    'authenticated',
    'public.execute_storyops_post_service_action(uuid,uuid,uuid,text,uuid,integer,jsonb)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.execute_storyops_post_service_action(uuid,uuid,uuid,text,uuid,integer,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Post-service write RPC privilege boundary is invalid';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.get_storyops_post_service_status(uuid)',
    'EXECUTE'
  ) then
    raise exception 'Authenticated status projection is unavailable';
  end if;
  if has_table_privilege(
    'service_role',
    'public.post_service_followups',
    'SELECT'
  ) or has_table_privilege(
    'authenticated',
    'public.post_service_followups',
    'SELECT'
  ) then
    raise exception 'Post-service consent-bound rows are directly readable';
  end if;
end;
$$;

update public.visits
set status = 'completed'
where id = '10000000-0000-4000-8000-000000000641';
update public.jobs
set status = 'invoiced'
where id = '10000000-0000-4000-8000-000000000631';
update public.invoices
set
  status = 'paid',
  provider_invoice_id = 'in_post_service_sql_fixture',
  amount_paid = total,
  balance_due = 0,
  paid_at = now()
where id = '10000000-0000-4000-8000-000000000651';

\echo '2/6 local paid state without processed provider proof fails closed'
do $$
declare
  invoice_version integer;
  blocked boolean := false;
begin
  select version
  into invoice_version
  from public.invoices
  where id = '10000000-0000-4000-8000-000000000651';
  begin
    perform public.execute_storyops_post_service_action(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '98000000-0000-4000-8000-000000000001',
      'review.request',
      '10000000-0000-4000-8000-000000000651',
      invoice_version,
      '{"channel":"email"}'::jsonb
    );
  exception when others then
    if position('POST_SERVICE_PROVIDER_PAID_INVOICE_REQUIRED' in sqlerrm) > 0
    then blocked := true;
    else raise;
    end if;
  end;
  if not blocked then
    raise exception 'Unverified paid invoice started follow-up';
  end if;
end;
$$;

with fixture(receipt) as (
  values (
    jsonb_build_object(
      'schemaVersion', 'storyops-provider-receipt-v1',
      'provider', 'stripe',
      'eventId', 'evt_post_service_sql_paid',
      'eventType', 'invoice.paid',
      'objectId', 'in_post_service_sql_fixture',
      'objectKind', 'invoice',
      'action', 'invoice_paid',
      'companyId', '10000000-0000-4000-8000-000000000001',
      'occurredAt', now()::text,
      'jobId', '10000000-0000-4000-8000-000000000631',
      'amountCents', 52800,
      'amountPaidCents', 52800,
      'amountRemainingCents', 0,
      'currency', 'usd'
    )
  )
)
insert into public.webhook_events(
  id,
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
  '98000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  'stripe',
  'evt_post_service_sql_paid',
  'invoice.paid',
  encode(extensions.digest(receipt::text, 'sha256'), 'hex'),
  'processed',
  receipt,
  now()
from fixture;

\echo '3/6 current consent, queue truth, replay, conflicts, and deduplication'
do $$
declare
  invoice_version integer;
  first_result jsonb;
  replay_result jsonb;
  duplicate_result jsonb;
  blocked boolean := false;
  record_id uuid;
begin
  select version
  into invoice_version
  from public.invoices
  where id = '10000000-0000-4000-8000-000000000651';

  insert into public.consent_records(
    id,
    company_id,
    customer_id,
    channel,
    purpose,
    status,
    captured_at,
    capture_method,
    disclosure_version,
    proof,
    withdrawn_at
  )
  values (
    '98000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'email',
    'marketing',
    'withdrawn',
    now(),
    'keyword',
    'consent-v1',
    'SQL fixture current withdrawal',
    now()
  );
  begin
    perform public.execute_storyops_post_service_action(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '98000000-0000-4000-8000-000000000004',
      'review.request',
      '10000000-0000-4000-8000-000000000651',
      invoice_version,
      '{"channel":"email"}'::jsonb
    );
  exception when others then
    if position('POST_SERVICE_CURRENT_CONSENT_REQUIRED' in sqlerrm) > 0
    then blocked := true;
    else raise;
    end if;
  end;
  if not blocked then
    raise exception 'Withdrawn consent started a review request';
  end if;
  delete from public.consent_records
  where id = '98000000-0000-4000-8000-000000000003';

  first_result := public.execute_storyops_post_service_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '98000000-0000-4000-8000-000000000005',
    'review.request',
    '10000000-0000-4000-8000-000000000651',
    invoice_version,
    '{"channel":"email"}'::jsonb
  );
  if first_result ->> 'status' <> 'queued'
    or first_result ->> 'replayed' <> 'false'
    or first_result ->> 'alreadyExisted' <> 'false'
    or first_result ->> 'domainRecordId' <> first_result ->> 'recordId'
    or first_result ? 'providerMessageId'
  then
    raise exception 'Review queue receipt claimed unsupported state: %', first_result;
  end if;
  record_id := (first_result ->> 'recordId')::uuid;

  replay_result := public.execute_storyops_post_service_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '98000000-0000-4000-8000-000000000005',
    'review.request',
    '10000000-0000-4000-8000-000000000651',
    invoice_version,
    '{"channel":"email"}'::jsonb
  );
  if replay_result ->> 'replayed' <> 'true'
    or replay_result ->> 'recordId' <> record_id::text
  then
    raise exception 'Review command did not replay exactly: %', replay_result;
  end if;

  blocked := false;
  begin
    perform public.execute_storyops_post_service_action(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '98000000-0000-4000-8000-000000000005',
      'referral.invite',
      '10000000-0000-4000-8000-000000000651',
      invoice_version,
      '{"channel":"email"}'::jsonb
    );
  exception when others then
    if position('POST_SERVICE_IDEMPOTENCY_CONFLICT' in sqlerrm) > 0
    then blocked := true;
    else raise;
    end if;
  end;
  if not blocked then
    raise exception 'Reused command ID changed post-service intent';
  end if;

  duplicate_result := public.execute_storyops_post_service_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '98000000-0000-4000-8000-000000000006',
    'review.request',
    '10000000-0000-4000-8000-000000000651',
    invoice_version,
    '{"channel":"email"}'::jsonb
  );
  if duplicate_result ->> 'alreadyExisted' <> 'true'
    or duplicate_result ->> 'recordId' <> record_id::text
    or (
      select count(*)
      from public.post_service_followups
      where invoice_id = '10000000-0000-4000-8000-000000000651'
        and action_type = 'review_request'
    ) <> 1
  then
    raise exception 'New command ID duplicated the review action: %', duplicate_result;
  end if;

  if not exists (
    select 1
    from public.post_service_followups
    where id = record_id
      and retention_class = 'communication'
      and retain_until between now() + interval '729 days'
        and now() + interval '731 days'
      and not legal_hold
      and status = 'queued'
  ) then
    raise exception 'Review queue is outside bounded retention governance';
  end if;
end;
$$;

\echo '4/6 referral domain row and active plan are source-bound and unique'
do $$
declare
  invoice_version integer;
  referral_result jsonb;
  referral_duplicate jsonb;
  plan_result jsonb;
  plan_duplicate jsonb;
begin
  select version
  into invoice_version
  from public.invoices
  where id = '10000000-0000-4000-8000-000000000651';

  referral_result := public.execute_storyops_post_service_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    '98000000-0000-4000-8000-000000000007',
    'referral.invite',
    '10000000-0000-4000-8000-000000000651',
    invoice_version,
    '{"channel":"email"}'::jsonb
  );
  if referral_result ->> 'status' <> 'queued'
    or referral_result ->> 'domainRecordId'
      = referral_result ->> 'recordId'
    or not exists (
      select 1
      from public.referrals referral
      join public.post_service_followups followup
        on followup.referral_id = referral.id
      where referral.id = (referral_result ->> 'domainRecordId')::uuid
        and referral.source_invoice_id
          = '10000000-0000-4000-8000-000000000651'
        and referral.source_job_id
          = '10000000-0000-4000-8000-000000000631'
        and referral.referrer_customer_id
          = '10000000-0000-4000-8000-000000000201'
        and referral.status = 'invited'
        and followup.id = (referral_result ->> 'recordId')::uuid
        and followup.status = 'queued'
    )
  then
    raise exception 'Referral domain linkage is incomplete: %', referral_result;
  end if;

  referral_duplicate := public.execute_storyops_post_service_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    '98000000-0000-4000-8000-000000000008',
    'referral.invite',
    '10000000-0000-4000-8000-000000000651',
    invoice_version,
    '{"channel":"email"}'::jsonb
  );
  if referral_duplicate ->> 'alreadyExisted' <> 'true'
    or referral_duplicate ->> 'domainRecordId'
      <> referral_result ->> 'domainRecordId'
    or (
      select count(*)
      from public.referrals
      where source_invoice_id = '10000000-0000-4000-8000-000000000651'
    ) <> 1
  then
    raise exception 'Referral domain action duplicated: %', referral_duplicate;
  end if;

  plan_result := public.execute_storyops_post_service_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    '98000000-0000-4000-8000-000000000009',
    'maintenance.activate',
    '10000000-0000-4000-8000-000000000651',
    invoice_version,
    jsonb_build_object(
      'cadence', 'semiannual',
      'nextDueDate', (current_date + 180)::text
    )
  );
  if plan_result ->> 'status' <> 'active'
    or plan_result ->> 'requiresFreshEstimate' <> 'true'
    or plan_result ->> 'domainRecordId' <> plan_result ->> 'recordId'
    or not exists (
      select 1
      from public.recurring_maintenance_plans plan
      join public.jobs job on job.id = plan.source_job_id
      join public.quotes quote on quote.id = job.quote_id
      join public.estimates estimate on estimate.id = quote.estimate_id
      where plan.id = (plan_result ->> 'recordId')::uuid
        and plan.source_invoice_id
          = '10000000-0000-4000-8000-000000000651'
        and plan.source_estimate_id = estimate.id
        and plan.customer_id = job.customer_id
        and plan.property_id = job.property_id
        and plan.service_codes = job.service_codes
        and plan.price_book_id = estimate.price_book_id
        and plan.requires_fresh_estimate
    )
  then
    raise exception 'Maintenance source linkage is incomplete: %', plan_result;
  end if;

  plan_duplicate := public.execute_storyops_post_service_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    '98000000-0000-4000-8000-000000000010',
    'maintenance.activate',
    '10000000-0000-4000-8000-000000000651',
    invoice_version,
    jsonb_build_object(
      'cadence', 'semiannual',
      'nextDueDate', (current_date + 180)::text
    )
  );
  if plan_duplicate ->> 'alreadyExisted' <> 'true'
    or plan_duplicate ->> 'recordId' <> plan_result ->> 'recordId'
    or (
      select count(*)
      from public.recurring_maintenance_plans
      where source_job_id = '10000000-0000-4000-8000-000000000631'
        and status = 'active'
    ) <> 1
  then
    raise exception 'Maintenance action duplicated: %', plan_duplicate;
  end if;
end;
$$;

\echo '5/6 stale versions, technician role, and role-scoped projections fail closed'
do $$
declare
  invoice_version integer;
  blocked boolean := false;
begin
  select version
  into invoice_version
  from public.invoices
  where id = '10000000-0000-4000-8000-000000000651';
  begin
    perform public.execute_storyops_post_service_action(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000103',
      '98000000-0000-4000-8000-000000000011',
      'review.request',
      '10000000-0000-4000-8000-000000000651',
      invoice_version,
      '{"channel":"email"}'::jsonb
    );
  exception when others then
    if position('POST_SERVICE_ROLE_REQUIRED' in sqlerrm) > 0
    then blocked := true;
    else raise;
    end if;
  end;
  if not blocked then raise exception 'Technician started follow-up'; end if;

  blocked := false;
  begin
    perform public.execute_storyops_post_service_action(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '98000000-0000-4000-8000-000000000012',
      'maintenance.activate',
      '10000000-0000-4000-8000-000000000651',
      invoice_version - 1,
      jsonb_build_object(
        'cadence', 'annual',
        'nextDueDate', (current_date + 365)::text
      )
    );
  exception when others then
    if position('POST_SERVICE_INVOICE_VERSION_CONFLICT' in sqlerrm) > 0
    then blocked := true;
    else raise;
    end if;
  end;
  if not blocked then raise exception 'Stale invoice version started lifecycle action'; end if;
end;
$$;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
declare
  projection jsonb;
begin
  projection := public.get_storyops_post_service_status(
    '10000000-0000-4000-8000-000000000001'
  );
  if jsonb_array_length(projection -> 'followups') <> 2
    or jsonb_array_length(projection -> 'maintenancePlans') <> 1
    or not exists (
      select 1
      from jsonb_array_elements(projection -> 'followups') item
      where item ->> 'action' = 'referral.invite'
        and item ->> 'domainRecordId' is not null
    )
  then
    raise exception 'Owner lifecycle projection is incomplete: %', projection;
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);
do $$
declare
  projection jsonb;
begin
  projection := public.get_storyops_post_service_status(
    '10000000-0000-4000-8000-000000000001'
  );
  if jsonb_array_length(projection -> 'followups') <> 2
    or jsonb_array_length(projection -> 'maintenancePlans') <> 1
  then
    raise exception 'Portal lifecycle projection escaped customer scope: %', projection;
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000103","role":"authenticated"}',
  true
);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_storyops_post_service_status(
      '10000000-0000-4000-8000-000000000001'
    );
  exception when others then
    if position('POST_SERVICE_STATUS_ROLE_REQUIRED' in sqlerrm) > 0
    then blocked := true;
    else raise;
    end if;
  end;
  if not blocked then raise exception 'Technician read lifecycle projection'; end if;
end;
$$;
reset role;

\echo '6/6 retention dry-run inventories follow-up communication records'
update public.post_service_followups
set retain_until = now() - interval '1 day'
where company_id = '10000000-0000-4000-8000-000000000001'
  and action_type = 'review_request';

do $$
declare
  retention_result record;
begin
  select *
  into retention_result
  from public.apply_retention_policy(
    '10000000-0000-4000-8000-000000000001',
    now(),
    true,
    null
  );
  if (retention_result.candidate_counts ->> 'postServiceFollowups')::integer <> 1
    or retention_result.affected_counts <> '{}'::jsonb
    or not exists (
      select 1
      from public.retention_runs run
      where run.id = retention_result.run_id
        and run.candidate_counts ->> 'postServiceFollowups' = '1'
        and run.evidence_sha256 = retention_result.evidence_sha256
    )
  then
    raise exception 'Post-service retention inventory is incomplete';
  end if;
end;
$$;

rollback;
