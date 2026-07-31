\set ON_ERROR_STOP on

begin;

\echo '1/9 every current tenant table is protected by the active-company mutation trigger'
do $$
declare
  unprotected_tables text[];
begin
  select coalesce(array_agg(column_record.table_name order by column_record.table_name), '{}')
  into unprotected_tables
  from information_schema.columns column_record
  join information_schema.tables table_record
    on table_record.table_schema = column_record.table_schema
   and table_record.table_name = column_record.table_name
  where column_record.table_schema = 'public'
    and column_record.column_name = 'company_id'
    and table_record.table_type = 'BASE TABLE'
    and not exists (
      select 1
      from pg_trigger trigger_record
      join pg_class relation_record on relation_record.oid = trigger_record.tgrelid
      join pg_namespace namespace_record on namespace_record.oid = relation_record.relnamespace
      where namespace_record.nspname = 'public'
        and relation_record.relname = column_record.table_name
        and trigger_record.tgname = 'storyops_active_company_mutation_gate'
        and not trigger_record.tgisinternal
        and trigger_record.tgenabled <> 'D'
    );

  if cardinality(unprotected_tables) <> 0 then
    raise exception 'Tenant tables lack the active-company mutation trigger: %',
      unprotected_tables;
  end if;
end;
$$;

insert into public.companies(id, name, timezone, status, settings)
values (
  '35000000-0000-4000-8000-000000000010',
  'Active company-scope test tenant',
  'America/Chicago',
  'active',
  '{}'::jsonb
);
insert into public.company_memberships(
  id,
  company_id,
  user_id,
  role
)
values (
  '35000000-0000-4000-8000-000000000011',
  '35000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000101',
  'owner'
);

insert into storage.objects(bucket_id, name, metadata)
values
  (
    'sds',
    '10000000-0000-4000-8000-000000000001/active-company-gate-existing.pdf',
    '{"size":128,"mimetype":"application/pdf","gate":"before"}'::jsonb
  ),
  (
    'company-assets',
    '10000000-0000-4000-8000-000000000001/active-company-gate-existing.png',
    '{"size":128,"mimetype":"image/png","gate":"before"}'::jsonb
  );

update public.companies
set status = 'paused'
where id = '10000000-0000-4000-8000-000000000001';

\echo '2/9 a paused owner cannot write an operational row directly'
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
begin
  begin
    update public.leads
    set qualification_summary = 'This paused-company write must not persist.'
    where id = '10000000-0000-4000-8000-000000000221';
    raise exception 'Paused owner direct mutation unexpectedly succeeded';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'STORYOPS_COMPANY_NOT_ACTIVE' then
        raise;
      end if;
  end;
end;
$$;

\echo '3/9 a paused owner cannot mutate the tenant-root company profile directly'
-- Production intentionally exposes no raw UPDATE grant on companies. Grant it
-- only inside this rolled-back test transaction so the defense-in-depth trigger
-- is proven even if a future ACL regression exposes the table.
grant select, update on public.companies to authenticated;
set local role authenticated;
do $$
begin
  begin
    update public.companies
    set
      name = 'A paused company name must not persist',
      timezone = 'UTC',
      settings = settings || '{"pausedMutation":true}'::jsonb
    where id = '10000000-0000-4000-8000-000000000001';
    raise exception 'Paused company profile mutation unexpectedly succeeded';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'STORYOPS_COMPANY_NOT_ACTIVE' then
        raise;
      end if;
  end;
end;
$$;
reset role;
revoke select, update on public.companies from authenticated;

do $$
begin
  if exists (
    select 1
    from public.companies
    where id = '10000000-0000-4000-8000-000000000001'
      and (
        name = 'A paused company name must not persist'
        or timezone = 'UTC'
        or settings @> '{"pausedMutation":true}'::jsonb
      )
  ) then
    raise exception 'Paused company profile mutation changed tenant-root state';
  end if;
end;
$$;

\echo '4/9 a tenant row cannot move from a paused company into an active company'
do $$
begin
  begin
    update public.leads
    set company_id = '35000000-0000-4000-8000-000000000010'
    where id = '10000000-0000-4000-8000-000000000221';
    raise exception 'Cross-company row move unexpectedly succeeded';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'STORYOPS_COMPANY_SCOPE_IMMUTABLE' then
        raise;
      end if;
  end;

  if not exists (
    select 1
    from public.leads
    where id = '10000000-0000-4000-8000-000000000221'
      and company_id = '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Cross-company row move changed tenant ownership';
  end if;
end;
$$;

\echo '5/9 the generic command and offline replay boundary also fail before reservation'
do $$
begin
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '35000000-0000-4000-8000-000000000001',
      'lead.create',
      0,
      '{
        "entityId":"35000000-0000-4000-8000-000000000002",
        "source":"manual",
        "displayName":"Paused command lead",
        "requestedServices":["gutter-cleaning"],
        "preferredContactChannel":"email"
      }'::jsonb,
      repeat('a', 64)
    );
    raise exception 'Paused generic command unexpectedly succeeded';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'STORYOPS_COMPANY_NOT_ACTIVE' then
        raise;
      end if;
  end;

  if exists (
    select 1
    from public.idempotency_keys
    where company_id = '10000000-0000-4000-8000-000000000001'
      and scope = 'workspace-command-v1'
      and key = '35000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Paused command left an idempotency reservation';
  end if;
end;
$$;

\echo '6/9 an assigned technician cannot replay field work while the company is paused'
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000103","role":"authenticated"}',
  true
);
do $$
begin
  begin
    update public.visits
    set internal_notes = 'This paused-company field write must not persist.'
    where id = '10000000-0000-4000-8000-000000000641';
    raise exception 'Paused technician direct mutation unexpectedly succeeded';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'STORYOPS_COMPANY_NOT_ACTIVE' then
        raise;
      end if;
  end;
