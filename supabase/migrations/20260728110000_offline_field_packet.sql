-- A media row marked synced is completion evidence. Refuse that claim unless the
-- private Storage object is already durable with matching byte-size and MIME metadata.

-- V1 field Storage is a core data-plane dependency. The provider registry row
-- refers only to optional server-issued signed targets; migrate the legacy
-- ambiguous identity and then remove it from the finite provider set.
delete from public.integration_connections legacy
where legacy.provider = 'storage'
  and exists (
    select 1
    from public.integration_connections current
    where current.company_id = legacy.company_id
      and current.provider = 'signed_storage_targets'
  );
update public.integration_connections
set provider = 'signed_storage_targets'
where provider = 'storage';
alter table public.integration_connections
  drop constraint integration_connections_provider_check;
alter table public.integration_connections
  add constraint integration_connections_provider_check
  check (provider in (
    'openai', 'twilio', 'email', 'stripe', 'google_calendar', 'maps',
    'nws', 'vroom', 'signed_storage_targets', 'quickbooks_export'
  ));

-- Customer portal scope-photo ingestion is closed in V1 until it has its own
-- quota, lifecycle, byte-verifying finalizer, and orphan cleanup. Existing
-- authorized customer-visible objects remain readable through the separate
-- can_read predicate.
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
begin
  if cardinality(folders) < 3
    or folders[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or folders[3] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    return false;
  end if;
  target_company_id := folders[1]::uuid;
  scope_id := folders[3]::uuid;
  if public.has_company_role(
    target_company_id,
    array['owner', 'dispatcher']::public.app_role[]
  ) then
    return folders[2] in ('visits', 'customers', 'incidents', 'scope');
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

create table public.media_upload_attestations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  command_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  asset_id uuid not null,
  object_path text not null,
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint not null check (byte_size between 1 and 15728640),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  attested_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  consumed_at timestamptz,
  unique (company_id, command_id),
  unique (company_id, asset_id),
  check (expires_at > attested_at)
);

alter table public.media_upload_attestations enable row level security;
alter table public.media_upload_attestations force row level security;
revoke all on public.media_upload_attestations from public, anon, authenticated;

