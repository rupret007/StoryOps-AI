\set ON_ERROR_STOP on

begin;

insert into auth.users(id)
values ('10000000-0000-4000-8000-000000000105');

insert into public.company_memberships(
  id, company_id, user_id, role, active
)
values (
  '94500000-0000-4000-8000-000000000491',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000105',
  'technician',
  true
);

insert into public.crew_members(
  id, company_id, crew_id, user_id, starts_on
)
values (
  '94500000-0000-4000-8000-000000000492',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000601',
  '10000000-0000-4000-8000-000000000105',
  current_date - 1
);

\echo '1/11 browser roles cannot forge dispatch evidence or call trusted recorders'
do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_class relation
    where relation.oid in (
      'private.dispatch_current_origin_ephemera'::regclass,
      'private.dispatch_current_origin_verifiers'::regclass
    )
      and relation.relpersistence <> 'u'
  ) then
    raise exception 'Dispatch-origin transient tables are WAL logged';
  end if;
end;
$$;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000102',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated"}',
  true
);

do $$
declare
  receipt_insert_blocked boolean := false;
  recorder_blocked boolean := false;
  loader_blocked boolean := false;
begin
  if has_table_privilege(
    current_user,
    'public.dispatch_clearance_receipts',
    'INSERT,UPDATE,DELETE'
  ) or has_table_privilege(
    current_user,
    'public.dispatch_clearance_consumptions',
    'INSERT,UPDATE,DELETE'
  ) then
    raise exception 'Authenticated retained direct dispatch-clearance DML';
  end if;
  if has_function_privilege(
    current_user,
    'public.record_storyops_dispatch_clearance(uuid,uuid,text,text,jsonb)',
    'EXECUTE'
  ) or has_function_privilege(
    current_user,
    'public.load_storyops_dispatch_clearance_candidate(uuid,uuid,uuid,integer,text)',
    'EXECUTE'
  ) or has_function_privilege(
    current_user,
    'public.replay_storyops_dispatch_clearance(uuid,uuid,uuid,integer,text,text,jsonb)',
    'EXECUTE'
  ) or has_function_privilege(
    current_user,
    'public.get_storyops_dispatch_origin_retention_health()',
    'EXECUTE'
  ) then
    raise exception 'Authenticated retained a trusted dispatch evidence function';
  end if;
  if not has_function_privilege(
    current_user,
    'public.consume_storyops_dispatch_clearance(uuid,uuid,integer,uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'Authenticated lost the finite receipt-consumption boundary';
  end if;

  begin
    insert into public.dispatch_clearance_receipts default values;
  exception
    when insufficient_privilege then receipt_insert_blocked := true;
  end;
  begin
    perform public.record_storyops_dispatch_clearance(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000102',
      'dispatch-forbidden-recorder',
      repeat('0', 64),
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then recorder_blocked := true;
  end;
  begin
    perform public.load_storyops_dispatch_clearance_candidate(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000102',
      '10000000-0000-4000-8000-000000000641',
      1,
      'dispatch-forbidden-loader'
    );
  exception
    when insufficient_privilege then loader_blocked := true;
  end;
  if not receipt_insert_blocked or not recorder_blocked or not loader_blocked then
    raise exception 'Dispatch trusted-recorder ACL boundary failed';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);

set local role service_role;
do $$
begin
  if has_table_privilege(
    current_user,
    'public.dispatch_clearance_receipts',
    'INSERT,UPDATE,DELETE'
  ) or has_table_privilege(
    current_user,
    'public.dispatch_clearance_consumptions',
    'INSERT,UPDATE,DELETE'
  ) then
    raise exception 'Service role retained direct dispatch-clearance DML';
  end if;
  if not has_function_privilege(
    current_user,
    'public.record_storyops_dispatch_clearance(uuid,uuid,text,text,jsonb)',
    'EXECUTE'
  ) or not has_function_privilege(
    current_user,
    'public.load_storyops_dispatch_clearance_candidate(uuid,uuid,uuid,integer,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    current_user,
    'public.replay_storyops_dispatch_clearance(uuid,uuid,uuid,integer,text,text,jsonb)',
    'EXECUTE'
  ) or not has_function_privilege(
    current_user,
    'public.get_storyops_dispatch_origin_retention_health()',
    'EXECUTE'
  ) or has_function_privilege(
    current_user,
    'public.consume_storyops_dispatch_clearance(uuid,uuid,integer,uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'Service-role dispatch function capabilities are not least privilege';
  end if;
  if exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private'
      and relation.relname in (
        'dispatch_current_origin_ephemera',
        'dispatch_current_origin_verifiers'
      )
      and has_table_privilege(
        current_user,
        relation.oid,
        'SELECT,INSERT,UPDATE,DELETE'
      )
  ) then
    raise exception 'Service role can read or mutate private origin material';
  end if;
end;
$$;
reset role;

\echo '2/11 direct and generic confirmed-to-en-route promotion requires a bound receipt'
-- Test-only setup creates an already booked visit. The scheduling and reviewed-
-- geocode boundaries have their own contracts; both guards are immediately
-- restored before the dispatch behavior is exercised.
alter table public.visits disable trigger visits_scheduling_promotion_guard;
alter table public.visits disable trigger visits_reviewed_geocode_guard;
update public.visits
set status = 'confirmed'
where id = '10000000-0000-4000-8000-000000000641';
alter table public.visits enable trigger visits_reviewed_geocode_guard;
alter table public.visits enable trigger visits_scheduling_promotion_guard;

do $$
declare
  direct_blocked boolean := false;
begin
  begin
    update public.visits
    set status = 'en_route'
    where id = '10000000-0000-4000-8000-000000000641';
  exception
    when others then
      if position('DISPATCH_CLEARANCE_RECEIPT_REQUIRED' in sqlerrm) > 0 then
        direct_blocked := true;
      else
        raise;
      end if;
  end;
  if not direct_blocked then
    raise exception 'Direct confirmed-to-en-route update bypassed clearance';
  end if;
end;
$$;

reset role;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000102',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated"}',
  true
);

do $$
declare
  visit_version integer;
  transition_payload jsonb;
  transition_hash text;
  generic_blocked boolean := false;
begin
  select version
  into visit_version
  from public.visits
  where id = '10000000-0000-4000-8000-000000000641';
  transition_payload := jsonb_build_object(
    'entityId', '10000000-0000-4000-8000-000000000641',
    'status', 'en_route'
  );
  transition_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'commandType', 'visit.transition',
        'expectedVersion', visit_version,
        'payload', transition_payload
      )::text,
      'sha256'
    ),
    'hex'
  );
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '94500000-0000-4000-8000-000000000001',
      'visit.transition',
      visit_version,
      transition_payload,
      transition_hash
    );
  exception
    when others then
      if position('DISPATCH_CLEARANCE_RECEIPT_REQUIRED' in sqlerrm) > 0 then
        generic_blocked := true;
      else
        raise;
      end if;
  end;
  if not generic_blocked then
    raise exception 'Generic visit transition bypassed dispatch clearance';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);

\echo '3/11 finite consumption checks hash and launch authority before receipt lookup'
reset role;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000102',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated"}',
  true
);

do $$
declare
  request_hash text;
  hash_blocked boolean := false;
  launch_blocked boolean := false;
begin
  request_hash := public.storyops_json_sha256(jsonb_build_object(
    'clearanceReceiptId', '94500000-0000-4000-8000-000000000101'::uuid,
    'companyId', '10000000-0000-4000-8000-000000000001'::uuid,
    'expectedVisitVersion', 1,
    'operation', 'visit.dispatch_clearance.consume'
  ));
  begin
    perform public.consume_storyops_dispatch_clearance(
      '10000000-0000-4000-8000-000000000001',
      '94500000-0000-4000-8000-000000000102',
      1,
      '94500000-0000-4000-8000-000000000101',
      repeat('f', 64)
    );
  exception
    when others then
      if position('DISPATCH_CLEARANCE_CONSUME_HASH_MISMATCH' in sqlerrm) > 0 then
        hash_blocked := true;
      else
        raise;
      end if;
  end;
  begin
    perform public.consume_storyops_dispatch_clearance(
      '10000000-0000-4000-8000-000000000001',
      '94500000-0000-4000-8000-000000000102',
      1,
      '94500000-0000-4000-8000-000000000101',
      request_hash
    );
  exception
    when others then
      if position('DISPATCH_CLEARANCE_LAUNCH_NOT_AUTHORIZED' in sqlerrm) > 0 then
        launch_blocked := true;
      else
        raise;
      end if;
  end;
  if not hash_blocked or not launch_blocked then
    raise exception 'Dispatch consume did not fail closed before receipt lookup';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);

