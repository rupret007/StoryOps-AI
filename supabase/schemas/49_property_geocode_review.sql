-- Durable live-provider geocode candidates with explicit human confirmation.
-- Coordinates are facts, not guesses: only a fresh Google Maps result confirmed
-- against the exact current address/version may update a service property.

create table public.property_geocode_candidates (
  id uuid primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  property_version integer not null check (property_version > 0),
  address_hash text not null check (address_hash ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider = 'google_maps'),
  provider_mode text not null check (provider_mode = 'live'),
  provider_place_id text,
  formatted_address text not null
    check (char_length(formatted_address) between 5 and 500),
  latitude numeric(10,7) not null check (latitude between -90 and 90),
  longitude numeric(10,7) not null check (longitude between -180 and 180),
  precision text not null
    check (precision in ('rooftop', 'parcel', 'street', 'city', 'unknown')),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'invalidated', 'expired')),
  operation_id uuid not null,
  requested_by uuid not null references auth.users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  evidence_hash text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  confirmed_by uuid references auth.users(id) on delete restrict,
  confirmed_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  check (expires_at > observed_at),
  check (
    (confirmed_by is null) = (confirmed_at is null)
    and (
      (status = 'confirmed' and confirmed_by is not null)
      or status in ('invalidated', 'expired')
      or (status = 'pending' and confirmed_by is null)
    )
  ),
  check (
    (status in ('invalidated', 'expired') and invalidated_at is not null)
    or (status in ('pending', 'confirmed') and invalidated_at is null)
  )
);

create index property_geocode_candidates_property_idx
  on public.property_geocode_candidates(
    company_id, property_id, requested_at desc
  );
create unique index property_geocode_candidates_operation_place_idx
  on public.property_geocode_candidates(
    company_id, operation_id, provider_place_id
  )
  where provider_place_id is not null;
create unique index property_geocode_candidates_one_confirmed_idx
  on public.property_geocode_candidates(company_id, property_id)
  where status = 'confirmed';

