\set ON_ERROR_STOP on

begin;

insert into public.companies(id, name, status)
values (
  '99000000-0000-4000-8000-000000000004',
  'Scope cleanup claim isolation',
  'active'
);

create temporary table active_company_service_fixture (
  scheduling_attempt jsonb,
  scheduling_request_hash text,
  scheduling_attempt_id uuid,
  scope_request_id uuid,
  scope_object_path text
) on commit drop;

insert into active_company_service_fixture default values;
grant select, update on active_company_service_fixture to service_role;

-- The production service role retains no generic tenant-table access. Read-only
-- inspection is granted only inside this rolled-back contract so assertions can
-- run in the same JWT/role context as each finite service RPC.
grant select on
  public.scheduling_calendar_booking_attempts,
  public.scheduling_reconciliation_cases,
  public.post_service_followups,
  public.audit_events,
  public.automation_runs,
  public.owner_briefings,
  public.scope_photo_upload_reservations,
  public.media_assets,
  public.scope_photo_submissions,
  public.media_upload_attestations
to service_role;

-- Keep worker eligibility deterministic regardless of the host clock.
update public.companies
set timezone = (
  select zone.name
  from pg_timezone_names zone
  where (now() at time zone zone.name)::time >= time '09:00'
    and (now() at time zone zone.name)::time < time '19:00'
  order by zone.name
  limit 1
)
where id = '10000000-0000-4000-8000-000000000001';

-- Three independent follow-ups let the contract exercise a pre-claimed send,
-- an unclaimed queued send, and an already-submitted reconciliation.
insert into public.invoices(
  id,
  company_id,
  invoice_number,
  customer_id,
  job_id,
  status,
  issue_date,
  due_date,
  subtotal,
  tax,
  total,
  amount_paid,
  balance_due,
  paid_at
)
values
  (
    '36000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000001',
    'INV-ACTIVE-GATE-101',
    '10000000-0000-4000-8000-000000000201',
    null,
    'paid',
    current_date,
    current_date,
    1.00,
    0.00,
    1.00,
    1.00,
    0.00,
    now()
  ),
  (
    '36000000-0000-4000-8000-000000000102',
    '10000000-0000-4000-8000-000000000001',
    'INV-ACTIVE-GATE-102',
    '10000000-0000-4000-8000-000000000201',
    null,
    'paid',
    current_date,
    current_date,
    1.00,
    0.00,
    1.00,
    1.00,
    0.00,
    now()
  ),
  (
    '36000000-0000-4000-8000-000000000103',
    '10000000-0000-4000-8000-000000000001',
    'INV-ACTIVE-GATE-103',
    '10000000-0000-4000-8000-000000000201',
    null,
    'paid',
    current_date,
    current_date,
    1.00,
    0.00,
    1.00,
    1.00,
    0.00,
    now()
  );

insert into public.communication_threads(
  id,
  company_id,
  customer_id,
  subject,
  status
)
values
  (
    '36000000-0000-4000-8000-000000000111',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'Paused pre-claimed send',
    'open'
  ),
  (
    '36000000-0000-4000-8000-000000000112',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'Paused queued send',
    'open'
  ),
  (
    '36000000-0000-4000-8000-000000000113',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'Paused provider reconciliation',
    'open'
  );

insert into public.communication_messages(
  id,
  company_id,
  thread_id,
  channel,
  direction,
  sender,
  recipients,
  body,
  provider_message_id,
  delivery_status,
  consent_record_id,
  sent_by_agent
)
values
  (
    '36000000-0000-4000-8000-000000000121',
    '10000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000111',
    'sms',
    'outbound',
    'StoryOps active-company contract',
    array['+12145550172'],
    'Synthetic pre-claimed message. Reply STOP to opt out.',
    null,
    'queued',
    '10000000-0000-4000-8000-000000000233',
    'post-service-worker-v1'
  ),
  (
    '36000000-0000-4000-8000-000000000122',
    '10000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000112',
    'sms',
    'outbound',
    'StoryOps active-company contract',
    array['+12145550172'],
    'Synthetic queued message. Reply STOP to opt out.',
    null,
    'queued',
    '10000000-0000-4000-8000-000000000233',
    'post-service-worker-v1'
  ),
  (
    '36000000-0000-4000-8000-000000000123',
    '10000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000113',
    'sms',
    'outbound',
    'StoryOps active-company contract',
    array['+12145550172'],
    'Synthetic submitted message. Reply STOP to opt out.',
    'SM_ACTIVE_GATE_RECONCILE_001',
    'queued',
    '10000000-0000-4000-8000-000000000233',
    'post-service-worker-v1'
  );

