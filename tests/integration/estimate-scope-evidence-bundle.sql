\set ON_ERROR_STOP on

begin;

\echo '1/10 browser and non-backoffice identities cannot load estimate evidence bundles'
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.load_estimate_scope_evidence_bundle(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000201',
      '10000000-0000-4000-8000-000000000211',
      array['10000000-0000-4000-8000-000000000441']::uuid[]
    );
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then
    raise exception 'Authenticated browser loaded the trusted estimate evidence bundle';
  end if;
end;
$$;

reset role;
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.load_estimate_scope_evidence_bundle(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000103',
      '10000000-0000-4000-8000-000000000201',
      '10000000-0000-4000-8000-000000000211',
      array['10000000-0000-4000-8000-000000000441']::uuid[]
    );
  exception when others then
    if position('ESTIMATE_BACKOFFICE_ROLE_REQUIRED' in sqlerrm) > 0 then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'Technician loaded the back-office estimate evidence bundle';
  end if;
end;
$$;

\echo '2/10 newest complete v2 request returns one canonical eligible bundle'
do $$
declare
  bundle jsonb;
begin
  bundle := public.load_estimate_scope_evidence_bundle(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    array[
      '10000000-0000-4000-8000-000000000443',
      '10000000-0000-4000-8000-000000000441',
      '10000000-0000-4000-8000-000000000442'
    ]::uuid[]
  );
  if bundle ->> 'schemaVersion' <> 'storyops-estimate-scope-evidence-v1'
    or not coalesce((bundle ->> 'eligible')::boolean, false)
    or bundle ->> 'requestId' <> '10000000-0000-4000-8000-000000000461'
    or bundle ->> 'reviewId' <> '10000000-0000-4000-8000-000000000462'
    or bundle ->> 'checklistVersion' <> 'exterior-scope-v2'
    or jsonb_array_length(bundle -> 'requiredChecklistCodes') <> 12
    or bundle -> 'measurementIds' <> '[
      "10000000-0000-4000-8000-000000000441",
      "10000000-0000-4000-8000-000000000442",
      "10000000-0000-4000-8000-000000000443"
    ]'::jsonb
    or bundle -> 'analysisIds'
      <> '["10000000-0000-4000-8000-000000000451"]'::jsonb
  then
    raise exception 'Canonical eligible scope bundle was incomplete: %', bundle;
  end if;
end;
$$;

\echo '3/10 approved seed estimate stores the exact request/review bundle and analyses'
reset role;
do $$
declare
  estimate_row public.estimates%rowtype;
  expected_bundle jsonb;
begin
  select *
  into estimate_row
  from public.estimates
  where id = '10000000-0000-4000-8000-000000000501';
  expected_bundle := public.build_estimate_scope_evidence_bundle(
    estimate_row.company_id,
    estimate_row.customer_id,
    estimate_row.property_id,
    array[
      '10000000-0000-4000-8000-000000000441',
      '10000000-0000-4000-8000-000000000442',
      '10000000-0000-4000-8000-000000000443'
    ]::uuid[]
  );
  if estimate_row.scope_photo_request_id
      <> '10000000-0000-4000-8000-000000000461'::uuid
    or estimate_row.scope_photo_review_id
      <> '10000000-0000-4000-8000-000000000462'::uuid
    or estimate_row.scope_photo_checklist_version <> 'exterior-scope-v2'
    or estimate_row.evidence_analysis_ids
      <> array['10000000-0000-4000-8000-000000000451']::uuid[]
    or estimate_row.calculation_input -> 'scopeEvidenceBundle'
      is distinct from expected_bundle
  then
    raise exception 'Approved estimate did not persist the exact scope bundle';
  end if;
end;
$$;

\echo '4/10 one globally usable photo analysis cannot authorize a required-photo estimate'
insert into public.properties(
  id, company_id, customer_id, name, property_type, service_address
)
values (
  '99000000-0000-4000-8000-000000000311',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  'Unreviewed photo-bundle fixture',
  'single_family',
  '{"line1":"Photo bundle test","postalCode":"75219"}'
);

