-- Trusted incident evidence remains recordable while ordinary field work is
-- stopped. Bind every staged object and durable row to the exact active
-- company, open incident, assigned visit, job, and property.

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
    return public.is_assigned_technician_for_visit(scope_id);
  end if;
  return false;
exception
  when invalid_text_representation then
    return false;
end;
$$;

revoke all on function public.can_upload_job_media_object(text) from public;
grant execute on function public.can_upload_job_media_object(text)
  to authenticated, service_role;

comment on function public.can_upload_job_media_object(text) is
  'Read-only private Storage staging predicate. Incident paths bind an existing incident to its exact company/visit/job/property and allow only owner/dispatcher or the assigned technician; the trusted finalizer enforces unresolved/closure capture time and customer browser uploads remain closed behind the signed scope-photo workflow.';

create or replace function public.enforce_storyops_incident_media_association()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  immutable_evidence boolean := false;
begin
  if tg_op = 'UPDATE' then
    immutable_evidence :=
      old.purpose in ('incident', 'safety', 'damage')
      and row(
      new.id,
      new.company_id,
      new.property_id,
      new.job_id,
      new.visit_id,
      new.incident_id,
      new.purpose,
      new.object_path,
      new.content_type,
      new.byte_size,
      new.checksum_sha256,
      new.captured_at,
      new.captured_by,
      new.offline_client_id
    ) is not distinct from row(
      old.id,
      old.company_id,
      old.property_id,
      old.job_id,
      old.visit_id,
      old.incident_id,
      old.purpose,
      old.object_path,
      old.content_type,
      old.byte_size,
      old.checksum_sha256,
      old.captured_at,
      old.captured_by,
      old.offline_client_id
    );
  end if;
  if tg_op = 'UPDATE'
    and old.purpose in ('incident', 'safety', 'damage')
    and not immutable_evidence
  then
    raise exception using message = 'INCIDENT_MEDIA_IMMUTABLE_ASSOCIATION';
  end if;
  if new.purpose not in ('incident', 'safety', 'damage') then
    if new.incident_id is not null then
      raise exception using message = 'INCIDENT_MEDIA_PURPOSE_REQUIRED';
    end if;
    return new;
  end if;
  if new.customer_visible
    or new.incident_id is null
    or new.visit_id is null
    or new.job_id is null
    or new.property_id is null
    or new.captured_at > clock_timestamp() + interval '5 minutes'
  then
    raise exception using message = 'INCIDENT_MEDIA_EXACT_PRIVATE_ASSOCIATION_REQUIRED';
  end if;
  if immutable_evidence then
    return new;
  end if;
  if not exists (
    select 1
    from public.incidents incident
    join public.visits visit
      on visit.id = new.visit_id
     and visit.company_id = incident.company_id
    join public.jobs job
      on job.id = visit.job_id
     and job.company_id = visit.company_id
    where incident.id = new.incident_id
      and incident.company_id = new.company_id
      and (
        incident.status in ('open', 'investigating', 'corrective_action')
        or (
          incident.status = 'closed'
          and incident.closed_at is not null
          and new.captured_at <= incident.closed_at + interval '5 minutes'
        )
      )
      and visit.id = new.visit_id
      and visit.job_id = new.job_id
      and job.property_id = new.property_id
      and (
        incident.visit_id = visit.id
        or incident.job_id = job.id
        or (
          incident.visit_id is null
          and incident.job_id is null
          and incident.property_id = job.property_id
        )
      )
  ) or new.object_path not like concat(
    new.company_id::text,
    '/incidents/',
    new.incident_id::text,
    '/visits/',
    new.visit_id::text,
    '/',
    new.id::text,
    '-',
    left(new.checksum_sha256, 16),
    '-%'
  ) then
    raise exception using message = 'INCIDENT_MEDIA_OPEN_SCOPE_MISMATCH';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_storyops_incident_media_association()
  from public, anon, authenticated, service_role;

create trigger media_assets_incident_evidence_guard
before insert or update on public.media_assets
for each row execute function public.enforce_storyops_incident_media_association();

comment on function public.enforce_storyops_incident_media_association() is
  'Fail-closed incident evidence guard: exact incident/company/visit/job/property, private visibility, content-addressed path, and closure-time cutoff for late offline replay.';

