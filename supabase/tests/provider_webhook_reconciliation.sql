\set ON_ERROR_STOP on

-- Transactional trusted-provider reconciliation contract.
-- Run after `supabase db reset --local`:
-- docker exec -i supabase_db_storyops-ai psql -U postgres -d postgres \
--   < supabase/tests/provider_webhook_reconciliation.sql

begin;

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
  '+19725559201',
  'active',
  false
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
values
  (
    '95000000-0000-4000-8000-000000000211',
    '10000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000201',
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
    '95000000-0000-4000-8000-000000000201',
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
  receipt jsonb;
  event_id_value uuid;
  claim_status boolean;
  existing_status_value text;
  result jsonb;
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

  receipt := jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'twilio',
    'eventId', 'SMCONTRACTSTOP001:inbound_message',
    'eventType', 'inbound_message',
    'companyId', '10000000-0000-4000-8000-000000000001',
    'providerMessageId', 'SMCONTRACTSTOP001',
    'channel', 'sms',
    'disposition', 'ignored',
    'consentSignal', 'opt_out',
    'contactFingerprint', encode(
      extensions.digest('+19725559201', 'sha256'),
      'hex'
    ),
    'occurredAt', now()
  );
  select event_id, claimed, existing_status
  into event_id_value, claim_status, existing_status_value
  from public.claim_webhook_event(
    'twilio',
    'SMCONTRACTSTOP001:inbound_message',
    'inbound_message',
    repeat('a', 64),
    receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  if not claim_status
    or not public.start_webhook_processing(event_id_value, repeat('a', 64))
  then
    raise exception 'STOP event did not obtain its processing lease';
  end if;
  result := public.reconcile_provider_webhook(
    event_id_value,
    repeat('a', 64),
    '10000000-0000-4000-8000-000000000001',
    'twilio',
    receipt
  );
  if result ->> 'disposition' <> 'processed' then
    raise exception 'STOP event did not reconcile';
  end if;
  perform public.complete_webhook_event(
    event_id_value,
    repeat('a', 64),
    'processed'
  );

  select claimed, existing_status
  into claim_status, existing_status_value
  from public.claim_webhook_event(
    'twilio',
    'SMCONTRACTSTOP001:inbound_message',
    'inbound_message',
    repeat('a', 64),
    receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  if claim_status or existing_status_value <> 'processed' then
    raise exception 'STOP duplicate did not become a processed no-op';
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
    or authorization_decision.decision_code <> 'STALE_CONSENT'
    or authorization_decision.consent_record_id
      <> '95000000-0000-4000-8000-000000000211'
    or authorization_decision.latest_consent_record_id is null
    or authorization_decision.latest_consent_record_id
      = '95000000-0000-4000-8000-000000000211'
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
  ) <> 2 or (
    select count(*)
    from public.audit_events
    where request_id = event_id_value::text
      and actor_type = 'provider'
      and action = 'provider_webhook_reconciled'
  ) <> 1 then
    raise exception 'STOP did not atomically suppress, withdraw, and audit';
  end if;
end;
$$;

\echo '3/6 START records review-required unknown consent without restoring'
do $$
declare
  receipt jsonb;
  event_id_value uuid;
  result jsonb;
begin
  receipt := jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'twilio',
    'eventId', 'SMCONTRACTSTART001:inbound_message',
    'eventType', 'inbound_message',
    'companyId', '10000000-0000-4000-8000-000000000001',
    'providerMessageId', 'SMCONTRACTSTART001',
    'channel', 'sms',
    'disposition', 'ignored',
    'consentSignal', 'opt_in',
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
    'SMCONTRACTSTART001:inbound_message',
    'inbound_message',
    repeat('b', 64),
    receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  if not public.start_webhook_processing(event_id_value, repeat('b', 64)) then
    raise exception 'START event did not obtain its processing lease';
  end if;
  result := public.reconcile_provider_webhook(
    event_id_value,
    repeat('b', 64),
    '10000000-0000-4000-8000-000000000001',
    'twilio',
    receipt
  );
  perform public.complete_webhook_event(
    event_id_value,
    repeat('b', 64),
    result ->> 'disposition'
  );

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
      and status = 'unknown'
      and disclosure_version = 'sms-keyword-review-v1'
  ) <> 2 then
    raise exception 'START restored consent or failed to record required review';
  end if;
end;
$$;

\echo '4/6 missing contact fails closed without consent writes'
do $$
declare
  receipt jsonb;
  event_id_value uuid;
  blocked boolean := false;
begin
  receipt := jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'twilio',
    'eventId', 'SMCONTRACTUNKNOWN001:inbound_message',
    'eventType', 'inbound_message',
    'companyId', '10000000-0000-4000-8000-000000000001',
    'providerMessageId', 'SMCONTRACTUNKNOWN001',
    'channel', 'sms',
    'disposition', 'ignored',
    'consentSignal', 'opt_out',
    'contactFingerprint', encode(
      extensions.digest('+12145550888', 'sha256'),
      'hex'
    ),
    'occurredAt', now()
  );
  select event_id
  into event_id_value
  from public.claim_webhook_event(
    'twilio',
    'SMCONTRACTUNKNOWN001:inbound_message',
    'inbound_message',
    repeat('c', 64),
    receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  perform public.start_webhook_processing(event_id_value, repeat('c', 64));
  begin
    perform public.reconcile_provider_webhook(
      event_id_value,
      repeat('c', 64),
      '10000000-0000-4000-8000-000000000001',
      'twilio',
      receipt
    );
  exception
    when others then
      if position('exactly one company subject' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Unknown STOP subject was accepted';
  end if;
  perform public.fail_webhook_event(
    event_id_value,
    repeat('c', 64),
    'SUBJECT_NOT_FOUND'
  );
end;
$$;

\echo '5/6 delivery reconciles the exact communication record'
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
insert into public.payments(
  id,
  company_id,
  invoice_id,
  customer_id,
  provider,
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
  'pi_contract_payment_001',
  'invoice',
  'pending',
  132.00,
  'webhook-contract-payment-001'
);

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
    'quoteId', '10000000-0000-4000-8000-000000000521',
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
      if position('amount does not match' in sqlerrm) > 0 then
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
      if position('provider ID conflicts' in sqlerrm) > 0 then
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
