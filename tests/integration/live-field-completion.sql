\set ON_ERROR_STOP on

begin;

\echo '1/9 visit notes require active assigned work'
update public.visit_checklist_items
set
  status = 'complete',
  completed_at = now(),
  completed_by = '10000000-0000-4000-8000-000000000103'
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
      '96000000-0000-4000-8000-000000000901',
      'visit.notes.update',
      visit_version,
      jsonb_build_object(
        'entityId', '10000000-0000-4000-8000-000000000641',
        'notes', 'This must not save before on-site work starts.'
      ),
      repeat('a', 64)
    );
  exception
    when others then
      if position('active-state conflict' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Visit notes were accepted before active work';
  end if;
end;
$$;

\echo '2/9 assigned technician reaches on-site state through versioned transitions'
do $$
declare
  visit_version integer;
begin
  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';

  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000902',
    'visit.transition',
    visit_version,
    '{"entityId":"10000000-0000-4000-8000-000000000641","status":"en_route"}'::jsonb,
    repeat('b', 64)
  );

  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';

  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000903',
    'visit.transition',
    visit_version,
    '{"entityId":"10000000-0000-4000-8000-000000000641","status":"on_site"}'::jsonb,
    repeat('c', 64)
  );
end;
$$;

\echo '3/9 note length, role, and assignment fail closed'
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
      '96000000-0000-4000-8000-000000000904',
      'visit.notes.update',
      visit_version,
      '{"entityId":"10000000-0000-4000-8000-000000000641","notes":"bad"}'::jsonb,
      repeat('d', 64)
    );
  exception
    when others then
      if position('5 through 4000' in sqlerrm) > 0 then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Short visit notes were accepted'; end if;
end;
$$;

reset role;
update public.crew_members
set ends_on = current_date - 1
where id = '10000000-0000-4000-8000-000000000602';
set local role authenticated;

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
      '96000000-0000-4000-8000-000000000905',
      'visit.notes.update',
      visit_version,
      '{"entityId":"10000000-0000-4000-8000-000000000641","notes":"Unassigned technicians cannot save this note."}'::jsonb,
      repeat('e', 64)
    );
  exception
    when others then
      if position('assignment' in sqlerrm) > 0 then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Unassigned technician visit notes were accepted'; end if;
end;
$$;

reset role;
update public.crew_members
set ends_on = null
where id = '10000000-0000-4000-8000-000000000602';
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
  blocked boolean := false;
begin
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '96000000-0000-4000-8000-000000000906',
      'visit.notes.update',
      3,
      '{"entityId":"10000000-0000-4000-8000-000000000641","notes":"Portal roles cannot save internal field notes."}'::jsonb,
      repeat('f', 64)
    );
  exception
    when others then
      if position('Role cannot update visit notes' in sqlerrm) > 0 then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'Customer role updated internal visit notes'; end if;
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

\echo '4/9 notes save once, replay idempotently, and reject a stale version'
do $$
declare
  before_version integer;
  first_result jsonb;
  replay_result jsonb;
  stale_blocked boolean := false;
begin
  select (visit ->> 'version')::integer into before_version
  from jsonb_array_elements(
    public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';

  first_result := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000907',
    'visit.notes.update',
    before_version,
    '{"entityId":"10000000-0000-4000-8000-000000000641","notes":"Scope completed without a property exception."}'::jsonb,
    repeat('1', 64)
  );
  replay_result := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000907',
    'visit.notes.update',
    before_version,
    '{"entityId":"10000000-0000-4000-8000-000000000641","notes":"Scope completed without a property exception."}'::jsonb,
    repeat('1', 64)
  );
  if (first_result ->> 'version')::integer <> before_version + 1
    or coalesce((first_result ->> 'replayed')::boolean, true)
    or not coalesce((replay_result ->> 'replayed')::boolean, false)
  then
    raise exception 'Visit notes idempotency receipt is invalid';
  end if;

  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '96000000-0000-4000-8000-000000000908',
      'visit.notes.update',
      before_version,
      '{"entityId":"10000000-0000-4000-8000-000000000641","notes":"A stale field packet must not overwrite the saved note."}'::jsonb,
      repeat('2', 64)
    );
  exception
    when others then
      if position('version' in sqlerrm) > 0 then stale_blocked := true; else raise; end if;
  end;
  if not stale_blocked then raise exception 'Stale visit notes version was accepted'; end if;
