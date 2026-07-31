\set ON_ERROR_STOP on

begin;

update public.visits
set
  status = 'on_site',
  internal_notes = null
where id = '10000000-0000-4000-8000-000000000641';

update public.visit_checklist_items
set
  status = 'pending',
  completed_at = null,
  completed_by = null
where visit_id = '10000000-0000-4000-8000-000000000641';

delete from public.completion_signatures
where visit_id = '10000000-0000-4000-8000-000000000641';
delete from public.media_assets
where visit_id = '10000000-0000-4000-8000-000000000641';
delete from public.time_entries
where visit_id = '10000000-0000-4000-8000-000000000641';
delete from public.material_usage
where visit_id = '10000000-0000-4000-8000-000000000641';
delete from public.incidents
where visit_id = '10000000-0000-4000-8000-000000000641';

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

\echo '1/10 technician field projection includes safe materials and assigned checklist definitions'
do $$
declare
  field_reference jsonb;
begin
  field_reference := public.get_storyops_field_reference(
    '10000000-0000-4000-8000-000000000001'
  );
  if jsonb_array_length(field_reference -> 'materials') <> 2
    or exists (
      select 1
      from jsonb_array_elements(field_reference -> 'materials') material
      where coalesce((material ->> 'requiresSds')::boolean, true)
        or material -> 'sdsDocument' <> 'null'::jsonb
    )
    or not exists (
      select 1
      from jsonb_array_elements(field_reference -> 'checklistDefinitions') item
      where item ->> 'label' = 'Review property hazards and stop-work conditions'
        and (item ->> 'required')::boolean
        and (item ->> 'safetyCritical')::boolean
    )
  then
    raise exception 'Technician field safety projection is incomplete or unsafe';
  end if;
end;
$$;

reset role;
insert into public.materials(
  id, company_id, sku, name, unit, quantity_on_hand, reorder_point, requires_sds, active
)
values (
  '97000000-0000-4000-8000-000000000822',
  '10000000-0000-4000-8000-000000000001',
  'TEST-REQUIRES-SDS',
  'SDS-gated test material',
  'gal',
  1,
  0,
  true,
  true
);
set local role authenticated;

\echo '2/10 completion blocks incomplete required checklist work'
do $$
declare
  visit_version integer;
  blocked boolean := false;
begin
  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000901',
      'visit.transition',
      visit_version,
      '{"entityId":"10000000-0000-4000-8000-000000000641","status":"completed"}'::jsonb,
      repeat('1', 64)
    );
  exception
    when others then
      if position('checklist work is incomplete' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then raise exception 'Incomplete checklist allowed completion'; end if;
end;
$$;

reset role;
update public.visit_checklist_items
set
  status = 'complete',
  completed_at = now(),
  completed_by = '10000000-0000-4000-8000-000000000103'
where visit_id = '10000000-0000-4000-8000-000000000641';
set local role authenticated;

\echo '3/10 completion blocks missing before and after evidence'
do $$
declare
  visit_version integer;
  blocked boolean := false;
begin
  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000902',
      'visit.transition',
      visit_version,
      '{"entityId":"10000000-0000-4000-8000-000000000641","status":"completed"}'::jsonb,
      repeat('2', 64)
    );
  exception
    when others then
      if position('Before and after evidence' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then raise exception 'Missing media allowed completion'; end if;
end;
$$;

\echo '4/10 durable before, after, signature, and timer records enforce stopped-time gate'
reset role;
insert into storage.objects(bucket_id, name, metadata)
values
  (
    'job-media',
    '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/97000000-0000-4000-8000-000000000811-aaaaaaaaaaaaaaaa-safety-before.png',
    '{"size":1024,"mimetype":"image/png"}'::jsonb
  ),
  (
    'job-media',
    '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/97000000-0000-4000-8000-000000000812-bbbbbbbbbbbbbbbb-safety-after.png',
    '{"size":1024,"mimetype":"image/png"}'::jsonb
  ),
  (
    'job-media',
    '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/97000000-0000-4000-8000-000000000813-cccccccccccccccc-safety-signature.png',
    '{"size":2048,"mimetype":"image/png"}'::jsonb
  );
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
  bypass_blocked boolean := false;
begin
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000910',
      'media.register',
      0,
      jsonb_build_object(
        'entityId', '97000000-0000-4000-8000-000000000810',
        'visitId', '10000000-0000-4000-8000-000000000641',
        'jobId', '10000000-0000-4000-8000-000000000631',
        'propertyId', '10000000-0000-4000-8000-000000000211',
        'purpose', 'before',
        'objectPath', '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/97000000-0000-4000-8000-000000000811-aaaaaaaaaaaaaaaa-safety-before.png',
        'contentType', 'image/png',
        'byteSize', 1024,
        'checksumSha256', repeat('a', 64),
        'capturedAt', now(),
        'customerVisible', false
      ),
      repeat('2', 64)
    );
  exception
    when others then
      if position('trusted field-media finalizer' in sqlerrm) > 0 then
        bypass_blocked := true;
      else
        raise;
      end if;
  end;
  if not bypass_blocked then
    raise exception 'Authenticated media.register bypassed the field-media finalizer';
  end if;
