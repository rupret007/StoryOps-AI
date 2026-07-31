\set ON_ERROR_STOP on

begin;

\echo '1/6 non-exterior industry-pack vocabulary is accepted'
insert into public.service_catalog(
  id, company_id, code, name, description, category, active, taxable,
  required_skills, required_equipment_types, required_measurement_kinds,
  safety_sop_reference, scope_evidence_policy
)
values (
  '98000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000001',
  'lawn-mowing',
  'Lawn mowing',
  'Measured recurring lawn mowing contract fixture.',
  'landscape_maintenance',
  true,
  true,
  array['mower-operation'],
  array['commercial-mower'],
  array['area_sq_ft'],
  'SOP-LANDSCAPE-MOW-001',
  'not_applicable'
);

insert into public.price_books(
  id, company_id, name, version_label, status, effective_from, currency,
  company_minimum, default_tax_rate_pct, margin_floor_pct,
  automatic_discount_limit_pct, deposit_kind, deposit_value
)
values (
  '98000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000001',
  'Landscape contract fixture',
  'landscape-v1',
  'draft',
  now(),
  'USD',
  75,
  0,
  30,
  5,
  'none',
  0
);

-- Direct estimate fixtures still bind a reviewed postal-code mapping. Industry
-- packs can change scope-photo policy, but they do not bypass authoritative
-- travel-zone selection.
insert into public.price_book_travel_zones(
  id, company_id, price_book_id, zone_code, name, fee, taxable,
  maximum_one_way_miles, postal_codes, mapping_evidence_source,
  mapping_reviewed_by, mapping_reviewed_at, mapping_review_reference
)
values (
  '98000000-0000-4000-8000-000000000203',
  '10000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000201',
  'LANDSCAPE-TEST',
  'Reviewed landscape fixture zone',
  0,
  false,
  null,
  array['75219'],
  'reviewed_postal_codes',
  'Industry pack fixture reviewer',
  '2026-07-28T12:00:00+00:00'::timestamptz,
  'industry-pack-fixture-reviewed-zone-v1'
);

insert into public.price_book_service_rules(
  id, company_id, price_book_id, service_catalog_id, service_code,
  pricing_unit, base_price,
  unit_price, included_quantity, service_minimum, estimated_base_cost,
  estimated_unit_cost, duration_base_minutes, duration_minutes_per_unit,
  taxable
)
values (
  '98000000-0000-4000-8000-000000000202',
  '10000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000201',
  '98000000-0000-4000-8000-000000000101',
  'lawn-mowing',
  'sq_ft',
  40,
  0.03,
  1000,
  75,
  20,
  0.01,
  20,
  0.01,
  true
);

insert into public.price_book_attribute_multipliers(
  company_id, service_rule_id, attribute, attribute_value, multiplier
)
values (
  '10000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000202',
  'turf_condition',
  'maintained',
  1
);

\echo '2/6 duration evidence completes the kernel pricing-unit vocabulary'
insert into public.property_measurements(
  id, company_id, property_id, kind, label, value, unit, source,
  measured_at, verified_by_human, service_codes, add_on_codes
)
values (
  '98000000-0000-4000-8000-000000000301',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000211',
  'duration_hours',
  'Reviewed service duration',
  2.5,
  'hour',
  'field_measured',
  now(),
  true,
  array['lawn-mowing'],
  '{}'
);

\echo '3/6 a reviewed non-photo service can persist an approved measured estimate'
insert into public.estimates(
  id, company_id, estimate_number, customer_id, property_id, price_book_id,
  price_book_version, status, calculation_version, calculation_input,
  calculated_at
)
values (
  '98000000-0000-4000-8000-000000000401',
  '10000000-0000-4000-8000-000000000001',
  'EST-PACK-NONPHOTO-1',
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000211',
  '98000000-0000-4000-8000-000000000201',
  'landscape-v1',
  'approved',
  'storyops-pricing-v1.1.0',
  '{
    "services":[{"serviceCode":"lawn-mowing"}],
    "travelZoneCode":"LANDSCAPE-TEST",
    "travelZoneEvidence":{
      "source":"reviewed_postal_code",
      "postalCode":"75219",
      "mappingReviewedBy":"Industry pack fixture reviewer",
      "mappingReviewedAt":"2026-07-28T12:00:00+00:00",
      "mappingReviewReference":"industry-pack-fixture-reviewed-zone-v1"
    },
    "scopeEvidenceDisposition":"not_applicable",
    "scopeEvidencePolicies":[
      {"serviceCode":"lawn-mowing","policy":"not_applicable"}
    ]
  }',
  now()
);

