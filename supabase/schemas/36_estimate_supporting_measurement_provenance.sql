-- Upgrade the deterministic estimate commit boundary to preserve and verify
-- every supporting measurement used to qualify a priced service. Migration 07
-- contains the same behavior for clean installs; this migration upgrades
-- already-applied databases without weakening the existing RPC ACL.

do $upgrade_estimate_supporting_measurement_provenance$
declare
  function_signature regprocedure :=
    'public.persist_priced_estimate(uuid,uuid,text,text,text,jsonb,uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,text)'::regprocedure;
  function_definition text;
  declaration_marker text := $fragment$  expected_measurement_id uuid;
$fragment$;
  declaration_replacement text := $fragment$  expected_measurement_id uuid;
  expected_service_measurement_ids jsonb;
$fragment$;
  add_on_id_validation_marker text := $fragment$      or exists (
        select 1
        from jsonb_array_elements(coalesce(service -> 'addOns', '[]'::jsonb)) add_on
$fragment$;
  supporting_id_validation text := $fragment$      or jsonb_typeof(coalesce(service -> 'supportingMeasurementIds', '[]'::jsonb))
        <> 'array'
      or jsonb_array_length(
        coalesce(service -> 'supportingMeasurementIds', '[]'::jsonb)
      ) > 12
      or exists (
        select 1
        from jsonb_array_elements_text(
          coalesce(service -> 'supportingMeasurementIds', '[]'::jsonb)
        ) supporting(measurement_id)
        where supporting.measurement_id !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
      or exists (
        select 1
        from jsonb_array_elements_text(
          coalesce(service -> 'supportingMeasurementIds', '[]'::jsonb)
        ) supporting(measurement_id)
        group by supporting.measurement_id
        having count(*) > 1
      )
      or exists (
        select 1
        from jsonb_array_elements_text(
          coalesce(service -> 'supportingMeasurementIds', '[]'::jsonb)
        ) supporting(measurement_id)
        where supporting.measurement_id = service ->> 'measurementId'
      )
$fragment$;
  add_on_reference_marker text := $fragment$    union
    select distinct (add_on ->> 'measurementId')::uuid
$fragment$;
  supporting_reference_union text := $fragment$    union
    select distinct supporting.measurement_id::uuid
    from jsonb_array_elements(p_calculation_input -> 'services') service,
      jsonb_array_elements_text(
        coalesce(service -> 'supportingMeasurementIds', '[]'::jsonb)
      ) supporting(measurement_id)
$fragment$;
  add_on_input_marker text := $fragment$    if jsonb_typeof(coalesce(service_value -> 'addOns', '[]'::jsonb)) <> 'array' then
$fragment$;
  supporting_evidence_validation text := $fragment$    for measurement_id_value in
      select supporting.measurement_id::uuid
      from jsonb_array_elements_text(
        coalesce(service_value -> 'supportingMeasurementIds', '[]'::jsonb)
      ) supporting(measurement_id)
    loop
      select value
      into snapshot_measurement_value
      from jsonb_array_elements(p_authoritative_snapshot -> 'measurements')
      where value ->> 'id' = measurement_id_value::text
      limit 1;
      if snapshot_measurement_value is null
        or not exists (
          select 1
          from public.property_measurements measurement
          join public.service_catalog catalog
            on catalog.company_id = measurement.company_id
            and catalog.code = service_value ->> 'serviceCode'
            and catalog.active
          where measurement.id = measurement_id_value
            and measurement.company_id = p_company_id
            and measurement.property_id = p_property_id
            and measurement.verified_by_human
            and measurement.kind = any(catalog.required_measurement_kinds)
            and service_value ->> 'serviceCode' = any(measurement.service_codes)
            and measurement.value =
              (snapshot_measurement_value ->> 'value')::numeric
            and measurement.kind = snapshot_measurement_value ->> 'kind'
            and measurement.unit = snapshot_measurement_value ->> 'unit'
            and (
              select coalesce(jsonb_agg(code order by code), '[]'::jsonb)
              from unnest(measurement.service_codes) code
            ) = snapshot_measurement_value -> 'serviceCodes'
            and (
              select coalesce(jsonb_agg(code order by code), '[]'::jsonb)
              from unnest(measurement.add_on_codes) code
            ) = snapshot_measurement_value -> 'addOnCodes'
            and measurement.version =
              (snapshot_measurement_value ->> 'version')::integer
            and measurement.updated_at =
              (snapshot_measurement_value ->> 'updatedAt')::timestamptz
            and not exists (
              select 1
              from public.property_measurements replacement
              where replacement.company_id = measurement.company_id
                and replacement.property_id = measurement.property_id
                and replacement.supersedes_measurement_id = measurement.id
            )
        )
      then
        raise exception 'ESTIMATE_SUPPORTING_MEASUREMENT_EVIDENCE_MISMATCH';
      end if;
    end loop;
    if exists (
      select 1
      from public.service_catalog catalog,
        unnest(catalog.required_measurement_kinds) required(kind)
      where catalog.company_id = p_company_id
        and catalog.code = service_value ->> 'serviceCode'
        and catalog.active
        and not exists (
          select 1
          from public.property_measurements measurement
          where measurement.company_id = p_company_id
            and measurement.property_id = p_property_id
            and measurement.kind = required.kind
            and service_value ->> 'serviceCode' = any(measurement.service_codes)
            and measurement.id in (
              select (service_value ->> 'measurementId')::uuid
              union
              select supporting.measurement_id::uuid
              from jsonb_array_elements_text(
                coalesce(service_value -> 'supportingMeasurementIds', '[]'::jsonb)
              ) supporting(measurement_id)
            )
        )
    ) then
      raise exception 'ESTIMATE_REQUIRED_MEASUREMENT_EVIDENCE_MISSING';
    end if;
$fragment$;
  old_service_line_validation text := $fragment$      select (service ->> 'measurementId')::uuid
      into expected_measurement_id
      from jsonb_array_elements(p_calculation_input -> 'services') service
      where service ->> 'serviceCode' = line_value ->> 'serviceCode'
        and (service ->> 'quantity')::numeric = (line_value ->> 'quantity')::numeric
      limit 1;
      if expected_measurement_id is null
        or line_value -> 'sourceMeasurementIds'
          <> jsonb_build_array(expected_measurement_id::text)
$fragment$;
  new_service_line_validation text := $fragment$      select
        jsonb_build_array(service ->> 'measurementId')
          || coalesce(service -> 'supportingMeasurementIds', '[]'::jsonb)
      into expected_service_measurement_ids
      from jsonb_array_elements(p_calculation_input -> 'services') service
      where service ->> 'serviceCode' = line_value ->> 'serviceCode'
        and (service ->> 'quantity')::numeric = (line_value ->> 'quantity')::numeric
      limit 1;
      if expected_service_measurement_ids is null
        or line_value -> 'sourceMeasurementIds'
          is distinct from expected_service_measurement_ids
$fragment$;
begin
  select pg_get_functiondef(function_signature)
  into function_definition;

  if position('ESTIMATE_SUPPORTING_MEASUREMENT_EVIDENCE_MISMATCH' in function_definition) > 0
    and position('expected_service_measurement_ids jsonb' in function_definition) > 0
  then
    return;
  end if;

  if position('ESTIMATE_SUPPORTING_MEASUREMENT_EVIDENCE_MISMATCH' in function_definition) > 0
    or position('expected_service_measurement_ids jsonb' in function_definition) > 0
    or position(declaration_marker in function_definition) = 0
    or position(add_on_id_validation_marker in function_definition) = 0
    or position(add_on_reference_marker in function_definition) = 0
    or position(add_on_input_marker in function_definition) = 0
    or position(old_service_line_validation in function_definition) = 0
  then
    raise exception
      'Unexpected persist_priced_estimate predecessor; refusing supporting-provenance upgrade';
  end if;

  function_definition := replace(
    function_definition,
    declaration_marker,
    declaration_replacement
  );
  function_definition := replace(
    function_definition,
    add_on_id_validation_marker,
    supporting_id_validation || add_on_id_validation_marker
  );
  function_definition := replace(
    function_definition,
    add_on_reference_marker,
    supporting_reference_union || add_on_reference_marker
  );
  function_definition := replace(
    function_definition,
    add_on_input_marker,
    supporting_evidence_validation || add_on_input_marker
  );
  function_definition := replace(
    function_definition,
    old_service_line_validation,
    new_service_line_validation
  );
  execute function_definition;

  select pg_get_functiondef(function_signature)
  into function_definition;
  if position('ESTIMATE_SUPPORTING_MEASUREMENT_EVIDENCE_MISMATCH' in function_definition) = 0
    or position('expected_service_measurement_ids jsonb' in function_definition) = 0
  then
    raise exception 'Supporting-measurement provenance upgrade did not install';
  end if;
end;
$upgrade_estimate_supporting_measurement_provenance$;

comment on function public.persist_priced_estimate(
  uuid, uuid, text, text, text, jsonb, uuid, uuid, uuid, uuid, uuid,
  text, jsonb, jsonb, text, text
) is
  'Atomically persists a server-priced estimate and quote after revalidating current customer, property, catalog, exact primary/supporting/add-on measurement provenance, reviewed travel-zone evidence, price-book, terms, hashes, and role.';
