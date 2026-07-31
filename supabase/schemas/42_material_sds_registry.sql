-- Exact, private, versioned SDS registration for the operating material catalog.
-- Company configuration identifies the expected material and PDF checksum, but
-- it never turns an arbitrary URL into field safety evidence. An active owner
-- must prepare a bounded private upload and finalize it against the durable
-- Storage object. Field usage remains blocked unless the material points to the
-- exact immutable SDS version bound to the current operating baseline.

alter table public.sds_documents
  drop constraint if exists sds_documents_company_id_checksum_sha256_key;

alter table public.sds_documents
  add column configuration_material_key text,
  add column configuration_revision integer,
  add column configuration_hash text,
  add column operating_baseline_id uuid
    references public.company_operating_baseline_publications(id) on delete restrict,
  add column operating_baseline_hash text,
  add column document_version integer,
  add column content_type text,
  add column byte_size bigint,
  add column review_reference text,
  add column registration_command_id uuid,
  add column request_hash text,
  add column storage_verified_at timestamptz,
  add column registration_source text not null default 'legacy';

alter table public.sds_documents
  add constraint sds_documents_registration_source_check
    check (registration_source in ('legacy', 'owner_review_v1')),
  add constraint sds_documents_configuration_material_key_check
    check (
      configuration_material_key is null
      or configuration_material_key ~ '^[a-z0-9][a-z0-9-]{1,63}$'
    ),
  add constraint sds_documents_configuration_revision_check
    check (configuration_revision is null or configuration_revision > 0),
  add constraint sds_documents_configuration_hash_check
    check (configuration_hash is null or configuration_hash ~ '^[a-f0-9]{64}$'),
  add constraint sds_documents_operating_baseline_hash_check
    check (
      operating_baseline_hash is null
      or operating_baseline_hash ~ '^[a-f0-9]{64}$'
    ),
  add constraint sds_documents_document_version_check
    check (document_version is null or document_version > 0),
  add constraint sds_documents_content_type_check
    check (content_type is null or content_type = 'application/pdf'),
  add constraint sds_documents_byte_size_check
    check (byte_size is null or byte_size between 5 and 10485760),
  add constraint sds_documents_review_reference_check
    check (
      review_reference is null
      or (
        length(btrim(review_reference)) between 5 and 240
        and review_reference !~ '[[:cntrl:]]'
      )
    ),
  add constraint sds_documents_request_hash_check
    check (request_hash is null or request_hash ~ '^[a-f0-9]{64}$'),
  add constraint sds_documents_private_object_path_check
    check (
      registration_source = 'legacy'
      or storage_object_path like company_id::text || '/materials/%/sds/%'
    ),
  add constraint sds_documents_owner_registration_complete
    check (
      registration_source = 'legacy'
      or (
        configuration_material_key is not null
        and configuration_revision is not null
        and configuration_hash is not null
        and num_nonnulls(operating_baseline_id, operating_baseline_hash) in (0, 2)
        and document_version is not null
        and content_type = 'application/pdf'
        and byte_size is not null
        and review_reference is not null
        and registration_command_id is not null
        and request_hash is not null
        and storage_verified_at is not null
        and reviewed_at is not null
        and reviewed_by is not null
      )
    );

create unique index sds_documents_exact_version_idx
  on public.sds_documents(
    company_id,
    configuration_material_key,
    document_version
  )
  where registration_source = 'owner_review_v1';

create unique index sds_documents_object_path_idx
  on public.sds_documents(company_id, storage_object_path);

create unique index sds_documents_registration_command_idx
  on public.sds_documents(company_id, registration_command_id)
  where registration_command_id is not null;

alter table public.materials
  add column configuration_material_key text,
  add column configuration_revision integer,
  add column configuration_hash text,
  add column operating_baseline_id uuid
    references public.company_operating_baseline_publications(id) on delete restrict,
  add column operating_baseline_hash text,
  add column expected_sds_checksum_sha256 text,
  add column sds_document_version integer;

alter table public.materials
  add constraint materials_configuration_material_key_check
    check (
      configuration_material_key is null
      or configuration_material_key ~ '^[a-z0-9][a-z0-9-]{1,63}$'
    ),
  add constraint materials_configuration_revision_check
    check (configuration_revision is null or configuration_revision > 0),
  add constraint materials_configuration_hash_check
    check (configuration_hash is null or configuration_hash ~ '^[a-f0-9]{64}$'),
  add constraint materials_operating_baseline_hash_check
    check (
      operating_baseline_hash is null
      or operating_baseline_hash ~ '^[a-f0-9]{64}$'
    ),
  add constraint materials_expected_sds_checksum_check
    check (
      expected_sds_checksum_sha256 is null
      or expected_sds_checksum_sha256 ~ '^[a-f0-9]{64}$'
    ),
  add constraint materials_sds_document_version_check
    check (sds_document_version is null or sds_document_version > 0),
  add constraint materials_configuration_binding_complete
    check (
      num_nonnulls(
        configuration_material_key,
        configuration_revision,
        configuration_hash,
        operating_baseline_id,
        operating_baseline_hash
      ) in (0, 5)
    ),
  add constraint materials_sds_pointer_complete
    check (num_nonnulls(sds_document_id, sds_document_version) in (0, 2)),
  add constraint materials_nonchemical_has_no_sds
    check (
      requires_sds
      or (
        sds_document_id is null
        and sds_document_version is null
        and expected_sds_checksum_sha256 is null
      )
    );

create unique index materials_configuration_key_idx
  on public.materials(company_id, configuration_material_key)
  where configuration_material_key is not null;

create table public.sds_registration_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  command_id uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  prepared_by uuid not null references auth.users(id) on delete restrict,
  material_id uuid references public.materials(id) on delete restrict,
  material_version integer check (material_version is null or material_version > 0),
  configuration_material_key text not null
    check (configuration_material_key ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  configuration_revision integer not null check (configuration_revision > 0),
  configuration_hash text not null check (configuration_hash ~ '^[a-f0-9]{64}$'),
  operating_baseline_id uuid
    references public.company_operating_baseline_publications(id) on delete restrict,
  operating_baseline_hash text
    check (
      operating_baseline_hash is null
      or operating_baseline_hash ~ '^[a-f0-9]{64}$'
    ),
  document_version integer not null check (document_version > 0),
  product_name text not null
    check (
      length(btrim(product_name)) between 2 and 120
      and product_name !~ '[[:cntrl:]]'
    ),
  manufacturer text not null
    check (
      length(btrim(manufacturer)) between 2 and 120
      and manufacturer !~ '[[:cntrl:]]'
    ),
  revision_date date not null,
  object_path text not null check (length(object_path) between 1 and 500),
  content_type text not null check (content_type = 'application/pdf'),
  byte_size bigint not null check (byte_size between 5 and 10485760),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  review_reference text not null
    check (
      length(btrim(review_reference)) between 5 and 240
      and review_reference !~ '[[:cntrl:]]'
    ),
  status text not null check (status in ('prepared', 'registered', 'expired')),
  sds_document_id uuid references public.sds_documents(id) on delete restrict,
  prepared_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (company_id, command_id),
  unique (company_id, object_path),
  check (object_path like company_id::text || '/materials/%/sds/%'),
  check (expires_at > prepared_at),
  check (num_nonnulls(material_id, material_version) in (0, 2)),
  check (num_nonnulls(operating_baseline_id, operating_baseline_hash) in (0, 2)),
  check (
    (status = 'registered' and sds_document_id is not null and completed_at is not null)
    or (status in ('prepared', 'expired') and sds_document_id is null and completed_at is null)
  )
);

create index sds_registration_requests_pending_idx
  on public.sds_registration_requests(
    company_id,
    configuration_material_key,
    expires_at
  )
  where status = 'prepared';

