\set ON_ERROR_STOP on

begin;

\echo '1/3 lead scope rejects a mismatched customer/property pair'
insert into public.customers(id, company_id, display_name, lifecycle)
values
  (
    '94000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000001',
    'Lead scope customer one',
    'active'
  ),
  (
    '94000000-0000-4000-8000-000000000202',
    '10000000-0000-4000-8000-000000000001',
    'Lead scope customer two',
    'active'
  );

insert into public.properties(
  id,
  company_id,
  customer_id,
  name,
  service_address,
  stories
)
values
  (
    '94000000-0000-4000-8000-000000000211',
    '10000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000201',
    'Scope property one',
    '{"line1":"100 Scope St","city":"Dallas","region":"TX","postalCode":"75201","country":"US"}',
    1
  ),
  (
    '94000000-0000-4000-8000-000000000212',
    '10000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000202',
    'Scope property two',
    '{"line1":"200 Scope St","city":"Fort Worth","region":"TX","postalCode":"76102","country":"US"}',
    1
  );

insert into public.leads(
  id,
  company_id,
  source,
  status,
  display_name,
  requested_services
)
values (
  '94000000-0000-4000-8000-000000000221',
  '10000000-0000-4000-8000-000000000001',
  'manual',
  'qualified',
  'Exact scope lead',
  array['pressure-wash-flatwork']
);

set local role authenticated;
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
begin
  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000901',
    'lead.link_scope',
    1,
    jsonb_build_object(
      'entityId', '94000000-0000-4000-8000-000000000221',
      'customerId', '94000000-0000-4000-8000-000000000201',
      'propertyId', '94000000-0000-4000-8000-000000000212'
    ),
    repeat('a', 64)
  );
  raise exception 'Mismatched lead scope was accepted';
exception
  when others then
    if sqlerrm = 'Mismatched lead scope was accepted' then raise; end if;
end;
$$;

\echo '2/3 exact company-owned scope links atomically'
do $$
declare
  receipt jsonb;
begin
  receipt := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000902',
    'lead.link_scope',
    1,
    jsonb_build_object(
      'entityId', '94000000-0000-4000-8000-000000000221',
      'customerId', '94000000-0000-4000-8000-000000000201',
      'propertyId', '94000000-0000-4000-8000-000000000211'
    ),
    repeat('b', 64)
  );
  if receipt ->> 'entityId' <> '94000000-0000-4000-8000-000000000221'
    or (receipt ->> 'version')::integer <> 2
    or (receipt ->> 'replayed')::boolean
  then
    raise exception 'Exact scope receipt is invalid: %', receipt;
  end if;
end;
$$;

\echo '3/3 retry replays and preserves the exact selected chain'
do $$
declare
  replay jsonb;
begin
  replay := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000902',
    'lead.link_scope',
    1,
    jsonb_build_object(
      'entityId', '94000000-0000-4000-8000-000000000221',
      'customerId', '94000000-0000-4000-8000-000000000201',
      'propertyId', '94000000-0000-4000-8000-000000000211'
    ),
    repeat('b', 64)
  );
  if not (replay ->> 'replayed')::boolean then
    raise exception 'Exact scope retry did not replay';
  end if;
end;
$$;

reset role;

do $$
declare
  linked record;
begin
  select status, customer_id, property_id, version
  into linked
  from public.leads
  where id = '94000000-0000-4000-8000-000000000221';

  if linked.status <> 'converted'
    or linked.customer_id <> '94000000-0000-4000-8000-000000000201'
    or linked.property_id <> '94000000-0000-4000-8000-000000000211'
    or linked.version <> 2
  then
    raise exception 'Stored lead scope is invalid';
  end if;
end;
$$;

rollback;

\echo 'StoryOps live lead-scope contract passed'
