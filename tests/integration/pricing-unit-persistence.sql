\set ON_ERROR_STOP on

begin;

\echo '1/3 create a non-photo field-service fixture with flat, hourly, and supporting evidence'
insert into public.properties(
  id,
  company_id,
  customer_id,
  name,
  property_type,
  service_address,
  stories
)
values
  (
    '98000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'Pricing-unit persistence contract',
    'other',
    '{"line1":"1 Contract Way","city":"Dallas","region":"TX","postalCode":"75219","country":"US"}'::jsonb,
    1
  ),
  (
    '98000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'Wrong-property evidence contract',
    'other',
    '{"line1":"2 Contract Way","city":"Dallas","region":"TX","postalCode":"75219","country":"US"}'::jsonb,
    1
  );

insert into public.service_catalog(
  id,
  company_id,
  code,
  name,
  description,
  category,
  active,
  taxable,
  required_measurement_kinds,
  safety_sop_reference,
  scope_evidence_policy
)
values
  (
    '98000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000001',
    'flat-contract',
    'Flat contract service',
    'Test-only fixed-price service with count evidence.',
    'contract_service',
    true,
    true,
    array['count', 'height_ft'],
    'TEST-SOP-FLAT',
    'not_applicable'
  ),
  (
    '98000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000001',
    'hour-contract',
    'Hourly contract service',
    'Test-only hourly service with duration evidence.',
    'contract_service',
    true,
    true,
    array['duration_hours'],
    'TEST-SOP-HOUR',
    'not_applicable'
  );

insert into public.price_books(
  id,
  company_id,
  name,
  version_label,
  status,
  effective_from,
  currency,
  company_minimum,
  default_tax_rate_pct,
  margin_floor_pct,
  automatic_discount_limit_pct,
  deposit_kind,
  deposit_value
)
values (
  '98000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000001',
  'Pricing-unit persistence contract',
  'contract-1',
  'draft',
  now() - interval '1 day',
  'USD',
  0,
  8.25,
  0,
  0,
  'percent',
  25
);

insert into public.price_book_service_rules(
  id,
  company_id,
  price_book_id,
  service_catalog_id,
  service_code,
  pricing_unit,
  base_price,
  unit_price,
  included_quantity,
  service_minimum,
  estimated_base_cost,
  estimated_unit_cost,
  duration_base_minutes,
  duration_minutes_per_unit,
  taxable,
  allowed_attribute_values
)
values
  (
    '98000000-0000-4000-8000-000000000021',
    '10000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000010',
    '98000000-0000-4000-8000-000000000011',
    'flat-contract',
    'flat',
    50,
    0,
    0,
    50,
    10,
    0,
    30,
    0,
    true,
    '{}'::jsonb
  ),
  (
    '98000000-0000-4000-8000-000000000022',
    '10000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000010',
    '98000000-0000-4000-8000-000000000012',
    'hour-contract',
    'hour',
    0,
    100,
    0,
    0,
    0,
    30,
    0,
    60,
    true,
    '{}'::jsonb
  );

insert into public.price_book_add_ons(
  id,
  company_id,
  service_rule_id,
  code,
  name,
  pricing_unit,
  unit_price,
  estimated_unit_cost,
  duration_minutes_per_unit,
  taxable
)
values
  (
    '98000000-0000-4000-8000-000000000031',
    '10000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000021',
    'flat-contract-addon',
    'Flat contract add-on',
    'flat',
    10,
    2,
    5,
    true
  ),
  (
    '98000000-0000-4000-8000-000000000032',
    '10000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000022',
    'hour-contract-addon',
    'Hourly contract add-on',
    'hour',
    20,
    4,
    10,
    true
  );

