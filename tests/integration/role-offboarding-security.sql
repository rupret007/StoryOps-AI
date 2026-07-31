\set ON_ERROR_STOP on

begin;

\echo '1/4 customer and technician mappings are initially authorized'
insert into storage.objects(bucket_id, name, metadata)
values (
  'job-media',
  '10000000-0000-4000-8000-000000000001/jobs/10000000-0000-4000-8000-000000000631/offboarding-proof.jpg',
  '{"size":16,"mimetype":"image/jpeg"}'::jsonb
);

-- The production API role intentionally has no direct table grant. This
-- rollback-only fixture grants the minimum insert privilege so the trusted
-- attestation trigger can be exercised with auth.role() = service_role.
grant insert on public.media_assets to service_role;
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select public.attest_storyops_media_upload(
  '10000000-0000-4000-8000-000000000001',
  '19000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000103',
  '19000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001/jobs/10000000-0000-4000-8000-000000000631/offboarding-proof.jpg',
  repeat('1', 64),
  16,
  'image/jpeg'
);
insert into public.media_assets(
  id,
  company_id,
  property_id,
  job_id,
  visit_id,
  purpose,
  object_path,
  content_type,
  byte_size,
  checksum_sha256,
  captured_at,
  captured_by,
  customer_visible,
  offline_client_id,
  sync_state
)
values (
  '19000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000211',
  '10000000-0000-4000-8000-000000000631',
  '10000000-0000-4000-8000-000000000641',
  'scope',
  '10000000-0000-4000-8000-000000000001/jobs/10000000-0000-4000-8000-000000000631/offboarding-proof.jpg',
  'image/jpeg',
  16,
  repeat('1', 64),
  now(),
  '10000000-0000-4000-8000-000000000103',
  true,
  '19000000-0000-4000-8000-000000000003',
  'synced'
);
reset role;
revoke insert on public.media_assets from service_role;
select set_config('request.jwt.claims', '{}', true);

insert into public.scope_photo_requests(
  id,
  company_id,
  customer_id,
  property_id,
  checklist_version,
  checklist,
  requested_by,
  expires_at
)
values (
  '19000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000211',
  'offboarding-test-v1',
  '[{"code":"front","label":"Front elevation"}]'::jsonb,
  '10000000-0000-4000-8000-000000000101',
  now() + interval '1 day'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);
do $$
begin
  if not public.is_customer_user(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201'
  ) or not public.can_read_job_media_object(
    '10000000-0000-4000-8000-000000000001/jobs/10000000-0000-4000-8000-000000000631/offboarding-proof.jpg'
  ) or not public.is_active_company_portal_user(
    '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Active customer mapping, media, or package catalog was not authorized';
  end if;
  perform count(*) from public.service_packages
  where company_id = '10000000-0000-4000-8000-000000000001';
  perform count(*) from public.service_package_components
  where company_id = '10000000-0000-4000-8000-000000000001';
end;
$$;
reset role;

\echo '2/4 customer offboarding denies portal rows and known private-media paths'
update public.company_memberships
set active = false
where company_id = '10000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000104';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);
do $$
declare
  workspace_denied boolean := false;
begin
  begin
    perform public.get_storyops_workspace('10000000-0000-4000-8000-000000000001');
  exception when others then
    workspace_denied := true;
  end;
  if not workspace_denied
    or public.is_customer_user(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000201'
    )
    or public.can_read_job_media_object(
      '10000000-0000-4000-8000-000000000001/jobs/10000000-0000-4000-8000-000000000631/offboarding-proof.jpg'
    )
    or exists (
      select 1 from public.scope_photo_requests
      where id = '19000000-0000-4000-8000-000000000002'
    )
    or exists (
      select 1 from storage.objects
      where bucket_id = 'job-media'
        and name = '10000000-0000-4000-8000-000000000001/jobs/10000000-0000-4000-8000-000000000631/offboarding-proof.jpg'
    )
    or exists (
      select 1 from public.service_packages
      where company_id = '10000000-0000-4000-8000-000000000001'
    )
    or exists (
      select 1 from public.service_package_components
      where company_id = '10000000-0000-4000-8000-000000000001'
    )
  then
    raise exception 'Offboarded customer retained workspace, portal, media, or package access';
  end if;
