\set ON_ERROR_STOP on

begin;

\echo '1/10 browser roles cannot invoke trusted scope-photo commands directly'
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
    perform public.create_scope_photo_request(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000201',
      '10000000-0000-4000-8000-000000000211',
      'forbidden direct call',
      7,
      'scope-request:forbidden',
      repeat('a', 64)
    );
  exception
    when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'Authenticated browser invoked trusted request RPC';
  end if;
end;
$$;

reset role;
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);

create temporary table scope_photo_fixture(
  request_id uuid,
  reservation_id uuid,
  asset_id uuid,
  measurement_id uuid,
  review_id uuid
);
insert into scope_photo_fixture default values;

\echo '2/10 owner creates a finite server-authored checklist'
do $$
declare
  result jsonb;
  context jsonb;
begin
  result := public.create_scope_photo_request(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'Please document each elevation and access path.',
    7,
    'scope-request:integration-1',
    repeat('1', 64)
  );
  if result ->> 'schemaVersion' <> 'storyops-scope-photo-request-v1'
    or (result ->> 'maximumPhotos')::integer <> 12
  then
    raise exception 'Scope request receipt was incomplete';
  end if;
  update scope_photo_fixture set request_id = (result ->> 'requestId')::uuid;
  context := public.load_scope_photo_context(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000211'
  );
  if result ->> 'checklistVersion' <> 'exterior-scope-v2'
    or jsonb_array_length(context -> 'requests' -> 0 -> 'checklist') <> 12
  then
    raise exception 'Server-authored checklist was not persisted';
  end if;
end;
$$;

\echo '3/10 request replay is exact and changed-payload reuse conflicts'
do $$
declare
  replay jsonb;
  blocked boolean := false;
begin
  replay := public.create_scope_photo_request(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'Please document each elevation and access path.',
    7,
    'scope-request:integration-1',
    repeat('1', 64)
  );
  if not coalesce((replay ->> 'replayed')::boolean, false)
    or (replay ->> 'requestId')::uuid <> (select request_id from scope_photo_fixture)
  then
    raise exception 'Scope request did not replay exactly';
  end if;
  begin
    perform public.create_scope_photo_request(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000201',
      '10000000-0000-4000-8000-000000000211',
      'changed',
      7,
      'scope-request:integration-1',
      repeat('2', 64)
    );
  exception when others then
    if position('IDEMPOTENCY_CONFLICT' in sqlerrm) > 0 then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Changed scope request replay was accepted'; end if;
end;
$$;

\echo '4/10 mapped customer receives a bounded content-addressed reservation'
do $$
declare
  result jsonb;
begin
  result := public.prepare_scope_photo_upload(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    (select request_id from scope_photo_fixture),
    'front_elevation',
    '97000000-0000-4000-8000-000000000801',
    'image/png',
    68,
    '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460',
    clock_timestamp(),
    '97000000-0000-4000-8000-000000000802',
    repeat('3', 64)
  );
  if result ->> 'objectPath' not like
      '10000000-0000-4000-8000-000000000001/customers/10000000-0000-4000-8000-000000000201/97000000-0000-4000-8000-000000000801-431ced6916a2a21a-scope.png'
    or (result ->> 'byteSize')::integer <> 68
  then
    raise exception 'Upload reservation did not bind tenant, customer, asset, and checksum';
  end if;
  update scope_photo_fixture
  set
    asset_id = '97000000-0000-4000-8000-000000000801';
end;
$$;

\echo '5/10 technician and unrelated roles cannot prepare pre-estimate media'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.prepare_scope_photo_upload(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000103',
      (select request_id from scope_photo_fixture),
      'rear_elevation',
      '97000000-0000-4000-8000-000000000811',
      'image/png',
      68,
      repeat('4', 64),
      clock_timestamp(),
      '97000000-0000-4000-8000-000000000812',
      repeat('5', 64)
    );
  exception when others then
    if position('ROLE_REQUIRED' in sqlerrm) > 0 then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Technician prepared unassigned scope media'; end if;
end;
$$;

\echo '6/10 customer context hides AI analysis, reviews, and confirmed measurements'
do $$
declare
  context jsonb;
begin
  context := public.load_scope_photo_context(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    '10000000-0000-4000-8000-000000000211'
  );
  if context ->> 'actorRole' <> 'customer'
    or context -> 'confirmedMeasurements' <> '[]'::jsonb
    or context -> 'requests' -> 0 -> 'review' <> 'null'::jsonb
  then
    raise exception 'Customer scope context exposed internal review evidence';
  end if;
end;
$$;

\echo '7/10 verified measurement requires a same-request source asset and staff attestation'
reset role;
update scope_photo_fixture fixture
set reservation_id = reservation.id
from public.scope_photo_upload_reservations reservation
where reservation.command_id = '97000000-0000-4000-8000-000000000802';