-- The only non-bootstrap path that may write property coordinates is the
-- confirmation RPC below. The authorization is bound to one backend,
-- transaction, actor, command, property version, and candidate, then consumed
-- by the property trigger exactly once.
create table private.property_geocode_write_authorizations (
  id uuid primary key default gen_random_uuid(),
  backend_pid integer not null,
  transaction_id bigint not null,
  company_id uuid not null references public.companies(id) on delete restrict,
  property_id uuid not null references public.properties(id) on delete restrict,
  candidate_id uuid not null
    references public.property_geocode_candidates(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  command_id uuid not null,
  expected_property_version integer not null
    check (expected_property_version > 0),
  consumed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (backend_pid, transaction_id, company_id, property_id),
  unique (company_id, command_id),
  check (consumed_at is null or consumed_at >= created_at)
);

revoke all on table private.property_geocode_write_authorizations
  from public, anon, authenticated, service_role;

alter table public.properties
  add column geocode_candidate_id uuid
    references public.property_geocode_candidates(id) on delete set null,
  add column geocode_provider text,
  add column geocode_precision text,
  add column geocode_address_hash text,
  add constraint properties_geocode_provenance_complete check (
    (
      latitude is null
      and longitude is null
      and geocode_confidence is null
      and geocoded_at is null
      and geocode_candidate_id is null
      and geocode_provider is null
      and geocode_precision is null
      and geocode_address_hash is null
    )
    or (
      latitude is not null
      and longitude is not null
      and geocode_confidence is not null
      and geocoded_at is not null
      and (
        (
          geocode_candidate_id is null
          and geocode_provider is null
          and geocode_precision is null
          and geocode_address_hash is null
        )
        or (
          geocode_candidate_id is not null
          and geocode_provider = 'google_maps'
          and geocode_precision in ('rooftop', 'parcel', 'street')
          and geocode_address_hash ~ '^[a-f0-9]{64}$'
        )
      )
    )
  );

create or replace function private.storyops_property_has_reviewed_geocode(
  p_company_id uuid,
  p_property_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select
    p_company_id is not null
    and p_property_id is not null
    and exists (
      select 1
      from public.properties property
      join public.property_geocode_candidates candidate
        on candidate.id = property.geocode_candidate_id
       and candidate.company_id = property.company_id
       and candidate.property_id = property.id
      where property.company_id = p_company_id
        and property.id = p_property_id
        and candidate.status = 'confirmed'
        and candidate.confirmed_by is not null
        and candidate.confirmed_at is not null
        and candidate.provider = 'google_maps'
        and candidate.provider_mode = 'live'
        and candidate.precision in ('rooftop', 'parcel', 'street')
        and candidate.confidence >= 0.8
        and candidate.address_hash
          = public.storyops_json_sha256(property.service_address)
        and property.geocode_address_hash = candidate.address_hash
        and property.geocode_provider = candidate.provider
        and property.geocode_precision = candidate.precision
        and property.latitude = candidate.latitude
        and property.longitude = candidate.longitude
        and property.geocode_confidence = candidate.confidence
        and property.geocoded_at = candidate.observed_at
        and candidate.evidence_hash = public.storyops_json_sha256(
          jsonb_build_object(
            'operationId', candidate.operation_id,
            'propertyId', candidate.property_id,
            'propertyVersion', candidate.property_version,
            'addressHash', candidate.address_hash,
            'candidate', jsonb_strip_nulls(jsonb_build_object(
              'id', candidate.id,
              'provider', candidate.provider,
              'mode', candidate.provider_mode,
              'formattedAddress', candidate.formatted_address,
              'latitude', candidate.latitude,
              'longitude', candidate.longitude,
              'precision', candidate.precision,
              'confidence', candidate.confidence,
              'providerPlaceId', candidate.provider_place_id,
              'observedAt', candidate.observed_at,
              'expiresAt', candidate.expires_at
            ))
          )
        )
    );
$$;

revoke all on function private.storyops_property_has_reviewed_geocode(
  uuid, uuid
) from public, anon, authenticated, service_role;

create or replace function public.enforce_storyops_live_receipt_geocode()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if new.evidence_mode = 'live'
    and not private.storyops_property_has_reviewed_geocode(
      new.company_id,
      new.property_id
    )
  then
    raise exception using message =
      'SCHEDULING_REVIEWED_LIVE_GEOCODE_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger scheduling_evidence_receipts_reviewed_geocode_guard
before insert or update on public.scheduling_evidence_receipts
for each row execute function public.enforce_storyops_live_receipt_geocode();

create or replace function public.enforce_storyops_confirmed_visit_geocode()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  property_id_value uuid;
begin
  if new.status <> 'confirmed'
    or (tg_op = 'UPDATE' and old.status = 'confirmed')
  then
    return new;
  end if;
  select job.property_id
  into property_id_value
  from public.jobs job
  where job.company_id = new.company_id
    and job.id = new.job_id;
  if property_id_value is null
    or not private.storyops_property_has_reviewed_geocode(
      new.company_id,
      property_id_value
    )
  then
    raise exception using message =
      'VISIT_REVIEWED_LIVE_GEOCODE_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger visits_reviewed_geocode_guard
before insert or update on public.visits
for each row execute function public.enforce_storyops_confirmed_visit_geocode();

create or replace function public.load_storyops_property_geocode_context(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_property_id uuid,
  p_expected_property_version integer,
  p_operation_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  property_row public.properties%rowtype;
  address_hash_value text;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id,
    p_actor_user_id,
    array['owner', 'dispatcher']
  );
  if p_property_id is null
    or p_expected_property_version < 1
    or p_operation_id is null
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception using message = 'PROPERTY_GEOCODE_CONTEXT_INVALID';
  end if;

  select *
  into property_row
  from public.properties property
  where property.id = p_property_id
    and property.company_id = p_company_id
    and property.version = p_expected_property_version;
  if not found then
    raise exception using message = 'PROPERTY_GEOCODE_PROPERTY_VERSION_CONFLICT';
  end if;
  address_hash_value := public.storyops_json_sha256(property_row.service_address);
  if property_row.geocode_candidate_id is not null
    and property_row.geocode_address_hash = address_hash_value
  then
    raise exception using message = 'PROPERTY_GEOCODE_ALREADY_CONFIRMED';
  end if;
  effective_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'schemaVersion', 'storyops-property-geocode-lookup-v1',
    'operationId', p_operation_id,
    'propertyId', p_property_id,
    'propertyVersion', p_expected_property_version
  ));
  if effective_request_hash <> p_request_hash then
    raise exception using message = 'PROPERTY_GEOCODE_REQUEST_HASH_MISMATCH';
  end if;

  select *
  into reservation
  from public.idempotency_keys idempotency
  where idempotency.company_id = p_company_id
    and idempotency.scope = 'property-geocode-lookup-v1'
    and idempotency.key = p_operation_id::text;
  if reservation.id is not null then
    if reservation.request_hash <> effective_request_hash then
      raise exception using message = 'PROPERTY_GEOCODE_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return jsonb_build_object(
        'replayed', true,
        'receipt', reservation.response
      );
    end if;
    raise exception using message = 'PROPERTY_GEOCODE_LOOKUP_IN_PROGRESS';
  end if;

  return jsonb_build_object(
    'replayed', false,
    'companyId', p_company_id,
    'propertyId', property_row.id,
    'propertyVersion', property_row.version,
    'serviceAddress', property_row.service_address,
    'addressHash', address_hash_value
  );