end;
$$;

reset role;
-- The Edge finalizer supplies this canonical request hash in production.
-- Grant only the pure hash helpers inside this rolled-back SQL fixture.
grant execute on function public.storyops_canonical_json(jsonb) to service_role;
grant execute on function public.storyops_json_sha256(jsonb) to service_role;
grant execute on function public.storyops_canonical_json(jsonb) to authenticated;
grant execute on function public.storyops_json_sha256(jsonb) to authenticated;
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

do $$
declare
  media_payload jsonb;
begin
  media_payload := jsonb_build_object(
    'entityId', '97000000-0000-4000-8000-000000000811',
    'visitId', '10000000-0000-4000-8000-000000000641',
    'jobId', '10000000-0000-4000-8000-000000000631',
    'propertyId', '10000000-0000-4000-8000-000000000211',
    'purpose', 'before',
    'objectPath', '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/97000000-0000-4000-8000-000000000811-aaaaaaaaaaaaaaaa-safety-before.png',
    'contentType', 'image/png',
    'byteSize', 1024,
    'checksumSha256', repeat('a', 64),
    'capturedAt', now(),
    'customerVisible', false
  );
  perform public.finalize_storyops_media_upload(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000911',
    '10000000-0000-4000-8000-000000000103',
    media_payload,
    public.storyops_json_sha256(jsonb_build_object(
      'commandType', 'media.register',
      'expectedVersion', 0,
      'payload', media_payload
    ))
  );
  media_payload := jsonb_build_object(
    'entityId', '97000000-0000-4000-8000-000000000812',
    'visitId', '10000000-0000-4000-8000-000000000641',
    'jobId', '10000000-0000-4000-8000-000000000631',
    'propertyId', '10000000-0000-4000-8000-000000000211',
    'purpose', 'after',
    'objectPath', '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/97000000-0000-4000-8000-000000000812-bbbbbbbbbbbbbbbb-safety-after.png',
    'contentType', 'image/png',
    'byteSize', 1024,
    'checksumSha256', repeat('b', 64),
    'capturedAt', now(),
    'customerVisible', false
  );
  perform public.finalize_storyops_media_upload(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000912',
    '10000000-0000-4000-8000-000000000103',
    media_payload,
    public.storyops_json_sha256(jsonb_build_object(
      'commandType', 'media.register',
      'expectedVersion', 0,
      'payload', media_payload
    ))
  );
  media_payload := jsonb_build_object(
    'entityId', '97000000-0000-4000-8000-000000000813',
    'visitId', '10000000-0000-4000-8000-000000000641',
    'jobId', '10000000-0000-4000-8000-000000000631',
    'propertyId', '10000000-0000-4000-8000-000000000211',
    'purpose', 'signature',
    'objectPath', '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/97000000-0000-4000-8000-000000000813-cccccccccccccccc-safety-signature.png',
    'contentType', 'image/png',
    'byteSize', 2048,
    'checksumSha256', repeat('c', 64),
    'capturedAt', now(),
    'customerVisible', false
  );
  perform public.finalize_storyops_media_upload(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000913',
    '10000000-0000-4000-8000-000000000103',
    media_payload,
    public.storyops_json_sha256(jsonb_build_object(
      'commandType', 'media.register',
      'expectedVersion', 0,
      'payload', media_payload
    ))
  );
