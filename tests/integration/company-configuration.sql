\set ON_ERROR_STOP on

begin;

-- Exercise the finite setup-status wrappers through the full reviewed
-- configuration -> publication -> operating-baseline activation sequence.
update public.companies
set status = 'setup'
where id = '10000000-0000-4000-8000-000000000001';

\echo '1/10 configuration commands require authentication'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_company_configuration_state(
      '10000000-0000-4000-8000-000000000001'
    );
  exception
    when others then
      if position('Authentication is required' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Unauthenticated configuration state was exposed';
  end if;
end;
$$;

create temporary table configuration_fixture(configuration jsonb not null);
insert into configuration_fixture(configuration)
values (
  jsonb_build_object(
    'schemaVersion', 'storyops-company-config-v1',
    'identity', jsonb_build_object(
      'legalName', 'Story Exterior Care LLC',
      'displayName', 'Story Exterior Care',
      'ownerName', 'Alex Owner',
      'publicEmail', 'owner@example.test',
      'publicPhone', '+18175550123',
      'website', '',
      'brand', jsonb_build_object(
        'primaryColor', '#174f46',
        'accentColor', '#d99545',
        'logoUrl', ''
      )
    ),
    'territory', jsonb_build_object(
      'serviceAddress', jsonb_build_object(
        'line1', '100 Main Street',
        'line2', '',
        'city', 'Grapevine',
        'region', 'TX',
        'postalCode', '76051',
        'country', 'US'
      ),
      'timezone', 'America/Chicago',
      'serviceAreaNote', 'Reviewed DFW service area',
      'travelZones', jsonb_build_array(
        jsonb_build_object(
          'code', 'DFW-A',
          'name', 'Core',
          'maximumMiles', '',
          'fee', '0.00',
          'postalCodes', jsonb_build_array('76051', '75219')
        )
      ),
      'travelZoneMappingReview', jsonb_build_object(
        'status', 'approved',
        'reviewer', 'Owner territory reviewer',
        'reviewedAt', '2025-01-01T12:00:00.000Z',
        'evidenceReference', 'territory-mapping-review-2026-07'
      )
    ),
    'schedule', jsonb_build_object(
      'businessHours', (
        select jsonb_agg(jsonb_build_object(
          'day', day_name,
          'closed', day_name = 'sunday',
          'opensAt', '08:00',
          'closesAt', '17:00'
        ))
        from unnest(array[
          'monday', 'tuesday', 'wednesday', 'thursday',
          'friday', 'saturday', 'sunday'
        ]) day_name
      ),
      'appointmentBufferMinutes', 30,
      'minimumLeadTimeHours', 24,
      'maximumBookingDays', 60
    ),
    'pricing', jsonb_build_object(
      'currency', 'USD',
      'companyMinimum', '225.00',
      'defaultTaxRatePercent', '8.2500',
      'taxEnabled', true,
      'marginFloorPercent', '42.00',
      'automaticDiscountLimitPercent', '10.00',
      'priceBookTemplateVersion', 'storyops-exterior-dfw-v1.1.0',
      'enabledServiceCodes', jsonb_build_array('pressure-wash-flatwork'),
      'serviceRules', jsonb_build_array(jsonb_build_object(
        'serviceCode', 'pressure-wash-flatwork',
        'pricingUnit', 'sq_ft',
        'requiredMeasurementKinds', jsonb_build_array('area_sq_ft'),
        'basePrice', '110.00',
        'unitPrice', '0.140000',
        'includedQuantity', '500.0000',
        'serviceMinimum', '185.00',
        'estimatedBaseCost', '45.00',
        'estimatedUnitCost', '0.050000',
        'durationBaseMinutes', 45,
        'durationMinutesPerUnit', '0.0550',
        'taxable', true,
        'allowedAttributeValues', jsonb_build_object(
          'risk', jsonb_build_array('standard', 'elevated')
        ),
        'attributeMultipliers', jsonb_build_array(
          jsonb_build_object(
            'attribute', 'risk',
            'value', 'standard',
            'multiplier', '1.0000'
          ),
          jsonb_build_object(
            'attribute', 'risk',
            'value', 'elevated',
            'multiplier', '1.2500',
            'approval', jsonb_build_object(
              'reason', 'outside_sop',
              'summary', 'Elevated scope requires owner SOP review.'
            )
          )
        ),
        'addOns', jsonb_build_array(
          jsonb_build_object(
            'code', 'OIL_SPOT_TREAT',
            'name', 'Oil spot treatment',
            'pricingUnit', 'each',
            'unitPrice', '22.000000',
            'estimatedUnitCost', '5.500000',
            'durationMinutesPerUnit', '8.0000',
            'taxable', true,
            'approval', jsonb_build_object(
              'reason', 'outside_sop',
              'summary', 'Treatment compatibility requires owner review.'
            )
          ),
          jsonb_build_object(
            'code', 'PATIO_WASH',
            'name', 'Patio washing',
            'pricingUnit', 'sq_ft',
            'unitPrice', '0.180000',
            'estimatedUnitCost', '0.060000',
            'durationMinutesPerUnit', '0.0500',
            'taxable', true
          )
        )
      )),
      'packages', jsonb_build_array(
        jsonb_build_object(
          'code', 'STARTER_GOOD',
          'name', 'Starter core',
          'description', 'Good integration fixture with the core service only.',
          'tier', 'good',
          'components', jsonb_build_array(jsonb_build_object(
            'serviceCode', 'pressure-wash-flatwork',
            'required', true,
            'requiredAddOnCodes', '[]'::jsonb,
            'optionalAddOnCodes', '[]'::jsonb
          ))
        ),
        jsonb_build_object(
          'code', 'STARTER_BETTER',
          'name', 'Starter treatment option',
          'description', 'Better integration fixture with an explicitly optional treatment.',
          'tier', 'better',
          'components', jsonb_build_array(jsonb_build_object(
            'serviceCode', 'pressure-wash-flatwork',
            'required', true,
            'requiredAddOnCodes', '[]'::jsonb,
            'optionalAddOnCodes', jsonb_build_array(
              'OIL_SPOT_TREAT',
              'PATIO_WASH'
            )
          ))
        ),
        jsonb_build_object(
          'code', 'STARTER_BEST',
          'name', 'Starter treatment included',
          'description', 'Best integration fixture with the measured treatment required.',
          'tier', 'best',
          'components', jsonb_build_array(jsonb_build_object(
            'serviceCode', 'pressure-wash-flatwork',
            'required', true,
            'requiredAddOnCodes', jsonb_build_array('OIL_SPOT_TREAT'),
            'optionalAddOnCodes', '[]'::jsonb
          ))
        )
      ),
      'taxReview', jsonb_build_object(
        'status', 'approved',
        'reviewer', 'Tax reviewer',
        'reviewedAt', '2025-01-01T12:00:00.000Z',
        'evidenceReference', 'tax-review-2026-07'
      )
    ),
    'people', jsonb_build_object(
      'crewMembers', jsonb_build_array(
        jsonb_build_object(
          'id', 'owner-crew',
          'name', 'Alex Owner',
          'role', 'owner',
          'skills', jsonb_build_array(
            'exterior-cleaning',
            'surface-identification',
            'pressure-washing'
          ),
          'active', true
        ),
        jsonb_build_object(
          'id', 'planned-technician',
          'name', 'Planned Technician',
          'role', 'technician',
          'skills', jsonb_build_array('technician-only-credential'),
          'active', true
        )
      )
    ),
    'resources', jsonb_build_object(
      'vehicles', jsonb_build_array(jsonb_build_object(
        'id', 'service-vehicle-1',
        'name', 'Primary truck',
        'kind', 'truck',
        'capacityNote', 'Owner reviewed capacity',
        'active', true
      )),
      'equipment', jsonb_build_array(
        jsonb_build_object(
          'id', 'pressure-washer-1',
          'name', 'Primary pressure washer',
          'equipmentType', 'pressure-washer',
          'quantity', 1,
          'inspectionStatus', 'current',
          'active', true
        ),
        jsonb_build_object(
          'id', 'surface-cleaner-1',
          'name', 'Primary surface cleaner',
          'equipmentType', 'surface-cleaner',
          'quantity', 1,
          'inspectionStatus', 'current',
          'active', true
        )
      )
    ),
    'materials', jsonb_build_object(
      'catalog', jsonb_build_array(jsonb_build_object(
        'id', 'water',
        'name', 'Water',
        'unit', 'gallon',
        'requiresSds', false,
        'sdsStatus', 'not_required',
        'sdsReference', '',
        'sdsChecksumSha256', ''
      ))
    ),
    'payments', jsonb_build_object(
      'acceptedMethods', jsonb_build_array('card', 'ach', 'check'),
      'depositKind', 'percent',
      'depositValue', '25.00',
      'refundsRequireApproval', true
    ),
    'policies', jsonb_build_object(
      'cancellationHours', 24,
      'cancellationFee', '75.00',
      'rescheduleHours', 24,
      'termsText', 'Qualified counsel reviewed this integration-test terms fixture for deterministic publication.',
      'retentionDays', jsonb_build_object(
        'operational', 1095,
        'communications', 730,
        'aiTraces', 90,
        'audit', 2555,
        'safety', 1460
      ),
      'legalReview', jsonb_build_object(
        'status', 'approved',
        'reviewer', 'Legal reviewer',
        'reviewedAt', '2025-01-01T12:00:00.000Z',
        'evidenceReference', 'legal-review-2026-07'
      ),
      'privacyReview', jsonb_build_object(
        'status', 'approved',
        'reviewer', 'Privacy reviewer',
        'reviewedAt', '2025-01-01T12:00:00.000Z',
        'evidenceReference', 'privacy-review-2026-07'
      ),
      'safetyReview', jsonb_build_object(
        'status', 'approved',
        'reviewer', 'Safety reviewer',
        'reviewedAt', '2025-01-01T12:00:00.000Z',
        'evidenceReference', 'safety-review-2026-07'
      ),
      'insuranceReview', jsonb_build_object(
        'status', 'approved',
        'reviewer', 'Insurance reviewer',
        'reviewedAt', '2025-01-01T12:00:00.000Z',
        'evidenceReference', 'insurance-review-2026-07'
      ),
      'environmentalReview', jsonb_build_object(
        'status', 'approved',
        'reviewer', 'Environmental reviewer',
        'reviewedAt', '2025-01-01T12:00:00.000Z',
        'evidenceReference', 'environmental-review-2026-07'
      )
    ),
    'engagement', jsonb_build_object(
      'reviewRequestEnabled', false,
      'reviewDelayHours', 24,
      'reviewUrl', '',
      'referralEnabled', false,
      'referralRewardDescription', '',
      'recurringMaintenanceEnabled', true
    ),
    'integrations', jsonb_build_object(
      'providers', (
        select jsonb_agg(jsonb_build_object(
          'provider', provider_name,
          'requestedMode', 'sandbox',
          'environmentEnabled', false,
          'ownerEnabled', false,
          'health', 'not_checked'
        ))
        from unnest(array[
          'openai', 'twilio', 'email', 'stripe', 'google_calendar',
          'maps', 'nws', 'vroom', 'storage', 'quickbooks_export'
        ]) provider_name
      )
    )
  )
);
grant select on configuration_fixture to authenticated;

\echo '2/10 dispatcher cannot read or save owner configuration'
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000102', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated"}',
  true
);
do $$
declare
  blocked_read boolean := false;
  blocked_write boolean := false;
  fixture jsonb := (select configuration from configuration_fixture);
