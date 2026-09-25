\set ON_ERROR_STOP on

begin;

reset role;

delete from public.time_entries
where id in (
  '95000000-0000-4000-8000-000000000501',
  '95000000-0000-4000-8000-000000000502'
);
delete from public.media_assets
where id in (
  '95000000-0000-4000-8000-000000000511',
  '95000000-0000-4000-8000-000000000512'
);
delete from public.incidents
where id in (
  '95000000-0000-4000-8000-000000000521',
  '95000000-0000-4000-8000-000000000522',
  '95000000-0000-4000-8000-000000000523',
  '95000000-0000-4000-8000-000000000524'
);

update public.visits
set status = 'on_site'
where id = '10000000-0000-4000-8000-000000000641';

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
select set_config('request.headers', '{}', true);

select public.execute_storyops_command(
  '10000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000531',
  'time.start',
  0,
  jsonb_build_object(
    'entityId', '95000000-0000-4000-8000-000000000501',
    'visitId', '10000000-0000-4000-8000-000000000641',
    'startedAt', clock_timestamp() - interval '5 minutes'
  ),
  repeat('1', 64)
);

-- Create the temporary packet as the technician, build its exact request facts
-- with fixture-owner visibility, then restore the technician for the RPC.
create temporary table incident_stop_test_request (
  command_id uuid primary key,
  expected_visit_version integer not null,
  payload jsonb not null,
  request_hash text not null,
  changed_payload jsonb,
  changed_request_hash text
) on commit drop;

reset role;
insert into incident_stop_test_request(
  command_id, expected_visit_version, payload, request_hash
)
select
  '95000000-0000-4000-8000-000000000541',
  request.expected_visit_version,
  request.payload,
  public.storyops_json_sha256(jsonb_build_object(
    'commandType', 'incident.report_pause',
    'expectedVersion', request.expected_visit_version,
    'payload', request.payload
  ))
from (
  select
    visit.version as expected_visit_version,
    jsonb_build_object(
      'schemaVersion', 'storyops-incident-pause-v1',
      'action', 'incident.report_pause',
      'actorUserId', '10000000-0000-4000-8000-000000000103',
      'entityId', '95000000-0000-4000-8000-000000000521',
      'incidentNumber', 'INC-ATOMIC-STOP-1',
      'visitId', visit.id,
      'jobId', job.id,
      'propertyId', job.property_id,
      'severity', 'minor',
      'category', 'property_damage',
      'occurredAt', clock_timestamp(),
      'requestedAt', clock_timestamp(),
      'summary', 'A loose fixture fell beside the active pressure-washing area.',
      'immediateActions', 'Stopped work, isolated the area, and preserved direct evidence.',
      'requiresLegalReview', false
    ) as payload
  from public.visits visit
  join public.jobs job on job.id = visit.job_id
  where visit.id = '10000000-0000-4000-8000-000000000641'
) request;

update incident_stop_test_request request
set changed_payload = jsonb_set(
  request.payload,
  '{summary}',
  to_jsonb('Changed facts must not reuse an accepted command identity.'::text)
);
update incident_stop_test_request request
set changed_request_hash = public.storyops_json_sha256(jsonb_build_object(
  'commandType', 'incident.report_pause',
  'expectedVersion', request.expected_visit_version,
  'payload', request.changed_payload
));

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

