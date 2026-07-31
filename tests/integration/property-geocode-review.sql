\set ON_ERROR_STOP on

begin;

\echo '1/12 geocode evidence is RPC-only and candidates are read-only to back office'
do $$
begin
  if has_table_privilege(
    'authenticated',
    'public.property_geocode_candidates',
    'INSERT,UPDATE,DELETE'
  ) or has_table_privilege(
    'service_role',
    'public.property_geocode_candidates',
    'SELECT,INSERT,UPDATE,DELETE'
  ) or not has_table_privilege(
    'authenticated',
    'public.property_geocode_candidates',
    'SELECT'
  ) or not has_function_privilege(
    'service_role',
    'public.load_storyops_property_geocode_context(uuid,uuid,uuid,integer,uuid,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.record_storyops_property_geocode_candidates(uuid,uuid,uuid,integer,uuid,text,jsonb,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.record_storyops_property_geocode_candidates(uuid,uuid,uuid,integer,uuid,text,jsonb,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.confirm_storyops_property_geocode_candidate(uuid,uuid,uuid,integer,uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'Property geocode ACLs are not least privilege';
  end if;
end;
$$;

insert into public.customers(
  id, company_id, kind, display_name, lifecycle
)
values (
  '94900000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000001',
  'individual',
  'Geocode Contract Customer',
  'active'
);
insert into public.properties(
  id, company_id, customer_id, name, property_type, service_address
)
values (
  '94900000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000001',
  '94900000-0000-4000-8000-000000000101',
  'Geocode Contract Property',
  'single_family',
  '{
    "line1":"4101 Exact Review Lane",
    "city":"Dallas",
    "region":"TX",
    "postalCode":"75201",
    "country":"US"
  }'::jsonb
);

insert into public.companies(id, name, status)
values (
  '94900000-0000-4000-8000-000000000001',
  'Geocode cross-tenant company',
  'active'
);
insert into public.company_memberships(
  id, company_id, user_id, role, active
)
values (
  '94900000-0000-4000-8000-000000000002',
  '94900000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000104',
  'owner',
  true
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);

\echo '2/12 service lookup returns only exact company/property/version/address facts'
do $$
declare
  operation_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000010';
  property_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000201';
  request_hash_value text := public.storyops_json_sha256(
    jsonb_build_object(
      'schemaVersion', 'storyops-property-geocode-lookup-v1',
      'operationId', operation_id_value,
      'propertyId', property_id_value,
      'propertyVersion', 1
    )
  );
  context jsonb;
begin
  context := public.load_storyops_property_geocode_context(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    property_id_value,
    1,
    operation_id_value,
    request_hash_value
  );
  if (context ->> 'replayed')::boolean
    or (context ->> 'propertyId')::uuid <> property_id_value
    or (context ->> 'propertyVersion')::integer <> 1
    or context -> 'serviceAddress' ->> 'line1' <> '4101 Exact Review Lane'
    or context ->> 'addressHash' <> public.storyops_json_sha256(
      context -> 'serviceAddress'
    )
  then
    raise exception 'Geocode lookup context was not exact: %', context;
  end if;
end;
$$;

\echo '3/12 provider candidates persist as bounded evidence but cannot set coordinates'
do $$
declare
  operation_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000010';
  property_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000201';
  high_candidate_id constant uuid :=
    '94900000-0000-4000-8000-000000000301';
  low_candidate_id constant uuid :=
    '94900000-0000-4000-8000-000000000302';
  observed_at_value timestamptz := date_trunc('milliseconds', now());
  address_hash_value text;
  request_hash_value text;
  receipt jsonb;