create or replace function public.attest_storyops_media_upload(
  p_company_id uuid,
  p_command_id uuid,
  p_actor_user_id uuid,
  p_asset_id uuid,
  p_object_path text,
  p_checksum_sha256 text,
  p_byte_size bigint,
  p_content_type text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  attestation_id uuid;
  existing public.media_upload_attestations%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Media attestation requires the trusted service boundary';
  end if;
  if p_checksum_sha256 !~ '^[a-f0-9]{64}$'
    or p_byte_size not between 1 and 15728640
    or p_content_type not in ('image/jpeg', 'image/png', 'image/webp')
    or p_object_path not like concat(p_company_id::text, '/%')
  then
    raise exception 'Media attestation metadata is invalid';
  end if;
  if not exists (
    select 1
    from storage.objects object
    where object.bucket_id = 'job-media'
      and object.name = p_object_path
      and (object.metadata ->> 'size')::bigint = p_byte_size
      and coalesce(
        object.metadata ->> 'mimetype',
        object.metadata ->> 'contentType'
      ) = p_content_type
  ) then
    raise exception 'Media attestation requires the durable Storage object';
  end if;

  insert into public.media_upload_attestations(
    company_id, command_id, actor_user_id, asset_id, object_path,
    checksum_sha256, byte_size, content_type
  )
  values (
    p_company_id, p_command_id, p_actor_user_id, p_asset_id, p_object_path,
    p_checksum_sha256, p_byte_size, p_content_type
  )
  on conflict (company_id, command_id) do nothing
  returning id into attestation_id;

  if attestation_id is null then
    select *
    into existing
    from public.media_upload_attestations
    where company_id = p_company_id and command_id = p_command_id;
    if existing.actor_user_id <> p_actor_user_id
      or existing.asset_id <> p_asset_id
      or existing.object_path <> p_object_path
      or existing.checksum_sha256 <> p_checksum_sha256
      or existing.byte_size <> p_byte_size
      or existing.content_type <> p_content_type
    then
      raise exception 'Media command ID conflicts with a different attestation';
    end if;
    attestation_id := existing.id;
  end if;
  return attestation_id;
end;
$$;

revoke all on function public.attest_storyops_media_upload(
  uuid, uuid, uuid, uuid, text, text, bigint, text
) from public, anon, authenticated;
grant execute on function public.attest_storyops_media_upload(
  uuid, uuid, uuid, uuid, text, text, bigint, text
) to service_role;

create or replace function public.require_durable_job_media_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  consumed_attestation_id uuid;
begin
  if new.sync_state = 'synced' and auth.role() <> 'service_role' then
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

revoke all on function public.require_durable_job_media_object() from public, anon, authenticated;

drop trigger if exists media_assets_require_durable_object on public.media_assets;
create trigger media_assets_require_durable_object
  before insert or update
  on public.media_assets
  for each row execute function public.require_durable_job_media_object();

comment on function public.require_durable_job_media_object() is
  'Fail-closed Storage reconciliation gate: synced media requires its durable private object plus a matching, unconsumed trusted byte-checksum attestation.';

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
  visit_job_id_value uuid;
  visit_property_id_value uuid;
  captured_at_value timestamptz := nullif(p_payload ->> 'capturedAt', '')::timestamptz;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  inserted_reservation_id uuid;
  resulting_version integer;
  result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Media finalization requires the trusted service boundary';
  end if;
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or exists (
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in (
        'entityId', 'visitId', 'jobId', 'propertyId', 'purpose', 'objectPath',
        'contentType', 'byteSize', 'checksumSha256', 'capturedAt', 'customerVisible'
      )
    )
  then
    raise exception 'Media finalization payload is invalid';
  end if;
  if p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or asset_id_value is null
    or visit_id_value is null
    or job_id_value is null
    or property_id_value is null
    or captured_at_value is null
    or p_payload ->> 'purpose' not in ('before', 'after', 'signature')
    or p_payload ->> 'contentType' not in ('image/jpeg', 'image/png', 'image/webp')
    or (p_payload ->> 'byteSize')::bigint not between 1 and 15728640
    or p_payload ->> 'checksumSha256' !~ '^[a-f0-9]{64}$'
    or coalesce((p_payload ->> 'customerVisible')::boolean, true)
  then
    raise exception 'Media finalization fields are invalid';
  end if;
  if captured_at_value > clock_timestamp() + interval '5 minutes'
    or captured_at_value < clock_timestamp() - interval '30 days'
  then
    raise exception 'Media timestamp is outside the offline recovery window';
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
  if actor_role = 'technician'
    and not exists (
      select 1
      from public.visits assigned_visit
      join public.crew_members member on member.crew_id = assigned_visit.crew_id
      where assigned_visit.id = visit_id_value
        and assigned_visit.company_id = p_company_id
        and member.user_id = p_actor_user_id
        and member.starts_on <= assigned_visit.ends_at::date
        and (member.ends_on is null or member.ends_on >= assigned_visit.starts_at::date)
    )
  then
    raise exception 'Technician is not assigned to this visit';
  elsif actor_role not in ('owner', 'dispatcher', 'technician') then
    raise exception 'Role cannot finalize field media';
  end if;

  select visit.job_id, job.property_id
  into visit_job_id_value, visit_property_id_value
  from public.visits visit
  join public.jobs job on job.id = visit.job_id and job.company_id = visit.company_id
  where visit.id = visit_id_value
    and visit.company_id = p_company_id
    and visit.status in ('on_site', 'paused');
  if not found
    or visit_job_id_value <> job_id_value
    or visit_property_id_value <> property_id_value
    or p_payload ->> 'objectPath' not like concat(
      p_company_id::text,
      '/visits/',
      visit_id_value::text,
      '/',
      asset_id_value::text,
      '-',
      left(p_payload ->> 'checksumSha256', 16),
      '-%'
    )
  then
    raise exception 'Media visit, lifecycle, associations, or content-addressed path disagree';
  end if;

  effective_request_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'commandType', 'media.register',
        'expectedVersion', 0,
        'payload', p_payload
      )::text,
      'sha256'
    ),
    'hex'
  );
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
    id, company_id, property_id, job_id, visit_id, purpose, object_path,
    content_type, byte_size, checksum_sha256, captured_at, captured_by,
    customer_visible, offline_client_id, sync_state
  )
  values (
    asset_id_value, p_company_id, property_id_value, job_id_value, visit_id_value,
    p_payload ->> 'purpose', p_payload ->> 'objectPath', p_payload ->> 'contentType',
    (p_payload ->> 'byteSize')::bigint, p_payload ->> 'checksumSha256',
    captured_at_value, p_actor_user_id, false, p_command_id::text, 'synced'
  )
  returning version into resulting_version;

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

alter table public.completion_signatures
  add column received_at timestamptz not null default clock_timestamp();

create or replace function public.enforce_completion_signature_window()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.signed_at > clock_timestamp() + interval '5 minutes'
    or new.signed_at < clock_timestamp() - interval '7 days'
  then
    raise exception 'Signature timestamp is outside the offline recovery window';
  end if;
  if not exists (
    select 1
    from public.visits visit
    where visit.id = new.visit_id
      and visit.company_id = new.company_id
      and visit.status in ('on_site', 'paused')
  ) then
    raise exception 'Completion signature requires active or paused on-site work';
  end if;
  new.received_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function public.enforce_completion_signature_window()
  from public, anon, authenticated;

create trigger completion_signatures_enforce_window
  before insert on public.completion_signatures
  for each row execute function public.enforce_completion_signature_window();

-- Permit the uploader to read back a staged object before media.register creates
-- its metadata row. The same company/assignment/customer path predicate used for
-- upload remains mandatory; unrelated objects stay private.
drop policy if exists job_media_select on storage.objects;
create policy job_media_select on storage.objects for select to authenticated using (
  bucket_id = 'job-media'
  and (
    public.can_read_job_media_object(name)
    or public.can_upload_job_media_object(name)
  )
);

-- Content-addressed job evidence is immutable. A correction is a new object and
-- a new media command; the browser cannot replace bytes behind a registered path.
drop policy if exists job_media_update on storage.objects;

-- All media/signature writes cross the finite command/finalizer boundary.
drop policy if exists media_assets_staff_insert on public.media_assets;
drop policy if exists media_assets_staff_update on public.media_assets;
drop policy if exists completion_signatures_staff_insert on public.completion_signatures;
drop policy if exists completion_signatures_staff_update on public.completion_signatures;

revoke insert, update, delete, truncate
  on public.media_assets, public.completion_signatures
  from anon, authenticated;
