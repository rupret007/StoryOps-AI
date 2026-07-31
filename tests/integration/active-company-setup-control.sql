\set ON_ERROR_STOP on

begin;

\echo '1/3 setup wrapper can populate an invited setup-status company'
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
values (
  '00000000-0000-0000-0000-000000000000',
  '35000000-0000-4000-8000-000000000031',
  'authenticated',
  'authenticated',
  'active-gate-setup@example.test',
  extensions.crypt('LocalRegressionOnly1!', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"],"storyops_bootstrap_company_id":"35000000-0000-4000-8000-000000000030"}',
  '{"full_name":"Setup Gate Owner"}',
  now(),
  now(),
  '',
  '',
  '',
  ''
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"35000000-0000-4000-8000-000000000031","role":"authenticated","app_metadata":{"storyops_bootstrap_company_id":"35000000-0000-4000-8000-000000000030"}}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '35000000-0000-4000-8000-000000000031',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  receipt jsonb;
begin
  receipt := public.complete_storyops_setup(
    '35000000-0000-4000-8000-000000000030',
    '35000000-0000-4000-8000-000000000032',
    repeat('3', 64),
    'Setup Gate Exterior Care',
    'Setup Gate Owner',
    '76051',
    'America/Chicago',
    array['gutter-cleaning']::text[],
    true
  );
  if receipt ->> 'status' <> 'configured'
    or receipt ->> 'companyStatus' <> 'setup'
    or receipt ->> 'companyId' <> '35000000-0000-4000-8000-000000000030'
  then
    raise exception 'Finite setup wrapper returned an invalid receipt: %', receipt;
  end if;
end;
$$;

\echo '2/3 caller-forged setup settings cannot authorize arbitrary tenant work'
do $$
begin
  perform set_config(
    'storyops.setup_control',
    '35000000-0000-4000-8000-000000000030:35000000-0000-4000-8000-000000000031',
    true
  );
  begin
    perform public.execute_storyops_command(
      '35000000-0000-4000-8000-000000000030',
      '35000000-0000-4000-8000-000000000033',
      'lead.create',
      0,
      '{
        "entityId":"35000000-0000-4000-8000-000000000034",
        "source":"manual",
        "displayName":"Setup bypass attempt",
        "requestedServices":["gutter-cleaning"],
        "preferredContactChannel":"email"
      }'::jsonb,
      repeat('4', 64)
    );
    raise exception 'Setup-status company executed ordinary operational work';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'STORYOPS_COMPANY_NOT_ACTIVE' then
        raise;
      end if;
  end;
end;
$$;

\echo '3/3 private capabilities are cleaned up and only finite wrappers are executable'
reset role;
do $$
begin
  if exists (
    select 1
    from private.storyops_setup_capabilities capability
    where capability.company_id = '35000000-0000-4000-8000-000000000030'
  ) then
    raise exception 'Setup wrapper leaked a private capability';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.complete_storyops_setup_v1_0(uuid,uuid,text,text,text,text,text,text[],boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.save_company_configuration_draft_v1_0(uuid,uuid,integer,jsonb,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.publish_company_configuration_v1_0(uuid,uuid,integer,text,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.publish_company_operating_baseline_v1_0(uuid,uuid,integer,text,text)',
    'EXECUTE'
  ) then
    raise exception 'A wrapped setup implementation remained directly executable';
  end if;
end;
$$;

rollback;
