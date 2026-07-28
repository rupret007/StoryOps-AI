\set ON_ERROR_STOP on

-- RPC-only estimating, exact decimal-rate, converted-lead, and measurement
-- applicability contract. All mutable fixtures roll back.

begin;

\echo '1/4 service role can execute snapshots but cannot read tenant tables'
do $$
declare
  table_name_value text;
  function_signature text;
begin
  foreach table_name_value in array array[
    'companies',
    'company_memberships',
    'leads',
    'customers',
    'properties',
    'service_catalog',
    'price_books',
    'price_book_service_rules',
    'price_book_attribute_multipliers',
    'price_book_add_ons',
    'price_book_travel_zones',
    'property_measurements',
    'photo_analyses',
    'service_terms'
  ]::text[]
  loop
    if has_table_privilege(
      'service_role',
      format('public.%I', table_name_value),
      'SELECT'
    ) then
      raise exception 'Service role unexpectedly has SELECT on %', table_name_value;
    end if;
  end loop;

  foreach function_signature in array array[
    'public.resolve_estimate_actor(uuid,uuid)',
    'public.load_active_price_book_snapshot(uuid,uuid)',
    'public.load_estimate_context_snapshot(uuid,uuid,uuid)',
    'public.load_estimate_calculation_snapshot(uuid,uuid,uuid,uuid,uuid,uuid[],text[])',
    'public.load_stored_estimate_pricing_snapshot(uuid,uuid)'
  ]::text[]
  loop
    if not has_function_privilege('service_role', function_signature, 'EXECUTE')
      or has_function_privilege('authenticated', function_signature, 'EXECUTE')
    then
      raise exception 'Estimate snapshot privilege boundary is invalid for %',
        function_signature;
    end if;
  end loop;
end;
$$;

\echo '2/4 snapshots are finite, tagged, and preserve six-decimal configured rates'
set local role service_role;
do $$
declare
  context_snapshot jsonb;
  price_snapshot jsonb;
  calculation_snapshot jsonb;
begin
  context_snapshot := public.load_estimate_context_snapshot(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000211'
  );
  if not exists (
    select 1
    from jsonb_array_elements(context_snapshot -> 'measurements') measurement
    where measurement ->> 'label' = 'Driveway'
      and measurement -> 'service_codes'
        = '["pressure-wash-flatwork"]'::jsonb
      and measurement -> 'add_on_codes' = '[]'::jsonb
  ) or not exists (
    select 1
    from jsonb_array_elements(context_snapshot -> 'measurements') measurement
    where measurement ->> 'label' = 'Downspouts'
      and measurement -> 'service_codes' = '[]'::jsonb
      and measurement -> 'add_on_codes' = '["downspout-flush"]'::jsonb
  ) then
    raise exception 'Context snapshot omitted authoritative measurement applicability';
  end if;

  price_snapshot := public.load_active_price_book_snapshot(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000401'
  );
  if not exists (
    select 1
    from jsonb_array_elements(price_snapshot -> 'rules') rule
    where rule ->> 'service_code' = 'pressure-wash-flatwork'
      and rule ->> 'unit_price' = '0.180000'
      and rule ->> 'estimated_unit_cost' = '0.040000'
  ) then
    raise exception 'Price snapshot rounded or omitted configured six-decimal rates';
  end if;

  calculation_snapshot := public.load_estimate_calculation_snapshot(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    '10000000-0000-4000-8000-000000000222',
    array['10000000-0000-4000-8000-000000000441']::uuid[],
    array['pressure-wash-flatwork']::text[]
  );
  if calculation_snapshot #>> '{lead,status}' <> 'converted'
    or calculation_snapshot #>> '{lead,customer_id}'
      <> '10000000-0000-4000-8000-000000000201'
    or calculation_snapshot #>> '{lead,property_id}'
      <> '10000000-0000-4000-8000-000000000211'
    or calculation_snapshot #>> '{service_catalog,0,code}'
      <> 'pressure-wash-flatwork'
    or calculation_snapshot #>> '{service_catalog,0,active}' <> 'true'
    or nullif(
      calculation_snapshot #>> '{service_catalog,0,safety_sop_reference}',
      ''
    ) is null
  then
    raise exception 'Exact lead or service-catalog snapshot was rejected or relabeled';
  end if;
