-- Current-origin dispatch actor and location-privacy hardening.
--
-- Exact device coordinates are operational input, not durable business data.
-- Keep them only until the two-minute departure receipt expires, while the
-- immutable receipt retains the consent envelope, observation metadata, and
-- SHA-256 binding needed to prove what was used. The durable VROOM request
-- keeps the same origin hash and route outcome, but never the coordinates.

create unlogged table private.dispatch_current_origin_ephemera (
  route_check_id uuid primary key
    references public.route_checks(id)
    on delete restrict
    deferrable initially deferred,
  receipt_id uuid unique
    references public.dispatch_clearance_receipts(id)
    on delete restrict
    deferrable initially deferred,
  company_id uuid not null,
  visit_id uuid not null,
  actor_user_id uuid,
  coordinates jsonb not null,
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  purge_after timestamptz not null,
  retention_policy text not null
    default 'storyops-dispatch-current-origin-ephemeral-v1'
    check (
      retention_policy =
        'storyops-dispatch-current-origin-ephemeral-v1'
    ),
  created_at timestamptz not null default statement_timestamp(),
  constraint dispatch_current_origin_ephemera_coordinates_check check (
    jsonb_typeof(coordinates) = 'object'
    and coordinates ?& array['latitude', 'longitude']::text[]
    and coordinates - array['latitude', 'longitude']::text[] = '{}'::jsonb
    and jsonb_typeof(coordinates -> 'latitude') = 'number'
    and jsonb_typeof(coordinates -> 'longitude') = 'number'
    and (coordinates ->> 'latitude')::numeric between -90 and 90
    and (coordinates ->> 'longitude')::numeric between -180 and 180
  ),
  constraint dispatch_current_origin_ephemera_retention_check check (
    isfinite(observed_at)
    and expires_at = observed_at + interval '2 minutes'
    and purge_after = expires_at
  )
);

create index dispatch_current_origin_ephemera_purge_idx
  on private.dispatch_current_origin_ephemera(purge_after, route_check_id);

create unlogged table private.dispatch_current_origin_verifiers (
  route_check_id uuid primary key
    references public.route_checks(id)
    on delete restrict
    deferrable initially deferred,
  receipt_id uuid unique
    references public.dispatch_clearance_receipts(id)
    on delete restrict
    deferrable initially deferred,
  company_id uuid not null,
  visit_id uuid not null,
  actor_user_id uuid,
  verifier_key bytea not null check (octet_length(verifier_key) = 32),
  source_origin_sha256 text not null
    check (source_origin_sha256 ~ '^[a-f0-9]{64}$'),
  source_request_sha256 text
    check (
      source_request_sha256 is null
      or source_request_sha256 ~ '^[a-f0-9]{64}$'
    ),
  origin_mac text not null check (origin_mac ~ '^[a-f0-9]{64}$'),
  request_mac text check (
    request_mac is null
    or request_mac ~ '^[a-f0-9]{64}$'
  ),
  purge_after timestamptz not null,
  retention_policy text not null
    default 'storyops-dispatch-origin-verifier-v1'
    check (retention_policy = 'storyops-dispatch-origin-verifier-v1'),
  created_at timestamptz not null default statement_timestamp()
);

create index dispatch_current_origin_verifiers_purge_idx
  on private.dispatch_current_origin_verifiers(purge_after, route_check_id);

revoke all on table private.dispatch_current_origin_ephemera
  from public, anon, authenticated, service_role;
revoke all on table private.dispatch_current_origin_verifiers
  from public, anon, authenticated, service_role;

comment on table private.dispatch_current_origin_ephemera is
  'Reviewed API/logical-row minimization boundary: exact consented departure coordinates are UNLOGGED, exist only until the two-minute dispatch-origin expiry, are never directly readable by API roles, and are then eligible for bounded automatic purge. UNLOGGED avoids WAL/PITR replication but is not cryptographic erasure of local MVCC pages or host snapshots; provider and legal review remain required.';
comment on column private.dispatch_current_origin_ephemera.purge_after is
  'Logical-row deletion deadline equal to operational expiry; no legal-hold or general-retention extension applies. Local MVCC/storage remnants are a documented residual V1 limit, not a hard-erasure guarantee.';
comment on table private.dispatch_current_origin_verifiers is
  'UNLOGGED, non-exported random HMAC keys and source digests retained for at most 24 hours to verify dispatch idempotency without making API-visible coordinate hashes dictionary-testable; this table never stores coordinates and fails closed after database restart.';