\echo '4/6 a photo-required service cannot persist an approved estimate without usable evidence'
update public.service_catalog
set scope_evidence_policy = 'photo_required'
where id = '98000000-0000-4000-8000-000000000101';

-- Use a property with no scope-photo history. The seeded Morgan property has
-- usable reviewed evidence and would only prove that the submitted disposition
-- was stale, not that photo-required approval fails closed without evidence.
insert into public.properties(
  id, company_id, customer_id, name, property_type, service_address
)
values (
  '98000000-0000-4000-8000-000000000311',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  'No-photo industry-pack fixture',
  'single_family',
  '{
    "line1":"Scope evidence policy test property",
    "postalCode":"75219"
  }'
);

-- Satisfy the independent deterministic-measurement gate so this assertion
-- reaches the photo-evidence policy rather than failing earlier on scope size.
insert into public.property_measurements(
  id, company_id, property_id, kind, label, value, unit, source,
  measured_at, verified_by_human, service_codes, add_on_codes
)
values (
  '98000000-0000-4000-8000-000000000302',
  '10000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000311',
  'area_sq_ft',
  'Reviewed turf area',
  2400,
  'sq_ft',
  'field_measured',
  now(),
  true,
  array['lawn-mowing'],
  '{}'
);

do $$
begin
  begin
    insert into public.estimates(
      id, company_id, estimate_number, customer_id, property_id, price_book_id,
      price_book_version, status, calculation_version, calculation_input,
      calculated_at
    )
    values (
      '98000000-0000-4000-8000-000000000402',
      '10000000-0000-4000-8000-000000000001',
      'EST-PACK-PHOTO-1',
      '10000000-0000-4000-8000-000000000201',
      '98000000-0000-4000-8000-000000000311',
      '98000000-0000-4000-8000-000000000201',
      'landscape-v1',
      'approved',
      'storyops-pricing-v1.1.0',
      '{
        "services":[{
          "serviceCode":"lawn-mowing",
          "measurementId":"98000000-0000-4000-8000-000000000302"
        }],
        "travelZoneCode":"LANDSCAPE-TEST",
        "travelZoneEvidence":{
          "source":"reviewed_postal_code",
          "postalCode":"75219",
          "mappingReviewedBy":"Industry pack fixture reviewer",
          "mappingReviewedAt":"2026-07-28T12:00:00+00:00",
          "mappingReviewReference":"industry-pack-fixture-reviewed-zone-v1"
        },
        "scopeEvidenceDisposition":"human_review_required",
        "scopeEvidencePolicies":[
          {"serviceCode":"lawn-mowing","policy":"photo_required"}
        ]
      }',
      now()
    );
    raise exception 'Photo-required estimate unexpectedly became approved';
  exception
    when raise_exception then
      if sqlerrm = 'Photo-required estimate unexpectedly became approved' then
        raise;
      end if;
      if sqlerrm <> 'ESTIMATE_SCOPE_PHOTO_REVIEW_REQUIRED' then
        raise;
      end if;
  end;
end;
$$;

\echo '5/6 category codes remain bounded'
do $$
begin
  begin
    insert into public.service_catalog(
      company_id, code, name, description, category, active, taxable,
      required_skills, required_equipment_types, required_measurement_kinds,
      safety_sop_reference
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      'invalid-category-fixture',
      'Invalid category fixture',
      'This row must fail the bounded semantic-code constraint.',
      'Landscape Maintenance!',
      false,
      true,
      '{}',
      '{}',
      '{}',
      'SOP-TEST-INVALID'
    );
    raise exception 'Unbounded service category unexpectedly succeeded';
  exception
    when check_violation then null;
  end;
end;
$$;

\echo '6/6 pricing-dimension codes remain bounded'
do $$
begin
  begin
    insert into public.price_book_attribute_multipliers(
      company_id, service_rule_id, attribute, attribute_value, multiplier
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      '98000000-0000-4000-8000-000000000202',
      'DROP TABLE',
      'invalid',
      1
    );
    raise exception 'Unbounded pricing attribute unexpectedly succeeded';
  exception
    when check_violation then null;
  end;
end;
$$;

rollback;

\echo 'industry pack kernel: pass'