begin
  begin
    perform public.get_company_configuration_state(
      '10000000-0000-4000-8000-000000000001'
    );
  exception
    when others then
      if position('Only an active company owner' in sqlerrm) > 0 then
        blocked_read := true;
      else
        raise;
      end if;
  end;
  begin
    perform public.save_company_configuration_draft(
      '10000000-0000-4000-8000-000000000001',
      '99100000-0000-4000-8000-000000000001',
      0,
      fixture,
      repeat('1', 64)
    );
  exception
    when others then
      if position('Only an active company owner' in sqlerrm) > 0 then
        blocked_write := true;
      else
        raise;
      end if;
  end;
  if not blocked_read or not blocked_write then
    raise exception 'Dispatcher reached an owner-only configuration boundary';
  end if;
end;
$$;

\echo '3/10 owner saves an exact validated draft revision'
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
\echo '3a/17 structurally valid incomplete work saves with publication blockers'
do $$
declare
  receipt jsonb;
  incomplete jsonb := (
    select jsonb_set(
      jsonb_set(
        jsonb_set(
          configuration,
          '{people,crewMembers,0,skills}',
          '["exterior-cleaning"]'::jsonb
        ),
        '{resources,equipment,0,inspectionStatus}',
        '"due"'::jsonb
      ),
      '{resources,equipment,1,inspectionStatus}',
      '"due"'::jsonb
    )
    from configuration_fixture
  );