insert into public.price_book_travel_zones(
  id,
  company_id,
  price_book_id,
  zone_code,
  name,
  fee,
  taxable,
  maximum_one_way_miles,
  postal_codes,
  mapping_evidence_source,
  mapping_reviewed_by,
  mapping_reviewed_at,
  mapping_review_reference
)
values (
  '98000000-0000-4000-8000-000000000033',
  '10000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000010',
  'CONTRACT',
  'Reviewed contract ZIP',
  0,
  false,
  null,
  array['75219'],
  'reviewed_postal_codes',
  'Contract fixture reviewer',
  now() - interval '1 hour',
  'pricing-unit-contract-reviewed-zone'
);

update public.price_books
set status = 'retired'
where id = '10000000-0000-4000-8000-000000000401';

update public.price_books
set
  status = 'active',
  published_by = '10000000-0000-4000-8000-000000000101',
  published_at = now()
where id = '98000000-0000-4000-8000-000000000010';

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
values
  (
    '98000000-0000-4000-8000-000000000041',
    '10000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000001',
    'count',
    'One fixed service',
    1,
    'each',
    'field_measured',
    now(),
    '10000000-0000-4000-8000-000000000101',
    1,
    true,
    array['flat-contract'],
    array['flat-contract-addon']
  ),
  (
    '98000000-0000-4000-8000-000000000042',
    '10000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000001',
    'duration_hours',
    'Two labor hours',
    2,
    'hour',
    'field_measured',
    now(),
    '10000000-0000-4000-8000-000000000101',
    1,
    true,
    array['hour-contract'],
    array['hour-contract-addon']
  ),
  (
    '98000000-0000-4000-8000-000000000043',
    '10000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000001',
    'height_ft',
    'Verified service height',
    12,
    'ft',
    'field_measured',
    now(),
    '10000000-0000-4000-8000-000000000101',
    1,
    true,
    array['flat-contract'],
    '{}'::text[]
  ),
  (
    '98000000-0000-4000-8000-000000000044',
    '10000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    'height_ft',
    'Other property service height',
    14,
    'ft',
    'field_measured',
    now(),
    '10000000-0000-4000-8000-000000000101',
    1,
    true,
    array['flat-contract'],
    '{}'::text[]
  );

\echo '2/3 enforce exact supporting provenance and persist the valid evidence set'
do $$
declare
  company_id_value constant uuid := '10000000-0000-4000-8000-000000000001';
  actor_id_value constant uuid := '10000000-0000-4000-8000-000000000101';
  customer_id_value constant uuid := '10000000-0000-4000-8000-000000000201';
  property_id_value constant uuid := '98000000-0000-4000-8000-000000000001';
  price_book_id_value constant uuid := '98000000-0000-4000-8000-000000000010';
  terms_id_value constant uuid := '10000000-0000-4000-8000-000000000152';
  flat_measurement public.property_measurements%rowtype;
  hour_measurement public.property_measurements%rowtype;
  supporting_measurement public.property_measurements%rowtype;
  wrong_property_measurement public.property_measurements%rowtype;
  customer_row public.customers%rowtype;
  property_row public.properties%rowtype;
  terms_row public.service_terms%rowtype;
  zone_row public.price_book_travel_zones%rowtype;
  catalog_snapshot jsonb;
  measurement_snapshot jsonb;
  wrong_property_snapshot jsonb;
  calculation_input jsonb;
  authoritative_snapshot jsonb;
  pricing_result jsonb;
  receipt jsonb;
  estimate_id_value uuid;
  calculated_at_value timestamptz := now();
