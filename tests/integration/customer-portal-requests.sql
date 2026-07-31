\set ON_ERROR_STOP on

begin;

\echo '1/9 customer portal state requires an authenticated customer membership'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_customer_portal_state(
      '10000000-0000-4000-8000-000000000001'
    );
  exception
    when others then
      if position('CUSTOMER_DEPOSIT_SCOPE_DENIED' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Unauthenticated customer portal state was exposed';
  end if;
end;
$$;

create temporary table portal_visit_before as
select to_jsonb(visit) as snapshot
from public.visits visit
where visit.id = '10000000-0000-4000-8000-000000000641';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000104',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);
select set_config('request.headers', '{}', true);

\echo '2/9 projection is limited to the authenticated customer mapping'
do $$
declare
  portal_state jsonb;
begin
  portal_state := public.get_customer_portal_state(
    '10000000-0000-4000-8000-000000000001'
  );
  if portal_state ->> 'companyId'
      <> '10000000-0000-4000-8000-000000000001'
    or jsonb_array_length(portal_state -> 'customers') <> 1
    or portal_state #>> '{customers,0,customerId}'
      <> '10000000-0000-4000-8000-000000000201'
    or jsonb_array_length(
      portal_state #> '{customers,0,serviceOptions}'
    ) < 1
  then
    raise exception 'Customer portal projection escaped or omitted its mapped scope: %', portal_state;
  end if;
end;
$$;

\echo '3/9 reschedule is an idempotent request and never changes the visit'
do $$
declare
  canonical_request text;
  request_hash text;
  receipt jsonb;
  replay jsonb;
  request_count integer;
begin
  canonical_request := jsonb_build_object(
    'commandType', 'portal.reschedule.request',
    'payload', jsonb_build_object(
      'customerId', '10000000-0000-4000-8000-000000000201'::uuid,
      'preferredEndDate', current_date + 4,
      'preferredStartDate', current_date + 3,
      'propertyId', '10000000-0000-4000-8000-000000000211'::uuid,
      'requestNotes', 'Weekday mornings are preferred.',
      'requestType', 'reschedule',
      'requestedServiceCodes', '[]'::jsonb,
      'visitId', '10000000-0000-4000-8000-000000000641'::uuid
    )
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );

  receipt := public.submit_customer_portal_request(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    '17000000-0000-4000-8000-000000000001',
    'portal.reschedule.request',
    canonical_request,
    request_hash,
    'reschedule',
    '10000000-0000-4000-8000-000000000641',
    '10000000-0000-4000-8000-000000000211',
    current_date + 3,
    current_date + 4,
    array[]::text[],
    'Weekday mornings are preferred.'
  );
  replay := public.submit_customer_portal_request(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    '17000000-0000-4000-8000-000000000001',
    'portal.reschedule.request',
    canonical_request,
    request_hash,
    'reschedule',
    '10000000-0000-4000-8000-000000000641',
    '10000000-0000-4000-8000-000000000211',
    current_date + 3,
    current_date + 4,
    array[]::text[],
    'Weekday mornings are preferred.'
  );

  select count(*)
  into request_count
  from public.customer_portal_requests request
  where request.command_id = '17000000-0000-4000-8000-000000000001';

  if receipt ->> 'requestId' is null
    or (receipt ->> 'visitChanged')::boolean
    or (receipt ->> 'replayed')::boolean
    or replay ->> 'requestId' <> receipt ->> 'requestId'
    or not (replay ->> 'replayed')::boolean
    or request_count <> 1
  then
    raise exception 'Reschedule request mutated state or replayed unsafely: %, %', receipt, replay;
  end if;
end;
$$;

reset role;
do $$
declare
  visit_after jsonb;
begin
  select to_jsonb(visit)
  into visit_after
  from public.visits visit
  where visit.id = '10000000-0000-4000-8000-000000000641';
  if visit_after <> (select snapshot from portal_visit_before) then
    raise exception 'Reschedule request changed the visit row';
  end if;
end;
$$;
set local role authenticated;

\echo '4/9 a reused command ID with changed request content conflicts'
do $$
declare
  canonical_request text;
  request_hash text;
  blocked boolean := false;
begin
  canonical_request := jsonb_build_object(
    'commandType', 'portal.reschedule.request',
    'payload', jsonb_build_object(
      'customerId', '10000000-0000-4000-8000-000000000201'::uuid,
      'preferredEndDate', current_date + 5,
      'preferredStartDate', current_date + 3,
      'propertyId', '10000000-0000-4000-8000-000000000211'::uuid,
      'requestNotes', 'Changed content under the same command.',
      'requestType', 'reschedule',
      'requestedServiceCodes', '[]'::jsonb,
      'visitId', '10000000-0000-4000-8000-000000000641'::uuid
    )
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  begin
    perform public.submit_customer_portal_request(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000201',
      '17000000-0000-4000-8000-000000000001',
      'portal.reschedule.request',
      canonical_request,
      request_hash,
      'reschedule',
      '10000000-0000-4000-8000-000000000641',
      '10000000-0000-4000-8000-000000000211',
      current_date + 3,
      current_date + 5,
      array[]::text[],
      'Changed content under the same command.'
    );
  exception
    when others then
      if position('CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Changed content reused an existing customer command ID';
  end if;
end;
$$;

\echo '5/9 additional-service requests normalize into one linked lead'
do $$
declare
  canonical_request text;
  request_hash text;
  receipt jsonb;
  replay jsonb;
begin
  canonical_request := jsonb_build_object(
    'commandType', 'portal.additional_service.request',
    'payload', jsonb_build_object(
      'customerId', '10000000-0000-4000-8000-000000000201'::uuid,
      'preferredEndDate', null,
      'preferredStartDate', null,
      'propertyId', '10000000-0000-4000-8000-000000000211'::uuid,
      'requestNotes', 'Please qualify a house soft wash.',
      'requestType', 'additional_service',
      'requestedServiceCodes', jsonb_build_array('soft-wash-house'),
      'visitId', null
    )
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  receipt := public.submit_customer_portal_request(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    '17000000-0000-4000-8000-000000000002',
    'portal.additional_service.request',
    canonical_request,
    request_hash,
    'additional_service',
    null,
    '10000000-0000-4000-8000-000000000211',
    null,
    null,
    array['soft-wash-house'],
    'Please qualify a house soft wash.'
  );
  replay := public.submit_customer_portal_request(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    '17000000-0000-4000-8000-000000000002',
    'portal.additional_service.request',
    canonical_request,
    request_hash,
    'additional_service',
    null,
    '10000000-0000-4000-8000-000000000211',
    null,
    null,
    array['soft-wash-house'],
    'Please qualify a house soft wash.'
  );
  if receipt ->> 'normalizedLeadId' is null
    or replay ->> 'normalizedLeadId' <> receipt ->> 'normalizedLeadId'
    or not (replay ->> 'replayed')::boolean
  then
    raise exception 'Additional-service intake was not exactly-once and linked: %, %', receipt, replay;
  end if;
end;
$$;

reset role;
do $$
declare
  lead_count integer;
begin
  select count(*)
  into lead_count
  from public.customer_portal_requests request
  join public.leads lead on lead.id = request.normalized_lead_id
  where request.command_id = '17000000-0000-4000-8000-000000000002'
    and lead.company_id = '10000000-0000-4000-8000-000000000001'
    and lead.customer_id = '10000000-0000-4000-8000-000000000201'
    and lead.property_id = '10000000-0000-4000-8000-000000000211'
    and lead.source = 'web'
    and lead.status = 'new'
    and lead.requested_services = array['soft-wash-house'];
  if lead_count <> 1 then
    raise exception 'Additional-service request did not create one linked lead';
  end if;
end;
$$;
set local role authenticated;

\echo '6/9 global opt-out records four withdrawals and contact suppression exactly once'
do $$
declare
  canonical_request text;
  request_hash text;
  receipt jsonb;
  replay jsonb;
begin
  canonical_request := jsonb_build_object(
    'commandType', 'portal.communication_preferences.update',
    'payload', jsonb_build_object(
      'customerId', '10000000-0000-4000-8000-000000000201'::uuid,
      'disclosureVersion', 'customer-portal-consent-v1',
      'globalOptOut', true,
      'marketingEmail', false,
      'marketingSms', false,
      'transactionalEmail', false,
      'transactionalSms', false
    )
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  receipt := public.update_customer_communication_preferences(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    '17000000-0000-4000-8000-000000000003',
    canonical_request,
    request_hash,
    false,
    false,
    false,
    false,
    true,
    'customer-portal-consent-v1'
  );
  replay := public.update_customer_communication_preferences(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    '17000000-0000-4000-8000-000000000003',
    canonical_request,
    request_hash,
    false,
    false,
    false,
    false,
    true,
    'customer-portal-consent-v1'
  );
  if jsonb_array_length(receipt -> 'consentRecordIds') <> 4
    or not (replay ->> 'replayed')::boolean
  then
    raise exception 'Global opt-out evidence or idempotency is incomplete: %, %', receipt, replay;
  end if;
end;
$$;

reset role;
do $$
declare
  consent_count integer;
  suppression_count integer;
begin
  select count(*)
  into consent_count
  from public.consent_records consent
  where consent.company_id = '10000000-0000-4000-8000-000000000001'
    and consent.customer_id = '10000000-0000-4000-8000-000000000201'
    and consent.proof =
      'authenticated_customer_portal;command=17000000-0000-4000-8000-000000000003'
    and consent.status = 'withdrawn';
  select count(*)
  into suppression_count
  from public.contact_suppressions suppression
  where suppression.company_id = '10000000-0000-4000-8000-000000000001'
    and suppression.channel in ('sms', 'email')
    and suppression.status = 'active'
    and suppression.source_event_id = '17000000-0000-4000-8000-000000000003';
  if consent_count <> 4
    or suppression_count <> 2
  then
    raise exception 'Global opt-out did not persist exact consent and suppression evidence';
  end if;
end;
$$;
set local role authenticated;

\echo '7/9 explicit authenticated consent releases only the enabled contact channel'
do $$
declare
  canonical_request text;
  request_hash text;
  receipt jsonb;
begin
  canonical_request := jsonb_build_object(
    'commandType', 'portal.communication_preferences.update',
    'payload', jsonb_build_object(
      'customerId', '10000000-0000-4000-8000-000000000201'::uuid,
      'disclosureVersion', 'customer-portal-consent-v1',
      'globalOptOut', false,
      'marketingEmail', false,
      'marketingSms', false,
      'transactionalEmail', true,
      'transactionalSms', false
    )
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  receipt := public.update_customer_communication_preferences(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    '17000000-0000-4000-8000-000000000004',
    canonical_request,
    request_hash,
    false,
    true,
    false,
    false,
    false,
    'customer-portal-consent-v1'
  );
  if (receipt ->> 'globalOptOut')::boolean then
    raise exception 'Purpose-specific consent incorrectly released suppression: %', receipt;
  end if;
end;
$$;

reset role;
do $$
declare
  sms_status text;
  email_status text;
begin
  select suppression.status
  into sms_status
  from public.contact_suppressions suppression
  where suppression.company_id = '10000000-0000-4000-8000-000000000001'
    and suppression.channel = 'sms';
  select suppression.status
  into email_status
  from public.contact_suppressions suppression
  where suppression.company_id = '10000000-0000-4000-8000-000000000001'
    and suppression.channel = 'email';
  if sms_status <> 'active'
    or email_status <> 'released'
  then
    raise exception 'Purpose-specific consent released the wrong suppression';
  end if;
end;
$$;
set local role authenticated;

\echo '8/9 a customer cannot mutate a request through direct table access'
do $$
declare
  changed integer;
  request_status text;
begin
  update public.customer_portal_requests
  set status = 'cancelled'
  where command_id = '17000000-0000-4000-8000-000000000001';
  get diagnostics changed = row_count;
  select request.status
  into request_status
  from public.customer_portal_requests request
  where request.command_id = '17000000-0000-4000-8000-000000000001';
  if changed <> 0 or request_status <> 'submitted' then
    raise exception 'Customer directly changed an office-reviewed request';
  end if;
end;
$$;

\echo '9/9 another customer ID is denied even when its UUID is known'
reset role;
insert into public.customers(
  id,
  company_id,
  display_name,
  email,
  phone
)
values (
  '17000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000001',
  'Isolation Fixture',
  'isolation@example.test',
  '+18175550199'
);
set local role authenticated;
do $$
declare
  canonical_request text;
  request_hash text;
  blocked boolean := false;
begin
  canonical_request := jsonb_build_object(
    'commandType', 'portal.communication_preferences.update',
    'payload', jsonb_build_object(
      'customerId', '17000000-0000-4000-8000-000000000201'::uuid,
      'disclosureVersion', 'customer-portal-consent-v1',
      'globalOptOut', true,
      'marketingEmail', false,
      'marketingSms', false,
      'transactionalEmail', false,
      'transactionalSms', false
    )
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  begin
    perform public.update_customer_communication_preferences(
      '10000000-0000-4000-8000-000000000001',
      '17000000-0000-4000-8000-000000000201',
      '17000000-0000-4000-8000-000000000005',
      canonical_request,
      request_hash,
      false,
      false,
      false,
      false,
      true,
      'customer-portal-consent-v1'
    );
  exception
    when others then
      if position('CUSTOMER_PORTAL_SCOPE_DENIED' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Mapped customer changed another customer consent record';
  end if;
end;
$$;

rollback;