end;
$$;

reset role;
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
  visit_version integer;
  blocked boolean := false;
begin
  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000914',
    'signature.capture',
    0,
    jsonb_build_object(
      'entityId', '97000000-0000-4000-8000-000000000814',
      'visitId', '10000000-0000-4000-8000-000000000641',
      'signerName', 'Casey Customer',
      'signerRole', 'customer',
      'signedAt', now(),
      'signatureAssetId', '97000000-0000-4000-8000-000000000813',
      'disclosureVersion', 'completion-v1'
    ),
    repeat('6', 64)
  );
  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000915',
    'time.start',
    0,
    jsonb_build_object(
      'entityId', '97000000-0000-4000-8000-000000000815',
      'visitId', '10000000-0000-4000-8000-000000000641',
      'startedAt', now() - interval '10 minutes'
    ),
    repeat('7', 64)
  );
  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000916',
      'visit.transition',
      visit_version,
      '{"entityId":"10000000-0000-4000-8000-000000000641","status":"completed"}'::jsonb,
      repeat('8', 64)
    );
  exception
    when others then
      if position('timers must be stopped' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then raise exception 'Open timer allowed completion'; end if;
end;
$$;

select public.execute_storyops_command(
  '10000000-0000-4000-8000-000000000001',
  '97000000-0000-4000-8000-000000000917',
  'time.stop',
  1,
  jsonb_build_object(
    'entityId', '97000000-0000-4000-8000-000000000815',
    'endedAt', now()
  ),
  repeat('9', 64)
);

\echo '5/10 completion blocks missing notes, then missing material usage'
do $$
declare
  visit_version integer;
  blocked boolean := false;
begin
  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000918',
      'visit.transition',
      visit_version,
      '{"entityId":"10000000-0000-4000-8000-000000000641","status":"completed"}'::jsonb,
      repeat('a', 64)
    );
  exception
    when others then
      if position('Internal completion notes' in sqlerrm) > 0 then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Missing notes allowed completion'; end if;

  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000919',
    'visit.notes.update',
    visit_version,
    jsonb_build_object(
      'entityId', '10000000-0000-4000-8000-000000000641',
      'notes', 'Completed the approved scope and observed no property exception.'
    ),
    repeat('b', 64)
  );
  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';
  blocked := false;
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000920',
      'visit.transition',
      visit_version,
      '{"entityId":"10000000-0000-4000-8000-000000000641","status":"completed"}'::jsonb,
      repeat('c', 64)
    );
  exception
    when others then
      if position('material usage record' in sqlerrm) > 0 then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Missing material usage allowed completion'; end if;
end;
$$;

\echo '6/10 non-chemical material usage is accepted and required-SDS gaps are blocked'
do $$
declare
  blocked boolean := false;
begin
  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000921',
    'material.record',
    0,
    jsonb_build_object(
      'entityId', '97000000-0000-4000-8000-000000000821',
      'visitId', '10000000-0000-4000-8000-000000000641',
      'materialId', '10000000-0000-4000-8000-000000000613',
      'quantity', '1.0000',
      'unit', 'each',
      'recordedAt', now()
    ),
    repeat('d', 64)
  );

  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000922',
      'material.record',
      0,
      jsonb_build_object(
        'entityId', '97000000-0000-4000-8000-000000000823',
        'visitId', '10000000-0000-4000-8000-000000000641',
        'materialId', '97000000-0000-4000-8000-000000000822',
        'quantity', '0.1000',
        'unit', 'gal',
        'recordedAt', now()
      ),
      repeat('e', 64)
    );
  exception
    when others then
      if position('required SDS is missing' in sqlerrm) > 0 then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Material requiring a missing SDS was recorded'; end if;
end;
$$;

\echo '7/10 legacy visit incident insert is retired and atomic stop-work blocks completion'
do $$
declare
  visit_version integer;
  blocked boolean := false;
  payload jsonb;
  receipt jsonb;