\echo '4/11 test fixture binds canonical reviewed geocode, live providers, and current authority'
do $$
declare
  property_version_value integer;
  address_hash_value text;
  observed_at_value timestamptz := now() - interval '1 minute';
  expires_at_value timestamptz := now() + interval '1 day';
  evidence_hash_value text;
begin
  select
    property.version,
    public.storyops_json_sha256(property.service_address)
  into property_version_value, address_hash_value
  from public.properties property
  where property.id = '10000000-0000-4000-8000-000000000211'
    and property.company_id = '10000000-0000-4000-8000-000000000001';

  evidence_hash_value := public.storyops_json_sha256(jsonb_build_object(
    'operationId', '94500000-0000-4000-8000-000000000401'::uuid,
    'propertyId', '10000000-0000-4000-8000-000000000211'::uuid,
    'propertyVersion', property_version_value,
    'addressHash', address_hash_value,
    'candidate', jsonb_build_object(
      'id', '94500000-0000-4000-8000-000000000402'::uuid,
      'provider', 'google_maps',
      'mode', 'live',
      'formattedAddress', '1846 Story Lane, Grapevine, TX 76051',
      'latitude', 32.9343000::numeric(10,7),
      'longitude', (-97.0781000)::numeric(10,7),
      'precision', 'rooftop',
      'confidence', 0.9800::numeric(5,4),
      'providerPlaceId', 'storyops-dispatch-contract-place',
      'observedAt', observed_at_value,
      'expiresAt', expires_at_value
    )
  ));

  insert into public.property_geocode_candidates(
    id, company_id, property_id, property_version, address_hash,
    provider, provider_mode, provider_place_id, formatted_address,
    latitude, longitude, precision, confidence, observed_at, expires_at,
    operation_id, requested_by, evidence_hash
  )
  values (
    '94500000-0000-4000-8000-000000000402',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000211',
    property_version_value,
    address_hash_value,
    'google_maps',
    'live',
    'storyops-dispatch-contract-place',
    '1846 Story Lane, Grapevine, TX 76051',
    32.9343000,
    -97.0781000,
    'rooftop',
    0.9800,
    observed_at_value,
    expires_at_value,
    '94500000-0000-4000-8000-000000000401',
    '10000000-0000-4000-8000-000000000101',
    evidence_hash_value
  );
end;
$$;

reset role;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
declare
  property_version_value integer;
  request_hash_value text;
  result jsonb;
begin
  select version into property_version_value
  from public.properties
  where id = '10000000-0000-4000-8000-000000000211';
  request_hash_value := public.storyops_json_sha256(jsonb_build_object(
    'action', 'property.geocode.confirm',
    'propertyId', '10000000-0000-4000-8000-000000000211'::uuid,
    'propertyVersion', property_version_value,
    'candidateId', '94500000-0000-4000-8000-000000000402'::uuid
  ));
  result := public.confirm_storyops_property_geocode_candidate(
    '10000000-0000-4000-8000-000000000001',
    '94500000-0000-4000-8000-000000000403',
    '10000000-0000-4000-8000-000000000211',
    property_version_value,
    '94500000-0000-4000-8000-000000000402',
    request_hash_value
  );
  if result ->> 'provider' <> 'google_maps'
    or result ->> 'candidateId' <> '94500000-0000-4000-8000-000000000402'
  then
    raise exception 'Canonical geocode confirmation fixture failed: %', result;
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);

alter table public.company_configuration_versions
  disable trigger company_configuration_launch_invalidation;
alter table public.company_configuration_versions
  disable trigger company_configuration_travel_zone_evidence;
insert into public.company_configuration_versions(
  id, company_id, revision, schema_version, status, publication_mode,
  configuration, configuration_hash, review_reference, created_by,
  published_by, published_at
)
values (
  '94500000-0000-4000-8000-000000000411',
  '10000000-0000-4000-8000-000000000001',
  945,
  'storyops-company-config-v1',
  'published',
  'live',
  jsonb_build_object(
    'schemaVersion', 'storyops-company-config-v1',
    'safety', jsonb_build_object(
      'weatherPolicy', jsonb_build_object(
        'minimumTemperatureF', '40',
        'maximumTemperatureF', '105',
        'maximumWindSpeedMph', '20',
        'maximumPrecipitationProbability', '0.50',
        'prohibitedLightningRisks', jsonb_build_array(
          'elevated', 'severe', 'unknown'
        )
      )
    )
  ),
  repeat('a', 64),
  'DISPATCH-CONTRACT-LIVE-REVIEW',
  '10000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000101',
  now()
);
alter table public.company_configuration_versions
  enable trigger company_configuration_travel_zone_evidence;
alter table public.company_configuration_versions
  enable trigger company_configuration_launch_invalidation;

alter table public.company_operating_baseline_publications
  disable trigger company_operating_baseline_materials;
alter table public.company_operating_baseline_publications
  disable trigger operating_baseline_launch_invalidation;
insert into public.company_operating_baseline_publications(
  id, company_id, configuration_version_id, configuration_revision,
  configuration_hash, price_book_id, service_terms_id, retention_policy_id,
  baseline_hash, status, review_reference, activated_by, command_id,
  request_hash
)
values (
  '94500000-0000-4000-8000-000000000412',
  '10000000-0000-4000-8000-000000000001',
  '94500000-0000-4000-8000-000000000411',
  945,
  repeat('a', 64),
  '10000000-0000-4000-8000-000000000401',
  '10000000-0000-4000-8000-000000000152',
  '10000000-0000-4000-8000-000000000151',
  repeat('b', 64),
  'active',
  'DISPATCH-CONTRACT-BASELINE-REVIEW',
  '10000000-0000-4000-8000-000000000101',
  '94500000-0000-4000-8000-000000000413',
  repeat('c', 64)
);
alter table public.company_operating_baseline_publications
  enable trigger operating_baseline_launch_invalidation;
alter table public.company_operating_baseline_publications
  enable trigger company_operating_baseline_materials;

update public.integration_connections connection
set
  mode = 'live',
  status = 'healthy',
  secret_reference = 'test-only/dispatch/' || connection.provider,
  capabilities = case connection.provider
    when 'nws' then array['weather']
    else array['routing']
  end,
  last_checked_at = now(),
  owner_enabled = true,
  environment_mode = 'live',
  environment_capabilities = case connection.provider
    when 'nws' then array['weather']
    else array['routing']
  end,
  environment_status = 'healthy',
  environment_fingerprint = repeat(
    case connection.provider when 'nws' then 'd' else 'e' end,
    64
  ),
  environment_probe_run_id = case connection.provider
    when 'nws' then '94500000-0000-4000-8000-000000000421'::uuid
    else '94500000-0000-4000-8000-000000000422'::uuid
  end,
  environment_checked_at = now(),
  environment_expires_at = now() + interval '15 minutes',
  activated_by_user_id = '10000000-0000-4000-8000-000000000101',
  activated_at = now(),
  disabled_at = null,
  activation_command_id = case connection.provider
    when 'nws' then '94500000-0000-4000-8000-000000000423'::uuid
    else '94500000-0000-4000-8000-000000000424'::uuid
  end
where connection.company_id = '10000000-0000-4000-8000-000000000001'
  and connection.provider in ('nws', 'vroom');

alter table public.jobs disable trigger jobs_scheduling_promotion_guard;
update public.jobs
set
  status = 'scheduled',
  assigned_crew_id = '10000000-0000-4000-8000-000000000601'
where id = '10000000-0000-4000-8000-000000000631';
alter table public.jobs enable trigger jobs_scheduling_promotion_guard;

update public.visits
set
  starts_at = now() + interval '30 minutes',
  ends_at = now() + interval '284 minutes'
where id = '10000000-0000-4000-8000-000000000641';

