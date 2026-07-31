\set ON_ERROR_STOP on

-- Transactional trusted-provider reconciliation contract.
-- Run after `supabase db reset --local`:
-- docker exec -i supabase_db_storyops-ai psql -U postgres -d postgres \
--   < supabase/tests/provider_webhook_reconciliation.sql

begin;

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000104',
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);

create function pg_temp.storyops_sms_intake(
  p_sid text,
  p_phone text,
  p_body text,
  p_signal text
)
returns jsonb
language sql
volatile
as $$
  select jsonb_build_object(
    'schemaVersion', 'storyops-lead-intake-v2',
    'provider', 'twilio',
    'providerEventId', p_sid || ':inbound_message',
    'eventType', 'inbound_message',
    'source', 'sms',
    'occurredAt', now(),
    'displayName', p_phone,
    'email', null,
    'phone', p_phone,
    'requestedServices', jsonb_build_array(),
    'preferredContactChannel', 'sms',
    'consentSignal', p_signal,
    'communication', jsonb_build_object(
      'channel', 'sms',
      'sender', p_phone,
      'recipients', jsonb_build_array('+19725559999'),
      'body', p_body,
      'subject', null,
      'providerMessageId', 'twilio:' || p_sid || ':inbound_message'
    ),
    'consent', jsonb_build_array(
      jsonb_build_object(
        'id', gen_random_uuid(),
        'channel', 'sms',
        'purpose', 'transactional',
        'status', case when p_signal = 'opt_out' then 'withdrawn' else 'unknown' end,
        'captureMethod', 'keyword',
        'disclosureVersion', 'edge-normalized-v1',
        'proof', 'edge-normalized'
      ),
      jsonb_build_object(
        'id', gen_random_uuid(),
        'channel', 'sms',
        'purpose', 'marketing',
        'status', case when p_signal = 'opt_out' then 'withdrawn' else 'unknown' end,
        'captureMethod', 'keyword',
        'disclosureVersion', 'edge-normalized-v1',
        'proof', 'edge-normalized'
      )
    ),
    'ids', jsonb_build_object(
      'leadId', gen_random_uuid(),
      'threadId', gen_random_uuid(),
      'messageId', gen_random_uuid()
    )
  );
$$;

\echo '1/6 reconciliation is RPC-only'
do $$
declare
  table_name_value text;