begin
  select * into customer_row from public.customers where id = customer_id_value;
  select * into property_row from public.properties where id = property_id_value;
  select * into terms_row from public.service_terms where id = terms_id_value;
  select * into strict zone_row
  from public.price_book_travel_zones
  where company_id = company_id_value
    and price_book_id = price_book_id_value
    and '75219' = any(postal_codes);
  select * into flat_measurement
  from public.property_measurements
  where id = '98000000-0000-4000-8000-000000000041';
  select * into hour_measurement
  from public.property_measurements
  where id = '98000000-0000-4000-8000-000000000042';
  select * into supporting_measurement
  from public.property_measurements
  where id = '98000000-0000-4000-8000-000000000043';
  select * into wrong_property_measurement
  from public.property_measurements
  where id = '98000000-0000-4000-8000-000000000044';

  select jsonb_agg(
    jsonb_build_object(
      'id', catalog.id,
      'code', catalog.code,
      'version', catalog.version,
      'active', catalog.active,
      'safetySopReference', catalog.safety_sop_reference
    )
    order by catalog.code
  )
  into catalog_snapshot
  from public.service_catalog catalog
  where catalog.company_id = company_id_value
    and catalog.code in ('flat-contract', 'hour-contract');

  measurement_snapshot := jsonb_build_array(
    jsonb_build_object(
      'id', flat_measurement.id,
      'value', flat_measurement.value::text,
      'kind', flat_measurement.kind,
      'unit', flat_measurement.unit,
      'serviceCodes', to_jsonb(flat_measurement.service_codes),
      'addOnCodes', to_jsonb(flat_measurement.add_on_codes),
      'version', flat_measurement.version,
      'updatedAt', flat_measurement.updated_at
    ),
    jsonb_build_object(
      'id', hour_measurement.id,
      'value', hour_measurement.value::text,
      'kind', hour_measurement.kind,
      'unit', hour_measurement.unit,
      'serviceCodes', to_jsonb(hour_measurement.service_codes),
      'addOnCodes', to_jsonb(hour_measurement.add_on_codes),
      'version', hour_measurement.version,
      'updatedAt', hour_measurement.updated_at
    ),
    jsonb_build_object(
      'id', supporting_measurement.id,
      'value', supporting_measurement.value::text,
      'kind', supporting_measurement.kind,
      'unit', supporting_measurement.unit,
      'serviceCodes', to_jsonb(supporting_measurement.service_codes),
      'addOnCodes', to_jsonb(supporting_measurement.add_on_codes),
      'version', supporting_measurement.version,
      'updatedAt', supporting_measurement.updated_at
    )
  );
  wrong_property_snapshot := jsonb_build_object(
    'id', wrong_property_measurement.id,
    'value', wrong_property_measurement.value::text,
    'kind', wrong_property_measurement.kind,
    'unit', wrong_property_measurement.unit,
    'serviceCodes', to_jsonb(wrong_property_measurement.service_codes),
    'addOnCodes', to_jsonb(wrong_property_measurement.add_on_codes),
    'version', wrong_property_measurement.version,
    'updatedAt', wrong_property_measurement.updated_at
  );

  calculation_input := jsonb_build_object(
    'services', jsonb_build_array(
      jsonb_build_object(
        'serviceCode', 'flat-contract',
        'measurementId', flat_measurement.id,
        'supportingMeasurementIds', jsonb_build_array(supporting_measurement.id),
        'quantity', flat_measurement.value::text,
        'pricingUnit', 'flat',
        'attributes', '{}'::jsonb,
        'addOns', jsonb_build_array(jsonb_build_object(
          'code', 'flat-contract-addon',
          'measurementId', flat_measurement.id,
          'quantity', flat_measurement.value::text,
          'pricingUnit', 'flat'
        )),
        'classificationEvidence', jsonb_build_object(
          'source', 'operator_assertion',
          'assertedBy', actor_id_value,
          'assertedAt', calculated_at_value
        ),
        'sourceMeasurementIds', jsonb_build_array(
          flat_measurement.id,
          supporting_measurement.id
        )
      ),
      jsonb_build_object(
        'serviceCode', 'hour-contract',
        'measurementId', hour_measurement.id,
        'quantity', hour_measurement.value::text,
        'pricingUnit', 'hour',
        'attributes', '{}'::jsonb,
        'addOns', jsonb_build_array(jsonb_build_object(
          'code', 'hour-contract-addon',
          'measurementId', hour_measurement.id,
          'quantity', hour_measurement.value::text,
          'pricingUnit', 'hour'
        )),
        'classificationEvidence', jsonb_build_object(
          'source', 'operator_assertion',
          'assertedBy', actor_id_value,
          'assertedAt', calculated_at_value
        ),
        'sourceMeasurementIds', jsonb_build_array(hour_measurement.id)
      )
    ),
    'travelZoneCode', zone_row.zone_code,
    'travelZoneEvidence', jsonb_build_object(
      'source', 'reviewed_postal_code',
      'postalCode', '75219',
      'mappingReviewedBy', zone_row.mapping_reviewed_by,
      'mappingReviewedAt', zone_row.mapping_reviewed_at,
      'mappingReviewReference', zone_row.mapping_review_reference,
      'derivedAt', calculated_at_value
    ),
    'scopeEvidenceDisposition', 'not_applicable',
    'scopeEvidencePolicies', jsonb_build_array(
      jsonb_build_object('serviceCode', 'flat-contract', 'policy', 'not_applicable'),
      jsonb_build_object('serviceCode', 'hour-contract', 'policy', 'not_applicable')
    ),
    'discount', jsonb_build_object('kind', 'none')
  );

  authoritative_snapshot := jsonb_build_object(
    'companyId', company_id_value,
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
    'priceBook', jsonb_build_object('id', price_book_id_value, 'versionLabel', 'contract-1'),
    'serviceTerms', jsonb_build_object(
      'id', terms_row.id,
      'versionLabel', terms_row.version_label,
      'reviewedAt', terms_row.reviewed_at,
      'reviewReference', terms_row.review_reference
    ),
    'serviceCatalog', catalog_snapshot,
    'travelZone', jsonb_build_object(
      'code', zone_row.zone_code,
      'source', 'reviewed_postal_code',
      'postalCode', '75219',
      'mappingReviewedBy', zone_row.mapping_reviewed_by,
      'mappingReviewedAt', zone_row.mapping_reviewed_at,
      'mappingReviewReference', zone_row.mapping_review_reference
    ),
    'photoEvidence', null,
    'measurements', measurement_snapshot
  );

  pricing_result := jsonb_build_object(
    'calculationVersion', 'storyops-pricing-v1.1.0',
    'requestId', 'estimate:' || repeat('a', 64),
    'quoteable', true,
    'lines', jsonb_build_array(
      jsonb_build_object(
        'kind', 'service', 'serviceCode', 'flat-contract',
        'description', 'Flat contract service', 'quantity', '1', 'unit', 'flat',
        'unitPrice', '0.000000', 'multiplier', '1',
        'subtotal', jsonb_build_object('amount', '50.00', 'currency', 'USD'),
        'taxable', true,
        'estimatedCost', jsonb_build_object('amount', '10.00', 'currency', 'USD'),
        'sourceMeasurementIds', jsonb_build_array(
          flat_measurement.id,
          supporting_measurement.id
        )
      ),
      jsonb_build_object(
        'kind', 'add_on', 'serviceCode', 'flat-contract',
        'addOnCode', 'flat-contract-addon',
        'description', 'Flat contract add-on', 'quantity', '1', 'unit', 'flat',
        'unitPrice', '10.000000', 'multiplier', '1',
        'subtotal', jsonb_build_object('amount', '10.00', 'currency', 'USD'),
        'taxable', true,
        'estimatedCost', jsonb_build_object('amount', '2.00', 'currency', 'USD'),
        'sourceMeasurementIds', jsonb_build_array(flat_measurement.id)
      ),
      jsonb_build_object(
        'kind', 'service', 'serviceCode', 'hour-contract',
        'description', 'Hourly contract service', 'quantity', '2', 'unit', 'hour',
        'unitPrice', '100.000000', 'multiplier', '1',
        'subtotal', jsonb_build_object('amount', '200.00', 'currency', 'USD'),
        'taxable', true,
        'estimatedCost', jsonb_build_object('amount', '60.00', 'currency', 'USD'),
        'sourceMeasurementIds', jsonb_build_array(hour_measurement.id)
      ),
      jsonb_build_object(
        'kind', 'add_on', 'serviceCode', 'hour-contract',
        'addOnCode', 'hour-contract-addon',
        'description', 'Hourly contract add-on', 'quantity', '2', 'unit', 'hour',
        'unitPrice', '20.000000', 'multiplier', '1',
        'subtotal', jsonb_build_object('amount', '40.00', 'currency', 'USD'),
        'taxable', true,
        'estimatedCost', jsonb_build_object('amount', '8.00', 'currency', 'USD'),
        'sourceMeasurementIds', jsonb_build_array(hour_measurement.id)
      )
    ),
    'serviceSubtotal', jsonb_build_object('amount', '300.00', 'currency', 'USD'),
    'minimumAdjustment', jsonb_build_object('amount', '0.00', 'currency', 'USD'),
    'travelFee', jsonb_build_object('amount', '0.00', 'currency', 'USD'),
    'manualAdjustment', jsonb_build_object('amount', '0.00', 'currency', 'USD'),
    'subtotalBeforeDiscount', jsonb_build_object('amount', '300.00', 'currency', 'USD'),
    'discount', jsonb_build_object('amount', '0.00', 'currency', 'USD'),
    'taxableSubtotal', jsonb_build_object('amount', '300.00', 'currency', 'USD'),
    'tax', jsonb_build_object('amount', '24.75', 'currency', 'USD'),
    'total', jsonb_build_object('amount', '324.75', 'currency', 'USD'),
    'depositRequired', jsonb_build_object('amount', '81.19', 'currency', 'USD'),
    'estimatedCost', jsonb_build_object('amount', '80.00', 'currency', 'USD'),
    'marginPercent', '73.33',
    'durationMinutes', 300,
    'issues', '[]'::jsonb,
    'approvalFlags', '[]'::jsonb,
    'priceBookId', price_book_id_value,
    'priceBookVersion', 'contract-1',
    'calculatedAt', calculated_at_value
  );

  begin
    perform public.persist_priced_estimate(
      company_id_value,
      actor_id_value,
      'supporting-provenance-missing-0001',
      repeat('1', 64),
      repeat('a', 64),
      authoritative_snapshot,
      customer_id_value,
      property_id_value,
      null,
      price_book_id_value,
      terms_id_value,
      'contract-1',
      calculation_input,
      jsonb_set(
        pricing_result,
        '{lines,0,sourceMeasurementIds}',
        jsonb_build_array(flat_measurement.id)
      ),
      terms_row.version_label,
      terms_row.terms_text
    );
    raise exception 'MISSING_SUPPORTING_PROVENANCE_ACCEPTED';
  exception
    when others then
      if sqlerrm = 'MISSING_SUPPORTING_PROVENANCE_ACCEPTED'
        or position('ESTIMATE_SERVICE_LINE_EVIDENCE_MISMATCH' in sqlerrm) = 0
      then
        raise;
      end if;
  end;

  begin
    perform public.persist_priced_estimate(
      company_id_value,
      actor_id_value,
      'supporting-provenance-extra-0001',
      repeat('2', 64),
      repeat('a', 64),
      authoritative_snapshot,
      customer_id_value,
      property_id_value,
      null,
      price_book_id_value,
      terms_id_value,
      'contract-1',
      calculation_input,
      jsonb_set(
        pricing_result,
        '{lines,0,sourceMeasurementIds}',
        jsonb_build_array(
          flat_measurement.id,
          supporting_measurement.id,
          hour_measurement.id
        )
      ),
      terms_row.version_label,
      terms_row.terms_text
    );
    raise exception 'EXTRA_SUPPORTING_PROVENANCE_ACCEPTED';
  exception
    when others then
      if sqlerrm = 'EXTRA_SUPPORTING_PROVENANCE_ACCEPTED'
        or position('ESTIMATE_SERVICE_LINE_EVIDENCE_MISMATCH' in sqlerrm) = 0
      then
        raise;
      end if;
  end;

  begin
    perform public.persist_priced_estimate(
      company_id_value,
      actor_id_value,
      'supporting-provenance-duplicate-0001',
      repeat('3', 64),
      repeat('a', 64),
      authoritative_snapshot,
      customer_id_value,
      property_id_value,
      null,
      price_book_id_value,
      terms_id_value,
      'contract-1',
      jsonb_set(
        calculation_input,
        '{services,0,supportingMeasurementIds}',
        jsonb_build_array(supporting_measurement.id, supporting_measurement.id)
      ),
      jsonb_set(
        pricing_result,
        '{lines,0,sourceMeasurementIds}',
        jsonb_build_array(
          flat_measurement.id,
          supporting_measurement.id,
          supporting_measurement.id
        )
      ),
      terms_row.version_label,
      terms_row.terms_text
    );
    raise exception 'DUPLICATE_SUPPORTING_PROVENANCE_ACCEPTED';
  exception
    when others then
      if sqlerrm = 'DUPLICATE_SUPPORTING_PROVENANCE_ACCEPTED'
        or position('ESTIMATE_MEASUREMENT_IDS_INVALID' in sqlerrm) = 0
      then
        raise;
      end if;
  end;

  begin
    perform public.persist_priced_estimate(
      company_id_value,
      actor_id_value,
      'supporting-provenance-wrong-property-0001',
      repeat('4', 64),
      repeat('a', 64),
      jsonb_set(
        authoritative_snapshot,
        '{measurements}',
        (measurement_snapshot - 2) || jsonb_build_array(wrong_property_snapshot)
      ),
      customer_id_value,
      property_id_value,
      null,
      price_book_id_value,
      terms_id_value,
      'contract-1',
      jsonb_set(
        jsonb_set(
          calculation_input,
          '{services,0,supportingMeasurementIds}',
          jsonb_build_array(wrong_property_measurement.id)
        ),
        '{services,0,sourceMeasurementIds}',
        jsonb_build_array(flat_measurement.id, wrong_property_measurement.id)
      ),
      jsonb_set(
        pricing_result,
        '{lines,0,sourceMeasurementIds}',
        jsonb_build_array(flat_measurement.id, wrong_property_measurement.id)
      ),
      terms_row.version_label,
      terms_row.terms_text
    );
    raise exception 'WRONG_PROPERTY_SUPPORTING_PROVENANCE_ACCEPTED';
  exception
    when others then
      if sqlerrm = 'WRONG_PROPERTY_SUPPORTING_PROVENANCE_ACCEPTED'
        or position('ESTIMATE_MEASUREMENT_EVIDENCE_REQUIRED' in sqlerrm) = 0
      then
        raise;
      end if;
  end;

  begin
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
      add_on_codes,
      supersedes_measurement_id
    )
    values (
      '98000000-0000-4000-8000-000000000045',
      company_id_value,
      property_id_value,
      'height_ft',
      'Replacement service height',
      13,
      'ft',
      'field_measured',
      now(),
      actor_id_value,
      1,
      true,
      array['flat-contract'],
      '{}'::text[],
      supporting_measurement.id
    );
    perform public.persist_priced_estimate(
      company_id_value,
      actor_id_value,
      'supporting-provenance-superseded-0001',
      repeat('5', 64),
      repeat('a', 64),
      authoritative_snapshot,
      customer_id_value,
      property_id_value,
      null,
      price_book_id_value,
      terms_id_value,
      'contract-1',
      calculation_input,
      pricing_result,
      terms_row.version_label,
      terms_row.terms_text
    );
    raise exception 'SUPERSEDED_SUPPORTING_PROVENANCE_ACCEPTED';
  exception
    when others then
      if sqlerrm = 'SUPERSEDED_SUPPORTING_PROVENANCE_ACCEPTED'
        or position('ESTIMATE_SUPPORTING_MEASUREMENT_EVIDENCE_MISMATCH' in sqlerrm) = 0
      then
        raise;
      end if;
  end;

  receipt := public.persist_priced_estimate(
    company_id_value,
    actor_id_value,
    'pricing-unit-contract-0001',
    repeat('b', 64),
    repeat('a', 64),
    authoritative_snapshot,
    customer_id_value,
    property_id_value,
    null,
    price_book_id_value,
    terms_id_value,
    'contract-1',
    calculation_input,
    pricing_result,
    terms_row.version_label,
    terms_row.terms_text
  );
  estimate_id_value := (receipt ->> 'estimateId')::uuid;

  if receipt ->> 'estimateStatus' <> 'approved'
    or (select count(*) from public.estimate_lines where estimate_id = estimate_id_value) <> 4
    or not exists (
      select 1 from public.estimate_lines
      where estimate_id = estimate_id_value
        and line_kind = 'service'
        and service_code = 'flat-contract'
        and unit = 'flat'
        and quantity = 1
        and source_measurement_ids = array[
          flat_measurement.id,
          supporting_measurement.id
        ]::uuid[]
    )
    or not exists (
      select 1 from public.estimate_lines
      where estimate_id = estimate_id_value
        and line_kind = 'add_on'
        and add_on_code = 'flat-contract-addon'
        and unit = 'flat'
        and quantity = 1
    )
    or not exists (
      select 1 from public.estimate_lines
      where estimate_id = estimate_id_value
        and line_kind = 'service'
        and service_code = 'hour-contract'
        and unit = 'hour'
        and quantity = 2
    )
    or not exists (
      select 1 from public.estimate_lines
      where estimate_id = estimate_id_value
        and line_kind = 'add_on'
        and add_on_code = 'hour-contract-addon'
        and unit = 'hour'
        and quantity = 2
    )
  then
    raise exception 'Flat/hour service and add-on evidence did not persist exactly';
  end if;