insert into public.route_checks(
  id, company_id, provider, checked_at, route_feasible, drive_minutes,
  added_distance_miles, violations, request_payload, response_payload
)
select
  '94500000-0000-4000-8000-000000000431',
  visit.company_id,
  'vroom',
  now() - interval '1 minute',
  true,
  24,
  11.20,
  '{}',
  jsonb_build_object(
    'origin', jsonb_build_object(
      'latitude', 32.9,
      'longitude', -96.9
    ),
    'visitId', visit.id,
    'jobId', visit.job_id,
    'crewId', visit.crew_id,
    'window', jsonb_build_object(
      'start', visit.starts_at,
      'end', visit.ends_at
    )
  ),
  jsonb_build_object(
    'routes', 1,
    'assignedVisitId', visit.id,
    'unassigned', jsonb_build_array()
  )
from public.visits visit
where visit.id = '10000000-0000-4000-8000-000000000641';

insert into public.weather_checks(
  id, company_id, property_id, provider, forecast_issued_at, checked_at,
  period_starts_at, period_ends_at, temperature_f,
  precipitation_probability, wind_speed_mph, lightning_risk,
  condition_codes, policy_disposition, raw_forecast
)
select
  '94500000-0000-4000-8000-000000000432',
  visit.company_id,
  job.property_id,
  'nws',
  now() - interval '1 hour',
  now() - interval '1 minute',
  visit.starts_at - interval '1 hour',
  visit.ends_at + interval '1 hour',
  78,
  0.10,
  8,
  'none',
  array['clear'],
  'eligible',
  jsonb_build_object(
    'gridpoint', 'FWD/88,104',
    'visitId', visit.id,
    'unknowns', jsonb_build_array()
  )
from public.visits visit
join public.jobs job on job.id = visit.job_id
where visit.id = '10000000-0000-4000-8000-000000000641';

insert into public.scheduling_evidence_receipts(
  id, company_id, job_id, job_version, property_id, crew_id, crew_version,
  starts_at, ends_at, evidence_mode, configuration_revision,
  capacity_provider, capacity_reference, capacity_disposition,
  capacity_observed_at, capacity_expires_at, capacity_payload,
  capacity_payload_hash, calendar_event_status,
  operating_baseline_publication_id, operating_baseline_hash,
  route_check_id, route_disposition, route_observed_at, route_expires_at,
  route_request_hash, route_response_hash, weather_check_id,
  weather_disposition, weather_observed_at, weather_expires_at,
  weather_policy_version, weather_policy_hash, weather_payload_hash,
  unknowns, conflicts, expires_at, evidence_hash, idempotency_key,
  request_hash, created_by
)
select
  '94500000-0000-4000-8000-000000000433',
  visit.company_id,
  job.id,
  job.version,
  job.property_id,
  visit.crew_id,
  crew.version,
  visit.starts_at,
  visit.ends_at,
  'sandbox',
  945,
  'mock',
  'dispatch-contract-booking-fixture',
  'unknown',
  route.checked_at,
  route.checked_at + interval '10 minutes',
  jsonb_build_object('mode', 'sandbox'),
  public.storyops_json_sha256(jsonb_build_object('mode', 'sandbox')),
  'unknown',
  '94500000-0000-4000-8000-000000000412',
  repeat('b', 64),
  route.id,
  'eligible',
  route.checked_at,
  route.checked_at + interval '10 minutes',
  public.storyops_json_sha256(route.request_payload),
  public.storyops_json_sha256(route.response_payload),
  weather.id,
  'eligible',
  weather.checked_at,
  weather.checked_at + interval '10 minutes',
  'dispatch-contract-v1',
  public.storyops_json_sha256(
    company.settings -> 'weatherPolicy'
  ),
  public.storyops_json_sha256(weather.raw_forecast),
  '{}',
  '[]'::jsonb,
  least(
    route.checked_at + interval '10 minutes',
    weather.checked_at + interval '10 minutes'
  ),
  repeat('0', 64),
  'dispatch-contract-booking-receipt',
  repeat('1', 64),
  '10000000-0000-4000-8000-000000000101'
from public.visits visit
join public.jobs job on job.id = visit.job_id
join public.crews crew on crew.id = visit.crew_id
join public.route_checks route
  on route.id = '94500000-0000-4000-8000-000000000431'
join public.weather_checks weather
  on weather.id = '94500000-0000-4000-8000-000000000432'
join public.companies company on company.id = visit.company_id
where visit.id = '10000000-0000-4000-8000-000000000641';

update public.visits
set
  scheduling_evidence_receipt_id =
    '94500000-0000-4000-8000-000000000433',
  route_check_id = '94500000-0000-4000-8000-000000000431',
  weather_check_id = '94500000-0000-4000-8000-000000000432'
where id = '10000000-0000-4000-8000-000000000641';

alter table public.scheduling_evidence_consumptions
  disable trigger scheduling_evidence_consumption_reconciliation_fence;
alter table public.scheduling_evidence_consumptions
  disable trigger scheduling_evidence_consumption_reconciliation_close;
insert into public.scheduling_evidence_consumptions(
  company_id, evidence_receipt_id, visit_id, idempotency_key, consumed_by
)
values (
  '10000000-0000-4000-8000-000000000001',
  '94500000-0000-4000-8000-000000000433',
  '10000000-0000-4000-8000-000000000641',
  'dispatch-contract-booking-consumption',
  '10000000-0000-4000-8000-000000000101'
);
alter table public.scheduling_evidence_consumptions
  enable trigger scheduling_evidence_consumption_reconciliation_close;
alter table public.scheduling_evidence_consumptions
  enable trigger scheduling_evidence_consumption_reconciliation_fence;

alter table public.dispatch_assignments
  disable trigger dispatch_assignments_scheduling_promotion_guard;
update public.dispatch_assignments assignment
set
  status = 'confirmed',
  starts_at = visit.starts_at,
  ends_at = visit.ends_at
from public.visits visit
where assignment.visit_id = visit.id
  and visit.id = '10000000-0000-4000-8000-000000000641';
alter table public.dispatch_assignments
  enable trigger dispatch_assignments_scheduling_promotion_guard;

\echo '5/11 current origin is accepted only from the exact date-valid field actor'
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  visit_version_value integer;
  snapshot jsonb;
  actor_id uuid;
  expected_error text;
  denied_count integer := 0;
begin
  select version into visit_version_value
  from public.visits
  where id = '10000000-0000-4000-8000-000000000641';

  for actor_id in
    select unnest(array[
      '10000000-0000-4000-8000-000000000103'::uuid,
      '10000000-0000-4000-8000-000000000105'::uuid
    ])
  loop
    snapshot := public.load_storyops_dispatch_clearance_candidate(
      '10000000-0000-4000-8000-000000000001',
      actor_id,
      '10000000-0000-4000-8000-000000000641',
      visit_version_value,
      'dispatch-actor-allowed-' || actor_id::text
    );
    if snapshot #>> '{actor,user_id}' <> actor_id::text
      or snapshot #>> '{actor,role}' <> 'technician'
    then
      raise exception 'Assigned technician actor snapshot changed: %', snapshot;
    end if;
  end loop;

  for actor_id, expected_error in
    select *
    from (
      values
        (
          '10000000-0000-4000-8000-000000000102'::uuid,
          'DISPATCH_CURRENT_ORIGIN_ACTIVE_FIELD_ACTOR_REQUIRED'
        ),
        (
          '10000000-0000-4000-8000-000000000101'::uuid,
          'DISPATCH_CURRENT_ORIGIN_CREW_ASSIGNMENT_REQUIRED'
        )
    ) denied(actor_id, expected_error)
  loop
    begin
      perform public.load_storyops_dispatch_clearance_candidate(
        '10000000-0000-4000-8000-000000000001',
        actor_id,
        '10000000-0000-4000-8000-000000000641',
        visit_version_value,
        'dispatch-actor-denied-' || actor_id::text
      );
    exception
      when others then
        if position(expected_error in sqlerrm) > 0 then
          denied_count := denied_count + 1;
        else
          raise;
        end if;
    end;
  end loop;
  if denied_count <> 2 then
    raise exception 'Dispatcher or unassigned owner supplied current origin';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '', true);

insert into public.crew_members(
  id, company_id, crew_id, user_id, starts_on
)
values (
  '94500000-0000-4000-8000-000000000493',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000601',
  '10000000-0000-4000-8000-000000000101',
  current_date - 1
);

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  visit_version_value integer;
  snapshot jsonb;