end;
$$;
reset role;

\echo '3/4 same-kind evidence and post-snapshot catalog drift fail closed'
insert into public.property_measurements(
  id,
  company_id,
  property_id,
  kind,
  label,
  value,
  unit,
  source,
  measured_at,
  measured_by,
  confidence,
  verified_by_human,
  service_codes,
  add_on_codes
)
values (
  '97000000-0000-4000-8000-000000000441',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000211',
  'area_sq_ft',
  'House siding area',
  100,
  'sq_ft',
  'field_measured',
  now(),
  '10000000-0000-4000-8000-000000000101',
  1,
  true,
  array['soft-wash-house'],
  '{}'
);

do $$
declare
  customer_row public.customers%rowtype;
  property_row public.properties%rowtype;
  measurement_row public.property_measurements%rowtype;
  catalog_row public.service_catalog%rowtype;
  terms_row public.service_terms%rowtype;
  calculated_at_value timestamptz := now();
  calculation_input jsonb;
  authoritative_snapshot jsonb;
  pricing_result jsonb;
  rejected boolean := false;
  catalog_drift_rejected boolean := false;
  catalog_sop_drift_rejected boolean := false;
begin
  select * into customer_row
  from public.customers
  where id = '10000000-0000-4000-8000-000000000201';
  select * into property_row
  from public.properties
  where id = '10000000-0000-4000-8000-000000000211';
  select * into measurement_row
  from public.property_measurements
  where id = '97000000-0000-4000-8000-000000000441';
  select * into catalog_row
  from public.service_catalog
  where company_id = '10000000-0000-4000-8000-000000000001'
    and code = 'pressure-wash-flatwork';
  select * into terms_row
  from public.service_terms
  where id = '10000000-0000-4000-8000-000000000152';

  calculation_input := jsonb_build_object(
    'services', jsonb_build_array(jsonb_build_object(
      'serviceCode', 'pressure-wash-flatwork',
      'measurementId', measurement_row.id,
      'quantity', measurement_row.value::text,
      'pricingUnit', 'sq_ft',
      'attributes', '{}'::jsonb,
      'addOns', '[]'::jsonb,
      'classificationEvidence', jsonb_build_object(
        'source', 'operator_assertion',
        'assertedBy', '10000000-0000-4000-8000-000000000101',
        'assertedAt', calculated_at_value
      ),
      'sourceMeasurementIds', jsonb_build_array(measurement_row.id)
    )),
    'travelZoneCode', 'DFW-CORE',
    'travelZoneEvidence', jsonb_build_object(
      'source', 'postal_code',
      'postalCode', '75219',
      'derivedAt', calculated_at_value
    ),
    'discount', jsonb_build_object('kind', 'none')
  );
  authoritative_snapshot := jsonb_build_object(
    'companyId', '10000000-0000-4000-8000-000000000001',
    'customer', jsonb_build_object(
      'id', customer_row.id,
      'taxExempt', customer_row.tax_exempt,
      'version', customer_row.version,
      'updatedAt', customer_row.updated_at
    ),
    'property', jsonb_build_object(
      'id', property_row.id,
      'stories', property_row.stories,
      'version', property_row.version,
      'updatedAt', property_row.updated_at,
      'postalCode', '75219'
    ),
    'priceBook', jsonb_build_object(
      'id', '10000000-0000-4000-8000-000000000401',
      'versionLabel', '2026.1'
    ),
    'serviceTerms', jsonb_build_object(
      'id', terms_row.id,
      'versionLabel', terms_row.version_label,
      'reviewedAt', terms_row.reviewed_at,
      'reviewReference', terms_row.review_reference
    ),
    'serviceCatalog', jsonb_build_array(jsonb_build_object(
      'id', catalog_row.id,
      'code', catalog_row.code,
      'version', catalog_row.version,
      'active', catalog_row.active,
      'safetySopReference', catalog_row.safety_sop_reference
    )),
    'travelZone', jsonb_build_object(
      'code', 'DFW-CORE',
      'source', 'postal_code',
      'postalCode', '75219'
    ),
    'photoEvidence', null,
    'measurements', jsonb_build_array(jsonb_build_object(
      'id', measurement_row.id,
      'value', measurement_row.value::text,
      'kind', measurement_row.kind,
      'unit', measurement_row.unit,
      'serviceCodes', to_jsonb(measurement_row.service_codes),
      'addOnCodes', to_jsonb(measurement_row.add_on_codes),
      'version', measurement_row.version,
      'updatedAt', measurement_row.updated_at
    ))
  );
  pricing_result := jsonb_build_object(
    'calculationVersion', 'storyops-pricing-v1.1.0',
    'requestId', 'estimate:' || repeat('b', 64),
    'quoteable', true,
    'lines', jsonb_build_array(jsonb_build_object(
      'kind', 'service',
      'serviceCode', 'pressure-wash-flatwork',
      'description', 'Pressure Wash Flatwork',
      'quantity', '100',
      'unit', 'sq_ft',
      'unitPrice', '0.185000',
      'multiplier', '1',
      'subtotal', jsonb_build_object('amount', '18.50', 'currency', 'USD'),
      'taxable', true,
      'estimatedCost', jsonb_build_object('amount', '1.49', 'currency', 'USD'),
      'sourceMeasurementIds', jsonb_build_array(measurement_row.id)
    )),
    'serviceSubtotal', jsonb_build_object('amount', '18.50', 'currency', 'USD'),
    'minimumAdjustment', jsonb_build_object('amount', '0.00', 'currency', 'USD'),
    'travelFee', jsonb_build_object('amount', '0.00', 'currency', 'USD'),
    'manualAdjustment', jsonb_build_object('amount', '0.00', 'currency', 'USD'),
    'subtotalBeforeDiscount', jsonb_build_object('amount', '18.50', 'currency', 'USD'),
    'discount', jsonb_build_object('amount', '0.00', 'currency', 'USD'),
    'taxableSubtotal', jsonb_build_object('amount', '18.50', 'currency', 'USD'),
    'tax', jsonb_build_object('amount', '1.53', 'currency', 'USD'),
    'total', jsonb_build_object('amount', '20.03', 'currency', 'USD'),
    'depositRequired', jsonb_build_object('amount', '5.01', 'currency', 'USD'),
    'estimatedCost', jsonb_build_object('amount', '1.49', 'currency', 'USD'),
    'marginPercent', '91.95',
    'durationMinutes', 1,
    'issues', '[]'::jsonb,
    'approvalFlags', '[]'::jsonb,
    'priceBookId', '10000000-0000-4000-8000-000000000401',
    'priceBookVersion', '2026.1',
    'calculatedAt', calculated_at_value
  );

  begin
    perform public.persist_priced_estimate(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      'scope-mismatch-contract-0001',
      repeat('a', 64),
      repeat('b', 64),
      authoritative_snapshot,
      customer_row.id,
      property_row.id,
      null,
      '10000000-0000-4000-8000-000000000401',
      terms_row.id,
      '2026.1',
      calculation_input,
      pricing_result,
      terms_row.version_label,
      terms_row.terms_text
    );
  exception
    when others then
      if position('ESTIMATE_SERVICE_EVIDENCE_MISMATCH' in sqlerrm) > 0 then
        rejected := true;
      else
        raise;
      end if;
  end;
  if not rejected then
    raise exception 'Same-kind measurement crossed its authoritative service tag';
  end if;

  select * into measurement_row
  from public.property_measurements
  where id = '10000000-0000-4000-8000-000000000441';
  calculation_input := jsonb_set(
    calculation_input,
    '{services}',
    jsonb_build_array(jsonb_build_object(
      'serviceCode', 'pressure-wash-flatwork',
      'measurementId', measurement_row.id,
      'quantity', measurement_row.value::text,
      'pricingUnit', 'sq_ft',
      'attributes', '{}'::jsonb,
      'addOns', '[]'::jsonb,
      'classificationEvidence', jsonb_build_object(
        'source', 'operator_assertion',
        'assertedBy', '10000000-0000-4000-8000-000000000101',
        'assertedAt', calculated_at_value
      ),
      'sourceMeasurementIds', jsonb_build_array(measurement_row.id)
    ))
  );
  authoritative_snapshot := jsonb_set(
    authoritative_snapshot,
    '{measurements}',
    jsonb_build_array(jsonb_build_object(
      'id', measurement_row.id,
      'value', measurement_row.value::text,
      'kind', measurement_row.kind,
      'unit', measurement_row.unit,
      'serviceCodes', to_jsonb(measurement_row.service_codes),
      'addOnCodes', to_jsonb(measurement_row.add_on_codes),
      'version', measurement_row.version,
      'updatedAt', measurement_row.updated_at
    ))
  );
  pricing_result := jsonb_set(
    jsonb_set(
      pricing_result,
      '{requestId}',
      to_jsonb('estimate:' || repeat('c', 64))
    ),
    '{lines,0,quantity}',
    to_jsonb(measurement_row.value::text)
  );

  update public.service_catalog
  set active = false
  where id = catalog_row.id;

  begin
    perform public.persist_priced_estimate(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      'catalog-drift-contract-0001',
      repeat('d', 64),
      repeat('c', 64),
      authoritative_snapshot,
      customer_row.id,
      property_row.id,
      null,
      '10000000-0000-4000-8000-000000000401',
      terms_row.id,
      '2026.1',
      calculation_input,
      pricing_result,
      terms_row.version_label,
      terms_row.terms_text
    );
  exception
    when others then
      if position('ESTIMATE_SERVICE_CATALOG_CHANGED' in sqlerrm) > 0 then
        catalog_drift_rejected := true;
      else
        raise;
      end if;
  end;
  if not catalog_drift_rejected then
    raise exception 'Catalog deactivation/version drift survived snapshot revalidation';
  end if;

  execute 'alter table public.service_catalog disable trigger service_catalog_touch';
  update public.service_catalog
  set
    active = catalog_row.active,
    version = catalog_row.version,
    updated_at = catalog_row.updated_at,
    safety_sop_reference = catalog_row.safety_sop_reference || '-DRIFT'
  where id = catalog_row.id;
  execute 'alter table public.service_catalog enable trigger service_catalog_touch';
  pricing_result := jsonb_set(
    pricing_result,
    '{requestId}',
    to_jsonb('estimate:' || repeat('e', 64))
  );

  begin
    perform public.persist_priced_estimate(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      'catalog-sop-drift-contract-0001',
      repeat('f', 64),
      repeat('e', 64),
      authoritative_snapshot,
      customer_row.id,
      property_row.id,
      null,
      '10000000-0000-4000-8000-000000000401',
      terms_row.id,
      '2026.1',
      calculation_input,
      pricing_result,
      terms_row.version_label,
      terms_row.terms_text
    );
  exception
    when others then
      if position('ESTIMATE_SERVICE_CATALOG_CHANGED' in sqlerrm) > 0 then
        catalog_sop_drift_rejected := true;
      else
        raise;
      end if;
  end;
  if not catalog_sop_drift_rejected then
    raise exception 'Catalog SOP drift survived exact snapshot revalidation';
  end if;
end;
$$;

\echo '4/4 declarative migration and schema are exercised by the release runner'
rollback;

\echo 'live estimating security contract: PASS'
