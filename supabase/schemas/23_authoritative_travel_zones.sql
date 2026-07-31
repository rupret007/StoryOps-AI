-- Exact reviewed postal-code evidence for deterministic travel-zone pricing.
--
-- Mileage bands remain optional descriptive metadata. They are never used to
-- infer a fee. Every newly materialized zone requires one or more normalized
-- ZIP mappings and immutable review evidence, and estimates persist only when
-- the property ZIP resolves to exactly one reviewed mapping.

alter function public.validate_company_configuration(uuid, jsonb, text)
  rename to validate_company_configuration_without_travel_zone_evidence;

create or replace function public.validate_travel_zone_configuration(
  p_configuration jsonb,
  p_publication_mode text
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  issues jsonb := '[]'::jsonb;
  zones jsonb := p_configuration #> '{territory,travelZones}';
  mapping_review jsonb := p_configuration #> '{territory,travelZoneMappingReview}';
  postal_count integer;
  distinct_postal_count integer;
begin
  if jsonb_typeof(zones) is distinct from 'array'
    or jsonb_array_length(zones) not between 1 and 12
  then
    return jsonb_build_array(jsonb_build_object(
      'section', 'territory',
      'code', 'travel_zones_missing',
      'message', 'One to twelve exact reviewed travel zones are required.',
      'severity', 'blocking'
    ));
  end if;

  if exists (
    select 1
    from jsonb_array_elements(zones) zone
    where jsonb_typeof(zone) <> 'object'
      or nullif(btrim(zone ->> 'code'), '') is null
      or zone ->> 'code' !~ '^[A-Z0-9][A-Z0-9-]{1,15}$'
  ) or (
    select count(*) <> count(distinct zone ->> 'code')
    from jsonb_array_elements(zones) zone
  )
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'territory',
      'code', 'travel_zone_codes_invalid',
      'message', 'Travel-zone codes must be valid and unique.',
      'severity', 'blocking'
    ));
  end if;

  if exists (
    select 1
    from jsonb_array_elements(zones) zone
    where jsonb_typeof(zone -> 'postalCodes') is distinct from 'array'
      or jsonb_array_length(zone -> 'postalCodes') not between 1 and 500
  )
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'territory',
      'code', 'travel_zone_postal_mappings_missing',
      'message', 'Every travel zone requires at least one exact five-digit ZIP mapping.',
      'severity', 'blocking'
    ));
  else
    if exists (
      select 1
      from jsonb_array_elements(zones) zone
      cross join lateral jsonb_array_elements(zone -> 'postalCodes') postal_code
      where jsonb_typeof(postal_code) <> 'string'
        or postal_code #>> '{}' !~ '^[0-9]{5}$'
    )
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'section', 'territory',
        'code', 'travel_zone_postal_mapping_invalid',
        'message', 'Travel-zone mappings accept normalized five-digit ZIP codes only.',
        'severity', 'blocking'
      ));
    end if;

    select count(*), count(distinct postal_code)
    into postal_count, distinct_postal_count
    from jsonb_array_elements(zones) zone
    cross join lateral jsonb_array_elements_text(zone -> 'postalCodes') postal_code;
    if postal_count <> distinct_postal_count then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'section', 'territory',
        'code', 'travel_zone_postal_mapping_duplicate',
        'message', 'A ZIP code may map to exactly one travel zone.',
        'severity', 'blocking'
      ));
    end if;
  end if;

  if jsonb_typeof(mapping_review) is distinct from 'object'
    or mapping_review ->> 'status' not in ('required', 'in_review', 'approved')
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'territory',
      'code', 'travel_zone_mapping_review_missing',
      'message', 'Travel-zone mapping review status and evidence fields are required.',
      'severity', 'blocking'
    ));
  elsif p_publication_mode = 'live' and (
    mapping_review ->> 'status' <> 'approved'
    or length(btrim(coalesce(mapping_review ->> 'reviewer', ''))) not between 2 and 100
    or length(btrim(coalesce(mapping_review ->> 'evidenceReference', ''))) not between 5 and 240
    or coalesce(mapping_review ->> 'reviewedAt', '')
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
  )
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'territory',
      'code', 'travel_zone_mapping_review_required',
      'message', 'Approved reviewer, timestamp, and evidence reference are required for live ZIP mappings.',
      'severity', 'blocking'
    ));
  end if;

  return issues;
