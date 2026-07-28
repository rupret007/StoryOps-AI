\set ON_ERROR_STOP on
begin;

\echo '1/10 worker RPCs are service-role-only'
do $$
begin
  if has_function_privilege(
    'authenticated',
    'public.claim_storyops_post_service_followup(uuid,integer)',
    'execute'
  )
    or has_function_privilege(
      'authenticated',
      'public.begin_storyops_post_service_submission(uuid,uuid,text)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.mark_storyops_post_service_submission_unknown(uuid,uuid,text,text,text)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.complete_storyops_post_service_followup(uuid,uuid,jsonb)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.fail_storyops_post_service_followup(uuid,uuid,text,boolean)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.begin_storyops_post_service_submission(uuid,uuid,text)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.mark_storyops_post_service_submission_unknown(uuid,uuid,text,text,text)',
      'execute'
    )
  then
    raise exception 'Post-service worker RPC privilege boundary failed';
  end if;
end;
$$;

\echo '1a/10 missing trusted-provider GUC fails closed for an authenticated owner'
grant select, update on public.communication_messages to authenticated;
grant select on public.communication_threads to authenticated;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
declare
  blocked boolean := false;
begin
  if current_setting('storyops.provider_evidence_write', true) is not null then
    raise exception 'Provider evidence GUC unexpectedly existed before the regression';
  end if;
  begin
    update public.communication_messages
    set provider_message_id = 'forged-owner-before-trusted-context'
    where id = '10000000-0000-4000-8000-000000000702';
  exception when others then
    blocked := position(
      'COMMUNICATION_PROVIDER_EVIDENCE_TRUSTED_PATH_REQUIRED'
      in sqlerrm
    ) > 0;
  end;
  if not blocked then
    raise exception 'Missing trusted-provider GUC failed open';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);
revoke select, update on public.communication_messages from authenticated;
revoke select on public.communication_threads from authenticated;

update public.companies
set timezone = 'Pacific/Honolulu'
where id = '10000000-0000-4000-8000-000000000001';
update public.visits
set status = 'completed'
where id = '10000000-0000-4000-8000-000000000641';
update public.jobs
set status = 'invoiced'
where id = '10000000-0000-4000-8000-000000000631';
update public.invoices
set
  status = 'paid',
  provider_invoice_id = 'in_post_service_worker_fixture',
  amount_paid = total,
  balance_due = 0,
  paid_at = now()
where id = '10000000-0000-4000-8000-000000000651';