end;
$$;

\echo '5/9 authenticated callers cannot bypass the trusted media finalizer'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '96000000-0000-4000-8000-000000000910',
      'media.register',
      0,
      jsonb_build_object(
        'entityId', '96000000-0000-4000-8000-000000000810',
        'visitId', '10000000-0000-4000-8000-000000000641',
        'jobId', '10000000-0000-4000-8000-000000000631',
        'propertyId', '10000000-0000-4000-8000-000000000211',
        'purpose', 'before',
        'objectPath', '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/missing.png',
        'contentType', 'image/png',
        'byteSize', 1024,
        'checksumSha256', repeat('f', 64),
        'capturedAt', now()
      ),
      repeat('f', 64)
    );
  exception
    when others then
      if position('trusted field-media finalizer' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Authenticated media.register bypassed the trusted finalizer';
  end if;
end;
$$;

reset role;
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

\echo '6/9 the service finalizer refuses metadata without its durable Storage object'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.finalize_storyops_media_upload(
      '10000000-0000-4000-8000-000000000001',
      '96000000-0000-4000-8000-000000000909',
      '10000000-0000-4000-8000-000000000103',
      jsonb_build_object(
        'entityId', '96000000-0000-4000-8000-000000000809',
        'visitId', '10000000-0000-4000-8000-000000000641',
        'jobId', '10000000-0000-4000-8000-000000000631',
        'propertyId', '10000000-0000-4000-8000-000000000211',
        'purpose', 'before',
        'objectPath', '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/96000000-0000-4000-8000-000000000809-eeeeeeeeeeeeeeee-missing.png',
        'contentType', 'image/png',
        'byteSize', 1024,
        'checksumSha256', repeat('e', 64),
        'capturedAt', now(),
        'customerVisible', false
      ),
      repeat('e', 64)
    );
  exception
    when others then
      if position('durable Storage object' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Trusted media finalization accepted a missing Storage object';
  end if;
end;
$$;

reset role;
insert into storage.objects(bucket_id, name, metadata)
values
  (
    'job-media',
    '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/96000000-0000-4000-8000-000000000811-aaaaaaaaaaaaaaaa-before.png',
    '{"size":1024,"mimetype":"image/png"}'::jsonb
  ),
  (
    'job-media',
    '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/96000000-0000-4000-8000-000000000812-bbbbbbbbbbbbbbbb-after.png',
    '{"size":1024,"mimetype":"image/png"}'::jsonb
  ),
  (
    'job-media',
    '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/96000000-0000-4000-8000-000000000813-cccccccccccccccc-signature.png',
    '{"size":2048,"mimetype":"image/png"}'::jsonb
  );
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

\echo '7/9 trusted finalizer registers content-addressed PNG evidence idempotently'
do $$
declare
  first_result jsonb;
  replay_result jsonb;
begin
  first_result := public.finalize_storyops_media_upload(
    '10000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000911',
    '10000000-0000-4000-8000-000000000103',
    jsonb_build_object(
      'entityId', '96000000-0000-4000-8000-000000000811',
      'visitId', '10000000-0000-4000-8000-000000000641',
      'jobId', '10000000-0000-4000-8000-000000000631',
      'propertyId', '10000000-0000-4000-8000-000000000211',
      'purpose', 'before',
      'objectPath', '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/96000000-0000-4000-8000-000000000811-aaaaaaaaaaaaaaaa-before.png',
      'contentType', 'image/png',
      'byteSize', 1024,
      'checksumSha256', repeat('a', 64),
      'capturedAt', now(),
      'customerVisible', false
    ),
    repeat('3', 64)
  );
  replay_result := public.finalize_storyops_media_upload(
    '10000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000911',
    '10000000-0000-4000-8000-000000000103',
    jsonb_build_object(
      'entityId', '96000000-0000-4000-8000-000000000811',
      'visitId', '10000000-0000-4000-8000-000000000641',
      'jobId', '10000000-0000-4000-8000-000000000631',
      'propertyId', '10000000-0000-4000-8000-000000000211',
      'purpose', 'before',
      'objectPath', '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/96000000-0000-4000-8000-000000000811-aaaaaaaaaaaaaaaa-before.png',
      'contentType', 'image/png',
      'byteSize', 1024,
      'checksumSha256', repeat('a', 64),
      'capturedAt', now(),
      'customerVisible', false
    ),
    repeat('3', 64)
  );
  if coalesce((first_result ->> 'replayed')::boolean, true)
    or not coalesce((replay_result ->> 'replayed')::boolean, false)
  then
    raise exception 'Media finalizer replay receipt is invalid';
  end if;

  perform public.finalize_storyops_media_upload(
    '10000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000912',
    '10000000-0000-4000-8000-000000000103',
    jsonb_build_object(
      'entityId', '96000000-0000-4000-8000-000000000812',
      'visitId', '10000000-0000-4000-8000-000000000641',
      'jobId', '10000000-0000-4000-8000-000000000631',
      'propertyId', '10000000-0000-4000-8000-000000000211',
      'purpose', 'after',
      'objectPath', '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/96000000-0000-4000-8000-000000000812-bbbbbbbbbbbbbbbb-after.png',
      'contentType', 'image/png',
      'byteSize', 1024,
      'checksumSha256', repeat('b', 64),
      'capturedAt', now(),
      'customerVisible', false
    ),
    repeat('4', 64)
  );
  perform public.finalize_storyops_media_upload(
    '10000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000913',
    '10000000-0000-4000-8000-000000000103',
    jsonb_build_object(
      'entityId', '96000000-0000-4000-8000-000000000813',
      'visitId', '10000000-0000-4000-8000-000000000641',
      'jobId', '10000000-0000-4000-8000-000000000631',
      'propertyId', '10000000-0000-4000-8000-000000000211',
      'purpose', 'signature',
      'objectPath', '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/96000000-0000-4000-8000-000000000813-cccccccccccccccc-signature.png',
      'contentType', 'image/png',
      'byteSize', 2048,
      'checksumSha256', repeat('c', 64),
      'capturedAt', now(),
      'customerVisible', false
    ),
    repeat('5', 64)
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

\echo '8/9 signature capture bounds offline time and retains server receipt time'
do $$
declare
  signature_result jsonb;
  future_blocked boolean := false;
  stale_blocked boolean := false;
begin
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '96000000-0000-4000-8000-000000000917',
      'signature.capture',
      0,
      jsonb_build_object(
        'entityId', '96000000-0000-4000-8000-000000000817',
        'visitId', '10000000-0000-4000-8000-000000000641',
        'signerName', 'Future Customer',
        'signerRole', 'customer',
        'signedAt', now() + interval '10 minutes',
        'signatureAssetId', '96000000-0000-4000-8000-000000000813',
        'disclosureVersion', 'completion-v1'
      ),
      repeat('7', 64)
    );
  exception
    when others then
      if position('offline recovery window' in sqlerrm) > 0 then
        future_blocked := true;
      else
        raise;
      end if;
  end;
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '96000000-0000-4000-8000-000000000918',
      'signature.capture',
      0,
      jsonb_build_object(
        'entityId', '96000000-0000-4000-8000-000000000818',
        'visitId', '10000000-0000-4000-8000-000000000641',
        'signerName', 'Stale Customer',
        'signerRole', 'customer',
        'signedAt', now() - interval '8 days',
        'signatureAssetId', '96000000-0000-4000-8000-000000000813',
        'disclosureVersion', 'completion-v1'
      ),
      repeat('8', 64)
    );
  exception
    when others then
      if position('offline recovery window' in sqlerrm) > 0 then
        stale_blocked := true;
      else
        raise;
      end if;
  end;
  if not future_blocked or not stale_blocked then
    raise exception 'Signature timestamp window did not fail closed';
  end if;

  signature_result := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000914',
    'signature.capture',
    0,
    jsonb_build_object(
      'entityId', '96000000-0000-4000-8000-000000000814',
      'visitId', '10000000-0000-4000-8000-000000000641',
      'signerName', 'Casey Customer',
      'signerRole', 'customer',
      'signedAt', now(),
      'signatureAssetId', '96000000-0000-4000-8000-000000000813',
      'disclosureVersion', 'completion-v1'
    ),
    repeat('6', 64)
  );
  if signature_result ->> 'entityId' <> '96000000-0000-4000-8000-000000000814' then
    raise exception 'Completion signature receipt did not preserve its entity ID';
  end if;