end;
$$;

create or replace function public.record_storyops_property_geocode_candidates(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_property_id uuid,
  p_expected_property_version integer,
  p_operation_id uuid,
  p_address_hash text,
  p_candidates jsonb,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions, auth
as $$
declare
  property_row public.properties%rowtype;
  candidate jsonb;
  candidate_id uuid;
  candidate_observed_at timestamptz;
  candidate_expires_at timestamptz;
  candidate_evidence_hash text;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  unexpected_key text;
  response_candidates jsonb;
  result jsonb;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id,
    p_actor_user_id,
    array['owner', 'dispatcher']
  );
  if p_property_id is null
    or p_expected_property_version < 1
    or p_operation_id is null
    or coalesce(p_address_hash, '') !~ '^[a-f0-9]{64}$'
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_candidates) <> 'array'
    or jsonb_array_length(p_candidates) not between 1 and 5
  then
    raise exception using message = 'PROPERTY_GEOCODE_CANDIDATES_INVALID';
  end if;
  effective_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'schemaVersion', 'storyops-property-geocode-lookup-v1',
    'operationId', p_operation_id,
    'propertyId', p_property_id,
    'propertyVersion', p_expected_property_version
  ));
  if effective_request_hash <> p_request_hash then
    raise exception using message = 'PROPERTY_GEOCODE_REQUEST_HASH_MISMATCH';
  end if;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'property-geocode-lookup-v1',
    p_operation_id::text,
    effective_request_hash,
    now() + interval '7 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;
  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys idempotency
    where idempotency.company_id = p_company_id
      and idempotency.scope = 'property-geocode-lookup-v1'
      and idempotency.key = p_operation_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception using message = 'PROPERTY_GEOCODE_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception using message = 'PROPERTY_GEOCODE_LOOKUP_IN_PROGRESS';
  end if;

  select *
  into property_row
  from public.properties property
  where property.id = p_property_id
    and property.company_id = p_company_id
    and property.version = p_expected_property_version
    and public.storyops_json_sha256(property.service_address) = p_address_hash
  for update;
  if not found then
    raise exception using message = 'PROPERTY_GEOCODE_PROPERTY_CHANGED';
  end if;
  if property_row.geocode_candidate_id is not null
    and property_row.geocode_address_hash = p_address_hash
  then
    raise exception using message = 'PROPERTY_GEOCODE_ALREADY_CONFIRMED';
  end if;
  if (
    select count(distinct existing.operation_id)
    from public.property_geocode_candidates existing
    where existing.company_id = p_company_id
      and existing.requested_by = p_actor_user_id
      and existing.requested_at >= now() - interval '1 minute'
  ) >= 5 then
    raise exception using message = 'PROPERTY_GEOCODE_RATE_LIMITED';
  end if;

  for candidate in
    select value from jsonb_array_elements(p_candidates)
  loop
    if jsonb_typeof(candidate) <> 'object' then
      raise exception using message = 'PROPERTY_GEOCODE_CANDIDATE_INVALID';
    end if;
    select key
    into unexpected_key
    from jsonb_object_keys(candidate) keys(key)
    where key not in (
      'id', 'provider', 'mode', 'formattedAddress', 'latitude', 'longitude',
      'precision', 'confidence', 'providerPlaceId', 'observedAt'
    )
    limit 1;
    if unexpected_key is not null
      or jsonb_typeof(candidate -> 'id') is distinct from 'string'
      or jsonb_typeof(candidate -> 'provider') is distinct from 'string'
      or jsonb_typeof(candidate -> 'mode') is distinct from 'string'
      or jsonb_typeof(candidate -> 'formattedAddress')
        is distinct from 'string'
      or jsonb_typeof(candidate -> 'precision') is distinct from 'string'
      or jsonb_typeof(candidate -> 'observedAt') is distinct from 'string'
      or (
        candidate ? 'providerPlaceId'
        and jsonb_typeof(candidate -> 'providerPlaceId')
          not in ('string', 'null')
      )
      or coalesce(candidate ->> 'id', '')
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or candidate ->> 'provider' <> 'google_maps'
      or candidate ->> 'mode' <> 'live'
      or char_length(btrim(coalesce(candidate ->> 'formattedAddress', '')))
        not between 5 and 500
      or jsonb_typeof(candidate -> 'latitude') <> 'number'
      or (candidate ->> 'latitude')::numeric not between -90 and 90
      or jsonb_typeof(candidate -> 'longitude') <> 'number'
      or (candidate ->> 'longitude')::numeric not between -180 and 180
      or candidate ->> 'precision'
        not in ('rooftop', 'parcel', 'street', 'city', 'unknown')
      or jsonb_typeof(candidate -> 'confidence') <> 'number'
      or (candidate ->> 'confidence')::numeric not between 0 and 1
      or char_length(coalesce(candidate ->> 'providerPlaceId', '')) > 300
      or coalesce(candidate ->> 'observedAt', '') = ''
    then
      raise exception using message = 'PROPERTY_GEOCODE_CANDIDATE_INVALID';
    end if;
    candidate_id := (candidate ->> 'id')::uuid;
    candidate_observed_at := (candidate ->> 'observedAt')::timestamptz;
    candidate_expires_at := candidate_observed_at + interval '24 hours';
    if candidate_observed_at < now() - interval '10 minutes'
      or candidate_observed_at > now() + interval '1 minute'
    then
      raise exception using message = 'PROPERTY_GEOCODE_CANDIDATE_STALE';
    end if;
    if exists (
      select 1
      from public.property_geocode_candidates existing
      where existing.id = candidate_id
    ) then
      raise exception using message = 'PROPERTY_GEOCODE_CANDIDATE_ID_CONFLICT';
    end if;
    candidate_evidence_hash := public.storyops_json_sha256(jsonb_build_object(
      'operationId', p_operation_id,
      'propertyId', p_property_id,
      'propertyVersion', p_expected_property_version,
      'addressHash', p_address_hash,
      'candidate', jsonb_strip_nulls(jsonb_build_object(
        'id', candidate_id,
        'provider', 'google_maps',
        'mode', 'live',
        'formattedAddress', btrim(candidate ->> 'formattedAddress'),
        'latitude', (candidate ->> 'latitude')::numeric(10,7),
        'longitude', (candidate ->> 'longitude')::numeric(10,7),
        'precision', candidate ->> 'precision',
        'confidence', (candidate ->> 'confidence')::numeric(5,4),
        'providerPlaceId', nullif(candidate ->> 'providerPlaceId', ''),
        'observedAt', candidate_observed_at,
        'expiresAt', candidate_expires_at
      ))
    ));
    insert into public.property_geocode_candidates(
      id, company_id, property_id, property_version, address_hash,
      provider, provider_mode, provider_place_id, formatted_address,
      latitude, longitude, precision, confidence, observed_at, expires_at,
      operation_id, requested_by, evidence_hash
    )
    values (
      candidate_id,
      p_company_id,
      p_property_id,
      p_expected_property_version,
      p_address_hash,
      'google_maps',
      'live',
      nullif(candidate ->> 'providerPlaceId', ''),
      btrim(candidate ->> 'formattedAddress'),
      (candidate ->> 'latitude')::numeric,
      (candidate ->> 'longitude')::numeric,
      candidate ->> 'precision',
      (candidate ->> 'confidence')::numeric,
      candidate_observed_at,
      candidate_expires_at,
      p_operation_id,
      p_actor_user_id,
      candidate_evidence_hash
    );
  end loop;

  update public.property_geocode_candidates
  set
    status = 'invalidated',
    invalidated_at = now(),
    invalidation_reason = 'superseded_by_new_lookup'
  where company_id = p_company_id
    and property_id = p_property_id
    and status = 'pending'
    and operation_id <> p_operation_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', geocode.id,
        'propertyId', geocode.property_id,
        'propertyVersion', geocode.property_version,
        'provider', geocode.provider,
        'mode', geocode.provider_mode,
        'formattedAddress', geocode.formatted_address,
        'latitude', geocode.latitude,
        'longitude', geocode.longitude,
        'precision', geocode.precision,
        'confidence', geocode.confidence,
        'providerPlaceId', geocode.provider_place_id,
        'observedAt', geocode.observed_at,
        'expiresAt', geocode.expires_at,
        'evidenceHash', geocode.evidence_hash
      )
      order by geocode.confidence desc, geocode.id
    ),
    '[]'::jsonb
  )
  into response_candidates
  from public.property_geocode_candidates geocode
  where geocode.company_id = p_company_id
    and geocode.operation_id = p_operation_id
    and geocode.status = 'pending';

  result := jsonb_build_object(
    'schemaVersion', 'storyops-property-geocode-candidates-v1',
    'operationId', p_operation_id,
    'companyId', p_company_id,
    'propertyId', p_property_id,
    'propertyVersion', p_expected_property_version,
    'addressHash', p_address_hash,
    'candidates', response_candidates,
    'requiresHumanConfirmation', true,
    'replayed', false,
    'serverTime', now()
  );
  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now()
  where id = reservation_id;
  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id
  )
  values (
    p_company_id,
    'provider',
    'google_maps',
    'property.geocode_candidates_recorded',
    'properties',
    p_property_id,
    jsonb_build_object(
      'operationId', p_operation_id,
      'propertyVersion', p_expected_property_version,
      'addressHash', p_address_hash,
      'candidateCount', jsonb_array_length(response_candidates),
      'requiresHumanConfirmation', true
    ),
    p_operation_id::text
  );
  return result;