-- Generic audit records must never become a seven-year location store.
create or replace function public.redact_audit_payload(
  source_table text,
  source_data jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public, extensions
as $$
declare
  redacted jsonb := source_data;
  sensitive_fields text[] := case source_table
    when 'customers' then array[
      'email', 'phone', 'billing_address', 'notes', 'tax_exemption_reference'
    ]
    when 'properties' then array[
      'service_address', 'access_instructions', 'gate_code_ciphertext',
      'water_source_notes', 'drainage_notes'
    ]
    when 'consent_records' then array['proof']
    when 'communication_messages' then array['sender', 'recipients', 'body']
    when 'integration_connections' then array[
      'configuration', 'secret_reference', 'last_error'
    ]
    when 'approval_requests' then array['action_payload']
    when 'incidents' then array['summary', 'immediate_actions']
    when 'provider_customers' then array['email_snapshot']
    when 'dispatch_clearance_receipts' then array['current_origin']
    when 'route_checks' then array['request_payload']
    else array[]::text[]
  end;
  field_name text;
  removed_fields text[] := array[]::text[];
begin
  if source_data is null then
    return null;
  end if;
  foreach field_name in array sensitive_fields
  loop
    if redacted ? field_name then
      redacted := redacted - field_name;
      removed_fields := array_append(removed_fields, field_name);
    end if;
  end loop;
  if cardinality(removed_fields) > 0 then
    redacted := redacted || case
      when source_table in (
        'dispatch_clearance_receipts',
        'route_checks'
      ) then jsonb_build_object(
        '_redacted_fields',
        to_jsonb(removed_fields)
      )
      else jsonb_build_object(
        '_redacted_fields',
        to_jsonb(removed_fields),
        '_source_sha256',
        encode(extensions.digest(source_data::text, 'sha256'), 'hex')
      )
    end;
  end if;
  return redacted;
end;
$$;

-- Re-key any pre-hardening receipt with a random private HMAC key. Only
-- still-live coordinates enter the ephemeral table; expired coordinates are
-- deliberately discarded rather than migrated.
create temporary table dispatch_origin_migration_bindings
on commit drop
as
select
  receipt.id as receipt_id,
  receipt.route_check_id,
  receipt.company_id,
  receipt.visit_id,
  receipt.created_by as actor_user_id,
  receipt.current_origin,
  receipt.current_origin_hash as source_origin_sha256,
  receipt.request_hash as source_request_sha256,
  secret.verifier_key,
  encode(
    extensions.hmac(
      convert_to(
        jsonb_build_object(
          'coordinates', receipt.current_origin -> 'coordinates',
          'sourceSha256', receipt.current_origin_hash
        )::text,
        'UTF8'
      ),
      secret.verifier_key,
      'sha256'
    ),
    'hex'
  ) as origin_mac,
  encode(
    extensions.hmac(
      convert_to(receipt.request_hash, 'UTF8'),
      secret.verifier_key,
      'sha256'
    ),
    'hex'
  ) as request_mac,
  (receipt.current_origin ->> 'observedAt')::timestamptz as observed_at,
  receipt.current_origin_expires_at
from public.dispatch_clearance_receipts receipt
cross join lateral (
  select extensions.gen_random_bytes(32) as verifier_key
) secret
where receipt.schema_version = 'storyops-dispatch-clearance-v2';

insert into private.dispatch_current_origin_ephemera(
  route_check_id,
  receipt_id,
  company_id,
  visit_id,
  actor_user_id,
  coordinates,
  observed_at,
  expires_at,
  purge_after
)
select
  binding.route_check_id,
  binding.receipt_id,
  binding.company_id,
  binding.visit_id,
  binding.actor_user_id,
  binding.current_origin -> 'coordinates',
  binding.observed_at,
  binding.current_origin_expires_at,
  binding.current_origin_expires_at
from dispatch_origin_migration_bindings binding
where binding.current_origin_expires_at > statement_timestamp()
  and jsonb_typeof(binding.current_origin -> 'coordinates') = 'object';

insert into private.dispatch_current_origin_verifiers(
  route_check_id,
  receipt_id,
  company_id,
  visit_id,
  actor_user_id,
  verifier_key,
  source_origin_sha256,
  source_request_sha256,
  origin_mac,
  request_mac,
  purge_after
)
select
  binding.route_check_id,
  binding.receipt_id,
  binding.company_id,
  binding.visit_id,
  binding.actor_user_id,
  binding.verifier_key,
  binding.source_origin_sha256,
  binding.source_request_sha256,
  binding.origin_mac,
  binding.request_mac,
  statement_timestamp() + interval '24 hours'
from dispatch_origin_migration_bindings binding
where binding.current_origin_expires_at > statement_timestamp();

alter table public.dispatch_clearance_receipts
  drop constraint dispatch_clearance_receipts_current_origin_check;

alter table public.route_checks
  disable trigger route_checks_scheduling_evidence_immutable;
alter table public.route_checks disable trigger route_checks_audit;
alter table public.dispatch_clearance_receipts
  disable trigger dispatch_clearance_receipts_immutable;
alter table public.dispatch_clearance_receipts
  disable trigger dispatch_clearance_receipts_audit;

update public.route_checks route
set request_payload = jsonb_set(
  jsonb_set(
    route.request_payload,
    '{origin}',
    jsonb_build_object(
      'redacted', true,
      'retentionPolicy',
        'storyops-dispatch-current-origin-ephemeral-v1'
    ),
    false
  ),
  '{currentOriginHash}',
  to_jsonb(binding.origin_mac),
  false
)
from dispatch_origin_migration_bindings binding
where route.id = binding.route_check_id
  and route.request_payload ->> 'schemaVersion'
    = 'storyops-dispatch-route-request-v2';

update public.dispatch_clearance_receipts receipt
set
  current_origin = receipt.current_origin - 'coordinates',
  current_origin_hash = binding.origin_mac,
  request_hash = binding.request_mac,
  route_request_hash = public.storyops_json_sha256(route.request_payload),
  evidence_hash = repeat('0', 64)
from public.route_checks route
join dispatch_origin_migration_bindings binding
  on binding.route_check_id = route.id
where receipt.schema_version = 'storyops-dispatch-clearance-v2'
  and route.id = receipt.route_check_id
  and binding.receipt_id = receipt.id;

update public.dispatch_clearance_receipts receipt
set evidence_hash = public.storyops_dispatch_clearance_hash(receipt)
where receipt.schema_version = 'storyops-dispatch-clearance-v2';

alter table public.dispatch_clearance_receipts
  enable trigger dispatch_clearance_receipts_audit;
alter table public.dispatch_clearance_receipts
  enable trigger dispatch_clearance_receipts_immutable;
alter table public.route_checks enable trigger route_checks_audit;
alter table public.route_checks
  enable trigger route_checks_scheduling_evidence_immutable;

alter table public.dispatch_clearance_receipts
  add constraint dispatch_clearance_receipts_current_origin_check
  check (
    (
      (
        schema_version = 'storyops-dispatch-clearance-v1'
        and current_origin is null
        and current_origin_hash is null
        and current_origin_expires_at is null
      )
      or (
        schema_version = 'storyops-dispatch-clearance-v2'
        and jsonb_typeof(current_origin) = 'object'
        and current_origin ?& array[
          'schemaVersion', 'readingId', 'source',
          'observedAt', 'accuracyMeters', 'consent'
        ]::text[]
        and current_origin - array[
          'schemaVersion', 'readingId', 'source',
          'observedAt', 'accuracyMeters', 'consent'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof(current_origin -> 'schemaVersion') = 'string'
        and jsonb_typeof(current_origin -> 'readingId') = 'string'
        and jsonb_typeof(current_origin -> 'source') = 'string'
        and jsonb_typeof(current_origin -> 'observedAt') = 'string'
        and jsonb_typeof(current_origin -> 'accuracyMeters') = 'number'
        and jsonb_typeof(current_origin -> 'consent') = 'object'
        and (current_origin -> 'consent') ?& array[
          'kind', 'disclosureVersion', 'capturedAt'
        ]::text[]
        and (current_origin -> 'consent') - array[
          'kind', 'disclosureVersion', 'capturedAt'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof(current_origin #> '{consent,kind}') = 'string'
        and jsonb_typeof(
          current_origin #> '{consent,disclosureVersion}'
        ) = 'string'
        and jsonb_typeof(current_origin #> '{consent,capturedAt}') = 'string'
        and current_origin ->> 'schemaVersion'
          = 'storyops-dispatch-current-origin-v1'
        and current_origin ->> 'source' = 'device_geolocation'
        and (current_origin ->> 'readingId')::uuid is not null
        and (current_origin ->> 'accuracyMeters')::numeric
          between 0 and 100
        and isfinite((current_origin ->> 'observedAt')::timestamptz)
        and current_origin #>> '{consent,kind}' = 'explicit_user_action'
        and current_origin #>> '{consent,disclosureVersion}'
          = 'storyops-dispatch-origin-consent-v1'
        and isfinite(
          (current_origin #>> '{consent,capturedAt}')::timestamptz
        )
        and current_origin_hash is not null
        and current_origin_expires_at
          = (current_origin ->> 'observedAt')::timestamptz
            + interval '2 minutes'
        and expires_at <= current_origin_expires_at
      )
    ) is true
  );

-- Scrub the two historical generic-audit shapes while the append-only guard is
-- deliberately suspended inside this migration transaction.
alter table public.audit_events disable trigger audit_events_append_only;
update public.audit_events event
set
  before_data = public.redact_audit_payload(
    event.entity_type,
    event.before_data
  ),
  after_data = public.redact_audit_payload(
    event.entity_type,
    event.after_data
  )
where event.entity_type in (
  'dispatch_clearance_receipts',
  'route_checks'
);
update public.audit_events event
set
  before_data = case
    when event.before_data ? 'currentOriginHash'
      then event.before_data - 'currentOriginHash'
    else event.before_data
  end,
  after_data = case
    when event.after_data ? 'currentOriginHash'
      then event.after_data - 'currentOriginHash'
    else event.after_data
  end
where event.action = 'visit.dispatch_clearance_refreshed';
alter table public.audit_events enable trigger audit_events_append_only;

create or replace function private.storyops_redact_dispatch_origin_audit_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.entity_type in (
      'dispatch_clearance_receipts',
      'route_checks'
    )
  then
    new.before_data := public.redact_audit_payload(
      new.entity_type,
      new.before_data
    );
    new.after_data := public.redact_audit_payload(
      new.entity_type,
      new.after_data
    );
  end if;
  if new.action = 'visit.dispatch_clearance_refreshed' then
    new.before_data := new.before_data - 'currentOriginHash';
    new.after_data := new.after_data - 'currentOriginHash';
  end if;
  return new;
end;
$$;

create trigger audit_events_00_dispatch_origin_redaction
before insert on public.audit_events
for each row execute function
  private.storyops_redact_dispatch_origin_audit_event();

create or replace function private.storyops_redact_dispatch_route_origin()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  origin_data jsonb;
  source_origin_sha256_value text;
  verifier_key_value bytea;
  origin_mac_value text;
  visit_id_value uuid;
begin
  if new.request_payload ->> 'schemaVersion'
    is distinct from 'storyops-dispatch-route-request-v2'
  then
    return new;
  end if;

  origin_data := new.request_payload -> 'origin';
  source_origin_sha256_value :=
    new.request_payload ->> 'currentOriginHash';
  if jsonb_typeof(origin_data) <> 'object'
    or not (origin_data ?& array['latitude', 'longitude']::text[])
    or origin_data - array['latitude', 'longitude']::text[] <> '{}'::jsonb
    or jsonb_typeof(origin_data -> 'latitude') <> 'number'
    or jsonb_typeof(origin_data -> 'longitude') <> 'number'
    or (origin_data ->> 'latitude')::numeric not between -90 and 90
    or (origin_data ->> 'longitude')::numeric not between -180 and 180
    or coalesce(source_origin_sha256_value, '') !~ '^[a-f0-9]{64}$'
    or coalesce(new.request_payload ->> 'visitId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or new.id is null
    or new.company_id is null
    or new.checked_at is null
    or not isfinite(new.checked_at)
  then
    raise exception 'DISPATCH_CURRENT_ORIGIN_ROUTE_INVALID';
  end if;

  visit_id_value := (new.request_payload ->> 'visitId')::uuid;
  verifier_key_value := extensions.gen_random_bytes(32);
  origin_mac_value := encode(
    extensions.hmac(
      convert_to(
        jsonb_build_object(
          'coordinates', origin_data,
          'sourceSha256', source_origin_sha256_value
        )::text,
        'UTF8'
      ),
      verifier_key_value,
      'sha256'
    ),
    'hex'
  );

  insert into private.dispatch_current_origin_verifiers(
    route_check_id,
    company_id,
    visit_id,
    verifier_key,
    source_origin_sha256,
    origin_mac,
    purge_after
  )
  values (
    new.id,
    new.company_id,
    visit_id_value,
    verifier_key_value,
    source_origin_sha256_value,
    origin_mac_value,
    statement_timestamp() + interval '24 hours'
  );

  insert into private.dispatch_current_origin_ephemera(
    route_check_id,
    company_id,
    visit_id,
    coordinates,
    observed_at,
    expires_at,
    purge_after
  )
  values (
    new.id,
    new.company_id,
    visit_id_value,
    origin_data,
    new.checked_at,
    new.checked_at + interval '2 minutes',
    new.checked_at + interval '2 minutes'
  );

  new.request_payload := jsonb_set(
    jsonb_set(
      new.request_payload,
      '{origin}',
      jsonb_build_object(
        'redacted', true,
        'retentionPolicy',
          'storyops-dispatch-current-origin-ephemeral-v1'
      ),
      false
    ),
    '{currentOriginHash}',
    to_jsonb(origin_mac_value),
    false
  );
  return new;
end;
$$;

create trigger route_checks_00_redact_dispatch_origin
before insert on public.route_checks
for each row execute function
  private.storyops_redact_dispatch_route_origin();

create or replace function private.storyops_capture_dispatch_current_origin()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  full_origin jsonb;
  route_row public.route_checks%rowtype;
  ephemera_row private.dispatch_current_origin_ephemera%rowtype;
  verifier_row private.dispatch_current_origin_verifiers%rowtype;
  request_mac_value text;
begin
  if new.schema_version <> 'storyops-dispatch-clearance-v2' then
    return new;
  end if;

  full_origin := new.current_origin;
  if jsonb_typeof(full_origin) <> 'object'
    or jsonb_typeof(full_origin -> 'coordinates') <> 'object'
    or not (
      (full_origin -> 'coordinates')
        ?& array['latitude', 'longitude']::text[]
    )
    or (full_origin -> 'coordinates')
      - array['latitude', 'longitude']::text[] <> '{}'::jsonb
    or jsonb_typeof(full_origin #> '{coordinates,latitude}') <> 'number'
    or jsonb_typeof(full_origin #> '{coordinates,longitude}') <> 'number'
    or (full_origin #>> '{coordinates,latitude}')::numeric
      not between -90 and 90
    or (full_origin #>> '{coordinates,longitude}')::numeric
      not between -180 and 180
  then
    raise exception 'DISPATCH_CURRENT_ORIGIN_EPHEMERAL_CAPTURE_REQUIRED';
  end if;

  select * into route_row
  from public.route_checks route
  where route.company_id = new.company_id
    and route.id = new.route_check_id;
  select * into ephemera_row
  from private.dispatch_current_origin_ephemera ephemera
  where ephemera.route_check_id = new.route_check_id;
  select * into verifier_row
  from private.dispatch_current_origin_verifiers verifier
  where verifier.route_check_id = new.route_check_id;
  if route_row.id is null
    or ephemera_row.route_check_id is null
    or verifier_row.route_check_id is null
    or ephemera_row.company_id <> new.company_id
    or ephemera_row.visit_id <> new.visit_id
    or verifier_row.company_id <> new.company_id
    or verifier_row.visit_id <> new.visit_id
    or ephemera_row.coordinates
      is distinct from full_origin -> 'coordinates'
    or public.storyops_json_sha256(full_origin)
      <> verifier_row.source_origin_sha256
    or new.current_origin_hash
      <> verifier_row.source_origin_sha256
    or route_row.request_payload ->> 'schemaVersion'
      <> 'storyops-dispatch-route-request-v2'
    or route_row.request_payload ->> 'currentOriginHash'
      <> verifier_row.origin_mac
    or route_row.request_payload -> 'origin' is distinct from jsonb_build_object(
      'redacted', true,
      'retentionPolicy',
        'storyops-dispatch-current-origin-ephemeral-v1'
    )
  then
    raise exception 'DISPATCH_CURRENT_ORIGIN_ROUTE_BINDING_INVALID';
  end if;

  request_mac_value := encode(
    extensions.hmac(
      convert_to(new.request_hash, 'UTF8'),
      verifier_row.verifier_key,
      'sha256'
    ),
    'hex'
  );
  perform set_config(
    'storyops.dispatch_current_origin_capture',
    'on',
    true
  );
  update private.dispatch_current_origin_verifiers verifier
  set
    receipt_id = new.id,
    actor_user_id = new.created_by,
    source_request_sha256 = new.request_hash,
    request_mac = request_mac_value
  where verifier.route_check_id = new.route_check_id;
  update private.dispatch_current_origin_ephemera ephemera
  set
    receipt_id = new.id,
    actor_user_id = new.created_by,
    observed_at = (full_origin ->> 'observedAt')::timestamptz,
    expires_at = new.current_origin_expires_at,
    purge_after = new.current_origin_expires_at
  where ephemera.route_check_id = new.route_check_id;

  new.current_origin := full_origin - 'coordinates';
  new.current_origin_hash := verifier_row.origin_mac;
  new.request_hash := request_mac_value;
  new.route_request_hash :=
    public.storyops_json_sha256(route_row.request_payload);
  if new.current_origin_expires_at <= statement_timestamp() then
    perform set_config(
      'storyops.dispatch_current_origin_purge',
      'on',
      true
    );
    delete from private.dispatch_current_origin_ephemera ephemera
    where ephemera.route_check_id = new.route_check_id;
  end if;
  return new;
end;
$$;

create trigger dispatch_clearance_receipts_00_ephemeral_origin
before insert on public.dispatch_clearance_receipts
for each row execute function
  private.storyops_capture_dispatch_current_origin();

create or replace function private.storyops_dispatch_current_origin_payload(
  p_receipt_id uuid
)
returns jsonb
language sql
security definer
stable
set search_path = pg_catalog, public, private, extensions
as $$
  select case
    when ephemera.receipt_id is not null
      and receipt.expires_at > statement_timestamp()
      and ephemera.expires_at > statement_timestamp()
      and ephemera.purge_after > statement_timestamp()
      and ephemera.company_id = receipt.company_id
      and ephemera.visit_id = receipt.visit_id
      and ephemera.actor_user_id = receipt.created_by
      and verifier.receipt_id = receipt.id
      and verifier.company_id = receipt.company_id
      and verifier.visit_id = receipt.visit_id
      and verifier.actor_user_id = receipt.created_by
      and verifier.origin_mac = receipt.current_origin_hash
      and public.storyops_json_sha256(
        receipt.current_origin || jsonb_build_object(
          'coordinates', ephemera.coordinates
        )
      ) = verifier.source_origin_sha256
      and encode(
        extensions.hmac(
          convert_to(
            jsonb_build_object(
              'coordinates', ephemera.coordinates,
              'sourceSha256', verifier.source_origin_sha256
            )::text,
            'UTF8'
          ),
          verifier.verifier_key,
          'sha256'
        ),
        'hex'
      ) = receipt.current_origin_hash
    then receipt.current_origin || jsonb_build_object(
      'coordinates', ephemera.coordinates
    )
    else receipt.current_origin
  end
  from public.dispatch_clearance_receipts receipt
  left join private.dispatch_current_origin_ephemera ephemera
    on ephemera.receipt_id = receipt.id
  left join private.dispatch_current_origin_verifiers verifier
    on verifier.receipt_id = receipt.id
  where receipt.id = p_receipt_id
$$;

create or replace function public.storyops_dispatch_clearance_receipt_json(
  p_receipt public.dispatch_clearance_receipts,
  p_replayed boolean default false
)
returns jsonb
language sql
security definer
stable
strict
set search_path = pg_catalog, public, private
as $$
  select jsonb_build_object(
    'schemaVersion', p_receipt.schema_version,
    'receiptId', p_receipt.id,
    'companyId', p_receipt.company_id,
    'visitId', p_receipt.visit_id,
    'visitVersion', p_receipt.visit_version,
    'jobId', p_receipt.job_id,
    'jobVersion', p_receipt.job_version,
    'propertyId', p_receipt.property_id,
    'propertyVersion', p_receipt.property_version,
    'crewId', p_receipt.crew_id,
    'crewVersion', p_receipt.crew_version,
    'startsAt', p_receipt.starts_at,
    'endsAt', p_receipt.ends_at,
    'evidenceMode', p_receipt.evidence_mode,
    'configurationRevision', p_receipt.configuration_revision,
    'configurationHash', p_receipt.configuration_hash,
    'operatingBaselinePublicationId',
      p_receipt.operating_baseline_publication_id,
    'operatingBaselineHash', p_receipt.operating_baseline_hash,
    'schedulingEvidenceReceiptId', p_receipt.scheduling_evidence_receipt_id,
    'providerSnapshotHash', p_receipt.provider_snapshot_hash,
    'currentOrigin',
      private.storyops_dispatch_current_origin_payload(p_receipt.id),
    'currentOriginHash', p_receipt.current_origin_hash,
    'currentOriginExpiresAt', p_receipt.current_origin_expires_at,
    'routeCheckId', p_receipt.route_check_id,
    'routeDisposition', p_receipt.route_disposition,
    'routeObservedAt', p_receipt.route_observed_at,
    'routeExpiresAt', p_receipt.route_expires_at,
    'weatherCheckId', p_receipt.weather_check_id,
    'weatherDisposition', p_receipt.weather_disposition,
    'weatherObservedAt', p_receipt.weather_observed_at,
    'weatherExpiresAt', p_receipt.weather_expires_at,
    'unknowns', to_jsonb(p_receipt.unknowns),
    'conflicts', p_receipt.conflicts,
    'expiresAt', p_receipt.expires_at,
    'evidenceHash', p_receipt.evidence_hash,
    'requestHash', p_receipt.request_hash,
    'createdAt', p_receipt.created_at,
    'replayed', p_replayed
  )
$$;

create or replace function private.storyops_dispatch_current_origin_actor_authorized(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_visit_id uuid
)
returns public.app_role
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, extensions, auth
as $$
declare
  actor_role public.app_role;
  visit_row public.visits%rowtype;
begin
  if auth.role() not in ('service_role', 'authenticated')
    or (
      auth.role() = 'authenticated'
      and auth.uid() is distinct from p_actor_user_id
    )
  then
    raise exception 'DISPATCH_CURRENT_ORIGIN_ACTOR_CONTEXT_INVALID';
  end if;

  select membership.role into actor_role
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
   and company.status = 'active'
  where membership.company_id = p_company_id
    and membership.user_id = p_actor_user_id
    and membership.active
    and membership.role in ('owner', 'technician');
  if actor_role is null then
    raise exception 'DISPATCH_CURRENT_ORIGIN_ACTIVE_FIELD_ACTOR_REQUIRED';
  end if;

  select visit.* into visit_row
  from public.visits visit
  join public.crews crew
    on crew.company_id = visit.company_id
   and crew.id = visit.crew_id
   and crew.active
  where visit.company_id = p_company_id
    and visit.id = p_visit_id;
  if visit_row.id is null then
    raise exception 'DISPATCH_CURRENT_ORIGIN_ACTIVE_CREW_REQUIRED';
  end if;

  if not exists (
    select 1
    from public.crew_members member
    where member.company_id = p_company_id
      and member.crew_id = visit_row.crew_id
      and member.user_id = p_actor_user_id
      and member.starts_on <= visit_row.starts_at::date
      and (
        member.ends_on is null
        or member.ends_on
          >= (visit_row.ends_at - interval '1 microsecond')::date
      )
  ) then
    raise exception 'DISPATCH_CURRENT_ORIGIN_CREW_ASSIGNMENT_REQUIRED';
  end if;
  return actor_role;
end;
$$;

create or replace function private.storyops_protect_dispatch_current_origin()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_op = 'UPDATE'
    and current_setting(
      'storyops.dispatch_current_origin_capture',
      true
    ) = 'on'
  then
    return new;
  end if;
  if tg_op = 'DELETE'
    and current_setting(
      'storyops.dispatch_current_origin_purge',
      true
    ) = 'on'
  then
    return old;
  end if;
  raise exception 'DISPATCH_CURRENT_ORIGIN_EPHEMERAL_IMMUTABLE';
end;
$$;

create trigger dispatch_current_origin_ephemera_immutable
before update or delete on private.dispatch_current_origin_ephemera
for each row execute function
  private.storyops_protect_dispatch_current_origin();

create trigger dispatch_current_origin_verifiers_immutable
before update or delete on private.dispatch_current_origin_verifiers
for each row execute function
  private.storyops_protect_dispatch_current_origin();

create or replace function private.storyops_purge_dispatch_current_origins(
  p_limit integer
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = pg_catalog, private
as $$
declare
  affected integer;
  verifier_affected integer;
begin
  if p_limit is null or p_limit not between 1 and 5000 then
    raise exception 'DISPATCH_CURRENT_ORIGIN_PURGE_LIMIT_INVALID';
  end if;
  perform set_config(
    'storyops.dispatch_current_origin_purge',
    'on',
    true
  );
  with candidates as (
    select ephemera.route_check_id
    from private.dispatch_current_origin_ephemera ephemera
    where ephemera.purge_after <= statement_timestamp()
    order by ephemera.purge_after, ephemera.route_check_id
    limit p_limit
    for update skip locked
  )
  delete from private.dispatch_current_origin_ephemera ephemera
  using candidates
  where ephemera.route_check_id = candidates.route_check_id;
  get diagnostics affected = row_count;
  with candidates as (
    select verifier.route_check_id
    from private.dispatch_current_origin_verifiers verifier
    where verifier.purge_after <= statement_timestamp()
    order by verifier.purge_after, verifier.route_check_id
    limit p_limit
    for update skip locked
  )
  delete from private.dispatch_current_origin_verifiers verifier
  using candidates
  where verifier.route_check_id = candidates.route_check_id;
  get diagnostics verifier_affected = row_count;
  return jsonb_build_object(
    'coordinates', affected,
    'verifiers', verifier_affected,
    'total', affected + verifier_affected
  );
end;
$$;

create or replace function public.purge_storyops_dispatch_current_origins(
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = pg_catalog, public, private, auth
as $$
declare
  purge_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DISPATCH_CURRENT_ORIGIN_PURGE_SERVICE_ROLE_REQUIRED';
  end if;
  purge_result := private.storyops_purge_dispatch_current_origins(p_limit);
  return jsonb_build_object(
    'schemaVersion', 'storyops-dispatch-current-origin-purge-v1',
    'purged', (purge_result ->> 'total')::integer,
    'coordinatesPurged',
      (purge_result ->> 'coordinates')::integer,
    'verifiersPurged',
      (purge_result ->> 'verifiers')::integer,
    'retentionPolicy',
      'storyops-dispatch-current-origin-ephemeral-v1',
    'completedAt', statement_timestamp()
  );
end;
$$;

create table private.dispatch_origin_purge_worker_health (
  singleton boolean primary key default true check (singleton),
  schedule_job_id bigint,
  schedule_registered_at timestamptz,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_status text not null default 'pending'
    check (last_status in ('pending', 'running', 'healthy', 'failed')),
  last_purged_count integer not null default 0
    check (last_purged_count >= 0),
  last_cron_history_purged_count integer not null default 0
    check (last_cron_history_purged_count >= 0),
  last_error text,
  updated_at timestamptz not null default statement_timestamp()
);

insert into private.dispatch_origin_purge_worker_health(singleton)
values (true);

revoke all on table private.dispatch_origin_purge_worker_health
  from public, anon, authenticated, service_role;

create or replace function private.run_storyops_dispatch_origin_purge_worker()
returns jsonb
language plpgsql
security definer
volatile
set search_path = pg_catalog, private
as $$
declare
  purge_result jsonb;
  coordinate_stale_count integer;
  verifier_stale_count integer;
  cron_history_purged_count integer;
  cron_history_stale_count integer;
begin
  update private.dispatch_origin_purge_worker_health
  set
    last_started_at = statement_timestamp(),
    last_status = 'running',
    last_error = null,
    updated_at = statement_timestamp()
  where singleton;

  purge_result := private.storyops_purge_dispatch_current_origins(5000);
  select count(*)::integer into coordinate_stale_count
  from private.dispatch_current_origin_ephemera ephemera
  where ephemera.purge_after <= statement_timestamp();
  select count(*)::integer into verifier_stale_count
  from private.dispatch_current_origin_verifiers verifier
  where verifier.purge_after <= statement_timestamp();
  with candidates as (
    select run.runid
    from cron.job_run_details run
    where run.command =
      'select private.run_storyops_dispatch_origin_purge_worker();'
      and run.jobid = (
        select health.schedule_job_id
        from private.dispatch_origin_purge_worker_health health
        where health.singleton
      )
      and run.database = current_database()
      and run.username = (
        select job.username
        from cron.job job
        where job.jobid = run.jobid
      )
      and run.end_time <
        statement_timestamp() - interval '24 hours'
    order by run.end_time, run.runid
    limit 5000
    for update skip locked
  )
  delete from cron.job_run_details run
  using candidates
  where run.runid = candidates.runid;
  get diagnostics cron_history_purged_count = row_count;
  select count(*)::integer into cron_history_stale_count
  from cron.job_run_details run
  where run.command =
    'select private.run_storyops_dispatch_origin_purge_worker();'
    and run.jobid = (
      select health.schedule_job_id
      from private.dispatch_origin_purge_worker_health health
      where health.singleton
    )
    and run.database = current_database()
    and run.username = (
      select job.username
      from cron.job job
      where job.jobid = run.jobid
    )
    and run.end_time <
      statement_timestamp() - interval '24 hours';

  update private.dispatch_origin_purge_worker_health
  set
    last_completed_at = statement_timestamp(),
    last_status = case
      when coordinate_stale_count = 0
        and verifier_stale_count = 0
        and cron_history_stale_count = 0
      then 'healthy'
      else 'failed'
    end,
    last_purged_count = (purge_result ->> 'total')::integer,
    last_cron_history_purged_count = cron_history_purged_count,
    last_error = case
      when coordinate_stale_count = 0
        and verifier_stale_count = 0
        and cron_history_stale_count = 0
      then null
      when cron_history_stale_count > 0
      then 'DISPATCH_ORIGIN_CRON_HISTORY_STALE_ROWS_REMAIN'
      else 'DISPATCH_ORIGIN_RETENTION_STALE_ROWS_REMAIN'
    end,
    updated_at = statement_timestamp()
  where singleton;
  return jsonb_build_object(
    'schemaVersion', 'storyops-dispatch-origin-purge-worker-v1',
    'status', case
      when coordinate_stale_count = 0
        and verifier_stale_count = 0
        and cron_history_stale_count = 0
      then 'healthy'
      else 'failed'
    end,
    'purged', (purge_result ->> 'total')::integer,
    'coordinatesPurged',
      (purge_result ->> 'coordinates')::integer,
    'verifiersPurged',
      (purge_result ->> 'verifiers')::integer,
    'coordinateStaleCount', coordinate_stale_count,
    'verifierStaleCount', verifier_stale_count,
    'cronHistoryPurged', cron_history_purged_count,
    'cronHistoryStaleCount', cron_history_stale_count,
    'cronHistoryRetentionHours', 24,
    'completedAt', statement_timestamp()
  );
exception
  when others then
    update private.dispatch_origin_purge_worker_health
    set
      last_completed_at = statement_timestamp(),
      last_status = 'failed',
      last_cron_history_purged_count = 0,
      last_error = left(sqlstate || ':' || sqlerrm, 500),
      updated_at = statement_timestamp()
    where singleton;
    return jsonb_build_object(
      'schemaVersion', 'storyops-dispatch-origin-purge-worker-v1',
      'status', 'failed',
      'purged', 0,
      'coordinatesPurged', 0,
      'verifiersPurged', 0,
      'cronHistoryPurged', 0,
      'coordinateStaleCount', (
        select count(*)
        from private.dispatch_current_origin_ephemera ephemera
        where ephemera.purge_after <= statement_timestamp()
      ),
      'verifierStaleCount', (
        select count(*)
        from private.dispatch_current_origin_verifiers verifier
        where verifier.purge_after <= statement_timestamp()
      ),
      'cronHistoryStaleCount', (
        select count(*)
        from cron.job_run_details run
        where run.command =
          'select private.run_storyops_dispatch_origin_purge_worker();'
          and run.jobid = (
            select health.schedule_job_id
            from private.dispatch_origin_purge_worker_health health
            where health.singleton
          )
          and run.database = current_database()
          and run.username = (
            select job.username
            from cron.job job
            where job.jobid = run.jobid
          )
          and run.end_time <
            statement_timestamp() - interval '24 hours'
      ),
      'cronHistoryRetentionHours', 24,
      'completedAt', statement_timestamp()
    );
end;
$$;

create extension if not exists pg_cron;

do $schedule$
declare
  existing_job_id bigint;
  scheduled_job_id bigint;
begin
  select job.jobid into existing_job_id
  from cron.job job
  where job.jobname = 'storyops-dispatch-origin-purge';
  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;
  scheduled_job_id := cron.schedule(
    'storyops-dispatch-origin-purge',
    '5 seconds',
    'select private.run_storyops_dispatch_origin_purge_worker();'
  );
  update private.dispatch_origin_purge_worker_health
  set
    schedule_job_id = scheduled_job_id,
    schedule_registered_at = statement_timestamp(),
    updated_at = statement_timestamp()
  where singleton;
end;
$schedule$;

-- Bootstrap cleanup is useful, but only pg_cron execution evidence may open
-- the release gate below.
select private.run_storyops_dispatch_origin_purge_worker();

create or replace function private.storyops_dispatch_origin_retention_healthy()
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, private
as $$
  select
    health.last_status = 'healthy'
    and health.last_completed_at
      >= statement_timestamp() - interval '1 minute'
    and not exists (
      select 1
      from private.dispatch_current_origin_ephemera ephemera
      where ephemera.purge_after <= statement_timestamp()
    )
    and not exists (
      select 1
      from private.dispatch_current_origin_verifiers verifier
      where verifier.purge_after <= statement_timestamp()
    )
    and not exists (
      select 1
      from cron.job_run_details run
      where run.command =
        'select private.run_storyops_dispatch_origin_purge_worker();'
        and run.jobid = health.schedule_job_id
        and run.database = current_database()
        and run.username = (
          select job.username
          from cron.job job
          where job.jobid = health.schedule_job_id
        )
        and run.end_time <
          statement_timestamp() - interval '24 hours'
    )
    and exists (
      select 1
      from cron.job job
      where job.jobid = health.schedule_job_id
        and job.jobname = 'storyops-dispatch-origin-purge'
        and job.active
        and job.schedule = '5 seconds'
        and job.database = current_database()
    )
    and exists (
      select 1
      from lateral (
        select
          run.status,
          run.end_time
        from cron.job_run_details run
        where run.jobid = health.schedule_job_id
          and run.command =
            'select private.run_storyops_dispatch_origin_purge_worker();'
          and run.database = current_database()
          and run.username = (
            select job.username
            from cron.job job
            where job.jobid = health.schedule_job_id
          )
          and health.schedule_registered_at is not null
          and run.start_time >= health.schedule_registered_at
          and run.end_time is not null
        order by run.runid desc
        limit 1
      ) latest_scheduler_run
      where latest_scheduler_run.status = 'succeeded'
        and latest_scheduler_run.end_time
          >= statement_timestamp() - interval '1 minute'
    )
  from private.dispatch_origin_purge_worker_health health
  where health.singleton
$$;

create or replace function public.get_storyops_dispatch_origin_retention_health()
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  health_row private.dispatch_origin_purge_worker_health%rowtype;
  coordinate_stale_count integer;
  verifier_stale_count integer;
  cron_history_stale_count integer;
  oldest_coordinate_stale_seconds numeric;
  oldest_verifier_stale_seconds numeric;
  schedule_active boolean;
  scheduler_last_run_status text;
  scheduler_last_started_at timestamptz;
  scheduler_last_completed_at timestamptz;
  scheduler_execution_verified boolean;
  healthy boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DISPATCH_ORIGIN_RETENTION_HEALTH_SERVICE_ROLE_REQUIRED';
  end if;
  select * into health_row
  from private.dispatch_origin_purge_worker_health health
  where health.singleton;
  select
    count(*)::integer,
    coalesce(
      max(extract(epoch from (
        statement_timestamp() - ephemera.purge_after
      ))),
      0
    )
  into coordinate_stale_count, oldest_coordinate_stale_seconds
  from private.dispatch_current_origin_ephemera ephemera
  where ephemera.purge_after <= statement_timestamp();
  select
    count(*)::integer,
    coalesce(
      max(extract(epoch from (
        statement_timestamp() - verifier.purge_after
      ))),
      0
    )
  into verifier_stale_count, oldest_verifier_stale_seconds
  from private.dispatch_current_origin_verifiers verifier
  where verifier.purge_after <= statement_timestamp();
  select count(*)::integer
  into cron_history_stale_count
  from cron.job_run_details run
  where run.command =
    'select private.run_storyops_dispatch_origin_purge_worker();'
    and run.jobid = health_row.schedule_job_id
    and run.database = current_database()
    and run.username = (
      select job.username
      from cron.job job
      where job.jobid = health_row.schedule_job_id
    )
    and run.end_time <
      statement_timestamp() - interval '24 hours';
  select exists (
    select 1
    from cron.job job
    where job.jobid = health_row.schedule_job_id
      and job.jobname = 'storyops-dispatch-origin-purge'
      and job.active
      and job.schedule = '5 seconds'
      and job.database = current_database()
  ) into schedule_active;
  select
    run.status,
    run.start_time,
    run.end_time
  into
    scheduler_last_run_status,
    scheduler_last_started_at,
    scheduler_last_completed_at
  from cron.job_run_details run
  where run.jobid = health_row.schedule_job_id
    and run.command =
      'select private.run_storyops_dispatch_origin_purge_worker();'
    and run.database = current_database()
    and run.username = (
      select job.username
      from cron.job job
      where job.jobid = health_row.schedule_job_id
    )
    and health_row.schedule_registered_at is not null
    and run.start_time >= health_row.schedule_registered_at
    and run.end_time is not null
  order by run.runid desc
  limit 1;
  scheduler_execution_verified :=
    scheduler_last_run_status = 'succeeded'
    and scheduler_last_completed_at
      >= statement_timestamp() - interval '1 minute';
  healthy :=
    health_row.last_status = 'healthy'
    and health_row.last_completed_at
      >= statement_timestamp() - interval '1 minute'
    and coordinate_stale_count = 0
    and verifier_stale_count = 0
    and cron_history_stale_count = 0
    and schedule_active
    and scheduler_execution_verified;
  return jsonb_build_object(
    'schemaVersion', 'storyops-dispatch-origin-retention-health-v1',
    'status', case when healthy then 'healthy' else 'blocked' end,
    'p0ReleaseCheck', case when healthy then 'passed' else 'blocked' end,
    'scheduleActive', schedule_active,
    'scheduleSeconds', 5,
    'scheduleRegisteredAt', health_row.schedule_registered_at,
    'schedulerExecutionVerified',
      coalesce(scheduler_execution_verified, false),
    'schedulerLastRunStatus', scheduler_last_run_status,
    'schedulerLastStartedAt', scheduler_last_started_at,
    'schedulerLastCompletedAt', scheduler_last_completed_at,
    'lastStartedAt', health_row.last_started_at,
    'lastCompletedAt', health_row.last_completed_at,
    'lastStatus', health_row.last_status,
    'lastPurgedCount', health_row.last_purged_count,
    'lastCronHistoryPurgedCount',
      health_row.last_cron_history_purged_count,
    'coordinateStaleCount', coordinate_stale_count,
    'verifierStaleCount', verifier_stale_count,
    'cronHistoryStaleCount', cron_history_stale_count,
    'cronHistoryRetentionHours', 24,
    'oldestCoordinateStaleSeconds',
      oldest_coordinate_stale_seconds,
    'oldestVerifierStaleSeconds',
      oldest_verifier_stale_seconds,
    'retentionPolicy',
      'storyops-dispatch-current-origin-ephemeral-v1'
  );
end;
$$;

-- A stopped or unhealthy coordinate-purge worker is a P0 launch blocker.
alter function private.storyops_launch_authorization_effective(uuid)
  rename to storyops_launch_authorization_base_before_origin;

create or replace function private.storyops_launch_authorization_effective(
  p_company_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, private
as $$
  select
    private.storyops_launch_authorization_base_before_origin(
      p_company_id
    )
    and private.storyops_dispatch_origin_retention_healthy()
$$;

-- Preserve the broader legacy dispatch-role boundary for any non-origin
-- evidence consumer. Public current-origin entry points receive stricter
-- wrappers around the already-validated implementations.
alter function public.load_storyops_dispatch_clearance_candidate(
  uuid, uuid, uuid, integer, text
) set schema private;
alter function public.record_storyops_dispatch_clearance(
  uuid, uuid, text, text, jsonb
) set schema private;
alter function public.consume_storyops_dispatch_clearance(
  uuid, uuid, integer, uuid, text
) set schema private;

revoke all on function private.load_storyops_dispatch_clearance_candidate(
  uuid, uuid, uuid, integer, text
) from public, anon, authenticated, service_role;
revoke all on function private.record_storyops_dispatch_clearance(
  uuid, uuid, text, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.consume_storyops_dispatch_clearance(
  uuid, uuid, integer, uuid, text
) from public, anon, authenticated, service_role;

create or replace function public.load_storyops_dispatch_clearance_candidate(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_visit_id uuid,
  p_expected_visit_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DISPATCH_CLEARANCE_SERVICE_ROLE_REQUIRED';
  end if;
  perform private.storyops_dispatch_current_origin_actor_authorized(
    p_company_id,
    p_actor_user_id,
    p_visit_id
  );
  return private.load_storyops_dispatch_clearance_candidate(
    p_company_id,
    p_actor_user_id,
    p_visit_id,
    p_expected_visit_version,
    p_idempotency_key
  );
end;
$$;

create or replace function public.record_storyops_dispatch_clearance(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  visit_id_value uuid;
  existing_row public.dispatch_clearance_receipts%rowtype;
  verifier_row private.dispatch_current_origin_verifiers%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DISPATCH_CLEARANCE_SERVICE_ROLE_REQUIRED';
  end if;
  if p_evidence is null
    or jsonb_typeof(p_evidence) <> 'object'
    or coalesce(p_evidence ->> 'visitId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    raise exception 'DISPATCH_CLEARANCE_EVIDENCE_INVALID';
  end if;
  visit_id_value := (p_evidence ->> 'visitId')::uuid;
  perform private.storyops_dispatch_current_origin_actor_authorized(
    p_company_id,
    p_actor_user_id,
    visit_id_value
  );
  perform private.storyops_purge_dispatch_current_origins(500);

  begin
    return private.record_storyops_dispatch_clearance(
      p_company_id,
      p_actor_user_id,
      p_idempotency_key,
      p_request_hash,
      p_evidence
    );
  exception
    when others then
      if position(
        'DISPATCH_CLEARANCE_IDEMPOTENCY_CONFLICT' in sqlerrm
      ) = 0 then
        raise;
      end if;
  end;

  select * into existing_row
  from public.dispatch_clearance_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.idempotency_key = p_idempotency_key;
  select * into verifier_row
  from private.dispatch_current_origin_verifiers verifier
  where verifier.receipt_id = existing_row.id;
  if existing_row.id is null
    or verifier_row.receipt_id is null
    or existing_row.schema_version <> 'storyops-dispatch-clearance-v2'
    or verifier_row.source_request_sha256 <> p_request_hash
    or existing_row.visit_id <> visit_id_value
    or existing_row.visit_version
      <> (p_evidence ->> 'visitVersion')::integer
    or existing_row.created_by <> p_actor_user_id
    or verifier_row.actor_user_id <> p_actor_user_id
    or verifier_row.source_origin_sha256
      <> public.storyops_json_sha256(p_evidence -> 'currentOrigin')
    or verifier_row.origin_mac <> existing_row.current_origin_hash
    or verifier_row.request_mac <> existing_row.request_hash
  then
    raise exception 'DISPATCH_CLEARANCE_IDEMPOTENCY_CONFLICT';
  end if;
  return public.storyops_dispatch_clearance_receipt_json(
    existing_row,
    true
  );
end;
$$;

create or replace function public.replay_storyops_dispatch_clearance(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_visit_id uuid,
  p_expected_visit_version integer,
  p_idempotency_key text,
  p_request_hash text,
  p_current_origin jsonb
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  receipt_row public.dispatch_clearance_receipts%rowtype;
  verifier_row private.dispatch_current_origin_verifiers%rowtype;
  ephemera_row private.dispatch_current_origin_ephemera%rowtype;
  effective_request_hash text;
begin
  if auth.role() is distinct from 'service_role'
    or p_company_id is null
    or p_actor_user_id is null
    or p_visit_id is null
    or p_expected_visit_version < 1
    or p_idempotency_key is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_current_origin) <> 'object'
  then
    raise exception 'DISPATCH_CLEARANCE_REPLAY_INVALID_REQUEST';
  end if;
  perform private.storyops_dispatch_current_origin_actor_authorized(
    p_company_id,
    p_actor_user_id,
    p_visit_id
  );
  effective_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'actorUserId', p_actor_user_id,
    'companyId', p_company_id,
    'currentOrigin', p_current_origin,
    'expectedVisitVersion', p_expected_visit_version,
    'idempotencyKey', p_idempotency_key,
    'schemaVersion', 'storyops-dispatch-clearance-request-v2',
    'visitId', p_visit_id
  ));
  if effective_request_hash <> p_request_hash then
    raise exception 'DISPATCH_CLEARANCE_REQUEST_HASH_MISMATCH';
  end if;

  select * into receipt_row
  from public.dispatch_clearance_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.idempotency_key = p_idempotency_key;
  select * into verifier_row
  from private.dispatch_current_origin_verifiers verifier
  where verifier.receipt_id = receipt_row.id;
  select * into ephemera_row
  from private.dispatch_current_origin_ephemera ephemera
  where ephemera.receipt_id = receipt_row.id;
  if receipt_row.id is null
    or verifier_row.receipt_id is null
    or ephemera_row.receipt_id is null
    or receipt_row.visit_id <> p_visit_id
    or receipt_row.visit_version <> p_expected_visit_version
    or receipt_row.created_by <> p_actor_user_id
    or receipt_row.expires_at <= statement_timestamp()
    or ephemera_row.expires_at <= statement_timestamp()
    or verifier_row.actor_user_id <> p_actor_user_id
    or verifier_row.source_request_sha256 <> p_request_hash
    or verifier_row.source_origin_sha256
      <> public.storyops_json_sha256(p_current_origin)
    or receipt_row.current_origin
      is distinct from p_current_origin - 'coordinates'
    or ephemera_row.coordinates
      is distinct from p_current_origin -> 'coordinates'
    or verifier_row.origin_mac <> receipt_row.current_origin_hash
    or verifier_row.request_mac <> receipt_row.request_hash
  then
    raise exception 'DISPATCH_CLEARANCE_IDEMPOTENCY_CONFLICT';
  end if;
  return public.storyops_dispatch_clearance_receipt_json(
    receipt_row,
    true
  );
end;
$$;

create or replace function public.consume_storyops_dispatch_clearance(
  p_company_id uuid,
  p_command_id uuid,
  p_expected_visit_version integer,
  p_clearance_receipt_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  actor_user_id uuid := auth.uid();
  receipt_row public.dispatch_clearance_receipts%rowtype;
  effective_request_hash text;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
    or p_company_id is null
    or p_command_id is null
    or p_expected_visit_version < 1
    or p_clearance_receipt_id is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'DISPATCH_CLEARANCE_CONSUME_INVALID_REQUEST';
  end if;
  effective_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'clearanceReceiptId', p_clearance_receipt_id,
    'companyId', p_company_id,
    'expectedVisitVersion', p_expected_visit_version,
    'operation', 'visit.dispatch_clearance.consume'
  ));
  if effective_request_hash <> p_request_hash then
    raise exception 'DISPATCH_CLEARANCE_CONSUME_HASH_MISMATCH';
  end if;
  if not private.storyops_launch_authorization_effective(p_company_id) then
    raise exception 'DISPATCH_CLEARANCE_LAUNCH_NOT_AUTHORIZED';
  end if;
  select * into receipt_row
  from public.dispatch_clearance_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.id = p_clearance_receipt_id;
  if receipt_row.id is null then
    raise exception 'DISPATCH_CLEARANCE_RECEIPT_NOT_FOUND';
  end if;
  perform private.storyops_dispatch_current_origin_actor_authorized(
    p_company_id,
    actor_user_id,
    receipt_row.visit_id
  );
  if receipt_row.created_by <> actor_user_id then
    raise exception 'DISPATCH_CURRENT_ORIGIN_CREATOR_REQUIRED';
  end if;
  perform private.storyops_purge_dispatch_current_origins(500);
  return private.consume_storyops_dispatch_clearance(
    p_company_id,
    p_command_id,
    p_expected_visit_version,
    p_clearance_receipt_id,
    p_request_hash
  );
end;
$$;

create or replace function public.enforce_storyops_dispatch_current_origin_consumption()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions, auth
as $$
declare
  receipt_row public.dispatch_clearance_receipts%rowtype;
  route_row public.route_checks%rowtype;
  ephemera_row private.dispatch_current_origin_ephemera%rowtype;
  verifier_row private.dispatch_current_origin_verifiers%rowtype;
  full_origin jsonb;
begin
  select * into receipt_row
  from public.dispatch_clearance_receipts receipt
  where receipt.company_id = new.company_id
    and receipt.id = new.clearance_receipt_id;
  select * into route_row
  from public.route_checks route
  where route.company_id = new.company_id
    and route.id = receipt_row.route_check_id;
  select * into ephemera_row
  from private.dispatch_current_origin_ephemera ephemera
  where ephemera.receipt_id = receipt_row.id;
  select * into verifier_row
  from private.dispatch_current_origin_verifiers verifier
  where verifier.receipt_id = receipt_row.id;
  full_origin := receipt_row.current_origin || jsonb_build_object(
    'coordinates',
    ephemera_row.coordinates
  );

  if receipt_row.id is null
    or receipt_row.schema_version <> 'storyops-dispatch-clearance-v2'
    or receipt_row.created_by <> new.consumed_by
    or new.consumed_by is distinct from auth.uid()
    or ephemera_row.receipt_id is null
    or ephemera_row.company_id <> receipt_row.company_id
    or ephemera_row.visit_id <> receipt_row.visit_id
    or ephemera_row.actor_user_id <> receipt_row.created_by
    or verifier_row.receipt_id is null
    or verifier_row.company_id <> receipt_row.company_id
    or verifier_row.visit_id <> receipt_row.visit_id
    or verifier_row.actor_user_id <> receipt_row.created_by
    or ephemera_row.expires_at <= statement_timestamp()
    or ephemera_row.purge_after <= statement_timestamp()
    or receipt_row.current_origin_expires_at <= statement_timestamp()
    or receipt_row.expires_at > receipt_row.current_origin_expires_at
    or public.storyops_json_sha256(full_origin)
      <> verifier_row.source_origin_sha256
    or verifier_row.origin_mac <> receipt_row.current_origin_hash
    or encode(
      extensions.hmac(
        convert_to(
          jsonb_build_object(
            'coordinates', ephemera_row.coordinates,
            'sourceSha256', verifier_row.source_origin_sha256
          )::text,
          'UTF8'
        ),
        verifier_row.verifier_key,
        'sha256'
      ),
      'hex'
    ) <> receipt_row.current_origin_hash
    or receipt_row.evidence_hash
      <> public.storyops_dispatch_clearance_hash(receipt_row)
    or route_row.id is null
    or route_row.request_payload ->> 'schemaVersion'
      <> 'storyops-dispatch-route-request-v2'
    or route_row.request_payload ->> 'currentOriginHash'
      <> receipt_row.current_origin_hash
    or route_row.request_payload -> 'origin' is distinct from
      jsonb_build_object(
        'redacted', true,
        'retentionPolicy',
          'storyops-dispatch-current-origin-ephemeral-v1'
      )
  then
    raise exception 'DISPATCH_CLEARANCE_CURRENT_ORIGIN_REQUIRED';
  end if;
  perform set_config(
    'storyops.dispatch_current_origin_purge',
    'on',
    true
  );
  delete from private.dispatch_current_origin_ephemera ephemera
  where ephemera.receipt_id = receipt_row.id;
  return new;
end;
$$;

drop policy dispatch_clearance_receipts_staff_select
  on public.dispatch_clearance_receipts;
create policy dispatch_clearance_receipts_staff_select
on public.dispatch_clearance_receipts
for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
  or (
    public.has_company_role(
      company_id,
      array['technician']::public.app_role[]
    )
    and created_by = auth.uid()
    and public.is_assigned_technician_for_visit(visit_id)
  )
);

drop policy dispatch_clearance_consumptions_staff_select
  on public.dispatch_clearance_consumptions;
create policy dispatch_clearance_consumptions_staff_select
on public.dispatch_clearance_consumptions
for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
  or (
    public.has_company_role(
      company_id,
      array['technician']::public.app_role[]
    )
    and consumed_by = auth.uid()
    and public.is_assigned_technician_for_visit(visit_id)
  )
);

revoke all on function private.storyops_redact_dispatch_route_origin()
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_redact_dispatch_origin_audit_event()
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_capture_dispatch_current_origin()
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_dispatch_current_origin_payload(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_dispatch_current_origin_actor_authorized(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function private.storyops_protect_dispatch_current_origin()
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_purge_dispatch_current_origins(integer)
  from public, anon, authenticated, service_role;
revoke all on function private.run_storyops_dispatch_origin_purge_worker()
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_dispatch_origin_retention_healthy()
  from public, anon, authenticated, service_role;
revoke all on function
  private.storyops_launch_authorization_base_before_origin(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.storyops_launch_authorization_effective(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.storyops_dispatch_clearance_receipt_json(
  public.dispatch_clearance_receipts, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.load_storyops_dispatch_clearance_candidate(
  uuid, uuid, uuid, integer, text
) from public, anon, authenticated;
revoke all on function public.record_storyops_dispatch_clearance(
  uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.replay_storyops_dispatch_clearance(
  uuid, uuid, uuid, integer, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.consume_storyops_dispatch_clearance(
  uuid, uuid, integer, uuid, text
) from public, anon, service_role;
revoke all on function public.enforce_storyops_dispatch_current_origin_consumption()
  from public, anon, authenticated, service_role;
revoke all on function public.purge_storyops_dispatch_current_origins(integer)
  from public, anon, authenticated;
revoke all on function public.get_storyops_dispatch_origin_retention_health()
  from public, anon, authenticated;
revoke all on schema cron from public, anon, authenticated, service_role;
revoke all on all tables in schema cron
  from public, anon, authenticated, service_role;
revoke all on all functions in schema cron
  from public, anon, authenticated, service_role;

grant execute on function public.load_storyops_dispatch_clearance_candidate(
  uuid, uuid, uuid, integer, text
) to service_role;
grant execute on function public.record_storyops_dispatch_clearance(
  uuid, uuid, text, text, jsonb
) to service_role;
grant execute on function public.replay_storyops_dispatch_clearance(
  uuid, uuid, uuid, integer, text, text, jsonb
) to service_role;
grant execute on function public.consume_storyops_dispatch_clearance(
  uuid, uuid, integer, uuid, text
) to authenticated;
grant execute on function public.purge_storyops_dispatch_current_origins(integer)
  to service_role;
grant execute on function public.get_storyops_dispatch_origin_retention_health()
  to service_role;

comment on column public.dispatch_clearance_receipts.current_origin is
  'Durable redacted departure-origin evidence: consent, reading identity, observation, accuracy, and source only. Exact coordinates live solely in the private two-minute ephemera table.';
comment on function public.record_storyops_dispatch_clearance(
  uuid, uuid, text, text, jsonb
) is
  'Trusted current-origin recorder restricted to a date-valid active owner/technician on the visit crew; exact coordinates are privately HMAC-bound to the route and retained only until receipt expiry.';
comment on function public.replay_storyops_dispatch_clearance(
  uuid, uuid, uuid, integer, text, text, jsonb
) is
  'Service-only exact replay verifier that accepts the raw request digest and current-origin envelope but returns only opaque public MACs; private source digests and keys are never exported.';
comment on function public.consume_storyops_dispatch_clearance(
  uuid, uuid, integer, uuid, text
) is
  'Consumes fresh dispatch evidence only for the exact assigned field actor who supplied and consented to the receipt current origin.';
comment on function public.purge_storyops_dispatch_current_origins(integer) is
  'Bounded service-only purge for exact departure coordinates at their non-extendable two-minute retention deadline.';
comment on function public.get_storyops_dispatch_origin_retention_health() is
  'Service-only integration-health/P0 projection for the deployed five-second coordinate purge worker, including stale count and oldest stale age without location data.';