\echo '1/8 legacy visit-linked incident reporting cannot bypass the atomic stop'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000532',
      'incident.report',
      0,
      jsonb_build_object(
        'entityId', '95000000-0000-4000-8000-000000000522',
        'incidentNumber', 'INC-LEGACY-BLOCKED',
        'jobId', '10000000-0000-4000-8000-000000000631',
        'visitId', '10000000-0000-4000-8000-000000000641',
        'propertyId', '10000000-0000-4000-8000-000000000211',
        'severity', 'minor',
        'category', 'other',
        'occurredAt', clock_timestamp(),
        'summary', 'This legacy path must never create a visit incident by itself.',
        'immediateActions', 'Stopped work while testing the retired command path.',
        'requiresLegalReview', false
      ),
      repeat('2', 64)
    );
  exception
    when others then
      if position('INCIDENT_ATOMIC_STOP_REQUIRED' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Legacy incident.report bypassed atomic stop-work';
  end if;
end;
$$;

reset role;
do $$
begin
  if exists (
    select 1 from public.incidents
    where id = '95000000-0000-4000-8000-000000000522'
  ) then
    raise exception 'Blocked legacy visit incident still mutated durable state';
  end if;
end;
$$;

\echo '1b/8 job-only and property-only legacy reports cannot bypass active work'
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000102',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated"}',
  true
);
do $$
declare
  job_blocked boolean := false;
  property_blocked boolean := false;
begin
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000550',
      'incident.report',
      0,
      jsonb_build_object(
        'entityId', '95000000-0000-4000-8000-000000000523',
        'incidentNumber', 'INC-LEGACY-JOB-BLOCKED',
        'jobId', '10000000-0000-4000-8000-000000000631',
        'propertyId', '10000000-0000-4000-8000-000000000211',
        'severity', 'minor',
        'category', 'other',
        'occurredAt', clock_timestamp(),
        'summary', 'A job-only report cannot leave linked field work running.',
        'immediateActions', 'Escalated to the exact atomic visit stop-work path.',
        'requiresLegalReview', false
      ),
      repeat('a', 64)
    );
  exception
    when others then
      if position('INCIDENT_ATOMIC_STOP_REQUIRED' in sqlerrm) > 0 then
        job_blocked := true;
      else
        raise;
      end if;
  end;

  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000551',
      'incident.report',
      0,
      jsonb_build_object(
        'entityId', '95000000-0000-4000-8000-000000000524',
        'incidentNumber', 'INC-LEGACY-PROPERTY-BLOCKED',
        'propertyId', '10000000-0000-4000-8000-000000000211',
        'severity', 'minor',
        'category', 'other',
        'occurredAt', clock_timestamp(),
        'summary', 'A property-only report cannot leave linked field work running.',
        'immediateActions', 'Escalated to the exact atomic visit stop-work path.',
        'requiresLegalReview', false
      ),
      repeat('b', 64)
    );
  exception
    when others then
      if position('INCIDENT_ATOMIC_STOP_REQUIRED' in sqlerrm) > 0 then
        property_blocked := true;
      else
        raise;
      end if;
  end;

  if not job_blocked or not property_blocked then
    raise exception 'Job/property legacy incident bypassed active stop-work';
  end if;
end;
$$;

reset role;
do $$
begin
  if exists (
    select 1
    from public.incidents
    where id in (
      '95000000-0000-4000-8000-000000000523',
      '95000000-0000-4000-8000-000000000524'
    )
  ) then
    raise exception 'Blocked job/property incidents still mutated durable state';
  end if;
end;
$$;

\echo '2/8 an injected failure after incident/timer mutation rolls the full request back'
reset role;
create function pg_temp.fail_atomic_visit_pause()
returns trigger
language plpgsql
as $$
begin
  raise exception 'TEST_INJECTED_VISIT_PAUSE_FAILURE';
end;
$$;
create trigger zz_test_fail_atomic_visit_pause
before update on public.visits
for each row
when (
  old.id = '10000000-0000-4000-8000-000000000641'::uuid
  and new.status = 'paused'
)
execute function pg_temp.fail_atomic_visit_pause();

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
declare
  request incident_stop_test_request%rowtype;
  blocked boolean := false;
