\set ON_ERROR_STOP on

begin;

\echo '1/5 owner and technician memberships are field-eligible; dispatcher/customer are not'
do $$
begin
  if not private.storyops_user_is_field_eligible(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101'
  ) then
    raise exception 'Active owner was not field-eligible';
  end if;
  if not private.storyops_user_is_field_eligible(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000103'
  ) then
    raise exception 'Active technician was not field-eligible';
  end if;
  if private.storyops_user_is_field_eligible(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000102'
  ) or private.storyops_user_is_field_eligible(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104'
  ) then
    raise exception 'Non-field role was field-eligible';
  end if;
  if private.storyops_user_is_field_eligible(
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101'
  ) then
    raise exception 'Field eligibility escaped its company';
  end if;
end;
$$;

insert into public.crews (
  id, company_id, name, active, lead_technician_id, skill_codes,
  home_base_postal_code
)
values (
  '94700000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'Owner-only eligibility contract crew',
  true,
  '10000000-0000-4000-8000-000000000101',
  array['pressure-washing'],
  '75201'
);

insert into public.crew_members (
  id, company_id, crew_id, user_id, starts_on
)
values (
  '94700000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  '94700000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000101',
  current_date - 1
);

\echo '2/5 an owner-only crew is eligible through both canonical and compatibility predicates'
do $$
declare
  starts_at timestamptz := date_trunc('day', now() + interval '2 days')
    + interval '9 hours';
  ends_at timestamptz := date_trunc('day', now() + interval '2 days')
    + interval '11 hours';
begin
  if not private.storyops_crew_has_field_eligible_workers(
    '10000000-0000-4000-8000-000000000001',
    '94700000-0000-4000-8000-000000000001',
    starts_at,
    ends_at
  ) then
    raise exception 'Owner-only crew was not eligible';
  end if;
  if not private.storyops_crew_has_authorized_technicians(
    '10000000-0000-4000-8000-000000000001',
    '94700000-0000-4000-8000-000000000001',
    starts_at,
    ends_at
  ) then
    raise exception 'Scheduling compatibility predicate excluded the owner';
  end if;
end;
$$;

\echo '3/5 a half-open visit ending at midnight does not require next-day membership'
update public.crew_members
set ends_on = (current_date + 2)
where id = '94700000-0000-4000-8000-000000000002';

do $$
declare
  starts_at timestamptz := (current_date + 2)::timestamptz
    + interval '22 hours';
  ends_at timestamptz := (current_date + 3)::timestamptz;
begin
  if not private.storyops_crew_has_field_eligible_workers(
    '10000000-0000-4000-8000-000000000001',
    '94700000-0000-4000-8000-000000000001',
    starts_at,
    ends_at
  ) then
    raise exception 'A midnight-exclusive end incorrectly required next-day membership';
  end if;
end;
$$;

update public.crew_members
set ends_on = null
where id = '94700000-0000-4000-8000-000000000002';

\echo '4/5 authoritative scheduling candidate includes the active owner field worker'
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

do $$
declare
  snapshot jsonb;
begin
  snapshot := public.load_storyops_scheduling_candidate(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000631',
    date_trunc('day', now() + interval '2 days') + interval '9 hours',
    date_trunc('day', now() + interval '2 days') + interval '11 hours',
    '94700000-0000-4000-8000-000000000001'
  );
  if not exists (
    select 1
    from jsonb_array_elements(snapshot -> 'technician_memberships') membership
    where membership ->> 'user_id' =
        '10000000-0000-4000-8000-000000000101'
      and membership ->> 'role' = 'owner'
      and (membership ->> 'active')::boolean
  ) then
    raise exception 'Owner field worker was missing from scheduling facts: %', snapshot;
  end if;
  if snapshot -> 'property' ->> 'reviewed_geocode' <> 'false' then
    raise exception 'Legacy seed coordinates were represented as reviewed live proof: %',
      snapshot -> 'property';
  end if;
end;
$$;

\echo '5/5 non-field or offboarded crew members fail closed'
insert into public.crew_members (
  id, company_id, crew_id, user_id, starts_on
)
values (
  '94700000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000001',
  '94700000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000102',
  current_date - 1
);

do $$
declare
  starts_at timestamptz := date_trunc('day', now() + interval '2 days')
    + interval '9 hours';
  ends_at timestamptz := date_trunc('day', now() + interval '2 days')
    + interval '11 hours';
begin
  if private.storyops_crew_has_field_eligible_workers(
    '10000000-0000-4000-8000-000000000001',
    '94700000-0000-4000-8000-000000000001',
    starts_at,
    ends_at
  ) then
    raise exception 'Crew with dispatcher member remained eligible';
  end if;
end;
$$;

delete from public.crew_members
where id = '94700000-0000-4000-8000-000000000003';

-- Keep a second active owner while testing the original owner's offboarding so
-- the production last-owner invariant remains intact.
update public.company_memberships
set role = 'owner'
where company_id = '10000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000102';
update public.company_memberships
set active = false
where company_id = '10000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000101';

do $$
declare
  starts_at timestamptz := date_trunc('day', now() + interval '2 days')
    + interval '9 hours';
  ends_at timestamptz := date_trunc('day', now() + interval '2 days')
    + interval '11 hours';
begin
  if private.storyops_user_is_field_eligible(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101'
  ) or private.storyops_crew_has_field_eligible_workers(
    '10000000-0000-4000-8000-000000000001',
    '94700000-0000-4000-8000-000000000001',
    starts_at,
    ends_at
  ) then
    raise exception 'Offboarded owner retained field eligibility';
  end if;
end;
$$;

rollback;
