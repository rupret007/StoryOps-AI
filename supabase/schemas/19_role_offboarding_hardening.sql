-- Role offboarding must revoke portal and field access immediately even when a
-- stale portal/crew mapping remains for audit or operational reconciliation.

create or replace function public.is_customer_user(
  target_company_id uuid,
  target_customer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.customer_portal_users portal
    join public.company_memberships membership
      on membership.company_id = portal.company_id
     and membership.user_id = portal.user_id
    where portal.company_id = target_company_id
      and portal.customer_id = target_customer_id
      and portal.user_id = auth.uid()
      and membership.active
      and membership.role = 'customer'
  );
$$;

create or replace function public.is_assigned_technician_for_job(target_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.jobs job
    join public.crews crew
      on crew.id = job.assigned_crew_id
     and crew.company_id = job.company_id
     and crew.active
    join public.crew_members crew_member
      on crew_member.crew_id = crew.id
     and crew_member.company_id = crew.company_id
    join public.company_memberships membership
      on membership.company_id = crew_member.company_id
     and membership.user_id = crew_member.user_id
    where job.id = target_job_id
      and crew_member.user_id = auth.uid()
      and crew_member.starts_on <= current_date
      and (crew_member.ends_on is null or crew_member.ends_on >= current_date)
      and membership.active
      and membership.role = 'technician'
  );
$$;

create or replace function public.is_assigned_technician_for_visit(target_visit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.visits visit
    join public.crews crew
      on crew.id = visit.crew_id
     and crew.company_id = visit.company_id
     and crew.active
    join public.crew_members crew_member
      on crew_member.crew_id = crew.id
     and crew_member.company_id = crew.company_id
    join public.company_memberships membership
      on membership.company_id = crew_member.company_id
     and membership.user_id = crew_member.user_id
    where visit.id = target_visit_id
      and crew_member.user_id = auth.uid()
      and crew_member.starts_on <= visit.ends_at::date
      and (crew_member.ends_on is null or crew_member.ends_on >= visit.starts_at::date)
      and membership.active
      and membership.role = 'technician'
  );
$$;

revoke all on function public.is_customer_user(uuid, uuid)
  from public, anon;
revoke all on function public.is_assigned_technician_for_job(uuid)
  from public, anon;
revoke all on function public.is_assigned_technician_for_visit(uuid)
  from public, anon;
grant execute on function public.is_customer_user(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.is_assigned_technician_for_job(uuid)
  to authenticated, service_role;
grant execute on function public.is_assigned_technician_for_visit(uuid)
  to authenticated, service_role;

-- RLS does not govern TRUNCATE and row triggers do not observe it. Browser and
-- provider API roles never need schema mutation privileges on business tables.
revoke truncate, references, trigger on all tables in schema public
  from anon, authenticated, service_role;
alter default privileges in schema public
  revoke truncate, references, trigger on tables
  from anon, authenticated, service_role;

comment on function public.is_customer_user(uuid, uuid) is
  'Portal authorization requires both the exact portal mapping and a current active customer membership.';
comment on function public.is_assigned_technician_for_job(uuid) is
  'Field authorization requires current crew assignment, active crew, and current active technician membership.';
comment on function public.is_assigned_technician_for_visit(uuid) is
  'Visit authorization requires date-valid crew assignment, active crew, and current active technician membership.';
