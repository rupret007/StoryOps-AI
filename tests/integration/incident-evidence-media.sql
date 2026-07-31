\set ON_ERROR_STOP on

begin;

reset role;
delete from public.media_assets
where id between
  '95300000-0000-4000-8000-000000000101'
  and '95300000-0000-4000-8000-000000000199';
delete from public.incidents
where id in (
  '95300000-0000-4000-8000-000000000001',
  '95300000-0000-4000-8000-000000000002'
);
update public.visits
set status = 'planned'
where id = '10000000-0000-4000-8000-000000000641';

-- Create legitimate broader-scope incidents while no field work is active.
-- Once the visit is paused, both must control it under the same server rule:
-- exact visit OR job OR property-only.
create temporary table incident_evidence_incident_requests (
  command_id uuid primary key,
  payload jsonb not null,
  request_hash text
) on commit drop;
grant select on incident_evidence_incident_requests to authenticated;

insert into incident_evidence_incident_requests(command_id, payload)
values
(
  '95300000-0000-4000-8000-000000000011',
  jsonb_build_object(
    'entityId', '95300000-0000-4000-8000-000000000001',
    'incidentNumber', 'INC-EVIDENCE-JOB',
    'jobId', '10000000-0000-4000-8000-000000000631',
    'propertyId', '10000000-0000-4000-8000-000000000211',
    'severity', 'minor',
    'category', 'property_damage',
    'occurredAt', clock_timestamp() - interval '2 minutes',
    'summary', 'A job-wide property-damage investigation requires private evidence.',
    'immediateActions', 'Held all affected work and preserved the original evidence.',
    'requiresLegalReview', false
  )
),
(
  '95300000-0000-4000-8000-000000000012',
  jsonb_build_object(
    'entityId', '95300000-0000-4000-8000-000000000002',
    'incidentNumber', 'INC-EVIDENCE-PROPERTY',
    'propertyId', '10000000-0000-4000-8000-000000000211',
    'severity', 'minor',
    'category', 'other',
    'occurredAt', clock_timestamp() - interval '2 minutes',
    'summary', 'A property-wide corrective action requires private safety evidence.',
    'immediateActions', 'Held all affected work and isolated the property condition.',
    'requiresLegalReview', false
  )
);

update incident_evidence_incident_requests
set request_hash = public.storyops_json_sha256(jsonb_build_object(
  'commandType', 'incident.report',
  'expectedVersion', 0,
  'payload', payload
));

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
select public.execute_storyops_command(
  '10000000-0000-4000-8000-000000000001',
  request.command_id,
  'incident.report',
  0,
  request.payload,
  request.request_hash
)
from incident_evidence_incident_requests request
order by request.command_id;

reset role;
update public.visits
set status = 'paused'
where id = '10000000-0000-4000-8000-000000000641';

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
reset role;
update public.incidents
set status = 'investigating', owner_notified_at = clock_timestamp()
where id = '95300000-0000-4000-8000-000000000001';
update public.incidents
set status = 'corrective_action', owner_notified_at = clock_timestamp()
where id = '95300000-0000-4000-8000-000000000002';

reset role;
create temporary table incident_evidence_packets (
  command_id uuid primary key,
  asset_id uuid unique not null,
  incident_id uuid not null,
  purpose text not null,
  checksum_sha256 text not null,
  captured_at timestamptz not null,
  object_path text,
  payload jsonb,
  request_hash text
) on commit drop;
grant select on incident_evidence_packets to authenticated, service_role;

insert into incident_evidence_packets(
  command_id, asset_id, incident_id, purpose, checksum_sha256, captured_at
)
values
(
  '95300000-0000-4000-8000-000000000201',
  '95300000-0000-4000-8000-000000000101',
  '95300000-0000-4000-8000-000000000001',
  'incident',
  repeat('a', 64),
  clock_timestamp() - interval '30 seconds'
),
(
  '95300000-0000-4000-8000-000000000202',
  '95300000-0000-4000-8000-000000000102',
  '95300000-0000-4000-8000-000000000002',
  'safety',
  repeat('b', 64),
  clock_timestamp() - interval '25 seconds'
),
(
  '95300000-0000-4000-8000-000000000203',
  '95300000-0000-4000-8000-000000000103',
  '95300000-0000-4000-8000-000000000002',
  'damage',
  repeat('c', 64),
  clock_timestamp() - interval '20 seconds'
),
(
  '95300000-0000-4000-8000-000000000204',
  '95300000-0000-4000-8000-000000000104',
  '95300000-0000-4000-8000-000000000001',
  'damage',
  repeat('d', 64),
  clock_timestamp() - interval '15 seconds'
);