insert into public.post_service_followups(
  id,
  company_id,
  invoice_id,
  job_id,
  customer_id,
  property_id,
  action_type,
  channel,
  consent_record_id,
  communication_message_id,
  status,
  scheduled_at,
  provider_mode,
  provider_name,
  provider_status,
  provider_message_id,
  attempt_count,
  reconciliation_count,
  max_attempts,
  next_attempt_at,
  claimed_by,
  claim_token,
  claim_operation,
  claim_expires_at,
  created_by_user_id
)
values
  (
    '36000000-0000-4000-8000-000000000131',
    '10000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000631',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'review_request',
    'sms',
    '10000000-0000-4000-8000-000000000233',
    '36000000-0000-4000-8000-000000000121',
    'queued',
    now() - interval '1 minute',
    null,
    null,
    null,
    null,
    1,
    0,
    6,
    now() - interval '1 minute',
    '36000000-0000-4000-8000-000000000141',
    '36000000-0000-4000-8000-000000000142',
    'send',
    now() + interval '5 minutes',
    '10000000-0000-4000-8000-000000000101'
  ),
  (
    '36000000-0000-4000-8000-000000000132',
    '10000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000102',
    '10000000-0000-4000-8000-000000000631',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'review_request',
    'sms',
    '10000000-0000-4000-8000-000000000233',
    '36000000-0000-4000-8000-000000000122',
    'queued',
    now() - interval '1 minute',
    null,
    null,
    null,
    null,
    0,
    0,
    6,
    now() - interval '1 minute',
    null,
    null,
    null,
    null,
    '10000000-0000-4000-8000-000000000101'
  ),
  (
    '36000000-0000-4000-8000-000000000133',
    '10000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000103',
    '10000000-0000-4000-8000-000000000631',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'review_request',
    'sms',
    '10000000-0000-4000-8000-000000000233',
    '36000000-0000-4000-8000-000000000123',
    'submitted',
    now() - interval '1 minute',
    'live',
    'twilio',
    'accepted',
    'SM_ACTIVE_GATE_RECONCILE_001',
    1,
    0,
    6,
    now() - interval '1 minute',
    null,
    null,
    null,
    null,
    '10000000-0000-4000-8000-000000000101'
  );

-- The scheduling provider attempt is prepared from an exact canonical
-- envelope while the company is active.
update active_company_service_fixture
set scheduling_attempt = (
  select jsonb_build_object(
    'schemaVersion', 'storyops-calendar-booking-attempt-input-v1',
    'jobId', job.id,
    'jobVersion', job.version,
    'propertyId', job.property_id,
    'crewId', '10000000-0000-4000-8000-000000000601',
    'calendarId', 'primary',
    'eventId', private.storyops_calendar_event_id(
      'active-gate-scheduling-001:calendar'
    ),
    'providerIdempotencyKey', 'active-gate-scheduling-001:calendar',
    'startsAt', date_trunc('day', now() + interval '7 days') + interval '9 hours',
    'endsAt', date_trunc('day', now() + interval '7 days') + interval '13 hours',
    'traceId', 'active-company-service-boundary'
  )
  from public.jobs job
  where job.id = '10000000-0000-4000-8000-000000000631'
);

update active_company_service_fixture
set scheduling_request_hash = public.storyops_json_sha256(
  jsonb_build_object(
    'actorUserId', '10000000-0000-4000-8000-000000000102'::uuid,
    'companyId', '10000000-0000-4000-8000-000000000001'::uuid,
    'schedulingIdempotencyKey', 'active-gate-scheduling-001',
    'attempt', scheduling_attempt
  )
);

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);

\echo '1/8 service JWT prepares exact scheduling, AI, and scope-photo work while active'
do $$
declare
  scheduling_receipt jsonb;
  ai_receipt jsonb;
  scope_request jsonb;
  scope_reservation jsonb;