begin
  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';

  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000923',
      'incident.report',
      0,
      jsonb_build_object(
        'entityId', '97000000-0000-4000-8000-000000000824',
        'incidentNumber', 'INC-FIELD-SAFETY-1',
        'jobId', '10000000-0000-4000-8000-000000000631',
        'visitId', '10000000-0000-4000-8000-000000000641',
        'propertyId', '10000000-0000-4000-8000-000000000211',
        'severity', 'minor',
        'category', 'other',
        'occurredAt', now(),
        'summary', 'A disposal bag tore during cleanup.',
        'immediateActions', 'Work paused and debris was contained.',
        'requiresLegalReview', false
      ),
      repeat('f', 64)
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
    raise exception 'Legacy visit-linked incident report bypassed atomic stop-work';
  end if;

  payload := jsonb_build_object(
    'schemaVersion', 'storyops-incident-pause-v1',
    'action', 'incident.report_pause',
    'actorUserId', '10000000-0000-4000-8000-000000000103',
    'entityId', '97000000-0000-4000-8000-000000000824',
    'incidentNumber', 'INC-FIELD-SAFETY-1',
    'jobId', '10000000-0000-4000-8000-000000000631',
    'visitId', '10000000-0000-4000-8000-000000000641',
    'propertyId', '10000000-0000-4000-8000-000000000211',
    'severity', 'minor',
    'category', 'other',
    'occurredAt', now(),
    'requestedAt', now(),
    'summary', 'A disposal bag tore during cleanup.',
    'immediateActions', 'Work paused and debris was contained.',
    'requiresLegalReview', false
  );
  receipt := public.report_storyops_incident_and_pause(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000933',
    visit_version,
    payload,
    public.storyops_json_sha256(jsonb_build_object(
      'commandType', 'incident.report_pause',
      'expectedVersion', visit_version,
      'payload', payload
    ))
  );
  if receipt #>> '{visit,currentStatus}' <> 'paused'
    or receipt #>> '{incident,status}' <> 'open'
  then
    raise exception 'Atomic incident stop-work receipt was not durable';
  end if;

  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';
  blocked := false;
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000924',
      'visit.transition',
      visit_version,
      '{"entityId":"10000000-0000-4000-8000-000000000641","status":"completed"}'::jsonb,
      repeat('0', 64)
    );
  exception
    when others then
      if position('Open incident work' in sqlerrm) > 0 then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Unresolved incident allowed completion'; end if;
end;
$$;

\echo '8/10 technician, dispatcher, and customer cannot close incidents or read unauthorized safety metadata'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000925',
      'incident.close',
      1,
      '{"entityId":"97000000-0000-4000-8000-000000000824","closureNote":"Verified cleanup is complete."}'::jsonb,
      repeat('1', 64)
    );
  exception
    when others then
      if sqlerrm = 'INCIDENT_CLOSE_OWNER_REQUIRED' then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Technician closed an incident'; end if;
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

do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000926',
      'incident.close',
      1,
      '{"entityId":"97000000-0000-4000-8000-000000000824","closureNote":"Verified cleanup is complete."}'::jsonb,
      repeat('2', 64)
    );
  exception
    when others then
      if sqlerrm = 'INCIDENT_CLOSE_OWNER_REQUIRED' then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Dispatcher closed an incident'; end if;
end;
$$;

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
  close_blocked boolean := false;
  projection_blocked boolean := false;
begin
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000927',
      'incident.close',
      1,
      '{"entityId":"97000000-0000-4000-8000-000000000824","closureNote":"Verified cleanup is complete."}'::jsonb,
      repeat('3', 64)
    );
  exception
    when others then
      if sqlerrm = 'INCIDENT_CLOSE_OWNER_REQUIRED' then close_blocked := true; else raise; end if;
  end;
  begin
    perform public.get_storyops_field_reference(
      '10000000-0000-4000-8000-000000000001'
    );
  exception
    when others then
      if sqlerrm = 'FIELD_PACKET_ROLE_DENIED' then
        projection_blocked := true;
      else
        raise;
      end if;
  end;
  if not close_blocked or not projection_blocked then
    raise exception 'Customer incident closure or field reference access was not blocked';
  end if;
end;
$$;

\echo '9/10 owner closure is exact, versioned, durable, idempotent, and stale-safe'
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
  blocked boolean := false;
  first_result jsonb;
  replay_result jsonb;