begin
  begin
    receipt := public.save_company_configuration_draft(
      '10000000-0000-4000-8000-000000000001',
      '99100000-0000-4000-8000-000000000009',
      0,
      incomplete,
      repeat('a', 64)
    );
    if receipt ->> 'status' <> 'draft'
      or not exists (
        select 1 from jsonb_array_elements(receipt -> 'issues') issue
        where issue ->> 'code' = 'service_skill_coverage_missing'
      )
      or not exists (
        select 1 from jsonb_array_elements(receipt -> 'issues') issue
        where issue ->> 'code' = 'service_equipment_coverage_missing'
      )
    then
      raise exception 'Incomplete draft receipt lost publication blockers: %', receipt;
    end if;
    raise exception 'EXPECTED_INCOMPLETE_DRAFT_TEST_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'EXPECTED_INCOMPLETE_DRAFT_TEST_ROLLBACK' then
        raise;
      end if;
  end;
  if exists (
    select 1 from public.company_configuration_versions
    where company_id = '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Incomplete draft test subtransaction did not roll back';
  end if;
end;
$$;
\echo '3b/19 malformed approved-review evidence saves as a draft but cannot publish'
do $$
declare
  blocked boolean := false;
  receipt jsonb;
  unsafe jsonb := (
    select jsonb_set(
      configuration,
      '{policies,legalReview}',
      '{"status":"approved","evidenceReference":"x"}'::jsonb
    )
    from configuration_fixture
  );
begin
  begin
    receipt := public.save_company_configuration_draft(
      '10000000-0000-4000-8000-000000000001',
      '99100000-0000-4000-8000-000000000010',
      0,
      unsafe,
      repeat('b', 64)
    );
    if not exists (
      select 1 from jsonb_array_elements(receipt -> 'issues') issue
      where issue ->> 'code' = 'approved_review_evidence_invalid'
        and issue ->> 'section' = 'policies'
    ) then
      raise exception 'Incomplete review evidence was not retained as a draft blocker: %', receipt;
    end if;
    begin
      perform public.publish_company_configuration(
        '10000000-0000-4000-8000-000000000001',
        '99100000-0000-4000-8000-000000000011',
        1,
        'live',
        'malformed-review-negative-test',
        repeat('c', 64)
      );
    exception
      when others then
        if position('approved_review_evidence_invalid' in sqlerrm) > 0 then
          blocked := true;
        else
          raise;
        end if;
    end;
    if not blocked then
      raise exception 'Malformed approved review reached live publication';
    end if;
    raise exception 'EXPECTED_REVIEW_SHAPE_TEST_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'EXPECTED_REVIEW_SHAPE_TEST_ROLLBACK' then
        raise;
      end if;
  end;
  if exists (
    select 1 from public.company_configuration_versions
    where company_id = '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Malformed review test subtransaction did not roll back';
  end if;
end;
$$;

\echo '3c/19 future approved-review evidence saves as a draft but cannot publish'
do $$
declare
  blocked boolean := false;
  receipt jsonb;
  unsafe jsonb := (
    select jsonb_set(
      configuration,
      '{pricing,taxReview,reviewedAt}',
      '"2999-01-01T00:00:00.000Z"'::jsonb
    )
    from configuration_fixture
  );
begin
  begin
    receipt := public.save_company_configuration_draft(
      '10000000-0000-4000-8000-000000000001',
      '99100000-0000-4000-8000-000000000012',
      0,
      unsafe,
      repeat('d', 64)
    );
    if not exists (
      select 1 from jsonb_array_elements(receipt -> 'issues') issue
      where issue ->> 'code' = 'approved_review_evidence_invalid'
        and issue ->> 'section' = 'pricing'
    ) then
      raise exception 'Future review evidence was not retained as a draft blocker: %', receipt;
    end if;
    begin
      perform public.publish_company_configuration(
        '10000000-0000-4000-8000-000000000001',
        '99100000-0000-4000-8000-000000000013',
        1,
        'live',
        'future-review-negative-test',
        repeat('e', 64)
      );
    exception
      when others then
        if position('approved_review_evidence_invalid' in sqlerrm) > 0 then
          blocked := true;
        else
          raise;
        end if;
    end;
    if not blocked then
      raise exception 'Future approved review reached live publication';
    end if;
    raise exception 'EXPECTED_REVIEW_TIME_TEST_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'EXPECTED_REVIEW_TIME_TEST_ROLLBACK' then
        raise;
      end if;
  end;
  if exists (
    select 1 from public.company_configuration_versions
    where company_id = '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Future review test subtransaction did not roll back';
  end if;
end;
$$;

\echo '3d/19 private validator rejects every approved-review evidence boundary'
reset role;
do $$
declare
  test_case record;
  issues jsonb;
  unsafe jsonb;
begin
  for test_case in
    select *
    from (
      values
        (
          'extra object key',
          '{policies,legalReview}'::text[],
          jsonb_build_object(
            'status', 'approved',
            'reviewer', 'Qualified counsel',
            'reviewedAt', '2025-01-01T12:00:00.000Z',
            'evidenceReference', 'terms-review-2026-07',
            'unreviewedClaim', true
          ),
          'policies'
        ),
        (
          'one-character reviewer',
          '{policies,legalReview,reviewer}'::text[],
          '"x"'::jsonb,
          'policies'
        ),
        (
          'overlong reviewer',
          '{policies,legalReview,reviewer}'::text[],
          to_jsonb(repeat('r', 101)),
          'policies'
        ),
        (
          'non-normalized reviewer',
          '{policies,legalReview,reviewer}'::text[],
          '" Qualified counsel "'::jsonb,
          'policies'
        ),
        (
          'four-character evidence reference',
          '{pricing,taxReview,evidenceReference}'::text[],
          '"abcd"'::jsonb,
          'pricing'
        ),
        (
          'overlong evidence reference',
          '{pricing,taxReview,evidenceReference}'::text[],
          to_jsonb(repeat('e', 241)),
          'pricing'
        ),
        (
          'non-normalized evidence reference',
          '{pricing,taxReview,evidenceReference}'::text[],
          '" tax-review-2026-07 "'::jsonb,
          'pricing'
        ),
        (
          'non-string reviewed timestamp',
          '{territory,travelZoneMappingReview,reviewedAt}'::text[],
          '1735732800'::jsonb,
          'territory'
        ),
        (
          'ambiguous date-only reviewed timestamp',
          '{territory,travelZoneMappingReview,reviewedAt}'::text[],
          '"2025-01-01"'::jsonb,
          'territory'
        ),
        (
          'malformed reviewed timestamp',
          '{territory,travelZoneMappingReview,reviewedAt}'::text[],
          '"not-a-timestamp"'::jsonb,
          'territory'
        ),
        (
          'reviewed timestamp before evidence lower bound',
          '{territory,travelZoneMappingReview,reviewedAt}'::text[],
          '"1999-12-31T23:59:59.999Z"'::jsonb,
          'territory'
        ),
        (
          'future reviewed timestamp',
          '{territory,travelZoneMappingReview,reviewedAt}'::text[],
          '"2999-01-01T00:00:00.000Z"'::jsonb,
          'territory'
        )
    ) as cases(name, path, invalid_value, expected_section)
  loop
    select jsonb_set(configuration, test_case.path, test_case.invalid_value)
    into unsafe
    from configuration_fixture;

    issues := public.validate_company_configuration(
      '10000000-0000-4000-8000-000000000001',
      unsafe,
      'live'
    );
    if not exists (
      select 1
      from jsonb_array_elements(issues) issue
      where issue ->> 'code' = 'approved_review_evidence_invalid'
        and issue ->> 'section' = test_case.expected_section
        and issue ->> 'severity' = 'blocking'
    ) then
      raise exception 'Private validation accepted %: %', test_case.name, issues;
    end if;
  end loop;
end;
$$;

\echo '3e/20 private validation rejects pricing semantics, non-total matrices, and reordered duplicate package scopes'
do $$
declare
  test_case record;
  issues jsonb;
begin
  for test_case in
    select *
    from (
      select
        'pricing unit changed without catalog semantics'::text as name,
        jsonb_set(
          configuration,
          '{pricing,serviceRules,0,pricingUnit}',
          '"each"'::jsonb
        ) as unsafe,
        'service_rule_measurement_semantics_mismatch'::text as expected_code
      from configuration_fixture
      union all
      select
        'pricing unit and claimed kinds both diverge from catalog',
        jsonb_set(
          jsonb_set(
            configuration,
            '{pricing,serviceRules,0,pricingUnit}',
            '"each"'::jsonb
          ),
          '{pricing,serviceRules,0,requiredMeasurementKinds}',
          '["count"]'::jsonb
        ),
        'service_rule_measurement_semantics_mismatch'
      from configuration_fixture
      union all
      select
        'multiplier matrix field is missing',
        configuration #- '{pricing,serviceRules,0,allowedAttributeValues}'::text[],
        'service_rule_multiplier_matrix_invalid'
      from configuration_fixture
      union all
      select
        'allowed value is missing its multiplier',
        jsonb_set(
          configuration,
          '{pricing,serviceRules,0,attributeMultipliers}',
          jsonb_build_array(
            configuration #> '{pricing,serviceRules,0,attributeMultipliers,0}'
          )
        ),
        'service_rule_multiplier_matrix_invalid'
      from configuration_fixture
      union all
      select
        'multiplier references an undeclared value',
        jsonb_set(
          configuration,
          '{pricing,serviceRules,0,attributeMultipliers}',
          (configuration #> '{pricing,serviceRules,0,attributeMultipliers}')
            || jsonb_build_array(jsonb_build_object(
              'attribute', 'risk',
              'value', 'invented',
              'multiplier', '1.0000'
            ))
        ),
        'service_rule_multiplier_matrix_invalid'
      from configuration_fixture
      union all
      select
        'multiplier pair is duplicated',
        jsonb_set(
          configuration,
          '{pricing,serviceRules,0,attributeMultipliers}',
          (configuration #> '{pricing,serviceRules,0,attributeMultipliers}')
            || jsonb_build_array(
              configuration #> '{pricing,serviceRules,0,attributeMultipliers,0}'
            )
        ),
        'service_rule_multiplier_matrix_invalid'
      from configuration_fixture
      union all
      select
        'allowed attribute value is duplicated',
        jsonb_set(
          configuration,
          '{pricing,serviceRules,0,allowedAttributeValues,risk}',
          '["standard","standard","elevated"]'::jsonb
        ),
        'service_rule_multiplier_matrix_invalid'
      from configuration_fixture
      union all
      select
        'enabled service rule is duplicated',
        jsonb_set(
          configuration,
          '{pricing,serviceRules}',
          (configuration #> '{pricing,serviceRules}')
            || jsonb_build_array(configuration #> '{pricing,serviceRules,0}')
        ),
        'service_rule_duplicate'
      from configuration_fixture
      union all
      select
        'same package scope is reordered under another tier',
        jsonb_set(
          configuration,
          '{pricing,packages,2,components}',
          jsonb_build_array(jsonb_build_object(
            'serviceCode', 'pressure-wash-flatwork',
            'required', true,
            'requiredAddOnCodes', '[]'::jsonb,
            'optionalAddOnCodes', jsonb_build_array(
              'PATIO_WASH',
              'OIL_SPOT_TREAT'
            )
          ))
        ),
        'package_scope_duplicate'
      from configuration_fixture
    ) cases
  loop
    issues := public.validate_company_configuration(
      '10000000-0000-4000-8000-000000000001',
      test_case.unsafe,
      'live'
    );
    if not exists (
      select 1
      from jsonb_array_elements(issues) issue
      where issue ->> 'code' = test_case.expected_code
        and issue ->> 'section' = 'pricing'
        and issue ->> 'severity' = 'blocking'
    ) then
      raise exception 'Private validation accepted %: %', test_case.name, issues;
    end if;
  end loop;
end;
$$;

set local role authenticated;
create temporary table configuration_receipt(receipt jsonb not null);
insert into configuration_receipt(receipt)
select public.save_company_configuration_draft(
  '10000000-0000-4000-8000-000000000001',
  '99100000-0000-4000-8000-000000000101',
  0,
  configuration,
  repeat('2', 64)
)
from configuration_fixture;
do $$
declare
  receipt jsonb := (select configuration_receipt.receipt from configuration_receipt);
begin
  if receipt ->> 'status' <> 'draft'
    or (receipt ->> 'revision')::integer <> 1
    or (receipt ->> 'replayed')::boolean
    or receipt ->> 'configurationHash' !~ '^[a-f0-9]{64}$'
  then
    raise exception 'Unexpected configuration draft receipt: %', receipt;
  end if;
end;
$$;

\echo '4/10 exact retry replays the durable receipt'
do $$
declare
  replay jsonb;
begin
  select public.save_company_configuration_draft(
    '10000000-0000-4000-8000-000000000001',
    '99100000-0000-4000-8000-000000000101',
    0,
    configuration,
    repeat('2', 64)
  )
  into replay
  from configuration_fixture;
  if not (replay ->> 'replayed')::boolean
    or (replay ->> 'revision')::integer <> 1
  then
    raise exception 'Exact configuration retry did not replay: %', replay;
  end if;
end;
$$;

\echo '5/10 changed payload cannot reuse a command ID'
do $$
declare
  blocked boolean := false;
  changed jsonb := (
    select jsonb_set(configuration, '{pricing,companyMinimum}', '"250.00"')
    from configuration_fixture
  );
begin
  begin
    perform public.save_company_configuration_draft(
      '10000000-0000-4000-8000-000000000001',
      '99100000-0000-4000-8000-000000000101',
      0,
      changed,
      repeat('3', 64)
    );
  exception
    when others then
      if position('different payload' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Configuration command ID accepted a changed payload';
  end if;
end;
$$;

\echo '6/10 optimistic revision mismatch is rejected'
do $$
declare
  blocked boolean := false;
  fixture jsonb := (select configuration from configuration_fixture);
begin
  begin
    perform public.save_company_configuration_draft(
      '10000000-0000-4000-8000-000000000001',
      '99100000-0000-4000-8000-000000000102',
      0,
      fixture,
      repeat('4', 64)
    );
  exception
    when others then
      if position('revision changed' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Stale configuration revision was accepted';
  end if;
end;
$$;

\echo '7/10 exact owner-reviewed live publication is immutable and launch-neutral'
create temporary table publication_receipt(receipt jsonb not null);
insert into publication_receipt(receipt)
select public.publish_company_configuration(
  '10000000-0000-4000-8000-000000000001',
  '99100000-0000-4000-8000-000000000201',
  1,
  'live',
  'pilot-review-evidence-2026-07',
  repeat('5', 64)
);
do $$
declare
  receipt jsonb := (select publication_receipt.receipt from publication_receipt);
  state jsonb := public.get_company_configuration_state(
    '10000000-0000-4000-8000-000000000001'
  );
begin
  if receipt ->> 'status' <> 'published'
    or receipt ->> 'publicationMode' <> 'live'
    or state ->> 'status' <> 'published'
    or state ->> 'publicationMode' <> 'live'
  then
    raise exception 'Publication receipt/state was inaccurate: %, %', receipt, state;
  end if;
end;
$$;
reset role;
do $$
declare
  company_record public.companies%rowtype;
begin
  select * into company_record
  from public.companies
  where id = '10000000-0000-4000-8000-000000000001';
  if coalesce((company_record.settings ->> 'launchAuthorized')::boolean, false) then
    raise exception 'Configuration publication forged company launch authorization';
  end if;
end;
$$;

\echo '8/10 a reviewed revision rotates the prior publication without losing history'
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
declare
  changed jsonb := (
    select jsonb_set(configuration, '{pricing,companyMinimum}', '"250.00"')
    from configuration_fixture
  );
  draft_receipt jsonb;
  publication jsonb;
  replay jsonb;
begin
  draft_receipt := public.save_company_configuration_draft(
    '10000000-0000-4000-8000-000000000001',
    '99100000-0000-4000-8000-000000000301',
    1,
    changed,
    repeat('6', 64)
  );
  if (draft_receipt ->> 'revision')::integer <> 2 then
    raise exception 'Published revision did not advance to draft revision 2: %', draft_receipt;
  end if;
  publication := public.publish_company_configuration(
    '10000000-0000-4000-8000-000000000001',
    '99100000-0000-4000-8000-000000000302',
    2,
    'live',
    'pilot-review-evidence-2026-07-revision-2',
    repeat('7', 64)
  );
  replay := public.publish_company_configuration(
    '10000000-0000-4000-8000-000000000001',
    '99100000-0000-4000-8000-000000000302',
    2,
    'live',
    'pilot-review-evidence-2026-07-revision-2',
    repeat('7', 64)
  );
  if publication ->> 'status' <> 'published'
    or (publication ->> 'revision')::integer <> 2
    or not (replay ->> 'replayed')::boolean
  then
    raise exception 'Revision rotation or publication replay failed: %, %', publication, replay;
  end if;
end;
$$;
reset role;
do $$
begin
  if (
    select count(*) from public.company_configuration_versions
    where company_id = '10000000-0000-4000-8000-000000000001'
      and status = 'published'
  ) <> 1
    or (
      select count(*) from public.company_configuration_versions
      where company_id = '10000000-0000-4000-8000-000000000001'
        and status = 'retired'
    ) <> 1
  then
    raise exception 'Configuration rotation did not preserve one published and one retired row';
  end if;
end;
$$;

\echo '9/10 published history cannot be edited or deleted'
reset role;
do $$
declare
  update_blocked boolean := false;
  delete_blocked boolean := false;
begin
  begin
    update public.company_configuration_versions
    set configuration = jsonb_set(configuration, '{pricing,companyMinimum}', '"1.00"')
    where company_id = '10000000-0000-4000-8000-000000000001'
      and status = 'published';
  exception
    when others then
      if position('immutable' in sqlerrm) > 0 then
        update_blocked := true;
      else
        raise;
      end if;
  end;
  begin
    delete from public.company_configuration_versions
    where company_id = '10000000-0000-4000-8000-000000000001'
      and status = 'published';
  exception
    when others then
      if position('immutable' in sqlerrm) > 0 then
        delete_blocked := true;
      else
        raise;
      end if;
  end;
  if not update_blocked or not delete_blocked then
    raise exception 'Published configuration history was mutable';
  end if;
end;
$$;

\echo '10/10 incomplete live provider dual controls fail validation'
do $$
declare
  issues jsonb;
  unsafe jsonb := (
    select jsonb_set(
      configuration,
      '{integrations,providers,1}',
      jsonb_build_object(
        'provider', 'twilio',
        'requestedMode', 'live',
        'environmentEnabled', false,
        'ownerEnabled', true,
        'health', 'healthy'
      )
    )
    from configuration_fixture
  );
begin
  issues := public.validate_company_configuration(
    '10000000-0000-4000-8000-000000000001',
    unsafe,
    'live'
  );
  if not exists (
    select 1 from jsonb_array_elements(issues) issue
    where issue ->> 'code' = 'live_provider_not_ready'
      and issue ->> 'severity' = 'blocking'
  ) then
    raise exception 'Incomplete provider dual controls passed validation: %', issues;
  end if;
end;
$$;

\echo '10b/17 duplicate travel-zone mappings fail closed'
do $$
declare
  issues jsonb;
  unsafe jsonb := (
    select jsonb_set(
      configuration,
      '{territory,travelZones}',
      (configuration #> '{territory,travelZones}')
        || jsonb_build_array(jsonb_build_object(
          'code', 'DFW-B',
          'name', 'Duplicate fixture zone',
          'maximumMiles', '',
          'fee', '35.00',
          'postalCodes', jsonb_build_array('75219')
        ))
    )
    from configuration_fixture
  );
begin
  issues := public.validate_company_configuration(
    '10000000-0000-4000-8000-000000000001',
    unsafe,
    'live'
  );
  if not exists (
    select 1 from jsonb_array_elements(issues) issue
    where issue ->> 'code' = 'travel_zone_postal_mapping_duplicate'
      and issue ->> 'severity' = 'blocking'
  ) then
    raise exception 'A duplicate ZIP-to-zone mapping passed validation: %', issues;
  end if;
end;
$$;

\echo '10c/17 enabled services require exact crew-skill and equipment coverage'
do $$
declare
  issues jsonb;
  unsafe jsonb := (
    select jsonb_set(
      jsonb_set(
        jsonb_set(
          configuration,
          '{people,crewMembers,0,skills}',
          '["exterior-cleaning"]'::jsonb
        ),
        '{people,crewMembers,1,skills}',
        '["surface-identification","pressure-washing"]'::jsonb
      ),
      '{resources,equipment,1,inspectionStatus}',
      '"due"'::jsonb
    )
    from configuration_fixture
  );
begin
  issues := public.validate_company_configuration(
    '10000000-0000-4000-8000-000000000001',
    unsafe,
    'live'
  );
  if not exists (
    select 1 from jsonb_array_elements(issues) issue
    where issue ->> 'code' = 'service_skill_coverage_missing'
      and issue ->> 'severity' = 'blocking'
  ) or not exists (
    select 1 from jsonb_array_elements(issues) issue
    where issue ->> 'code' = 'service_equipment_coverage_missing'
      and issue ->> 'severity' = 'blocking'
  ) then
    raise exception 'Enabled service capability gaps passed validation: %', issues;
  end if;
end;
$$;

\echo '10d/17 single-owner validation rejects zero or multiple active owners'
do $$
declare
  issues jsonb;
  unsafe jsonb := (
    select jsonb_set(
      configuration,
      '{people,crewMembers,1,role}',
      '"owner"'::jsonb
    )
    from configuration_fixture
  );
begin
  issues := public.validate_company_configuration(
    '10000000-0000-4000-8000-000000000001',
    unsafe,
    'live'
  );
  if not exists (
    select 1 from jsonb_array_elements(issues) issue
    where issue ->> 'code' = 'active_owner_required'
      and issue ->> 'severity' = 'blocking'
  ) then
    raise exception 'Multiple active configured owners passed validation: %', issues;
  end if;
end;
$$;

\echo '11/17 dispatcher cannot publish or inspect an operating baseline'
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000102', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated"}',
  true
);
do $$
declare
  publish_blocked boolean := false;
  read_blocked boolean := false;
begin
  begin
    perform public.publish_company_operating_baseline(
      '10000000-0000-4000-8000-000000000001',
      '99100000-0000-4000-8000-000000000401',
      2,
      'owner-operating-review-2026-07',
      repeat('8', 64)
    );
  exception
    when others then
      if position('Only an active company owner' in sqlerrm) > 0 then
        publish_blocked := true;
      else
        raise;
      end if;
  end;
  begin
    perform public.get_company_operating_baseline_state(
      '10000000-0000-4000-8000-000000000001'
    );
  exception
    when others then
      if position('Only an active company owner' in sqlerrm) > 0 then
        read_blocked := true;
      else
        raise;
      end if;
  end;
  if not publish_blocked or not read_blocked then
    raise exception 'Dispatcher crossed the owner-only operating-baseline boundary';
  end if;
end;
$$;

\echo '12/17 owner explicitly materializes the exact reviewed operating baseline'
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
reset role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
\echo '12a/20 baseline publication revalidates catalog pricing semantics before materialization'
do $$
declare
  blocked boolean := false;
begin
  begin
    update public.service_catalog
    set required_measurement_kinds = array['count']::text[]
    where company_id = '10000000-0000-4000-8000-000000000001'
      and code = 'pressure-wash-flatwork';
    perform set_config(
      'request.jwt.claim.sub',
      '10000000-0000-4000-8000-000000000101',
      true
    );
    perform set_config(
      'request.jwt.claims',
      '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
      true
    );
    perform public.publish_company_operating_baseline(
      '10000000-0000-4000-8000-000000000001',
      '99100000-0000-4000-8000-000000000499',
      2,
      'invalid-catalog-semantics-negative-test',
      repeat('f', 64)
    );
  exception
    when others then
      if position('service_rule_measurement_semantics_mismatch' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Operating baseline materialized mismatched catalog pricing semantics';
  end if;
  if exists (
    select 1
    from public.service_catalog
    where company_id = '10000000-0000-4000-8000-000000000001'
      and code = 'pressure-wash-flatwork'
      and required_measurement_kinds is distinct from array['area_sq_ft']::text[]
  ) then
    raise exception 'Catalog mutation from baseline negative test was not rolled back';
  end if;
end;
$$;
create temporary table integration_state_before_baseline(state_hash text not null);
insert into integration_state_before_baseline(state_hash)
select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(integration)
  order by integration.provider), '[]'::jsonb)::text, 'sha256'), 'hex')
from public.integration_connections integration
where integration.company_id = '10000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
create temporary table baseline_receipt(receipt jsonb not null);
insert into baseline_receipt(receipt)
select public.publish_company_operating_baseline(
  '10000000-0000-4000-8000-000000000001',
  '99100000-0000-4000-8000-000000000402',
  2,
  'owner-operating-review-2026-07',
  repeat('9', 64)
);
do $$
declare
  receipt jsonb := (select baseline_receipt.receipt from baseline_receipt);
begin
  if receipt ->> 'status' <> 'active'
    or (receipt ->> 'configurationRevision')::integer <> 2
    or (receipt ->> 'serviceCount')::integer <> 1
    or (receipt ->> 'packageCount')::integer <> 3
    or (receipt ->> 'providersActivated')::boolean
    or (receipt ->> 'outboundEnabled')::boolean
    or (receipt ->> 'launchAuthorized')::boolean
    or receipt ->> 'baselineHash' !~ '^[a-f0-9]{64}$'
  then
    raise exception 'Operating-baseline receipt was inaccurate: %', receipt;
  end if;
end;
$$;

\echo '13/17 materialized prices, ZIP mappings, packages, terms, retention, and resources are exact'
reset role;
do $$
declare
  receipt jsonb := (select baseline_receipt.receipt from baseline_receipt);
  snapshot jsonb := public.load_active_price_book_snapshot(
    '10000000-0000-4000-8000-000000000001',
    (receipt ->> 'priceBookId')::uuid
  );
  company_record public.companies%rowtype;
begin
  select * into company_record
  from public.companies
  where id = '10000000-0000-4000-8000-000000000001';
  if company_record.status <> 'active'
    or coalesce((company_record.settings ->> 'launchAuthorized')::boolean, false)
    or not coalesce(
      (company_record.settings ->> 'operatingBaselinePublished')::boolean,
      false
    )
    or (snapshot #>> '{book,company_minimum}')::numeric <> 250.00
    or (snapshot #>> '{book,margin_floor_pct}')::numeric <> 42.00
    or jsonb_array_length(snapshot -> 'rules') <> 1
    or jsonb_array_length(snapshot -> 'packages') <> 3
    or not exists (
      select 1
      from public.price_book_travel_zones zone
      where zone.price_book_id = (receipt ->> 'priceBookId')::uuid
        and zone.zone_code = 'DFW-A'
        and zone.postal_codes = array['75219', '76051']
        and zone.mapping_evidence_source = 'reviewed_postal_codes'
        and zone.mapping_review_reference = 'territory-mapping-review-2026-07'
    )
    or not exists (
      select 1
      from jsonb_array_elements(snapshot -> 'multipliers') multiplier
      where multiplier ->> 'attribute' = 'risk'
        and multiplier ->> 'attribute_value' = 'elevated'
        and multiplier ->> 'approval_reason' = 'outside_sop'
    )
    or not exists (
      select 1
      from jsonb_array_elements(snapshot -> 'add_ons') add_on
      where add_on ->> 'code' = 'OIL_SPOT_TREAT'
        and add_on ->> 'approval_reason' = 'outside_sop'
    )
    or not exists (
      select 1 from public.service_terms terms
      where terms.id = (receipt ->> 'serviceTermsId')::uuid
        and terms.status = 'approved'
    )
    or not exists (
      select 1 from public.retention_policies policy
      where policy.id = (receipt ->> 'retentionPolicyId')::uuid
        and policy.status = 'active'
        and policy.class_rules #>> '{operational,days}' = '1095'
    )
    or not exists (
      select 1 from public.company_vehicles vehicle
      where vehicle.company_id = company_record.id
        and vehicle.configuration_key = 'service-vehicle-1'
        and vehicle.active
        and vehicle.configuration_revision = 2
    )
    or not exists (
      select 1 from public.equipment equipment
      where equipment.company_id = company_record.id
        and equipment.asset_tag = 'CONFIG-PRESSURE-WASHER-1'
        and equipment.status = 'available'
    )
    or exists (
      select 1
      from public.crews crew
      where crew.company_id = company_record.id
        and 'technician-only-credential' = any(crew.skill_codes)
    )
    or not exists (
      select 1
      from public.crews crew
      where crew.company_id = company_record.id
        and crew.lead_technician_id =
          '10000000-0000-4000-8000-000000000101'
        and crew.skill_codes @> array[
          'exterior-cleaning',
          'surface-identification',
          'pressure-washing'
        ]
    )
  then
    raise exception 'Operating baseline did not materialize the exact reviewed configuration: %',
      snapshot;
  end if;
end;
$$;

\echo '14/17 exact retry replays without duplicate operating records'
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
declare
  replay jsonb := public.publish_company_operating_baseline(
    '10000000-0000-4000-8000-000000000001',
    '99100000-0000-4000-8000-000000000402',
    2,
    'owner-operating-review-2026-07',
    repeat('9', 64)
  );
begin
  if not (replay ->> 'replayed')::boolean
    or (
      select count(*) from public.company_operating_baseline_publications
      where company_id = '10000000-0000-4000-8000-000000000001'
    ) <> 1
  then
    raise exception 'Operating-baseline exact replay was not idempotent: %', replay;
  end if;
end;
$$;

\echo '15/17 changed payload cannot reuse the operating-baseline command ID'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.publish_company_operating_baseline(
      '10000000-0000-4000-8000-000000000001',
      '99100000-0000-4000-8000-000000000402',
      2,
      'different-operating-review',
      repeat('a', 64)
    );
  exception
    when others then
      if position('different payload' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Changed operating-baseline payload reused a command ID';
  end if;
end;
$$;

\echo '16/17 providers stay byte-for-byte unchanged and published children are immutable'
reset role;
do $$
declare
  integration_hash_after text;
  price_blocked boolean := false;
  package_blocked boolean := false;
begin
  select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(integration)
    order by integration.provider), '[]'::jsonb)::text, 'sha256'), 'hex')
  into integration_hash_after
  from public.integration_connections integration
  where integration.company_id = '10000000-0000-4000-8000-000000000001';
  if integration_hash_after <> (
    select state_hash from integration_state_before_baseline
  ) then
    raise exception 'Operating-baseline publication changed provider state';
  end if;
  begin
    update public.price_book_service_rules
    set unit_price = 0.01
    where price_book_id = (
      select id from public.price_books
      where company_id = '10000000-0000-4000-8000-000000000001'
        and status = 'active'
    );
  exception
    when others then
      if position('immutable' in sqlerrm) > 0 then
        price_blocked := true;
      else
        raise;
      end if;
  end;
  begin
    delete from public.service_packages
    where price_book_id = (
      select id from public.price_books
      where company_id = '10000000-0000-4000-8000-000000000001'
        and status = 'active'
    );
  exception
    when others then
      if position('immutable' in sqlerrm) > 0 then
        package_blocked := true;
      else
        raise;
      end if;
  end;
  if not price_blocked or not package_blocked then
    raise exception 'Published operating-baseline pricing or packages were mutable';
  end if;
end;
$$;

rollback;
