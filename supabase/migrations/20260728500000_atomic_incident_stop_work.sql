-- An incident opened against active field work is one safety transaction:
-- preserve exact supplied facts, stop every active visit timer, and pause the
-- exact visit before returning a durable idempotent receipt. Ordinary work
-- remains fail-closed until every relevant visit/job/property incident closes.

create table private.storyops_incident_stop_capabilities (
  capability_token uuid primary key,
  backend_pid integer not null,
  transaction_id bigint not null,
  company_id uuid not null,
  command_id uuid not null,
  actor_user_id uuid not null,
  incident_id uuid not null,
  visit_id uuid not null,
  created_at timestamptz not null default now(),
  unique (backend_pid, transaction_id, incident_id)
);

revoke all on table private.storyops_incident_stop_capabilities
  from public, anon, authenticated, service_role;

create or replace function private.authorize_storyops_incident_stop(
  p_company_id uuid,
  p_command_id uuid,
  p_actor_user_id uuid,
  p_incident_id uuid,
  p_visit_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  capability_token_value uuid := gen_random_uuid();
begin
  delete from private.storyops_incident_stop_capabilities capability
  where capability.backend_pid = pg_backend_pid()
    and capability.transaction_id = txid_current();

  insert into private.storyops_incident_stop_capabilities(
    capability_token, backend_pid, transaction_id, company_id, command_id,
    actor_user_id, incident_id, visit_id
  )
  values (
    capability_token_value, pg_backend_pid(), txid_current(), p_company_id,
    p_command_id, p_actor_user_id, p_incident_id, p_visit_id
  );

  perform set_config(
    'storyops.incident_stop_capability',
    capability_token_value::text,
    true
  );
  return capability_token_value;
end;
$$;

revoke all on function private.authorize_storyops_incident_stop(
  uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

create or replace function public.require_atomic_storyops_incident_stop()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  capability_token_value uuid;
begin
  if new.visit_id is null then
    if (
      new.job_id is not null
      and exists (
        select 1
        from public.visits visit
        where visit.company_id = new.company_id
          and visit.job_id = new.job_id
          and visit.status in ('en_route', 'on_site', 'paused')
      )
    ) or (
      new.job_id is null
      and new.property_id is not null
      and exists (
        select 1
        from public.visits visit
        join public.jobs job
          on job.id = visit.job_id
         and job.company_id = visit.company_id
        where visit.company_id = new.company_id
          and job.property_id = new.property_id
          and visit.status in ('en_route', 'on_site', 'paused')
      )
    ) then
      raise exception using
        errcode = '55000',
        message = 'INCIDENT_ATOMIC_STOP_REQUIRED';
    end if;
    return new;
  end if;

  begin
    capability_token_value :=
      nullif(current_setting('storyops.incident_stop_capability', true), '')::uuid;
  exception
    when invalid_text_representation then
      capability_token_value := null;
  end;

  if capability_token_value is null
    or not exists (
      select 1
      from private.storyops_incident_stop_capabilities capability
      where capability.capability_token = capability_token_value
        and capability.backend_pid = pg_backend_pid()
        and capability.transaction_id = txid_current()
        and capability.company_id = new.company_id
        and capability.actor_user_id = new.reported_by
        and capability.incident_id = new.id
        and capability.visit_id = new.visit_id
    )
  then
    raise exception using
      errcode = '55000',
      message = 'INCIDENT_ATOMIC_STOP_REQUIRED';
  end if;

  delete from private.storyops_incident_stop_capabilities capability
  where capability.capability_token = capability_token_value
    and capability.backend_pid = pg_backend_pid()
    and capability.transaction_id = txid_current();
  perform set_config('storyops.incident_stop_capability', '', true);
  return new;
end;
$$;

revoke all on function public.require_atomic_storyops_incident_stop()
  from public, anon, authenticated, service_role;

create trigger incidents_require_atomic_stop
before insert on public.incidents
for each row execute function public.require_atomic_storyops_incident_stop();

-- Incident closure is a distinct owner command. RLS alone must never allow a
-- dispatcher or a direct owner UPDATE to forge status/closure evidence and
-- thereby release the stop-work guard.
create table private.storyops_incident_close_capabilities (
  capability_token uuid primary key,
  backend_pid integer not null,
  transaction_id bigint not null,
  company_id uuid not null,
  command_id uuid not null,
  actor_user_id uuid not null,
  incident_id uuid not null,
  expected_incident_version integer not null
    check (expected_incident_version > 0),
  closure_note text not null
    check (char_length(btrim(closure_note)) between 5 and 2000),
  closed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (backend_pid, transaction_id, incident_id)
);

revoke all on table private.storyops_incident_close_capabilities
  from public, anon, authenticated, service_role;

create or replace function private.authorize_storyops_incident_close(
  p_company_id uuid,
  p_command_id uuid,
  p_actor_user_id uuid,
  p_incident_id uuid,
  p_expected_incident_version integer,
  p_closure_note text,
  p_closed_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  capability_token_value uuid := gen_random_uuid();
begin
  delete from private.storyops_incident_close_capabilities capability
  where capability.backend_pid = pg_backend_pid()
    and capability.transaction_id = txid_current();

  insert into private.storyops_incident_close_capabilities(
    capability_token, backend_pid, transaction_id, company_id, command_id,
    actor_user_id, incident_id, expected_incident_version, closure_note,
    closed_at
  )
  values (
    capability_token_value, pg_backend_pid(), txid_current(), p_company_id,
    p_command_id, p_actor_user_id, p_incident_id,
    p_expected_incident_version, p_closure_note, p_closed_at
  );

  perform set_config(
    'storyops.incident_close_capability',
    capability_token_value::text,
    true
  );
  return capability_token_value;
end;
$$;

revoke all on function private.authorize_storyops_incident_close(
  uuid, uuid, uuid, uuid, integer, text, timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.enforce_storyops_incident_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  capability_token_value uuid;
  capability private.storyops_incident_close_capabilities%rowtype;
  closure_mutation boolean :=
    (
      new.status is distinct from old.status
      and (new.status = 'closed' or old.status = 'closed')
    )
    or new.closure_note is distinct from old.closure_note
    or new.closed_at is distinct from old.closed_at
    or new.closed_by is distinct from old.closed_by;
begin
  if closure_mutation then
    begin
      capability_token_value :=
        nullif(
          current_setting('storyops.incident_close_capability', true),
          ''
        )::uuid;
    exception
      when invalid_text_representation then
        capability_token_value := null;
    end;

    select *
    into capability
    from private.storyops_incident_close_capabilities candidate
    where candidate.capability_token = capability_token_value
      and candidate.backend_pid = pg_backend_pid()
      and candidate.transaction_id = txid_current();

    if capability.capability_token is null
      or capability.company_id <> old.company_id
      or capability.actor_user_id is distinct from auth.uid()
      or capability.incident_id <> old.id
      or capability.expected_incident_version <> old.version
      or old.status not in ('open', 'investigating', 'corrective_action')
      or new.status <> 'closed'
      or new.closure_note <> capability.closure_note
      or new.closed_at <> capability.closed_at
      or new.closed_by <> capability.actor_user_id
      or (
        to_jsonb(new) - array[
          'status', 'closure_note', 'closed_at', 'closed_by',
          'updated_at', 'version'
        ]
      ) is distinct from (
        to_jsonb(old) - array[
          'status', 'closure_note', 'closed_at', 'closed_by',
          'updated_at', 'version'
        ]
      )
    then
      raise exception using
        errcode = '55000',
        message = 'INCIDENT_CLOSE_COMMAND_REQUIRED';
    end if;

    delete from private.storyops_incident_close_capabilities candidate
    where candidate.capability_token = capability_token_value
      and candidate.backend_pid = pg_backend_pid()
      and candidate.transaction_id = txid_current();
    perform set_config('storyops.incident_close_capability', '', true);
    return new;
  end if;

  if (
    to_jsonb(new) - array[
      'status', 'owner_notified_at', 'requires_legal_review',
      'retain_until', 'legal_hold', 'updated_at', 'version'
    ]
  ) is distinct from (
    to_jsonb(old) - array[
      'status', 'owner_notified_at', 'requires_legal_review',
      'retain_until', 'legal_hold', 'updated_at', 'version'
    ]
  ) or (
    new.status is distinct from old.status
    and (old.status, new.status) not in (
      ('open', 'investigating'),
      ('open', 'corrective_action'),
      ('investigating', 'corrective_action')
    )
  ) or (
    new.owner_notified_at is distinct from old.owner_notified_at
    and (
      old.owner_notified_at is not null
      or new.owner_notified_at is null
      or new.owner_notified_at < old.reported_at
      or new.owner_notified_at > now() + interval '5 minutes'
    )
  ) or (
    old.requires_legal_review
    and not new.requires_legal_review
  ) or (
    old.legal_hold
    and not new.legal_hold
  ) or (
    new.retain_until is distinct from old.retain_until
    and (
      new.retain_until is null
      or new.retain_until < now()
      or (
        old.retain_until is not null
        and new.retain_until < old.retain_until
      )
    )
  ) then
    raise exception using
      errcode = '55000',
      message = 'INCIDENT_UPDATE_NOT_ALLOWED';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_storyops_incident_update()
  from public, anon, authenticated, service_role;

create trigger aa_incidents_safe_update_guard
before update on public.incidents
for each row execute function public.enforce_storyops_incident_update();

alter function public.execute_storyops_command(
  uuid, uuid, text, integer, jsonb, text
) rename to execute_storyops_command_pre_incident_close_guard;

revoke all on function public.execute_storyops_command_pre_incident_close_guard(
  uuid, uuid, text, integer, jsonb, text
) from public, anon, authenticated, service_role;

create or replace function public.execute_storyops_command(
  p_company_id uuid,
  p_command_id uuid,
  p_command_type text,
  p_expected_version integer,
  p_payload jsonb,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  incident_id_value uuid;
  incident_status text;
  incident_version integer;
  closure_note_value text;
  closed_at_value timestamptz;
  resulting_version integer;
  unexpected_key text;
  result jsonb;
begin
  if p_command_type is distinct from 'incident.close' then
    return public.execute_storyops_command_pre_incident_close_guard(
      p_company_id,
      p_command_id,
      p_command_type,
      p_expected_version,
      p_payload,
      p_request_hash
    );
  end if;

  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
    or p_company_id is null
    or p_command_id is null
    or p_expected_version is null
    or p_expected_version < 1
    or p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception using message = 'INCIDENT_CLOSE_INVALID_REQUEST';
  end if;
  if not public.lock_storyops_active_company(p_company_id) then
    raise exception using message = 'INCIDENT_CLOSE_COMPANY_NOT_ACTIVE';
  end if;

  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role is distinct from 'owner' then
    raise exception using message = 'INCIDENT_CLOSE_OWNER_REQUIRED';
  end if;

  select key
  into unexpected_key
  from jsonb_object_keys(p_payload) keys(key)
  where key not in ('entityId', 'closureNote')
  limit 1;
  if unexpected_key is not null
    or jsonb_typeof(p_payload -> 'entityId') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'closureNote') is distinct from 'string'
  then
    raise exception using message = 'INCIDENT_CLOSE_EXACT_PAYLOAD_REQUIRED';
  end if;
  begin
    incident_id_value := (p_payload ->> 'entityId')::uuid;
  exception
    when invalid_text_representation then
      raise exception using message = 'INCIDENT_CLOSE_EXACT_PAYLOAD_REQUIRED';
  end;
  closure_note_value := nullif(btrim(p_payload ->> 'closureNote'), '');
  if closure_note_value is null
    or char_length(closure_note_value) not between 5 and 2000
  then
    raise exception using message = 'INCIDENT_CLOSE_NOTE_INVALID';
  end if;

  effective_request_hash := public.storyops_json_sha256(
    jsonb_build_object(
      'commandType', 'incident.close',
      'expectedVersion', p_expected_version,
      'payload', p_payload
    )
  );
  if effective_request_hash <> p_request_hash then
    raise exception using message = 'INCIDENT_CLOSE_REQUEST_HASH_MISMATCH';
  end if;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'workspace-command-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '7 years'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys idempotency
    where idempotency.company_id = p_company_id
      and idempotency.scope = 'workspace-command-v1'
      and idempotency.key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception using message = 'INCIDENT_CLOSE_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception using message = 'INCIDENT_CLOSE_REQUEST_IN_PROGRESS';
  end if;

  select incident.status, incident.version
  into incident_status, incident_version
  from public.incidents incident
  where incident.company_id = p_company_id
    and incident.id = incident_id_value
  for update;
  if not found
    or incident_version <> p_expected_version
    or incident_status not in ('open', 'investigating', 'corrective_action')
  then
    raise exception using message = 'INCIDENT_CLOSE_SCOPE_OR_VERSION_CONFLICT';
  end if;

  closed_at_value := clock_timestamp();
  perform private.authorize_storyops_incident_close(
    p_company_id,
    p_command_id,
    actor_user_id,
    incident_id_value,
    p_expected_version,
    closure_note_value,
    closed_at_value
  );

  update public.incidents incident
  set
    status = 'closed',
    closure_note = closure_note_value,
    closed_at = closed_at_value,
    closed_by = actor_user_id
  where incident.company_id = p_company_id
    and incident.id = incident_id_value
    and incident.version = p_expected_version
    and incident.status in ('open', 'investigating', 'corrective_action')
  returning incident.version into resulting_version;
  if not found
    or resulting_version <> p_expected_version + 1
    or exists (
      select 1
      from private.storyops_incident_close_capabilities capability
      where capability.backend_pid = pg_backend_pid()
        and capability.transaction_id = txid_current()
        and capability.incident_id = incident_id_value
    )
  then
    raise exception using message = 'INCIDENT_CLOSE_POSTCONDITION_FAILED';
  end if;

  result := jsonb_build_object(
    'commandId', p_command_id,
    'commandType', 'incident.close',
    'status', 'applied',
    'replayed', false,
    'entityId', incident_id_value,
    'version', resulting_version,
    'requestHash', effective_request_hash,
    'serverTime', clock_timestamp()
  );
  update public.idempotency_keys idempotency
  set
    status = 'completed',
    response = result,
    completed_at = clock_timestamp()
  where idempotency.id = reservation_id
    and idempotency.status = 'in_progress';
  if not found then
    raise exception using message = 'INCIDENT_CLOSE_RESERVATION_LOST';
  end if;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    before_data, after_data, request_id, retention_class, retain_until
  )
  values (
    p_company_id,
    'user',
    actor_user_id::text,
    'incident.close.command',
    'incident',
    incident_id_value,
    jsonb_build_object(
      'status', incident_status,
      'version', incident_version
    ),
    jsonb_build_object(
      'status', 'closed',
      'version', resulting_version,
      'closedAt', closed_at_value,
      'commandId', p_command_id,
      'requestHash', effective_request_hash
    ),
    p_command_id::text,
    'audit',
    now() + interval '7 years'
  );
  return result;
end;
$$;

revoke all on function public.execute_storyops_command(
  uuid, uuid, text, integer, jsonb, text
) from public, anon, service_role;
grant execute on function public.execute_storyops_command(
  uuid, uuid, text, integer, jsonb, text
) to authenticated;

comment on function public.execute_storyops_command(
  uuid, uuid, text, integer, jsonb, text
) is
  'Authenticated command boundary; owner incident closure is capability-bound while all other finite commands delegate to the pre-guard implementation.';

create or replace function public.storyops_visit_has_open_incident(
  p_company_id uuid,
  p_visit_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.visits visit
    join public.jobs job
      on job.id = visit.job_id
     and job.company_id = visit.company_id
    join public.incidents incident
      on incident.company_id = visit.company_id
     and incident.status in ('open', 'investigating', 'corrective_action')
     and (
       incident.visit_id = visit.id
       or incident.job_id = job.id
       or (
         incident.visit_id is null
         and incident.job_id is null
         and incident.property_id = job.property_id
       )
     )
    where visit.company_id = p_company_id
      and visit.id = p_visit_id
  );
$$;

revoke all on function public.storyops_visit_has_open_incident(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.enforce_storyops_incident_stop_work()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  row_data jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  old_data jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  company_id_value uuid := nullif(row_data ->> 'company_id', '')::uuid;
  visit_id_value uuid;
  purpose_value text;
begin
  if tg_table_name = 'visits' then
    visit_id_value := new.id;
  else
    visit_id_value := nullif(row_data ->> 'visit_id', '')::uuid;
  end if;

  if visit_id_value is null
    or not public.storyops_visit_has_open_incident(
      company_id_value,
      visit_id_value
    )
  then
    return new;
  end if;

  if tg_table_name = 'visits' then
    if new.status in ('en_route', 'on_site', 'completed')
      or new.internal_notes is distinct from old.internal_notes
      or new.customer_notes is distinct from old.customer_notes
    then
      raise exception using
        errcode = '55000',
        message = 'OPEN_INCIDENT_STOPS_FIELD_WORK';
    end if;
    return new;
  elsif tg_table_name = 'time_entries' then
    if tg_op = 'UPDATE'
      and old.ended_at is null
      and new.ended_at is not null
      and (
        to_jsonb(new) - array['ended_at', 'updated_at', 'version']
      ) = (
        old_data - array['ended_at', 'updated_at', 'version']
      )
    then
      return new;
    end if;
    raise exception using
      errcode = '55000',
      message = 'OPEN_INCIDENT_STOPS_FIELD_WORK';
  elsif tg_table_name = 'media_assets' then
    purpose_value := new.purpose;
    if purpose_value in ('incident', 'safety', 'damage') then
      return new;
    end if;
    raise exception using
      errcode = '55000',
      message = 'OPEN_INCIDENT_STOPS_FIELD_WORK';
  end if;

  raise exception using
    errcode = '55000',
    message = 'OPEN_INCIDENT_STOPS_FIELD_WORK';
end;
$$;

revoke all on function public.enforce_storyops_incident_stop_work()
  from public, anon, authenticated, service_role;

create trigger visits_open_incident_stop_work
before update on public.visits
for each row execute function public.enforce_storyops_incident_stop_work();

create trigger time_entries_open_incident_stop_work
before insert or update on public.time_entries
for each row execute function public.enforce_storyops_incident_stop_work();

create trigger checklist_open_incident_stop_work
before insert or update on public.visit_checklist_items
for each row execute function public.enforce_storyops_incident_stop_work();

create trigger material_usage_open_incident_stop_work
before insert or update on public.material_usage
for each row execute function public.enforce_storyops_incident_stop_work();

create trigger media_assets_open_incident_stop_work
before insert or update on public.media_assets
for each row execute function public.enforce_storyops_incident_stop_work();

create trigger completion_signatures_open_incident_stop_work
before insert on public.completion_signatures
for each row execute function public.enforce_storyops_incident_stop_work();

create or replace function public.report_storyops_incident_and_pause(
  p_company_id uuid,
  p_command_id uuid,
  p_expected_visit_version integer,
  p_payload jsonb,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  unexpected_key text;
  incident_id_value uuid;
  visit_id_value uuid;
  requested_job_id uuid;
  requested_property_id uuid;
  visit_job_id uuid;
  visit_property_id uuid;
  previous_visit_status text;
  previous_visit_version integer;
  current_visit_version integer;
  incident_version integer;
  occurred_at_value timestamptz;
  requested_at_value timestamptz;
  processed_at_value timestamptz;
  stopped_time_entries jsonb := '[]'::jsonb;
  result jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
    or p_company_id is null
    or p_command_id is null
    or p_expected_visit_version is null
    or p_expected_visit_version < 1
    or p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception using message = 'INCIDENT_STOP_INVALID_REQUEST';
  end if;

  if not public.lock_storyops_active_company(p_company_id) then
    raise exception using message = 'INCIDENT_STOP_COMPANY_NOT_ACTIVE';
  end if;

  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role is null
    or actor_role not in ('owner', 'dispatcher', 'technician')
  then
    raise exception using message = 'INCIDENT_STOP_FIELD_ROLE_REQUIRED';
  end if;

  select key
  into unexpected_key
  from jsonb_object_keys(p_payload) keys(key)
  where key not in (
    'schemaVersion', 'action', 'actorUserId', 'entityId', 'incidentNumber',
    'visitId', 'jobId', 'propertyId', 'severity', 'category', 'occurredAt',
    'requestedAt', 'summary', 'immediateActions', 'requiresLegalReview'
  )
  limit 1;
  if unexpected_key is not null
    or p_payload ->> 'schemaVersion' <> 'storyops-incident-pause-v1'
    or p_payload ->> 'action' <> 'incident.report_pause'
    or jsonb_typeof(p_payload -> 'actorUserId') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'entityId') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'incidentNumber') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'visitId') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'jobId') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'propertyId') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'severity') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'category') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'occurredAt') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'requestedAt') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'summary') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'immediateActions') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'requiresLegalReview') is distinct from 'boolean'
  then
    raise exception using message = 'INCIDENT_STOP_EXACT_PAYLOAD_REQUIRED';
  end if;

  if coalesce(p_payload ->> 'actorUserId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_payload ->> 'entityId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_payload ->> 'visitId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_payload ->> 'jobId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_payload ->> 'propertyId', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or (p_payload ->> 'actorUserId')::uuid <> actor_user_id
    or p_payload ->> 'severity'
      not in ('near_miss', 'minor', 'serious', 'critical')
    or p_payload ->> 'category'
      not in ('injury', 'property_damage', 'chemical', 'vehicle', 'environmental', 'other')
    or char_length(btrim(p_payload ->> 'incidentNumber')) not between 3 and 80
    or char_length(btrim(p_payload ->> 'summary')) not between 10 and 2000
    or char_length(btrim(p_payload ->> 'immediateActions')) not between 5 and 2000
  then
    raise exception using message = 'INCIDENT_STOP_FACTS_INVALID';
  end if;

  begin
    incident_id_value := (p_payload ->> 'entityId')::uuid;
    visit_id_value := (p_payload ->> 'visitId')::uuid;
    requested_job_id := (p_payload ->> 'jobId')::uuid;
    requested_property_id := (p_payload ->> 'propertyId')::uuid;
    occurred_at_value := (p_payload ->> 'occurredAt')::timestamptz;
    requested_at_value := (p_payload ->> 'requestedAt')::timestamptz;
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise exception using message = 'INCIDENT_STOP_FACTS_INVALID';
  end;

  if occurred_at_value > now() + interval '5 minutes'
    or requested_at_value > now() + interval '5 minutes'
  then
    raise exception using message = 'INCIDENT_STOP_TIME_INVALID';
  end if;

  effective_request_hash := public.storyops_json_sha256(
    jsonb_build_object(
      'commandType', 'incident.report_pause',
      'expectedVersion', p_expected_visit_version,
      'payload', p_payload
    )
  );
  if effective_request_hash <> p_request_hash then
    raise exception using message = 'INCIDENT_STOP_REQUEST_HASH_MISMATCH';
  end if;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'incident-report-pause-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '7 years'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys idempotency
    where idempotency.company_id = p_company_id
      and idempotency.scope = 'incident-report-pause-v1'
      and idempotency.key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception using message = 'INCIDENT_STOP_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception using message = 'INCIDENT_STOP_REQUEST_IN_PROGRESS';
  end if;

  select
    visit.status,
    visit.version,
    visit.job_id,
    job.property_id
  into
    previous_visit_status,
    previous_visit_version,
    visit_job_id,
    visit_property_id
  from public.visits visit
  join public.jobs job
    on job.id = visit.job_id
   and job.company_id = visit.company_id
  where visit.id = visit_id_value
    and visit.company_id = p_company_id
  for update of visit, job;

  if not found
    or p_expected_visit_version > previous_visit_version
    or previous_visit_status not in ('en_route', 'on_site', 'paused')
    or visit_job_id <> requested_job_id
    or visit_property_id <> requested_property_id
  then
    raise exception using message = 'INCIDENT_STOP_SCOPE_OR_VERSION_CONFLICT';
  end if;
  if actor_role = 'technician'
    and not public.is_assigned_technician_for_visit(visit_id_value)
  then
    raise exception using message = 'INCIDENT_STOP_ASSIGNMENT_REQUIRED';
  end if;

  processed_at_value := clock_timestamp();
  perform private.authorize_storyops_incident_stop(
    p_company_id,
    p_command_id,
    actor_user_id,
    incident_id_value,
    visit_id_value
  );

  insert into public.incidents(
    id, company_id, incident_number, job_id, visit_id, property_id,
    severity, status, category, occurred_at, reported_at, reported_by,
    summary, immediate_actions, requires_legal_review, retain_until
  )
  values (
    incident_id_value,
    p_company_id,
    btrim(p_payload ->> 'incidentNumber'),
    visit_job_id,
    visit_id_value,
    visit_property_id,
    p_payload ->> 'severity',
    'open',
    p_payload ->> 'category',
    occurred_at_value,
    processed_at_value,
    actor_user_id,
    btrim(p_payload ->> 'summary'),
    btrim(p_payload ->> 'immediateActions'),
    (
      (p_payload ->> 'requiresLegalReview')::boolean
      or p_payload ->> 'severity' in ('serious', 'critical')
    ),
    null
  )
  returning version into incident_version;

  with stopped as (
    update public.time_entries entry
    set ended_at = greatest(
      processed_at_value,
      entry.started_at + interval '1 millisecond'
    )
    where entry.company_id = p_company_id
      and entry.visit_id = visit_id_value
      and entry.ended_at is null
    returning entry.id, entry.version, entry.ended_at
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', stopped.id,
        'previousVersion', stopped.version - 1,
        'currentVersion', stopped.version,
        'endedAt', stopped.ended_at
      )
      order by stopped.id
    ),
    '[]'::jsonb
  )
  into stopped_time_entries
  from stopped;

  if previous_visit_status = 'paused' then
    current_visit_version := previous_visit_version;
  else
    update public.visits visit
    set
      status = 'paused',
      offline_revision = visit.offline_revision + 1,
      last_synced_at = processed_at_value
    where visit.id = visit_id_value
      and visit.company_id = p_company_id
      and visit.version = previous_visit_version
    returning visit.version into current_visit_version;
    if not found then
      raise exception using message = 'INCIDENT_STOP_VISIT_PAUSE_CONFLICT';
    end if;
  end if;

  if exists (
    select 1
    from public.time_entries entry
    where entry.company_id = p_company_id
      and entry.visit_id = visit_id_value
      and entry.ended_at is null
  ) or not exists (
    select 1
    from public.visits visit
    where visit.company_id = p_company_id
      and visit.id = visit_id_value
      and visit.status = 'paused'
      and visit.version = current_visit_version
  ) then
    raise exception using message = 'INCIDENT_STOP_POSTCONDITION_FAILED';
  end if;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-incident-pause-receipt-v1',
    'action', 'incident.report_pause',
    'commandId', p_command_id,
    'commandType', 'incident.report_pause',
    'status', 'applied',
    'companyId', p_company_id,
    'actorUserId', actor_user_id,
    'requestHash', effective_request_hash,
    'replayed', false,
    'entityId', incident_id_value,
    'version', incident_version,
    'incident', jsonb_build_object(
      'id', incident_id_value,
      'incidentNumber', btrim(p_payload ->> 'incidentNumber'),
      'status', 'open',
      'version', incident_version
    ),
    'visit', jsonb_build_object(
      'id', visit_id_value,
      'jobId', visit_job_id,
      'propertyId', visit_property_id,
      'previousStatus', previous_visit_status,
      'currentStatus', 'paused',
      'submittedExpectedVersion', p_expected_visit_version,
      'previousVersion', previous_visit_version,
      'currentVersion', current_visit_version
    ),
    'stoppedTimeEntries', stopped_time_entries,
    'serverTime', processed_at_value
  );

  update public.idempotency_keys idempotency
  set
    status = 'completed',
    response = result,
    completed_at = processed_at_value
  where idempotency.id = reservation_id
    and idempotency.status = 'in_progress';
  if not found then
    raise exception using message = 'INCIDENT_STOP_RESERVATION_LOST';
  end if;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id, retain_until
  )
  values (
    p_company_id,
    'user',
    actor_user_id::text,
    'incident.report_pause.atomic',
    'incident',
    incident_id_value,
    jsonb_build_object(
      'visitId', visit_id_value,
      'jobId', visit_job_id,
      'propertyId', visit_property_id,
      'visitStatus', 'paused',
      'submittedExpectedVisitVersion', p_expected_visit_version,
      'lockedVisitVersion', previous_visit_version,
      'resultingVisitVersion', current_visit_version,
      'occurredAt', occurred_at_value,
      'requestedAt', requested_at_value,
      'processedAt', processed_at_value,
      'stoppedTimeEntryIds', (
        select coalesce(jsonb_agg(entry -> 'id'), '[]'::jsonb)
        from jsonb_array_elements(stopped_time_entries) entry
      ),
      'requestHash', effective_request_hash
    ),
    p_command_id::text,
    now() + interval '7 years'
  );

  return result;
end;
$$;

revoke all on function public.report_storyops_incident_and_pause(
  uuid, uuid, integer, jsonb, text
) from public, anon, service_role;
grant execute on function public.report_storyops_incident_and_pause(
  uuid, uuid, integer, jsonb, text
) to authenticated;

comment on function public.report_storyops_incident_and_pause(
  uuid, uuid, integer, jsonb, text
) is
  'Authenticated, assignment-scoped, full-request-idempotent monotonic safety boundary that preserves submitted event facts, locks current visit truth, stops every active timer at server time, pauses active work, and returns submitted/current versions in a durable receipt.';

comment on function public.storyops_visit_has_open_incident(uuid, uuid) is
  'Server-only predicate for unresolved incidents linked to the exact visit, its job, or a property-wide incident.';