begin
  select * into request from incident_stop_test_request;
  begin
    perform public.report_storyops_incident_and_pause(
      '10000000-0000-4000-8000-000000000001',
      request.command_id,
      request.expected_visit_version,
      request.payload,
      request.request_hash
    );
  exception
    when others then
      if position('TEST_INJECTED_VISIT_PAUSE_FAILURE' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Injected mid-transaction failure did not abort the request';
  end if;
end;
$$;

reset role;
do $$
declare
  request incident_stop_test_request%rowtype;
begin
  select * into request from incident_stop_test_request;
  if exists (
      select 1 from public.incidents
      where id = '95000000-0000-4000-8000-000000000521'
    )
    or not exists (
      select 1 from public.time_entries
      where id = '95000000-0000-4000-8000-000000000501'
        and ended_at is null
        and version = 1
    )
    or not exists (
      select 1 from public.visits
      where id = '10000000-0000-4000-8000-000000000641'
        and status = 'on_site'
        and version = request.expected_visit_version
    )
    or exists (
      select 1
      from public.idempotency_keys
      where company_id = '10000000-0000-4000-8000-000000000001'
        and scope = 'incident-report-pause-v1'
        and key = request.command_id::text
    )
  then
    raise exception 'Atomic incident failure left partial incident, timer, visit, or reservation state';
  end if;
end;
$$;

drop trigger zz_test_fail_atomic_visit_pause on public.visits;

\echo '3/8 one durable request creates the incident, stops all timers, and pauses the visit'
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

create temporary table incident_stop_test_receipt (
  receipt jsonb not null
) on commit drop;

insert into incident_stop_test_receipt(receipt)
select public.report_storyops_incident_and_pause(
  '10000000-0000-4000-8000-000000000001',
  request.command_id,
  request.expected_visit_version,
  request.payload,
  request.request_hash
)
from incident_stop_test_request request;

reset role;
do $$
declare
  receipt jsonb;
begin
  select record.receipt into receipt from incident_stop_test_receipt record;
  if coalesce((receipt ->> 'replayed')::boolean, true)
    or receipt ->> 'schemaVersion' <> 'storyops-incident-pause-receipt-v1'
    or receipt ->> 'commandType' <> 'incident.report_pause'
    or receipt #>> '{incident,id}' <> '95000000-0000-4000-8000-000000000521'
    or receipt #>> '{incident,status}' <> 'open'
    or receipt #>> '{visit,currentStatus}' <> 'paused'
    or receipt #>> '{visit,previousStatus}' <> 'on_site'
    or (receipt #>> '{visit,submittedExpectedVersion}')::integer
      <> (
        select request.expected_visit_version
        from incident_stop_test_request request
      )
    or (receipt #>> '{visit,previousVersion}')::integer
      < (receipt #>> '{visit,submittedExpectedVersion}')::integer
    or jsonb_array_length(receipt -> 'stoppedTimeEntries') <> 1
    or not exists (
      select 1 from public.time_entries
      where id = '95000000-0000-4000-8000-000000000501'
        and ended_at is not null
        and version = 2
    )
    or not exists (
      select 1 from public.visits
      where id = '10000000-0000-4000-8000-000000000641'
        and status = 'paused'
        and version = (receipt #>> '{visit,currentVersion}')::integer
    )
  then
    raise exception 'Atomic incident stop-work postcondition or receipt failed';
  end if;
end;
$$;

\echo '4/8 exact replay is read-only and command-id reuse with changed facts conflicts'
set local role authenticated;
do $$
declare
  request incident_stop_test_request%rowtype;
  replay jsonb;
  changed_payload jsonb;
  blocked boolean := false;
begin
  select * into request from incident_stop_test_request;
  replay := public.report_storyops_incident_and_pause(
    '10000000-0000-4000-8000-000000000001',
    request.command_id,
    request.expected_visit_version,
    request.payload,
    request.request_hash
  );
  if not coalesce((replay ->> 'replayed')::boolean, false)
    or replay ->> 'requestHash' <> request.request_hash
  then
    raise exception 'Exact incident replay was not stable and read-only';
  end if;

  changed_payload := request.changed_payload;
  begin
    perform public.report_storyops_incident_and_pause(
      '10000000-0000-4000-8000-000000000001',
      request.command_id,
      request.expected_visit_version,
      changed_payload,
      request.changed_request_hash
    );
  exception
    when others then
      if position('INCIDENT_STOP_IDEMPOTENCY_CONFLICT' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Changed incident facts reused a completed command identity';
  end if;
end;
$$;

reset role;
do $$
begin
  if (
    select count(*) from public.incidents
    where id = '95000000-0000-4000-8000-000000000521'
  ) <> 1 then
    raise exception 'Exact incident replay duplicated durable incident state';
  end if;
end;
$$;

\echo '4b/8 direct dispatcher/owner closure is blocked; safe investigation remains available'
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000102',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated"}',
  true
);
do $$
declare
  dispatcher_blocked boolean := false;
begin
  begin
    update public.incidents
    set
      status = 'closed',
      closure_note = 'Dispatcher attempted a direct forged closure.',
      closed_at = clock_timestamp(),
      closed_by = '10000000-0000-4000-8000-000000000102'
    where id = '95000000-0000-4000-8000-000000000521';
  exception
    when others then
      if position('INCIDENT_CLOSE_COMMAND_REQUIRED' in sqlerrm) > 0 then
        dispatcher_blocked := true;
      else
        raise;
      end if;
  end;
  if not dispatcher_blocked then
    raise exception 'Dispatcher directly closed an incident';
  end if;
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
declare
  owner_forgery_blocked boolean := false;
begin
  begin
    update public.incidents
    set
      closed_at = clock_timestamp(),
      closed_by = '10000000-0000-4000-8000-000000000101'
    where id = '95000000-0000-4000-8000-000000000521';
  exception
    when others then
      if position('INCIDENT_CLOSE_COMMAND_REQUIRED' in sqlerrm) > 0 then
        owner_forgery_blocked := true;
      else
        raise;
      end if;
  end;
  if not owner_forgery_blocked then
    raise exception 'Owner directly forged incident closure evidence';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000102',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated"}',
  true
);
update public.incidents
set
  status = 'investigating',
  owner_notified_at = clock_timestamp()
where id = '95000000-0000-4000-8000-000000000521';

do $$
begin
  if not exists (
    select 1
    from public.incidents
    where id = '95000000-0000-4000-8000-000000000521'
      and status = 'investigating'
      and version = 2
      and owner_notified_at is not null
      and closure_note is null
      and closed_at is null
      and closed_by is null
  ) then
    raise exception 'Safe investigation transition did not persist exactly';
  end if;
end;
$$;

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

\echo '5/8 open incident blocks resume, timer, checklist, material, signature, and ordinary media'
do $$
declare
  visit_version integer;
  checklist_version integer;
  blocked_count integer := 0;
begin
  select version into visit_version
  from public.visits
  where id = '10000000-0000-4000-8000-000000000641';
  select version into checklist_version
  from public.visit_checklist_items
  where visit_id = '10000000-0000-4000-8000-000000000641'
  order by id
  limit 1;

  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000533',
      'visit.transition',
      visit_version,
      '{"entityId":"10000000-0000-4000-8000-000000000641","status":"on_site"}'::jsonb,
      repeat('3', 64)
    );
  exception when others then
    if position('OPEN_INCIDENT_STOPS_FIELD_WORK' in sqlerrm) > 0
      then blocked_count := blocked_count + 1; else raise; end if;
  end;

  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000534',
      'time.start',
      0,
      jsonb_build_object(
        'entityId', '95000000-0000-4000-8000-000000000502',
        'visitId', '10000000-0000-4000-8000-000000000641',
        'startedAt', clock_timestamp()
      ),
      repeat('4', 64)
    );
  exception when others then
    if position('OPEN_INCIDENT_STOPS_FIELD_WORK' in sqlerrm) > 0
      then blocked_count := blocked_count + 1; else raise; end if;
  end;

  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000535',
      'checklist.record',
      checklist_version,
      jsonb_build_object(
        'entityId', (
          select id from public.visit_checklist_items
          where visit_id = '10000000-0000-4000-8000-000000000641'
          order by id limit 1
        ),
        'visitId', '10000000-0000-4000-8000-000000000641',
        'templateItemId', (
          select template_item_id from public.visit_checklist_items
          where visit_id = '10000000-0000-4000-8000-000000000641'
          order by id limit 1
        ),
        'status', 'complete',
        'completedAt', clock_timestamp(),
        'evidenceAssetIds', jsonb_build_array(),
        'note', 'This ordinary checklist mutation must remain blocked.'
      ),
      repeat('5', 64)
    );
  exception when others then
    if position('OPEN_INCIDENT_STOPS_FIELD_WORK' in sqlerrm) > 0
      then blocked_count := blocked_count + 1; else raise; end if;
  end;

  begin
    insert into public.material_usage(
      id, company_id, visit_id, material_id, quantity, unit,
      recorded_at, recorded_by, offline_client_id
    )
    select
      '95000000-0000-4000-8000-000000000513',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000641',
      material.id,
      1,
      material.unit,
      clock_timestamp(),
      '10000000-0000-4000-8000-000000000103',
      'atomic-incident-blocked-material'
    from public.materials material
    where material.company_id = '10000000-0000-4000-8000-000000000001'
    order by material.id
    limit 1;
  exception when others then
    if position('OPEN_INCIDENT_STOPS_FIELD_WORK' in sqlerrm) > 0
      then blocked_count := blocked_count + 1; else raise; end if;
  end;

  begin
    insert into public.completion_signatures(
      id, company_id, visit_id, signer_name, signer_role, signed_at,
      signature_asset_id, disclosure_version
    )
    values (
      '95000000-0000-4000-8000-000000000514',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000641',
      'Blocked Signer',
      'customer',
      clock_timestamp(),
      '10000000-0000-4000-8000-000000000711',
      'blocked-v1'
    );
  exception when others then
    if position('OPEN_INCIDENT_STOPS_FIELD_WORK' in sqlerrm) > 0
      then blocked_count := blocked_count + 1; else raise; end if;
  end;

  begin
    insert into public.media_assets(
      id, company_id, property_id, job_id, visit_id, purpose, object_path,
      content_type, byte_size, checksum_sha256, captured_at, captured_by,
      customer_visible, offline_client_id, sync_state
    )
    values (
      '95000000-0000-4000-8000-000000000511',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000211',
      '10000000-0000-4000-8000-000000000631',
      '10000000-0000-4000-8000-000000000641',
      'before',
      '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/95000000-0000-4000-8000-000000000511-blocked-before.png',
      'image/png',
      16,
      repeat('a', 64),
      clock_timestamp(),
      '10000000-0000-4000-8000-000000000103',
      false,
      'atomic-incident-blocked-before',
      'pending'
    );
  exception when others then
    if position('OPEN_INCIDENT_STOPS_FIELD_WORK' in sqlerrm) > 0
      then blocked_count := blocked_count + 1; else raise; end if;
  end;

  if blocked_count <> 6 then
    raise exception 'Open incident blocked % of 6 ordinary field mutation classes', blocked_count;
  end if;
end;
$$;

\echo '6/8 incident/safety/damage evidence remains preservable during stop-work'
insert into public.media_assets(
  id, company_id, property_id, job_id, visit_id, incident_id, purpose,
  object_path, content_type, byte_size, checksum_sha256, captured_at,
  captured_by, customer_visible, offline_client_id, sync_state
)
values (
  '95000000-0000-4000-8000-000000000512',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000211',
  '10000000-0000-4000-8000-000000000631',
  '10000000-0000-4000-8000-000000000641',
  '95000000-0000-4000-8000-000000000521',
  'incident',
  '10000000-0000-4000-8000-000000000001/incidents/95000000-0000-4000-8000-000000000521/visits/10000000-0000-4000-8000-000000000641/95000000-0000-4000-8000-000000000512-bbbbbbbbbbbbbbbb-evidence.png',
  'image/png',
  16,
  repeat('b', 64),
  clock_timestamp(),
  '10000000-0000-4000-8000-000000000103',
  false,
  'atomic-incident-evidence',
  'pending'
);

\echo '7/8 every relevant open incident must close before work can resume'
set local role authenticated;
create temporary table incident_stop_delayed_request (
  command_id uuid primary key,
  expected_visit_version integer not null,
  payload jsonb not null,
  request_hash text not null
) on commit drop;
create temporary table incident_stop_delayed_receipt (
  receipt jsonb not null
) on commit drop;

reset role;
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
insert into incident_stop_delayed_request(
  command_id, expected_visit_version, payload, request_hash
)
select
  '95000000-0000-4000-8000-000000000542',
  request.expected_visit_version,
  request.payload,
  public.storyops_json_sha256(jsonb_build_object(
    'commandType', 'incident.report_pause',
    'expectedVersion', request.expected_visit_version,
    'payload', request.payload
  ))
from (
  select
    visit.version as expected_visit_version,
    jsonb_build_object(
      'schemaVersion', 'storyops-incident-pause-v1',
      'action', 'incident.report_pause',
      'actorUserId', '10000000-0000-4000-8000-000000000103',
      'entityId', '95000000-0000-4000-8000-000000000522',
      'incidentNumber', 'INC-ATOMIC-STOP-2',
      'visitId', visit.id,
      'jobId', job.id,
      'propertyId', job.property_id,
      'severity', 'near_miss',
      'category', 'other',
      'occurredAt', clock_timestamp() - interval '400 days',
      'requestedAt', clock_timestamp() - interval '3 days',
      'summary', 'A delayed offline near miss remains independently unresolved.',
      'immediateActions', 'Work remained stopped while the device awaited reconnection.',
      'requiresLegalReview', false
    ) as payload
  from public.visits visit
  join public.jobs job on job.id = visit.job_id
  where visit.id = '10000000-0000-4000-8000-000000000641'
) request;

-- Simulate an unrelated authoritative visit write after the device durably
-- captured the safety command. The stop must bind both submitted and locked
-- versions instead of becoming permanently unexecutable.
update public.visits
set last_synced_at = clock_timestamp()
where id = '10000000-0000-4000-8000-000000000641';

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
insert into incident_stop_delayed_receipt(receipt)
select public.report_storyops_incident_and_pause(
  '10000000-0000-4000-8000-000000000001',
  request.command_id,
  request.expected_visit_version,
  request.payload,
  request.request_hash
)
from incident_stop_delayed_request request;

reset role;
do $$
declare
  receipt jsonb;
  request incident_stop_delayed_request%rowtype;
begin
  select * into request from incident_stop_delayed_request;
  select record.receipt into receipt from incident_stop_delayed_receipt record;
  if (receipt #>> '{visit,submittedExpectedVersion}')::integer
      <> request.expected_visit_version
    or (receipt #>> '{visit,previousVersion}')::integer
      <= request.expected_visit_version
    or (receipt #>> '{visit,currentVersion}')::integer
      <> (receipt #>> '{visit,previousVersion}')::integer
    or receipt #>> '{visit,currentStatus}' <> 'paused'
    or jsonb_array_length(receipt -> 'stoppedTimeEntries') <> 0
    or not exists (
      select 1
      from public.incidents incident
      where incident.id = '95000000-0000-4000-8000-000000000522'
        and incident.occurred_at
          = (request.payload ->> 'occurredAt')::timestamptz
        and incident.reported_at > now() - interval '1 minute'
    )
  then
    raise exception 'Delayed/version-stale monotonic incident stop failed: %', receipt;
  end if;
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
declare
  incident_version integer;
  close_payload jsonb;
  close_hash text;
  result jsonb;
  replay jsonb;
begin
  select version into incident_version
  from public.incidents
  where id = '95000000-0000-4000-8000-000000000521';
  close_payload :=
    '{"entityId":"95000000-0000-4000-8000-000000000521","closureNote":"Owner verified the first corrective action is complete."}'::jsonb;
  close_hash := public.storyops_json_sha256(jsonb_build_object(
    'commandType', 'incident.close',
    'expectedVersion', incident_version,
    'payload', close_payload
  ));
  result := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000543',
    'incident.close',
    incident_version,
    close_payload,
    close_hash
  );
  replay := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000543',
    'incident.close',
    incident_version,
    close_payload,
    close_hash
  );
  if result ->> 'status' <> 'applied'
    or coalesce((result ->> 'replayed')::boolean, true)
    or not coalesce((replay ->> 'replayed')::boolean, false)
    or result ->> 'requestHash' <> close_hash
    or (select count(*)
      from public.audit_events event
      where event.company_id = '10000000-0000-4000-8000-000000000001'
        and event.action = 'incident.close.command'
        and event.entity_id = '95000000-0000-4000-8000-000000000521'
        and event.request_id = '95000000-0000-4000-8000-000000000543'
        and event.after_data ->> 'requestHash' = close_hash
        and event.before_data ->> 'status' = 'investigating'
        and event.after_data ->> 'status' = 'closed'
    ) <> 1
  then
    raise exception 'Owner close receipt/replay/audit contract failed';
  end if;
end;
$$;

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
declare
  blocked boolean := false;
  visit_version integer;
begin
  select version into visit_version
  from public.visits
  where id = '10000000-0000-4000-8000-000000000641';
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000544',
      'visit.transition',
      visit_version,
      '{"entityId":"10000000-0000-4000-8000-000000000641","status":"on_site"}'::jsonb,
      repeat('7', 64)
    );
  exception when others then
    if position('OPEN_INCIDENT_STOPS_FIELD_WORK' in sqlerrm) > 0
      then blocked := true; else raise; end if;
  end;
  if not blocked then
    raise exception 'Closing only one of two relevant incidents allowed work to resume';
  end if;
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
declare
  incident_version integer;
  close_payload jsonb;
  close_hash text;
begin
  select version into incident_version
  from public.incidents
  where id = '95000000-0000-4000-8000-000000000522';
  close_payload :=
    '{"entityId":"95000000-0000-4000-8000-000000000522","closureNote":"Owner verified the second corrective action is complete."}'::jsonb;
  close_hash := public.storyops_json_sha256(jsonb_build_object(
    'commandType', 'incident.close',
    'expectedVersion', incident_version,
    'payload', close_payload
  ));
  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000545',
    'incident.close',
    incident_version,
    close_payload,
    close_hash
  );
end;
$$;

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
declare
  visit_version integer;
  receipt jsonb;
begin
  select version into visit_version
  from public.visits
  where id = '10000000-0000-4000-8000-000000000641';
  receipt := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000546',
    'visit.transition',
    visit_version,
    '{"entityId":"10000000-0000-4000-8000-000000000641","status":"on_site"}'::jsonb,
    repeat('9', 64)
  );
  if receipt ->> 'status' <> 'applied' then
    raise exception 'Work did not resume after every relevant incident closed';
  end if;
end;
$$;

\echo '8/8 customer role and mismatched actor/scope facts are rejected without mutation'
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
do $$
declare
  request incident_stop_test_request%rowtype;
  blocked boolean := false;
begin
  select * into request from incident_stop_test_request;
  begin
    perform public.report_storyops_incident_and_pause(
      '10000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000547',
      request.expected_visit_version,
      jsonb_set(
        request.payload,
        '{entityId}',
        to_jsonb('95000000-0000-4000-8000-000000000523'::text)
      ),
      request.request_hash
    );
  exception when others then
    if position('INCIDENT_STOP_FIELD_ROLE_REQUIRED' in sqlerrm) > 0
      then blocked := true; else raise; end if;
  end;
  if not blocked then
    raise exception 'Customer role reported an operational incident';
  end if;
end;
$$;

rollback;

\echo 'WashOps atomic incident stop-work contract passed'