exception
  when invalid_text_representation
    or invalid_datetime_format
    or datetime_field_overflow
    or numeric_value_out_of_range
  then
    raise exception using message = 'PROPERTY_GEOCODE_CANDIDATE_INVALID';
end;
$$;

create or replace function public.confirm_storyops_property_geocode_candidate(
  p_company_id uuid,
  p_command_id uuid,
  p_property_id uuid,
  p_expected_property_version integer,
  p_candidate_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions, auth
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  property_row public.properties%rowtype;
  candidate_row public.property_geocode_candidates%rowtype;
  authorization_id uuid;
  property_version_value integer;
  result jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
    or p_company_id is null
    or p_command_id is null
    or p_property_id is null
    or p_candidate_id is null
    or p_expected_property_version < 1
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception using message = 'PROPERTY_GEOCODE_CONFIRM_INVALID';
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
  if actor_role is null
    or actor_role not in ('owner', 'dispatcher')
  then
    raise exception using message = 'PROPERTY_GEOCODE_BACK_OFFICE_REQUIRED';
  end if;

  effective_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'action', 'property.geocode.confirm',
    'propertyId', p_property_id,
    'propertyVersion', p_expected_property_version,
    'candidateId', p_candidate_id
  ));
  if effective_request_hash <> p_request_hash then
    raise exception using message = 'PROPERTY_GEOCODE_CONFIRM_HASH_MISMATCH';
  end if;
  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'property-geocode-confirm-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;
  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys idempotency
    where idempotency.company_id = p_company_id
      and idempotency.scope = 'property-geocode-confirm-v1'
      and idempotency.key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception using message = 'PROPERTY_GEOCODE_CONFIRM_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception using message = 'PROPERTY_GEOCODE_CONFIRM_IN_PROGRESS';
  end if;

  select *
  into property_row
  from public.properties property
  where property.id = p_property_id
    and property.company_id = p_company_id
    and property.version = p_expected_property_version
  for update;
  if not found then
    raise exception using message = 'PROPERTY_GEOCODE_PROPERTY_VERSION_CONFLICT';
  end if;
  select *
  into candidate_row
  from public.property_geocode_candidates candidate
  where candidate.id = p_candidate_id
    and candidate.company_id = p_company_id
    and candidate.property_id = p_property_id
  for update;
  if not found
    or candidate_row.status <> 'pending'
    or candidate_row.provider <> 'google_maps'
    or candidate_row.provider_mode <> 'live'
    or candidate_row.expires_at <= now()
    or candidate_row.property_version <> property_row.version
    or candidate_row.address_hash
      <> public.storyops_json_sha256(property_row.service_address)
    or candidate_row.confidence < 0.8
    or candidate_row.precision not in ('rooftop', 'parcel', 'street')
    or candidate_row.evidence_hash <> public.storyops_json_sha256(
      jsonb_build_object(
        'operationId', candidate_row.operation_id,
        'propertyId', candidate_row.property_id,
        'propertyVersion', candidate_row.property_version,
        'addressHash', candidate_row.address_hash,
        'candidate', jsonb_strip_nulls(jsonb_build_object(
          'id', candidate_row.id,
          'provider', candidate_row.provider,
          'mode', candidate_row.provider_mode,
          'formattedAddress', candidate_row.formatted_address,
          'latitude', candidate_row.latitude,
          'longitude', candidate_row.longitude,
          'precision', candidate_row.precision,
          'confidence', candidate_row.confidence,
          'providerPlaceId', candidate_row.provider_place_id,
          'observedAt', candidate_row.observed_at,
          'expiresAt', candidate_row.expires_at
        ))
      )
    )
  then
    raise exception using message = 'PROPERTY_GEOCODE_LIVE_CANDIDATE_REQUIRED';
  end if;

  update public.property_geocode_candidates
  set
    status = 'invalidated',
    invalidated_at = now(),
    invalidation_reason = 'alternate_candidate_not_selected'
  where company_id = p_company_id
    and property_id = p_property_id
    and status = 'pending'
    and id <> p_candidate_id;
  update public.property_geocode_candidates
  set
    status = 'confirmed',
    confirmed_by = actor_user_id,
    confirmed_at = now()
  where id = p_candidate_id
    and company_id = p_company_id
    and status = 'pending';
  if not found then
    raise exception using message = 'PROPERTY_GEOCODE_CANDIDATE_CONFLICT';
  end if;

  insert into private.property_geocode_write_authorizations(
    backend_pid,
    transaction_id,
    company_id,
    property_id,
    candidate_id,
    actor_user_id,
    command_id,
    expected_property_version
  )
  values (
    pg_backend_pid(),
    txid_current()::bigint,
    p_company_id,
    p_property_id,
    p_candidate_id,
    actor_user_id,
    p_command_id,
    p_expected_property_version
  )
  returning id into authorization_id;

  update public.properties
  set
    latitude = candidate_row.latitude,
    longitude = candidate_row.longitude,
    geocode_confidence = candidate_row.confidence,
    geocoded_at = candidate_row.observed_at,
    geocode_candidate_id = candidate_row.id,
    geocode_provider = candidate_row.provider,
    geocode_precision = candidate_row.precision,
    geocode_address_hash = candidate_row.address_hash
  where id = p_property_id
    and company_id = p_company_id
    and version = p_expected_property_version
  returning version into property_version_value;
  if not found then
    raise exception using message = 'PROPERTY_GEOCODE_PROPERTY_VERSION_CONFLICT';
  end if;
  if not exists (
    select 1
    from private.property_geocode_write_authorizations write_auth
    where write_auth.id = authorization_id
      and write_auth.consumed_at is not null
  ) then
    raise exception using message =
      'PROPERTY_GEOCODE_WRITE_AUTHORIZATION_NOT_CONSUMED';
  end if;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-property-geocode-confirmation-v1',
    'commandId', p_command_id,
    'companyId', p_company_id,
    'propertyId', p_property_id,
    'propertyVersion', property_version_value,
    'candidateId', p_candidate_id,
    'provider', candidate_row.provider,
    'precision', candidate_row.precision,
    'confidence', candidate_row.confidence,
    'confirmedAt', now(),
    'requestHash', effective_request_hash,
    'replayed', false
  );
  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now()
  where id = reservation_id;
  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    before_data, after_data, request_id
  )
  values (
    p_company_id,
    'user',
    actor_user_id::text,
    'property.geocode_confirmed',
    'properties',
    p_property_id,
    jsonb_build_object(
      'propertyVersion', p_expected_property_version,
      'addressHash', candidate_row.address_hash
    ),
    result - array['companyId', 'requestHash']::text[],
    p_command_id::text
  );
  return result;