update incident_evidence_packets packet
set object_path = concat(
  '10000000-0000-4000-8000-000000000001/incidents/',
  packet.incident_id,
  '/visits/10000000-0000-4000-8000-000000000641/',
  packet.asset_id,
  '-',
  left(packet.checksum_sha256, 16),
  '-evidence.png'
);
update incident_evidence_packets packet
set payload = jsonb_build_object(
  'entityId', packet.asset_id,
  'visitId', '10000000-0000-4000-8000-000000000641',
  'jobId', '10000000-0000-4000-8000-000000000631',
  'propertyId', '10000000-0000-4000-8000-000000000211',
  'incidentId', packet.incident_id,
  'purpose', packet.purpose,
  'objectPath', packet.object_path,
  'contentType', 'image/png',
  'byteSize', 1024,
  'checksumSha256', packet.checksum_sha256,
  'capturedAt', packet.captured_at,
  'customerVisible', false
);
update incident_evidence_packets packet
set request_hash = public.storyops_json_sha256(jsonb_build_object(
  'commandType', 'media.register',
  'expectedVersion', 0,
  'payload', packet.payload
));

\echo '1/10 Storage RLS keeps customer uploads behind signed scope workflow and rejects cross-scope evidence'
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
  direct_customer_upload_blocked boolean := false;
begin
  begin
    insert into storage.objects(bucket_id, name, metadata)
    values (
      'job-media',
      '10000000-0000-4000-8000-000000000001/customers/10000000-0000-4000-8000-000000000201/customer-upload-contract.png',
      '{"size":16,"mimetype":"image/png"}'::jsonb
    );
  exception when insufficient_privilege then
    direct_customer_upload_blocked := true;
  end;
  if not direct_customer_upload_blocked then
    raise exception 'Customer bypassed the signed scope-photo upload workflow';
  end if;
end;
$$;

reset role;
update public.crew_members
set ends_on = current_date
where id = '10000000-0000-4000-8000-000000000602';

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
  unassigned_blocked boolean := false;
  cross_company_blocked boolean := false;
  cross_visit_blocked boolean := false;
begin
  begin
    insert into storage.objects(bucket_id, name, metadata)
    values (
      'job-media',
      '10000000-0000-4000-8000-000000000001/incidents/95300000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/95300000-0000-4000-8000-000000000111-aaaaaaaaaaaaaaaa-unassigned.png',
      '{"size":1024,"mimetype":"image/png"}'::jsonb
    );
  exception when insufficient_privilege then
    unassigned_blocked := true;
  end;
  begin
    insert into storage.objects(bucket_id, name, metadata)
    values (
      'job-media',
      'ffffffff-ffff-4fff-8fff-ffffffffffff/incidents/95300000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/95300000-0000-4000-8000-000000000112-aaaaaaaaaaaaaaaa-cross-company.png',
      '{"size":1024,"mimetype":"image/png"}'::jsonb
    );
  exception when insufficient_privilege then
    cross_company_blocked := true;
  end;
  begin
    insert into storage.objects(bucket_id, name, metadata)
    values (
      'job-media',
      '10000000-0000-4000-8000-000000000001/incidents/95300000-0000-4000-8000-000000000001/visits/ffffffff-ffff-4fff-8fff-ffffffffffff/95300000-0000-4000-8000-000000000113-aaaaaaaaaaaaaaaa-cross-visit.png',
      '{"size":1024,"mimetype":"image/png"}'::jsonb
    );
  exception when insufficient_privilege then
    cross_visit_blocked := true;
  end;
  if not unassigned_blocked or not cross_company_blocked or not cross_visit_blocked then
    raise exception 'Incident Storage RLS failed closed: unassigned %, company %, visit %',
      unassigned_blocked, cross_company_blocked, cross_visit_blocked;
  end if;
end;
$$;

reset role;
update public.crew_members
set ends_on = null
where id = '10000000-0000-4000-8000-000000000602';

\echo '2/10 assigned technician stages exact job/property-scoped incident objects'
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
insert into storage.objects(bucket_id, name, metadata)
select
  'job-media',
  packet.object_path,
  '{"size":1024,"mimetype":"image/png"}'::jsonb
from incident_evidence_packets packet;