begin
  scheduling_receipt := public.prepare_storyops_calendar_booking_attempt(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000102',
    'active-gate-scheduling-001',
    (select scheduling_request_hash from active_company_service_fixture),
    (select scheduling_attempt from active_company_service_fixture)
  );
  if scheduling_receipt ->> 'status' <> 'prepared' then
    raise exception 'Scheduling attempt did not prepare: %', scheduling_receipt;
  end if;
  update active_company_service_fixture
  set scheduling_attempt_id = (scheduling_receipt ->> 'attemptId')::uuid;

  ai_receipt := public.begin_storyops_ai_office_run(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '36000000-0000-4000-8000-000000000201',
    'owner_briefing',
    'ai-office:manual:36000000-0000-4000-8000-000000000201',
    '{}'::jsonb,
    false,
    date_trunc('milliseconds', now())
  );
  if ai_receipt ->> 'durableStatus' <> 'running' then
    raise exception 'AI Office run did not begin: %', ai_receipt;
  end if;

  scope_request := public.create_scope_photo_request(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'Paused-company finalization boundary contract.',
    7,
    'scope-request:active-company-service-boundary',
    repeat('a', 64)
  );
  update active_company_service_fixture
  set scope_request_id = (scope_request ->> 'requestId')::uuid;

  scope_reservation := public.prepare_scope_photo_upload(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    (scope_request ->> 'requestId')::uuid,
    'front_elevation',
    '36000000-0000-4000-8000-000000000211',
    'image/png',
    68,
    repeat('c', 64),
    clock_timestamp(),
    '36000000-0000-4000-8000-000000000212',
    repeat('b', 64)
  );
  update active_company_service_fixture
  set scope_object_path = scope_reservation ->> 'objectPath';
end;
$$;

reset role;
select set_config('request.jwt.claims', '{}', true);

insert into storage.objects(bucket_id, name, metadata)
select
  'job-media',
  scope_object_path,
  '{"size":68,"mimetype":"image/png"}'::jsonb
from active_company_service_fixture;

update public.companies
set status = 'paused'
where id = '10000000-0000-4000-8000-000000000001';

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);

\echo '2/8 a paused service JWT cannot cross the scheduling provider-call boundary'
do $$
begin
  begin
    perform public.begin_storyops_calendar_booking_provider_call(
      (select scheduling_attempt_id from active_company_service_fixture)
    );
    raise exception 'Paused scheduling provider call unexpectedly began';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'STORYOPS_COMPANY_NOT_ACTIVE' then
        raise;
      end if;
  end;

  if not exists (
    select 1
    from public.scheduling_calendar_booking_attempts attempt
    join public.scheduling_reconciliation_cases reconciliation
      on reconciliation.calendar_attempt_id = attempt.id
    where attempt.id = (
        select scheduling_attempt_id from active_company_service_fixture
      )
      and attempt.status = 'prepared'
      and attempt.provider_call_started_at is null
      and attempt.last_error_code is null
      and reconciliation.status = 'pending'
      and reconciliation.last_error_code is null
  ) then
    raise exception 'Paused scheduling failure changed durable pre-provider evidence';
  end if;
end;
$$;

\echo '3/8 a paused pre-claimed post-service send cannot begin'
do $$
begin
  begin
    perform public.begin_storyops_post_service_submission(
      '36000000-0000-4000-8000-000000000131',
      '36000000-0000-4000-8000-000000000142',
      'twilio'
    );
    raise exception 'Paused post-service provider submission unexpectedly began';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'STORYOPS_COMPANY_NOT_ACTIVE' then
        raise;
      end if;
  end;

  if not exists (
    select 1
    from public.post_service_followups followup
    where followup.id = '36000000-0000-4000-8000-000000000131'
      and followup.status = 'queued'
      and followup.claim_operation = 'send'
      and followup.claim_token =
        '36000000-0000-4000-8000-000000000142'
      and followup.provider_mode is null
      and followup.provider_status is null
  ) or exists (
    select 1
    from public.audit_events event
    where event.entity_id = '36000000-0000-4000-8000-000000000131'
      and event.action = 'post_service.provider_submission_started'
  ) then
    raise exception 'Paused post-service start changed evidence or wrote a false audit';
  end if;