create or replace function public.finalize_storyops_media_upload(
  p_company_id uuid,
  p_command_id uuid,
  p_actor_user_id uuid,
  p_payload jsonb,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_role public.app_role;
  asset_id_value uuid := nullif(p_payload ->> 'entityId', '')::uuid;
  visit_id_value uuid := nullif(p_payload ->> 'visitId', '')::uuid;
  job_id_value uuid := nullif(p_payload ->> 'jobId', '')::uuid;
  property_id_value uuid := nullif(p_payload ->> 'propertyId', '')::uuid;
  incident_id_value uuid := nullif(p_payload ->> 'incidentId', '')::uuid;
  incident_status_value text;
  incident_closed_at_value timestamptz;
  visit_job_id_value uuid;
  visit_property_id_value uuid;
  captured_at_value timestamptz := nullif(p_payload ->> 'capturedAt', '')::timestamptz;
  evidence_purpose boolean;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  inserted_reservation_id uuid;
  resulting_version integer;
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Media finalization requires the trusted service boundary';
  end if;
  if not public.lock_storyops_active_company(p_company_id) then
    raise exception 'Media finalization requires an active company';
  end if;
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or exists (
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in (
        'entityId', 'visitId', 'jobId', 'propertyId', 'incidentId', 'purpose',
        'objectPath', 'contentType', 'byteSize', 'checksumSha256', 'capturedAt',
        'customerVisible'
      )
    )
  then
    raise exception 'Media finalization payload is invalid';
  end if;
  evidence_purpose := p_payload ->> 'purpose' in ('incident', 'safety', 'damage');
  if p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or asset_id_value is null
    or visit_id_value is null
    or job_id_value is null
    or property_id_value is null
    or captured_at_value is null
    or p_payload ->> 'purpose'
      not in ('before', 'after', 'signature', 'incident', 'safety', 'damage')
    or evidence_purpose <> (incident_id_value is not null)
    or p_payload ->> 'contentType' not in ('image/jpeg', 'image/png', 'image/webp')
    or (p_payload ->> 'byteSize')::bigint not between 1 and 15728640
    or p_payload ->> 'checksumSha256' !~ '^[a-f0-9]{64}$'
    or coalesce((p_payload ->> 'customerVisible')::boolean, true)
  then
    raise exception 'Media finalization fields are invalid';
  end if;
  if captured_at_value > clock_timestamp() + interval '5 minutes'
    or (
      not evidence_purpose
      and captured_at_value < clock_timestamp() - interval '30 days'
    )
  then
    raise exception 'Media timestamp is outside the permitted recovery window';
  end if;

  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = p_actor_user_id
    and membership.active;
  if actor_role is null then
    raise exception 'No active company membership';
  end if;

  effective_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'commandType', 'media.register',
    'expectedVersion', 0,
    'payload', p_payload
  ));
  if effective_request_hash <> p_request_hash then
    raise exception 'Media command request hash does not match its canonical payload';
  end if;
  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'field-media-finalize-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into inserted_reservation_id;

  if inserted_reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'field-media-finalize-v1'
      and key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception 'Media command ID was reused with a different payload';
    end if;
    if reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'The same media command is already in progress';
  end if;

  if actor_role = 'technician'
    and not exists (
      select 1
      from public.visits assigned_visit
      join public.crews assigned_crew
        on assigned_crew.id = assigned_visit.crew_id
       and assigned_crew.company_id = assigned_visit.company_id
       and assigned_crew.active
      join public.crew_members assigned_member
        on assigned_member.crew_id = assigned_crew.id
       and assigned_member.company_id = assigned_crew.company_id
      join public.company_memberships assigned_membership
        on assigned_membership.company_id = assigned_member.company_id
       and assigned_membership.user_id = assigned_member.user_id
      where assigned_visit.id = visit_id_value
        and assigned_visit.company_id = p_company_id
        and assigned_member.user_id = p_actor_user_id
        and assigned_member.starts_on <= assigned_visit.ends_at::date
        and (
          assigned_member.ends_on is null
          or assigned_member.ends_on >= assigned_visit.starts_at::date
        )
        and assigned_membership.active
        and assigned_membership.role = 'technician'
    )
  then
    raise exception 'Technician is not assigned to this visit';
  elsif actor_role not in ('owner', 'dispatcher', 'technician') then
    raise exception 'Role cannot finalize field media';
  end if;

  select visit.job_id, job.property_id
  into visit_job_id_value, visit_property_id_value
  from public.visits visit
  join public.jobs job
    on job.id = visit.job_id
   and job.company_id = visit.company_id
  where visit.id = visit_id_value
    and visit.company_id = p_company_id
    and visit.status in ('on_site', 'paused');
  if not found
    or visit_job_id_value <> job_id_value
    or visit_property_id_value <> property_id_value
  then
    raise exception 'Media visit lifecycle or associations disagree';
  end if;

  if evidence_purpose then
    select incident.status, incident.closed_at
    into incident_status_value, incident_closed_at_value
    from public.incidents incident
    where incident.id = incident_id_value
      and incident.company_id = p_company_id
      and (
        incident.visit_id = visit_id_value
        or incident.job_id = job_id_value
        or (
          incident.visit_id is null
          and incident.job_id is null
          and incident.property_id = property_id_value
        )
      );
    if not found
      or (
        incident_status_value not in ('open', 'investigating', 'corrective_action')
        and not (
          incident_status_value = 'closed'
          and incident_closed_at_value is not null
          and captured_at_value <= incident_closed_at_value + interval '5 minutes'
        )
      )
      or p_payload ->> 'objectPath' not like concat(
      p_company_id::text,
      '/incidents/',
      incident_id_value::text,
      '/visits/',
      visit_id_value::text,
      '/',
      asset_id_value::text,
      '-',
      left(p_payload ->> 'checksumSha256', 16),
      '-%'
    ) then
      raise exception 'Incident media requires the exact incident, visit, and capture-time scope';
    end if;
  elsif p_payload ->> 'objectPath' not like concat(
    p_company_id::text,
    '/visits/',
    visit_id_value::text,
    '/',
    asset_id_value::text,
    '-',
    left(p_payload ->> 'checksumSha256', 16),
    '-%'
  ) then
    raise exception 'Media visit path is not content-addressed to the exact asset';
  end if;

  perform public.attest_storyops_media_upload(
    p_company_id,
    p_command_id,
    p_actor_user_id,
    asset_id_value,
    p_payload ->> 'objectPath',
    p_payload ->> 'checksumSha256',
    (p_payload ->> 'byteSize')::bigint,
    p_payload ->> 'contentType'
  );

  insert into public.media_assets(
    id, company_id, property_id, job_id, visit_id, incident_id, purpose,
    object_path, content_type, byte_size, checksum_sha256, captured_at,
    captured_by, customer_visible, offline_client_id, sync_state
  )
  values (
    asset_id_value, p_company_id, property_id_value, job_id_value, visit_id_value,
    incident_id_value, p_payload ->> 'purpose', p_payload ->> 'objectPath',
    p_payload ->> 'contentType', (p_payload ->> 'byteSize')::bigint,
    p_payload ->> 'checksumSha256', captured_at_value, p_actor_user_id, false,
    p_command_id::text, 'synced'
  )
  returning version into resulting_version;

  if evidence_purpose and incident_status_value = 'closed' then
    insert into public.audit_events(
      company_id, actor_type, actor_id, action, entity_type, entity_id,
      after_data, request_id, retain_until
    )
    values (
      p_company_id,
      'user',
      p_actor_user_id::text,
      'incident.evidence_late_attachment',
      'media_asset',
      asset_id_value,
      jsonb_build_object(
        'incidentId', incident_id_value,
        'visitId', visit_id_value,
        'capturedAt', captured_at_value,
        'incidentClosedAt', incident_closed_at_value,
        'customerVisible', false
      ),
      p_command_id::text,
      now() + interval '7 years'
    );
  end if;

  result := jsonb_build_object(
    'commandId', p_command_id,
    'commandType', 'media.register',
    'status', 'applied',
    'replayed', false,
    'entityId', asset_id_value,
    'version', resulting_version,
    'requestHash', p_request_hash,
    'serverTime', clock_timestamp()
  );
  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now()
  where id = inserted_reservation_id;
  return result;
end;
$$;

revoke all on function public.finalize_storyops_media_upload(
  uuid, uuid, uuid, jsonb, text
) from public, anon, authenticated;
grant execute on function public.finalize_storyops_media_upload(
  uuid, uuid, uuid, jsonb, text
) to service_role;

comment on function public.finalize_storyops_media_upload(
  uuid, uuid, uuid, jsonb, text
) is
  'Strict content-addressed private field-media finalizer. Incident/safety/damage evidence binds the exact incident and visit, preserves old offline capture facts without an arbitrary lower-age rejection, and permits audited late replay after closure only for evidence captured by the closure-time skew bound.';