begin
  select version into visit_version_value
  from public.visits
  where id = '10000000-0000-4000-8000-000000000641';
  snapshot := public.load_storyops_dispatch_clearance_candidate(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000641',
    visit_version_value,
    'dispatch-owner-now-assigned'
  );
  if snapshot #>> '{actor,user_id}'
      <> '10000000-0000-4000-8000-000000000101'
    or snapshot #>> '{actor,role}' <> 'owner'
  then
    raise exception 'Assigned owner actor snapshot changed: %', snapshot;
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '', true);

insert into public.route_checks(
  id, company_id, provider, checked_at, route_feasible, drive_minutes,
  added_distance_miles, violations, request_payload, response_payload
)
select
  fixture.route_id,
  company_id,
  'vroom',
  fixture.checked_at,
  true,
  24,
  11.20,
  '{}',
  request_payload || jsonb_build_object(
    'schemaVersion', 'storyops-dispatch-route-request-v2',
    'origin', jsonb_build_object(
      'latitude', 32.781,
      'longitude', -96.81
    ),
    'currentOriginHash', public.storyops_json_sha256(
      jsonb_build_object(
        'schemaVersion', 'storyops-dispatch-current-origin-v1',
        'readingId', fixture.reading_id,
        'source', 'device_geolocation',
        'coordinates', jsonb_build_object(
          'latitude', 32.781,
          'longitude', -96.81
        ),
        'observedAt', fixture.checked_at,
        'accuracyMeters', 18,
        'consent', jsonb_build_object(
          'kind', 'explicit_user_action',
          'disclosureVersion', 'storyops-dispatch-origin-consent-v1',
          'capturedAt', fixture.checked_at
        )
      )
    )
  ),
  response_payload
from public.route_checks
cross join (
  values
    (
      '94500000-0000-4000-8000-000000000436'::uuid,
      now() - interval '15 seconds',
      '94500000-0000-4000-8000-000000000446'::uuid
    ),
    (
      '94500000-0000-4000-8000-000000000434'::uuid,
      now() - interval '30 minutes',
      '94500000-0000-4000-8000-000000000447'::uuid
    )
) fixture(route_id, checked_at, reading_id)
where id = '94500000-0000-4000-8000-000000000431';

insert into public.weather_checks(
  id, company_id, property_id, provider, forecast_issued_at, checked_at,
  period_starts_at, period_ends_at, temperature_f,
  precipitation_probability, wind_speed_mph, lightning_risk,
  condition_codes, policy_disposition, raw_forecast
)
select
  '94500000-0000-4000-8000-000000000435',
  company_id,
  property_id,
  'nws',
  forecast_issued_at,
  now() - interval '30 minutes',
  period_starts_at,
  period_ends_at,
  temperature_f,
  precipitation_probability,
  wind_speed_mph,
  lightning_risk,
  condition_codes,
  policy_disposition,
  raw_forecast
from public.weather_checks
where id = '94500000-0000-4000-8000-000000000432';

insert into public.dispatch_clearance_receipts(
  id, schema_version, company_id, visit_id, visit_version, job_id, job_version,
  property_id, property_version, property_geocoded_at, crew_id, crew_version,
  starts_at, ends_at, evidence_mode, configuration_revision,
  configuration_hash, operating_baseline_publication_id,
  operating_baseline_hash, scheduling_evidence_receipt_id,
  provider_snapshot_hash, provider_bindings, current_origin,
  current_origin_hash, current_origin_expires_at, route_check_id,
  route_disposition, route_observed_at, route_expires_at,
  route_request_hash, route_response_hash, weather_check_id,
  weather_disposition, weather_observed_at, weather_expires_at,
  weather_policy_version, weather_policy_hash, weather_payload_hash,
  unknowns, conflicts, expires_at, evidence_hash, idempotency_key,
  request_hash, created_by
)
select
  receipt_id,
  'storyops-dispatch-clearance-v2',
  visit.company_id,
  visit.id,
  visit.version,
  job.id,
  job.version,
  property.id,
  property.version,
  property.geocoded_at,
  visit.crew_id,
  crew.version,
  visit.starts_at,
  visit.ends_at,
  'live',
  945,
  repeat('a', 64),
  '94500000-0000-4000-8000-000000000412',
  repeat('b', 64),
  '94500000-0000-4000-8000-000000000433',
  private.storyops_dispatch_provider_snapshot_hash(visit.company_id),
  private.storyops_dispatch_provider_bindings(visit.company_id),
  origin.current_origin,
  public.storyops_json_sha256(origin.current_origin),
  route.checked_at + interval '2 minutes',
  route.id,
  'eligible',
  route.checked_at,
  route.checked_at + interval '10 minutes',
  public.storyops_json_sha256(route.request_payload),
  public.storyops_json_sha256(route.response_payload),
  weather.id,
  'eligible',
  weather.checked_at,
  weather.checked_at + interval '10 minutes',
  'dispatch-contract-v1',
  public.storyops_json_sha256(company.settings -> 'weatherPolicy'),
  public.storyops_json_sha256(weather.raw_forecast),
  '{}',
  '[]'::jsonb,
  least(
    route.checked_at + interval '2 minutes',
    route.checked_at + interval '10 minutes',
    weather.checked_at + interval '10 minutes'
  ),
  repeat('0', 64),
  'dispatch:' || visit.id::text || ':v' || visit.version::text
    || ':origin:' || fixture.reading_id::text,
  public.storyops_json_sha256(jsonb_build_object(
    'actorUserId', '10000000-0000-4000-8000-000000000103'::uuid,
    'companyId', visit.company_id,
    'currentOrigin', origin.current_origin,
    'expectedVisitVersion', visit.version,
    'idempotencyKey',
      'dispatch:' || visit.id::text || ':v' || visit.version::text
        || ':origin:' || fixture.reading_id::text,
    'schemaVersion', 'storyops-dispatch-clearance-request-v2',
    'visitId', visit.id::text
  )),
  '10000000-0000-4000-8000-000000000103'
from (
  values
    (
      '94500000-0000-4000-8000-000000000441'::uuid,
      '94500000-0000-4000-8000-000000000436'::uuid,
      '94500000-0000-4000-8000-000000000432'::uuid,
      '94500000-0000-4000-8000-000000000446'::uuid
    ),
    (
      '94500000-0000-4000-8000-000000000442'::uuid,
      '94500000-0000-4000-8000-000000000434'::uuid,
      '94500000-0000-4000-8000-000000000435'::uuid,
      '94500000-0000-4000-8000-000000000447'::uuid
    )
) fixture(
  receipt_id, route_id, weather_id, reading_id
)
join public.visits visit
  on visit.id = '10000000-0000-4000-8000-000000000641'
join public.jobs job on job.id = visit.job_id
join public.properties property on property.id = job.property_id
join public.crews crew on crew.id = visit.crew_id
join public.companies company on company.id = visit.company_id
join public.route_checks route on route.id = fixture.route_id
join public.weather_checks weather on weather.id = fixture.weather_id
cross join lateral (
  select jsonb_build_object(
    'schemaVersion', 'storyops-dispatch-current-origin-v1',
    'readingId', fixture.reading_id,
    'source', 'device_geolocation',
    'coordinates', jsonb_build_object(
      'latitude', 32.781,
      'longitude', -96.81
    ),
    'observedAt', route.checked_at,
    'accuracyMeters', 18,
    'consent', jsonb_build_object(
      'kind', 'explicit_user_action',
      'disclosureVersion', 'storyops-dispatch-origin-consent-v1',
      'capturedAt', route.checked_at
    )
  ) as current_origin
) origin;

create temporary table dispatch_clearance_v2_evidence_fixture (
  receipt_id uuid primary key,
  evidence jsonb not null
) on commit drop;