begin
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000928',
      'incident.close',
      1,
      '{"entityId":"97000000-0000-4000-8000-000000000824","closureNote":"bad"}'::jsonb,
      repeat('4', 64)
    );
  exception
    when others then
      if sqlerrm = 'INCIDENT_CLOSE_NOTE_INVALID' then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Short incident closure note was accepted'; end if;

  blocked := false;
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000929',
      'incident.close',
      1,
      '{"entityId":"97000000-0000-4000-8000-000000000824","closureNote":"Verified cleanup is complete.","sendMessage":true}'::jsonb,
      repeat('5', 64)
    );
  exception
    when others then
      if sqlerrm = 'INCIDENT_CLOSE_EXACT_PAYLOAD_REQUIRED' then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Expanded incident closure payload was accepted'; end if;

  first_result := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000930',
    'incident.close',
    1,
    '{"entityId":"97000000-0000-4000-8000-000000000824","closureNote":"Owner verified debris containment and completed cleanup."}'::jsonb,
    public.storyops_json_sha256(jsonb_build_object(
      'commandType', 'incident.close',
      'expectedVersion', 1,
      'payload', '{"entityId":"97000000-0000-4000-8000-000000000824","closureNote":"Owner verified debris containment and completed cleanup."}'::jsonb
    ))
  );
  replay_result := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000930',
    'incident.close',
    1,
    '{"entityId":"97000000-0000-4000-8000-000000000824","closureNote":"Owner verified debris containment and completed cleanup."}'::jsonb,
    public.storyops_json_sha256(jsonb_build_object(
      'commandType', 'incident.close',
      'expectedVersion', 1,
      'payload', '{"entityId":"97000000-0000-4000-8000-000000000824","closureNote":"Owner verified debris containment and completed cleanup."}'::jsonb
    ))
  );
  if (first_result ->> 'version')::integer <> 2
    or coalesce((first_result ->> 'replayed')::boolean, true)
    or not coalesce((replay_result ->> 'replayed')::boolean, false)
  then
    raise exception 'Incident closure replay receipt is invalid';
  end if;
  blocked := false;
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000931',
      'incident.close',
      1,
      '{"entityId":"97000000-0000-4000-8000-000000000824","closureNote":"A stale closure cannot overwrite the record."}'::jsonb,
      public.storyops_json_sha256(jsonb_build_object(
        'commandType', 'incident.close',
        'expectedVersion', 1,
        'payload', '{"entityId":"97000000-0000-4000-8000-000000000824","closureNote":"A stale closure cannot overwrite the record."}'::jsonb
      ))
    );
  exception
    when others then
      if sqlerrm = 'INCIDENT_CLOSE_SCOPE_OR_VERSION_CONFLICT' then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then raise exception 'Stale incident closure was accepted'; end if;
end;
$$;

reset role;
do $$
begin
  if not exists (
    select 1
    from public.incidents incident
    where incident.id = '97000000-0000-4000-8000-000000000824'
      and incident.status = 'closed'
      and incident.closed_by = '10000000-0000-4000-8000-000000000101'
      and incident.closed_at is not null
      and incident.closure_note =
        'Owner verified debris containment and completed cleanup.'
      and incident.version = 2
  ) then
    raise exception 'Incident closure evidence is not durable';
  end if;
end;
$$;
set local role authenticated;

\echo '10/10 assigned technician completes only after every safety gate is satisfied'
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
  completion_result jsonb;
begin
  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';
  completion_result := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000932',
    'visit.transition',
    visit_version,
    '{"entityId":"10000000-0000-4000-8000-000000000641","status":"completed"}'::jsonb,
    repeat('8', 64)
  );
  if completion_result ->> 'entityId' <> '10000000-0000-4000-8000-000000000641'
    or not exists (
      select 1
      from jsonb_array_elements(
        public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
      ) visit
      where visit ->> 'id' = '10000000-0000-4000-8000-000000000641'
        and visit ->> 'status' = 'completed'
    )
  then
    raise exception 'Fully evidenced visit did not complete';
  end if;
end;
$$;

rollback;

\echo 'StoryOps live field safety contract passed'