with fixture(receipt) as (
  values (jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'stripe',
    'eventId', 'evt_post_service_worker_paid',
    'eventType', 'invoice.paid',
    'objectId', 'in_post_service_worker_fixture',
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
  'evt_post_service_worker_paid',
  'invoice.paid',
  encode(extensions.digest(receipt::text, 'sha256'), 'hex'),
  'processed',
  receipt,
  now()
from fixture;

\echo '2/10 sandbox receipt is explicit and cannot claim customer delivery'
do $$
declare
  action_result jsonb;
  claim_result jsonb;
  duplicate_claim jsonb;
  completion_result jsonb;
  followup_id uuid;
  communication_id uuid;
begin
  action_result := public.execute_storyops_post_service_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    'a1000000-0000-4000-8000-000000000001',
    'review.request',
    '10000000-0000-4000-8000-000000000651',
    (
      select version
      from public.invoices
      where id = '10000000-0000-4000-8000-000000000651'
    ),
    '{"channel":"email"}'::jsonb
  );
  followup_id := (action_result ->> 'recordId')::uuid;
  update public.post_service_followups
  set scheduled_at = now(), next_attempt_at = now()
  where id = followup_id;

  claim_result := public.claim_storyops_post_service_followup(
    'a1000000-0000-4000-8000-000000000010',
    90
  );
  if claim_result ->> 'operation' <> 'send'
    or claim_result ->> 'followupId' <> followup_id::text
    or claim_result ->> 'consentSnapshotId'
      <> '10000000-0000-4000-8000-000000000232'
    or claim_result ->> 'idempotencyKey'
      <> 'post-service:' || followup_id::text
  then
    raise exception 'Review queue claim was invalid: %', claim_result;
  end if;

  duplicate_claim := public.claim_storyops_post_service_followup(
    'a1000000-0000-4000-8000-000000000011',
    90
  );
  if duplicate_claim is not null then
    raise exception 'Active lease allowed a duplicate claim: %', duplicate_claim;
  end if;

  completion_result := public.complete_storyops_post_service_followup(
    followup_id,
    (claim_result ->> 'claimToken')::uuid,
    jsonb_build_object(
      'provider', 'email',
      'providerId', 'EM_SANDBOX_WORKER_TEST',
      'mode', 'sandbox',
      'status', 'delivered',
      'occurredAt', now()::text,
      'idempotencyKey', 'post-service:' || followup_id::text
    )
  );
  select communication_message_id
  into communication_id
  from public.post_service_followups
  where id = followup_id;
  if completion_result ->> 'status' <> 'sandboxed'
    or completion_result ->> 'externalDeliveryClaimed' <> 'false'
    or not exists (
      select 1
      from public.post_service_followups followup
      where followup.id = followup_id
        and followup.status = 'sandboxed'
        and followup.provider_mode = 'sandbox'
        and followup.provider_status = 'sandbox_recorded'
        and followup.provider_message_id is null
    )
    or not exists (
      select 1
      from public.communication_messages message
      where message.id = communication_id
        and message.delivery_status = 'queued'
        and message.provider_message_id is null
    )
    or not exists (
      select 1
      from public.audit_events event
      where event.entity_id = followup_id
        and event.action = 'post_service.sandbox_receipt_recorded'
        and event.after_data ->> 'externalDeliveryClaimed' = 'false'
    )
  then
    raise exception 'Sandbox receipt fabricated delivery: %', completion_result;
  end if;
end;
$$;

\echo '3/10 owner and dispatcher cannot forge provider evidence or mutate a prepared message'
select set_config(
  'storyops.test_message_id',
  (
    select followup.communication_message_id::text
    from public.post_service_followups followup
    where followup.action_type = 'review_request'
  ),
  true
);
grant select, update on public.communication_messages to authenticated;
grant select on public.communication_threads to authenticated;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
declare
  message_id uuid;
  provider_blocked boolean := false;
  payload_blocked boolean := false;
  provider_error text;
  payload_error text;
begin
  message_id := current_setting('storyops.test_message_id')::uuid;
  begin
    update public.communication_messages
    set
      provider_message_id = 'forged-owner-provider-id',
      delivery_status = 'delivered',
      sent_at = now()
    where id = message_id;
  exception when others then
    provider_error := sqlerrm;
    provider_blocked := position(
      'COMMUNICATION_PROVIDER_EVIDENCE_TRUSTED_PATH_REQUIRED'
      in sqlerrm
    ) > 0;
  end;
  begin
    update public.communication_messages
    set body = 'Forged post-service payload'
    where id = message_id;
  exception when others then
    payload_error := sqlerrm;
    payload_blocked := position(
      'POST_SERVICE_MESSAGE_TRUSTED_PATH_REQUIRED'
      in sqlerrm
    ) > 0;
  end;
  if not provider_blocked or not payload_blocked then
    raise exception
      'Owner mutation guard failed (provider % / %, payload % / %, provider context %, role %, auth role %)',
      provider_blocked,
      provider_error,
      payload_blocked,
      payload_error,
      current_setting('storyops.provider_evidence_write', true),
      current_setting('role', true),
      auth.role();
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated"}',
  true
);
do $$
declare
  message_id uuid;
  blocked boolean := false;
begin
  message_id := current_setting('storyops.test_message_id')::uuid;
  begin
    update public.communication_messages
    set delivery_status = 'delivered'
    where id = message_id;
  exception when others then
    blocked := position(
      'COMMUNICATION_PROVIDER_EVIDENCE_TRUSTED_PATH_REQUIRED'
      in sqlerrm
    ) > 0;
  end;
  if not blocked then
    raise exception 'Dispatcher forged provider delivery';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);
revoke select, update on public.communication_messages from authenticated;
revoke select on public.communication_threads from authenticated;

\echo '4/10 live marketing email is cancelled without calling a provider'
do $$
declare
  followup_id uuid;
  claim_result jsonb;
  failure_result jsonb;