insert into dispatch_clearance_v2_evidence_fixture(receipt_id, evidence)
select
  receipt.id,
  jsonb_build_object(
    'schemaVersion', 'storyops-dispatch-clearance-evidence-v2',
    'evidenceMode', 'live',
    'visitId', receipt.visit_id,
    'visitVersion', receipt.visit_version,
    'jobId', receipt.job_id,
    'jobVersion', receipt.job_version,
    'propertyId', receipt.property_id,
    'propertyVersion', receipt.property_version,
    'propertyGeocodedAt', receipt.property_geocoded_at,
    'crewId', receipt.crew_id,
    'crewVersion', receipt.crew_version,
    'startsAt', receipt.starts_at,
    'endsAt', receipt.ends_at,
    'configurationRevision', receipt.configuration_revision,
    'configurationHash', receipt.configuration_hash,
    'operatingBaselinePublicationId',
      receipt.operating_baseline_publication_id,
    'operatingBaselineHash', receipt.operating_baseline_hash,
    'schedulingEvidenceReceiptId', receipt.scheduling_evidence_receipt_id,
    'providerSnapshotHash', receipt.provider_snapshot_hash,
    'currentOrigin', receipt.current_origin || jsonb_build_object(
      'coordinates',
      ephemera.coordinates
    ),
    'route', jsonb_build_object(
      'provider', 'vroom',
      'disposition', 'eligible',
      'observedAt', receipt.route_observed_at,
      'expiresAt', receipt.route_observed_at + interval '10 minutes',
      'routeFeasible', true,
      'driveMinutes', 24,
      'distanceMiles', 11.20,
      'violations', jsonb_build_array(),
      'requestPayload', jsonb_build_object(
        'schemaVersion', 'storyops-dispatch-route-request-v2',
        'companyId', receipt.company_id,
        'visitId', receipt.visit_id,
        'visitVersion', receipt.visit_version,
        'jobId', receipt.job_id,
        'jobVersion', receipt.job_version,
        'propertyId', receipt.property_id,
        'propertyVersion', receipt.property_version,
        'crewId', receipt.crew_id,
        'crewVersion', receipt.crew_version,
        'currentOriginHash', verifier.source_origin_sha256,
        'origin', ephemera.coordinates,
        'destination', jsonb_build_object(
          'latitude', property.latitude,
          'longitude', property.longitude
        ),
        'departureAt', receipt.route_observed_at,
        'arrivalDeadline', receipt.starts_at,
        'visitWindow', jsonb_build_object(
          'start', receipt.starts_at,
          'end', receipt.ends_at
        ),
        'routingJobId', 'dispatch:' || receipt.visit_id::text
      ),
      'responsePayload', jsonb_build_object(
        'provider', 'vroom',
        'mode', 'live',
        'vehicleId', receipt.crew_id,
        'jobIds', jsonb_build_array('dispatch:' || receipt.visit_id::text),
        'unassignedJobIds', jsonb_build_array(),
        'travelSeconds', 1440,
        'serviceSeconds', extract(
          epoch from (receipt.ends_at - receipt.starts_at)
        )::integer,
        'distanceMeters', 18024.6528,
        'summary', jsonb_build_object(
          'travelSeconds', 1440,
          'serviceSeconds', extract(
            epoch from (receipt.ends_at - receipt.starts_at)
          )::integer,
          'distanceMeters', 18024.6528
        )
      )
    ),
    'weather', jsonb_build_object(
      'provider', 'nws',
      'disposition', 'eligible',
      'observedAt', weather.checked_at,
      'expiresAt', weather.checked_at + interval '20 minutes',
      'forecastIssuedAt', weather.forecast_issued_at,
      'periodStartsAt', weather.period_starts_at,
      'periodEndsAt', weather.period_ends_at,
      'temperatureF', weather.temperature_f,
      'precipitationProbability', weather.precipitation_probability,
      'windSpeedMph', weather.wind_speed_mph,
      'lightningRisk', weather.lightning_risk,
      'conditionCodes', to_jsonb(weather.condition_codes),
      'policyVersion', coalesce(
        nullif(policy.envelope ->> 'version', ''),
        'weather-policy-'
          || left(public.storyops_json_sha256(policy.envelope), 32)
      ),
      'policyHash', public.storyops_json_sha256(policy.envelope),
      'policy', policy.envelope,
      'payload', weather.raw_forecast
    ),
    'unknowns', jsonb_build_array(),
    'conflicts', jsonb_build_array()
  )
from public.dispatch_clearance_receipts receipt
join private.dispatch_current_origin_ephemera ephemera
  on ephemera.receipt_id = receipt.id
join private.dispatch_current_origin_verifiers verifier
  on verifier.receipt_id = receipt.id
join public.properties property on property.id = receipt.property_id
join public.weather_checks weather on weather.id = receipt.weather_check_id
join public.companies company on company.id = receipt.company_id
join public.company_configuration_versions configuration
  on configuration.company_id = receipt.company_id
 and configuration.status = 'published'
cross join lateral (
  select company.settings -> 'weatherPolicy' || jsonb_build_object(
    'reviewReference',
      configuration.configuration #>>
        '{policies,safetyReview,evidenceReference}',
    'reviewedAt',
      configuration.configuration #>>
        '{policies,safetyReview,reviewedAt}',
    'configurationRevision', configuration.revision
  ) as envelope
) policy
where receipt.id = '94500000-0000-4000-8000-000000000441';

do $$
declare
  durable_origin jsonb;
  ephemeral_origin jsonb;
  durable_origin_mac text;
  durable_request_mac text;
  source_origin_sha256 text;
  source_request_sha256 text;
begin
  if not private.storyops_property_has_reviewed_geocode(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000211'
  ) then
    raise exception 'Dispatch fixture lacks current reviewed geocode';
  end if;
  if jsonb_array_length(private.storyops_dispatch_provider_bindings(
    '10000000-0000-4000-8000-000000000001'
  )) <> 2 then
    raise exception 'Dispatch fixture lacks both provider bindings';
  end if;
  select
    receipt.current_origin,
    ephemera.coordinates,
    receipt.current_origin_hash,
    receipt.request_hash,
    verifier.source_origin_sha256,
    verifier.source_request_sha256
  into
    durable_origin,
    ephemeral_origin,
    durable_origin_mac,
    durable_request_mac,
    source_origin_sha256,
    source_request_sha256
  from public.dispatch_clearance_receipts receipt
  join private.dispatch_current_origin_ephemera ephemera
    on ephemera.receipt_id = receipt.id
  join private.dispatch_current_origin_verifiers verifier
    on verifier.receipt_id = receipt.id
  join public.route_checks dispatch on dispatch.id = receipt.route_check_id
  join public.route_checks booking
    on booking.id = '94500000-0000-4000-8000-000000000431'
  where receipt.id = '94500000-0000-4000-8000-000000000441'
    and not (receipt.current_origin ? 'coordinates')
    and dispatch.request_payload -> 'origin' = jsonb_build_object(
      'redacted', true,
      'retentionPolicy',
        'storyops-dispatch-current-origin-ephemeral-v1'
    )
    and dispatch.request_payload ->> 'currentOriginHash'
      = receipt.current_origin_hash
    and public.storyops_json_sha256(
      receipt.current_origin || jsonb_build_object(
        'coordinates',
        ephemera.coordinates
      )
    ) = verifier.source_origin_sha256
    and verifier.origin_mac = receipt.current_origin_hash
    and verifier.request_mac = receipt.request_hash
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
    and booking.request_payload -> 'origin'
      is distinct from ephemera.coordinates;
  if durable_origin is null
    or ephemeral_origin is distinct from jsonb_build_object(
      'latitude', 32.781,
      'longitude', -96.81
    )
    or durable_origin_mac = source_origin_sha256
    or durable_request_mac = source_request_sha256
  then
    raise exception
      'Current origin was not opaque-MAC-bound and minimized: durable %, ephemeral %',
      durable_origin,
      ephemeral_origin;
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  receipt_row public.dispatch_clearance_receipts%rowtype;
  verifier_row private.dispatch_current_origin_verifiers%rowtype;
  full_evidence jsonb;
  replay jsonb;
  replay_rpc jsonb;
  conflicting_origin jsonb;
  conflicting_hash text;
  conflict_blocked boolean := false;
  missing_key_blocked_count integer := 0;
  missing_case record;
