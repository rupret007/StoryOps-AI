-- A one-owner exterior-services company must be able to schedule and perform
-- field work without creating a fictitious technician identity. Keep the
-- decision finite: only an active owner or active technician membership is a
-- field worker, and the user must still be date-valid on the selected crew.

create or replace function private.storyops_user_is_field_eligible(
  p_company_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    p_company_id is not null
    and p_user_id is not null
    and exists (
      select 1
      from public.company_memberships membership
      where membership.company_id = p_company_id
        and membership.user_id = p_user_id
        and membership.active
        and membership.role in ('owner', 'technician')
    );
$$;

create or replace function private.storyops_crew_has_field_eligible_workers(
  p_company_id uuid,
  p_crew_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    p_company_id is not null
    and p_crew_id is not null
    and p_starts_at is not null
    and p_ends_at is not null
    and p_ends_at > p_starts_at
    and exists (
      select 1
      from public.crews crew
      where crew.id = p_crew_id
        and crew.company_id = p_company_id
        and crew.active
    )
    -- A selected crew cannot hide an ineligible date-valid member.
    and not exists (
      select 1
      from public.crew_members member
      where member.company_id = p_company_id
        and member.crew_id = p_crew_id
        and member.starts_on
          <= (p_ends_at - interval '1 microsecond')::date
        and (member.ends_on is null or member.ends_on >= p_starts_at::date)
        and not private.storyops_user_is_field_eligible(
          member.company_id,
          member.user_id
        )
    )
    -- Every service date must have at least one exact, date-valid field worker.
    and not exists (
      select 1
      from generate_series(
        p_starts_at::date,
        (p_ends_at - interval '1 microsecond')::date,
        interval '1 day'
      ) service_day
      where not exists (
        select 1
        from public.crew_members member
        where member.company_id = p_company_id
          and member.crew_id = p_crew_id
          and member.starts_on <= service_day::date
          and (
            member.ends_on is null
            or member.ends_on >= service_day::date
          )
          and private.storyops_user_is_field_eligible(
            member.company_id,
            member.user_id
          )
      )
    );
$$;

-- Preserve the existing private function signature used by the scheduling
-- receipt recorder and atomic booking command while correcting its semantics.
create or replace function private.storyops_crew_has_authorized_technicians(
  p_company_id uuid,
  p_crew_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select private.storyops_crew_has_field_eligible_workers(
    p_company_id,
    p_crew_id,
    p_starts_at,
    p_ends_at
  );
$$;

revoke all on function private.storyops_user_is_field_eligible(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_crew_has_field_eligible_workers(
  uuid, uuid, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.storyops_crew_has_authorized_technicians(
  uuid, uuid, timestamptz, timestamptz
) from public, anon, authenticated, service_role;

comment on function private.storyops_user_is_field_eligible(uuid, uuid) is
  'Canonical active-membership predicate for field work: owner or technician only.';
comment on function private.storyops_crew_has_field_eligible_workers(
  uuid, uuid, timestamptz, timestamptz
) is
  'Requires an active crew whose every date-valid member is an active owner/technician and that has a field worker on every service date.';
comment on function private.storyops_crew_has_authorized_technicians(
  uuid, uuid, timestamptz, timestamptz
) is
  'Compatibility wrapper for the canonical owner-or-technician field eligibility predicate.';