end;
$$;
reset role;

do $$
declare
  mapping_change_blocked boolean := false;
begin
  begin
    update public.customer_portal_users
    set customer_id = customer_id
    where id = '10000000-0000-4000-8000-000000000202';
  exception when check_violation then
    mapping_change_blocked := true;
  end;
  if not mapping_change_blocked then
    raise exception 'Inactive customer membership still allowed portal mapping mutation';
  end if;
end;
$$;

update public.company_memberships
set active = true
where company_id = '10000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000104';

\echo '3a/5 future-started membership and inactive crews are not assignments'
update public.crew_members
set starts_on = current_date + 10
where id = '10000000-0000-4000-8000-000000000602';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000103","role":"authenticated"}',
  true
);
do $$
begin
  if public.is_assigned_technician_for_visit(
      '10000000-0000-4000-8000-000000000641'
    )
  then
    raise exception 'A future-started technician could read the visit';
  end if;
end;
$$;
reset role;
update public.crew_members
set starts_on = current_date - 30
where id = '10000000-0000-4000-8000-000000000602';

update public.crews
set active = false
where id = '10000000-0000-4000-8000-000000000601';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000103","role":"authenticated"}',
  true
);
do $$
begin
  if public.is_assigned_technician_for_visit(
      '10000000-0000-4000-8000-000000000641'
    )
  then
    raise exception 'A technician on an inactive crew could read the visit';
  end if;
end;
$$;
reset role;
update public.crews
set active = true
where id = '10000000-0000-4000-8000-000000000601';

\echo '3/4 technician offboarding denies assigned work and media despite current crew dates'
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000103","role":"authenticated"}',
  true
);
do $$
begin
  if not public.is_assigned_technician_for_job(
    '10000000-0000-4000-8000-000000000631'
  ) or not public.is_assigned_technician_for_visit(
    '10000000-0000-4000-8000-000000000641'
  ) then
    raise exception 'Active technician assignment was not authorized';
  end if;
end;
$$;
reset role;

update public.company_memberships
set active = false
where company_id = '10000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000103';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000103","role":"authenticated"}',
  true
);
do $$
declare
  workspace_denied boolean := false;
begin
  begin
    perform public.get_storyops_workspace('10000000-0000-4000-8000-000000000001');
  exception when others then
    workspace_denied := true;
  end;
  if not workspace_denied
    or public.is_assigned_technician_for_job(
      '10000000-0000-4000-8000-000000000631'
    )
    or public.is_assigned_technician_for_visit(
      '10000000-0000-4000-8000-000000000641'
    )
    or public.can_read_job_media_object(
      '10000000-0000-4000-8000-000000000001/jobs/10000000-0000-4000-8000-000000000631/offboarding-proof.jpg'
    )
  then
    raise exception 'Offboarded technician retained assigned work or media access';
  end if;
end;
$$;
reset role;

update public.company_memberships
set active = true
where company_id = '10000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000103';

\echo '4/4 API roles hold no RLS-bypassing table privileges'
do $$
begin
  if exists (
    select 1
    from information_schema.role_table_grants grant_row
    where grant_row.table_schema = 'public'
      and grant_row.grantee in ('anon', 'authenticated', 'service_role')
      and grant_row.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')
  ) then
    raise exception 'An API role retains TRUNCATE, REFERENCES, or TRIGGER on a business table';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.validate_company_configuration(uuid,jsonb,text)',
    'EXECUTE'
  ) then
    raise exception 'Authenticated users can call the internal configuration validator';
  end if;
end;
$$;

rollback;

\echo 'Role offboarding security contract passed.'
