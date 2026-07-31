-- Finite Edge finalization boundary. Normal field media delegates unchanged.
-- A trusted-pilot field-media rehearsal uses an intentionally inactive,
-- non-customer crew; activate that exact server-created crew only within this
-- transaction so the production assignment guard is exercised without ever
-- publishing an operationally active rehearsal crew.

create or replace function public.finalize_storyops_media_upload_from_edge(
  p_company_id uuid,
  p_command_id uuid,
  p_actor_user_id uuid,
  p_payload jsonb,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  canary_run_id uuid;
  canary_crew_id uuid;
  canary_crew_was_active boolean;
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'FIELD_MEDIA_EDGE_SERVICE_ROLE_REQUIRED';
  end if;

  select
    run.id,
    crew.id,
    crew.active
  into
    canary_run_id,
    canary_crew_id,
    canary_crew_was_active
  from public.trusted_pilot_verification_runs run
  join public.visits visit
    on visit.id = run.visit_id
   and visit.company_id = run.company_id
  join public.crews crew
    on crew.id = visit.crew_id
   and crew.company_id = visit.company_id
  join public.jobs job
    on job.id = run.job_id
   and job.id = visit.job_id
   and job.company_id = run.company_id
  join public.customers customer
    on customer.id = job.customer_id
   and customer.company_id = job.company_id
  where run.company_id = p_company_id
    and run.kind = 'field_media_canary'
    and run.status = 'executing'
    and run.assigned_user_id = p_actor_user_id
    and run.media_command_id = p_command_id
    and run.media_asset_id::text = p_payload ->> 'entityId'
    and run.visit_id::text = p_payload ->> 'visitId'
    and run.job_id::text = p_payload ->> 'jobId'
    and run.property_id::text = p_payload ->> 'propertyId'
    and run.object_path = p_payload ->> 'objectPath'
    and run.execution_command_id is not null
    and customer.lifecycle = 'inactive'
    and customer.do_not_contact
    and customer.acquisition_source = 'system_controlled_rehearsal'
    and customer.tags @> array['storyops-controlled-rehearsal']::text[]
    and visit.status in ('on_site', 'paused')
  for update of run, crew;

  if canary_run_id is not null and not canary_crew_was_active then
    update public.crews
    set active = true
    where id = canary_crew_id
      and company_id = p_company_id
      and not active;
  end if;

  result := public.finalize_storyops_media_upload(
    p_company_id,
    p_command_id,
    p_actor_user_id,
    p_payload,
    p_request_hash
  );

  if canary_run_id is not null and not canary_crew_was_active then
    update public.crews
    set active = false
    where id = canary_crew_id
      and company_id = p_company_id
      and active;
  end if;

  return result;
end;
$$;

revoke all on function public.finalize_storyops_media_upload_from_edge(
  uuid, uuid, uuid, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_storyops_media_upload_from_edge(
  uuid, uuid, uuid, jsonb, text
) to service_role;

comment on function public.finalize_storyops_media_upload_from_edge(
  uuid, uuid, uuid, jsonb, text
) is
  'Service-role-only Edge adapter for the canonical durable-media finalizer. It transactionally activates only an exact executing, server-created, do-not-contact controlled rehearsal crew and restores it inactive before commit.';
