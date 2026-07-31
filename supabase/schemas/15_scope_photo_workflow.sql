-- Property-scoped, photo-assisted estimating evidence. Uploads remain private,
-- content-addressed, bounded, and non-billable until a back-office human creates
-- an explicit property_measurements record through the finite confirmation RPC.

alter table public.photo_analyses
  add column source_asset_id uuid references public.media_assets(id) on delete restrict,
  add column access_flags jsonb not null default '[]'::jsonb
    check (jsonb_typeof(access_flags) = 'array'),
  add column risk_flags jsonb not null default '[]'::jsonb
    check (jsonb_typeof(risk_flags) = 'array');

alter table public.property_measurements
  add column source_analysis_id uuid references public.photo_analyses(id) on delete restrict,
  add column human_confirmation_note text;

alter table public.property_measurements
  add constraint photo_assisted_measurement_confirmation
  check (
    source <> 'photo_assisted'
    or (
      verified_by_human
      and measured_by is not null
      and cardinality(source_asset_ids) > 0
      and nullif(btrim(human_confirmation_note), '') is not null
    )
  ) not valid;

create table public.scope_photo_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  status text not null default 'open'
    check (status in ('open', 'submitted', 'reviewed', 'expired', 'cancelled')),
  checklist_version text not null,
  checklist jsonb not null check (
    jsonb_typeof(checklist) = 'array'
    and jsonb_array_length(checklist) between 1 and 12
  ),
  note text not null default '' check (length(note) <= 500),
  maximum_photos integer not null default 12 check (maximum_photos between 1 and 12),
  requested_by uuid not null references auth.users(id) on delete restrict,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (expires_at > created_at)
);

create index scope_photo_requests_property_idx
  on public.scope_photo_requests(company_id, property_id, created_at desc);
create index scope_photo_requests_customer_idx
  on public.scope_photo_requests(company_id, customer_id, status, expires_at);

create table public.scope_photo_upload_reservations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  request_id uuid not null references public.scope_photo_requests(id) on delete cascade,
  command_id uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  checklist_item_code text not null check (length(checklist_item_code) between 1 and 80),
  asset_id uuid not null,
  object_path text not null check (length(object_path) between 1 and 500),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint not null check (byte_size between 1 and 10485760),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz not null,
  prepared_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'prepared'
    check (status in ('prepared', 'finalized', 'cleanup_claimed', 'cleanup_failed', 'cleaned')),
  expires_at timestamptz not null,
  finalized_at timestamptz,
  cleanup_attempts integer not null default 0 check (cleanup_attempts between 0 and 10),
  cleanup_error text,
  cleanup_claimed_at timestamptz,
  cleaned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, command_id),
  unique (company_id, asset_id),
  unique (company_id, object_path),
  check (object_path like company_id::text || '/customers/%'),
  check (expires_at > created_at),
  check ((status = 'finalized') = (finalized_at is not null))
);

create index scope_photo_upload_orphan_idx
  on public.scope_photo_upload_reservations(status, expires_at)
  where status in ('prepared', 'cleanup_failed');

create table public.scope_photo_submissions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  request_id uuid not null references public.scope_photo_requests(id) on delete cascade,
  reservation_id uuid not null unique
    references public.scope_photo_upload_reservations(id) on delete restrict,
  checklist_item_code text not null,
  asset_id uuid not null unique references public.media_assets(id) on delete restrict,
  analysis_id uuid references public.photo_analyses(id) on delete restrict,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (request_id, asset_id)
);

create index scope_photo_submissions_request_idx
  on public.scope_photo_submissions(company_id, request_id, created_at);

create table public.scope_photo_reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  request_id uuid not null references public.scope_photo_requests(id) on delete cascade,
  disposition text not null check (
    disposition in ('confirmed_for_estimate', 'site_verification_required', 'more_photos_required')
  ),
  access_decision text not null check (length(btrim(access_decision)) between 10 and 1000),
  risk_decision text not null check (length(btrim(risk_decision)) between 10 and 1000),
  unresolved_unknowns text[] not null default '{}',
  reviewed_by uuid not null references auth.users(id) on delete restrict,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.scope_confirmed_measurements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  request_id uuid not null references public.scope_photo_requests(id) on delete restrict,
  analysis_id uuid references public.photo_analyses(id) on delete restrict,
  measurement_id uuid not null unique
    references public.property_measurements(id) on delete restrict,
  confirmation_note text not null check (length(btrim(confirmation_note)) between 10 and 1000),
  confirmed_by uuid not null references auth.users(id) on delete restrict,
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index scope_photo_reviews_request_idx
  on public.scope_photo_reviews(company_id, request_id, reviewed_at desc);

alter table public.scope_photo_requests enable row level security;
alter table public.scope_photo_upload_reservations enable row level security;
alter table public.scope_photo_submissions enable row level security;
alter table public.scope_photo_reviews enable row level security;
alter table public.scope_confirmed_measurements enable row level security;

revoke all on table
  public.scope_photo_requests,
  public.scope_photo_upload_reservations,
  public.scope_photo_submissions,
  public.scope_photo_reviews,
  public.scope_confirmed_measurements
from public, anon;

revoke insert, update, delete, truncate on table
  public.scope_photo_requests,
  public.scope_photo_upload_reservations,
  public.scope_photo_submissions,
  public.scope_photo_reviews,
  public.scope_confirmed_measurements
from authenticated;

grant select on table
  public.scope_photo_requests,
  public.scope_photo_submissions,
  public.scope_photo_reviews,
  public.scope_confirmed_measurements
to authenticated;