begin
  select * into receipt_row
  from public.dispatch_clearance_receipts receipt
  where receipt.id = '94500000-0000-4000-8000-000000000441';
  select * into verifier_row
  from private.dispatch_current_origin_verifiers verifier
  where verifier.receipt_id = receipt_row.id;
  select fixture.evidence into full_evidence
  from dispatch_clearance_v2_evidence_fixture fixture
  where fixture.receipt_id = receipt_row.id;

  for missing_case in
    select *
    from (
      values
        (
          full_evidence - 'visitVersion',
          'DISPATCH_CLEARANCE_EVIDENCE_INVALID'
        ),
        (
          full_evidence - 'weather',
          'DISPATCH_CLEARANCE_EVIDENCE_INVALID'
        ),
        (
          full_evidence #- '{currentOrigin,accuracyMeters}',
          'DISPATCH_CLEARANCE_CURRENT_ORIGIN_INVALID'
        ),
        (
          full_evidence #- '{currentOrigin,coordinates,latitude}',
          'DISPATCH_CLEARANCE_CURRENT_ORIGIN_INVALID'
        ),
        (
          full_evidence #- '{currentOrigin,consent,capturedAt}',
          'DISPATCH_CLEARANCE_CURRENT_ORIGIN_INVALID'
        ),
        (
          jsonb_set(
            full_evidence,
            '{currentOrigin,accuracyMeters}',
            'null'::jsonb
          ),
          'DISPATCH_CLEARANCE_CURRENT_ORIGIN_INVALID'
        ),
        (
          full_evidence #- '{route,responsePayload}',
          'DISPATCH_CLEARANCE_ROUTE_INVALID'
        ),
        (
          full_evidence #- '{route,requestPayload,origin,latitude}',
          'DISPATCH_CLEARANCE_ROUTE_INVALID'
        ),
        (
          full_evidence #- '{weather,precipitationProbability}',
          'DISPATCH_CLEARANCE_WEATHER_INVALID'
        ),
        (
          jsonb_set(full_evidence, '{weather,windSpeedMph}', 'null'::jsonb),
          'DISPATCH_CLEARANCE_WEATHER_INVALID'
        )
    ) candidate(evidence, expected_error)
  loop
    begin
      perform public.record_storyops_dispatch_clearance(
        receipt_row.company_id,
        receipt_row.created_by,
        receipt_row.idempotency_key,
        verifier_row.source_request_sha256,
        missing_case.evidence
      );
    exception
      when others then
        if position(missing_case.expected_error in sqlerrm) > 0 then
          missing_key_blocked_count := missing_key_blocked_count + 1;
        else
          raise;
        end if;
    end;
  end loop;
  if missing_key_blocked_count <> 10 then
    raise exception
      'Recorder blocked % of 10 NULL/missing-key attacks',
      missing_key_blocked_count;
  end if;

  replay := public.record_storyops_dispatch_clearance(
    receipt_row.company_id,
    receipt_row.created_by,
    receipt_row.idempotency_key,
    verifier_row.source_request_sha256,
    full_evidence
  );
  if (replay ->> 'replayed')::boolean is not true
    or replay -> 'currentOrigin'
      is distinct from full_evidence -> 'currentOrigin'
    or replay ->> 'currentOriginHash' <> receipt_row.current_origin_hash
  then
    raise exception 'Exact current-origin refresh replay changed: %', replay;
  end if;

  replay_rpc := public.replay_storyops_dispatch_clearance(
    receipt_row.company_id,
    receipt_row.created_by,
    receipt_row.visit_id,
    receipt_row.visit_version,
    receipt_row.idempotency_key,
    verifier_row.source_request_sha256,
    full_evidence -> 'currentOrigin'
  );
  if (replay_rpc ->> 'replayed')::boolean is not true
    or replay_rpc -> 'currentOrigin'
      is distinct from full_evidence -> 'currentOrigin'
    or replay_rpc ->> 'currentOriginHash'
      <> receipt_row.current_origin_hash
    or replay_rpc ->> 'requestHash' <> receipt_row.request_hash
  then
    raise exception 'Exact replay RPC changed opaque receipt: %', replay_rpc;
  end if;

  conflicting_origin := jsonb_set(
    full_evidence -> 'currentOrigin',
    '{readingId}',
    to_jsonb('94500000-0000-4000-8000-000000000449'::text)
  );
  conflicting_hash := public.storyops_json_sha256(jsonb_build_object(
    'actorUserId', receipt_row.created_by,
    'companyId', receipt_row.company_id,
    'currentOrigin', conflicting_origin,
    'expectedVisitVersion', receipt_row.visit_version,
    'idempotencyKey', receipt_row.idempotency_key,
    'schemaVersion', 'storyops-dispatch-clearance-request-v2',
    'visitId', receipt_row.visit_id::text
  ));
  begin
    perform public.record_storyops_dispatch_clearance(
      receipt_row.company_id,
      receipt_row.created_by,
      receipt_row.idempotency_key,
      conflicting_hash,
      jsonb_set(
        full_evidence,
        '{currentOrigin}',
        conflicting_origin
      )
    );
  exception
    when others then
      if position('DISPATCH_CLEARANCE_IDEMPOTENCY_CONFLICT' in sqlerrm) > 0 then
        conflict_blocked := true;
      else
        raise;
      end if;
  end;
  if not conflict_blocked then
    raise exception 'One refresh key replayed with changed current origin';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '', true);

\echo '6/11 durable rows and audits retain no exact origin or public source oracle'
insert into public.audit_events(
  id, company_id, actor_type, actor_id, action, entity_type, entity_id,
  after_data, retention_class, retain_until
)
values (
  '94500000-0000-4000-8000-000000000494',
  '10000000-0000-4000-8000-000000000001',
  'system',
  'dispatch-origin-contract',
  'visit.dispatch_clearance_refreshed',
  'dispatch_clearance_receipt',
  '94500000-0000-4000-8000-000000000441',
  jsonb_build_object(
    'visitId', '10000000-0000-4000-8000-000000000641',
    'currentOriginHash', repeat('9', 64)
  ),
  'audit',
  now() + interval '7 years'
);

do $$
declare
  provider_redaction jsonb;
  stale_payload jsonb;
begin
  provider_redaction := public.redact_audit_payload(
    'provider_customers',
    jsonb_build_object(
      'id', '94500000-0000-4000-8000-000000000495',
      'email_snapshot', 'privacy-regression@example.test'
    )
  );
  if provider_redaction ? 'email_snapshot'
    or not (provider_redaction ? '_source_sha256')
    or provider_redaction -> '_redacted_fields'
      <> jsonb_build_array('email_snapshot')
  then
    raise exception 'Cumulative provider-customer audit redaction regressed: %',
      provider_redaction;
  end if;
  if position(
    'storyops_launch_authorization_base_before_private_workers'
    in pg_get_functiondef(
      'private.storyops_launch_authorization_effective(uuid)'::regprocedure
    )
  ) = 0
    or position(
      'storyops_launch_authorization_base_before_canary_quarantine'
      in pg_get_functiondef(
        'private.storyops_launch_authorization_base_before_private_workers(uuid)'::regprocedure
      )
    ) = 0
    or position(
      'storyops_dispatch_origin_retention_healthy'
      in pg_get_functiondef(
        'private.storyops_launch_authorization_base_before_canary_quarantine(uuid)'::regprocedure
      )
    ) = 0
  then
    raise exception 'Dispatch-origin retention health is not a P0 launch gate';
  end if;

  if exists (
    select 1
    from public.route_checks route
    where route.id in (
        '94500000-0000-4000-8000-000000000434',
        '94500000-0000-4000-8000-000000000436'
      )
      and (
        route.request_payload ? 'origin'
        and route.request_payload -> 'origin'
          <> jsonb_build_object(
            'redacted', true,
            'retentionPolicy',
              'storyops-dispatch-current-origin-ephemeral-v1'
          )
      )
  ) or exists (
    select 1
    from public.dispatch_clearance_receipts receipt
    where receipt.id in (
        '94500000-0000-4000-8000-000000000441',
        '94500000-0000-4000-8000-000000000442'
      )
      and receipt.current_origin ? 'coordinates'
  ) then
    raise exception 'A durable dispatch row retained exact coordinates';
  end if;

  if exists (
    select 1
    from public.audit_events event
    where event.entity_type in (
        'route_checks',
        'dispatch_clearance_receipts'
      )
      and event.entity_id in (
        '94500000-0000-4000-8000-000000000434',
        '94500000-0000-4000-8000-000000000436',
        '94500000-0000-4000-8000-000000000441',
        '94500000-0000-4000-8000-000000000442'
      )
      and (
        coalesce(event.before_data, '{}'::jsonb) ? 'request_payload'
        or coalesce(event.after_data, '{}'::jsonb) ? 'request_payload'
        or coalesce(event.before_data, '{}'::jsonb) ? 'current_origin'
        or coalesce(event.after_data, '{}'::jsonb) ? 'current_origin'
        or coalesce(event.before_data, '{}'::jsonb) ? '_source_sha256'
        or coalesce(event.after_data, '{}'::jsonb) ? '_source_sha256'
        or coalesce(event.before_data, '{}'::jsonb)::text like '%32.781%'
        or coalesce(event.after_data, '{}'::jsonb)::text like '%32.781%'
        or coalesce(event.before_data, '{}'::jsonb)::text like '%-96.81%'
        or coalesce(event.after_data, '{}'::jsonb)::text like '%-96.81%'
      )
  ) then
    raise exception 'Generic audit retained origin data or a source oracle';
  end if;

  if (
    select after_data ? 'currentOriginHash'
    from public.audit_events
    where id = '94500000-0000-4000-8000-000000000494'
  ) then
    raise exception 'Explicit dispatch audit retained currentOriginHash';
  end if;

  select private.storyops_dispatch_current_origin_payload(receipt.id)
  into stale_payload
  from public.dispatch_clearance_receipts receipt
  where receipt.id = '94500000-0000-4000-8000-000000000442';
  if stale_payload ? 'coordinates'
    or exists (
      select 1
      from private.dispatch_current_origin_ephemera ephemera
      where ephemera.receipt_id =
        '94500000-0000-4000-8000-000000000442'
    )
  then
    raise exception 'Expired receipt reconstructed or retained coordinates: %',
      stale_payload;
  end if;