begin
  select id
  into followup_id
  from public.post_service_followups
  where action_type = 'review_request';
  update public.post_service_followups
  set
    status = 'queued',
    completed_at = null,
    provider_mode = null,
    provider_name = null,
    provider_status = null,
    next_attempt_at = now(),
    last_error_code = null
  where id = followup_id;
  claim_result := public.claim_storyops_post_service_followup(
    'a1000000-0000-4000-8000-000000000014',
    90
  );
  failure_result := public.fail_storyops_post_service_followup(
    followup_id,
    (claim_result ->> 'claimToken')::uuid,
    'LIVE_EMAIL_MARKETING_UNSUBSCRIBE_REQUIRED',
    false
  );
  if failure_result ->> 'status' <> 'cancelled'
    or failure_result ->> 'externalDeliveryClaimed' <> 'false'
    or not exists (
      select 1
      from public.post_service_followups followup
      where followup.id = followup_id
        and followup.status = 'cancelled'
        and followup.last_error_code
          = 'LIVE_EMAIL_MARKETING_UNSUBSCRIBE_REQUIRED'
    )
  then
    raise exception 'Unsafe live marketing email was not cancelled: %',
      failure_result;
  end if;
end;
$$;

\echo '5/10 an ambiguous live SMS submission is quarantined and never re-leased'
do $$
declare
  followup_id uuid;
  claim_result jsonb;
begin
  select id
  into followup_id
  from public.post_service_followups
  where action_type = 'review_request';
  update public.post_service_followups
  set
    channel = 'sms',
    consent_record_id = '10000000-0000-4000-8000-000000000233',
    status = 'queued',
    completed_at = null,
    communication_message_id = null,
    provider_mode = null,
    provider_name = null,
    provider_status = null,
    provider_message_id = null,
    scheduled_at = now(),
    next_attempt_at = now(),
    last_error_code = null
  where id = followup_id;
  claim_result := public.claim_storyops_post_service_followup(
    'a1000000-0000-4000-8000-000000000015',
    90
  );
  if claim_result ->> 'operation' <> 'send'
    or claim_result ->> 'followupId' <> followup_id::text
    or claim_result ->> 'channel' <> 'sms'
  then
    raise exception 'Live SMS fixture claim was invalid: %', claim_result;
  end if;
  perform set_config('storyops.test_followup_id', followup_id::text, true);
  perform set_config(
    'storyops.test_claim_token',
    claim_result ->> 'claimToken',
    true
  );
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
  blocked boolean := false;
begin
  begin
    perform public.begin_storyops_post_service_submission(
      current_setting('storyops.test_followup_id')::uuid,
      current_setting('storyops.test_claim_token')::uuid,
      'twilio'
    );
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then
    raise exception
      'Authenticated owner crossed submission boundary with an exact claim token';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);

do $$
declare
  followup_id uuid := current_setting('storyops.test_followup_id')::uuid;
  claim_token uuid := current_setting('storyops.test_claim_token')::uuid;
  boundary_result jsonb;
  unknown_result jsonb;
  duplicate_claim jsonb;
begin
  boundary_result := public.begin_storyops_post_service_submission(
    followup_id,
    claim_token,
    'twilio'
  );
  unknown_result := public.mark_storyops_post_service_submission_unknown(
    followup_id,
    claim_token,
    'NETWORK_ERROR',
    'twilio',
    'SM_AMBIGUOUS_WORKER_TEST_001'
  );
  duplicate_claim := public.claim_storyops_post_service_followup(
    'a1000000-0000-4000-8000-000000000016',
    90
  );
  if boundary_result ->> 'status' <> 'submitted_unknown'
    or unknown_result ->> 'status' <> 'submitted_unknown'
    or unknown_result ->> 'retryScheduled' <> 'false'
    or duplicate_claim is not null
    or not exists (
      select 1
      from public.post_service_followups followup
      join public.communication_messages message
        on message.id = followup.communication_message_id
      where followup.id = followup_id
        and followup.status = 'submitted_unknown'
        and followup.provider_mode = 'live'
        and followup.provider_name = 'twilio'
        and followup.provider_status = 'submission_unknown'
        and followup.provider_message_id = 'SM_AMBIGUOUS_WORKER_TEST_001'
        and followup.claim_token is null
        and followup.claim_expires_at is null
        and message.provider_message_id = 'SM_AMBIGUOUS_WORKER_TEST_001'
        and message.delivery_status = 'queued'
    )
    or not exists (
      select 1
      from public.audit_events event
      where event.entity_id = followup_id
        and event.action = 'post_service.provider_submission_unknown'
        and event.after_data ->> 'manualReconciliationRequired' = 'true'
        and event.after_data ->> 'externalDeliveryClaimed' = 'false'
    )
  then
    raise exception 'Ambiguous live SMS was not quarantined: %, %, %',
      boundary_result,
      unknown_result,
      duplicate_claim;
  end if;
