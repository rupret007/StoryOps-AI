\set ON_ERROR_STOP on

begin;

\echo '1/4 the forward-installed inner setup contract provisions all five inactive templates and a current replay-stable receipt'
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
  '54000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'setup-forward-owner@example.test',
  extensions.crypt('LocalRegressionOnly1!', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"],"storyops_bootstrap_company_id":"54000000-0000-4000-8000-000000000000"}',
  '{"full_name":"Forward Setup Owner"}',
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
  '{"sub":"54000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"storyops_bootstrap_company_id":"54000000-0000-4000-8000-000000000000"}}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '54000000-0000-4000-8000-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  receipt jsonb;
  replay_receipt jsonb;
  completed_at text;
begin
  receipt := public.complete_storyops_setup(
    '54000000-0000-4000-8000-000000000000',
    '54000000-0000-4000-8000-000000000002',
    repeat('5', 64),
    'Forward Compatible Exterior Care',
    'Forward Setup Owner',
    '76051',
    'America/Chicago',
    array[
      'pressure-wash-flatwork',
      'soft-wash-house',
      'gutter-cleaning',
      'roof-washing',
      'window-cleaning'
    ]::text[],
    true
  );

  completed_at := receipt ->> 'serverTime';

  if receipt ->> 'schemaVersion' <> 'storyops-live-setup-v1'
    or receipt ->> 'status' <> 'configured'
    or (receipt ->> 'replayed')::boolean
    or (receipt ->> 'serviceCount')::integer <> 5
    or (receipt ->> 'availableServiceCount')::integer <> 5
    or (receipt ->> 'integrationsDisabled')::integer <> 11
    or completed_at is null
    or receipt ->> 'serverTime' <> completed_at
  then
    raise exception 'Forward setup returned a stale or incomplete receipt: %', receipt;
  end if;

  replay_receipt := public.complete_storyops_setup(
    '54000000-0000-4000-8000-000000000000',
    '54000000-0000-4000-8000-000000000002',
    repeat('5', 64),
    'Forward Compatible Exterior Care',
    'Forward Setup Owner',
    '76051',
    'America/Chicago',
    array[
      'pressure-wash-flatwork',
      'soft-wash-house',
      'gutter-cleaning',
      'roof-washing',
      'window-cleaning'
    ]::text[],
    true
  );

  if not (replay_receipt ->> 'replayed')::boolean
    or (replay_receipt ->> 'serviceCount')::integer <> 5
    or (replay_receipt ->> 'availableServiceCount')::integer <> 5
    or (replay_receipt ->> 'integrationsDisabled')::integer <> 11
    or replay_receipt ->> 'serverTime' <> completed_at
  then
    raise exception 'Forward setup replay changed authoritative receipt facts: %',
      replay_receipt;
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

do $$
begin
  if (
    select count(*)
    from public.service_catalog service
    where service.company_id = '54000000-0000-4000-8000-000000000000'
      and service.code = any(array[
        'pressure-wash-flatwork',
        'soft-wash-house',
        'gutter-cleaning',
        'roof-washing',
        'window-cleaning'
      ]::text[])
      and not service.active
  ) <> 5 then
    raise exception 'Forward setup did not install five inactive service templates';
  end if;

  if nullif((
    select company.settings ->> 'setupCompletedAt'
    from public.companies company
    where company.id = '54000000-0000-4000-8000-000000000000'
  ), '') is null then
    raise exception 'Forward setup did not persist setupCompletedAt';
  end if;

  if (
    select count(distinct service.default_checklist_template_id)
    from public.service_catalog service
    where service.company_id = '54000000-0000-4000-8000-000000000000'
  ) <> 1 then
    raise exception 'Forward setup service templates do not share the review checklist';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.complete_storyops_setup_v1_0(uuid,uuid,text,text,text,text,text,text[],boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'service_role',
    'public.complete_storyops_setup_v1_0(uuid,uuid,text,text,text,text,text,text[],boolean)',
    'EXECUTE'
  ) then
    raise exception 'Private setup implementation became directly executable';
  end if;

  if (
    select
      inner_routine.proowner is distinct from wrapper_routine.proowner
      or guard_routine.proowner is distinct from wrapper_routine.proowner
      or not inner_routine.prosecdef
    from pg_proc inner_routine
    cross join pg_proc wrapper_routine
    cross join pg_proc guard_routine
    where inner_routine.oid =
      'public.complete_storyops_setup_v1_0(uuid,uuid,text,text,text,text,text,text[],boolean)'::regprocedure
      and wrapper_routine.oid =
        'public.complete_storyops_setup(uuid,uuid,text,text,text,text,text,text[],boolean)'::regprocedure
      and guard_routine.oid =
        'public.guard_company_system_state()'::regprocedure
  ) then
    raise exception 'Forward replacement changed trusted routine ownership or security mode';
  end if;
end;
$$;

\echo '2/4 setupCompletedAt is immutable across the authenticated company boundary'
-- The application reaches companies through finite RPCs/views. Grant the
-- narrow table rights only inside this rolled-back contract so the trigger,
-- rather than the outer ACL, is the boundary under test.
grant select, update(settings) on public.companies to authenticated;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"54000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '54000000-0000-4000-8000-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  blocked boolean := false;
begin
  begin
    update public.companies
    set settings = jsonb_set(
      settings,
      '{setupCompletedAt}',
      to_jsonb(now() + interval '1 day'),
      false
    )
    where id = '54000000-0000-4000-8000-000000000000';
  exception
    when others then
      if position(
        'setup and launch evidence is server-managed' in sqlerrm
      ) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;

  if not blocked then
    raise exception 'Authenticated owner changed setupCompletedAt directly';
  end if;
end;
$$;

\echo '3/4 the idempotent backfill inserts only missing inactive templates and preserves reviewed rows byte-for-byte'
reset role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.companies(
  id,
  name,
  timezone,
  currency,
  status,
  settings
)
values (
  '54000000-0000-4000-8000-000000000010',
  'Forward Backfill Fixture',
  'America/Chicago',
  'USD',
  'active',
  '{
    "setupWizardCompleted":true,
    "setupCompletedAt":"2026-07-01T12:00:00Z",
    "launchAuthorized":false
  }'::jsonb
);

