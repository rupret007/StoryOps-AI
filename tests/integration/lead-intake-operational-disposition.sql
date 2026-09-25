\set ON_ERROR_STOP on

begin;

\echo '1/7 install one reviewed published-hours fixture'
insert into auth.users(
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000101',
    'authenticated',
    'authenticated',
    'ops-owner@storyops.local',
    extensions.crypt('StoryOpsOpsFixture1!', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Operations Owner"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000102',
    'authenticated',
    'authenticated',
    'ops-dispatcher@storyops.local',
    extensions.crypt('StoryOpsOpsFixture1!', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Operations Dispatcher"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000103',
    'authenticated',
    'authenticated',
    'ops-technician@storyops.local',
    extensions.crypt('StoryOpsOpsFixture1!', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Operations Technician"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
  )
on conflict (id) do nothing;

insert into public.companies(id, name, timezone, status, settings)
values (
  '10000000-0000-4000-8000-000000000001',
  'WashOps operational intake fixture',
  'America/Chicago',
  'active',
  '{}'::jsonb
)
on conflict (id) do nothing;

insert into public.company_memberships(id, company_id, user_id, role)
values
  (
    '98000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    'owner'
  ),
  (
    '98000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000102',
    'dispatcher'
  ),
  (
    '98000000-0000-4000-8000-000000000013',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000103',
    'technician'
  )
on conflict (company_id, user_id) do nothing;

update public.company_configuration_versions
set status = 'retired', updated_at = now()
where company_id = '10000000-0000-4000-8000-000000000001'
  and status = 'published';

insert into public.company_configuration_versions(
  id,
  company_id,
  revision,
  schema_version,
  status,
  publication_mode,
  configuration,
  configuration_hash,
  review_reference,
  created_by,
  published_by,
  published_at
)
values (
  '98000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  coalesce((
    select max(configuration.revision) + 1
    from public.company_configuration_versions configuration
    where configuration.company_id = '10000000-0000-4000-8000-000000000001'
  ), 1),
  'storyops-company-config-v1',
  'published',
  'sandbox',
  jsonb_build_object(
    'schemaVersion', 'storyops-company-config-v1',
    'territory', jsonb_build_object(
      'timezone', 'America/Chicago',
      'travelZones', jsonb_build_array(jsonb_build_object(
        'code', 'OPS-A',
        'postalCodes', jsonb_build_array('75201')
      )),
      'travelZoneMappingReview', jsonb_build_object(
        'status', 'approved',
        'reviewer', 'Operations fixture',
        'reviewedAt', '2026-07-29T12:00:00Z',
        'evidenceReference', 'lead-intake-operations-fixture'
      )
    ),
    'schedule', jsonb_build_object(
      'businessHours', (
        select jsonb_agg(
          jsonb_build_object(
            'day', day_name,
            'closed', false,
            'opensAt', '08:00',
            'closesAt', '17:00'
          )
          order by ordering
        )
        from unnest(array[
          'monday', 'tuesday', 'wednesday', 'thursday',
          'friday', 'saturday', 'sunday'
        ]) with ordinality days(day_name, ordering)
      )
    )
  ),
  repeat('a', 64),
  'lead-intake-operations-reviewed-fixture',
  '10000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000101',
  now()
);

create temporary table intake_operation_fixture(
  event_id uuid primary key,
  lead_id uuid not null,
  thread_id uuid not null,
  message_id uuid not null,
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  channel text not null,
  occurred_at timestamptz not null,
  body text not null,
  consent_signal text not null
);

insert into intake_operation_fixture values
  (
    '98000000-0000-4000-8000-000000000101',
    '98000000-0000-4000-8000-000000000201',
    '98000000-0000-4000-8000-000000000301',
    '98000000-0000-4000-8000-000000000401',
    'storyops_web',
    'ops-routine',
    'inbound_web',
    'chat',
    '2026-07-29T15:00:00Z',
    'Please quote the selected service.',
    'none'
  ),
  (
    '98000000-0000-4000-8000-000000000102',
    '98000000-0000-4000-8000-000000000202',
    '98000000-0000-4000-8000-000000000302',
    '98000000-0000-4000-8000-000000000402',
    'storyops_chat',
    'ops-after-hours',
    'inbound_chat',
    'chat',
    '2026-07-30T04:00:00Z',
    'Please quote the selected service after work.',
    'none'
  ),
  (
    '98000000-0000-4000-8000-000000000103',
    '98000000-0000-4000-8000-000000000203',
    '98000000-0000-4000-8000-000000000303',
    '98000000-0000-4000-8000-000000000403',
    'storyops_email',
    'ops-human',
    'inbound_email',
    'email',
    '2026-07-29T15:15:00Z',
    'Please connect me to a real person. My attorney says this is unsafe after an injury and now an emergency.',
    'none'
  ),
  (
    '98000000-0000-4000-8000-000000000104',
    '98000000-0000-4000-8000-000000000204',
    '98000000-0000-4000-8000-000000000304',
    '98000000-0000-4000-8000-000000000404',
    'twilio',
    'CAOPSTEST1001MCRNOANSWER',
    'inbound_voice',
    'voice',
    '2026-07-29T15:20:00Z',
    '[Missed inbound voice call; terminal provider status no-answer; transcript intentionally not used]',
    'none'
  ),
  (
    '98000000-0000-4000-8000-000000000105',
    '98000000-0000-4000-8000-000000000204',
    '98000000-0000-4000-8000-000000000304',
    '98000000-0000-4000-8000-000000000405',
    'twilio',
    'CAOPSTEST1001MCRBUSY',
    'inbound_voice',
    'voice',
    '2026-07-29T15:21:00Z',
    '[Missed inbound voice call; terminal provider status busy; transcript intentionally not used]',
    'none'
  ),
  (
    '98000000-0000-4000-8000-000000000106',
    '98000000-0000-4000-8000-000000000206',
    '98000000-0000-4000-8000-000000000306',
    '98000000-0000-4000-8000-000000000406',
    'twilio',
    'SMOPSTEST1001:inbound_message',
    'inbound_message',
    'sms',
    '2026-07-29T15:25:00Z',
    'Please connect me to a human',
    'opt_out'
  );

insert into public.leads(
  id,
  company_id,
  source,
  status,
  display_name,
  phone,
  requested_services
)
select distinct
  fixture.lead_id,
  '10000000-0000-4000-8000-000000000001'::uuid,
  case
    when fixture.channel = 'voice' then 'phone'
    when fixture.channel = 'sms' then 'sms'
    when fixture.channel = 'email' then 'email'
    else 'web'
  end,
  'new',
  'Operational fixture ' || right(fixture.lead_id::text, 4),
  case when fixture.channel in ('voice', 'sms') then '+12145550199' else null end,
  array[]::text[]
from intake_operation_fixture fixture;

insert into public.communication_threads(
  id,
  company_id,
  lead_id,
  subject,
  status,
  last_message_at
)
select distinct
  fixture.thread_id,
  '10000000-0000-4000-8000-000000000001'::uuid,
  fixture.lead_id,
  'Operational intake fixture',
  'open',
  max(fixture.occurred_at)
from intake_operation_fixture fixture
group by fixture.thread_id, fixture.lead_id;

insert into public.communication_messages(
  id,
  company_id,
  thread_id,
  channel,
  direction,
  sender,
  recipients,
  body,
  risk_class,
  provider_message_id,
  delivery_status,
  received_at,
  retention_class
)
select
  fixture.message_id,
  '10000000-0000-4000-8000-000000000001'::uuid,
  fixture.thread_id,
  fixture.channel,
  'inbound',
  'verified-fixture-sender',
  array['verified-fixture-recipient'],
  fixture.body,
  'routine',
  fixture.provider || ':' || fixture.provider_event_id,
  'received',
  fixture.occurred_at,
  'communication'
from intake_operation_fixture fixture;

insert into public.webhook_events(
  id,
  company_id,
  provider,
  provider_event_id,
  event_type,
  payload_hash,
  status,
  payload,
  received_at
)
select
  fixture.event_id,
  '10000000-0000-4000-8000-000000000001'::uuid,
  fixture.provider,
  fixture.provider_event_id,
  fixture.event_type,
  repeat(substr(fixture.event_id::text, 1, 1), 64),
  'processing',
  jsonb_build_object(
    'schemaVersion', 1,
    'operationalSignals', jsonb_build_object(
      'businessHoursStatus', 'open',
      'handoffReasons', jsonb_build_array()
    )
  ),
  fixture.occurred_at
from intake_operation_fixture fixture;

\echo '2/7 durable receipt transition derives operations without trusting caller fields'
update public.webhook_events webhook
set payload = webhook.payload || jsonb_build_object(
  'intakeReceipt',
  jsonb_build_object(
    'subjectType', 'lead',
    'leadId', fixture.lead_id,
    'customerId', null,
    'threadId', fixture.thread_id,
    'messageId', fixture.message_id,
    'consentRecordIds', jsonb_build_array(),
    'existingSubject', false,
    'existingLead', false,
    'consentSignal', fixture.consent_signal
  )
)
from intake_operation_fixture fixture
where webhook.id = fixture.event_id
  and fixture.event_id <> '98000000-0000-4000-8000-000000000106';

do $$
declare
  routine_record record;
  after_hours_record record;
begin
  select disposition, business_hours_status, business_timezone, evidence
  into routine_record
  from public.lead_intake_operational_dispositions
  where webhook_event_id = '98000000-0000-4000-8000-000000000101';
  if routine_record.disposition <> 'routine'
    or routine_record.business_hours_status <> 'open'
    or routine_record.business_timezone <> 'America/Chicago'
    or routine_record.evidence #>> '{businessHours,configurationId}'
      <> '98000000-0000-4000-8000-000000000001'
  then
    raise exception 'Published in-hours evidence was not authoritative: %', routine_record;
  end if;

  select disposition, business_hours_status, evidence
  into after_hours_record
  from public.lead_intake_operational_dispositions
  where webhook_event_id = '98000000-0000-4000-8000-000000000102';
  if after_hours_record.disposition <> 'after_hours'
    or after_hours_record.business_hours_status <> 'closed'
    or after_hours_record.evidence #>> '{businessHours,status}' <> 'closed'
  then
    raise exception 'Caller-asserted open status overrode published hours: %', after_hours_record;
  end if;
end;
$$;

\echo '3/7 deterministic risk language creates finite redacted human handoff'
do $$
declare
  handoff_record record;
begin
  select disposition, human_handoff_required, handoff_reasons, evidence
  into handoff_record
  from public.lead_intake_operational_dispositions
  where webhook_event_id = '98000000-0000-4000-8000-000000000103';
  if handoff_record.disposition <> 'human_handoff_required'
    or not handoff_record.human_handoff_required
    or handoff_record.handoff_reasons <> array[
      'explicit_human_request',
      'legal_uncertainty',
      'safety_uncertainty',
      'emergency_uncertainty'
    ]::text[]
  then
    raise exception 'Finite handoff classification failed: %', handoff_record;
  end if;
  if lower(handoff_record.evidence::text) like '%attorney%'
    or lower(handoff_record.evidence::text) like '%ignore%'
  then
    raise exception 'Customer content leaked into durable handoff evidence';
  end if;
end;
$$;

\echo '4/7 terminal statuses have separate webhook keys but one missed-call action'
do $$
declare
  recovery_count integer;
  recovery_record record;
begin
  select count(*)
  into recovery_count
  from public.webhook_events
  where id in (
    '98000000-0000-4000-8000-000000000104',
    '98000000-0000-4000-8000-000000000105'
  );
  if recovery_count <> 2 then
    raise exception 'Status-qualified provider events collided';
  end if;

  select disposition, missed_call, terminal_call_status, source_operation_key
  into recovery_record
  from public.lead_intake_operational_dispositions
  where source_operation_key = 'twilio:CAOPSTEST1001:missed_call';
  if recovery_record.disposition <> 'missed_call_recovery'
    or not recovery_record.missed_call
    or recovery_record.terminal_call_status <> 'no-answer'
  then
    raise exception 'Missed-call recovery evidence is invalid: %', recovery_record;
  end if;

  select count(*)
  into recovery_count
  from public.lead_intake_operational_dispositions
  where source_operation_key = 'twilio:CAOPSTEST1001:missed_call';
  if recovery_count <> 1 then
    raise exception 'One provider call created duplicate recovery actions';
  end if;
end;
$$;

\echo '5/7 consent keyword content never becomes a handoff instruction'
update public.company_configuration_versions
set status = 'retired', updated_at = now()
where id = '98000000-0000-4000-8000-000000000001'
  and status = 'published';

update public.webhook_events webhook
set payload = webhook.payload || jsonb_build_object(
  'intakeReceipt',
  jsonb_build_object(
    'subjectType', 'lead',
    'leadId', fixture.lead_id,
    'customerId', null,
    'threadId', fixture.thread_id,
    'messageId', fixture.message_id,
    'consentRecordIds', jsonb_build_array(),
    'existingSubject', false,
    'existingLead', false,
    'consentSignal', fixture.consent_signal
  )
)
from intake_operation_fixture fixture
where webhook.id = fixture.event_id
  and fixture.event_id = '98000000-0000-4000-8000-000000000106';

do $$
declare
  stop_record record;
begin
  select
    disposition,
    business_hours_status,
    human_handoff_required,
    handoff_reasons
  into stop_record
  from public.lead_intake_operational_dispositions
  where webhook_event_id = '98000000-0000-4000-8000-000000000106';
  if stop_record.disposition <> 'routine'
    or stop_record.business_hours_status <> 'configuration_missing'
    or stop_record.human_handoff_required
    or cardinality(stop_record.handoff_reasons) <> 0
  then
    raise exception 'STOP boundary was reinterpreted as content: %', stop_record;
  end if;
end;
$$;

\echo '6/7 owner actions and audit evidence are complete and content-redacted'
do $$
declare
  matching_count integer;
begin
  select count(*)
  into matching_count
  from public.notifications notification
  where notification.company_id = '10000000-0000-4000-8000-000000000001'
    and notification.title in (
      'Missed call needs recovery',
      'After-hours lead received',
      'Human follow-up required'
    )
    and notification.action_url = '/pipeline'
    and notification.recipient_user_id in (
      '10000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000102'
    );
  if matching_count <> 6 then
    raise exception 'Owner/dispatcher action fan-out was incomplete: %', matching_count;
  end if;

  select count(*)
  into matching_count
  from public.audit_events audit
  where audit.company_id = '10000000-0000-4000-8000-000000000001'
    and audit.action = 'lead_intake_operational_disposition_recorded'
    and audit.request_id like '98000000-%';
  if matching_count <> 5 then
    raise exception 'Operational audit count was not idempotent: %', matching_count;
  end if;
  if exists (
    select 1
    from public.audit_events audit
    where audit.action = 'lead_intake_operational_disposition_recorded'
      and audit.request_id like '98000000-%'
      and lower(audit.after_data::text) like '%attorney%'
  ) then
    raise exception 'Customer content leaked into audit evidence';
  end if;
end;
$$;

\echo '7/7 RLS exposes disposition evidence only to active owner/dispatcher roles'
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000103',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000103","role":"authenticated"}',
  true
);
do $$
begin
  if (select count(*) from public.lead_intake_operational_dispositions) <> 0 then
    raise exception 'Technician could read back-office intake operations';
  end if;
  begin
    insert into public.lead_intake_operational_dispositions(
      company_id,
      webhook_event_id,
      message_id,
      lead_id,
      source_operation_key,
      disposition,
      business_hours_status,
      missed_call,
      human_handoff_required,
      handoff_reasons,
      evidence
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      '98000000-0000-4000-8000-000000000101',
      '98000000-0000-4000-8000-000000000401',
      '98000000-0000-4000-8000-000000000201',
      'forged',
      'routine',
      'configuration_missing',
      false,
      true,
      array['business_hours_configuration_missing'],
      '{}'::jsonb
    );
    raise exception 'Technician forged operational evidence';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
begin
  if (
    select count(*)
    from public.lead_intake_operational_dispositions
    where company_id = '10000000-0000-4000-8000-000000000001'
      and webhook_event_id::text like '98000000-%'
  ) <> 5 then
    raise exception 'Owner could not read operational disposition evidence';
  end if;
end;
$$;
reset role;

rollback;

\echo 'WashOps lead-intake operational disposition contract passed'