create policy scope_photo_requests_select
  on public.scope_photo_requests for select
  using (
    public.has_company_role(
      company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
    or public.is_customer_user(company_id, customer_id)
  );

create policy scope_photo_submissions_select
  on public.scope_photo_submissions for select
  using (
    exists (
      select 1
      from public.scope_photo_requests request
      where request.id = scope_photo_submissions.request_id
        and request.company_id = scope_photo_submissions.company_id
        and (
          public.has_company_role(
            request.company_id,
            array['owner', 'dispatcher']::public.app_role[]
          )
          or public.is_customer_user(request.company_id, request.customer_id)
        )
    )
  );

create policy scope_photo_reviews_staff_select
  on public.scope_photo_reviews for select
  using (
    public.has_company_role(
      company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
  );

create policy scope_confirmed_measurements_staff_select
  on public.scope_confirmed_measurements for select
  using (
    public.has_company_role(
      company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
  );

create or replace function public.resolve_scope_photo_actor(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_customer_id uuid
)
returns text
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  actor_role public.app_role;
begin
  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = p_actor_user_id
    and membership.active;

  if actor_role in ('owner', 'dispatcher') then
    return actor_role::text;
  end if;
  if actor_role = 'customer'
    and exists (
      select 1
      from public.customer_portal_users portal
      where portal.company_id = p_company_id
        and portal.customer_id = p_customer_id
        and portal.user_id = p_actor_user_id
    )
  then
    return 'customer';
  end if;
  raise exception 'SCOPE_PHOTO_ROLE_REQUIRED';
end;
$$;

revoke all on function public.resolve_scope_photo_actor(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_scope_photo_actor(uuid, uuid, uuid)
  to service_role;

create or replace function public.create_scope_photo_request(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_customer_id uuid,
  p_property_id uuid,
  p_note text,
  p_expires_in_days integer,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role text;
  request_id_value uuid;
  claim_id uuid;
  existing public.idempotency_keys%rowtype;
  result jsonb;
  checklist_value jsonb := jsonb_build_array(
    jsonb_build_object(
      'code', 'front_elevation',
      'label', 'Front elevation',
      'guidance', 'Stand back far enough to show the full front work area and surrounding access.',
      'required', true,
      'maximumPhotos', 2,
      'sortOrder', 10
    ),
    jsonb_build_object(
      'code', 'rear_elevation',
      'label', 'Rear elevation',
      'guidance', 'Show the rear work area, doors, gates, and nearby obstacles in one wide view.',
      'required', true,
      'maximumPhotos', 2,
      'sortOrder', 20
    ),
    jsonb_build_object(
      'code', 'left_side',
      'label', 'Left side',
      'guidance', 'Show the full left-side work area and the path a technician would use.',
      'required', true,
      'maximumPhotos', 2,
      'sortOrder', 30
    ),
    jsonb_build_object(
      'code', 'right_side',
      'label', 'Right side',
      'guidance', 'Show the full right-side work area and the path a technician would use.',
      'required', true,
      'maximumPhotos', 2,
      'sortOrder', 40
    ),
    jsonb_build_object(
      'code', 'access_detail',
      'label', 'Access detail',
      'guidance', 'Show gates, stairs, slopes, tight passages, or other access constraints.',
      'required', true,
      'maximumPhotos', 2,
      'sortOrder', 50
    ),
    jsonb_build_object(
      'code', 'surface_or_risk_detail',
      'label', 'Surface or risk detail',
      'guidance', 'Add a close view of unusual staining, fragile surfaces, overhead lines, damage, or another concern.',
      'required', false,
      'maximumPhotos', 2,
      'sortOrder', 60
    )
  );
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  if p_request_hash !~ '^[a-f0-9]{64}$'
    or length(p_idempotency_key) not between 8 and 256
    or p_expires_in_days not between 1 and 14
    or length(coalesce(p_note, '')) > 500
  then
    raise exception 'SCOPE_PHOTO_REQUEST_INVALID';
  end if;

  actor_role := public.resolve_scope_photo_actor(
    p_company_id,
    p_actor_user_id,
    p_customer_id
  );
  if actor_role not in ('owner', 'dispatcher') then
    raise exception 'SCOPE_PHOTO_STAFF_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.properties property
    where property.id = p_property_id
      and property.company_id = p_company_id
      and property.customer_id = p_customer_id
  ) then
    raise exception 'SCOPE_PHOTO_PROPERTY_NOT_FOUND';
  end if;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'scope-photo-request-v1',
    p_idempotency_key,
    p_request_hash,
    now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into claim_id;

  if claim_id is null then
    select *
    into existing
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'scope-photo-request-v1'
      and key = p_idempotency_key;
    if existing.request_hash <> p_request_hash then
      raise exception 'SCOPE_PHOTO_IDEMPOTENCY_CONFLICT';
    end if;
    if existing.status = 'completed' then
      return existing.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'SCOPE_PHOTO_IDEMPOTENCY_IN_PROGRESS';
  end if;

  insert into public.scope_photo_requests(
    company_id, customer_id, property_id, checklist_version, checklist,
    note, maximum_photos, requested_by, expires_at
  )
  values (
    p_company_id, p_customer_id, p_property_id, 'exterior-scope-v1',
    checklist_value,  coalesce(p_note, ''), 12, p_actor_user_id,
    now() + make_interval(days => p_expires_in_days)
  )
  returning id into request_id_value;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-scope-photo-request-v1',
    'requestId', request_id_value,
    'propertyId', p_property_id,
    'customerId', p_customer_id,
    'status', 'open',
    'checklistVersion', 'exterior-scope-v1',
    'maximumPhotos', 12,
    'replayed', false,
    'serverTime', clock_timestamp()
  );
  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now()
  where id = claim_id;
  return result;
end;
$$;

revoke all on function public.create_scope_photo_request(
  uuid, uuid, uuid, uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.create_scope_photo_request(
  uuid, uuid, uuid, uuid, text, integer, text, text
) to service_role;

create or replace function public.prepare_scope_photo_upload(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_checklist_item_code text,
  p_asset_id uuid,
  p_content_type text,
  p_byte_size bigint,
  p_checksum_sha256 text,
  p_captured_at timestamptz,
  p_command_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  request_row public.scope_photo_requests%rowtype;
  actor_role text;
  checklist_item jsonb;
  item_maximum integer;
  active_count integer;
  item_count integer;
  reservation public.scope_photo_upload_reservations%rowtype;
  replayed_value boolean := false;
  object_path_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  select *
  into request_row
  from public.scope_photo_requests
  where id = p_request_id
    and company_id = p_company_id
  for update;
  if not found then
    raise exception 'SCOPE_PHOTO_REQUEST_NOT_FOUND';
  end if;

  actor_role := public.resolve_scope_photo_actor(
    p_company_id,
    p_actor_user_id,
    request_row.customer_id
  );
  if actor_role not in ('owner', 'dispatcher', 'customer') then
    raise exception 'SCOPE_PHOTO_ROLE_REQUIRED';
  end if;
  object_path_value := concat(
    p_company_id::text,
    '/customers/',
    request_row.customer_id::text,
    '/',
    p_asset_id::text,
    '-',
    left(p_checksum_sha256, 16),
    '-scope.',
    case p_content_type
      when 'image/jpeg' then 'jpg'
      when 'image/png' then 'png'
      when 'image/webp' then 'webp'
      else 'invalid'
    end
  );

  select existing.*
  into reservation
  from public.scope_photo_upload_reservations existing
  where existing.company_id = p_company_id
    and existing.command_id = p_command_id;
  if found then
    if reservation.request_hash <> p_request_hash
      or reservation.request_id <> p_request_id
      or reservation.asset_id <> p_asset_id
      or reservation.object_path <> object_path_value
      or reservation.checksum_sha256 <> p_checksum_sha256
    then
      raise exception 'SCOPE_PHOTO_IDEMPOTENCY_CONFLICT';
    end if;
    replayed_value := true;
  else
    if request_row.status not in ('open', 'submitted')
      or request_row.expires_at <= now()
      or p_request_hash !~ '^[a-f0-9]{64}$'
      or p_content_type not in ('image/jpeg', 'image/png', 'image/webp')
      or p_byte_size not between 1 and 10485760
      or p_checksum_sha256 !~ '^[a-f0-9]{64}$'
      or p_captured_at > clock_timestamp() + interval '5 minutes'
      or p_captured_at < clock_timestamp() - interval '30 days'
    then
      raise exception 'SCOPE_PHOTO_UPLOAD_INVALID';
    end if;

    select item
    into checklist_item
    from jsonb_array_elements(request_row.checklist) item
    where item ->> 'code' = p_checklist_item_code;
    if checklist_item is null then
      raise exception 'SCOPE_PHOTO_CHECKLIST_ITEM_INVALID';
    end if;
    item_maximum := (checklist_item ->> 'maximumPhotos')::integer;

    select count(*)
    into active_count
    from public.scope_photo_upload_reservations candidate
    where candidate.request_id = p_request_id
      and candidate.status in ('prepared', 'finalized')
      and (
        candidate.status = 'finalized'
        or candidate.expires_at > now()
      );
    select count(*)
    into item_count
    from public.scope_photo_upload_reservations candidate
    where candidate.request_id = p_request_id
      and candidate.checklist_item_code = p_checklist_item_code
      and candidate.status in ('prepared', 'finalized')
      and (
        candidate.status = 'finalized'
        or candidate.expires_at > now()
      );
    if active_count >= request_row.maximum_photos or item_count >= item_maximum then
      raise exception 'SCOPE_PHOTO_UPLOAD_LIMIT_REACHED';
    end if;

    insert into public.scope_photo_upload_reservations(
      company_id, request_id, command_id, request_hash, checklist_item_code,
      asset_id, object_path, content_type, byte_size, checksum_sha256,
      captured_at, prepared_by, expires_at
    )
    values (
      p_company_id, p_request_id, p_command_id, p_request_hash,
      p_checklist_item_code, p_asset_id, object_path_value, p_content_type,
      p_byte_size, p_checksum_sha256, p_captured_at, p_actor_user_id,
      now() + interval '2 hours'
    )
    returning * into reservation;
  end if;

  return jsonb_build_object(
    'schemaVersion', 'storyops-scope-photo-reservation-v1',
    'commandId', reservation.command_id,
    'requestId', reservation.request_id,
    'assetId', reservation.asset_id,
    'objectPath', reservation.object_path,
    'contentType', reservation.content_type,
    'byteSize', reservation.byte_size,
    'checksumSha256', reservation.checksum_sha256,
    'capturedAt', reservation.captured_at,
    'expiresAt', reservation.expires_at,
    'status', reservation.status,
    'replayed', replayed_value
  );
end;
$$;

revoke all on function public.prepare_scope_photo_upload(
  uuid, uuid, uuid, text, uuid, text, bigint, text, timestamptz, uuid, text
) from public, anon, authenticated;
grant execute on function public.prepare_scope_photo_upload(
  uuid, uuid, uuid, text, uuid, text, bigint, text, timestamptz, uuid, text
) to service_role;

create or replace function public.load_scope_photo_upload_reservation(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_command_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  request_row public.scope_photo_requests%rowtype;
  reservation public.scope_photo_upload_reservations%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  select *
  into request_row
  from public.scope_photo_requests
  where id = p_request_id and company_id = p_company_id;
  if not found then
    raise exception 'SCOPE_PHOTO_REQUEST_NOT_FOUND';
  end if;
  perform public.resolve_scope_photo_actor(
    p_company_id,
    p_actor_user_id,
    request_row.customer_id
  );
  select *
  into reservation
  from public.scope_photo_upload_reservations
  where company_id = p_company_id
    and request_id = p_request_id
    and command_id = p_command_id;
  if not found then
    raise exception 'SCOPE_PHOTO_RESERVATION_NOT_FOUND';
  end if;
  return to_jsonb(reservation);
end;
$$;

revoke all on function public.load_scope_photo_upload_reservation(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.load_scope_photo_upload_reservation(uuid, uuid, uuid, uuid)
  to service_role;

create or replace function public.finalize_scope_photo_upload(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_command_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  request_row public.scope_photo_requests%rowtype;
  reservation public.scope_photo_upload_reservations%rowtype;
  submission public.scope_photo_submissions%rowtype;
  retention_days integer;
  asset_version integer;
  all_required_complete boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  select *
  into request_row
  from public.scope_photo_requests
  where id = p_request_id
    and company_id = p_company_id
  for update;
  if not found then
    raise exception 'SCOPE_PHOTO_REQUEST_NOT_FOUND';
  end if;
  perform public.resolve_scope_photo_actor(
    p_company_id,
    p_actor_user_id,
    request_row.customer_id
  );

  select *
  into reservation
  from public.scope_photo_upload_reservations
  where company_id = p_company_id
    and request_id = p_request_id
    and command_id = p_command_id
  for update;
  if not found then
    raise exception 'SCOPE_PHOTO_RESERVATION_NOT_FOUND';
  end if;
  if reservation.prepared_by <> p_actor_user_id then
    raise exception 'SCOPE_PHOTO_UPLOADER_MISMATCH';
  end if;
  if reservation.status = 'finalized' then
    select *
    into submission
    from public.scope_photo_submissions existing
    where existing.reservation_id = reservation.id;
    return jsonb_build_object(
      'schemaVersion', 'storyops-scope-photo-finalized-v1',
      'commandId', reservation.command_id,
      'requestId', reservation.request_id,
      'submissionId', submission.id,
      'assetId', reservation.asset_id,
      'version', 1,
      'replayed', true,
      'serverTime', reservation.finalized_at
    );
  end if;
  if reservation.status <> 'prepared'
    or reservation.expires_at <= now()
    or request_row.status not in ('open', 'submitted')
    or request_row.expires_at <= now()
  then
    raise exception 'SCOPE_PHOTO_RESERVATION_EXPIRED';
  end if;

  perform public.attest_storyops_media_upload(
    p_company_id,
    p_command_id,
    p_actor_user_id,
    reservation.asset_id,
    reservation.object_path,
    reservation.checksum_sha256,
    reservation.byte_size,
    reservation.content_type
  );

  select company.default_operational_retention_days
  into retention_days
  from public.companies company
  where company.id = p_company_id;

  insert into public.media_assets(
    id, company_id, property_id, purpose, object_path, content_type, byte_size,
    checksum_sha256, captured_at, captured_by, customer_visible,
    offline_client_id, sync_state, retention_class, retain_until
  )
  values (
    reservation.asset_id, p_company_id, request_row.property_id, 'scope',
    reservation.object_path, reservation.content_type, reservation.byte_size,
    reservation.checksum_sha256, reservation.captured_at, p_actor_user_id, true,
    p_command_id::text, 'synced', 'operational',
    now() + make_interval(days => retention_days)
  )
  returning version into asset_version;

  insert into public.scope_photo_submissions(
    company_id, request_id, reservation_id, checklist_item_code, asset_id, uploaded_by
  )
  values (
    p_company_id, p_request_id, reservation.id, reservation.checklist_item_code,
    reservation.asset_id, p_actor_user_id
  )
  returning * into submission;

  update public.scope_photo_upload_reservations
  set status = 'finalized', finalized_at = clock_timestamp(), updated_at = now()
  where id = reservation.id;

  select not exists (
    select 1
    from jsonb_array_elements(request_row.checklist) item
    where coalesce((item ->> 'required')::boolean, false)
      and not exists (
        select 1
        from public.scope_photo_submissions uploaded
        where uploaded.request_id = p_request_id
          and uploaded.checklist_item_code = item ->> 'code'
      )
  )
  into all_required_complete;

  if all_required_complete then
    update public.scope_photo_requests
    set status = 'submitted', updated_at = now()
    where id = p_request_id and status = 'open';
  end if;

  return jsonb_build_object(
    'schemaVersion', 'storyops-scope-photo-finalized-v1',
    'commandId', reservation.command_id,
    'requestId', reservation.request_id,
    'submissionId', submission.id,
    'assetId', reservation.asset_id,
    'version', asset_version,
    'replayed', false,
    'serverTime', clock_timestamp()
  );
end;
$$;

revoke all on function public.finalize_scope_photo_upload(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_scope_photo_upload(uuid, uuid, uuid, uuid)
  to service_role;

create or replace function public.authorize_scope_photo_analysis(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_property_id uuid,
  p_asset_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select auth.role() is not distinct from 'service_role'
    and exists (
      select 1
      from public.company_memberships membership
      join public.scope_photo_submissions submission
        on submission.company_id = membership.company_id
      join public.scope_photo_requests request
        on request.id = submission.request_id
        and request.company_id = submission.company_id
      where membership.company_id = p_company_id
        and membership.user_id = p_actor_user_id
        and membership.active
        and membership.role in ('owner', 'dispatcher')
        and submission.asset_id = p_asset_id
        and request.property_id = p_property_id
        and request.status in ('open', 'submitted', 'reviewed')
    );
$$;

revoke all on function public.authorize_scope_photo_analysis(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.authorize_scope_photo_analysis(uuid, uuid, uuid, uuid)
  to service_role;

create or replace function public.link_scope_photo_analysis(
  p_company_id uuid,
  p_asset_id uuid,
  p_analysis_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.photo_analyses analysis
    where analysis.id = p_analysis_id
      and analysis.company_id = p_company_id
      and analysis.source_asset_id = p_asset_id
  ) then
    raise exception 'SCOPE_PHOTO_ANALYSIS_SCOPE_MISMATCH';
  end if;
  update public.scope_photo_submissions submission
  set analysis_id = p_analysis_id
  where submission.company_id = p_company_id
    and submission.asset_id = p_asset_id
    and (submission.analysis_id is null or submission.analysis_id = p_analysis_id);
  if not found then
    raise exception 'SCOPE_PHOTO_SUBMISSION_NOT_FOUND';
  end if;
end;
$$;

revoke all on function public.link_scope_photo_analysis(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.link_scope_photo_analysis(uuid, uuid, uuid)
  to service_role;

create or replace function public.confirm_scope_photo_measurement(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_analysis_id uuid,
  p_source_asset_ids uuid[],
  p_kind text,
  p_label text,
  p_value numeric,
  p_unit text,
  p_service_codes text[],
  p_add_on_codes text[],
  p_confirmation_note text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  request_row public.scope_photo_requests%rowtype;
  actor_role text;
  claim_id uuid;
  existing public.idempotency_keys%rowtype;
  measurement_id_value uuid;
  result jsonb;
  expected_unit text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  select *
  into request_row
  from public.scope_photo_requests
  where id = p_request_id and company_id = p_company_id;
  if not found then
    raise exception 'SCOPE_PHOTO_REQUEST_NOT_FOUND';
  end if;
  actor_role := public.resolve_scope_photo_actor(
    p_company_id,
    p_actor_user_id,
    request_row.customer_id
  );
  if actor_role not in ('owner', 'dispatcher') then
    raise exception 'SCOPE_PHOTO_STAFF_REQUIRED';
  end if;

  expected_unit := case p_kind
    when 'area_sq_ft' then 'sq_ft'
    when 'length_linear_ft' then 'linear_ft'
    when 'height_ft' then 'ft'
    when 'count' then 'each'
    when 'stories' then 'story'
    when 'duration_hours' then 'hour'
    else null
  end;
  if expected_unit is null
    or p_unit <> expected_unit
    or p_value is null
    or p_value <= 0
    or (p_kind in ('count', 'stories') and p_value <> trunc(p_value))
    or length(btrim(p_label)) not between 2 and 160
    or length(btrim(p_confirmation_note)) not between 10 and 1000
    or coalesce(cardinality(p_source_asset_ids), 0) not between 1 and 12
    or coalesce(cardinality(p_service_codes), 0)
      + coalesce(cardinality(p_add_on_codes), 0) = 0
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or length(p_idempotency_key) not between 8 and 256
  then
    raise exception 'SCOPE_PHOTO_MEASUREMENT_INVALID';
  end if;
  if (
    select count(distinct submission.asset_id)
    from public.scope_photo_submissions submission
    where submission.company_id = p_company_id
      and submission.request_id = p_request_id
      and submission.asset_id = any(p_source_asset_ids)
  ) <> cardinality(p_source_asset_ids)
  then
    raise exception 'SCOPE_PHOTO_SOURCE_ASSET_MISMATCH';
  end if;
  if p_analysis_id is not null
    and not exists (
      select 1
      from public.photo_analyses analysis
      join public.scope_photo_submissions submission
        on submission.analysis_id = analysis.id
      where analysis.id = p_analysis_id
        and analysis.company_id = p_company_id
        and analysis.property_id = request_row.property_id
        and submission.request_id = p_request_id
        and submission.asset_id = any(p_source_asset_ids)
    )
  then
    raise exception 'SCOPE_PHOTO_ANALYSIS_SCOPE_MISMATCH';
  end if;
  if exists (
    select 1
    from unnest(p_service_codes) requested(code)
    where not exists (
      select 1
      from public.service_catalog catalog
      where catalog.company_id = p_company_id
        and catalog.code = requested.code
        and catalog.active
    )
  ) then
    raise exception 'SCOPE_PHOTO_SERVICE_CLASSIFICATION_INVALID';
  end if;
  if exists (
    select 1
    from unnest(p_add_on_codes) requested(code)
    where not exists (
      select 1
      from public.price_book_add_ons add_on
      join public.price_book_service_rules rule on rule.id = add_on.service_rule_id
      join public.price_books book on book.id = rule.price_book_id
      where add_on.company_id = p_company_id
        and add_on.code = requested.code
        and book.status = 'active'
    )
  ) then
    raise exception 'SCOPE_PHOTO_ADD_ON_CLASSIFICATION_INVALID';
  end if;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id, 'scope-photo-measurement-v1', p_idempotency_key,
    p_request_hash, now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into claim_id;
  if claim_id is null then
    select *
    into existing
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'scope-photo-measurement-v1'
      and key = p_idempotency_key;
    if existing.request_hash <> p_request_hash then
      raise exception 'SCOPE_PHOTO_IDEMPOTENCY_CONFLICT';
    end if;
    if existing.status = 'completed' then
      return existing.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'SCOPE_PHOTO_IDEMPOTENCY_IN_PROGRESS';
  end if;

  insert into public.property_measurements(
    company_id, property_id, kind, label, value, unit, source, measured_at,
    measured_by, source_asset_ids, confidence, verified_by_human,
    service_codes, add_on_codes, source_analysis_id, human_confirmation_note
  )
  values (
    p_company_id, request_row.property_id, p_kind, btrim(p_label), p_value,
    p_unit, 'photo_assisted', clock_timestamp(), p_actor_user_id,
    p_source_asset_ids, null, true, p_service_codes, p_add_on_codes,
    p_analysis_id, btrim(p_confirmation_note)
  )
  returning id into measurement_id_value;

  insert into public.scope_confirmed_measurements(
    company_id, request_id, analysis_id, measurement_id,
    confirmation_note, confirmed_by
  )
  values (
    p_company_id, p_request_id, p_analysis_id, measurement_id_value,
    btrim(p_confirmation_note), p_actor_user_id
  );

  result := jsonb_build_object(
    'schemaVersion', 'storyops-scope-measurement-v1',
    'commandId', p_idempotency_key,
    'requestId', p_request_id,
    'measurementId', measurement_id_value,
    'version', 1,
    'replayed', false,
    'serverTime', clock_timestamp()
  );
  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now()
  where id = claim_id;
  return result;
end;
$$;

revoke all on function public.confirm_scope_photo_measurement(
  uuid, uuid, uuid, uuid, uuid[], text, text, numeric, text,
  text[], text[], text, text, text
) from public, anon, authenticated;
grant execute on function public.confirm_scope_photo_measurement(
  uuid, uuid, uuid, uuid, uuid[], text, text, numeric, text,
  text[], text[], text, text, text
) to service_role;

create or replace function public.review_scope_photo_request(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_disposition text,
  p_access_decision text,
  p_risk_decision text,
  p_unresolved_unknowns text[],
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  request_row public.scope_photo_requests%rowtype;
  actor_role text;
  claim_id uuid;
  existing public.idempotency_keys%rowtype;
  review_id_value uuid;
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  select *
  into request_row
  from public.scope_photo_requests
  where id = p_request_id and company_id = p_company_id
  for update;
  if not found then
    raise exception 'SCOPE_PHOTO_REQUEST_NOT_FOUND';
  end if;
  actor_role := public.resolve_scope_photo_actor(
    p_company_id,
    p_actor_user_id,
    request_row.customer_id
  );
  if actor_role not in ('owner', 'dispatcher') then
    raise exception 'SCOPE_PHOTO_STAFF_REQUIRED';
  end if;
  if p_disposition not in (
      'confirmed_for_estimate',
      'site_verification_required',
      'more_photos_required'
    )
    or length(btrim(p_access_decision)) not between 10 and 1000
    or length(btrim(p_risk_decision)) not between 10 and 1000
    or coalesce(cardinality(p_unresolved_unknowns), 0) > 50
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or length(p_idempotency_key) not between 8 and 256
  then
    raise exception 'SCOPE_PHOTO_REVIEW_INVALID';
  end if;
  if p_disposition = 'confirmed_for_estimate' and (
    coalesce(cardinality(p_unresolved_unknowns), 0) > 0
    or not exists (
      select 1
      from public.scope_confirmed_measurements measurement
      where measurement.request_id = p_request_id
    )
    or exists (
      select 1
      from jsonb_array_elements(request_row.checklist) item
      where coalesce((item ->> 'required')::boolean, false)
        and not exists (
          select 1
          from public.scope_photo_submissions submission
          where submission.request_id = p_request_id
            and submission.checklist_item_code = item ->> 'code'
        )
    )
  ) then
    raise exception 'SCOPE_PHOTO_REVIEW_EVIDENCE_INCOMPLETE';
  end if;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id, 'scope-photo-review-v1', p_idempotency_key,
    p_request_hash, now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into claim_id;
  if claim_id is null then
    select *
    into existing
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'scope-photo-review-v1'
      and key = p_idempotency_key;
    if existing.request_hash <> p_request_hash then
      raise exception 'SCOPE_PHOTO_IDEMPOTENCY_CONFLICT';
    end if;
    if existing.status = 'completed' then
      return existing.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'SCOPE_PHOTO_IDEMPOTENCY_IN_PROGRESS';
  end if;

  insert into public.scope_photo_reviews(
    company_id, request_id, disposition, access_decision, risk_decision,
    unresolved_unknowns, reviewed_by
  )
  values (
    p_company_id, p_request_id, p_disposition, btrim(p_access_decision),
    btrim(p_risk_decision), p_unresolved_unknowns, p_actor_user_id
  )
  returning id into review_id_value;
  update public.scope_photo_requests
  set status = case
        when p_disposition = 'more_photos_required' then 'open'
        else 'reviewed'
      end,
      updated_at = now()
  where id = p_request_id;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-scope-review-v1',
    'commandId', p_idempotency_key,
    'requestId', p_request_id,
    'reviewId', review_id_value,
    'replayed', false,
    'serverTime', clock_timestamp()
  );
  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now()
  where id = claim_id;
  return result;
end;
$$;

revoke all on function public.review_scope_photo_request(
  uuid, uuid, uuid, text, text, text, text[], text, text
) from public, anon, authenticated;
grant execute on function public.review_scope_photo_request(
  uuid, uuid, uuid, text, text, text, text[], text, text
) to service_role;

create or replace function public.load_scope_photo_context(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_property_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  property_row public.properties%rowtype;
  actor_role text;
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  select *
  into property_row
  from public.properties
  where id = p_property_id and company_id = p_company_id;
  if not found then
    raise exception 'SCOPE_PHOTO_PROPERTY_NOT_FOUND';
  end if;
  actor_role := public.resolve_scope_photo_actor(
    p_company_id,
    p_actor_user_id,
    property_row.customer_id
  );

  select jsonb_build_object(
    'schemaVersion', 'storyops-scope-photo-context-v1',
    'companyId', p_company_id,
    'propertyId', p_property_id,
    'actorRole', actor_role,
    'requests', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', request.id,
          'companyId', request.company_id,
          'customerId', request.customer_id,
          'propertyId', request.property_id,
          'status', case
            when request.status in ('open', 'submitted') and request.expires_at <= now()
              then 'expired'
            else request.status
          end,
          'checklistVersion', request.checklist_version,
          'checklist', request.checklist,
          'note', request.note,
          'maximumPhotos', request.maximum_photos,
          'photoCount', (
            select count(*)
            from public.scope_photo_submissions submission
            where submission.request_id = request.id
          ),
          'completedItemCodes', coalesce((
            select jsonb_agg(distinct submission.checklist_item_code)
            from public.scope_photo_submissions submission
            where submission.request_id = request.id
          ), '[]'::jsonb),
          'expiresAt', request.expires_at,
          'createdAt', request.created_at,
          'review', case
            when actor_role = 'customer' then null
            else (
            select jsonb_build_object(
              'id', review.id,
              'requestId', review.request_id,
              'disposition', review.disposition,
              'accessDecision', review.access_decision,
              'riskDecision', review.risk_decision,
              'unresolvedUnknowns', to_jsonb(review.unresolved_unknowns),
              'reviewedBy', review.reviewed_by,
              'reviewedAt', review.reviewed_at
            )
            from public.scope_photo_reviews review
            where review.request_id = request.id
            order by review.reviewed_at desc
            limit 1
          )
          end
        )
        order by request.created_at desc
      )
      from public.scope_photo_requests request
      where request.company_id = p_company_id
        and request.property_id = p_property_id
    ), '[]'::jsonb),
    'submissions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', submission.id,
          'requestId', submission.request_id,
          'checklistItemCode', submission.checklist_item_code,
          'assetId', asset.id,
          'contentType', asset.content_type,
          'byteSize', asset.byte_size,
          'checksumSha256', asset.checksum_sha256,
          'capturedAt', asset.captured_at,
          'uploadedBy', submission.uploaded_by,
          'analysis', case
            when actor_role = 'customer' or analysis.id is null then null
            else jsonb_build_object(
              'id', analysis.id,
              'sourceAssetId', analysis.source_asset_id,
              'overallConfidence', analysis.overall_confidence::text,
              'disposition', analysis.disposition,
              'observations', analysis.observations,
              'measurementCandidates', analysis.measurement_candidates,
              'accessFlags', analysis.access_flags,
              'riskFlags', analysis.risk_flags,
              'unknowns', to_jsonb(analysis.unknowns),
              'injectionSignals', to_jsonb(analysis.injection_signals),
              'analyzedAt', analysis.analyzed_at
            )
          end
        )
        order by asset.captured_at
      )
      from public.scope_photo_submissions submission
      join public.scope_photo_requests request on request.id = submission.request_id
      join public.media_assets asset on asset.id = submission.asset_id
      left join public.photo_analyses analysis on analysis.id = submission.analysis_id
      where submission.company_id = p_company_id
        and request.property_id = p_property_id
    ), '[]'::jsonb),
    'confirmedMeasurements', case
      when actor_role = 'customer' then '[]'::jsonb
      else coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', measurement.id,
            'requestId', relation.request_id,
            'analysisId', relation.analysis_id,
            'label', measurement.label,
            'kind', measurement.kind,
            'value', measurement.value::text,
            'unit', measurement.unit,
            'serviceCodes', to_jsonb(measurement.service_codes),
            'addOnCodes', to_jsonb(measurement.add_on_codes),
            'sourceAssetIds', to_jsonb(measurement.source_asset_ids),
            'confirmationNote', relation.confirmation_note,
            'confirmedBy', relation.confirmed_by,
            'confirmedAt', relation.confirmed_at
          )
          order by relation.confirmed_at
        )
        from public.scope_confirmed_measurements relation
        join public.scope_photo_requests request on request.id = relation.request_id
        join public.property_measurements measurement
          on measurement.id = relation.measurement_id
        where relation.company_id = p_company_id
          and request.property_id = p_property_id
      ), '[]'::jsonb)
    end,
    'serverTime', clock_timestamp()
  )
  into result;
  return result;
end;
$$;

revoke all on function public.load_scope_photo_context(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.load_scope_photo_context(uuid, uuid, uuid)
  to service_role;

create or replace function public.claim_scope_photo_orphans(
  p_company_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  if p_company_id is null
    or not exists (
      select 1
      from public.companies company
      where company.id = p_company_id
    )
    or p_limit not between 1 and 200
  then
    raise exception 'SCOPE_PHOTO_CLEANUP_LIMIT_INVALID';
  end if;

  update public.scope_photo_requests request
  set status = 'expired', updated_at = now()
  where request.company_id = p_company_id
    and request.status in ('open', 'submitted')
    and request.expires_at <= now();

  with candidates as (
    select reservation.id
    from public.scope_photo_upload_reservations reservation
    where reservation.company_id = p_company_id
      and (
        (
          reservation.status = 'prepared'
          and reservation.expires_at <= now()
        )
        or (
          reservation.status = 'cleanup_failed'
          and reservation.cleanup_attempts < 10
          and reservation.updated_at <= now() - interval '15 minutes'
        )
      )
    order by reservation.expires_at
    for update skip locked
    limit p_limit
  ),
  claimed as (
    update public.scope_photo_upload_reservations reservation
    set status = 'cleanup_claimed',
        cleanup_attempts = cleanup_attempts + 1,
        cleanup_claimed_at = now(),
        cleanup_error = null,
        updated_at = now()
    from candidates
    where reservation.id = candidates.id
    returning reservation.command_id, reservation.object_path
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'commandId', command_id,
      'companyId', p_company_id,
      'objectPath', object_path
    )),
    '[]'::jsonb
  )
  into result
  from claimed;
  return result;
end;
$$;

create or replace function public.complete_scope_photo_orphan_cleanup(
  p_command_id uuid,
  p_succeeded boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  update public.scope_photo_upload_reservations
  set status = case when p_succeeded then 'cleaned' else 'cleanup_failed' end,
      cleaned_at = case when p_succeeded then now() else null end,
      cleanup_error = case when p_succeeded then null else left(coalesce(p_error, 'unknown'), 500) end,
      updated_at = now()
  where command_id = p_command_id
    and status = 'cleanup_claimed';
  if not found then
    raise exception 'SCOPE_PHOTO_CLEANUP_CLAIM_NOT_FOUND';
  end if;
end;
$$;

revoke all on function public.claim_scope_photo_orphans(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.complete_scope_photo_orphan_cleanup(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.claim_scope_photo_orphans(uuid, integer)
  to service_role;
grant execute on function public.complete_scope_photo_orphan_cleanup(uuid, boolean, text)
  to service_role;

create or replace function public.protect_scope_media_asset()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.purpose <> 'scope' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE'
    and current_user = 'postgres'
    and current_setting('storyops.retention_purge', true) = 'on'
  then
    return old;
  end if;
  raise exception 'Scope media is immutable; corrections require a new content-addressed asset';
end;
$$;

create trigger scope_media_assets_immutable
  before update or delete on public.media_assets
  for each row execute function public.protect_scope_media_asset();

create trigger scope_photo_requests_timestamps
  before update on public.scope_photo_requests
  for each row execute function public.touch_record();
create trigger scope_photo_upload_reservations_timestamps
  before update on public.scope_photo_upload_reservations
  for each row execute function public.touch_record();

create trigger scope_photo_requests_audit
  after insert or update or delete on public.scope_photo_requests
  for each row execute function public.audit_mutation();
create trigger scope_photo_submissions_audit
  after insert or update or delete on public.scope_photo_submissions
  for each row execute function public.audit_mutation();
create trigger scope_photo_reviews_audit
  after insert or update or delete on public.scope_photo_reviews
  for each row execute function public.audit_mutation();
create trigger scope_confirmed_measurements_audit
  after insert or update or delete on public.scope_confirmed_measurements
  for each row execute function public.audit_mutation();

create trigger scope_photo_reviews_append_only
  before update or delete on public.scope_photo_reviews
  for each row execute function public.reject_append_only_mutation();
create trigger scope_confirmed_measurements_append_only
  before update or delete on public.scope_confirmed_measurements
  for each row execute function public.reject_append_only_mutation();

create or replace function public.protect_scope_photo_submission()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
    and old.analysis_id is null
    and new.analysis_id is not null
    and (
      to_jsonb(new) - 'analysis_id'
      = to_jsonb(old) - 'analysis_id'
    )
  then
    return new;
  end if;
  if tg_op = 'DELETE'
    and current_user = 'postgres'
    and current_setting('storyops.retention_purge', true) = 'on'
  then
    return old;
  end if;
  raise exception 'Scope-photo submissions are immutable after finalization';
end;
$$;

create trigger scope_photo_submissions_immutable
  before update or delete on public.scope_photo_submissions
  for each row execute function public.protect_scope_photo_submission();

create or replace function public.protect_confirmed_scope_measurement()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.source <> 'photo_assisted' or not old.verified_by_human then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE'
    and current_user = 'postgres'
    and current_setting('storyops.retention_purge', true) = 'on'
  then
    return old;
  end if;
  raise exception 'Confirmed photo-assisted measurements are immutable; append a superseding measurement';
end;
$$;

create trigger confirmed_scope_measurements_immutable
  before update or delete on public.property_measurements
  for each row execute function public.protect_confirmed_scope_measurement();

comment on table public.scope_photo_requests is
  'Customer-facing, bounded property photo checklist. It is evidence intake, never an estimate or price.';
comment on table public.scope_photo_upload_reservations is
  'Short-lived content-addressed upload reservations. Expired unregistered objects are claimed by the orphan cleanup worker.';
comment on table public.scope_photo_submissions is
  'Immutable link from a finalized private scope asset to its checklist request and optional advisory analysis.';
comment on table public.scope_confirmed_measurements is
  'Human attestation linking photo evidence to a separately created, billable-eligible property measurement.';
comment on function public.confirm_scope_photo_measurement(
  uuid, uuid, uuid, uuid, uuid[], text, text, numeric, text,
  text[], text[], text, text, text
) is
  'Finite back-office command: accepts no price fields and never promotes a model candidate without a human-entered measurement and classification.';
comment on function public.claim_scope_photo_orphans(uuid, integer) is
  'Claims exact-company expired, unregistered object paths for the private Storage cleanup worker. Registered media remains governed by retention and legal hold.';