end;
$$;

create or replace function public.validate_company_configuration(
  p_company_id uuid,
  p_configuration jsonb,
  p_publication_mode text
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    coalesce(
      public.validate_company_configuration_without_travel_zone_evidence(
        p_company_id,
        p_configuration,
        p_publication_mode
      ),
      '[]'::jsonb
    )
    || public.validate_travel_zone_configuration(
      p_configuration,
      p_publication_mode
    );
$$;

create or replace function public.enforce_company_configuration_travel_zone_evidence()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  issues jsonb;
begin
  issues := public.validate_travel_zone_configuration(
    new.configuration,
    coalesce(new.publication_mode, 'sandbox')
  );
  if exists (
    select 1
    from jsonb_array_elements(issues) issue
    where issue ->> 'severity' = 'blocking'
  ) then
    raise exception 'Company travel-zone configuration is invalid: %', issues;
  end if;
  return new;
end;
$$;

create trigger company_configuration_travel_zone_evidence
before insert or update of configuration, publication_mode, status
on public.company_configuration_versions
for each row execute function public.enforce_company_configuration_travel_zone_evidence();

alter table public.price_book_travel_zones
  add column mapping_evidence_source text,
  add column mapping_reviewed_by text,
  add column mapping_reviewed_at timestamptz,
  add column mapping_review_reference text;

-- Existing installations are backfilled only when an immutable published
-- configuration already contains the exact reviewed mapping. Nothing is
-- inferred from a fee, mileage band, or neighboring ZIP.
with reviewed_configuration_zones as (
  select
    configuration.company_id,
    zone ->> 'code' as zone_code,
    array(
      select postal_code
      from jsonb_array_elements_text(zone -> 'postalCodes') postal_code
      order by postal_code
    ) as postal_codes,
    configuration.configuration #>> '{territory,travelZoneMappingReview,reviewer}'
      as reviewed_by,
    case
      when configuration.configuration
        #>> '{territory,travelZoneMappingReview,reviewedAt}'
        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
      then (
        configuration.configuration
          #>> '{territory,travelZoneMappingReview,reviewedAt}'
      )::timestamptz
      else null
    end as reviewed_at,
    configuration.configuration
      #>> '{territory,travelZoneMappingReview,evidenceReference}'
      as review_reference
  from public.company_configuration_versions configuration
  cross join lateral jsonb_array_elements(
    configuration.configuration #> '{territory,travelZones}'
  ) zone
  where configuration.status = 'published'
    and configuration.publication_mode = 'live'
    and configuration.configuration
      #>> '{territory,travelZoneMappingReview,status}' = 'approved'
    and jsonb_typeof(zone -> 'postalCodes') = 'array'
    and jsonb_array_length(zone -> 'postalCodes') > 0
)
update public.price_book_travel_zones zone
set
  postal_codes = reviewed.postal_codes,
  mapping_evidence_source = 'reviewed_postal_codes',
  mapping_reviewed_by = reviewed.reviewed_by,
  mapping_reviewed_at = reviewed.reviewed_at,
  mapping_review_reference = reviewed.review_reference
from reviewed_configuration_zones reviewed
where reviewed.company_id = zone.company_id
  and reviewed.zone_code = zone.zone_code
  and reviewed.reviewed_by is not null
  and reviewed.reviewed_at is not null
  and reviewed.review_reference is not null;

update public.companies company
set settings = company.settings || jsonb_build_object(
  'travelZoneRemediationRequired',
  true,
  'travelZoneRemediationReason',
  'Active price book lacks exact reviewed ZIP-to-fee evidence; republish the reviewed company configuration and operating baseline.'
)
where exists (
  select 1
  from public.price_books book
  join public.price_book_travel_zones zone on zone.price_book_id = book.id
  where book.company_id = company.id
    and book.status = 'active'
    and (
      cardinality(zone.postal_codes) = 0
      or zone.mapping_evidence_source is distinct from 'reviewed_postal_codes'
      or zone.mapping_reviewed_by is null
      or zone.mapping_reviewed_at is null
      or zone.mapping_review_reference is null
    )
)
or exists (
  select 1
  from public.price_books book
  join lateral (
    select count(*) as mapped_count, count(distinct postal_code) as distinct_count
    from public.price_book_travel_zones zone
    cross join lateral unnest(zone.postal_codes) postal_code
    where zone.price_book_id = book.id
      and zone.company_id = book.company_id
  ) mapping_counts on true
  where book.company_id = company.id
    and book.status = 'active'
    and mapping_counts.mapped_count <> mapping_counts.distinct_count
);

alter table public.price_book_travel_zones
  add constraint price_book_travel_zone_reviewed_mapping_required
  check (
    cardinality(postal_codes) between 1 and 500
    and mapping_evidence_source = 'reviewed_postal_codes'
    and length(btrim(mapping_reviewed_by)) between 2 and 100
    and mapping_reviewed_at is not null
    and length(btrim(mapping_review_reference)) between 5 and 240
  ) not valid;

create index price_book_travel_zone_postal_codes_idx
  on public.price_book_travel_zones using gin(postal_codes);

create or replace function public.enforce_reviewed_price_book_travel_zone()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  configuration_zone jsonb;
  mapping_review jsonb;
  postal_count integer;
  distinct_postal_count integer;
begin
  select zone, configuration.configuration #> '{territory,travelZoneMappingReview}'
  into configuration_zone, mapping_review
  from public.company_configuration_versions configuration
  cross join lateral jsonb_array_elements(
    configuration.configuration #> '{territory,travelZones}'
  ) zone
  where configuration.company_id = new.company_id
    and configuration.status = 'published'
    and configuration.publication_mode = 'live'
    and configuration.configuration
      #>> '{territory,travelZoneMappingReview,status}' = 'approved'
    and jsonb_typeof(zone -> 'postalCodes') = 'array'
    and jsonb_array_length(zone -> 'postalCodes') > 0
    and zone ->> 'code' = new.zone_code
  order by configuration.revision desc
  limit 1;

  -- A published configuration is the source of truth whenever present. The
  -- caller cannot replace any part of its mapping or review identity.
  if configuration_zone is not null then
    select array_agg(postal_code order by postal_code)
    into new.postal_codes
    from jsonb_array_elements_text(configuration_zone -> 'postalCodes') postal_code;
    new.mapping_evidence_source := 'reviewed_postal_codes';
    new.mapping_reviewed_by := mapping_review ->> 'reviewer';
    new.mapping_reviewed_at := (mapping_review ->> 'reviewedAt')::timestamptz;
    new.mapping_review_reference := mapping_review ->> 'evidenceReference';
  end if;

  select count(*), count(distinct postal_code)
  into postal_count, distinct_postal_count
  from unnest(new.postal_codes) postal_code;
  if postal_count not between 1 and 500
    or postal_count <> distinct_postal_count
    or exists (
      select 1 from unnest(new.postal_codes) postal_code
      where postal_code !~ '^[0-9]{5}$'
    )
  then
    raise exception 'TRAVEL_ZONE_POSTAL_MAPPING_INVALID';
  end if;
  if new.mapping_evidence_source <> 'reviewed_postal_codes'
    or length(btrim(coalesce(new.mapping_reviewed_by, ''))) not between 2 and 100
    or new.mapping_reviewed_at is null
    or new.mapping_reviewed_at > clock_timestamp() + interval '5 minutes'
    or length(btrim(coalesce(new.mapping_review_reference, ''))) not between 5 and 240
  then
    raise exception 'TRAVEL_ZONE_MAPPING_REVIEW_REQUIRED';
  end if;
  if exists (
    select 1
    from public.price_book_travel_zones existing
    where existing.price_book_id = new.price_book_id
      and existing.id <> new.id
      and existing.postal_codes && new.postal_codes
  )
  then
    raise exception 'TRAVEL_ZONE_POSTAL_MAPPING_DUPLICATE';
  end if;
  return new;
exception
  when invalid_text_representation or datetime_field_overflow then
    raise exception 'TRAVEL_ZONE_MAPPING_REVIEW_REQUIRED';
end;
$$;

create trigger price_book_travel_zone_reviewed_mapping
before insert or update of postal_codes, mapping_evidence_source,
  mapping_reviewed_by, mapping_reviewed_at, mapping_review_reference
on public.price_book_travel_zones
for each row execute function public.enforce_reviewed_price_book_travel_zone();

create or replace function public.enforce_active_price_book_travel_zone_evidence()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  mapped_postal_count integer;
  distinct_postal_count integer;
begin
  if new.status <> 'active' or old.status = 'active' then
    return new;
  end if;
  if not exists (
    select 1
    from public.price_book_travel_zones zone
    where zone.price_book_id = new.id
      and zone.company_id = new.company_id
  ) or exists (
    select 1
    from public.price_book_travel_zones zone
    where zone.price_book_id = new.id
      and zone.company_id = new.company_id
      and (
        cardinality(zone.postal_codes) = 0
        or zone.mapping_evidence_source is distinct from 'reviewed_postal_codes'
        or zone.mapping_reviewed_by is null
        or zone.mapping_reviewed_at is null
        or zone.mapping_review_reference is null
      )
  )
  then
    raise exception 'PRICE_BOOK_TRAVEL_ZONE_EVIDENCE_REQUIRED';
  end if;

  select count(*), count(distinct postal_code)
  into mapped_postal_count, distinct_postal_count
  from public.price_book_travel_zones zone
  cross join lateral unnest(zone.postal_codes) postal_code
  where zone.price_book_id = new.id
    and zone.company_id = new.company_id;
  if mapped_postal_count <> distinct_postal_count then
    raise exception 'PRICE_BOOK_TRAVEL_ZONE_MAPPING_AMBIGUOUS';
  end if;

  update public.companies
  set
    settings = (settings - 'travelZoneRemediationReason')
      || jsonb_build_object('travelZoneRemediationRequired', false),
    updated_at = clock_timestamp()
  where id = new.company_id;
  return new;
end;
$$;

create trigger price_book_activation_travel_zone_evidence
after update of status on public.price_books
for each row execute function public.enforce_active_price_book_travel_zone_evidence();

create or replace function public.resolve_reviewed_travel_zone(
  p_company_id uuid,
  p_price_book_id uuid,
  p_postal_code text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  match_count integer;
  matched_zone public.price_book_travel_zones%rowtype;
begin
  if p_postal_code is null or p_postal_code !~ '^[0-9]{5}$' then
    raise exception 'TRAVEL_ZONE_POSTAL_CODE_INVALID';
  end if;

  select count(*)
  into match_count
  from public.price_book_travel_zones zone
  join public.price_books book
    on book.id = zone.price_book_id
    and book.company_id = zone.company_id
  where zone.company_id = p_company_id
    and zone.price_book_id = p_price_book_id
    and book.status = 'active'
    and book.effective_from <= clock_timestamp()
    and (book.effective_until is null or book.effective_until > clock_timestamp())
    and p_postal_code = any(zone.postal_codes)
    and zone.mapping_evidence_source = 'reviewed_postal_codes'
    and zone.mapping_reviewed_by is not null
    and zone.mapping_reviewed_at is not null
    and zone.mapping_review_reference is not null;
  if match_count = 0 then
    raise exception 'TRAVEL_ZONE_UNRESOLVED';
  end if;
  if match_count <> 1 then
    raise exception 'TRAVEL_ZONE_AMBIGUOUS';
  end if;

  select zone.*
  into strict matched_zone
  from public.price_book_travel_zones zone
  where zone.company_id = p_company_id
    and zone.price_book_id = p_price_book_id
    and p_postal_code = any(zone.postal_codes)
    and zone.mapping_evidence_source = 'reviewed_postal_codes'
    and zone.mapping_reviewed_by is not null
    and zone.mapping_reviewed_at is not null
    and zone.mapping_review_reference is not null;

  return jsonb_build_object(
    'code', matched_zone.zone_code,
    'source', 'reviewed_postal_code',
    'postalCode', p_postal_code,
    'mappingReviewedBy', matched_zone.mapping_reviewed_by,
    'mappingReviewedAt', matched_zone.mapping_reviewed_at,
    'mappingReviewReference', matched_zone.mapping_review_reference
  );
end;
$$;

create or replace function public.enforce_estimate_reviewed_travel_zone()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  evidence jsonb := new.calculation_input -> 'travelZoneEvidence';
  property_postal_code text;
  matching_zone_count integer;
begin
  property_postal_code := left(coalesce((
    select coalesce(
      property.service_address ->> 'postalCode',
      property.service_address ->> 'postal_code'
    )
    from public.properties property
    where property.id = new.property_id
      and property.company_id = new.company_id
  ), ''), 5);

  if jsonb_typeof(evidence) <> 'object'
    or evidence ->> 'source' <> 'reviewed_postal_code'
    or evidence ->> 'postalCode' <> property_postal_code
    or property_postal_code !~ '^[0-9]{5}$'
    or new.calculation_input ->> 'travelZoneCode' is null
    or length(btrim(coalesce(evidence ->> 'mappingReviewReference', '')))
      not between 5 and 240
    or nullif(evidence ->> 'mappingReviewedAt', '') is null
  then
    raise exception 'ESTIMATE_TRAVEL_ZONE_EVIDENCE_REQUIRED';
  end if;

  select count(*)
  into matching_zone_count
  from public.price_book_travel_zones zone
  where zone.company_id = new.company_id
    and zone.price_book_id = new.price_book_id
    and zone.zone_code = new.calculation_input ->> 'travelZoneCode'
    and property_postal_code = any(zone.postal_codes)
    and zone.mapping_evidence_source = 'reviewed_postal_codes'
    and zone.mapping_review_reference = evidence ->> 'mappingReviewReference'
    and zone.mapping_reviewed_by = evidence ->> 'mappingReviewedBy'
    and zone.mapping_reviewed_at = (evidence ->> 'mappingReviewedAt')::timestamptz;
  if matching_zone_count <> 1 then
    raise exception 'ESTIMATE_TRAVEL_ZONE_EVIDENCE_MISMATCH';
  end if;
  return new;
exception
  when invalid_text_representation or datetime_field_overflow then
    raise exception 'ESTIMATE_TRAVEL_ZONE_EVIDENCE_REQUIRED';
end;
$$;

create trigger estimates_reviewed_travel_zone
before insert or update of calculation_input, price_book_id, property_id
on public.estimates
for each row execute function public.enforce_estimate_reviewed_travel_zone();

revoke all on function public.validate_company_configuration_without_travel_zone_evidence(
  uuid, jsonb, text
) from public, anon, authenticated;
revoke all on function public.validate_travel_zone_configuration(jsonb, text)
  from public, anon;
grant execute on function public.validate_travel_zone_configuration(jsonb, text)
  to authenticated;
revoke all on function public.validate_company_configuration(uuid, jsonb, text)
  from public, anon;
grant execute on function public.validate_company_configuration(uuid, jsonb, text)
  to authenticated;
revoke all on function public.enforce_company_configuration_travel_zone_evidence()
  from public, anon, authenticated;
revoke all on function public.enforce_reviewed_price_book_travel_zone()
  from public, anon, authenticated;
revoke all on function public.enforce_active_price_book_travel_zone_evidence()
  from public, anon, authenticated;
revoke all on function public.resolve_reviewed_travel_zone(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.resolve_reviewed_travel_zone(uuid, uuid, text)
  to service_role;
revoke all on function public.enforce_estimate_reviewed_travel_zone()
  from public, anon, authenticated;

comment on function public.resolve_reviewed_travel_zone(uuid, uuid, text) is
  'Returns exactly one active price-book zone for an exact reviewed five-digit ZIP mapping; never infers by fee or mileage.';
comment on column public.price_book_travel_zones.mapping_review_reference is
  'Immutable evidence reference copied from the published company configuration that authorized these exact ZIP mappings.';