begin
  select public.storyops_json_sha256(property.service_address)
  into address_hash_value
  from public.properties property
  where property.id = property_id_value;
  request_hash_value := public.storyops_json_sha256(jsonb_build_object(
    'schemaVersion', 'storyops-property-geocode-lookup-v1',
    'operationId', operation_id_value,
    'propertyId', property_id_value,
    'propertyVersion', 1
  ));
  receipt := public.record_storyops_property_geocode_candidates(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    property_id_value,
    1,
    operation_id_value,
    address_hash_value,
    jsonb_build_array(
      jsonb_build_object(
        'id', high_candidate_id,
        'provider', 'google_maps',
        'mode', 'live',
        'formattedAddress', '4101 Exact Review Ln, Dallas, TX 75201, USA',
        'latitude', 32.7767000,
        'longitude', -96.7970000,
        'precision', 'rooftop',
        'confidence', 0.9700,
        'providerPlaceId', 'place-geocode-contract-high',
        'observedAt', observed_at_value
      ),
      jsonb_build_object(
        'id', low_candidate_id,
        'provider', 'google_maps',
        'mode', 'live',
        'formattedAddress', 'Dallas, TX, USA',
        'latitude', 32.7767000,
        'longitude', -96.7970000,
        'precision', 'city',
        'confidence', 0.5500,
        'providerPlaceId', 'place-geocode-contract-low',
        'observedAt', observed_at_value
      )
    ),
    request_hash_value
  );
  if receipt ->> 'schemaVersion'
      <> 'storyops-property-geocode-candidates-v1'
    or jsonb_array_length(receipt -> 'candidates') <> 2
    or not (receipt ->> 'requiresHumanConfirmation')::boolean
    or (receipt ->> 'replayed')::boolean
    or exists (
      select 1
      from public.properties property
      where property.id = property_id_value
        and (
          property.latitude is not null
          or property.geocode_candidate_id is not null
        )
    )
  then
    raise exception 'Candidate persistence promoted unreviewed coordinates: %',
      receipt;
  end if;
  if (
    select count(*)
    from public.property_geocode_candidates candidate
    where candidate.operation_id = operation_id_value
      and candidate.status = 'pending'
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
  ) <> 2 then
    raise exception 'Candidate operation/expiry evidence hash was not exact';
  end if;
end;
$$;

\echo '4/12 record and load replay return the first durable provider result'
do $$
declare
  operation_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000010';
  property_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000201';
  address_hash_value text;
  request_hash_value text;
  replay jsonb;
  loaded jsonb;
begin
  select public.storyops_json_sha256(property.service_address)
  into address_hash_value
  from public.properties property
  where property.id = property_id_value;
  request_hash_value := public.storyops_json_sha256(jsonb_build_object(
    'schemaVersion', 'storyops-property-geocode-lookup-v1',
    'operationId', operation_id_value,
    'propertyId', property_id_value,
    'propertyVersion', 1
  ));
  replay := public.record_storyops_property_geocode_candidates(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    property_id_value,
    1,
    operation_id_value,
    address_hash_value,
    jsonb_build_array(jsonb_build_object(
      'id', '94900000-0000-4000-8000-000000000399'::uuid,
      'provider', 'google_maps',
      'mode', 'live',
      'formattedAddress', 'A different provider retry result',
      'latitude', 32.7000000,
      'longitude', -96.7000000,
      'precision', 'street',
      'confidence', 0.9000,
      'observedAt', date_trunc('milliseconds', now())
    )),
    request_hash_value
  );
  loaded := public.load_storyops_property_geocode_context(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    property_id_value,
    1,
    operation_id_value,
    request_hash_value
  );
  if not (replay ->> 'replayed')::boolean
    or not (loaded ->> 'replayed')::boolean
    or loaded -> 'receipt' ->> 'operationId' <> operation_id_value::text
    or exists (
      select 1
      from public.property_geocode_candidates
      where id = '94900000-0000-4000-8000-000000000399'
    )
  then
    raise exception 'Provider retry did not reconcile to durable evidence';
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

\echo '5/12 low-confidence/city evidence cannot be confirmed'
do $$
declare
  command_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000020';
  property_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000201';
  candidate_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000302';
  request_hash_value text := public.storyops_json_sha256(
    jsonb_build_object(
      'action', 'property.geocode.confirm',
      'propertyId', property_id_value,
      'propertyVersion', 1,
      'candidateId', candidate_id_value
    )
  );
  denied boolean := false;
begin
  begin
    perform public.confirm_storyops_property_geocode_candidate(
      '10000000-0000-4000-8000-000000000001',
      command_id_value,
      property_id_value,
      1,
      candidate_id_value,
      request_hash_value
    );
  exception when others then
    denied := sqlerrm = 'PROPERTY_GEOCODE_LIVE_CANDIDATE_REQUIRED';
  end;
  if not denied
    or exists (
      select 1
      from public.idempotency_keys
      where company_id = '10000000-0000-4000-8000-000000000001'
        and scope = 'property-geocode-confirm-v1'
        and key = command_id_value::text
    )
  then
    raise exception 'Low-confidence confirmation did not roll back';
  end if;
end;
$$;

\echo '6/12 confirmation consumes one transaction-bound write authorization'
do $$
declare
  command_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000021';
  property_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000201';
  candidate_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000301';
  request_hash_value text := public.storyops_json_sha256(
    jsonb_build_object(
      'action', 'property.geocode.confirm',
      'propertyId', property_id_value,
      'propertyVersion', 1,
      'candidateId', candidate_id_value
    )
  );
  receipt jsonb;