end;
$$;

-- Launch authorization has its own migration-43 contract and was proven
-- fail-closed in step 3. This transaction-local replacement isolates the
-- dispatch receipt-consumption contract and is rolled back with the fixture.
create or replace function private.storyops_launch_authorization_effective(
  p_company_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_company_id = '10000000-0000-4000-8000-000000000001'::uuid
$$;

\echo '7/11 stale live evidence cannot be consumed'
reset role;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000103',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000103","role":"authenticated"}',
  true
);
do $$
declare
  visit_version_value integer;
  request_hash_value text;
  blocked boolean := false;
begin
  select version into visit_version_value
  from public.visits
  where id = '10000000-0000-4000-8000-000000000641';
  request_hash_value := public.storyops_json_sha256(jsonb_build_object(
    'clearanceReceiptId', '94500000-0000-4000-8000-000000000442'::uuid,
    'companyId', '10000000-0000-4000-8000-000000000001'::uuid,
    'expectedVisitVersion', visit_version_value,
    'operation', 'visit.dispatch_clearance.consume'
  ));
  begin
    perform public.consume_storyops_dispatch_clearance(
      '10000000-0000-4000-8000-000000000001',
      '94500000-0000-4000-8000-000000000451',
      visit_version_value,
      '94500000-0000-4000-8000-000000000442',
      request_hash_value
    );
  exception
    when others then
      if position(
        'DISPATCH_CLEARANCE_LIVE_FRESH_EVIDENCE_REQUIRED' in sqlerrm
      ) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Expired route/weather evidence authorized departure';
  end if;
end;
$$;

\echo '8/11 another assigned technician cannot read or consume the origin receipt'
reset role;
select set_config(
  'storyops.test.cross_actor_request_hash',
  public.storyops_json_sha256(jsonb_build_object(
    'clearanceReceiptId', '94500000-0000-4000-8000-000000000441'::uuid,
    'companyId', '10000000-0000-4000-8000-000000000001'::uuid,
    'expectedVisitVersion', 1,
    'operation', 'visit.dispatch_clearance.consume'
  )),
  true
);
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000105',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000105","role":"authenticated"}',
  true
);
do $$
declare
  visit_version_value integer := 1;
  request_hash_value text;
  blocked boolean := false;
begin
  if (
    select count(*)
    from public.dispatch_clearance_receipts receipt
    where receipt.id = '94500000-0000-4000-8000-000000000441'
  ) <> 0 then
    raise exception 'Technician B read Technician A current-origin receipt';
  end if;
  request_hash_value := current_setting(
    'storyops.test.cross_actor_request_hash'
  );
  begin
    perform public.consume_storyops_dispatch_clearance(
      '10000000-0000-4000-8000-000000000001',
      '94500000-0000-4000-8000-000000000459',
      visit_version_value,
      '94500000-0000-4000-8000-000000000441',
      request_hash_value
    );
  exception
    when others then
      if position('DISPATCH_CURRENT_ORIGIN_CREATOR_REQUIRED' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Technician B consumed Technician A current origin';
  end if;
end;
$$;

reset role;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000103',
  true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000103","role":"authenticated"}',
  true
);

\echo '9/11 fresh exact receipt consumes atomically, deletes coordinates, replays, and rejects reuse'
do $$
declare
  visit_version_value integer;
  request_hash_value text;
  result jsonb;
  replay jsonb;
  reuse_blocked boolean := false;
begin
  select version into visit_version_value
  from public.visits
  where id = '10000000-0000-4000-8000-000000000641';
  request_hash_value := public.storyops_json_sha256(jsonb_build_object(
    'clearanceReceiptId', '94500000-0000-4000-8000-000000000441'::uuid,
    'companyId', '10000000-0000-4000-8000-000000000001'::uuid,
    'expectedVisitVersion', visit_version_value,
    'operation', 'visit.dispatch_clearance.consume'
  ));
  result := public.consume_storyops_dispatch_clearance(
    '10000000-0000-4000-8000-000000000001',
    '94500000-0000-4000-8000-000000000452',
    visit_version_value,
    '94500000-0000-4000-8000-000000000441',
    request_hash_value
  );
  if result ->> 'status' <> 'applied'
    or result ->> 'currentStatus' <> 'en_route'
    or (result ->> 'resultingVersion')::integer <> visit_version_value + 1
    or (select status from public.visits
      where id = '10000000-0000-4000-8000-000000000641') <> 'en_route'
    or (select count(*) from public.dispatch_clearance_consumptions
      where clearance_receipt_id =
        '94500000-0000-4000-8000-000000000441') <> 1
  then
    raise exception 'Fresh clearance was not atomically consumed: %', result;
  end if;

  replay := public.consume_storyops_dispatch_clearance(
    '10000000-0000-4000-8000-000000000001',
    '94500000-0000-4000-8000-000000000452',
    visit_version_value,
    '94500000-0000-4000-8000-000000000441',
    request_hash_value
  );
  if (replay ->> 'replayed')::boolean is not true
    or replay ->> 'clearanceReceiptId'
      <> '94500000-0000-4000-8000-000000000441'
    or (select count(*) from public.dispatch_clearance_consumptions
      where clearance_receipt_id =
        '94500000-0000-4000-8000-000000000441') <> 1
  then
    raise exception 'Exact dispatch consume replay was not stable: %', replay;
  end if;

  begin
    perform public.consume_storyops_dispatch_clearance(
      '10000000-0000-4000-8000-000000000001',
      '94500000-0000-4000-8000-000000000453',
      visit_version_value,
      '94500000-0000-4000-8000-000000000441',
      request_hash_value
    );
  exception
    when others then
      if position('DISPATCH_CLEARANCE_RECEIPT_ALREADY_CONSUMED' in sqlerrm) > 0
      then
        reuse_blocked := true;
      else
        raise;
      end if;
  end;
  if not reuse_blocked then
    raise exception 'A second command reused one dispatch receipt';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);

do $$
begin
  if exists (
    select 1
    from private.dispatch_current_origin_ephemera ephemera
    where ephemera.receipt_id =
      '94500000-0000-4000-8000-000000000441'
  ) then
    raise exception 'Consumed current-origin coordinates were not deleted';
  end if;
end;
$$;

\echo '10/11 both append-only tables retain the immutable trigger boundary'
do $$
declare
  receipt_blocked boolean := false;
  consumption_blocked boolean := false;