insert into public.checklist_templates(
  id,
  company_id,
  name,
  version_label,
  active
)
values (
  '54000000-0000-4000-8000-000000000011',
  '54000000-0000-4000-8000-000000000010',
  'Setup review required - exterior service',
  'setup-draft-v1',
  true
);

insert into public.service_catalog(
  id,
  company_id,
  code,
  name,
  description,
  category,
  active,
  taxable,
  required_skills,
  required_equipment_types,
  required_measurement_kinds,
  safety_sop_reference,
  default_checklist_template_id
)
values (
  '54000000-0000-4000-8000-000000000012',
  '54000000-0000-4000-8000-000000000010',
  'pressure-wash-flatwork',
  'Owner-reviewed flatwork',
  'Reviewed production description',
  'pressure_washing',
  true,
  false,
  array['reviewed-skill']::text[],
  array['reviewed-equipment']::text[],
  array['area_sq_ft']::text[],
  'REVIEWED-SOP-001',
  '54000000-0000-4000-8000-000000000011'
);

do $$
declare
  first_insert_count integer;
  second_insert_count integer;
begin
  first_insert_count :=
    private.backfill_storyops_setup_service_templates_v1_1();
  second_insert_count :=
    private.backfill_storyops_setup_service_templates_v1_1();

  if first_insert_count < 4 or second_insert_count <> 0 then
    raise exception
      'Setup service backfill was incomplete or non-idempotent: first %, second %',
      first_insert_count,
      second_insert_count;
  end if;

  if not exists (
    select 1
    from public.service_catalog service
    where service.id = '54000000-0000-4000-8000-000000000012'
      and service.company_id = '54000000-0000-4000-8000-000000000010'
      and service.code = 'pressure-wash-flatwork'
      and service.name = 'Owner-reviewed flatwork'
      and service.description = 'Reviewed production description'
      and service.category = 'pressure_washing'
      and service.active
      and not service.taxable
      and service.required_skills = array['reviewed-skill']::text[]
      and service.required_equipment_types =
        array['reviewed-equipment']::text[]
      and service.required_measurement_kinds = array['area_sq_ft']::text[]
      and service.safety_sop_reference = 'REVIEWED-SOP-001'
      and service.default_checklist_template_id =
        '54000000-0000-4000-8000-000000000011'
      and service.version = 1
  ) then
    raise exception 'Backfill overwrote a reviewed service row';
  end if;

  if (
    select count(*)
    from public.service_catalog service
    where service.company_id = '54000000-0000-4000-8000-000000000010'
      and service.code = any(array[
        'pressure-wash-flatwork',
        'soft-wash-house',
        'gutter-cleaning',
        'roof-washing',
        'window-cleaning'
      ]::text[])
  ) <> 5 or (
    select count(*)
    from public.service_catalog service
    where service.company_id = '54000000-0000-4000-8000-000000000010'
      and service.code <> 'pressure-wash-flatwork'
      and service.code = any(array[
        'soft-wash-house',
        'gutter-cleaning',
        'roof-washing',
        'window-cleaning'
      ]::text[])
      and not service.active
      and service.taxable
      and service.default_checklist_template_id =
        '54000000-0000-4000-8000-000000000011'
  ) <> 4 then
    raise exception 'Backfill did not create exactly the four missing inactive templates';
  end if;