end;
$$;

create or replace function public.invalidate_storyops_property_geocode()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.service_address is distinct from old.service_address then
    new.latitude := null;
    new.longitude := null;
    new.geocode_confidence := null;
    new.geocoded_at := null;
    new.geocode_candidate_id := null;
    new.geocode_provider := null;
    new.geocode_precision := null;
    new.geocode_address_hash := null;
    update public.property_geocode_candidates
    set
      status = 'invalidated',
      invalidated_at = now(),
      invalidation_reason = 'service_address_changed'
    where company_id = old.company_id
      and property_id = old.id
      and status in ('pending', 'confirmed');
  end if;
  return new;
end;
$$;

create or replace function public.enforce_storyops_property_geocode_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  authorization_row private.property_geocode_write_authorizations%rowtype;
  candidate_row public.property_geocode_candidates%rowtype;
begin
  if tg_op = 'INSERT' then
    if new.latitude is null
      and new.longitude is null
      and new.geocode_confidence is null
      and new.geocoded_at is null
      and new.geocode_candidate_id is null
      and new.geocode_provider is null
      and new.geocode_precision is null
      and new.geocode_address_hash is null
    then
      return new;
    end if;
    -- Local seed/migration data runs as a trusted database owner with no JWT
    -- claim. Such legacy coordinates remain visibly unproven and are rejected
    -- by every live scheduling gate.
    if auth.role() is null
      and session_user in ('postgres', 'supabase_admin')
      and new.geocode_candidate_id is null
      and new.geocode_provider is null
      and new.geocode_precision is null
      and new.geocode_address_hash is null
    then
      return new;
    end if;
    raise exception using message =
      'PROPERTY_GEOCODE_REVIEWED_CANDIDATE_REQUIRED';
  end if;

  if new.service_address is distinct from old.service_address then
    if new.latitude is not null
      or new.longitude is not null
      or new.geocode_confidence is not null
      or new.geocoded_at is not null
      or new.geocode_candidate_id is not null
      or new.geocode_provider is not null
      or new.geocode_precision is not null
      or new.geocode_address_hash is not null
    then
      raise exception using message =
        'PROPERTY_GEOCODE_ADDRESS_CHANGE_MUST_INVALIDATE';
    end if;
    return new;
  end if;

  if row(
    new.latitude,
    new.longitude,
    new.geocode_confidence,
    new.geocoded_at,
    new.geocode_candidate_id,
    new.geocode_provider,
    new.geocode_precision,
    new.geocode_address_hash
  ) is not distinct from row(
    old.latitude,
    old.longitude,
    old.geocode_confidence,
    old.geocoded_at,
    old.geocode_candidate_id,
    old.geocode_provider,
    old.geocode_precision,
    old.geocode_address_hash
  ) then
    return new;
  end if;

  select *
  into authorization_row
  from private.property_geocode_write_authorizations write_auth
  where write_auth.backend_pid = pg_backend_pid()
    and write_auth.transaction_id = txid_current()::bigint
    and write_auth.company_id = new.company_id
    and write_auth.property_id = new.id
    and write_auth.candidate_id = new.geocode_candidate_id
    and write_auth.actor_user_id = auth.uid()
    and write_auth.expected_property_version = old.version
    and write_auth.consumed_at is null
  for update;
  if not found then
    raise exception using message =
      'PROPERTY_GEOCODE_WRITE_AUTHORIZATION_REQUIRED';
  end if;

  select *
  into candidate_row
  from public.property_geocode_candidates candidate
  where candidate.id = authorization_row.candidate_id
    and candidate.company_id = authorization_row.company_id
    and candidate.property_id = authorization_row.property_id
    and candidate.status = 'confirmed'
    and candidate.confirmed_by = authorization_row.actor_user_id;
  if not found
    or new.geocode_candidate_id is distinct from candidate_row.id
    or new.latitude is distinct from candidate_row.latitude
    or new.longitude is distinct from candidate_row.longitude
    or new.geocode_confidence is distinct from candidate_row.confidence
    or new.geocoded_at is distinct from candidate_row.observed_at
    or new.geocode_provider is distinct from candidate_row.provider
    or new.geocode_precision is distinct from candidate_row.precision
    or new.geocode_address_hash is distinct from candidate_row.address_hash
    or candidate_row.address_hash
      <> public.storyops_json_sha256(new.service_address)
    or candidate_row.evidence_hash <> public.storyops_json_sha256(
      jsonb_build_object(
        'operationId', candidate_row.operation_id,
        'propertyId', candidate_row.property_id,
        'propertyVersion', candidate_row.property_version,
        'addressHash', candidate_row.address_hash,
        'candidate', jsonb_strip_nulls(jsonb_build_object(
          'id', candidate_row.id,
          'provider', candidate_row.provider,
          'mode', candidate_row.provider_mode,
          'formattedAddress', candidate_row.formatted_address,
          'latitude', candidate_row.latitude,
          'longitude', candidate_row.longitude,
          'precision', candidate_row.precision,
          'confidence', candidate_row.confidence,
          'providerPlaceId', candidate_row.provider_place_id,
          'observedAt', candidate_row.observed_at,
          'expiresAt', candidate_row.expires_at
        ))
      )
    )
  then
    raise exception using message =
      'PROPERTY_GEOCODE_WRITE_AUTHORIZATION_BINDING_MISMATCH';
  end if;

  update private.property_geocode_write_authorizations write_auth
  set consumed_at = statement_timestamp()
  where write_auth.id = authorization_row.id
    and write_auth.consumed_at is null;
  if not found then
    raise exception using message =
      'PROPERTY_GEOCODE_WRITE_AUTHORIZATION_ALREADY_CONSUMED';
  end if;
  return new;
