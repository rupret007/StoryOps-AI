-- Field work must remain useful offline without converting absent route,
-- weather, scope, SDS, or synchronization facts into reassuring defaults.
-- Completed-work media becomes customer-readable only after an explicit
-- back-office publication of durable before/after evidence for a completed
-- visit.

create table public.field_change_requests (
  id uuid primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  visit_id uuid not null references public.visits(id) on delete restrict,
  job_id uuid not null references public.jobs(id) on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  reason_code text not null check (
    reason_code in (
      'scope_mismatch',
      'access_blocked',
      'customer_request',
      'site_condition',
      'other'
    )
  ),
  summary text not null check (
    char_length(summary) between 10 and 2000
    and summary = btrim(summary)
  ),
  status text not null default 'submitted'
    check (status in ('submitted', 'reviewing', 'resolved', 'cancelled')),
  resolution_note text check (
    resolution_note is null
    or char_length(btrim(resolution_note)) between 5 and 2000
  ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  version integer not null default 1 check (version > 0),
  unique (company_id, id)
);

create index field_change_requests_visit_queue_idx
  on public.field_change_requests(company_id, visit_id, status, created_at);

alter table public.field_change_requests enable row level security;
alter table public.field_change_requests force row level security;

revoke all on table public.field_change_requests
  from public, anon, authenticated, service_role;

create policy field_change_requests_staff_select
  on public.field_change_requests
  for select
  to authenticated
  using (
    public.has_company_role(
      company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
    or public.is_assigned_technician_for_visit(visit_id)
  );

create trigger field_change_requests_touch
  before update on public.field_change_requests
  for each row execute function public.touch_record();

create trigger field_change_requests_audit
  after insert or update or delete on public.field_change_requests
  for each row execute function public.audit_mutation();

create trigger storyops_active_company_mutation_gate
  before insert or update or delete on public.field_change_requests
  for each row execute function public.assert_active_company_for_authenticated_mutation();

create or replace function public.submit_storyops_field_change_request(
  p_company_id uuid,
  p_command_id uuid,
  p_expected_version integer,
  p_payload jsonb,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  visit_id_value uuid;
  job_id_value uuid;
  effective_request_hash text;
  claim record;
  result jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
  then
    raise exception using message = 'FIELD_CHANGE_AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.companies company
    where company.id = p_company_id
      and company.status = 'active'
  ) then
    raise exception using message = 'FIELD_CHANGE_COMPANY_NOT_ACTIVE';
  end if;
  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role not in ('owner', 'dispatcher', 'technician') then
    raise exception using message = 'FIELD_CHANGE_ROLE_DENIED';
  end if;
  if p_expected_version < 1
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or exists (
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in ('entityId', 'reasonCode', 'summary')
    )
    or not (p_payload ?& array['entityId', 'reasonCode', 'summary'])
    or p_payload ->> 'entityId'
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_payload ->> 'reasonCode' not in (
      'scope_mismatch',
      'access_blocked',
      'customer_request',
      'site_condition',
      'other'
    )
    or char_length(p_payload ->> 'summary') not between 10 and 2000
    or p_payload ->> 'summary' is distinct from btrim(p_payload ->> 'summary')
  then
    raise exception using message = 'FIELD_CHANGE_PAYLOAD_INVALID';
  end if;

  visit_id_value := (p_payload ->> 'entityId')::uuid;
  select visit.job_id
  into job_id_value
  from public.visits visit
  where visit.id = visit_id_value
    and visit.company_id = p_company_id
    and visit.version = p_expected_version
    and visit.status in ('confirmed', 'en_route', 'on_site', 'paused')
    and (
      actor_role in ('owner', 'dispatcher')
      or public.is_assigned_technician_for_visit(visit.id)
    )
  for share;
  if job_id_value is null then
    raise exception using message = 'FIELD_CHANGE_VISIT_STALE_OR_DENIED';
  end if;

  effective_request_hash := public.storyops_json_sha256(
    jsonb_build_object(
      'commandType', 'field.change_request',
      'expectedVersion', p_expected_version,
      'payload', p_payload
    )
  );
  if effective_request_hash <> p_request_hash then
    raise exception using message = 'FIELD_CHANGE_REQUEST_HASH_MISMATCH';
  end if;

  select *
  into claim
  from public.claim_idempotency_key(
    p_company_id,
    'field-change-request-v1',
    p_command_id::text,
    p_request_hash,
    now() + interval '90 days'
  );
  if claim.claim_status = 'completed' then
    return claim.stored_response || jsonb_build_object('replayed', true);
  elsif claim.claim_status = 'conflict' then
    raise exception using message = 'FIELD_CHANGE_COMMAND_CONFLICT';
  elsif claim.claim_status <> 'reserved' then
    raise exception using message = 'FIELD_CHANGE_COMMAND_IN_PROGRESS';
  end if;

  insert into public.field_change_requests(
    id,
    company_id,
    visit_id,
    job_id,
    requested_by,
    reason_code,
    summary
  )
  values (
    p_command_id,
    p_company_id,
    visit_id_value,
    job_id_value,
    actor_user_id,
    p_payload ->> 'reasonCode',
    p_payload ->> 'summary'
  );

  result := jsonb_build_object(
    'commandId', p_command_id,
    'commandType', 'field.change_request',
    'status', 'applied',
    'replayed', false,
    'entityId', p_command_id,
    'version', 1,
    'requestHash', p_request_hash,
    'serverTime', clock_timestamp()
  );
  perform public.complete_idempotency_key(
    p_company_id,
    'field-change-request-v1',
    p_command_id::text,
    p_request_hash,
    result
  );
  return result;
end;
$$;

revoke all on function public.submit_storyops_field_change_request(
  uuid, uuid, integer, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.submit_storyops_field_change_request(
  uuid, uuid, integer, jsonb, text
) to authenticated;

comment on function public.submit_storyops_field_change_request(
  uuid, uuid, integer, jsonb, text
) is
  'Exact, versioned, idempotent and offline-replayable field request. It records observed scope/access/site change facts without changing price, scope, schedule, or customer communication.';

-- Add the assigned visit packet to the existing safety-reference RPC. The
-- prior function remains private so callers cannot bypass this active-company
-- and packet-shape boundary.
alter function public.get_storyops_field_reference(uuid)
  rename to get_storyops_field_reference_v1_0;

revoke all on function public.get_storyops_field_reference_v1_0(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_storyops_field_reference(
  p_company_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  base_reference jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
  then
    raise exception using message = 'FIELD_PACKET_AUTHENTICATION_REQUIRED';
  end if;
  select membership.role
  into actor_role
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
   and company.status = 'active'
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role not in ('owner', 'dispatcher', 'technician') then
    raise exception using message = 'FIELD_PACKET_ROLE_DENIED';
  end if;

  base_reference := public.get_storyops_field_reference_v1_0(p_company_id);
  return base_reference || jsonb_build_object(
    'fieldPackets',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'visitId', visit.id,
          'visitVersion', visit.version,
          'jobId', job.id,
          'jobNumber', job.job_number,
          'quoteId', quote.id,
          'propertyId', property.id,
          'scopeLines', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', line.id,
                'lineKind', line.line_kind,
                'serviceCode', line.service_code,
                'addOnCode', line.add_on_code,
                'description', line.description,
                'quantity', line.quantity::text,
                'unit', line.unit,
                'sortOrder', line.sort_order
              )
              order by line.sort_order, line.id
            )
            from public.estimate_lines line
            where line.company_id = p_company_id
              and line.estimate_id = estimate.id
              and line.line_kind in ('service', 'add_on')
          ), '[]'::jsonb),
          'exclusions', case
            when jsonb_typeof(estimate.calculation_input -> 'scopeExclusions') = 'array'
            then coalesce((
              select jsonb_agg(exclusion.value order by exclusion.ordinality)
              from jsonb_array_elements(
                estimate.calculation_input -> 'scopeExclusions'
              ) with ordinality exclusion(value, ordinality)
              where jsonb_typeof(exclusion.value) = 'string'
                and char_length(btrim(exclusion.value #>> '{}')) between 1 and 500
            ), '[]'::jsonb)
            else '[]'::jsonb
          end,
          'exclusionsStatus', case
            when jsonb_typeof(estimate.calculation_input -> 'scopeExclusions') = 'array'
              and exists (
                select 1
                from jsonb_array_elements(
                  estimate.calculation_input -> 'scopeExclusions'
                ) exclusion(value)
                where jsonb_typeof(exclusion.value) = 'string'
                  and char_length(btrim(exclusion.value #>> '{}')) between 1 and 500
              )
            then 'recorded'
            else 'not_recorded'
          end,
          'access', jsonb_build_object(
            'instructions', nullif(btrim(property.access_instructions), ''),
            'waterSourceNotes', nullif(btrim(property.water_source_notes), ''),
            'drainageNotes', nullif(btrim(property.drainage_notes), ''),
            'knownHazards', property.known_hazards
          ),
          'routeEvidence', case
            when route.id is null then null
            else jsonb_build_object(
              'id', route.id,
              'provider', route.provider,
              'evidenceMode', case
                when route.provider = 'vroom' then 'live'
                else 'sandbox'
              end,
              'checkedAt', route.checked_at,
              'driveMinutes', route.drive_minutes,
              'distanceMiles', route.added_distance_miles::text,
              'routeFeasible', route.route_feasible,
              'violations', route.violations,
              'freshness', case
                when route.checked_at >= statement_timestamp() - interval '30 minutes'
                then 'current'
                else 'stale'
              end
            )
          end,
          'weatherEvidence', case
            when weather.id is null then null
            else jsonb_build_object(
              'id', weather.id,
              'provider', weather.provider,
              'evidenceMode', case
                when weather.provider = 'nws' then 'live'
                else 'sandbox'
              end,
              'forecastIssuedAt', weather.forecast_issued_at,
              'checkedAt', weather.checked_at,
              'periodStartsAt', weather.period_starts_at,
              'periodEndsAt', weather.period_ends_at,
              'temperatureF', weather.temperature_f::text,
              'precipitationProbability',
                weather.precipitation_probability::text,
              'windSpeedMph', weather.wind_speed_mph::text,
              'lightningRisk', weather.lightning_risk,
              'conditionCodes', weather.condition_codes,
              'policyDisposition', weather.policy_disposition,
              'freshness', case
                when weather.checked_at >= statement_timestamp() - interval '30 minutes'
                  and statement_timestamp() between
                    weather.period_starts_at and weather.period_ends_at
                then 'current'
                else 'stale'
              end
            )
          end,
          'evidence', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', media.id,
                'purpose', media.purpose,
                'contentType', media.content_type,
                'byteSize', media.byte_size,
                'checksumSha256', media.checksum_sha256,
                'capturedAt', media.captured_at,
                'syncState', media.sync_state,
                'customerVisible', media.customer_visible
              )
              order by media.captured_at, media.id
            )
            from public.media_assets media
            where media.company_id = p_company_id
              and media.visit_id = visit.id
              and media.purpose in ('before', 'after')
          ), '[]'::jsonb),
          'changeRequests', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', request.id,
                'reasonCode', request.reason_code,
                'summary', request.summary,
                'status', request.status,
                'createdAt', request.created_at,
                'version', request.version
              )
              order by request.created_at desc, request.id
            )
            from public.field_change_requests request
            where request.company_id = p_company_id
              and request.visit_id = visit.id
          ), '[]'::jsonb)
        )
        order by
          case when visit.status in ('en_route', 'on_site', 'paused') then 0 else 1 end,
          visit.starts_at,
          visit.id
      )
      from public.visits visit
      join public.jobs job
        on job.id = visit.job_id
       and job.company_id = visit.company_id
      join public.quotes quote
        on quote.id = job.quote_id
       and quote.company_id = job.company_id
      join public.estimates estimate
        on estimate.id = quote.estimate_id
       and estimate.company_id = quote.company_id
      join public.properties property
        on property.id = job.property_id
       and property.company_id = job.company_id
      left join public.route_checks route
        on route.id = visit.route_check_id
       and route.company_id = visit.company_id
      left join public.weather_checks weather
        on weather.id = visit.weather_check_id
       and weather.company_id = visit.company_id
       and weather.property_id = property.id
      where visit.company_id = p_company_id
        and visit.status <> 'cancelled'
        and (
          actor_role in ('owner', 'dispatcher')
          or public.is_assigned_technician_for_visit(visit.id)
        )
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_storyops_field_reference(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_storyops_field_reference(uuid)
  to authenticated;

comment on function public.get_storyops_field_reference(uuid) is
  'Active-company, role/assignment-scoped mobile packet with exact accepted estimate lines, explicitly recorded or unknown exclusions, property access facts, provider-distinguishing route/weather evidence, durable field media state, SDS references, and field change requests.';

-- A customer may read scope-upload evidence they already own. Completed-work
-- access is narrower: explicit visibility, durable sync, before/after purpose,
-- exact visit/job/property linkage, and a completed visit are all mandatory.
create or replace function public.can_read_job_media_object(target_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.media_assets media
    left join public.properties property
      on property.id = media.property_id
     and property.company_id = media.company_id
    where media.object_path = target_name
      and (
        public.has_company_role(
          media.company_id,
          array['owner', 'dispatcher']::public.app_role[]
        )
        or (
          media.visit_id is not null
          and public.is_assigned_technician_for_visit(media.visit_id)
        )
        or (
          media.customer_visible
          and property.id is not null
          and public.is_customer_user(media.company_id, property.customer_id)
          and (
            media.purpose = 'scope'
            or (
              media.purpose in ('before', 'after')
              and media.sync_state = 'synced'
              and media.visit_id is not null
              and media.job_id is not null
              and exists (
                select 1
                from public.visits visit
                join public.jobs job
                  on job.id = visit.job_id
                 and job.company_id = visit.company_id
                where visit.id = media.visit_id
                  and visit.company_id = media.company_id
                  and visit.status = 'completed'
                  and job.id = media.job_id
                  and job.property_id = media.property_id
                  and job.customer_id = property.customer_id
              )
            )
          )
        )
      )
  );
$$;

revoke all on function public.can_read_job_media_object(text)
  from public, anon, authenticated, service_role;
grant execute on function public.can_read_job_media_object(text)
  to authenticated, service_role;

drop policy if exists media_assets_select on public.media_assets;
create policy media_assets_select
  on public.media_assets
  for select
  to authenticated
  using (public.can_read_job_media_object(object_path));

-- Durable byte attestation belongs to the immutable object identity. A
-- metadata-only publication/retention update must not consume a second upload
-- attestation, while any association, purpose, checksum, size, or path change
-- still crosses the original trusted finalizer gate. Table ACLs and RLS remain
-- the authorization boundary for metadata updates.
create or replace function public.require_durable_job_media_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  consumed_attestation_id uuid;
begin
  if tg_op = 'UPDATE'
    and old.sync_state = 'synced'
    and new.sync_state = 'synced'
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
      new.offline_client_id,
      new.created_at
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
      old.offline_client_id,
      old.created_at
    )
  then
    return new;
  end if;
  if new.sync_state = 'synced'
    and auth.role() is distinct from 'service_role'
  then
    raise exception
      'media.register requires the trusted field-media finalizer';
  end if;
  if new.sync_state = 'synced'
    and not exists (
      select 1
      from storage.objects object
      where object.bucket_id = 'job-media'
        and object.name = new.object_path
        and (object.metadata ->> 'size')::bigint = new.byte_size
        and coalesce(
          object.metadata ->> 'mimetype',
          object.metadata ->> 'contentType'
        ) = new.content_type
    )
  then
    raise exception
      'Media registration requires a durable job-media object with matching size and content type';
  end if;
  if new.sync_state = 'synced' then
    update public.media_upload_attestations attestation
    set consumed_at = now()
    where attestation.company_id = new.company_id
      and attestation.command_id::text = new.offline_client_id
      and attestation.actor_user_id = new.captured_by
      and attestation.asset_id = new.id
      and attestation.object_path = new.object_path
      and attestation.checksum_sha256 = new.checksum_sha256
      and attestation.byte_size = new.byte_size
      and attestation.content_type = new.content_type
      and attestation.consumed_at is null
      and attestation.expires_at > now()
    returning attestation.id into consumed_attestation_id;
    if consumed_attestation_id is null then
      raise exception
        'Media registration requires an unconsumed trusted checksum attestation';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.require_durable_job_media_object()
  from public, anon, authenticated;

