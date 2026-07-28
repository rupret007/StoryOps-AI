\set ON_ERROR_STOP on

-- Self-contained least-privilege live outbound authorization contract.
-- Safe against an empty migrated local database; all fixtures roll back.

begin;

\echo '1/4 service role receives RPC execute without tenant-table access'
do $$
declare
  table_name_value text;
begin
  foreach table_name_value in array array[
    'customers',
    'leads',
    'consent_records'
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

insert into public.companies(id, name)
values (
  '96000000-0000-4000-8000-000000000001',
  'Outbound authorization contract'
);

insert into public.customers(
  id,
  company_id,
  display_name,
  phone,
  lifecycle
)
values (
  '96000000-0000-4000-8000-000000000201',
  '96000000-0000-4000-8000-000000000001',
  'Consent contract customer',
  '+1 (972) 555-9201',
  'active'
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
    '96000000-0000-4000-8000-000000000211',
    '96000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000201',
    'sms',
    'transactional',
    'granted',
    now() - interval '1 day',
    'written',
    'contract-v1',
    'contract grant'
  ),
  (
    '96000000-0000-4000-8000-000000000212',
    '96000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000201',
    'sms',
    'marketing',
    'granted',
    now() - interval '1 day',
    'written',
    'contract-v1',
    'contract grant'
  );

\echo '2/4 active exact consent authorizes without returning contact data'
set local role service_role;
do $$
declare
  decision record;
  result_keys text[];
begin
  select *
  into decision
  from public.authorize_outbound_contact(
    '96000000-0000-4000-8000-000000000001',
    'sms',
    'transactional',
    encode(extensions.digest('+19725559201', 'sha256'), 'hex'),
    '96000000-0000-4000-8000-000000000211'
  );

  select array_agg(key order by key)
  into result_keys
  from jsonb_object_keys(to_jsonb(decision)) keys(key);
  if not decision.allowed
    or decision.decision_code <> 'ALLOWED'
    or decision.consent_record_id
      <> '96000000-0000-4000-8000-000000000211'
    or decision.latest_consent_record_id
      <> '96000000-0000-4000-8000-000000000211'
    or result_keys <> array[
      'allowed',
      'consent_record_id',
      'decision_code',
      'latest_consent_record_id'
    ]::text[]
  then
    raise exception 'Exact active consent was not authorized with bounded evidence';
  end if;
end;
$$;
reset role;

\echo '3/4 mismatched fingerprint and do-not-contact both fail closed'
do $$
declare
  decision record;
begin
  select *
  into decision
  from public.authorize_outbound_contact(
    '96000000-0000-4000-8000-000000000001',
    'sms',
    'transactional',
    encode(extensions.digest('+19725559202', 'sha256'), 'hex'),
    '96000000-0000-4000-8000-000000000211'
  );
  if decision.allowed or decision.decision_code <> 'CONTACT_MISMATCH' then
    raise exception 'Mismatched contact fingerprint was authorized';
  end if;

  update public.customers
  set do_not_contact = true, version = version + 1
  where id = '96000000-0000-4000-8000-000000000201';

  select *
  into decision
  from public.authorize_outbound_contact(
    '96000000-0000-4000-8000-000000000001',
    'sms',
    'transactional',
    encode(extensions.digest('+19725559201', 'sha256'), 'hex'),
    '96000000-0000-4000-8000-000000000211'
  );
  if decision.allowed or decision.decision_code <> 'OPTED_OUT' then
    raise exception 'Customer do-not-contact suppression was authorized';
  end if;

  update public.customers
  set do_not_contact = false, version = version + 1
  where id = '96000000-0000-4000-8000-000000000201';
end;
$$;

\echo '4/4 appended STOP withdrawal supersedes the prepared grant'
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
values
  (
    '96000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000201',
    'sms',
    'transactional',
    'withdrawn',
    now(),
    'keyword',
    'sms-keyword-v1',
    'provider=twilio;event=SMCONTRACTSTOP;contact_sha256=redacted',
    now()
  ),
  (
    '96000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000201',
    'sms',
    'marketing',
    'withdrawn',
    now(),
    'keyword',
    'sms-keyword-v1',
    'provider=twilio;event=SMCONTRACTSTOP;contact_sha256=redacted',
    now()
  );

do $$
declare
  decision record;
begin
  select *
  into decision
  from public.authorize_outbound_contact(
    '96000000-0000-4000-8000-000000000001',
    'sms',
    'transactional',
    encode(extensions.digest('+19725559201', 'sha256'), 'hex'),
    '96000000-0000-4000-8000-000000000211'
  );
  if decision.allowed
    or decision.decision_code <> 'STALE_CONSENT'
    or decision.consent_record_id
      <> '96000000-0000-4000-8000-000000000211'
    or decision.latest_consent_record_id is null
    or decision.latest_consent_record_id
      = '96000000-0000-4000-8000-000000000211'
  then
    raise exception 'STOP withdrawal did not supersede the prepared consent';
  end if;
end;
$$;

rollback;

\echo 'outbound authorization contract: PASS'