create table public.sds_upload_attestations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  registration_request_id uuid not null
    references public.sds_registration_requests(id) on delete restrict,
  command_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  object_path text not null check (length(object_path) between 1 and 500),
  expected_checksum_sha256 text not null
    check (expected_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  observed_checksum_sha256 text not null
    check (observed_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint not null check (byte_size between 5 and 10485760),
  content_type text not null check (content_type = 'application/pdf'),
  attested_at timestamptz not null default now(),
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, registration_request_id),
  unique (company_id, command_id),
  check (object_path like company_id::text || '/materials/%/sds/%'),
  check (expected_checksum_sha256 = observed_checksum_sha256),
  check (consumed_at is null or consumed_at >= attested_at)
);

create index sds_upload_attestations_unconsumed_idx
  on public.sds_upload_attestations(company_id, registration_request_id)
  where consumed_at is null;

create trigger sds_registration_requests_touch
  before update on public.sds_registration_requests
  for each row execute function public.touch_record();

create trigger sds_registration_requests_audit
  after insert or update or delete on public.sds_registration_requests
  for each row execute function public.audit_mutation();

create trigger storyops_active_company_mutation_gate
  before insert or update or delete on public.sds_registration_requests
  for each row execute function public.assert_active_company_for_authenticated_mutation();

create trigger sds_upload_attestations_audit
  after insert or update or delete on public.sds_upload_attestations
  for each row execute function public.audit_mutation();

create trigger storyops_active_company_mutation_gate
  before insert or update or delete on public.sds_upload_attestations
  for each row execute function public.assert_active_company_for_authenticated_mutation();

alter table public.sds_registration_requests enable row level security;
alter table public.sds_registration_requests force row level security;
alter table public.sds_upload_attestations enable row level security;
alter table public.sds_upload_attestations force row level security;

revoke all on table
  public.sds_registration_requests,
  public.sds_upload_attestations
  from public, anon, authenticated, service_role;

create or replace function public.storyops_material_unit(p_unit text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select case lower(btrim(p_unit))
    when 'oz' then 'oz'
    when 'ounce' then 'oz'
    when 'ounces' then 'oz'
    when 'gal' then 'gal'
    when 'gallon' then 'gal'
    when 'gallons' then 'gal'
    when 'lb' then 'lb'
    when 'pound' then 'lb'
    when 'pounds' then 'lb'
    when 'each' then 'each'
    when 'item' then 'each'
    when 'unit' then 'each'
    else null
  end
$$;

revoke all on function public.storyops_material_unit(text)
  from public, anon, authenticated, service_role;

create or replace function public.protect_storyops_immutable_sds()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'STORYOPS_SDS_VERSION_IMMUTABLE';
end;
$$;

revoke all on function public.protect_storyops_immutable_sds()
  from public, anon, authenticated, service_role;

create trigger sds_documents_immutable_version
  before update or delete on public.sds_documents
  for each row execute function public.protect_storyops_immutable_sds();

create or replace function public.protect_storyops_sds_upload_attestation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'STORYOPS_SDS_ATTESTATION_IMMUTABLE';
  end if;
  if old.consumed_at is not null
    or new.consumed_at is null
    or to_jsonb(new) - 'consumed_at'
      <> to_jsonb(old) - 'consumed_at'
  then
    raise exception 'STORYOPS_SDS_ATTESTATION_IMMUTABLE';
  end if;
  return new;
end;
$$;

revoke all on function public.protect_storyops_sds_upload_attestation()
  from public, anon, authenticated, service_role;

create trigger sds_upload_attestations_immutable
  before update or delete on public.sds_upload_attestations
  for each row execute function public.protect_storyops_sds_upload_attestation();

create or replace function public.validate_storyops_material_sds_binding()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  document_row public.sds_documents%rowtype;
begin
  if new.sds_document_id is null then
    if new.sds_document_version is not null then
      raise exception 'STORYOPS_MATERIAL_SDS_POINTER_INCOMPLETE';
    end if;
    return new;
  end if;
  if not new.requires_sds
    or new.expected_sds_checksum_sha256 is null
    or new.configuration_material_key is null
  then
    raise exception 'STORYOPS_MATERIAL_SDS_NOT_REQUIRED';
  end if;
  select *
  into document_row
  from public.sds_documents document
  where document.id = new.sds_document_id
    and document.company_id = new.company_id;
  if document_row.id is null
    or document_row.registration_source <> 'owner_review_v1'
    or document_row.document_version <> new.sds_document_version
    or document_row.configuration_material_key <> new.configuration_material_key
    or document_row.configuration_revision <> new.configuration_revision
    or document_row.configuration_hash <> new.configuration_hash
    or document_row.checksum_sha256 <> new.expected_sds_checksum_sha256
    or document_row.reviewed_at is null
    or document_row.reviewed_by is null
    or document_row.storage_verified_at is null
  then
    raise exception 'STORYOPS_MATERIAL_SDS_BINDING_MISMATCH';
  end if;
  return new;
end;
$$;

revoke all on function public.validate_storyops_material_sds_binding()
  from public, anon, authenticated, service_role;

create trigger materials_exact_sds_binding
  before insert or update on public.materials
  for each row execute function public.validate_storyops_material_sds_binding();

create or replace function public.assert_storyops_material_usage_sds()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1
    from public.materials material
    left join public.sds_documents document
      on document.id = material.sds_document_id
     and document.company_id = material.company_id
    left join public.company_operating_baseline_publications publication
      on publication.id = material.operating_baseline_id
     and publication.company_id = material.company_id
     and publication.status = 'active'
    where material.id = new.material_id
      and material.company_id = new.company_id
      and material.requires_sds
      and (
        document.id is null
        or document.registration_source <> 'owner_review_v1'
        or document.document_version is distinct from material.sds_document_version
        or document.configuration_material_key
          is distinct from material.configuration_material_key
        or document.configuration_revision is distinct from material.configuration_revision
        or document.configuration_hash is distinct from material.configuration_hash
        or document.checksum_sha256 is distinct from material.expected_sds_checksum_sha256
        or document.reviewed_at is null
        or document.reviewed_by is null
        or document.storage_verified_at is null
        or publication.id is null
        or publication.configuration_revision <> material.configuration_revision
        or publication.configuration_hash <> material.configuration_hash
        or publication.baseline_hash <> material.operating_baseline_hash
      )
  ) then
    raise exception 'STORYOPS_MATERIAL_USAGE_REQUIRES_CURRENT_REGISTERED_SDS';
  end if;
  return new;
end;
$$;

revoke all on function public.assert_storyops_material_usage_sds()
  from public, anon, authenticated, service_role;

create trigger material_usage_current_sds_gate
  before insert on public.material_usage
  for each row execute function public.assert_storyops_material_usage_sds();