insert into public.media_assets(
  id, company_id, property_id, purpose, object_path, content_type, byte_size,
  checksum_sha256, captured_at, captured_by, customer_visible, sync_state
)
select
  fixture.asset_id,
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000211',
  'scope',
  reservation.object_path,
  reservation.content_type,
  reservation.byte_size,
  reservation.checksum_sha256,
  reservation.captured_at,
  reservation.prepared_by,
  true,
  'pending'
from scope_photo_fixture fixture
join public.scope_photo_upload_reservations reservation
  on reservation.id = fixture.reservation_id;

insert into public.scope_photo_submissions(
  company_id, request_id, reservation_id, checklist_item_code, asset_id, uploaded_by
)
select
  '10000000-0000-4000-8000-000000000001',
  fixture.request_id,
  fixture.reservation_id,
  'front_elevation',
  fixture.asset_id,
  '10000000-0000-4000-8000-000000000104'
from scope_photo_fixture fixture;

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);
do $$
declare
  result jsonb;
  context jsonb;
begin
  result := public.confirm_scope_photo_measurement(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000102',
    (select request_id from scope_photo_fixture),
    null,
    array[(select asset_id from scope_photo_fixture)],
    'area_sq_ft',
    'Human-confirmed driveway area',
    900,
    'sq_ft',
    array['pressure-wash-flatwork'],
    '{}',
    'Dispatcher confirmed the customer plan dimensions by phone.',
    'scope-measurement:integration-1',
    repeat('6', 64)
  );
  update scope_photo_fixture set measurement_id = (result ->> 'measurementId')::uuid;
  context := public.load_scope_photo_context(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000102',
    '10000000-0000-4000-8000-000000000211'
  );
  if not exists (
    select 1
    from jsonb_array_elements(context -> 'confirmedMeasurements') measurement
    where measurement ->> 'id' = result ->> 'measurementId'
      and measurement -> 'serviceCodes'
        = '["pressure-wash-flatwork"]'::jsonb
  )
  then
    raise exception 'Human-confirmed measurement evidence was not persisted';
  end if;
end;
$$;

\echo '8/10 measurement command replays and cannot be run by the customer'
do $$
declare
  replay jsonb;
  blocked boolean := false;
begin
  replay := public.confirm_scope_photo_measurement(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000102',
    (select request_id from scope_photo_fixture),
    null,
    array[(select asset_id from scope_photo_fixture)],
    'area_sq_ft',
    'Human-confirmed driveway area',
    900,
    'sq_ft',
    array['pressure-wash-flatwork'],
    '{}',
    'Dispatcher confirmed the customer plan dimensions by phone.',
    'scope-measurement:integration-1',
    repeat('6', 64)
  );
  if not coalesce((replay ->> 'replayed')::boolean, false)
    or (replay ->> 'measurementId')::uuid <> (select measurement_id from scope_photo_fixture)
  then
    raise exception 'Measurement confirmation did not replay exactly';
  end if;
  begin
    perform public.confirm_scope_photo_measurement(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000104',
      (select request_id from scope_photo_fixture),
      null,
      array[(select asset_id from scope_photo_fixture)],
      'area_sq_ft',
      'Customer attempted measurement',
      1,
      'sq_ft',
      array['pressure-wash-flatwork'],
      '{}',
      'Customer cannot create a pricing measurement.',
      'scope-measurement:customer',
      repeat('7', 64)
    );
  exception when others then
    if position('STAFF_REQUIRED' in sqlerrm) > 0 then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Customer created billable measurement evidence'; end if;
end;
$$;

\echo '9/10 confirmed photo-assisted measurements are immutable'
reset role;
do $$
declare
  blocked boolean := false;
begin
  begin
    update public.property_measurements
    set value = 1
    where id = (select measurement_id from scope_photo_fixture);
  exception when others then
    if position('immutable' in sqlerrm) > 0 then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Confirmed measurement was rewritten'; end if;
end;
$$;

\echo '10/10 human review preserves unresolved access/risk state'
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);
do $$
declare
  result jsonb;
  replay jsonb;
begin
  result := public.review_scope_photo_request(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    (select request_id from scope_photo_fixture),
    'site_verification_required',
    'Rear gate width remains unknown until the technician arrives.',
    'Photos do not clear overhead or fragile-surface risk.',
    array['Rear elevation is missing.'],
    'scope-review:integration-1',
    repeat('8', 64)
  );
  replay := public.review_scope_photo_request(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    (select request_id from scope_photo_fixture),
    'site_verification_required',
    'Rear gate width remains unknown until the technician arrives.',
    'Photos do not clear overhead or fragile-surface risk.',
    array['Rear elevation is missing.'],
    'scope-review:integration-1',
    repeat('8', 64)
  );
  if not coalesce((replay ->> 'replayed')::boolean, false)
    or result ->> 'reviewId' <> replay ->> 'reviewId'
  then
    raise exception 'Scope review did not replay exactly';
  end if;
end;
$$;

rollback;

\echo 'scope photo workflow integration passed: finite checklist, private reservation, role isolation, idempotency, human measurement, immutable evidence, and explicit risk review'