begin
  if not exists (
    select 1
    from pg_trigger trigger_row
    join pg_class relation on relation.oid = trigger_row.tgrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_proc procedure on procedure.oid = trigger_row.tgfoid
    where namespace.nspname = 'public'
      and relation.relname = 'dispatch_clearance_receipts'
      and trigger_row.tgname = 'dispatch_clearance_receipts_immutable'
      and procedure.proname = 'protect_storyops_dispatch_clearance'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled <> 'D'
  ) or not exists (
    select 1
    from pg_trigger trigger_row
    join pg_class relation on relation.oid = trigger_row.tgrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_proc procedure on procedure.oid = trigger_row.tgfoid
    where namespace.nspname = 'public'
      and relation.relname = 'dispatch_clearance_consumptions'
      and trigger_row.tgname = 'dispatch_clearance_consumptions_immutable'
      and procedure.proname = 'protect_storyops_dispatch_clearance'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled <> 'D'
  ) then
    raise exception 'A dispatch append-only table lost its mutation trigger';
  end if;
  begin
    update public.dispatch_clearance_receipts
    set trace_id = 'forbidden-mutation'
    where id = '94500000-0000-4000-8000-000000000441';
  exception
    when others then
      if position('DISPATCH_CLEARANCE_IMMUTABLE' in sqlerrm) > 0 then
        receipt_blocked := true;
      else
        raise;
      end if;
  end;
  begin
    update public.dispatch_clearance_consumptions
    set response = response || jsonb_build_object('forged', true)
    where clearance_receipt_id =
      '94500000-0000-4000-8000-000000000441';
  exception
    when others then
      if position('DISPATCH_CLEARANCE_IMMUTABLE' in sqlerrm) > 0 then
        consumption_blocked := true;
      else
        raise;
      end if;
  end;
  if not receipt_blocked or not consumption_blocked then
    raise exception 'A privileged dispatch evidence mutation was accepted';
  end if;
end;
$$;

\echo '11/11 five-second worker purges abandonment and exposes bounded backlog as P0-blocked'
do $$
declare
  abandoned_route_id uuid := md5(
    'dispatch-abandoned-origin-contract'
  )::uuid;
  observed_at_value timestamptz := statement_timestamp() - interval '5 minutes';
  old_exact_cron_run_id bigint := -91001;
  old_other_cron_run_id bigint := -91002;
  purge_job_id bigint;
  worker_result jsonb;
begin
  if not exists (
    select 1
    from cron.job job
    where job.jobname = 'storyops-dispatch-origin-purge'
      and job.schedule = '5 seconds'
      and job.active
  ) then
    raise exception 'Five-second dispatch-origin purge schedule is inactive';
  end if;

  insert into private.dispatch_current_origin_ephemera(
    route_check_id, company_id, visit_id, coordinates, observed_at,
    expires_at, purge_after
  )
  values (
    abandoned_route_id,
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000641',
    jsonb_build_object('latitude', 32.781, 'longitude', -96.81),
    observed_at_value,
    observed_at_value + interval '2 minutes',
    observed_at_value + interval '2 minutes'
  );
  select job.jobid
  into purge_job_id
  from cron.job job
  where job.jobname = 'storyops-dispatch-origin-purge';
  insert into cron.job_run_details(
    runid, jobid, database, username, command, status, return_message,
    start_time, end_time
  )
  values (
    old_exact_cron_run_id,
    purge_job_id,
    current_database(),
    current_user,
    'select private.run_storyops_dispatch_origin_purge_worker();',
    'succeeded',
    'test old exact history',
    statement_timestamp() - interval '25 hours 1 second',
    statement_timestamp() - interval '25 hours'
  );
  insert into cron.job_run_details(
    runid, jobid, database, username, command, status, return_message,
    start_time, end_time
  )
  values (
    old_other_cron_run_id,
    purge_job_id,
    current_database(),
    current_user,
    'select 1;',
    'succeeded',
    'test unrelated history',
    statement_timestamp() - interval '25 hours 1 second',
    statement_timestamp() - interval '25 hours'
  );
  worker_result := private.run_storyops_dispatch_origin_purge_worker();
  if worker_result ->> 'status' <> 'healthy'
    or (worker_result ->> 'coordinatesPurged')::integer < 1
    or (worker_result ->> 'cronHistoryPurged')::integer < 1
    or (worker_result ->> 'cronHistoryStaleCount')::integer <> 0
    or exists (
      select 1
      from private.dispatch_current_origin_ephemera ephemera
      where ephemera.route_check_id = abandoned_route_id
    )
    or exists (
      select 1
      from cron.job_run_details run
      where run.runid = old_exact_cron_run_id
    )
    or not exists (
      select 1
      from cron.job_run_details run
      where run.runid = old_other_cron_run_id
    )
  then
    raise exception
      'Bounded scoped abandonment/history purge failed: %',
      worker_result;
  end if;

  insert into private.dispatch_current_origin_verifiers(
    route_check_id, company_id, visit_id, verifier_key,
    source_origin_sha256, origin_mac, purge_after
  )
  select
    md5('dispatch-verifier-backlog-' || series.ordinality::text)::uuid,
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000641',
    extensions.gen_random_bytes(32),
    repeat('a', 64),
    repeat('b', 64),
    statement_timestamp() - interval '1 hour'
  from generate_series(1, 5001) series(ordinality);

  worker_result := private.run_storyops_dispatch_origin_purge_worker();
  if worker_result ->> 'status' <> 'failed'
    or (worker_result ->> 'verifiersPurged')::integer <> 5000
    or (worker_result ->> 'verifierStaleCount')::integer <> 1
  then
    raise exception 'Bounded verifier backlog did not fail health: %',
      worker_result;
  end if;
end;
$$;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  health jsonb;
  worker_result jsonb;
  schedule_registered_at_value timestamptz;
begin
  health := public.get_storyops_dispatch_origin_retention_health();
  if health ->> 'status' <> 'blocked'
    or health ->> 'p0ReleaseCheck' <> 'blocked'
    or (health ->> 'verifierStaleCount')::integer <> 1
    or (health ->> 'coordinateStaleCount')::integer <> 0
    or (health ->> 'cronHistoryStaleCount')::integer <> 0
  then
    raise exception 'Verifier backlog was not integration-health blocked: %',
      health;
  end if;

  worker_result := private.run_storyops_dispatch_origin_purge_worker();
  health := public.get_storyops_dispatch_origin_retention_health();
  if worker_result ->> 'status' <> 'healthy'
    or (worker_result ->> 'verifiersPurged')::integer <> 1
    or health ->> 'status' <> 'healthy'
    or health ->> 'p0ReleaseCheck' <> 'passed'
    or (health ->> 'verifierStaleCount')::integer <> 0
    or (health ->> 'coordinateStaleCount')::integer <> 0
    or (health ->> 'cronHistoryStaleCount')::integer <> 0
    or (health ->> 'scheduleActive')::boolean is not true
    or (health ->> 'scheduleSeconds')::integer <> 5
    or (health ->> 'cronHistoryRetentionHours')::integer <> 24
    or (health ->> 'schedulerExecutionVerified')::boolean is not true
    or health ->> 'schedulerLastRunStatus' <> 'succeeded'
  then
    raise exception 'Retention worker did not recover health: %, %',
      worker_result,
      health;
  end if;

  select schedule_registered_at
  into schedule_registered_at_value
  from private.dispatch_origin_purge_worker_health
  where singleton;
  update private.dispatch_origin_purge_worker_health
  set schedule_registered_at =
    statement_timestamp() + interval '1 hour'
  where singleton;
  worker_result := private.run_storyops_dispatch_origin_purge_worker();
  health := public.get_storyops_dispatch_origin_retention_health();
  if worker_result ->> 'status' <> 'healthy'
    or health ->> 'status' <> 'blocked'
    or health ->> 'p0ReleaseCheck' <> 'blocked'
    or (health ->> 'schedulerExecutionVerified')::boolean is not false
  then
    raise exception
      'Direct purge call falsely established scheduler health: %, %',
      worker_result,
      health;
  end if;
  update private.dispatch_origin_purge_worker_health
  set schedule_registered_at = schedule_registered_at_value
  where singleton;
  health := public.get_storyops_dispatch_origin_retention_health();
  if health ->> 'status' <> 'healthy'
    or health ->> 'p0ReleaseCheck' <> 'passed'
    or (health ->> 'schedulerExecutionVerified')::boolean is not true
  then
    raise exception 'Scheduler-derived retention health did not recover: %',
      health;
  end if;
end;
$$;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '', true);

rollback;