end;
$$;

create trigger properties_geocode_address_invalidation
before update of service_address on public.properties
for each row execute function public.invalidate_storyops_property_geocode();

create trigger properties_geocode_coordinate_write_guard
before insert or update on public.properties
for each row execute function public.enforce_storyops_property_geocode_write();

alter table public.property_geocode_candidates enable row level security;
alter table public.property_geocode_candidates force row level security;
revoke all on table public.property_geocode_candidates
  from public, anon, authenticated, service_role;
grant select on table public.property_geocode_candidates to authenticated;
create policy property_geocode_candidates_back_office_select
  on public.property_geocode_candidates
  for select
  to authenticated
  using (
    public.has_company_role(
      company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
  );

revoke all on function public.load_storyops_property_geocode_context(
  uuid, uuid, uuid, integer, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_property_geocode_context(
  uuid, uuid, uuid, integer, uuid, text
) to service_role;
revoke all on function public.record_storyops_property_geocode_candidates(
  uuid, uuid, uuid, integer, uuid, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_storyops_property_geocode_candidates(
  uuid, uuid, uuid, integer, uuid, text, jsonb, text
) to service_role;
revoke all on function public.confirm_storyops_property_geocode_candidate(
  uuid, uuid, uuid, integer, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.confirm_storyops_property_geocode_candidate(
  uuid, uuid, uuid, integer, uuid, text
) to authenticated;
revoke all on function public.invalidate_storyops_property_geocode()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_storyops_property_geocode_write()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_storyops_live_receipt_geocode()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_storyops_confirmed_visit_geocode()
  from public, anon, authenticated, service_role;

comment on table public.property_geocode_candidates is
  'Bounded immutable live Google Maps candidates; an owner/dispatcher must explicitly confirm one before coordinates become scheduling facts.';
comment on function public.confirm_storyops_property_geocode_candidate(
  uuid, uuid, uuid, integer, uuid, text
) is
  'Atomically confirms one fresh, high-confidence candidate against the exact current property address and invalidates alternatives.';