comment on function public.require_durable_job_media_object() is
  'Fail-closed immutable byte/association gate. New or changed synced object identities require durable Storage plus one trusted checksum attestation; metadata-only visibility/retention updates reuse the already-attested immutable bytes and remain ACL/RLS controlled.';

create or replace function public.publish_storyops_completed_work_evidence(
  p_company_id uuid,
  p_command_id uuid,
  p_visit_id uuid,
  p_asset_ids uuid[],
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  normalized_asset_ids uuid[];
  eligible_count integer;
  claim record;
  result jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
    or not public.has_company_role(
      p_company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
  then
    raise exception using message = 'COMPLETED_EVIDENCE_ROLE_DENIED';
  end if;
  if not exists (
    select 1
    from public.companies company
    where company.id = p_company_id
      and company.status = 'active'
  ) then
    raise exception using message = 'COMPLETED_EVIDENCE_COMPANY_NOT_ACTIVE';
  end if;
  select array_agg(asset_id order by asset_id)
  into normalized_asset_ids
  from (
    select distinct unnest(p_asset_ids) as asset_id
  ) assets;
  if normalized_asset_ids is null
    or cardinality(normalized_asset_ids) not between 1 and 50
    or cardinality(normalized_asset_ids) <> cardinality(p_asset_ids)
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception using message = 'COMPLETED_EVIDENCE_PAYLOAD_INVALID';
  end if;
  if public.storyops_json_sha256(
    jsonb_build_object(
      'assetIds', to_jsonb(normalized_asset_ids),
      'commandType', 'completed_work.publish',
      'visitId', p_visit_id
    )
  ) <> p_request_hash then
    raise exception using message = 'COMPLETED_EVIDENCE_REQUEST_HASH_MISMATCH';
  end if;
  if not exists (
    select 1
    from public.visits visit
    where visit.id = p_visit_id
      and visit.company_id = p_company_id
      and visit.status = 'completed'
  ) then
    raise exception using message = 'COMPLETED_EVIDENCE_VISIT_NOT_COMPLETE';
  end if;

  select count(*)
  into eligible_count
  from public.media_assets media
  join public.visits visit
    on visit.id = media.visit_id
   and visit.company_id = media.company_id
  join public.jobs job
    on job.id = visit.job_id
   and job.company_id = visit.company_id
  where media.company_id = p_company_id
    and media.id = any(normalized_asset_ids)
    and media.visit_id = p_visit_id
    and media.job_id = job.id
    and media.property_id = job.property_id
    and media.purpose in ('before', 'after')
    and media.sync_state = 'synced';
  if eligible_count <> cardinality(normalized_asset_ids) then
    raise exception using message = 'COMPLETED_EVIDENCE_ASSET_INELIGIBLE';
  end if;

  select *
  into claim
  from public.claim_idempotency_key(
    p_company_id,
    'completed-work-evidence-v1',
    p_command_id::text,
    p_request_hash,
    now() + interval '365 days'
  );
  if claim.claim_status = 'completed' then
    return claim.stored_response || jsonb_build_object('replayed', true);
  elsif claim.claim_status = 'conflict' then
    raise exception using message = 'COMPLETED_EVIDENCE_COMMAND_CONFLICT';
  elsif claim.claim_status <> 'reserved' then
    raise exception using message = 'COMPLETED_EVIDENCE_COMMAND_IN_PROGRESS';
  end if;

  update public.media_assets media
  set customer_visible = true
  where media.company_id = p_company_id
    and media.id = any(normalized_asset_ids)
    and not media.customer_visible;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-completed-work-publication-v1',
    'companyId', p_company_id,
    'commandId', p_command_id,
    'visitId', p_visit_id,
    'assetIds', to_jsonb(normalized_asset_ids),
    'publishedCount', cardinality(normalized_asset_ids),
    'requestHash', p_request_hash,
    'replayed', false,
    'serverTime', clock_timestamp()
  );
  perform public.complete_idempotency_key(
    p_company_id,
    'completed-work-evidence-v1',
    p_command_id::text,
    p_request_hash,
    result
  );
  return result;
end;
$$;

revoke all on function public.publish_storyops_completed_work_evidence(
  uuid, uuid, uuid, uuid[], text
) from public, anon, authenticated, service_role;
grant execute on function public.publish_storyops_completed_work_evidence(
  uuid, uuid, uuid, uuid[], text
) to authenticated;

comment on function public.publish_storyops_completed_work_evidence(
  uuid, uuid, uuid, uuid[], text
) is
  'Explicit idempotent back-office publication for exact durable before/after assets on a completed visit. It does not publish damage, incident, safety, signature, scope, pending, or cross-tenant media.';

-- Extend the authenticated portal state instead of trusting the broader
-- workspace cache. Every projected file satisfies the same predicate used by
-- Storage RLS.
alter function public.get_customer_portal_state(uuid)
  rename to get_customer_portal_state_v3_0;

revoke all on function public.get_customer_portal_state_v3_0(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_customer_portal_state(
  p_company_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  base_state jsonb;
  customer_state jsonb;
  enriched_customers jsonb := '[]'::jsonb;
  customer_id_value uuid;
  completed_work jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or auth.uid() is null
    or not public.is_active_company_portal_user(p_company_id)
  then
    raise exception using message = 'CUSTOMER_COMPLETED_WORK_SCOPE_DENIED';
  end if;
  base_state := public.get_customer_portal_state_v3_0(p_company_id);
  if base_state ->> 'companyId' is distinct from p_company_id::text then
    raise exception using message = 'CUSTOMER_COMPLETED_WORK_SCOPE_DENIED';
  end if;

  for customer_state in
    select value
    from jsonb_array_elements(coalesce(base_state -> 'customers', '[]'::jsonb))
  loop
    customer_id_value := (customer_state ->> 'customerId')::uuid;
    if not public.is_customer_user(p_company_id, customer_id_value) then
      raise exception using message = 'CUSTOMER_COMPLETED_WORK_SCOPE_DENIED';
    end if;
    select coalesce(
      jsonb_agg(work_item order by (work_item ->> 'completedAt') desc),
      '[]'::jsonb
    )
    into completed_work
    from (
      select jsonb_build_object(
        'visitId', visit.id,
        'jobId', job.id,
        'jobNumber', job.job_number,
        'propertyId', job.property_id,
        'serviceCodes', job.service_codes,
        'completedAt', visit.updated_at,
        'media', jsonb_agg(
          jsonb_build_object(
            'id', media.id,
            'purpose', media.purpose,
            'objectPath', media.object_path,
            'contentType', media.content_type,
            'byteSize', media.byte_size,
            'checksumSha256', media.checksum_sha256,
            'capturedAt', media.captured_at,
            'version', media.version
          )
          order by
            case when media.purpose = 'before' then 0 else 1 end,
            media.captured_at,
            media.id
        )
      ) as work_item
      from public.jobs job
      join public.visits visit
        on visit.job_id = job.id
       and visit.company_id = job.company_id
       and visit.status = 'completed'
      join public.media_assets media
        on media.visit_id = visit.id
       and media.job_id = job.id
       and media.property_id = job.property_id
       and media.company_id = job.company_id
       and media.purpose in ('before', 'after')
       and media.sync_state = 'synced'
       and media.customer_visible
      where job.company_id = p_company_id
        and job.customer_id = customer_id_value
        and public.can_read_job_media_object(media.object_path)
      group by
        visit.id,
        visit.updated_at,
        job.id,
        job.job_number,
        job.property_id,
        job.service_codes
    ) completed;
    enriched_customers := enriched_customers || jsonb_build_array(
      customer_state || jsonb_build_object('completedWork', completed_work)
    );
  end loop;
  return jsonb_set(base_state, '{customers}', enriched_customers);
end;
$$;

revoke all on function public.get_customer_portal_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_customer_portal_state(uuid)
  to authenticated;

comment on function public.get_customer_portal_state(uuid) is
  'Authenticated active-customer portal state. Completed-work projection contains only explicitly published, durable before/after media for completed visits belonging to the exact portal customer.';