end;
$$;

\echo '7/9 a paused assigned technician cannot upload orphaned field evidence'
set local role authenticated;
do $$
begin
  begin
    insert into storage.objects(bucket_id, name, metadata)
    values (
      'job-media',
      '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/paused-field.jpg',
      '{"size":128,"mimetype":"image/jpeg"}'::jsonb
    );
    raise exception 'Paused technician Storage upload unexpectedly succeeded';
  exception
    when insufficient_privilege then
      null;
  end;
end;
$$;

\echo '8/9 paused owner SDS and company-asset writes are denied'
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
declare
  insert_denials integer := 0;
begin
  begin
    insert into storage.objects(bucket_id, name, metadata)
    values (
      'sds',
      '10000000-0000-4000-8000-000000000001/paused-owner.pdf',
      '{"size":128,"mimetype":"application/pdf"}'::jsonb
    );
  exception when insufficient_privilege then
    insert_denials := insert_denials + 1;
  end;
  begin
    insert into storage.objects(bucket_id, name, metadata)
    values (
      'company-assets',
      '10000000-0000-4000-8000-000000000001/paused-owner.png',
      '{"size":128,"mimetype":"image/png"}'::jsonb
    );
  exception when insufficient_privilege then
    insert_denials := insert_denials + 1;
  end;

  update storage.objects
  set metadata = metadata || '{"gate":"paused-update"}'::jsonb
  where bucket_id = 'sds'
    and name =
      '10000000-0000-4000-8000-000000000001/active-company-gate-existing.pdf';
  update storage.objects
  set metadata = metadata || '{"gate":"paused-update"}'::jsonb
  where bucket_id = 'company-assets'
    and name =
      '10000000-0000-4000-8000-000000000001/active-company-gate-existing.png';

  if insert_denials <> 2 then
    raise exception 'Paused owner Storage inserts were not both denied';
  end if;
end;
$$;

reset role;
do $$
begin
  if exists (
    select 1
    from storage.objects
    where name in (
      '10000000-0000-4000-8000-000000000001/active-company-gate-existing.pdf',
      '10000000-0000-4000-8000-000000000001/active-company-gate-existing.png'
    )
      and metadata ->> 'gate' <> 'before'
  ) then
    raise exception 'Paused owner changed existing Storage bytes or metadata';
  end if;
end;
$$;

\echo '9/9 the owner can use the finite lifecycle command to reactivate and resume'
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
declare
  control_state jsonb;
  canonical_request text;
  request_hash text;
  receipt jsonb;
  replay jsonb;
begin
  control_state := public.get_storyops_company_control_state(
    '10000000-0000-4000-8000-000000000001'
  );
  if control_state ->> 'status' <> 'paused'
    or (control_state ->> 'canReactivate')::boolean is not true
  then
    raise exception 'Paused owner control state was unavailable: %', control_state;
  end if;

  canonical_request := jsonb_build_object(
    'action',
    'company.operational_status.set',
    'payload',
    jsonb_build_object(
      'expectedStatus',
      'paused',
      'reason',
      'Owner reviewed the pause and is resuming the local gate regression.',
      'targetStatus',
      'active'
    )
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  receipt := public.set_storyops_company_operational_status(
    '10000000-0000-4000-8000-000000000001',
    '35000000-0000-4000-8000-000000000020',
    'paused',
    'active',
    'Owner reviewed the pause and is resuming the local gate regression.',
    canonical_request,
    request_hash
  );
  replay := public.set_storyops_company_operational_status(
    '10000000-0000-4000-8000-000000000001',
    '35000000-0000-4000-8000-000000000020',
    'paused',
    'active',
    'Owner reviewed the pause and is resuming the local gate regression.',
    canonical_request,
    request_hash
  );
  if receipt ->> 'status' <> 'active'
    or (receipt ->> 'replayed')::boolean
    or (replay ->> 'replayed')::boolean is not true
  then
    raise exception 'Lifecycle command did not produce an exact replay: %, %',
      receipt,
      replay;
  end if;
end;
$$;

reset role;
update public.leads
set qualification_summary = 'Active-company mutation confirmed.'
where id = '10000000-0000-4000-8000-000000000221';

do $$
declare
  receipt jsonb;
begin
  receipt := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '35000000-0000-4000-8000-000000000003',
    'lead.create',
    0,
    '{
      "entityId":"35000000-0000-4000-8000-000000000004",
      "source":"manual",
      "displayName":"Active command lead",
      "requestedServices":["gutter-cleaning"],
      "preferredContactChannel":"email"
    }'::jsonb,
    repeat('b', 64)
  );
  if receipt ->> 'status' <> 'applied'
    or (receipt ->> 'entityId')::uuid <> '35000000-0000-4000-8000-000000000004'
  then
    raise exception 'Active command did not resume: %', receipt;
  end if;
end;
$$;

rollback;