begin
  receipt := public.confirm_storyops_property_geocode_candidate(
    '10000000-0000-4000-8000-000000000001',
    command_id_value,
    property_id_value,
    1,
    candidate_id_value,
    request_hash_value
  );
  if (receipt ->> 'replayed')::boolean
    or (receipt ->> 'propertyVersion')::integer <> 2
    or not private.storyops_property_has_reviewed_geocode(
      '10000000-0000-4000-8000-000000000001',
      property_id_value
    )
    or (
      select count(*)
      from private.property_geocode_write_authorizations write_auth
      where write_auth.company_id =
          '10000000-0000-4000-8000-000000000001'
        and write_auth.property_id = property_id_value
        and write_auth.candidate_id = candidate_id_value
        and write_auth.actor_user_id =
          '10000000-0000-4000-8000-000000000101'
        and write_auth.command_id = command_id_value
        and write_auth.expected_property_version = 1
        and write_auth.consumed_at is not null
    ) <> 1
  then
    raise exception 'Reviewed coordinate write was not exactly authorized: %',
      receipt;
  end if;
  if not exists (
    select 1
    from public.properties property
    where property.id = property_id_value
      and property.version = 2
      and property.geocode_candidate_id = candidate_id_value
      and property.geocode_provider = 'google_maps'
      and property.geocode_precision = 'rooftop'
      and property.geocode_address_hash =
        public.storyops_json_sha256(property.service_address)
      and property.latitude = 32.7767000
      and property.longitude = -96.7970000
      and property.geocode_confidence = 0.9700
  ) or not exists (
    select 1
    from public.property_geocode_candidates candidate
    where candidate.id = candidate_id_value
      and candidate.status = 'confirmed'
      and candidate.confirmed_by =
        '10000000-0000-4000-8000-000000000101'
  ) or not exists (
    select 1
    from public.property_geocode_candidates candidate
    where candidate.id = '94900000-0000-4000-8000-000000000302'
      and candidate.status = 'invalidated'
      and candidate.invalidation_reason = 'alternate_candidate_not_selected'
  ) then
    raise exception 'Confirmed property/candidate facts were inconsistent';
  end if;
end;
$$;

\echo '7/12 confirmation replay is stable and conflicting command reuse fails'
do $$
declare
  command_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000021';
  property_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000201';
  candidate_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000301';
  request_hash_value text := public.storyops_json_sha256(
    jsonb_build_object(
      'action', 'property.geocode.confirm',
      'propertyId', property_id_value,
      'propertyVersion', 1,
      'candidateId', candidate_id_value
    )
  );
  replay jsonb;
  conflict_denied boolean := false;
begin
  replay := public.confirm_storyops_property_geocode_candidate(
    '10000000-0000-4000-8000-000000000001',
    command_id_value,
    property_id_value,
    1,
    candidate_id_value,
    request_hash_value
  );
  begin
    perform public.confirm_storyops_property_geocode_candidate(
      '10000000-0000-4000-8000-000000000001',
      command_id_value,
      property_id_value,
      1,
      '94900000-0000-4000-8000-000000000302',
      public.storyops_json_sha256(jsonb_build_object(
        'action', 'property.geocode.confirm',
        'propertyId', property_id_value,
        'propertyVersion', 1,
        'candidateId', '94900000-0000-4000-8000-000000000302'::uuid
      ))
    );
  exception when others then
    conflict_denied := sqlerrm =
      'PROPERTY_GEOCODE_CONFIRM_IDEMPOTENCY_CONFLICT';
  end;
  if not (replay ->> 'replayed')::boolean
    or not conflict_denied
    or (
      select count(*)
      from public.audit_events audit
      where audit.action = 'property.geocode_confirmed'
        and audit.request_id = command_id_value::text
    ) <> 1
  then
    raise exception 'Confirmation replay/conflict contract failed';
  end if;
end;
$$;

\echo '8/12 direct coordinate insert, mutation, and clear are all blocked'
do $$
declare
  insert_denied boolean := false;
  mutate_denied boolean := false;
  clear_denied boolean := false;