end;
$$;

\echo '4/8 submitted provider truth can reconcile while queued sends remain unclaimed'
do $$
declare
  reconciliation_claim jsonb;
  reconciliation_result jsonb;
  paused_claim jsonb;
begin
  reconciliation_claim := public.claim_storyops_post_service_followup(
    '10000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000151',
    90
  );
  if reconciliation_claim ->> 'operation' <> 'reconcile'
    or reconciliation_claim ->> 'followupId'
      <> '36000000-0000-4000-8000-000000000133'
  then
    raise exception 'Paused worker did not select submitted reconciliation: %',
      reconciliation_claim;
  end if;

  reconciliation_result := public.complete_storyops_post_service_followup(
    '36000000-0000-4000-8000-000000000133',
    (reconciliation_claim ->> 'claimToken')::uuid,
    jsonb_build_object(
      'provider', 'twilio',
      'providerId', 'SM_ACTIVE_GATE_RECONCILE_001',
      'mode', 'live',
      'status', 'delivered',
      'occurredAt', to_jsonb(date_trunc('milliseconds', now())::text),
      'idempotencyKey',
        'post-service:36000000-0000-4000-8000-000000000133'
    )
  );
  if reconciliation_result ->> 'status' <> 'completed'
    or reconciliation_result ->> 'externalDeliveryClaimed' <> 'true'
  then
    raise exception 'Paused submitted reconciliation failed: %',
      reconciliation_result;
  end if;

  paused_claim := public.claim_storyops_post_service_followup(
    '10000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000152',
    90
  );
  if paused_claim is not null then
    raise exception 'Paused worker claimed new queued work: %', paused_claim;
  end if;
  if not exists (
    select 1
    from public.post_service_followups followup
    where followup.id = '36000000-0000-4000-8000-000000000132'
      and followup.status = 'queued'
      and followup.claim_token is null
      and followup.attempt_count = 0
  ) then
    raise exception 'Paused queued follow-up was mutated or claimed';
  end if;
end;
$$;

\echo '5/8 AI Office cannot publish business output after pause'
do $$
declare
  result_payload jsonb;
  failure_receipt jsonb;
begin
  result_payload := jsonb_build_object(
    'traceId', '36000000-0000-4000-8000-000000000202',
    'runId', '36000000-0000-4000-8000-000000000201',
    'agent', 'owner_briefing',
    'modelProvider', 'sandbox-openai',
    'output', jsonb_build_object(
      'summary', 'This output must not persist after the company is paused.',
      'confidence', 0.5,
      'evidence', '[]'::jsonb,
      'unknowns', jsonb_build_array('The company paused during execution.'),
      'proposedActions', '[]'::jsonb,
      'ownerAttention', true
    ),
    'actions', '[]'::jsonb,
    'injectionSignals', '[]'::jsonb,
    'completedAt', to_jsonb(date_trunc('milliseconds', now())::text),
    'replayed', false
  );

  begin
    perform public.complete_storyops_ai_office_run(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '36000000-0000-4000-8000-000000000201',
      'owner_briefing',
      'sandbox',
      result_payload
    );
    raise exception 'Paused AI Office run unexpectedly published output';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'STORYOPS_COMPANY_NOT_ACTIVE' then
        raise;
      end if;
  end;

  if not exists (
    select 1
    from public.automation_runs run
    where run.id = '36000000-0000-4000-8000-000000000201'
      and run.status = 'running'
      and run.output is null
      and run.completed_at is null
  ) or exists (
    select 1
    from public.owner_briefings briefing
    where briefing.generated_by_run_id =
      '36000000-0000-4000-8000-000000000201'
  ) then
    raise exception 'Blocked AI completion persisted business output';
  end if;

  failure_receipt := public.fail_storyops_ai_office_run(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '36000000-0000-4000-8000-000000000201',
    'owner_briefing',
    'COMPANY_PAUSED',
    'The company paused before the authorized run could publish output.'
  );
  if failure_receipt ->> 'durableStatus' <> 'failed'
    or failure_receipt ->> 'errorCode' <> 'COMPANY_PAUSED'
  then
    raise exception 'Paused AI failure bookkeeping was not retained: %',
      failure_receipt;
  end if;