\echo '3/10 canonical request hash rejects tampering before durable mutation'
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.finalize_storyops_media_upload(
      '10000000-0000-4000-8000-000000000001',
      packet.command_id,
      '10000000-0000-4000-8000-000000000103',
      packet.payload,
      repeat('f', 64)
    )
    from incident_evidence_packets packet
    where packet.asset_id = '95300000-0000-4000-8000-000000000101';
  exception when others then
    if position('canonical payload' in sqlerrm) > 0 then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'Tampered media request hash was accepted';
  end if;
end;
$$;
reset role;
do $$
begin
  if exists (
    select 1 from public.media_assets
    where id = '95300000-0000-4000-8000-000000000101'
  ) then
    raise exception 'Tampered media request hash changed durable state';
  end if;
end;
$$;

\echo '4/10 all unresolved statuses finalize exact private incident/safety/damage evidence'
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.finalize_storyops_media_upload(
  '10000000-0000-4000-8000-000000000001',
  packet.command_id,
  '10000000-0000-4000-8000-000000000103',
  packet.payload,
  packet.request_hash
)
from incident_evidence_packets packet
where packet.asset_id in (
  '95300000-0000-4000-8000-000000000101',
  '95300000-0000-4000-8000-000000000102'
)
order by packet.asset_id;

do $$
declare
  replay jsonb;
  reused_blocked boolean := false;
begin
  select public.finalize_storyops_media_upload(
    '10000000-0000-4000-8000-000000000001',
    packet.command_id,
    '10000000-0000-4000-8000-000000000103',
    packet.payload,
    packet.request_hash
  )
  into replay
  from incident_evidence_packets packet
  where packet.asset_id = '95300000-0000-4000-8000-000000000101';
  if coalesce((replay ->> 'replayed')::boolean, false) is not true then
    raise exception 'Exact incident media replay was not idempotent: %', replay;
  end if;

  begin
    perform public.finalize_storyops_media_upload(
      '10000000-0000-4000-8000-000000000001',
      '95300000-0000-4000-8000-000000000201',
      '10000000-0000-4000-8000-000000000103',
      packet.payload,
      packet.request_hash
    )
    from incident_evidence_packets packet
    where packet.asset_id = '95300000-0000-4000-8000-000000000102';
  exception when others then
    if position('reused with a different payload' in sqlerrm) > 0 then
      reused_blocked := true;
    else
      raise;
    end if;
  end;
  if not reused_blocked then
    raise exception 'Completed media command identity accepted changed exact facts';
  end if;
end;
$$;

\echo '5/10 paused company blocks finalization after Storage staging'
reset role;
update public.companies
set status = 'paused'
where id = '10000000-0000-4000-8000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.finalize_storyops_media_upload(
      '10000000-0000-4000-8000-000000000001',
      packet.command_id,
      '10000000-0000-4000-8000-000000000103',
      packet.payload,
      packet.request_hash
    )
    from incident_evidence_packets packet
    where packet.asset_id = '95300000-0000-4000-8000-000000000103';
  exception when others then
    if position('active company' in lower(sqlerrm)) > 0
      or position('storyops_company_not_active' in lower(sqlerrm)) > 0
    then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'Paused-company media finalization was accepted';
  end if;
end;
$$;

reset role;
do $$
begin
  if exists (
    select 1 from public.media_assets
    where id = '95300000-0000-4000-8000-000000000103'
  ) then
    raise exception 'Paused-company media finalization changed durable state';
  end if;
end;
$$;
update public.companies
set status = 'active'
where id = '10000000-0000-4000-8000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.finalize_storyops_media_upload(
  '10000000-0000-4000-8000-000000000001',
  packet.command_id,
  '10000000-0000-4000-8000-000000000103',
  packet.payload,
  packet.request_hash
)
from incident_evidence_packets packet
where packet.asset_id = '95300000-0000-4000-8000-000000000103';

\echo '6/10 trusted evidence association is immutable while sync-state-only recovery remains legal'
reset role;
do $$
declare
  downgrade_blocked boolean := false;
begin
  begin
    update public.media_assets
    set purpose = 'before', incident_id = null
    where id = '95300000-0000-4000-8000-000000000101';
  exception when others then
    if position('INCIDENT_MEDIA_IMMUTABLE_ASSOCIATION' in sqlerrm) > 0 then
      downgrade_blocked := true;
    else
      raise;
    end if;
  end;
  if not downgrade_blocked then
    raise exception 'Trusted evidence downgraded into ordinary customer media';
  end if;