begin
  begin
    insert into public.properties(
      id, company_id, customer_id, name, property_type, service_address,
      latitude, longitude, geocode_confidence, geocoded_at
    )
    values (
      '94900000-0000-4000-8000-000000000202',
      '10000000-0000-4000-8000-000000000001',
      '94900000-0000-4000-8000-000000000101',
      'Direct coordinate bypass',
      'single_family',
      '{"line1":"9999 Bypass Lane","city":"Dallas","region":"TX","postalCode":"75201","country":"US"}',
      32.7000000,
      -96.7000000,
      0.9900,
      now()
    );
  exception when others then
    insert_denied := sqlerrm =
      'PROPERTY_GEOCODE_REVIEWED_CANDIDATE_REQUIRED';
  end;
  begin
    update public.properties
    set latitude = latitude + 0.0000001
    where id = '94900000-0000-4000-8000-000000000201';
  exception when others then
    mutate_denied := sqlerrm =
      'PROPERTY_GEOCODE_WRITE_AUTHORIZATION_REQUIRED';
  end;
  begin
    update public.properties
    set
      latitude = null,
      longitude = null,
      geocode_confidence = null,
      geocoded_at = null,
      geocode_candidate_id = null,
      geocode_provider = null,
      geocode_precision = null,
      geocode_address_hash = null
    where id = '94900000-0000-4000-8000-000000000201';
  exception when others then
    clear_denied := sqlerrm =
      'PROPERTY_GEOCODE_WRITE_AUTHORIZATION_REQUIRED';
  end;
  if not insert_denied or not mutate_denied or not clear_denied then
    raise exception 'Direct property coordinate bypass remained available';
  end if;
end;
$$;

\echo '9/12 address change clears provenance and invalidates confirmed evidence'
update public.properties
set service_address = jsonb_set(
  service_address,
  '{line1}',
  '"4103 Changed Address Lane"'::jsonb
)
where id = '94900000-0000-4000-8000-000000000201';

do $$
begin
  if exists (
    select 1
    from public.properties property
    where property.id = '94900000-0000-4000-8000-000000000201'
      and (
        property.version <> 3
        or property.latitude is not null
        or property.longitude is not null
        or property.geocode_confidence is not null
        or property.geocoded_at is not null
        or property.geocode_candidate_id is not null
        or property.geocode_provider is not null
        or property.geocode_precision is not null
        or property.geocode_address_hash is not null
      )
  ) or private.storyops_property_has_reviewed_geocode(
    '10000000-0000-4000-8000-000000000001',
    '94900000-0000-4000-8000-000000000201'
  ) or not exists (
    select 1
    from public.property_geocode_candidates candidate
    where candidate.id = '94900000-0000-4000-8000-000000000301'
      and candidate.status = 'invalidated'
      and candidate.invalidation_reason = 'service_address_changed'
  ) then
    raise exception 'Address change retained stale geocode authority';
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);

\echo '10/12 stale property versions and stale provider observations fail closed'
do $$
declare
  property_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000201';
  stale_version_operation constant uuid :=
    '94900000-0000-4000-8000-000000000030';
  stale_candidate_operation constant uuid :=
    '94900000-0000-4000-8000-000000000031';
  stale_version_denied boolean := false;
  stale_candidate_denied boolean := false;
  address_hash_value text;
  request_hash_value text;
begin
  begin
    perform public.load_storyops_property_geocode_context(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      property_id_value,
      2,
      stale_version_operation,
      public.storyops_json_sha256(jsonb_build_object(
        'schemaVersion', 'storyops-property-geocode-lookup-v1',
        'operationId', stale_version_operation,
        'propertyId', property_id_value,
        'propertyVersion', 2
      ))
    );
  exception when others then
    stale_version_denied :=
      sqlerrm = 'PROPERTY_GEOCODE_PROPERTY_VERSION_CONFLICT';
  end;
  select public.storyops_json_sha256(property.service_address)
  into address_hash_value
  from public.properties property
  where property.id = property_id_value;
  request_hash_value := public.storyops_json_sha256(jsonb_build_object(
    'schemaVersion', 'storyops-property-geocode-lookup-v1',
    'operationId', stale_candidate_operation,
    'propertyId', property_id_value,
    'propertyVersion', 3
  ));
  begin
    perform public.record_storyops_property_geocode_candidates(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      property_id_value,
      3,
      stale_candidate_operation,
      address_hash_value,
      jsonb_build_array(jsonb_build_object(
        'id', '94900000-0000-4000-8000-000000000303'::uuid,
        'provider', 'google_maps',
        'mode', 'live',
        'formattedAddress', '4103 Changed Address Ln, Dallas, TX',
        'latitude', 32.7768000,
        'longitude', -96.7971000,
        'precision', 'rooftop',
        'confidence', 0.9800,
        'observedAt', now() - interval '11 minutes'
      )),
      request_hash_value
    );
  exception when others then
    stale_candidate_denied :=
      sqlerrm = 'PROPERTY_GEOCODE_CANDIDATE_STALE';
  end;
  if not stale_version_denied
    or not stale_candidate_denied
    or exists (
      select 1
      from public.property_geocode_candidates
      where id = '94900000-0000-4000-8000-000000000303'
    )
    or exists (
      select 1
      from public.idempotency_keys
      where company_id = '10000000-0000-4000-8000-000000000001'
        and scope = 'property-geocode-lookup-v1'
        and key = stale_candidate_operation::text
    )
  then
    raise exception 'Stale version/provider evidence did not roll back';
  end if;
