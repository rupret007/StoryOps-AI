\set ON_ERROR_STOP on

begin;

\echo '1/9 setup state and provisioning require authentication'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_storyops_setup_state(null);
  exception
    when others then
      if position('Authentication is required' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Unauthenticated setup-state read was allowed';
  end if;
end;
$$;

delete from public.company_memberships
where user_id = '10000000-0000-4000-8000-000000000102';

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

\echo '2/9 a public company UUID cannot be claimed without a protected bootstrap invitation'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_storyops_setup_state(
      '98000000-0000-4000-8000-000000000001'
    );
  exception
    when others then
      if position('bootstrap invitation is required' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Uninvited identity could claim the configured company UUID';
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated","app_metadata":{"storyops_bootstrap_company_id":"98000000-0000-4000-8000-000000000001"}}',
  true
);

\echo '3/9 an invited signed-in unscoped back-office identity is setup-required'
do $$
declare
  setup_state jsonb;
begin
  setup_state := public.get_storyops_setup_state(
    '98000000-0000-4000-8000-000000000001'
  );
  if setup_state ->> 'status' <> 'required'
    or (setup_state ->> 'setupComplete')::boolean
    or not (setup_state ->> 'requiresLaunchReview')::boolean
  then
    raise exception 'Unexpected unscoped setup state: %', setup_state;
  end if;
end;
$$;

\echo '4/9 an existing company cannot be claimed without membership'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_storyops_setup_state(
      '10000000-0000-4000-8000-000000000001'
    );
  exception
    when others then
      if position('No active company membership' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Existing company scope was exposed without membership';
  end if;
end;
$$;

\echo '5/9 an existing non-pristine setup company fails closed'
reset role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
insert into public.companies(id, name, timezone, currency, status, settings)
values (
  '97900000-0000-4000-8000-000000000001',
  'Unsafe partial setup',
  'America/Chicago',
  'USD',
  'setup',
  '{}'::jsonb
);
insert into public.company_memberships(company_id, user_id, role, active)
values (
  '97900000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000102',
  'owner',
  true
);
insert into public.integration_connections(
  company_id,
  provider,
  mode,
  status,
  secret_reference,
  configuration,
  capabilities
)
values (
  '97900000-0000-4000-8000-000000000001',
  'email',
  'live',
  'healthy',
  'vault://existing-provider',
  '{}'::jsonb,
  array['send']
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000102',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated","app_metadata":{"storyops_bootstrap_company_id":"98000000-0000-4000-8000-000000000001"}}',
  true
);
set local role authenticated;
do $$
declare
  settings_blocked boolean := false;
  status_blocked boolean := false;
  setup_state jsonb;
begin
  begin
    update public.companies
    set settings = settings || jsonb_build_object(
      'setupWizardCompleted', true,
      'launchAuthorized', true
    )
    where id = '97900000-0000-4000-8000-000000000001';
  exception
    when others then
      if position('setup and launch evidence is server-managed' in sqlerrm) > 0
        or position('permission denied for table companies' in sqlerrm) > 0
      then
        settings_blocked := true;
      else
        raise;
      end if;
  end;

  begin
    update public.companies
    set status = 'active'
    where id = '97900000-0000-4000-8000-000000000001';
  exception
    when others then
      if position('lifecycle status is server-managed' in sqlerrm) > 0
        or position('permission denied for table companies' in sqlerrm) > 0
      then
        status_blocked := true;
      else
        raise;
      end if;
  end;

  setup_state := public.get_storyops_setup_state(
    '97900000-0000-4000-8000-000000000001'
  );
  if not settings_blocked
    or not status_blocked
    or setup_state ->> 'status' <> 'required'
    or (setup_state ->> 'setupComplete')::boolean
  then
    raise exception 'Owner direct DML forged setup or launch state: %', setup_state;
  end if;
end;
$$;

do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.complete_storyops_setup(
      '97900000-0000-4000-8000-000000000001',
      '97900000-0000-4000-8000-000000000901',
      repeat('7', 64),
      'Unsafe partial setup',
      'Dana Dispatcher',
      '76051',
      'America/Chicago',
      array['gutter-cleaning'],
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
    raise exception 'Non-pristine setup company was silently reconfigured';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
insert into public.company_memberships(company_id, user_id, role, active)
values (
  '97900000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000101',
  'owner',
  true
);
update public.company_memberships
set active = false
where company_id = '97900000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000102';
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000102',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated","app_metadata":{"storyops_bootstrap_company_id":"98000000-0000-4000-8000-000000000001"}}',
  true
);
set local role authenticated;

\echo '6/9 invalid services fail before any company record is created'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.complete_storyops_setup(
      '98000000-0000-4000-8000-000000000001',
      '98000000-0000-4000-8000-000000000901',
      repeat('8', 64),
      'North Texas Exterior Care',
      'Dana Dispatcher',
      '76051',
      'America/Chicago',
      array['invented-service'],
      true
    );
  exception
    when others then
      if position('supported services' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Unsupported service was provisioned';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
do $$
begin
  if exists (
    select 1 from public.companies
    where id = '98000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Invalid setup left a company record';
  end if;
end;
$$;
insert into public.companies(id, name, timezone, currency, status, settings)
values (
  '98000000-0000-4000-8000-000000000001',
  'North Texas Exterior Care',
  'America/Chicago',
  'USD',
  'setup',
  '{}'::jsonb
);
insert into public.company_memberships(company_id, user_id, role, active)
values (
  '98000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000102',
  'owner',
  true
);
do $$
begin
  if (
    select count(*)
    from public.integration_connections connection
    where connection.company_id = '98000000-0000-4000-8000-000000000001'
      and connection.provider = 'supabase_auth'
      and connection.mode = 'disabled'
      and connection.status = 'disabled'
      and not connection.owner_enabled
  ) <> 1 then
    raise exception 'Migration 51 did not seed the pristine setup identity provider';
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
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated","app_metadata":{"storyops_bootstrap_company_id":"98000000-0000-4000-8000-000000000001"}}',
  true
);
set local role authenticated;

\echo '7/9 a pre-created pristine setup scope installs all templates and eleven disabled providers'
do $$
declare
  receipt jsonb;
begin
  receipt := public.complete_storyops_setup(
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000902',
    repeat('9', 64),
    'North Texas Exterior Care',
    'Dana Dispatcher',
    '76051',
    'America/Chicago',
    array['pressure-wash-flatwork', 'gutter-cleaning'],
    true
  );
  if receipt ->> 'status' <> 'configured'
    or (receipt ->> 'replayed')::boolean
    or receipt ->> 'companyStatus' <> 'setup'
    or not (receipt ->> 'requiresLaunchReview')::boolean
    or (receipt ->> 'serviceCount')::integer <> 2
    or (receipt ->> 'availableServiceCount')::integer <> 5
    or (receipt ->> 'integrationsDisabled')::integer <> 11
  then
    raise exception 'Setup receipt is incomplete: %', receipt;
  end if;
end;
$$;

reset role;
do $$
begin
  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = '98000000-0000-4000-8000-000000000001'
      and membership.user_id = '10000000-0000-4000-8000-000000000102'
      and membership.role = 'owner'
      and membership.active
  ) then
    raise exception 'Owner membership was not provisioned';
  end if;
  if (
    select count(*)
    from public.service_catalog service
    where service.company_id = '98000000-0000-4000-8000-000000000001'
      and not service.active
  ) <> 5 or (
    select array_agg(service.code order by service.code)
    from public.service_catalog service
    where service.company_id = '98000000-0000-4000-8000-000000000001'
      and not service.active
  ) is distinct from array[
    'gutter-cleaning',
    'pressure-wash-flatwork',
    'roof-washing',
    'soft-wash-house',
    'window-cleaning'
  ]::text[] then
    raise exception 'The complete inactive service template catalog is incorrect';
  end if;
  if (
    select company.settings -> 'enabledServiceCodes'
    from public.companies company
    where company.id = '98000000-0000-4000-8000-000000000001'
  ) is distinct from '["pressure-wash-flatwork","gutter-cleaning"]'::jsonb then
    raise exception 'Selected initial service scope was not retained separately';
  end if;
  if exists (
    select 1
    from public.price_books price_book
    where price_book.company_id = '98000000-0000-4000-8000-000000000001'
      and price_book.status <> 'draft'
  ) or not exists (
    select 1
    from public.price_books price_book
    where price_book.company_id = '98000000-0000-4000-8000-000000000001'
      and price_book.status = 'draft'
      and price_book.company_minimum = 0
      and price_book.default_tax_rate_pct = 0
  ) then
    raise exception 'Setup published or invented pricing';
  end if;
  if not exists (
    select 1
    from public.service_terms terms
    where terms.company_id = '98000000-0000-4000-8000-000000000001'
      and terms.status = 'draft'
      and terms.reviewed_by is null
  ) then
    raise exception 'Review-required terms draft is missing';
  end if;
  if not exists (
    select 1
    from public.retention_policies policy
    where policy.company_id = '98000000-0000-4000-8000-000000000001'
      and policy.status = 'draft'
      and policy.legal_review_status = 'required'
  ) then
    raise exception 'Review-required retention draft is missing';
  end if;
  if (
    select count(*)
    from public.integration_connections integration
    where integration.company_id = '98000000-0000-4000-8000-000000000001'
      and integration.mode = 'disabled'
      and integration.status = 'disabled'
  ) <> 11 then
    raise exception 'Every setup integration must be disabled';
  end if;
  if (
    select array_agg(integration.provider order by integration.provider)
    from public.integration_connections integration
    where integration.company_id = '98000000-0000-4000-8000-000000000001'
  ) is distinct from array[
    'email',
    'google_calendar',
    'maps',
    'nws',
    'openai',
    'quickbooks_export',
    'signed_storage_targets',
    'stripe',
    'supabase_auth',
    'twilio',
    'vroom'
  ]::text[] then
    raise exception 'Setup provider identities disagree with the finite V1 provider set';
  end if;
  if not exists (
    select 1
    from public.audit_events event
    where event.company_id = '98000000-0000-4000-8000-000000000001'
      and event.action = 'company.setup_completed'
      and event.request_id = '98000000-0000-4000-8000-000000000902'
  ) then
    raise exception 'Setup audit event is missing';
  end if;
end;
$$;
set local role authenticated;

\echo '8/9 setup replay is idempotent while the operational workspace stays closed'
do $$
declare
  receipt jsonb;
  setup_state jsonb;
  workspace_blocked boolean := false;
begin
  receipt := public.complete_storyops_setup(
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000902',
    repeat('9', 64),
    'North Texas Exterior Care',
    'Dana Dispatcher',
    '76051',
    'America/Chicago',
    array['pressure-wash-flatwork', 'gutter-cleaning'],
    true
  );
  if not (receipt ->> 'replayed')::boolean
    or (receipt ->> 'integrationsDisabled')::integer <> 11
  then
    raise exception 'Exact setup replay was not recognized';
  end if;

  setup_state := public.get_storyops_setup_state(null);
  if setup_state ->> 'status' <> 'ready'
    or setup_state ->> 'companyId' <> '98000000-0000-4000-8000-000000000001'
    or setup_state ->> 'role' <> 'owner'
  then
    raise exception 'Configured setup state is invalid: %', setup_state;
  end if;

  begin
    perform public.get_storyops_workspace(
      '98000000-0000-4000-8000-000000000001'
    );
  exception
    when others then
      if position('No active company membership' in sqlerrm) > 0 then
        workspace_blocked := true;
      else
        raise;
      end if;
  end;
  if not workspace_blocked then
    raise exception 'Setup-only company opened the operational workspace before baseline activation';
  end if;
end;
$$;
reset role;
do $$
begin
  if (
    select count(*)
    from public.audit_events event
    where event.company_id = '98000000-0000-4000-8000-000000000001'
      and event.action = 'company.setup_completed'
  ) <> 1 then
    raise exception 'Setup replay duplicated audit evidence';
  end if;
end;
$$;
set local role authenticated;

\echo '9/9 changed setup payload cannot reuse or replace completed setup'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.complete_storyops_setup(
      '98000000-0000-4000-8000-000000000001',
      '98000000-0000-4000-8000-000000000902',
      repeat('9', 64),
      'Changed Exterior Care',
      'Dana Dispatcher',
      '76051',
      'America/Chicago',
      array['soft-wash-house'],
      true
    );
  exception
    when others then
      if position('already complete with a different request' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Changed payload reused an exact setup command and hash';
  end if;
end;
$$;

rollback;

\echo 'StoryOps authenticated live setup contract passed.'