insert into public.property_measurements(
  id, company_id, property_id, kind, label, value, unit, source,
  measured_at, measured_by, verified_by_human, service_codes, add_on_codes
)
values (
  '99000000-0000-4000-8000-000000000441',
  '10000000-0000-4000-8000-000000000001',
  '99000000-0000-4000-8000-000000000311',
  'area_sq_ft',
  'Other property flatwork',
  500,
  'sq_ft',
  'field_measured',
  now(),
  '10000000-0000-4000-8000-000000000101',
  true,
  array['pressure-wash-flatwork'],
  '{}'
);

insert into public.photo_analyses(
  id, company_id, property_id, model, model_version, prompt_version, purpose,
  overall_confidence, observations, measurement_candidates, unknowns,
  injection_signals, disposition, analyzed_at
)
values (
  '99000000-0000-4000-8000-000000000451',
  '10000000-0000-4000-8000-000000000001',
  '99000000-0000-4000-8000-000000000311',
  'sandbox',
  '1',
  'scope-test',
  'scope',
  1,
  '[]',
  '[]',
  '{}',
  '{}',
  'usable_for_scope',
  now()
);

do $$
declare
  blocked boolean := false;
begin
  begin
    insert into public.estimates(
      id, company_id, estimate_number, customer_id, property_id,
      price_book_id, price_book_version, status, calculation_version,
      calculation_input, evidence_analysis_ids, calculated_at
    )
    values (
      '99000000-0000-4000-8000-000000000501',
      '10000000-0000-4000-8000-000000000001',
      'EST-SCOPE-BUNDLE-GLOBAL-PHOTO',
      '10000000-0000-4000-8000-000000000201',
      '99000000-0000-4000-8000-000000000311',
      '10000000-0000-4000-8000-000000000401',
      '2026.1',
      'approved',
      'scope-bundle-test',
      jsonb_build_object(
        'services', jsonb_build_array(jsonb_build_object(
          'serviceCode', 'pressure-wash-flatwork',
          'measurementId', '99000000-0000-4000-8000-000000000441',
          'supportingMeasurementIds', '[]'::jsonb,
          'addOns', '[]'::jsonb
        )),
        'travelZoneCode', 'DFW-CORE',
        'travelZoneEvidence', jsonb_build_object(
          'source', 'reviewed_postal_code',
          'postalCode', '75219',
          'mappingReviewedBy', 'Demo fixture owner',
          'mappingReviewedAt', '2026-07-28T12:00:00.000Z',
          'mappingReviewReference', 'demo-seed-reviewed-zip-mappings-v1'
        ),
        'scopeEvidenceDisposition', 'human_review_required',
        'scopeEvidencePolicies', jsonb_build_array(jsonb_build_object(
          'serviceCode', 'pressure-wash-flatwork',
          'policy', 'photo_required'
        ))
      ),
      array['99000000-0000-4000-8000-000000000451']::uuid[],
      now()
    );
  exception when others then
    if position('ESTIMATE_SCOPE_PHOTO_REVIEW_REQUIRED' in sqlerrm) > 0 then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'Global usable photo analysis authorized a required-photo estimate';
  end if;
end;
$$;

\echo '5/10 a bundle from another property/request is rejected even while pending'
do $$
declare
  blocked boolean := false;
  foreign_bundle jsonb;