end;
$$;

\echo '11/12 active actors cannot cross company scope and inactive actors fail'
do $$
declare
  property_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000201';
  operation_id_value constant uuid :=
    '94900000-0000-4000-8000-000000000032';
  tenant_denied boolean := false;
  inactive_denied boolean := false;
begin
  begin
    perform public.load_storyops_property_geocode_context(
      '94900000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000104',
      property_id_value,
      3,
      operation_id_value,
      public.storyops_json_sha256(jsonb_build_object(
        'schemaVersion', 'storyops-property-geocode-lookup-v1',
        'operationId', operation_id_value,
        'propertyId', property_id_value,
        'propertyVersion', 3
      ))
    );
  exception when others then
    tenant_denied :=
      sqlerrm = 'PROPERTY_GEOCODE_PROPERTY_VERSION_CONFLICT';
  end;

  update public.company_memberships
  set role = 'owner'
  where company_id = '10000000-0000-4000-8000-000000000001'
    and user_id = '10000000-0000-4000-8000-000000000102';
  update public.company_memberships
  set active = false
  where company_id = '10000000-0000-4000-8000-000000000001'
    and user_id = '10000000-0000-4000-8000-000000000101';
  begin
    perform public.load_storyops_property_geocode_context(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      property_id_value,
      3,
      '94900000-0000-4000-8000-000000000033',
      public.storyops_json_sha256(jsonb_build_object(
        'schemaVersion', 'storyops-property-geocode-lookup-v1',
        'operationId', '94900000-0000-4000-8000-000000000033'::uuid,
        'propertyId', property_id_value,
        'propertyVersion', 3
      ))
    );
  exception when others then
    inactive_denied := sqlerrm = 'EDGE_ACTOR_FORBIDDEN';
  end;
  if not tenant_denied or not inactive_denied then
    raise exception 'Geocode tenant/active-membership isolation failed';
  end if;
end;
$$;

\echo '12/12 legacy coordinates are visible but never reviewed live authority'
do $$
declare
  receipt_denied boolean := false;
  visit_denied boolean := false;
begin
  if private.storyops_property_has_reviewed_geocode(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000211'
  ) then
    raise exception 'Synthetic legacy coordinates became live scheduling proof';
  end if;
  begin
    insert into public.scheduling_evidence_receipts(
      company_id,
      property_id,
      evidence_mode
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000211',
      'live'
    );
  exception when others then
    receipt_denied :=
      sqlerrm = 'SCHEDULING_REVIEWED_LIVE_GEOCODE_REQUIRED';
  end;
  begin
    insert into public.visits(
      id,
      company_id,
      job_id,
      sequence,
      status,
      starts_at,
      ends_at,
      crew_id
    )
    values (
      '94900000-0000-4000-8000-000000000401',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000631',
      99,
      'confirmed',
      now() + interval '2 days',
      now() + interval '2 days 1 hour',
      '10000000-0000-4000-8000-000000000601'
    );
  exception when others then
    visit_denied := sqlerrm = 'VISIT_REVIEWED_LIVE_GEOCODE_REQUIRED';
  end;
  if not receipt_denied or not visit_denied then
    raise exception 'Legacy coordinates crossed a live scheduling gate';
  end if;
  update public.companies
  set status = 'paused'
  where id = '94900000-0000-4000-8000-000000000001';
  begin
    perform public.load_storyops_property_geocode_context(
      '94900000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000104',
      '94900000-0000-4000-8000-000000000201',
      1,
      '94900000-0000-4000-8000-000000000034',
      repeat('0', 64)
    );
    raise exception 'Paused company accepted a geocode operation';
  exception when others then
    if sqlerrm not in ('EDGE_ACTOR_FORBIDDEN', 'Paused company accepted a geocode operation') then
      raise;
    end if;
    if sqlerrm = 'Paused company accepted a geocode operation' then
      raise;
    end if;
  end;
end;
$$;

rollback;