end;
$$;

\echo '9/9 completion accepts durable evidence and closes later signature capture'
do $$
declare
  visit_version integer;
  completion_result jsonb;
  lifecycle_blocked boolean := false;
begin
  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000916',
    'material.record',
    0,
    jsonb_build_object(
      'entityId', '96000000-0000-4000-8000-000000000816',
      'visitId', '10000000-0000-4000-8000-000000000641',
      'materialId', '10000000-0000-4000-8000-000000000613',
      'quantity', '1.0000',
      'unit', 'each',
      'recordedAt', now()
    ),
    repeat('8', 64)
  );

  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace('10000000-0000-4000-8000-000000000001') -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';

  completion_result := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000915',
    'visit.transition',
    visit_version,
    '{"entityId":"10000000-0000-4000-8000-000000000641","status":"completed"}'::jsonb,
    repeat('7', 64)
  );
  if completion_result ->> 'entityId' <> '10000000-0000-4000-8000-000000000641' then
    raise exception 'Visit completion returned the wrong entity';
  end if;

  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '96000000-0000-4000-8000-000000000919',
      'signature.capture',
      0,
      jsonb_build_object(
        'entityId', '96000000-0000-4000-8000-000000000819',
        'visitId', '10000000-0000-4000-8000-000000000641',
        'signerName', 'Late Customer',
        'signerRole', 'customer',
        'signedAt', now(),
        'signatureAssetId', '96000000-0000-4000-8000-000000000813',
        'disclosureVersion', 'completion-v1'
      ),
      repeat('9', 64)
    );
  exception
    when others then
      if position('active or paused' in sqlerrm) > 0 then
        lifecycle_blocked := true;
      else
        raise;
      end if;
  end;
  if not lifecycle_blocked then
    raise exception 'Completed visit accepted a later signature';
  end if;
end;
$$;

reset role;

do $$
begin
  if not exists (
    select 1
    from public.visits visit
    where visit.id = '10000000-0000-4000-8000-000000000641'
      and visit.status = 'completed'
      and visit.internal_notes = 'Scope completed without a property exception.'
  ) or not exists (
    select 1
    from public.completion_signatures signature
    join public.media_assets media on media.id = signature.signature_asset_id
    where signature.id = '96000000-0000-4000-8000-000000000814'
      and signature.visit_id = '10000000-0000-4000-8000-000000000641'
      and signature.signer_role = 'customer'
      and signature.received_at is not null
      and signature.received_at >= signature.signed_at
      and media.purpose = 'signature'
      and media.content_type = 'image/png'
  ) then
    raise exception 'Durable live field completion evidence is incomplete';
  end if;
end;
$$;

rollback;

\echo 'StoryOps live field completion contract passed'