end;
$$;

\echo '4/4 a linked identity-provider probe keeps an otherwise default row non-pristine and setup fails closed'
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
  '54000000-0000-4000-8000-000000000021',
  'authenticated',
  'authenticated',
  'setup-probe-owner@example.test',
  extensions.crypt('LocalRegressionOnly2!', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"],"storyops_bootstrap_company_id":"54000000-0000-4000-8000-000000000020"}',
  '{"full_name":"Probe Setup Owner"}',
  now(),
  now(),
  '',
  '',
  '',
  ''
);

insert into public.companies(id, name, timezone, currency, status, settings)
values (
  '54000000-0000-4000-8000-000000000020',
  'Probe-linked Setup Fixture',
  'America/Chicago',
  'USD',
  'setup',
  '{}'::jsonb
);

insert into public.company_memberships(company_id, user_id, role, active)
values (
  '54000000-0000-4000-8000-000000000020',
  '54000000-0000-4000-8000-000000000021',
  'owner',
  true
);

insert into public.integration_environment_probe_results(
  company_id,
  connection_id,
  probe_run_id,
  provider,
  capability,
  environment_mode,
  status,
  result_code,
  deployment_fingerprint,
  required_settings,
  latency_ms,
  checked_at,
  expires_at,
  recorded_by_user_id
)
select
  connection.company_id,
  connection.id,
  '54000000-0000-4000-8000-000000000022',
  'supabase_auth',
  'invite_user',
  'disabled',
  'not_configured',
  'not_configured',
  repeat('5', 64),
  '{}'::text[],
  1,
  now(),
  now() + interval '5 minutes',
  '54000000-0000-4000-8000-000000000021'
from public.integration_connections connection
where connection.company_id = '54000000-0000-4000-8000-000000000020'
  and connection.provider = 'supabase_auth';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"54000000-0000-4000-8000-000000000021","role":"authenticated","app_metadata":{"storyops_bootstrap_company_id":"54000000-0000-4000-8000-000000000020"}}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '54000000-0000-4000-8000-000000000021',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.complete_storyops_setup(
      '54000000-0000-4000-8000-000000000020',
      '54000000-0000-4000-8000-000000000023',
      repeat('6', 64),
      'Probe-linked Setup Fixture',
      'Probe Setup Owner',
      '76051',
      'America/Chicago',
      array['gutter-cleaning']::text[],
      true
    );
  exception
    when others then
      if position('not a pristine setup scope' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;

  if not blocked then
    raise exception 'Setup deleted a provider row with linked probe evidence';
  end if;
end;
$$;

rollback;