end;
$$;

\echo '6/10 due recurring maintenance becomes one durable message'
do $$
declare
  activation_result jsonb;
  queued_count integer;
  claim_result jsonb;
  completion_result jsonb;
  followup_id uuid;
  message_id uuid;
begin
  activation_result := public.execute_storyops_post_service_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    'a1000000-0000-4000-8000-000000000002',
    'maintenance.activate',
    '10000000-0000-4000-8000-000000000651',
    (
      select version
      from public.invoices
      where id = '10000000-0000-4000-8000-000000000651'
    ),
    jsonb_build_object(
      'cadence', 'annual',
      'nextDueDate', (current_date + 1)::text
    )
  );
  queued_count := public.queue_storyops_due_maintenance_followups(10);
  if queued_count <> 1
    or public.queue_storyops_due_maintenance_followups(10) <> 0
  then
    raise exception 'Maintenance materialization was not idempotent';
  end if;
  select id
  into followup_id
  from public.post_service_followups
  where recurring_plan_id = (activation_result ->> 'recordId')::uuid
    and action_type = 'maintenance_reminder';
  if followup_id is null then
    raise exception 'Maintenance message was not durably queued';
  end if;
  update public.post_service_followups
  set
    channel = 'sms',
    consent_record_id = '10000000-0000-4000-8000-000000000233'
  where id = followup_id;

  claim_result := public.claim_storyops_post_service_followup(
    'a1000000-0000-4000-8000-000000000012',
    90
  );
  perform public.begin_storyops_post_service_submission(
    followup_id,
    (claim_result ->> 'claimToken')::uuid,
    'twilio'
  );
  completion_result := public.complete_storyops_post_service_followup(
    followup_id,
    (claim_result ->> 'claimToken')::uuid,
    jsonb_build_object(
      'provider', 'twilio',
      'providerId', 'SM_LIVE_WORKER_TEST_001',
      'mode', 'live',
      'status', 'queued',
      'occurredAt', now()::text,
      'idempotencyKey', 'post-service:' || followup_id::text
    )
  );
  select communication_message_id
  into message_id
  from public.post_service_followups
  where id = followup_id;
  if completion_result ->> 'status' <> 'submitted'
    or completion_result ->> 'externalDeliveryClaimed' <> 'false'
  then
    raise exception 'Provider acceptance was treated as delivery: %',
      completion_result;
  end if;

  update public.communication_messages
  set delivery_status = 'delivered'
  where id = message_id;
  if not exists (
    select 1
    from public.post_service_followups followup
    where followup.id = followup_id
      and followup.status = 'completed'
      and followup.provider_mode = 'live'
      and followup.provider_status = 'delivered'
      and followup.completed_at is not null
  )
    or not exists (
      select 1
      from public.audit_events event
      where event.entity_id = followup_id
        and event.action = 'post_service.delivery_reconciled'
        and event.after_data ->> 'externalDeliveryClaimed' = 'true'
    )
  then
    raise exception 'Verified delivery did not reconcile to the follow-up';
  end if;
end;
$$;

\echo '7/10 suppression cancels before send and a newer grant cannot override it'
do $$
declare
  action_result jsonb;
  claim_result jsonb;
  followup_id uuid;
