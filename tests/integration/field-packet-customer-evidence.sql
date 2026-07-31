\set ON_ERROR_STOP on

begin;

\echo '1/7 assigned field packet preserves accepted scope and provider evidence truth'
-- This fixture exercises packet/evidence projection, while
-- scheduling-evidence-boundary.sql and property-geocode-review.sql own the
-- promotion and reviewed-live-geocode scheduling boundaries.
alter table public.visits disable trigger visits_scheduling_promotion_guard;
alter table public.visits disable trigger visits_reviewed_geocode_guard;
update public.visits
set status = 'confirmed'
where id = '10000000-0000-4000-8000-000000000641';
alter table public.visits enable trigger visits_reviewed_geocode_guard;
alter table public.visits enable trigger visits_scheduling_promotion_guard;

-- The browser/Edge path computes this canonical hash before invoking the RPC.
-- Grant it only inside this rolled-back SQL harness to reproduce that request.
grant execute on function public.storyops_canonical_json(jsonb)
  to authenticated, service_role;
grant execute on function public.storyops_json_sha256(jsonb)
  to authenticated, service_role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000103","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000103',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.headers', '{}', true);

do $$
declare
  packet jsonb;
begin
  select value
  into packet
  from jsonb_array_elements(
    public.get_storyops_field_reference(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'fieldPackets'
  )
  where value ->> 'visitId' = '10000000-0000-4000-8000-000000000641';

  if packet is null
    or jsonb_array_length(packet -> 'scopeLines') <> 3
    or packet #>> '{scopeLines,0,description}' <> 'Pressure Wash Flatwork'
    or (packet #>> '{scopeLines,0,quantity}')::numeric <> 850
    or packet #>> '{scopeLines,0,unit}' <> 'sq_ft'
    or packet ->> 'exclusionsStatus' <> 'not_recorded'
    or jsonb_array_length(packet -> 'exclusions') <> 0
    or packet #>> '{access,instructions}'
      <> 'Text on arrival; side gate is unlocked.'
    or packet #>> '{access,waterSourceNotes}'
      <> 'Exterior spigot on north wall.'
    or packet #>> '{access,drainageNotes}' is not null
    or packet #>> '{access,knownHazards,0}'
      <> 'decorative low-voltage lighting along driveway'
    or packet #>> '{routeEvidence,provider}' <> 'mock'
    or packet #>> '{routeEvidence,evidenceMode}' <> 'sandbox'
    or (packet #>> '{routeEvidence,driveMinutes}')::integer <> 24
    or packet #>> '{routeEvidence,distanceMiles}' <> '11.20'
    or packet #>> '{weatherEvidence,provider}' <> 'mock'
    or packet #>> '{weatherEvidence,evidenceMode}' <> 'sandbox'
    or packet #>> '{weatherEvidence,temperatureF}' <> '78.00'
    or packet #>> '{weatherEvidence,precipitationProbability}' <> '0.1000'
  then
    raise exception 'Field packet lost or invented scope/provider facts: %', packet;
  end if;
end;
$$;

\echo '2/7 field change request is exact, idempotent, request-only, and offline replayable'
do $$
declare
  packet jsonb;
  visit_version integer;
  payload jsonb;
  request_hash text;
  first_receipt jsonb;
  replay_receipt jsonb;
  conflicting_payload jsonb;
  conflict_blocked boolean := false;
begin
  select value
  into packet
  from jsonb_array_elements(
    public.get_storyops_field_reference(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'fieldPackets'
  )
  where value ->> 'visitId' = '10000000-0000-4000-8000-000000000641';
  visit_version := (packet ->> 'visitVersion')::integer;
  payload := jsonb_build_object(
    'entityId', '10000000-0000-4000-8000-000000000641',
    'reasonCode', 'scope_mismatch',
    'summary', 'The detached garage gutters are not listed in the accepted scope.'
  );
  request_hash := public.storyops_json_sha256(
    jsonb_build_object(
      'commandType', 'field.change_request',
      'expectedVersion', visit_version,
      'payload', payload
    )
  );
  first_receipt := public.submit_storyops_field_change_request(
    '10000000-0000-4000-8000-000000000001',
    '37000000-0000-4000-8000-000000000101',
    visit_version,
    payload,
    request_hash
  );
  replay_receipt := public.submit_storyops_field_change_request(
    '10000000-0000-4000-8000-000000000001',
    '37000000-0000-4000-8000-000000000101',
    visit_version,
    payload,
    request_hash
  );
  if first_receipt ->> 'commandType' <> 'field.change_request'
    or coalesce((first_receipt ->> 'replayed')::boolean, true)
    or not coalesce((replay_receipt ->> 'replayed')::boolean, false)
    or replay_receipt ->> 'requestHash' <> request_hash
    or not exists (
      select 1
      from jsonb_array_elements(
        public.get_storyops_field_reference(
          '10000000-0000-4000-8000-000000000001'
        ) -> 'fieldPackets'
      ) projected_packet,
      jsonb_array_elements(projected_packet -> 'changeRequests') request
      where projected_packet ->> 'visitId'
          = '10000000-0000-4000-8000-000000000641'
        and request ->> 'id' = '37000000-0000-4000-8000-000000000101'
        and request ->> 'status' = 'submitted'
        and request ->> 'reasonCode' = 'scope_mismatch'
    )
  then
    raise exception 'Field change receipt/projection was not exact: %, %',
      first_receipt, replay_receipt;
  end if;

  conflicting_payload := jsonb_build_object(
    'entityId', '10000000-0000-4000-8000-000000000641',
    'reasonCode', 'access_blocked',
    'summary', 'The east gate is locked and the crew cannot reach the accepted scope.'
  );
  begin
    perform public.submit_storyops_field_change_request(
      '10000000-0000-4000-8000-000000000001',
      '37000000-0000-4000-8000-000000000101',
      visit_version,
      conflicting_payload,
      public.storyops_json_sha256(
        jsonb_build_object(
          'commandType', 'field.change_request',
          'expectedVersion', visit_version,
          'payload', conflicting_payload
        )
      )
    );
  exception when others then
    conflict_blocked := sqlerrm = 'FIELD_CHANGE_COMMAND_CONFLICT';
  end;
  if not conflict_blocked then
    raise exception 'Field command ID accepted a different request';
  end if;
end;
$$;

\echo '3/7 direct request-table writes and customer field-packet reads are denied'
do $$
declare
  direct_write_blocked boolean := false;
begin
  begin
    insert into public.field_change_requests(
      id, company_id, visit_id, job_id, requested_by, reason_code, summary
    )
    values (
      '37000000-0000-4000-8000-000000000102',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000641',
      '10000000-0000-4000-8000-000000000631',
      '10000000-0000-4000-8000-000000000103',
      'other',
      'This direct table write must be denied.'
    );
  exception when insufficient_privilege then
    direct_write_blocked := true;
  end;
  if not direct_write_blocked then
    raise exception 'Authenticated technician bypassed the field request RPC';
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000104',
  true
);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_storyops_field_reference(
      '10000000-0000-4000-8000-000000000001'
    );
  exception when others then
    blocked := sqlerrm = 'FIELD_PACKET_ROLE_DENIED';
  end;
  if not blocked then
    raise exception 'Customer read the internal field packet';
  end if;
end;
$$;

\echo '4/7 trusted finalizer creates private durable before/after fixtures'
reset role;
update public.visits
set status = 'on_site'
where id = '10000000-0000-4000-8000-000000000641';

insert into storage.objects(bucket_id, name, metadata)
values
  (
    'job-media',
    '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/37000000-0000-4000-8000-000000000001-aaaaaaaaaaaaaaaa-before.png',
    '{"size":1024,"mimetype":"image/png"}'::jsonb
  ),
  (
    'job-media',
    '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/37000000-0000-4000-8000-000000000002-bbbbbbbbbbbbbbbb-after.png',
    '{"size":1024,"mimetype":"image/png"}'::jsonb
  );

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
with request(payload) as (
  values (jsonb_build_object(
    'entityId', '37000000-0000-4000-8000-000000000001',
    'visitId', '10000000-0000-4000-8000-000000000641',
    'jobId', '10000000-0000-4000-8000-000000000631',
    'propertyId', '10000000-0000-4000-8000-000000000211',
    'purpose', 'before',
    'objectPath', '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/37000000-0000-4000-8000-000000000001-aaaaaaaaaaaaaaaa-before.png',
    'contentType', 'image/png',
    'byteSize', 1024,
    'checksumSha256', repeat('a', 64),
    'capturedAt', clock_timestamp(),
    'customerVisible', false
  ))
)
select public.finalize_storyops_media_upload(
  '10000000-0000-4000-8000-000000000001',
  '37000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000103',
  request.payload,
  public.storyops_json_sha256(jsonb_build_object(
    'commandType', 'media.register',
    'expectedVersion', 0,
    'payload', request.payload
  ))
)
from request;
with request(payload) as (
  values (jsonb_build_object(
    'entityId', '37000000-0000-4000-8000-000000000002',
    'visitId', '10000000-0000-4000-8000-000000000641',
    'jobId', '10000000-0000-4000-8000-000000000631',
    'propertyId', '10000000-0000-4000-8000-000000000211',
    'purpose', 'after',
    'objectPath', '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/37000000-0000-4000-8000-000000000002-bbbbbbbbbbbbbbbb-after.png',
    'contentType', 'image/png',
    'byteSize', 1024,
    'checksumSha256', repeat('b', 64),
    'capturedAt', clock_timestamp(),
    'customerVisible', false
  ))
)
select public.finalize_storyops_media_upload(
  '10000000-0000-4000-8000-000000000001',
  '37000000-0000-4000-8000-000000000202',
  '10000000-0000-4000-8000-000000000103',
  request.payload,
  public.storyops_json_sha256(jsonb_build_object(
    'commandType', 'media.register',
    'expectedVersion', 0,
    'payload', request.payload
  ))
)
from request;

reset role;
update public.visits
set status = 'completed'
where id = '10000000-0000-4000-8000-000000000641';

\echo '5/7 customer cannot read private completion bytes or publish evidence'
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000104',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  portal jsonb;
  publish_blocked boolean := false;
begin
  portal := public.get_customer_portal_state(
    '10000000-0000-4000-8000-000000000001'
  );
  if jsonb_array_length(portal #> '{customers,0,completedWork}') <> 0
    or public.can_read_job_media_object(
      '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/37000000-0000-4000-8000-000000000001-aaaaaaaaaaaaaaaa-before.png'
    )
  then
    raise exception 'Private completion evidence leaked before publication';
  end if;
  begin
    perform public.publish_storyops_completed_work_evidence(
      '10000000-0000-4000-8000-000000000001',
      '37000000-0000-4000-8000-000000000301',
      '10000000-0000-4000-8000-000000000641',
      array['37000000-0000-4000-8000-000000000001']::uuid[],
      repeat('3', 64)
    );
  exception when others then
    publish_blocked := sqlerrm = 'COMPLETED_EVIDENCE_ROLE_DENIED';
  end;
  if not publish_blocked then
    raise exception 'Customer published their own completion evidence';
  end if;
end;
$$;

\echo '6/7 owner publication is explicit, idempotent, and metadata-only'
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
do $$
declare
  asset_ids uuid[] := array[
    '37000000-0000-4000-8000-000000000001',
    '37000000-0000-4000-8000-000000000002'
  ]::uuid[];
  request_hash text;
  receipt jsonb;
  replay jsonb;
  direct_update_blocked boolean := false;
begin
  begin
    update public.media_assets
    set customer_visible = true
    where id = '37000000-0000-4000-8000-000000000001';
  exception when insufficient_privilege then
    direct_update_blocked := true;
  end;
  if not direct_update_blocked then
    raise exception 'Owner bypassed explicit evidence publication';
  end if;

  request_hash := public.storyops_json_sha256(
    jsonb_build_object(
      'assetIds', to_jsonb(asset_ids),
      'commandType', 'completed_work.publish',
      'visitId', '10000000-0000-4000-8000-000000000641'::uuid
    )
  );
  receipt := public.publish_storyops_completed_work_evidence(
    '10000000-0000-4000-8000-000000000001',
    '37000000-0000-4000-8000-000000000302',
    '10000000-0000-4000-8000-000000000641',
    asset_ids,
    request_hash
  );
  replay := public.publish_storyops_completed_work_evidence(
    '10000000-0000-4000-8000-000000000001',
    '37000000-0000-4000-8000-000000000302',
    '10000000-0000-4000-8000-000000000641',
    asset_ids,
    request_hash
  );
  if receipt ->> 'schemaVersion' <> 'storyops-completed-work-publication-v1'
    or (receipt ->> 'publishedCount')::integer <> 2
    or coalesce((receipt ->> 'replayed')::boolean, true)
    or not coalesce((replay ->> 'replayed')::boolean, false)
  then
    raise exception 'Completed-work publication was not exact: %, %', receipt, replay;
  end if;
end;
$$;

\echo '7/7 customer sees only published completed before/after evidence; staff portal access is denied'
reset role;
do $$
begin
  if (
    select count(*)
    from public.media_assets media
    where media.id in (
      '37000000-0000-4000-8000-000000000001',
      '37000000-0000-4000-8000-000000000002'
    )
      and media.customer_visible
      and media.sync_state = 'synced'
      and media.purpose in ('before', 'after')
  ) <> 2
    or (
      select count(*)
      from storage.objects object
      where object.bucket_id = 'job-media'
        and object.name in (
          '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/37000000-0000-4000-8000-000000000001-aaaaaaaaaaaaaaaa-before.png',
          '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/37000000-0000-4000-8000-000000000002-bbbbbbbbbbbbbbbb-after.png'
        )
        and (object.metadata ->> 'size')::integer = 1024
        and object.metadata ->> 'mimetype' = 'image/png'
    ) <> 2
  then
    raise exception 'Publication changed durable object bytes or failed to publish exact metadata';
  end if;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000104',
  true
);
do $$
declare
  portal jsonb;
begin
  portal := public.get_customer_portal_state(
    '10000000-0000-4000-8000-000000000001'
  );
  if jsonb_array_length(portal #> '{customers,0,completedWork}') <> 1
    or portal #>> '{customers,0,completedWork,0,visitId}'
      <> '10000000-0000-4000-8000-000000000641'
    or jsonb_array_length(
      portal #> '{customers,0,completedWork,0,media}'
    ) <> 2
    or exists (
      select 1
      from jsonb_array_elements(
        portal #> '{customers,0,completedWork,0,media}'
      ) media
      where media ->> 'purpose' not in ('before', 'after')
        or media ->> 'id' not in (
          '37000000-0000-4000-8000-000000000001',
          '37000000-0000-4000-8000-000000000002'
        )
    )
    or not public.can_read_job_media_object(
      '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/37000000-0000-4000-8000-000000000001-aaaaaaaaaaaaaaaa-before.png'
    )
  then
    raise exception 'Completed-work customer projection escaped its eligibility boundary: %',
      portal;
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000103","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000103',
  true
);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_customer_portal_state(
      '10000000-0000-4000-8000-000000000001'
    );
  exception when others then
    blocked := sqlerrm = 'CUSTOMER_DEPOSIT_SCOPE_DENIED';
  end;
  if not blocked then
    raise exception 'Technician opened an authenticated customer portal projection';
  end if;
end;
$$;

rollback;