end;
$$;
update public.media_assets
set sync_state = 'failed'
where id = '95300000-0000-4000-8000-000000000101';
do $$
begin
  if not exists (
    select 1
    from public.media_assets
    where id = '95300000-0000-4000-8000-000000000101'
      and purpose = 'incident'
      and incident_id = '95300000-0000-4000-8000-000000000001'
      and not customer_visible
      and sync_state = 'failed'
  ) then
    raise exception 'Sync-state-only recovery changed protected evidence facts';
  end if;
end;
$$;

\echo '7/10 customer cannot read finalized private incident evidence'
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
  visible_count integer;
  protected boolean := false;
begin
  begin
    select count(*)
    into visible_count
    from public.media_assets
    where id between
      '95300000-0000-4000-8000-000000000101'
      and '95300000-0000-4000-8000-000000000103';
    protected := visible_count = 0;
  exception when insufficient_privilege then
    protected := true;
  end;
  if not protected then
    raise exception 'Customer read private incident evidence metadata';
  end if;
end;
$$;

\echo '8/10 queued pre-closure evidence survives closure with an audit event'
reset role;
create temporary table incident_evidence_close_request (
  expected_version integer not null,
  payload jsonb not null,
  request_hash text
) on commit drop;
grant select on incident_evidence_close_request to authenticated;
insert into incident_evidence_close_request(expected_version, payload)
select
  incident.version,
  jsonb_build_object(
    'entityId', incident.id,
    'closureNote', 'Owner verified corrective action and preserved queued evidence.'
  )
from public.incidents incident
where incident.id = '95300000-0000-4000-8000-000000000001';
update incident_evidence_close_request request
set request_hash = public.storyops_json_sha256(jsonb_build_object(
  'commandType', 'incident.close',
  'expectedVersion', request.expected_version,
  'payload', request.payload
));

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
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
select public.execute_storyops_command(
  '10000000-0000-4000-8000-000000000001',
  '95300000-0000-4000-8000-000000000021',
  'incident.close',
  request.expected_version,
  request.payload,
  request.request_hash
)
from incident_evidence_close_request request;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.finalize_storyops_media_upload(
  '10000000-0000-4000-8000-000000000001',
  packet.command_id,
  '10000000-0000-4000-8000-000000000103',
  packet.payload,
  packet.request_hash
)
from incident_evidence_packets packet
where packet.asset_id = '95300000-0000-4000-8000-000000000104';

reset role;
do $$
begin
  if not exists (
    select 1
    from public.media_assets media
    where media.id = '95300000-0000-4000-8000-000000000104'
      and media.incident_id = '95300000-0000-4000-8000-000000000001'
      and not media.customer_visible
  ) or not exists (
    select 1
    from public.audit_events event
    where event.action = 'incident.evidence_late_attachment'
      and event.entity_id = '95300000-0000-4000-8000-000000000104'
      and event.retain_until >= now() + interval '6 years 11 months'
  ) then
    raise exception 'Late pre-closure evidence or its retained audit event is missing';
  end if;
end;
$$;

\echo '9/10 exact closed path may stage, but post-closure capture cannot finalize'
insert into incident_evidence_packets(
  command_id, asset_id, incident_id, purpose, checksum_sha256, captured_at
)
select
  '95300000-0000-4000-8000-000000000205',
  '95300000-0000-4000-8000-000000000105',
  incident.id,
  'incident',
  repeat('e', 64),
  incident.closed_at + interval '5 minutes 1 second'
from public.incidents incident
where incident.id = '95300000-0000-4000-8000-000000000001';
update incident_evidence_packets packet
set
  object_path = concat(
    '10000000-0000-4000-8000-000000000001/incidents/',
    packet.incident_id,
    '/visits/10000000-0000-4000-8000-000000000641/',
    packet.asset_id,
    '-',
    left(packet.checksum_sha256, 16),
    '-post-closure.png'
  )
where packet.asset_id = '95300000-0000-4000-8000-000000000105';
update incident_evidence_packets packet
set payload = jsonb_build_object(
  'entityId', packet.asset_id,
  'visitId', '10000000-0000-4000-8000-000000000641',
  'jobId', '10000000-0000-4000-8000-000000000631',
  'propertyId', '10000000-0000-4000-8000-000000000211',
  'incidentId', packet.incident_id,
  'purpose', packet.purpose,
  'objectPath', packet.object_path,
  'contentType', 'image/png',
  'byteSize', 1024,
  'checksumSha256', packet.checksum_sha256,
  'capturedAt', packet.captured_at,
  'customerVisible', false
)
where packet.asset_id = '95300000-0000-4000-8000-000000000105';
update incident_evidence_packets packet
set request_hash = public.storyops_json_sha256(jsonb_build_object(
  'commandType', 'media.register',
  'expectedVersion', 0,
  'payload', packet.payload
))
where packet.asset_id = '95300000-0000-4000-8000-000000000105';

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
insert into storage.objects(bucket_id, name, metadata)
select
  'job-media',
  packet.object_path,
  '{"size":1024,"mimetype":"image/png"}'::jsonb