end;
$$;

\echo '3/3 flat pricing rejects count evidence whose quantity is not exactly one'
do $$
declare
  rejected boolean := false;
  error_text text;
  invalid_calculated_at timestamptz := clock_timestamp();
begin
  update public.property_measurements
  set value = 2
  where id = '98000000-0000-4000-8000-000000000041';

  begin
    perform public.persist_priced_estimate(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      'pricing-unit-contract-invalid-0001',
      repeat('c', 64),
      repeat('d', 64),
      jsonb_build_object(
        'companyId', '10000000-0000-4000-8000-000000000001',
        'customer', jsonb_build_object(
          'id', customer.id,
          'taxExempt', customer.tax_exempt,
          'version', customer.version,
          'updatedAt', customer.updated_at
        ),
        'property', jsonb_build_object(
          'id', property.id,
          'stories', property.stories,
          'version', property.version,
          'updatedAt', property.updated_at,
          'postalCode', '75219'
        ),
        'priceBook', jsonb_build_object(
          'id', '98000000-0000-4000-8000-000000000010',
          'versionLabel', 'contract-1'
        ),
        'serviceTerms', jsonb_build_object(
          'id', terms.id,
          'versionLabel', terms.version_label,
          'reviewedAt', terms.reviewed_at,
          'reviewReference', terms.review_reference
        ),
        'serviceCatalog', jsonb_build_array(jsonb_build_object(
          'id', catalog.id,
          'code', catalog.code,
          'version', catalog.version,
          'active', catalog.active,
          'safetySopReference', catalog.safety_sop_reference
        )),
        'travelZone', jsonb_build_object(
          'code', zone.zone_code,
          'source', 'reviewed_postal_code',
          'postalCode', '75219',
          'mappingReviewedBy', zone.mapping_reviewed_by,
          'mappingReviewedAt', zone.mapping_reviewed_at,
          'mappingReviewReference', zone.mapping_review_reference
        ),
        'photoEvidence', null,
        'measurements', jsonb_build_array(jsonb_build_object(
          'id', measurement.id,
          'value', measurement.value::text,
          'kind', measurement.kind,
          'unit', measurement.unit,
          'serviceCodes', to_jsonb(measurement.service_codes),
          'addOnCodes', to_jsonb(measurement.add_on_codes),
          'version', measurement.version,
          'updatedAt', measurement.updated_at
        ))
      ),
      '10000000-0000-4000-8000-000000000201',
      '98000000-0000-4000-8000-000000000001',
      null,
      '98000000-0000-4000-8000-000000000010',
      '10000000-0000-4000-8000-000000000152',
      'contract-1',
      jsonb_build_object(
        'services', jsonb_build_array(jsonb_build_object(
          'serviceCode', 'flat-contract',
          'measurementId', measurement.id,
          'quantity', measurement.value::text,
          'pricingUnit', 'flat',
          'attributes', '{}'::jsonb,
          'addOns', '[]'::jsonb,
          'classificationEvidence', jsonb_build_object(
            'source', 'operator_assertion',
            'assertedBy', '10000000-0000-4000-8000-000000000101',
            'assertedAt', invalid_calculated_at
          ),
          'sourceMeasurementIds', jsonb_build_array(measurement.id)
        )),
        'travelZoneCode', zone.zone_code,
        'travelZoneEvidence', jsonb_build_object(
          'source', 'reviewed_postal_code',
          'postalCode', '75219',
          'mappingReviewedBy', zone.mapping_reviewed_by,
          'mappingReviewedAt', zone.mapping_reviewed_at,
          'mappingReviewReference', zone.mapping_review_reference,
          'derivedAt', clock_timestamp()
        ),
        'scopeEvidenceDisposition', 'not_applicable',
        'scopeEvidencePolicies', jsonb_build_array(jsonb_build_object(
          'serviceCode', 'flat-contract',
          'policy', 'not_applicable'
        )),
        'discount', jsonb_build_object('kind', 'none')
      ),
      jsonb_build_object(
        'calculationVersion', 'storyops-pricing-v1.1.0',
        'requestId', 'estimate:' || repeat('d', 64),
        'quoteable', true,
        'lines', '[]'::jsonb,
        'serviceSubtotal', jsonb_build_object('amount', '50.00'),
        'minimumAdjustment', jsonb_build_object('amount', '0.00'),
        'travelFee', jsonb_build_object('amount', '0.00'),
        'manualAdjustment', jsonb_build_object('amount', '0.00'),
        'subtotalBeforeDiscount', jsonb_build_object('amount', '50.00'),
        'discount', jsonb_build_object('amount', '0.00'),
        'taxableSubtotal', jsonb_build_object('amount', '50.00'),
        'tax', jsonb_build_object('amount', '4.13'),
        'total', jsonb_build_object('amount', '54.13'),
        'depositRequired', jsonb_build_object('amount', '13.53'),
        'estimatedCost', jsonb_build_object('amount', '10.00'),
        'marginPercent', '80.00',
        'durationMinutes', 30,
        'issues', '[]'::jsonb,
        'approvalFlags', '[]'::jsonb,
        'priceBookId', '98000000-0000-4000-8000-000000000010',
        'priceBookVersion', 'contract-1',
        'calculatedAt', invalid_calculated_at
      ),
      terms.version_label,
      terms.terms_text
    )
    from public.customers customer
    cross join public.properties property
    cross join public.service_terms terms
    cross join public.service_catalog catalog
    cross join public.property_measurements measurement
    cross join public.price_book_travel_zones zone
    where customer.id = '10000000-0000-4000-8000-000000000201'
      and property.id = '98000000-0000-4000-8000-000000000001'
      and terms.id = '10000000-0000-4000-8000-000000000152'
      and catalog.id = '98000000-0000-4000-8000-000000000011'
      and measurement.id = '98000000-0000-4000-8000-000000000041'
      and zone.company_id = '10000000-0000-4000-8000-000000000001'
      and zone.price_book_id = '98000000-0000-4000-8000-000000000010'
      and '75219' = any(zone.postal_codes);
  exception
    when others then
      get stacked diagnostics error_text = message_text;
      rejected := position('ESTIMATE_SERVICE_EVIDENCE_MISMATCH' in error_text) > 0;
      if not rejected then
        raise;
      end if;
  end;

  if not rejected then
    raise exception 'Flat pricing accepted count evidence with quantity two';
  end if;
end;
$$;

rollback;

\echo 'Flat/hour pricing-unit persistence contract passed.'