create or replace function public.materialize_storyops_operating_materials(
  p_publication_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  publication_row public.company_operating_baseline_publications%rowtype;
  configuration_row public.company_configuration_versions%rowtype;
  configured_material jsonb;
  normalized_unit text;
  expected_checksum text;
  exact_sds_id uuid;
  exact_sds_version integer;
begin
  select *
  into publication_row
  from public.company_operating_baseline_publications publication
  where publication.id = p_publication_id
  for share;
  if publication_row.id is null then
    raise exception 'STORYOPS_MATERIAL_BASELINE_NOT_FOUND';
  end if;
  select *
  into configuration_row
  from public.company_configuration_versions configuration
  where configuration.id = publication_row.configuration_version_id
    and configuration.company_id = publication_row.company_id
    and configuration.revision = publication_row.configuration_revision
    and configuration.configuration_hash = publication_row.configuration_hash;
  if configuration_row.id is null then
    raise exception 'STORYOPS_MATERIAL_CONFIGURATION_MISMATCH';
  end if;
  if jsonb_typeof(configuration_row.configuration #> '{materials,catalog}') <> 'array' then
    raise exception 'STORYOPS_MATERIAL_CATALOG_MISSING';
  end if;

  update public.materials
  set
    active = false,
    sds_document_id = null,
    sds_document_version = null
  where company_id = publication_row.company_id
    and configuration_material_key is not null;

  for configured_material in
    select material
    from jsonb_array_elements(
      configuration_row.configuration #> '{materials,catalog}'
    ) material
    order by material ->> 'id'
  loop
    normalized_unit := public.storyops_material_unit(configured_material ->> 'unit');
    if normalized_unit is null then
      raise exception 'STORYOPS_MATERIAL_UNIT_UNSUPPORTED: %',
        configured_material ->> 'unit';
    end if;
    expected_checksum := nullif(
      lower(btrim(configured_material ->> 'sdsChecksumSha256')),
      ''
    );
    if coalesce((configured_material ->> 'requiresSds')::boolean, false)
      and (
        configured_material ->> 'sdsStatus' <> 'approved'
        or expected_checksum is null
        or expected_checksum !~ '^[a-f0-9]{64}$'
      )
    then
      raise exception 'STORYOPS_MATERIAL_CONFIGURED_SDS_INCOMPLETE: %',
        configured_material ->> 'id';
    end if;

    exact_sds_id := null;
    exact_sds_version := null;
    select document.id, document.document_version
    into exact_sds_id, exact_sds_version
    from public.sds_documents document
    where document.company_id = publication_row.company_id
      and document.configuration_material_key = configured_material ->> 'id'
      and document.configuration_revision = publication_row.configuration_revision
      and document.configuration_hash = publication_row.configuration_hash
      and document.checksum_sha256 = expected_checksum
      and document.registration_source = 'owner_review_v1'
    order by document.document_version desc
    limit 1;

    insert into public.materials(
      company_id,
      sku,
      name,
      unit,
      quantity_on_hand,
      reorder_point,
      sds_document_id,
      requires_sds,
      active,
      configuration_material_key,
      configuration_revision,
      configuration_hash,
      operating_baseline_id,
      operating_baseline_hash,
      expected_sds_checksum_sha256,
      sds_document_version
    )
    values (
      publication_row.company_id,
      'CONFIG-' || upper(configured_material ->> 'id'),
      btrim(configured_material ->> 'name'),
      normalized_unit,
      0,
      0,
      exact_sds_id,
      (configured_material ->> 'requiresSds')::boolean,
      true,
      configured_material ->> 'id',
      publication_row.configuration_revision,
      publication_row.configuration_hash,
      publication_row.id,
      publication_row.baseline_hash,
      case
        when (configured_material ->> 'requiresSds')::boolean then expected_checksum
        else null
      end,
      exact_sds_version
    )
    on conflict (company_id, configuration_material_key)
      where configuration_material_key is not null
    do update set
      sku = excluded.sku,
      name = excluded.name,
      unit = excluded.unit,
      sds_document_id = excluded.sds_document_id,
      requires_sds = excluded.requires_sds,
      active = excluded.active,
      configuration_revision = excluded.configuration_revision,
      configuration_hash = excluded.configuration_hash,
      operating_baseline_id = excluded.operating_baseline_id,
      operating_baseline_hash = excluded.operating_baseline_hash,
      expected_sds_checksum_sha256 = excluded.expected_sds_checksum_sha256,
      sds_document_version = excluded.sds_document_version;
  end loop;
end;
$$;

revoke all on function public.materialize_storyops_operating_materials(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.materialize_storyops_operating_materials_trigger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.materialize_storyops_operating_materials(new.id);
  return new;
end;
$$;

revoke all on function public.materialize_storyops_operating_materials_trigger()
  from public, anon, authenticated, service_role;

create trigger company_operating_baseline_materials
  after insert on public.company_operating_baseline_publications
  for each row execute function public.materialize_storyops_operating_materials_trigger();

do $$
declare
  publication_id uuid;
begin
  for publication_id in
    select publication.id
    from public.company_operating_baseline_publications publication
    where publication.status = 'active'
    order by publication.company_id, publication.activated_at, publication.id
  loop
    perform public.materialize_storyops_operating_materials(publication_id);
  end loop;
end;
$$;

create or replace function private.storyops_sds_registration_receipt(
  p_request public.sds_registration_requests,
  p_replayed boolean
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'schemaVersion', 'storyops-material-sds-registration-v1',
    'status', p_request.status,
    'companyId', p_request.company_id,
    'commandId', p_request.command_id,
    'requestHash', p_request.request_hash,
    'registrationRequestId', p_request.id,
    'materialId', p_request.material_id,
    'materialConfigurationKey', p_request.configuration_material_key,
    'materialVersion', p_request.material_version,
    'configurationRevision', p_request.configuration_revision,
    'configurationHash', p_request.configuration_hash,
    'baselineId', p_request.operating_baseline_id,
    'baselineHash', p_request.operating_baseline_hash,
    'documentVersion', p_request.document_version,
    'objectPath', p_request.object_path,
    'contentType', p_request.content_type,
    'byteSize', p_request.byte_size,
    'checksumSha256', p_request.checksum_sha256,
    'expiresAt', p_request.expires_at,
    'sdsDocumentId', p_request.sds_document_id,
    'replayed', p_replayed,
    'serverTime', now()
  )
$$;

revoke all on function private.storyops_sds_registration_receipt(
  public.sds_registration_requests,
  boolean
) from public, anon, authenticated, service_role;

create or replace function public.load_storyops_sds_upload_for_attestation(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  request_row public.sds_registration_requests%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'STORYOPS_SDS_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  if p_company_id is null
    or p_actor_user_id is null
    or p_command_id is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or not exists (
      select 1
      from public.company_memberships membership
      join public.companies company
        on company.id = membership.company_id
       and company.status in ('setup', 'active')
      where membership.company_id = p_company_id
        and membership.user_id = p_actor_user_id
        and membership.role = 'owner'
        and membership.active
    )
  then
    raise exception 'STORYOPS_SDS_TRUSTED_ACTOR_MISMATCH';
  end if;
  select *
  into request_row
  from public.sds_registration_requests request
  where request.company_id = p_company_id
    and request.command_id = p_command_id
    and request.request_hash = p_request_hash
    and request.prepared_by = p_actor_user_id;
  if request_row.id is null then
    raise exception 'STORYOPS_SDS_PREPARATION_NOT_FOUND';
  end if;
  if request_row.status <> 'prepared' or request_row.expires_at <= now() then
    raise exception 'STORYOPS_SDS_PREPARATION_EXPIRED';
  end if;
  return jsonb_build_object(
    'schemaVersion', 'storyops-sds-upload-verification-v1',
    'companyId', request_row.company_id,
    'actorUserId', request_row.prepared_by,
    'commandId', request_row.command_id,
    'requestHash', request_row.request_hash,
    'registrationRequestId', request_row.id,
    'objectPath', request_row.object_path,
    'contentType', request_row.content_type,
    'byteSize', request_row.byte_size,
    'checksumSha256', request_row.checksum_sha256,
    'expiresAt', request_row.expires_at
  );
end;
$$;

create or replace function public.attest_storyops_sds_upload(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_observed_checksum_sha256 text,
  p_observed_byte_size bigint,
  p_observed_content_type text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  request_row public.sds_registration_requests%rowtype;
  attestation_row public.sds_upload_attestations%rowtype;
  attestation_id_value uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'STORYOPS_SDS_TRUSTED_BOUNDARY_REQUIRED';
  end if;
  if p_company_id is null
    or p_actor_user_id is null
    or p_command_id is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_observed_checksum_sha256 !~ '^[a-f0-9]{64}$'
    or p_observed_byte_size not between 5 and 10485760
    or p_observed_content_type <> 'application/pdf'
  then
    raise exception 'STORYOPS_SDS_INVALID_ATTESTATION';
  end if;
  select *
  into request_row
  from public.sds_registration_requests request
  where request.company_id = p_company_id
    and request.command_id = p_command_id
    and request.request_hash = p_request_hash
    and request.prepared_by = p_actor_user_id
  for update;
  if request_row.id is null
    or request_row.status <> 'prepared'
    or request_row.expires_at <= now()
    or not exists (
      select 1
      from public.company_memberships membership
      join public.companies company
        on company.id = membership.company_id
       and company.status in ('setup', 'active')
      where membership.company_id = p_company_id
        and membership.user_id = p_actor_user_id
        and membership.role = 'owner'
        and membership.active
    )
  then
    raise exception 'STORYOPS_SDS_ATTESTATION_REQUEST_MISMATCH';
  end if;
  if p_observed_checksum_sha256 <> request_row.checksum_sha256
    or p_observed_byte_size <> request_row.byte_size
    or p_observed_content_type <> request_row.content_type
  then
    raise exception 'STORYOPS_SDS_BYTES_MISMATCH';
  end if;
  if not exists (
    select 1
    from storage.objects object
    where object.bucket_id = 'sds'
      and object.name = request_row.object_path
      and coalesce(
        object.metadata ->> 'mimetype',
        object.metadata ->> 'contentType'
      ) = request_row.content_type
      and coalesce(object.metadata ->> 'size', '') ~ '^[0-9]{1,12}$'
      and (object.metadata ->> 'size')::bigint = request_row.byte_size
  ) then
    raise exception 'STORYOPS_SDS_DURABLE_PRIVATE_OBJECT_MISMATCH';
  end if;

  insert into public.sds_upload_attestations(
    company_id,
    registration_request_id,
    command_id,
    actor_user_id,
    object_path,
    expected_checksum_sha256,
    observed_checksum_sha256,
    byte_size,
    content_type
  )
  values (
    p_company_id,
    request_row.id,
    p_command_id,
    p_actor_user_id,
    request_row.object_path,
    request_row.checksum_sha256,
    p_observed_checksum_sha256,
    p_observed_byte_size,
    p_observed_content_type
  )
  on conflict (company_id, registration_request_id) do nothing
  returning id into attestation_id_value;

  select *
  into attestation_row
  from public.sds_upload_attestations attestation
  where attestation.company_id = p_company_id
    and attestation.registration_request_id = request_row.id;
  if attestation_row.id is null
    or attestation_row.command_id <> p_command_id
    or attestation_row.actor_user_id <> p_actor_user_id
    or attestation_row.object_path <> request_row.object_path
    or attestation_row.expected_checksum_sha256 <> request_row.checksum_sha256
    or attestation_row.observed_checksum_sha256 <> p_observed_checksum_sha256
    or attestation_row.byte_size <> p_observed_byte_size
    or attestation_row.content_type <> p_observed_content_type
  then
    raise exception 'STORYOPS_SDS_ATTESTATION_CONFLICT';
  end if;

  return jsonb_build_object(
    'schemaVersion', 'storyops-sds-upload-attestation-v1',
    'status', 'attested',
    'companyId', p_company_id,
    'commandId', p_command_id,
    'requestHash', p_request_hash,
    'registrationRequestId', request_row.id,
    'objectPath', request_row.object_path,
    'contentType', request_row.content_type,
    'byteSize', request_row.byte_size,
    'checksumSha256', request_row.checksum_sha256,
    'attestedAt', attestation_row.attested_at,
    'replayed', attestation_id_value is null
  );
end;
$$;

revoke all on function public.load_storyops_sds_upload_for_attestation(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_sds_upload_for_attestation(
  uuid, uuid, uuid, text
) to service_role;

revoke all on function public.attest_storyops_sds_upload(
  uuid, uuid, uuid, text, text, bigint, text
) from public, anon, authenticated, service_role;
grant execute on function public.attest_storyops_sds_upload(
  uuid, uuid, uuid, text, text, bigint, text
) to service_role;

create or replace function public.prepare_storyops_material_sds_registration(
  p_company_id uuid,
  p_command_id uuid,
  p_material_configuration_key text,
  p_product_name text,
  p_manufacturer text,
  p_revision_date date,
  p_content_type text,
  p_byte_size bigint,
  p_checksum_sha256 text,
  p_review_reference text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role text;
  publication_row public.company_operating_baseline_publications%rowtype;
  configuration_row public.company_configuration_versions%rowtype;
  configured_material jsonb;
  material_row public.materials%rowtype;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  request_row public.sds_registration_requests%rowtype;
  effective_request_hash text;
  next_document_version integer;
  object_path_value text;
begin
  if actor_user_id is null then
    raise exception 'STORYOPS_SDS_AUTHENTICATION_REQUIRED';
  end if;
  if p_company_id is null
    or p_command_id is null
    or p_material_configuration_key !~ '^[a-z0-9][a-z0-9-]{1,63}$'
    or length(btrim(coalesce(p_product_name, ''))) not between 2 and 120
    or p_product_name ~ '[[:cntrl:]]'
    or length(btrim(coalesce(p_manufacturer, ''))) not between 2 and 120
    or p_manufacturer ~ '[[:cntrl:]]'
    or p_revision_date is null
    or p_content_type <> 'application/pdf'
    or p_byte_size not between 5 and 10485760
    or p_checksum_sha256 !~ '^[a-f0-9]{64}$'
    or length(btrim(coalesce(p_review_reference, ''))) not between 5 and 240
    or p_review_reference ~ '[[:cntrl:]]'
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'STORYOPS_SDS_INVALID_REQUEST';
  end if;

  select membership.role::text
  into actor_role
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
   and company.status in ('setup', 'active')
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role <> 'owner' then
    raise exception 'STORYOPS_SDS_ACTIVE_OWNER_REQUIRED';
  end if;

  effective_request_hash := encode(
    extensions.digest(
      array_to_string(
        array[
          'storyops-material-sds-registration-v1',
          p_company_id::text,
          p_material_configuration_key,
          btrim(p_product_name),
          btrim(p_manufacturer),
          p_revision_date::text,
          p_content_type,
          p_byte_size::text,
          p_checksum_sha256,
          btrim(p_review_reference)
        ],
        chr(31)
      ),
      'sha256'
    ),
    'hex'
  );
  if p_request_hash <> effective_request_hash then
    raise exception 'STORYOPS_SDS_REQUEST_HASH_MISMATCH';
  end if;

  insert into public.idempotency_keys(
    company_id,
    scope,
    key,
    request_hash,
    expires_at
  )
  values (
    p_company_id,
    'material-sds-registration-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '2555 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys key_record
    where key_record.company_id = p_company_id
      and key_record.scope = 'material-sds-registration-v1'
      and key_record.key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception 'STORYOPS_SDS_COMMAND_CONFLICT';
    end if;
    if reservation.status = 'completed' and reservation.response is not null then
      return jsonb_set(reservation.response, '{replayed}', 'true'::jsonb);
    end if;
    select *
    into request_row
    from public.sds_registration_requests request
    where request.company_id = p_company_id
      and request.command_id = p_command_id;
    if request_row.id is null then
      raise exception 'STORYOPS_SDS_COMMAND_IN_PROGRESS';
    end if;
    if request_row.status = 'expired' then
      raise exception 'STORYOPS_SDS_PREPARATION_EXPIRED';
    end if;
    return private.storyops_sds_registration_receipt(request_row, true);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-material-sds:' || p_company_id::text || ':' ||
      p_material_configuration_key,
    0
  ));

  update public.sds_registration_requests
  set status = 'expired'
  where company_id = p_company_id
    and configuration_material_key = p_material_configuration_key
    and status = 'prepared'
    and expires_at <= now();

  if exists (
    select 1
    from public.sds_registration_requests request
    where request.company_id = p_company_id
      and request.configuration_material_key = p_material_configuration_key
      and request.status = 'prepared'
      and request.expires_at > now()
  ) then
    raise exception 'STORYOPS_SDS_REGISTRATION_ALREADY_PREPARED';
  end if;

  select *
  into configuration_row
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.status in ('draft', 'published')
  order by
    case configuration.status when 'draft' then 0 else 1 end,
    configuration.revision desc
  limit 1
  for share;
  if configuration_row.id is null then
    raise exception 'STORYOPS_SDS_SAVED_CONFIGURATION_REQUIRED';
  end if;

  select *
  into publication_row
  from public.company_operating_baseline_publications publication
  where publication.company_id = p_company_id
    and publication.status = 'active'
    and publication.configuration_revision = configuration_row.revision
    and publication.configuration_hash = configuration_row.configuration_hash
  for share;
  select material
  into configured_material
  from jsonb_array_elements(
    configuration_row.configuration #> '{materials,catalog}'
  ) material
  where material ->> 'id' = p_material_configuration_key;
  if configured_material is null
    or not coalesce((configured_material ->> 'requiresSds')::boolean, false)
    or configured_material ->> 'sdsStatus' <> 'approved'
    or configured_material ->> 'sdsChecksumSha256' <> p_checksum_sha256
  then
    raise exception 'STORYOPS_SDS_EXACT_CONFIGURED_MATERIAL_REQUIRED';
  end if;
  if exists (
    select 1
    from public.sds_documents document
    where document.company_id = p_company_id
      and document.configuration_material_key = p_material_configuration_key
      and document.configuration_revision = configuration_row.revision
      and document.configuration_hash = configuration_row.configuration_hash
      and document.checksum_sha256 = p_checksum_sha256
      and document.registration_source = 'owner_review_v1'
  ) then
    raise exception 'STORYOPS_SDS_EXACT_VERSION_ALREADY_REGISTERED';
  end if;

  if publication_row.id is not null then
    select *
    into material_row
    from public.materials material
    where material.company_id = p_company_id
      and material.configuration_material_key = p_material_configuration_key
      and material.configuration_revision = configuration_row.revision
      and material.configuration_hash = configuration_row.configuration_hash
      and material.operating_baseline_id = publication_row.id
      and material.operating_baseline_hash = publication_row.baseline_hash
      and material.requires_sds
      and material.active
    for update;
    if material_row.id is null
      or material_row.expected_sds_checksum_sha256 <> p_checksum_sha256
    then
      raise exception 'STORYOPS_SDS_MATERIAL_NOT_MATERIALIZED';
    end if;
  end if;

  select coalesce(max(version_record.document_version), 0) + 1
  into next_document_version
  from (
    select document.document_version
    from public.sds_documents document
    where document.company_id = p_company_id
      and document.configuration_material_key = p_material_configuration_key
      and document.registration_source = 'owner_review_v1'
    union all
    select request.document_version
    from public.sds_registration_requests request
    where request.company_id = p_company_id
      and request.configuration_material_key = p_material_configuration_key
  ) version_record;

  object_path_value := concat(
    p_company_id::text,
    '/materials/',
    p_material_configuration_key,
    '/sds/v',
    next_document_version::text,
    '-',
    p_checksum_sha256,
    '.pdf'
  );

  insert into public.sds_registration_requests(
    company_id,
    command_id,
    request_hash,
    prepared_by,
    material_id,
    material_version,
    configuration_material_key,
    configuration_revision,
    configuration_hash,
    operating_baseline_id,
    operating_baseline_hash,
    document_version,
    product_name,
    manufacturer,
    revision_date,
    object_path,
    content_type,
    byte_size,
    checksum_sha256,
    review_reference,
    status,
    expires_at
  )
  values (
    p_company_id,
    p_command_id,
    effective_request_hash,
    actor_user_id,
    material_row.id,
    material_row.version,
    p_material_configuration_key,
    configuration_row.revision,
    configuration_row.configuration_hash,
    publication_row.id,
    publication_row.baseline_hash,
    next_document_version,
    btrim(p_product_name),
    btrim(p_manufacturer),
    p_revision_date,
    object_path_value,
    p_content_type,
    p_byte_size,
    p_checksum_sha256,
    btrim(p_review_reference),
    'prepared',
    now() + interval '2 hours'
  )
  returning * into request_row;

  insert into public.audit_events(
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data,
    request_id
  )
  values (
    p_company_id,
    'user',
    actor_user_id::text,
    'material.sds_registration_prepared',
    'sds_registration_request',
    request_row.id,
    jsonb_build_object(
      'materialId', request_row.material_id,
      'materialConfigurationKey', request_row.configuration_material_key,
      'configurationRevision', request_row.configuration_revision,
      'configurationHash', request_row.configuration_hash,
      'baselineId', request_row.operating_baseline_id,
      'baselineHash', request_row.operating_baseline_hash,
      'documentVersion', request_row.document_version,
      'objectPath', request_row.object_path,
      'contentType', request_row.content_type,
      'byteSize', request_row.byte_size,
      'checksumSha256', request_row.checksum_sha256,
      'reviewReference', request_row.review_reference
    ),
    p_command_id::text
  );

  return private.storyops_sds_registration_receipt(request_row, false);
end;
$$;

create or replace function public.finalize_storyops_material_sds_registration(
  p_company_id uuid,
  p_command_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role text;
  request_row public.sds_registration_requests%rowtype;
  publication_row public.company_operating_baseline_publications%rowtype;
  configuration_row public.company_configuration_versions%rowtype;
  attestation_row public.sds_upload_attestations%rowtype;
  object_row storage.objects%rowtype;
  document_id_value uuid := gen_random_uuid();
  response_value jsonb;
begin
  if actor_user_id is null then
    raise exception 'STORYOPS_SDS_AUTHENTICATION_REQUIRED';
  end if;
  if p_company_id is null
    or p_command_id is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'STORYOPS_SDS_INVALID_FINALIZATION';
  end if;
  select membership.role::text
  into actor_role
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
   and company.status in ('setup', 'active')
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role <> 'owner' then
    raise exception 'STORYOPS_SDS_ACTIVE_OWNER_REQUIRED';
  end if;

  select *
  into request_row
  from public.sds_registration_requests request
  where request.company_id = p_company_id
    and request.command_id = p_command_id
  for update;
  if request_row.id is null
    or request_row.request_hash <> p_request_hash
    or request_row.prepared_by <> actor_user_id
  then
    raise exception 'STORYOPS_SDS_PREPARATION_NOT_FOUND';
  end if;
  if request_row.status = 'registered' then
    return private.storyops_sds_registration_receipt(request_row, true);
  end if;
  if request_row.status <> 'prepared' or request_row.expires_at <= now() then
    raise exception 'STORYOPS_SDS_PREPARATION_EXPIRED';
  end if;

  select *
  into configuration_row
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.revision = request_row.configuration_revision
    and configuration.configuration_hash = request_row.configuration_hash
    and configuration.status in ('draft', 'published')
  for share;
  if configuration_row.id is null then
    raise exception 'STORYOPS_SDS_PREPARATION_STALE';
  end if;
  if request_row.operating_baseline_id is not null then
    select *
    into publication_row
    from public.company_operating_baseline_publications publication
    where publication.id = request_row.operating_baseline_id
      and publication.company_id = p_company_id
      and publication.status = 'active'
      and publication.configuration_revision = request_row.configuration_revision
      and publication.configuration_hash = request_row.configuration_hash
      and publication.baseline_hash = request_row.operating_baseline_hash
    for share;
    if publication_row.id is null then
      raise exception 'STORYOPS_SDS_PREPARATION_STALE';
    end if;
  end if;

  select *
  into object_row
  from storage.objects object
  where object.bucket_id = 'sds'
    and object.name = request_row.object_path;
  if object_row.id is null
    or coalesce(
      object_row.metadata ->> 'mimetype',
      object_row.metadata ->> 'contentType'
    ) <> request_row.content_type
    or coalesce(object_row.metadata ->> 'size', '') !~ '^[0-9]{1,12}$'
    or (object_row.metadata ->> 'size')::bigint <> request_row.byte_size
  then
    raise exception 'STORYOPS_SDS_DURABLE_PRIVATE_OBJECT_MISMATCH';
  end if;

  select *
  into attestation_row
  from public.sds_upload_attestations attestation
  where attestation.company_id = p_company_id
    and attestation.registration_request_id = request_row.id
    and attestation.command_id = p_command_id
    and attestation.actor_user_id = request_row.prepared_by
    and attestation.object_path = request_row.object_path
    and attestation.expected_checksum_sha256 = request_row.checksum_sha256
    and attestation.observed_checksum_sha256 = request_row.checksum_sha256
    and attestation.byte_size = request_row.byte_size
    and attestation.content_type = request_row.content_type
    and attestation.consumed_at is null
  for update;
  if attestation_row.id is null then
    raise exception 'STORYOPS_SDS_TRUSTED_BYTE_ATTESTATION_REQUIRED';
  end if;

  insert into public.sds_documents(
    id,
    company_id,
    product_name,
    manufacturer,
    revision_date,
    storage_object_path,
    checksum_sha256,
    reviewed_at,
    reviewed_by,
    configuration_material_key,
    configuration_revision,
    configuration_hash,
    operating_baseline_id,
    operating_baseline_hash,
    document_version,
    content_type,
    byte_size,
    review_reference,
    registration_command_id,
    request_hash,
    storage_verified_at,
    registration_source
  )
  values (
    document_id_value,
    p_company_id,
    request_row.product_name,
    request_row.manufacturer,
    request_row.revision_date,
    request_row.object_path,
    request_row.checksum_sha256,
    now(),
    actor_user_id,
    request_row.configuration_material_key,
    request_row.configuration_revision,
    request_row.configuration_hash,
    request_row.operating_baseline_id,
    request_row.operating_baseline_hash,
    request_row.document_version,
    request_row.content_type,
    request_row.byte_size,
    request_row.review_reference,
    request_row.command_id,
    request_row.request_hash,
    attestation_row.attested_at,
    'owner_review_v1'
  );

  if request_row.material_id is not null then
    update public.materials material
    set
      sds_document_id = document_id_value,
      sds_document_version = request_row.document_version
    where material.id = request_row.material_id
      and material.company_id = p_company_id
      and material.version = request_row.material_version
      and material.configuration_material_key = request_row.configuration_material_key
      and material.configuration_revision = request_row.configuration_revision
      and material.configuration_hash = request_row.configuration_hash
      and material.operating_baseline_id = request_row.operating_baseline_id
      and material.operating_baseline_hash = request_row.operating_baseline_hash
      and material.expected_sds_checksum_sha256 = request_row.checksum_sha256;
    if not found then
      raise exception 'STORYOPS_SDS_MATERIAL_VERSION_CONFLICT';
    end if;
  end if;

  update public.sds_registration_requests request
  set
    status = 'registered',
    sds_document_id = document_id_value,
    completed_at = now()
  where request.id = request_row.id
  returning * into request_row;

  update public.sds_upload_attestations attestation
  set consumed_at = now()
  where attestation.id = attestation_row.id
    and attestation.consumed_at is null;
  if not found then
    raise exception 'STORYOPS_SDS_ATTESTATION_CONSUMPTION_CONFLICT';
  end if;

  response_value := private.storyops_sds_registration_receipt(request_row, false);
  update public.idempotency_keys key_record
  set
    status = 'completed',
    response = response_value,
    completed_at = now(),
    updated_at = now()
  where key_record.company_id = p_company_id
    and key_record.scope = 'material-sds-registration-v1'
    and key_record.key = p_command_id::text
    and key_record.request_hash = p_request_hash
    and key_record.status = 'in_progress';
  if not found then
    raise exception 'STORYOPS_SDS_IDEMPOTENCY_FINALIZATION_CONFLICT';
  end if;

  insert into public.audit_events(
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data,
    request_id
  )
  values (
    p_company_id,
    'user',
    actor_user_id::text,
    'material.sds_registered',
    'sds_document',
    document_id_value,
    jsonb_build_object(
      'materialId', request_row.material_id,
      'materialConfigurationKey', request_row.configuration_material_key,
      'configurationRevision', request_row.configuration_revision,
      'configurationHash', request_row.configuration_hash,
      'baselineId', request_row.operating_baseline_id,
      'baselineHash', request_row.operating_baseline_hash,
      'documentVersion', request_row.document_version,
      'objectPath', request_row.object_path,
      'contentType', request_row.content_type,
      'byteSize', request_row.byte_size,
      'checksumSha256', request_row.checksum_sha256,
      'reviewReference', request_row.review_reference,
      'customerContacted', false,
      'chemicalInstructionsCreated', false
    ),
    p_command_id::text
  );
  return response_value;
end;
$$;

create or replace function public.get_storyops_material_sds_registry(
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
  configuration_row public.company_configuration_versions%rowtype;
  publication_row public.company_operating_baseline_publications%rowtype;
begin
  if actor_user_id is null then
    raise exception 'STORYOPS_SDS_AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = actor_user_id
      and membership.active
      and membership.role = 'owner'
  ) then
    raise exception 'STORYOPS_SDS_OWNER_READ_REQUIRED';
  end if;
  select *
  into configuration_row
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.status in ('draft', 'published')
  order by
    case configuration.status when 'draft' then 0 else 1 end,
    configuration.revision desc
  limit 1;
  if configuration_row.id is null then
    raise exception 'STORYOPS_SDS_SAVED_CONFIGURATION_REQUIRED';
  end if;
  select *
  into publication_row
  from public.company_operating_baseline_publications publication
  where publication.company_id = p_company_id
    and publication.status = 'active'
    and publication.configuration_revision = configuration_row.revision
    and publication.configuration_hash = configuration_row.configuration_hash;

  return jsonb_build_object(
    'schemaVersion', 'storyops-material-sds-registry-v1',
    'companyId', p_company_id,
    'baselineId', publication_row.id,
    'baselineHash', publication_row.baseline_hash,
    'configurationRevision', configuration_row.revision,
    'configurationHash', configuration_row.configuration_hash,
    'materials',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'materialId', material.id,
          'materialVersion', material.version,
          'configurationKey', configured_material ->> 'id',
          'configurationRevision', configuration_row.revision,
          'configurationHash', configuration_row.configuration_hash,
          'baselineId', publication_row.id,
          'baselineHash', publication_row.baseline_hash,
          'name', configured_material ->> 'name',
          'unit', public.storyops_material_unit(configured_material ->> 'unit'),
          'requiresSds',
            coalesce((configured_material ->> 'requiresSds')::boolean, false),
          'active',
            coalesce(material.active, false) and publication_row.id is not null,
          'registrationStatus',
            case
              when not coalesce(
                (configured_material ->> 'requiresSds')::boolean,
                false
              ) then 'not_required'
              when document.id is not null then 'registered'
              else 'registration_required'
            end,
          'expectedChecksumSha256',
            nullif(configured_material ->> 'sdsChecksumSha256', ''),
          'sdsDocument',
            case
              when document.id is null then null
              else jsonb_build_object(
                'id', document.id,
                'documentVersion', document.document_version,
                'productName', document.product_name,
                'manufacturer', document.manufacturer,
                'revisionDate', document.revision_date,
                'contentType', document.content_type,
                'byteSize', document.byte_size,
                'checksumSha256', document.checksum_sha256,
                'storageObjectPath', document.storage_object_path,
                'reviewedAt', document.reviewed_at,
                'reviewedByUserId', document.reviewed_by,
                'reviewReference', document.review_reference,
                'configurationRevision', document.configuration_revision,
                'configurationHash', document.configuration_hash,
                'baselineId', document.operating_baseline_id,
                'baselineHash', document.operating_baseline_hash
              )
            end
        )
        order by configured_material ->> 'name', configured_material ->> 'id'
      )
      from jsonb_array_elements(
        configuration_row.configuration #> '{materials,catalog}'
      ) configured_material
      left join public.materials material
        on material.company_id = p_company_id
       and material.configuration_material_key = configured_material ->> 'id'
       and material.configuration_revision = configuration_row.revision
       and material.configuration_hash = configuration_row.configuration_hash
       and material.operating_baseline_id = publication_row.id
      left join lateral (
        select exact_document.*
        from public.sds_documents exact_document
        where exact_document.company_id = p_company_id
          and exact_document.configuration_material_key
            = configured_material ->> 'id'
          and exact_document.configuration_revision = configuration_row.revision
          and exact_document.configuration_hash = configuration_row.configuration_hash
          and exact_document.checksum_sha256
            = nullif(configured_material ->> 'sdsChecksumSha256', '')
          and exact_document.registration_source = 'owner_review_v1'
          and exact_document.reviewed_at is not null
          and exact_document.storage_verified_at is not null
        order by exact_document.document_version desc
        limit 1
      ) document on true
    ), '[]'::jsonb),
    'serverTime', now()
  );
end;
$$;

-- Republish the field projection so an SDS is visible only when it is the
-- current exact registered version. The prior field-packet projection remains
-- the source for packets, incidents, and checklist definitions.
alter function public.get_storyops_field_reference(uuid)
  rename to get_storyops_field_reference_v1_1;

revoke all on function public.get_storyops_field_reference_v1_1(uuid)
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
  base_reference jsonb;
begin
  base_reference := public.get_storyops_field_reference_v1_1(p_company_id);
  return jsonb_set(
    base_reference,
    '{materials}',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', material.id,
          'name', material.name,
          'unit', material.unit,
          'requiresSds', material.requires_sds,
          'version', material.version,
          'sdsDocument',
            case
              when document.id is null then null
              else jsonb_build_object(
                'id', document.id,
                'productName', document.product_name,
                'manufacturer', document.manufacturer,
                'revisionDate', document.revision_date,
                'reviewedAt', document.reviewed_at,
                'checksumSha256', document.checksum_sha256,
                'storageObjectPath', document.storage_object_path,
                'version', document.version,
                'documentVersion', document.document_version,
                'contentType', document.content_type,
                'byteSize', document.byte_size,
                'configurationRevision', document.configuration_revision,
                'configurationHash', document.configuration_hash,
                'baselineId', document.operating_baseline_id,
                'baselineHash', document.operating_baseline_hash
              )
            end
        )
        order by material.name, material.id
      )
      from public.materials material
      left join public.sds_documents document
        on document.id = material.sds_document_id
       and document.company_id = material.company_id
       and document.registration_source = 'owner_review_v1'
       and document.document_version = material.sds_document_version
       and document.configuration_material_key = material.configuration_material_key
       and document.configuration_revision = material.configuration_revision
       and document.configuration_hash = material.configuration_hash
       and document.checksum_sha256 = material.expected_sds_checksum_sha256
       and document.reviewed_at is not null
       and document.storage_verified_at is not null
      left join public.company_operating_baseline_publications publication
        on publication.id = material.operating_baseline_id
       and publication.company_id = material.company_id
       and publication.status = 'active'
       and publication.configuration_revision = material.configuration_revision
       and publication.configuration_hash = material.configuration_hash
       and publication.baseline_hash = material.operating_baseline_hash
      where material.company_id = p_company_id
        and material.active
        and (
          not material.requires_sds
          or (document.id is not null and publication.id is not null)
        )
    ), '[]'::jsonb),
    true
  );