begin
  action_result := public.execute_storyops_post_service_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    'a1000000-0000-4000-8000-000000000003',
    'referral.invite',
    '10000000-0000-4000-8000-000000000651',
    (
      select version
      from public.invoices
      where id = '10000000-0000-4000-8000-000000000651'
    ),
    '{"channel":"email"}'::jsonb
  );
  followup_id := (action_result ->> 'recordId')::uuid;
  update public.post_service_followups
  set scheduled_at = now(), next_attempt_at = now()
  where id = followup_id;
  insert into public.consent_records(
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
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'email',
    'marketing',
    'withdrawn',
    now(),
    'written',
    'worker-test-opt-out-v1',
    'SQL worker contract test',
    now()
  );
  insert into public.consent_records(
    company_id,
    customer_id,
    channel,
    purpose,
    status,
    captured_at,
    capture_method,
    disclosure_version,
    proof
  )
  values (
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'email',
    'marketing',
    'granted',
    now() + interval '1 second',
    'written',
    'worker-test-forged-regrant-v1',
    'Newer grant must not override durable suppression'
  );
  update public.customers
  set do_not_contact = true
  where id = '10000000-0000-4000-8000-000000000201';

  claim_result := public.claim_storyops_post_service_followup(
    'a1000000-0000-4000-8000-000000000013',
    90
  );
  if claim_result is not null
    or not exists (
      select 1
      from public.post_service_followups followup
      where followup.id = followup_id
        and followup.status = 'cancelled'
        and followup.last_error_code = 'CONTACT_OR_COMPANY_INELIGIBLE'
        and followup.communication_message_id is null
    )
  then
    raise exception 'Current opt-out did not cancel before send: %', claim_result;
  end if;
end;
$$;

\echo '8/10 owner cannot clear durable suppression without a reviewed path'
grant select, update on public.customers to authenticated;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
declare
  blocked boolean := false;
  mutation_error text;
begin
  begin
    update public.customers
    set do_not_contact = false
    where id = '10000000-0000-4000-8000-000000000201';
  exception when others then
    mutation_error := sqlerrm;
    blocked := position('CONTACT_SUPPRESSION_REVIEW_REQUIRED' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception
      'Owner suppression guard failed (error %, context %, role %, auth role %)',
      mutation_error,
      current_setting('storyops.suppression_review', true),
      current_setting('role', true),
      auth.role();
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);
revoke select, update on public.customers from authenticated;

\echo '9/10 stale claim token and malformed receipts fail closed'
do $$
declare
  blocked boolean := false;
  followup_id uuid;