begin
  select calculation_input -> 'scopeEvidenceBundle'
  into foreign_bundle
  from public.estimates
  where id = '10000000-0000-4000-8000-000000000501';
  begin
    insert into public.estimates(
      id, company_id, estimate_number, customer_id, property_id,
      price_book_id, price_book_version, status, calculation_version,
      calculation_input, calculated_at
    )
    values (
      '99000000-0000-4000-8000-000000000502',
      '10000000-0000-4000-8000-000000000001',
      'EST-SCOPE-BUNDLE-CROSS-PROPERTY',
      '10000000-0000-4000-8000-000000000201',
      '99000000-0000-4000-8000-000000000311',
      '10000000-0000-4000-8000-000000000401',
      '2026.1',
      'pending_approval',
      'scope-bundle-test',
      jsonb_build_object(
        'services', jsonb_build_array(jsonb_build_object(
          'serviceCode', 'pressure-wash-flatwork',
          'measurementId', '99000000-0000-4000-8000-000000000441',
          'supportingMeasurementIds', '[]'::jsonb,
          'addOns', '[]'::jsonb
        )),
        'travelZoneCode', 'DFW-CORE',
        'travelZoneEvidence', jsonb_build_object(
          'source', 'reviewed_postal_code',
          'postalCode', '75219',
          'mappingReviewedBy', 'Demo fixture owner',
          'mappingReviewedAt', '2026-07-28T12:00:00.000Z',
          'mappingReviewReference', 'demo-seed-reviewed-zip-mappings-v1'
        ),
        'scopeEvidenceDisposition', 'human_review_required',
        'scopeEvidencePolicies', jsonb_build_array(jsonb_build_object(
          'serviceCode', 'pressure-wash-flatwork',
          'policy', 'photo_required'
        )),
        'scopeEvidenceBundle', foreign_bundle
      ),
      now()
    );
  exception when others then
    if position('ESTIMATE_SCOPE_EVIDENCE_BUNDLE_CHANGED' in sqlerrm) > 0 then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'Cross-property scope bundle was accepted';
  end if;
end;
$$;

\echo '6/10 every required-service measurement must be confirmed on the same request'
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);
do $$
declare
  bundle jsonb;
begin
  bundle := public.load_estimate_scope_evidence_bundle(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    array['10000000-0000-4000-8000-000000000444']::uuid[]
  );
  if coalesce((bundle ->> 'eligible')::boolean, false)
    or bundle ->> 'reason' <> 'measurement_evidence_incomplete'
  then
    raise exception 'Other-request measurement was treated as confirmed: %', bundle;
  end if;
end;
$$;

\echo '7/10 unresolved unknowns or a site-verification review revoke authorization'
reset role;
savepoint before_unknown_review;
insert into public.scope_photo_reviews(
  company_id, request_id, disposition, access_decision, risk_decision,
  unresolved_unknowns, reviewed_by, reviewed_at
)
values (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000461',
  'confirmed_for_estimate',
  'Access still requires one explicit human decision before estimating.',
  'Risk still requires one explicit human decision before estimating.',
  array['Fragile finish remains unknown.'],
  '10000000-0000-4000-8000-000000000101',
  clock_timestamp()
);
do $$
declare
  bundle jsonb;
  blocked boolean := false;
begin
  bundle := public.build_estimate_scope_evidence_bundle(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    array[
      '10000000-0000-4000-8000-000000000441',
      '10000000-0000-4000-8000-000000000442',
      '10000000-0000-4000-8000-000000000443'
    ]::uuid[]
  );
  if bundle ->> 'reason' <> 'unresolved_unknowns' then
    raise exception 'Unknowns did not revoke bundle eligibility: %', bundle;
  end if;
  begin
    update public.estimates
    set status = 'approved'
    where id = '10000000-0000-4000-8000-000000000501';
  exception when others then
    if position('ESTIMATE_SCOPE_EVIDENCE_BUNDLE_CHANGED' in sqlerrm) > 0 then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'Estimate remained authorized after unresolved unknowns';
  end if;
end;
$$;
rollback to savepoint before_unknown_review;

savepoint before_site_review;
insert into public.scope_photo_reviews(
  company_id, request_id, disposition, access_decision, risk_decision,
  unresolved_unknowns, reviewed_by, reviewed_at
)
values (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000461',
  'site_verification_required',
  'Technician must verify access and ladder footing before work begins.',
  'Technician must verify utilities and fragile surfaces before work begins.',
  '{}',
  '10000000-0000-4000-8000-000000000101',
  clock_timestamp()
);
do $$
declare
  bundle jsonb;