from incident_evidence_packets packet
where packet.asset_id = '95300000-0000-4000-8000-000000000105';

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.finalize_storyops_media_upload(
      '10000000-0000-4000-8000-000000000001',
      packet.command_id,
      '10000000-0000-4000-8000-000000000103',
      packet.payload,
      packet.request_hash
    )
    from incident_evidence_packets packet
    where packet.asset_id = '95300000-0000-4000-8000-000000000105';
  exception when others then
    if position('permitted recovery window' in sqlerrm) > 0
      or position('capture-time scope' in sqlerrm) > 0
    then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'Post-closure capture was accepted';
  end if;
end;
$$;
reset role;
do $$
begin
  if exists (
    select 1 from public.media_assets
    where id = '95300000-0000-4000-8000-000000000105'
  ) then
    raise exception 'Post-closure capture finalized against a closed incident';
  end if;
end;
$$;

\echo '10/10 finalizer rejects inactive/cross-company, cross-visit, and nonexistent incident scope'
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  cross_company_blocked boolean := false;
  cross_visit_blocked boolean := false;
  missing_incident_blocked boolean := false;
  bad_payload jsonb;
begin
  select jsonb_set(
    jsonb_set(
      packet.payload,
      '{entityId}',
      to_jsonb('95300000-0000-4000-8000-000000000106'::text)
    ),
    '{objectPath}',
    to_jsonb(
      'ffffffff-ffff-4fff-8fff-ffffffffffff/incidents/'
      || packet.incident_id::text
      || '/visits/10000000-0000-4000-8000-000000000641/'
      || '95300000-0000-4000-8000-000000000106-'
      || left(packet.checksum_sha256, 16)
      || '-cross-company.png'
    )
  )
  into bad_payload
  from incident_evidence_packets packet
  where packet.asset_id = '95300000-0000-4000-8000-000000000102';
  begin
    perform public.finalize_storyops_media_upload(
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '95300000-0000-4000-8000-000000000206',
      '10000000-0000-4000-8000-000000000103',
      bad_payload,
      public.storyops_json_sha256(jsonb_build_object(
        'commandType', 'media.register',
        'expectedVersion', 0,
        'payload', bad_payload
      ))
    );
  exception when others then
    cross_company_blocked := true;
  end;

  select jsonb_set(
    packet.payload,
    '{visitId}',
    to_jsonb('ffffffff-ffff-4fff-8fff-ffffffffffff'::text)
  )
  into bad_payload
  from incident_evidence_packets packet
  where packet.asset_id = '95300000-0000-4000-8000-000000000102';
  begin
    perform public.finalize_storyops_media_upload(
      '10000000-0000-4000-8000-000000000001',
      '95300000-0000-4000-8000-000000000207',
      '10000000-0000-4000-8000-000000000103',
      bad_payload,
      public.storyops_json_sha256(jsonb_build_object(
        'commandType', 'media.register',
        'expectedVersion', 0,
        'payload', bad_payload
      ))
    );
  exception when others then
    cross_visit_blocked := true;
  end;

  select jsonb_set(
    packet.payload,
    '{incidentId}',
    to_jsonb('ffffffff-ffff-4fff-8fff-ffffffffffff'::text)
  )
  into bad_payload
  from incident_evidence_packets packet
  where packet.asset_id = '95300000-0000-4000-8000-000000000102';
  begin
    perform public.finalize_storyops_media_upload(
      '10000000-0000-4000-8000-000000000001',
      '95300000-0000-4000-8000-000000000208',
      '10000000-0000-4000-8000-000000000103',
      bad_payload,
      public.storyops_json_sha256(jsonb_build_object(
        'commandType', 'media.register',
        'expectedVersion', 0,
        'payload', bad_payload
      ))
    );
  exception when others then
    missing_incident_blocked := true;
  end;
  if not cross_company_blocked or not cross_visit_blocked or not missing_incident_blocked then
    raise exception 'Finalizer scope rejection failed: company %, visit %, incident %',
      cross_company_blocked, cross_visit_blocked, missing_incident_blocked;
  end if;
end;
$$;

rollback;