end;
$$;

\echo '6/8 scope-photo finalization cannot persist evidence after pause'
do $$
begin
  begin
    perform public.finalize_scope_photo_upload(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000104',
      (select scope_request_id from active_company_service_fixture),
      '36000000-0000-4000-8000-000000000212'
    );
    raise exception 'Paused scope-photo upload unexpectedly finalized';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'STORYOPS_COMPANY_NOT_ACTIVE' then
        raise;
      end if;
  end;

  if not exists (
    select 1
    from public.scope_photo_upload_reservations reservation
    where reservation.command_id =
      '36000000-0000-4000-8000-000000000212'
      and reservation.status = 'prepared'
      and reservation.finalized_at is null
  ) or exists (
    select 1
    from public.media_assets asset
    where asset.id = '36000000-0000-4000-8000-000000000211'
  ) or exists (
    select 1
    from public.scope_photo_submissions submission
    where submission.asset_id =
      '36000000-0000-4000-8000-000000000211'
  ) or exists (
    select 1
    from public.media_upload_attestations attestation
    where attestation.command_id =
      '36000000-0000-4000-8000-000000000212'
  ) then
    raise exception 'Blocked scope finalization persisted partial evidence';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '{}', true);
update public.scope_photo_upload_reservations
set
  created_at = now() - interval '2 hours',
  expires_at = now() - interval '1 second'
where command_id = '36000000-0000-4000-8000-000000000212';

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);

\echo '7/8 paused scope-photo orphan cleanup remains available'
do $$
declare
  cleanup_claim jsonb;
  cross_company_claim jsonb;
begin
  cross_company_claim := public.claim_scope_photo_orphans(
    '99000000-0000-4000-8000-000000000004',
    20
  );
  if cross_company_claim <> '[]'::jsonb then
    raise exception 'Scope cleanup crossed company scope: %',
      cross_company_claim;
  end if;
  cleanup_claim := public.claim_scope_photo_orphans(
    '10000000-0000-4000-8000-000000000001',
    20
  );
  if not exists (
    select 1
    from jsonb_array_elements(cleanup_claim) claimed
    where claimed ->> 'commandId' =
      '36000000-0000-4000-8000-000000000212'
      and claimed ->> 'objectPath' = (
        select scope_object_path from active_company_service_fixture
      )
  ) then
    raise exception 'Paused orphan cleanup did not claim the prepared object: %',
      cleanup_claim;
  end if;

  perform public.complete_scope_photo_orphan_cleanup(
    '36000000-0000-4000-8000-000000000212',
    true,
    null
  );
  if not exists (
    select 1
    from public.scope_photo_upload_reservations reservation
    where reservation.command_id =
      '36000000-0000-4000-8000-000000000212'
      and reservation.status = 'cleaned'
      and reservation.cleaned_at is not null
  ) then
    raise exception 'Paused scope-photo orphan cleanup was not recorded';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '{}', true);
update public.companies
set status = 'active'
where id = '10000000-0000-4000-8000-000000000001';

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);

\echo '8/8 reactivation resumes queued sends and permits the provider boundary'
do $$
declare
  resumed_claim jsonb;
  submission_receipt jsonb;
begin
  resumed_claim := public.claim_storyops_post_service_followup(
    '10000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000153',
    90
  );
  if resumed_claim ->> 'operation' <> 'send'
    or resumed_claim ->> 'followupId'
      <> '36000000-0000-4000-8000-000000000132'
  then
    raise exception 'Reactivated worker did not resume queued work: %',
      resumed_claim;
  end if;

  submission_receipt := public.begin_storyops_post_service_submission(
    '36000000-0000-4000-8000-000000000132',
    (resumed_claim ->> 'claimToken')::uuid,
    'twilio'
  );
  if submission_receipt ->> 'status' <> 'submitted_unknown'
    or submission_receipt ->> 'externalDeliveryClaimed' <> 'false'
  then
    raise exception 'Reactivated provider boundary did not begin safely: %',
      submission_receipt;
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '{}', true);
rollback;

\echo 'active company service-boundary integration passed: paused provider starts and business outputs fail atomically; reconciliation, failure truth, and orphan cleanup remain available; queued work resumes after reactivation'