begin
  bundle := public.build_estimate_scope_evidence_bundle(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    array[
      '10000000-0000-4000-8000-000000000441',
      '10000000-0000-4000-8000-000000000442',
      '10000000-0000-4000-8000-000000000443'
    ]::uuid[]
  );
  if bundle ->> 'reason' <> 'confirmed_review_required' then
    raise exception 'Site-verification review did not revoke eligibility: %', bundle;
  end if;
end;
$$;
rollback to savepoint before_site_review;

\echo '8/10 a newer open request blocks the older reviewed request and stored bundle'
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);
create temporary table newer_scope_request(request_id uuid);
insert into newer_scope_request
select (
  public.create_scope_photo_request(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'New scope request intentionally supersedes the old reviewed request.',
    7,
    'scope-request:newer-bundle-contract',
    repeat('9', 64)
  ) ->> 'requestId'
)::uuid;

do $$
declare
  bundle jsonb;
begin
  bundle := public.load_estimate_scope_evidence_bundle(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    array[
      '10000000-0000-4000-8000-000000000441',
      '10000000-0000-4000-8000-000000000442',
      '10000000-0000-4000-8000-000000000443'
    ]::uuid[]
  );
  if coalesce((bundle ->> 'eligible')::boolean, false)
    or (bundle ->> 'requestId')::uuid <> (select request_id from newer_scope_request)
    or bundle ->> 'requestStatus' <> 'open'
  then
    raise exception 'Newest open request did not block the older review: %', bundle;
  end if;
end;
$$;

reset role;
do $$
declare
  blocked boolean := false;
begin
  begin
    update public.estimates
    set status = 'approved'
    where id = '10000000-0000-4000-8000-000000000501';
  exception when others then
    if position('ESTIMATE_SCOPE_EVIDENCE_BUNDLE_CHANGED' in sqlerrm) > 0 then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'Older reviewed request remained authoritative after a newer open request';
  end if;
end;
$$;

\echo '9/10 cancelled/expired requests cannot be revived by measurement or review commands'
update public.scope_photo_requests
set status = 'cancelled'
where id = (select request_id from newer_scope_request);
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.review_scope_photo_request(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      (select request_id from newer_scope_request),
      'site_verification_required',
      'Cancelled request must not be revived by an access decision.',
      'Cancelled request must not be revived by a risk decision.',
      array['Request was cancelled.'],
      'scope-review:cancelled-bundle-contract',
      repeat('8', 64)
    );
  exception when others then
    if position('SCOPE_PHOTO_REQUEST_INACTIVE' in sqlerrm) > 0 then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'Cancelled request was revived by a review';
  end if;
end;
$$;

\echo '10/10 request creation and estimate binding share the property-first lock order'
reset role;
do $$
declare
  create_definition text;
  bind_definition text;
  builder_volatility "char";
begin
  select pg_get_functiondef(
    'public.create_scope_photo_request(uuid,uuid,uuid,uuid,text,integer,text,text)'::regprocedure
  )
  into create_definition;
  select pg_get_functiondef(
    'public.bind_estimate_scope_evidence_bundle()'::regprocedure
  )
  into bind_definition;
  select provolatile
  into builder_volatility
  from pg_proc
  where oid =
    'public.build_estimate_scope_evidence_bundle(uuid,uuid,uuid,uuid[])'::regprocedure;
  if position('from public.properties property' in create_definition) = 0
    or position('for update' in create_definition)
      < position('from public.properties property' in create_definition)
    or position('from public.properties property' in bind_definition) = 0
    or position('for update' in bind_definition)
      < position('from public.properties property' in bind_definition)
    or position('for update' in create_definition)
      > position('insert into public.scope_photo_requests' in create_definition)
    or builder_volatility <> 'v'
  then
    raise exception 'Scope request and estimate binding do not share property-first locking';
  end if;
end;
$$;

rollback;

\echo 'estimate scope evidence bundle integration passed: actor boundary, v2 completeness, exact binding, global-photo isolation, cross-scope rejection, review invalidation, newest-request blocking, inactive-request rejection, and shared lock order'