begin
  foreach table_name_value in array array[
    'customers',
    'leads',
    'consent_records',
    'communication_messages',
    'invoices',
    'payments',
    'approval_requests',
    'audit_events',
    'webhook_events'
  ]::text[]
  loop
    if has_table_privilege(
      'service_role',
      format('public.%I', table_name_value),
      'SELECT'
    ) or has_table_privilege(
      'service_role',
      format('public.%I', table_name_value),
      'INSERT'
    ) or has_table_privilege(
      'service_role',
      format('public.%I', table_name_value),
      'UPDATE'
    ) or has_table_privilege(
      'service_role',
      format('public.%I', table_name_value),
      'DELETE'
    ) then
      raise exception 'Service role unexpectedly has direct DML on %', table_name_value;
    end if;
  end loop;
  if not has_function_privilege(
    'service_role',
    'public.reconcile_provider_webhook(uuid,text,uuid,text,jsonb)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.reconcile_provider_webhook(uuid,text,uuid,text,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Provider reconciliation RPC privilege boundary is invalid';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.persist_storyops_lead_intake(uuid,text,uuid,uuid,jsonb)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.persist_storyops_lead_intake(uuid,text,uuid,uuid,jsonb)',
    'EXECUTE'
  ) or has_function_privilege(
    'service_role',
    'public.reconcile_provider_webhook_before_intake_guard(uuid,text,uuid,text,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Lead-intake RPC privilege boundary is invalid';
  end if;
  if has_table_privilege(
    'service_role',
    'public.contact_suppressions',
    'SELECT,INSERT,UPDATE,DELETE'
  ) or not has_function_privilege(
    'service_role',
    'public.start_storyops_intake_processing(uuid,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.start_storyops_intake_processing(uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'Contact suppression or intake lease privilege boundary is invalid';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.authorize_outbound_contact(uuid,text,text,text,uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.authorize_outbound_contact(uuid,text,text,text,uuid)',
    'EXECUTE'
  ) then
    raise exception 'Outbound authorization RPC privilege boundary is invalid';
  end if;
end;
$$;

\echo '2/6 signed-boundary STOP plan appends withdrawal and suppresses'
insert into public.customers(
  id,
  company_id,
  kind,
  display_name,
  phone,
  lifecycle,
  do_not_contact
)
values (
  '95000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000001',
  'individual',
  'Webhook Contract Customer',
  '+19725559000',
  'active',
  false
);

insert into public.leads(
  id,
  company_id,
  source,
  status,
  display_name,
  phone,
  customer_id
)
values (
  '95000000-0000-4000-8000-000000000202',
  '10000000-0000-4000-8000-000000000001',
  'sms',
  'converted',
  'Converted alias for webhook customer',
  '+19725559201',
  '95000000-0000-4000-8000-000000000201'
);

insert into public.consent_records(
  id,
  company_id,
  lead_id,
  channel,
  purpose,
  status,
  captured_at,
  capture_method,
  disclosure_version,
  proof
)
values
  (
    '95000000-0000-4000-8000-000000000211',
    '10000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000202',
    'sms',
    'transactional',
    'granted',
    now() - interval '1 day',
    'written',
    'test-v1',
    'pre-stop-test-proof'
  ),
  (
    '95000000-0000-4000-8000-000000000212',
    '10000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000202',
    'sms',
    'marketing',
    'granted',
    now() - interval '1 day',
    'written',
    'test-v1',
    'pre-stop-test-proof'
  );

do $$
declare
  intake jsonb;
  claim_receipt jsonb;
  event_id_value uuid;
  claim_status boolean;
  existing_status_value text;
  processing_lease_id uuid;
  result jsonb;
  replay_result jsonb;
  authorization_decision record;
begin
  select *
  into authorization_decision
  from public.authorize_outbound_contact(
    '10000000-0000-4000-8000-000000000001',
    'sms',
    'transactional',
    encode(extensions.digest('+19725559201', 'sha256'), 'hex'),
    '95000000-0000-4000-8000-000000000211'
  );
  if not authorization_decision.allowed
    or authorization_decision.decision_code <> 'ALLOWED'
    or authorization_decision.consent_record_id
      <> '95000000-0000-4000-8000-000000000211'
    or authorization_decision.latest_consent_record_id
      <> '95000000-0000-4000-8000-000000000211'
  then
    raise exception 'Active exact consent was not authorized';
  end if;

  intake := pg_temp.storyops_sms_intake(
    'SMCONTRACTSTOP001',
    '+19725559201',
    'STOP',
    'opt_out'
  );
  claim_receipt := jsonb_build_object(
    'schemaVersion', 'storyops-intake-claim-v1',
    'source', 'sms',
    'consentSignal', 'opt_out'
  );
  select event_id, claimed, existing_status
  into event_id_value, claim_status, existing_status_value
  from public.claim_webhook_event(
    'twilio',
    'SMCONTRACTSTOP001:inbound_message',
    'inbound_message',
    repeat('a', 64),
    claim_receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  processing_lease_id := public.start_storyops_intake_processing(
    event_id_value,
    repeat('a', 64)
  );
  if not claim_status or processing_lease_id is null then
    raise exception 'STOP event did not obtain its processing lease';
  end if;
  result := public.persist_storyops_lead_intake(
    event_id_value,
    repeat('a', 64),
    '10000000-0000-4000-8000-000000000001',
    processing_lease_id,
    intake
  );
  if result ->> 'subjectType' <> 'customer'
    or result ->> 'customerId' <> '95000000-0000-4000-8000-000000000201'
    or result -> 'leadId' <> 'null'::jsonb
    or result ->> 'consentSignal' <> 'opt_out'
  then
    raise exception 'STOP did not collapse the converted lead into its customer';
  end if;
  perform public.complete_storyops_intake_webhook(
    event_id_value,
    repeat('a', 64),
    processing_lease_id,
    'processed'
  );

  select claimed, existing_status
  into claim_status, existing_status_value
  from public.claim_webhook_event(
    'twilio',
    'SMCONTRACTSTOP001:inbound_message',
    'inbound_message',
    repeat('a', 64),
    claim_receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  if claim_status or existing_status_value <> 'processed' then
    raise exception 'STOP duplicate did not become a processed no-op';
  end if;
  replay_result := public.load_storyops_lead_intake_receipt(
    event_id_value,
    repeat('a', 64),
    '10000000-0000-4000-8000-000000000001'
  );
  if replay_result is distinct from result then
    raise exception 'STOP replay did not return its exact durable receipt';
  end if;

  select *
  into authorization_decision
  from public.authorize_outbound_contact(
    '10000000-0000-4000-8000-000000000001',
    'sms',
    'transactional',
    encode(extensions.digest('+19725559201', 'sha256'), 'hex'),
    '95000000-0000-4000-8000-000000000211'
  );
  if authorization_decision.allowed
    or authorization_decision.decision_code <> 'OPTED_OUT'
    or authorization_decision.consent_record_id
      <> '95000000-0000-4000-8000-000000000211'
    or authorization_decision.latest_consent_record_id is not null
  then
    raise exception 'STOP did not block the prior outbound consent snapshot';
  end if;

  if not exists (
    select 1
    from public.customers
    where id = '95000000-0000-4000-8000-000000000201'
      and do_not_contact
      and version = 2
  ) or (
    select count(*)
    from public.consent_records
    where customer_id = '95000000-0000-4000-8000-000000000201'
      and channel = 'sms'
      and status = 'withdrawn'
      and capture_method = 'keyword'
  ) <> 2 or not exists (
    select 1
    from public.contact_suppressions
    where company_id = '10000000-0000-4000-8000-000000000001'
      and channel = 'sms'
      and contact_fingerprint = encode(
        extensions.digest('+19725559201', 'sha256'),
        'hex'
      )
      and status = 'active'
  ) or (
    select count(*)
    from public.audit_events
    where request_id = event_id_value::text
      and actor_type = 'provider'
      and action = 'lead_intake_persisted'
  ) <> 1 then
    raise exception 'STOP did not atomically suppress, withdraw, and audit';
  end if;
end;
$$;

\echo '3/6 START records review-required unknown consent without restoring'
do $$
declare
  intake jsonb;
  claim_receipt jsonb;
  event_id_value uuid;
  processing_lease_id uuid;
  result jsonb;
begin
  intake := pg_temp.storyops_sms_intake(
    'SMCONTRACTSTART001',
    '+19725559201',
    'START',
    'opt_in'
  );
  claim_receipt := jsonb_build_object(
    'schemaVersion', 'storyops-intake-claim-v1',
    'source', 'sms',
    'consentSignal', 'opt_in'
  );
  select event_id
  into event_id_value
  from public.claim_webhook_event(
    'twilio',
    'SMCONTRACTSTART001:inbound_message',
    'inbound_message',
    repeat('b', 64),
    claim_receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  processing_lease_id := public.start_storyops_intake_processing(
    event_id_value,
    repeat('b', 64)
  );
  if processing_lease_id is null then
    raise exception 'START event did not obtain its processing lease';
  end if;
  result := public.persist_storyops_lead_intake(
    event_id_value,
    repeat('b', 64),
    '10000000-0000-4000-8000-000000000001',
    processing_lease_id,
    intake
  );
  perform public.complete_storyops_intake_webhook(
    event_id_value,
    repeat('b', 64),
    processing_lease_id,
    'processed'
  );

  if result ->> 'subjectType' <> 'customer'
    or result ->> 'consentSignal' <> 'opt_in'
    or not exists (
    select 1
    from public.customers
    where id = '95000000-0000-4000-8000-000000000201'
      and do_not_contact
      and version = 2
  ) or (
    select count(*)
    from public.consent_records
    where customer_id = '95000000-0000-4000-8000-000000000201'
      and channel = 'sms'
      and status = 'unknown'
      and disclosure_version = 'sms-keyword-review-v1'
  ) <> 2 then
    raise exception 'START restored consent or failed to record required review';
  end if;
end;
$$;

\echo '4/6 missing, ambiguous, and legacy keyword paths fail closed'
do $$
declare
  intake jsonb;
  claim_receipt jsonb;
  legacy_receipt jsonb;
  event_id_value uuid;
  processing_lease_id uuid;
  stale_processing_lease_id uuid;
  result jsonb;
  legacy_blocked boolean := false;
  stale_completion_blocked boolean := false;
  authorization_decision record;
begin
  intake := pg_temp.storyops_sms_intake(
    'SMCONTRACTUNKNOWN001',
    '+12145550888',
    'STOP',
    'opt_out'
  );
  claim_receipt := jsonb_build_object(
    'schemaVersion', 'storyops-intake-claim-v1',
    'source', 'sms',
    'consentSignal', 'opt_out'
  );
  select event_id
  into event_id_value
  from public.claim_webhook_event(
    'twilio',
    'SMCONTRACTUNKNOWN001:inbound_message',
    'inbound_message',
    repeat('c', 64),
    claim_receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  processing_lease_id := public.start_storyops_intake_processing(
    event_id_value,
    repeat('c', 64)
  );
  result := public.persist_storyops_lead_intake(
    event_id_value,
    repeat('c', 64),
    '10000000-0000-4000-8000-000000000001',
    processing_lease_id,
    intake
  );
  if result ->> 'resolutionStatus' <> 'not_found'
    or (result ->> 'contactSuppressed')::boolean is not true
    or exists (
      select 1
      from public.leads
      where company_id = '10000000-0000-4000-8000-000000000001'
        and phone = '+12145550888'
    )
  then
    raise exception 'Unknown STOP was not suppressed and quarantined';
  end if;
  perform public.fail_storyops_intake_webhook(
    event_id_value,
    repeat('c', 64),
    processing_lease_id,
    'SUBJECT_NOT_FOUND'
  );

  insert into public.customers(
    id,
    company_id,
    kind,
    display_name,
    phone,
    lifecycle,
    do_not_contact
  )
  values (
    '95000000-0000-4000-8000-000000000204',
    '10000000-0000-4000-8000-000000000001',
    'individual',
    'Ambiguous customer',
    '+19725559204',
    'active',
    false
  );
  insert into public.leads(
    id,
    company_id,
    source,
    status,
    display_name,
    phone
  )
  values (
    '95000000-0000-4000-8000-000000000205',
    '10000000-0000-4000-8000-000000000001',
    'sms',
    'new',
    'Unrelated duplicate subject',
    '+19725559204'
  );
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
    proof
  )
  values (
    '95000000-0000-4000-8000-000000000213',
    '10000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000204',
    'sms',
    'transactional',
    'granted',
    now() - interval '1 day',
    'written',
    'test-v1',
    'ambiguous-pre-stop-proof'
  );
  select *
  into authorization_decision
  from public.authorize_outbound_contact(
    '10000000-0000-4000-8000-000000000001',
    'sms',
    'transactional',
    encode(extensions.digest('+19725559204', 'sha256'), 'hex'),
    '95000000-0000-4000-8000-000000000213'
  );
  if not authorization_decision.allowed then
    raise exception 'Ambiguous fixture did not begin with an active grant';
  end if;

  intake := pg_temp.storyops_sms_intake(
    'SMCONTRACTAMBIGUOUS001',
    '+19725559204',
    'STOP',
    'opt_out'
  );
  claim_receipt := jsonb_build_object(
    'schemaVersion', 'storyops-intake-claim-v1',
    'source', 'sms',
    'consentSignal', 'opt_out'
  );
  select event_id
  into event_id_value
  from public.claim_webhook_event(
    'twilio',
    'SMCONTRACTAMBIGUOUS001:inbound_message',
    'inbound_message',
    repeat('e', 64),
    claim_receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  processing_lease_id := public.start_storyops_intake_processing(
    event_id_value,
    repeat('e', 64)
  );
  result := public.persist_storyops_lead_intake(
    event_id_value,
    repeat('e', 64),
    '10000000-0000-4000-8000-000000000001',
    processing_lease_id,
    intake
  );
  if result ->> 'resolutionStatus' <> 'ambiguous'
    or (result ->> 'contactSuppressed')::boolean is not true
    or (result ->> 'customerCandidateCount')::integer <> 1
    or (result ->> 'leadCandidateCount')::integer <> 1
  then
    raise exception 'Ambiguous STOP did not return its fail-closed quarantine receipt';
  end if;
  perform public.fail_storyops_intake_webhook(
    event_id_value,
    repeat('e', 64),
    processing_lease_id,
    'SUBJECT_AMBIGUOUS'
  );
  select *
  into authorization_decision
  from public.authorize_outbound_contact(
    '10000000-0000-4000-8000-000000000001',
    'sms',
    'transactional',
    encode(extensions.digest('+19725559204', 'sha256'), 'hex'),
    '95000000-0000-4000-8000-000000000213'
  );
  if authorization_decision.allowed
    or authorization_decision.decision_code <> 'OPTED_OUT'
    or not exists (
      select 1
      from public.customers
      where id = '95000000-0000-4000-8000-000000000204'
        and do_not_contact
    )
  then
    raise exception 'Ambiguous STOP left an existing grant usable';
  end if;

  select event_id
  into event_id_value
  from public.claim_webhook_event(
    'twilio',
    'SMCONTRACTLEASE001:inbound_message',
    'inbound_message',
    repeat('2', 64),
    claim_receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  stale_processing_lease_id := public.start_storyops_intake_processing(
    event_id_value,
    repeat('2', 64)
  );
  if stale_processing_lease_id is null
    or public.start_storyops_intake_processing(event_id_value, repeat('2', 64)) is not null
  then
    raise exception 'Current intake processing lease was not exclusive';
  end if;
  update public.webhook_events
  set intake_processing_started_at = now() - interval '6 minutes'
  where id = event_id_value;
  processing_lease_id := public.start_storyops_intake_processing(
    event_id_value,
    repeat('2', 64)
  );
  if processing_lease_id is null
    or processing_lease_id = stale_processing_lease_id
  then
    raise exception 'Crashed intake processing lease was not reclaimed';
  end if;
  begin
    perform public.complete_storyops_intake_webhook(
      event_id_value,
      repeat('2', 64),
      stale_processing_lease_id,
      'processed'
    );
  exception
    when others then
      if position('INTAKE_PROCESSING_LEASE_REQUIRED' in sqlerrm) > 0 then
        stale_completion_blocked := true;
      else
        raise;
      end if;
  end;
  if not stale_completion_blocked then
    raise exception 'Stale intake lease completed after reclaim';
  end if;
  perform public.fail_storyops_intake_webhook(
    event_id_value,
    repeat('2', 64),
    processing_lease_id,
    'LEASE_RECOVERY_TEST'
  );

  legacy_receipt := jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'twilio',
    'eventId', 'SMCONTRACTLEGACY001:inbound_message',
    'eventType', 'inbound_message',
    'companyId', '10000000-0000-4000-8000-000000000001',
    'providerMessageId', 'SMCONTRACTLEGACY001',
    'channel', 'sms',
    'disposition', 'ignored',
    'consentSignal', 'opt_out',
    'contactFingerprint', encode(
      extensions.digest('+19725559201', 'sha256'),
      'hex'
    ),
    'occurredAt', now()
  );
  select event_id
  into event_id_value
  from public.claim_webhook_event(
    'twilio',
    'SMCONTRACTLEGACY001:inbound_message',
    'inbound_message',
    repeat('f', 64),
    legacy_receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  processing_lease_id := public.start_storyops_intake_processing(
    event_id_value,
    repeat('f', 64)
  );
  begin
    perform public.reconcile_provider_webhook(
      event_id_value,
      repeat('f', 64),
      '10000000-0000-4000-8000-000000000001',
      'twilio',
      legacy_receipt
    );
  exception
    when others then
      if position('TWILIO_INBOUND_REQUIRES_LEAD_INTAKE' in sqlerrm) > 0 then
        legacy_blocked := true;
      else
        raise;
      end if;
  end;
  if not legacy_blocked then
    raise exception 'Legacy provider-reconciliation keyword path remained active';
  end if;
  perform public.fail_storyops_intake_webhook(
    event_id_value,
    repeat('f', 64),
    processing_lease_id,
    'WRONG_INGRESS_PATH'
  );

  if (
    select count(*)
    from public.consent_records
    where customer_id = '95000000-0000-4000-8000-000000000201'
  ) <> 4 or (
    select count(*)
    from public.consent_records
    where lead_id = '95000000-0000-4000-8000-000000000202'
  ) <> 2 or exists (
    select 1
    from public.consent_records
    where lead_id = '95000000-0000-4000-8000-000000000205'
  ) then
    raise exception 'Failed consent events produced a partial mutation';
  end if;
end;
$$;

\echo '5/6 delivery reconciles the exact communication record'
select set_config('request.jwt.claims', '{}'::text, true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
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
  sent_by_agent,
  sent_at
)
values (
  '95000000-0000-4000-8000-000000000301',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000701',
  'sms',
  'outbound',
  'test',
  array['test'],
  'transactional test',
  'SMCONTRACTDELIVERY001',
  'queued',
  'test',
  now()
);

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000104',
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  receipt jsonb;
  event_id_value uuid;
  result jsonb;
begin
  receipt := jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'twilio',
    'eventId', 'SMCONTRACTDELIVERY001:delivered',
    'eventType', 'delivered',
    'companyId', '10000000-0000-4000-8000-000000000001',
    'providerMessageId', 'SMCONTRACTDELIVERY001',
    'channel', 'sms',
    'disposition', 'delivery_update',
    'deliveryStatus', 'delivered',
    'consentSignal', 'none',
    'occurredAt', now()
  );
  select event_id
  into event_id_value
  from public.claim_webhook_event(
    'twilio',
    'SMCONTRACTDELIVERY001:delivered',
    'delivered',
    repeat('d', 64),
    receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  perform public.start_webhook_processing(event_id_value, repeat('d', 64));
  result := public.reconcile_provider_webhook(
    event_id_value,
    repeat('d', 64),
    '10000000-0000-4000-8000-000000000001',
    'twilio',
    receipt
  );
  perform public.complete_webhook_event(
    event_id_value,
    repeat('d', 64),
    result ->> 'disposition'
  );
  if not exists (
    select 1
    from public.communication_messages
    where id = '95000000-0000-4000-8000-000000000301'
      and delivery_status = 'delivered'
      and version = 2
  ) then
    raise exception 'Twilio delivery did not reconcile';
  end if;
end;
$$;

\echo '6/6 Stripe money reconciliation is exact and mismatch-safe'
select set_config('request.jwt.claims', '{}'::text, true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
insert into public.payments(
  id,
  company_id,
  invoice_id,
  customer_id,
  provider,
  provider_checkout_id,
  provider_payment_id,
  payment_type,
  status,
  amount,
  idempotency_key
)
values (
  '95000000-0000-4000-8000-000000000402',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000651',
  '10000000-0000-4000-8000-000000000201',
  'stripe',
  'cs_contract_payment_001',
  'pi_contract_payment_001',
  'invoice',
  'pending',
  132.00,
  'storyops:invoice-balance:10000000-0000-4000-8000-000000000651:v'
    || (
      select version::text
      from public.invoices
      where id = '10000000-0000-4000-8000-000000000651'
    )
    || ':13200'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000104',
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  receipt jsonb;
  mismatch_receipt jsonb;
  conflict_receipt jsonb;
  event_id_value uuid;
  mismatch_event_id uuid;
  conflict_event_id uuid;
  result jsonb;
  mismatch_blocked boolean := false;
  conflict_blocked boolean := false;
begin
  receipt := jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'stripe',
    'eventId', 'evt_contract_payment_001',
    'eventType', 'payment_intent.succeeded',
    'companyId', '10000000-0000-4000-8000-000000000001',
    'objectId', 'pi_contract_payment_001',
    'objectKind', 'payment_intent',
    'action', 'payment_succeeded',
    'checkoutPurpose', 'invoice_balance',
    'checkoutAttempt', 1,
    'quoteId', '10000000-0000-4000-8000-000000000521',
    'invoiceId', '10000000-0000-4000-8000-000000000651',
    'invoiceVersion', (
      select version
      from public.invoices
      where id = '10000000-0000-4000-8000-000000000651'
    ),
    'amountCents', 13200,
    'currency', 'usd',
    'occurredAt', now()
  );
  select event_id
  into event_id_value
  from public.claim_webhook_event(
    'stripe',
    'evt_contract_payment_001',
    'payment_intent.succeeded',
    repeat('e', 64),
    receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  perform public.start_webhook_processing(event_id_value, repeat('e', 64));
  result := public.reconcile_provider_webhook(
    event_id_value,
    repeat('e', 64),
    '10000000-0000-4000-8000-000000000001',
    'stripe',
    receipt
  );
  perform public.complete_webhook_event(
    event_id_value,
    repeat('e', 64),
    result ->> 'disposition'
  );

  if not exists (
    select 1
    from public.payments
    where id = '95000000-0000-4000-8000-000000000402'
      and status = 'succeeded'
      and provider_payment_id = 'pi_contract_payment_001'
      and processed_at is not null
      and version = 2
  ) then
    raise exception 'Stripe payment success did not reconcile';
  end if;

  mismatch_receipt := receipt || jsonb_build_object(
    'eventId', 'evt_contract_payment_mismatch_001',
    'amountCents', 13199
  );
  select event_id
  into mismatch_event_id
  from public.claim_webhook_event(
    'stripe',
    'evt_contract_payment_mismatch_001',
    'payment_intent.succeeded',
    repeat('f', 64),
    mismatch_receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  perform public.start_webhook_processing(mismatch_event_id, repeat('f', 64));
  begin
    perform public.reconcile_provider_webhook(
      mismatch_event_id,
      repeat('f', 64),
      '10000000-0000-4000-8000-000000000001',
      'stripe',
      mismatch_receipt
    );
  exception
    when others then
      if position('amount does not match' in sqlerrm) > 0
        or sqlerrm = 'STRIPE_PAYMENT_REPLAY_CONFLICT'
      then
        mismatch_blocked := true;
      else
        raise;
      end if;
  end;
  if not mismatch_blocked then
    raise exception 'Stripe amount mismatch was accepted';
  end if;
  perform public.fail_webhook_event(
    mismatch_event_id,
    repeat('f', 64),
    'AMOUNT_MISMATCH'
  );

  conflict_receipt := receipt || jsonb_build_object(
    'eventId', 'evt_contract_payment_conflict_001',
    'objectId', 'pi_contract_payment_reused_wrong',
    'paymentIntentId', 'pi_contract_payment_001'
  );
  select event_id
  into conflict_event_id
  from public.claim_webhook_event(
    'stripe',
    'evt_contract_payment_conflict_001',
    'payment_intent.succeeded',
    repeat('1', 64),
    conflict_receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  perform public.start_webhook_processing(conflict_event_id, repeat('1', 64));
  begin
    perform public.reconcile_provider_webhook(
      conflict_event_id,
      repeat('1', 64),
      '10000000-0000-4000-8000-000000000001',
      'stripe',
      conflict_receipt
    );
  exception
    when others then
      if position('provider ID conflicts' in sqlerrm) > 0
        or sqlerrm = 'STRIPE_PAYMENT_INTENT_CONFLICT'
      then
        conflict_blocked := true;
      else
        raise;
      end if;
  end;
  if not conflict_blocked then
    raise exception 'Stripe provider ID conflict was accepted';
  end if;
  perform public.fail_webhook_event(
    conflict_event_id,
    repeat('1', 64),
    'PROVIDER_ID_CONFLICT'
  );

  if not exists (
    select 1
    from public.payments
    where id = '95000000-0000-4000-8000-000000000402'
      and status = 'succeeded'
      and version = 2
  ) or exists (
    select 1
    from public.audit_events
    where request_id = mismatch_event_id::text
      and actor_type = 'provider'
      and action = 'provider_webhook_reconciled'
  ) or exists (
    select 1
    from public.audit_events
    where request_id = conflict_event_id::text
      and actor_type = 'provider'
      and action = 'provider_webhook_reconciled'
  ) then
    raise exception 'Stripe conflict changed money state or created a success audit';
  end if;
end;
$$;

rollback;

\echo 'provider webhook reconciliation contract: PASS'