begin
  select id
  into followup_id
  from public.post_service_followups
  where action_type = 'review_request'
  limit 1;
  begin
    perform public.complete_storyops_post_service_followup(
      followup_id,
      'a1000000-0000-4000-8000-000000000099',
      '{}'::jsonb
    );
  exception when others then
    blocked := position('POST_SERVICE_WORKER_CLAIM_LOST' in sqlerrm) > 0
      or position('POST_SERVICE_WORKER_INVALID_RECEIPT' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Stale claim token or malformed receipt was accepted';
  end if;
end;
$$;

\echo '10/10 expired final leases resolve visibly while unknown submissions stay quarantined'
do $$
declare
  queued_followup_id uuid;
  queued_message_id uuid;
  submitted_followup_id uuid;
  submitted_message_id uuid;
  claim_result jsonb;
  status_projection jsonb;
begin
  select id
  into queued_followup_id
  from public.post_service_followups
  where action_type = 'referral_invite';

  select id, communication_message_id
  into submitted_followup_id, submitted_message_id
  from public.post_service_followups
  where action_type = 'maintenance_reminder';

  with inserted_thread as (
    insert into public.communication_threads(
      company_id,
      customer_id,
      subject,
      status
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000201',
      'Exhausted worker fixture',
      'open'
    )
    returning id
  )
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
  select
    '10000000-0000-4000-8000-000000000001',
    inserted_thread.id,
    'email',
    'outbound',
    'StoryOps Local Fixture',
    array['customer@storyops.local'],
    'Synthetic queued worker-exhaustion fixture.',
    'routine',
    'queued',
    '10000000-0000-4000-8000-000000000232',
    'post-service-worker-v1'
  from inserted_thread
  returning id into queued_message_id;

  update public.post_service_followups
  set
    status = 'queued',
    completed_at = null,
    provider_mode = null,
    provider_name = null,
    provider_status = null,
    provider_message_id = null,
    communication_message_id = queued_message_id,
    attempt_count = max_attempts,
    last_error_code = null,
    claimed_by = 'a1000000-0000-4000-8000-000000000020',
    claim_token = 'a1000000-0000-4000-8000-000000000021',
    claim_operation = 'send',
    claim_expires_at = now() - interval '1 second',
    next_attempt_at = now()
  where id = queued_followup_id;

  update public.communication_messages
  set delivery_status = 'queued'
  where id = submitted_message_id;

  update public.post_service_followups
  set
    status = 'submitted',
    completed_at = null,
    reconciliation_count = max_attempts,
    last_error_code = null,
    claimed_by = 'a1000000-0000-4000-8000-000000000022',
    claim_token = 'a1000000-0000-4000-8000-000000000023',
    claim_operation = 'reconcile',
    claim_expires_at = now() - interval '1 second',
    next_attempt_at = now()
  where id = submitted_followup_id;

  claim_result := public.claim_storyops_post_service_followup(
    'a1000000-0000-4000-8000-000000000024',
    90
  );
  perform set_config(
    'request.jwt.claims',
    '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
    true
  );
  status_projection := public.get_storyops_post_service_status(
    '10000000-0000-4000-8000-000000000001'
  );
  perform set_config('request.jwt.claims', '{}', true);

  if claim_result is not null
    or not exists (
      select 1
      from public.post_service_followups followup
      where followup.id = queued_followup_id
        and followup.status = 'failed'
        and followup.last_error_code = 'WORKER_LEASE_EXHAUSTED'
        and followup.claim_token is null
        and followup.claim_expires_at is null
    )
    or not exists (
      select 1
      from public.communication_messages message
      where message.id = queued_message_id
        and message.delivery_status = 'failed'
        and message.provider_message_id is null
    )
    or not exists (
      select 1
      from public.post_service_followups followup
      where followup.id = submitted_followup_id
        and followup.status = 'submitted'
        and followup.last_error_code = 'RECONCILIATION_EXHAUSTED'
        and followup.claim_token is null
        and followup.claim_expires_at is null
        and followup.provider_message_id = 'SM_LIVE_WORKER_TEST_001'
        and followup.provider_status = 'queued'
    )
    or not exists (
      select 1
      from public.communication_messages message
      where message.id = submitted_message_id
        and message.delivery_status = 'queued'
        and message.provider_message_id = 'SM_LIVE_WORKER_TEST_001'
    )
    or not exists (
      select 1
      from public.audit_events event
      where event.entity_id = queued_followup_id
        and event.action = 'post_service.worker_lease_exhausted'
        and event.after_data ->> 'errorCode' = 'WORKER_LEASE_EXHAUSTED'
        and event.after_data ->> 'externalDeliveryClaimed' = 'false'
    )
    or not exists (
      select 1
      from jsonb_array_elements(status_projection -> 'followups') item
      where item ->> 'id' = submitted_followup_id::text
        and item ->> 'status' = 'reconciliation_required'
        and item ->> 'manualReconciliationRequired' = 'true'
        and item ->> 'externalDeliveryClaimed' = 'false'
    )
    or not exists (
      select 1
      from public.audit_events event
      where event.entity_id = submitted_followup_id
        and event.action = 'post_service.reconciliation_exhausted'
        and event.after_data ->> 'errorCode' = 'RECONCILIATION_EXHAUSTED'
        and event.after_data ->> 'status' = 'submitted'
        and event.after_data ->> 'workflowStatus'
          = 'reconciliation_required'
        and event.after_data ->> 'manualReconciliationRequired' = 'true'
        and event.after_data ->> 'externalDeliveryClaimed' = 'false'
    )
    or not exists (
      select 1
      from public.post_service_followups followup
      where followup.status = 'submitted_unknown'
        and followup.provider_status = 'submission_unknown'
        and followup.claim_token is null
    )
  then
    raise exception
      'Exhausted leases were not resolved without disturbing quarantine: %',
      claim_result;
  end if;
end;
$$;

rollback;
