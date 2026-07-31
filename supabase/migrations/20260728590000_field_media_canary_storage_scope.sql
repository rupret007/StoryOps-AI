-- Trusted field-media canaries use a server-created, inactive rehearsal crew
-- so they never appear operationally dispatchable. Give only the exact
-- executing run's assigned field worker access to its one content-addressed
-- Storage object; all ordinary field-media paths retain the active-crew rule.

create or replace function private.is_storyops_field_media_canary_object(
  p_object_path text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1
    from public.trusted_pilot_verification_runs run
    join public.companies company
      on company.id = run.company_id
     and company.status = 'active'
    join public.visits visit
      on visit.id = run.visit_id
     and visit.company_id = run.company_id
     and visit.status in ('on_site', 'paused')
    join public.jobs job
      on job.id = run.job_id
     and job.id = visit.job_id
     and job.company_id = run.company_id
     and job.property_id = run.property_id
     and job.status = 'in_progress'
    join public.customers customer
      on customer.id = job.customer_id
     and customer.company_id = job.company_id
     and customer.lifecycle = 'inactive'
     and customer.do_not_contact
     and customer.acquisition_source = 'system_controlled_rehearsal'
     and customer.tags @> array['storyops-controlled-rehearsal']::text[]
    join public.crews crew
      on crew.id = visit.crew_id
     and crew.company_id = visit.company_id
     and not crew.active
    join public.crew_members crew_member
      on crew_member.company_id = crew.company_id
     and crew_member.crew_id = crew.id
     and crew_member.user_id = run.assigned_user_id
     and crew_member.starts_on <= visit.ends_at::date
     and (
       crew_member.ends_on is null
       or crew_member.ends_on >= visit.starts_at::date
     )
    join public.company_memberships membership
      on membership.company_id = run.company_id
     and membership.user_id = run.assigned_user_id
     and membership.active
    where run.kind = 'field_media_canary'
      and run.status = 'executing'
      and run.execution_command_id is not null
      and run.media_command_id is not null
      and run.media_asset_id is not null
      and run.object_path = p_object_path
      and run.assigned_user_id = auth.uid()
      and (
        (
          run.field_worker_role = 'technician'
          and membership.role = 'technician'
        )
        or (
          run.field_worker_role = 'owner_field_worker'
          and membership.role = 'owner'
          and run.requested_by_user_id = run.assigned_user_id
        )
      )
  );
$$;

revoke all on function private.is_storyops_field_media_canary_object(text)
  from public, anon, authenticated, service_role;

create or replace function public.can_upload_job_media_object(target_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, storage
as $$
declare
  folders text[] := storage.foldername(target_name);
  target_company_id uuid;
  scope_id uuid;
  incident_id_value uuid;
  visit_id_value uuid;
begin
  if cardinality(folders) < 3
    or folders[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    return false;
  end if;
  target_company_id := folders[1]::uuid;
  if not exists (
    select 1
    from public.companies company
    where company.id = target_company_id
      and company.status = 'active'
  ) then
    return false;
  end if;

  if folders[2] = 'incidents' then
    if cardinality(folders) <> 5
      or folders[3] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or folders[4] <> 'visits'
      or folders[5] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then
      return false;
    end if;
    incident_id_value := folders[3]::uuid;
    visit_id_value := folders[5]::uuid;
    if not exists (
      select 1
      from public.incidents incident
      join public.visits visit
        on visit.id = visit_id_value
       and visit.company_id = incident.company_id
      join public.jobs job
        on job.id = visit.job_id
       and job.company_id = visit.company_id
      where incident.id = incident_id_value
        and incident.company_id = target_company_id
        and incident.status in ('open', 'investigating', 'corrective_action', 'closed')
        and (
          incident.visit_id = visit.id
          or incident.job_id = job.id
          or (
            incident.visit_id is null
            and incident.job_id is null
            and incident.property_id = job.property_id
          )
        )
    ) then
      return false;
    end if;
    if public.has_company_role(
      target_company_id,
      array['owner', 'dispatcher']::public.app_role[]
    ) then
      return true;
    end if;
    return public.has_company_role(
      target_company_id,
      array['technician']::public.app_role[]
    ) and public.is_assigned_technician_for_visit(visit_id_value);
  end if;

  if folders[3] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  scope_id := folders[3]::uuid;
  if public.has_company_role(
    target_company_id,
    array['owner', 'dispatcher']::public.app_role[]
  ) then
    return folders[2] in ('visits', 'customers', 'scope');
  end if;
  if folders[2] = 'visits'
    and public.has_company_role(
      target_company_id,
      array['technician']::public.app_role[]
    )
  then
    return public.is_assigned_technician_for_visit(scope_id)
      or private.is_storyops_field_media_canary_object(target_name);
  end if;
  return false;
exception
  when invalid_text_representation then
    return false;
end;
$$;

revoke all on function public.can_upload_job_media_object(text)
  from public, anon, authenticated, service_role;
grant execute on function public.can_upload_job_media_object(text)
  to authenticated, service_role;

comment on function public.can_upload_job_media_object(text) is
  'Read-only private Storage staging predicate. Ordinary visit and incident paths retain active-company, role, and active-assignment checks; one exact executing controlled-rehearsal path is available only to its assigned field worker.';