end;
$$;

-- Both SDS commands can run while an owner is still in the setup lifecycle.
-- The same transaction-bound capability used by the finite setup/configuration
-- commands permits only the nested, revoked core to write tenant records.
alter function public.prepare_storyops_material_sds_registration(
  uuid, uuid, text, text, text, date, text, bigint, text, text, text
) rename to prepare_storyops_material_sds_registration_v1_core;

revoke all on function public.prepare_storyops_material_sds_registration_v1_core(
  uuid, uuid, text, text, text, date, text, bigint, text, text, text
) from public, anon, authenticated, service_role;

create or replace function public.prepare_storyops_material_sds_registration(
  p_company_id uuid,
  p_command_id uuid,
  p_material_configuration_key text,
  p_product_name text,
  p_manufacturer text,
  p_revision_date date,
  p_content_type text,
  p_byte_size bigint,
  p_checksum_sha256 text,
  p_review_reference text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  capability_token_value uuid := extensions.gen_random_uuid();
  result jsonb;
begin
  if auth.role() is distinct from 'authenticated' or actor_user_id is null then
    raise exception 'STORYOPS_SDS_AUTHENTICATION_REQUIRED';
  end if;
  insert into private.storyops_setup_capabilities(
    capability_token,
    backend_pid,
    transaction_id,
    company_id,
    actor_user_id
  )
  values (
    capability_token_value,
    pg_backend_pid(),
    txid_current(),
    p_company_id,
    actor_user_id
  );
  begin
    result := public.prepare_storyops_material_sds_registration_v1_core(
      p_company_id,
      p_command_id,
      p_material_configuration_key,
      p_product_name,
      p_manufacturer,
      p_revision_date,
      p_content_type,
      p_byte_size,
      p_checksum_sha256,
      p_review_reference,
      p_request_hash
    );
  exception when others then
    delete from private.storyops_setup_capabilities
    where capability_token = capability_token_value;
    raise;
  end;
  delete from private.storyops_setup_capabilities
  where capability_token = capability_token_value;
  return result;
end;
$$;

alter function public.finalize_storyops_material_sds_registration(
  uuid, uuid, text
) rename to finalize_storyops_material_sds_registration_v1_core;

revoke all on function public.finalize_storyops_material_sds_registration_v1_core(
  uuid, uuid, text
) from public, anon, authenticated, service_role;

create or replace function public.finalize_storyops_material_sds_registration(
  p_company_id uuid,
  p_command_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  capability_token_value uuid := extensions.gen_random_uuid();
  result jsonb;
begin
  if auth.role() is distinct from 'authenticated' or actor_user_id is null then
    raise exception 'STORYOPS_SDS_AUTHENTICATION_REQUIRED';
  end if;
  insert into private.storyops_setup_capabilities(
    capability_token,
    backend_pid,
    transaction_id,
    company_id,
    actor_user_id
  )
  values (
    capability_token_value,
    pg_backend_pid(),
    txid_current(),
    p_company_id,
    actor_user_id
  );
  begin
    result := public.finalize_storyops_material_sds_registration_v1_core(
      p_company_id,
      p_command_id,
      p_request_hash
    );
  exception when others then
    delete from private.storyops_setup_capabilities
    where capability_token = capability_token_value;
    raise;
  end;
  delete from private.storyops_setup_capabilities
  where capability_token = capability_token_value;
  return result;
end;
$$;

-- Live publication treats the private registered PDF as the authority. The
-- URL-shaped configuration field remains source/reference metadata only.
alter function public.publish_company_configuration(
  uuid, uuid, integer, text, text, text
) rename to publish_company_configuration_v1_2;

revoke all on function public.publish_company_configuration_v1_2(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated, service_role;

create or replace function public.publish_company_configuration(
  p_company_id uuid,
  p_command_id uuid,
  p_expected_revision integer,
  p_publication_mode text,
  p_review_reference text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  configuration_row public.company_configuration_versions%rowtype;
begin
  if p_publication_mode = 'live' then
    select *
    into configuration_row
    from public.company_configuration_versions configuration
    where configuration.company_id = p_company_id
      and configuration.revision = p_expected_revision
      -- Exact publication replays reach this wrapper after the immutable row
      -- has already transitioned to published. Revalidate the same SDS
      -- bindings, then let the versioned publication core prove that the
      -- command/payload is an exact replay.
      and configuration.status in ('draft', 'published');
    if configuration_row.id is null then
      raise exception 'STORYOPS_SDS_EXACT_DRAFT_REQUIRED';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(
        configuration_row.configuration #> '{materials,catalog}'
      ) configured_material
      where coalesce((configured_material ->> 'requiresSds')::boolean, false)
        and not exists (
          select 1
          from public.sds_documents document
          where document.company_id = p_company_id
            and document.configuration_material_key = configured_material ->> 'id'
            and document.configuration_revision = configuration_row.revision
            and document.configuration_hash = configuration_row.configuration_hash
            and document.checksum_sha256
              = configured_material ->> 'sdsChecksumSha256'
            and document.registration_source = 'owner_review_v1'
            and document.reviewed_at is not null
            and document.storage_verified_at is not null
        )
    ) then
      raise exception 'STORYOPS_SDS_LIVE_PUBLICATION_REQUIRES_EXACT_REGISTRATION';
    end if;
  end if;
  return public.publish_company_configuration_v1_2(
    p_company_id,
    p_command_id,
    p_expected_revision,
    p_publication_mode,
    p_review_reference,
    p_request_hash
  );
end;
$$;

alter function public.publish_company_operating_baseline(
  uuid, uuid, integer, text, text
) rename to publish_company_operating_baseline_v1_2;

revoke all on function public.publish_company_operating_baseline_v1_2(
  uuid, uuid, integer, text, text
) from public, anon, authenticated, service_role;

create or replace function public.publish_company_operating_baseline(
  p_company_id uuid,
  p_command_id uuid,
  p_configuration_revision integer,
  p_review_reference text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  configuration_row public.company_configuration_versions%rowtype;
begin
  select *
  into configuration_row
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.revision = p_configuration_revision
    and configuration.status = 'published'
    and configuration.publication_mode = 'live';
  if configuration_row.id is null then
    raise exception 'STORYOPS_SDS_EXACT_LIVE_CONFIGURATION_REQUIRED';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(
      configuration_row.configuration #> '{materials,catalog}'
    ) configured_material
    where coalesce((configured_material ->> 'requiresSds')::boolean, false)
      and not exists (
        select 1
        from public.sds_documents document
        where document.company_id = p_company_id
          and document.configuration_material_key = configured_material ->> 'id'
          and document.configuration_revision = configuration_row.revision
          and document.configuration_hash = configuration_row.configuration_hash
          and document.checksum_sha256 = configured_material ->> 'sdsChecksumSha256'
          and document.registration_source = 'owner_review_v1'
          and document.reviewed_at is not null
          and document.storage_verified_at is not null
      )
  ) then
    raise exception 'STORYOPS_SDS_BASELINE_REQUIRES_EXACT_REGISTRATION';
  end if;
  return public.publish_company_operating_baseline_v1_2(
    p_company_id,
    p_command_id,
    p_configuration_revision,
    p_review_reference,
    p_request_hash
  );
end;
$$;

revoke all on table public.sds_documents, public.materials
  from public, anon, authenticated, service_role;
grant select on table public.sds_documents, public.materials
  to authenticated;

revoke all on function public.prepare_storyops_material_sds_registration(
  uuid, uuid, text, text, text, date, text, bigint, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_storyops_material_sds_registration(
  uuid, uuid, text, text, text, date, text, bigint, text, text, text
) to authenticated;

revoke all on function public.finalize_storyops_material_sds_registration(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_storyops_material_sds_registration(
  uuid, uuid, text
) to authenticated;

revoke all on function public.get_storyops_material_sds_registry(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_storyops_material_sds_registry(uuid)
  to authenticated;

revoke all on function public.get_storyops_field_reference(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_storyops_field_reference(uuid)
  to authenticated;

revoke all on function public.publish_company_configuration(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.publish_company_configuration(
  uuid, uuid, integer, text, text, text
) to authenticated;

revoke all on function public.publish_company_operating_baseline(
  uuid, uuid, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.publish_company_operating_baseline(
  uuid, uuid, integer, text, text
) to authenticated;

create or replace function public.can_upload_storyops_sds_object(
  p_object_path text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  target_company_id uuid;
begin
  if auth.uid() is null
    or p_object_path is null
    or p_object_path !~
      '^[0-9a-f-]{36}/materials/[a-z0-9][a-z0-9-]{1,63}/sds/v[1-9][0-9]*-[a-f0-9]{64}\.pdf$'
  then
    return false;
  end if;
  begin
    target_company_id := split_part(p_object_path, '/', 1)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return exists (
    select 1
    from public.company_memberships membership
    join public.companies company
      on company.id = membership.company_id
     and company.status in ('setup', 'active')
    join public.sds_registration_requests request
      on request.company_id = membership.company_id
     and request.prepared_by = membership.user_id
     and request.object_path = p_object_path
     and request.status = 'prepared'
     and request.expires_at > now()
    where membership.company_id = target_company_id
      and membership.user_id = auth.uid()
      and membership.role = 'owner'
      and membership.active
      and not exists (
        select 1
        from public.sds_documents document
        where document.company_id = target_company_id
          and document.storage_object_path = p_object_path
      )
  );
end;
$$;

revoke all on function public.can_upload_storyops_sds_object(text)
  from public, anon, authenticated, service_role;
grant execute on function public.can_upload_storyops_sds_object(text)
  to authenticated;

drop policy if exists sds_owner_insert on storage.objects;
create policy sds_owner_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'sds'
  and public.can_upload_storyops_sds_object(name)
);

drop policy if exists sds_owner_update on storage.objects;
-- Evidence paths are content-addressed and write-once. In particular, an
-- authenticated owner cannot replace same-size bytes after trusted hashing but
-- before finalization. An expired/failed attempt consumes its version number;
-- the next preparation receives a fresh path.

comment on table public.sds_registration_requests is
  'Finite owner-reviewed private SDS upload reservations bound to one exact operating material and expected checksum.';
comment on function public.prepare_storyops_material_sds_registration(
  uuid, uuid, text, text, text, date, text, bigint, text, text, text
) is
  'Idempotently prepares a bounded private SDS PDF path for the exact configured material checksum; it does not create safety or chemical instructions.';
comment on function public.finalize_storyops_material_sds_registration(
  uuid, uuid, text
) is
  'Finalizes immutable SDS evidence only after the exact private Storage object metadata, current baseline, role, tenant, and material version reconcile.';
comment on function public.get_storyops_material_sds_registry(uuid) is
  'Owner-only exact material/SDS registry for the current operating configuration and baseline.';
