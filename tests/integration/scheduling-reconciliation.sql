\set ON_ERROR_STOP on

begin;

insert into public.companies(id, name, status)
values (
  '99000000-0000-4000-8000-000000000003',
  'Scheduling claim isolation',
  'active'
);

create temporary table scheduling_reconciliation_fixture (
  company_id uuid not null,
  actor_user_id uuid not null,
  job_id uuid not null,
  job_version integer not null,
  property_id uuid not null,
  crew_id uuid not null,
  crew_version integer not null,
  configuration_revision integer not null,
  baseline_id uuid not null,
  baseline_hash text not null,
  route_check_id uuid not null,
  weather_check_id uuid not null,
  receipt_id uuid not null,
  idempotency_key text not null,
  expected_event_id text not null,
  claim jsonb
) on commit drop;

insert into public.company_configuration_versions(
  id,
  company_id,
  revision,
  schema_version,
  status,
  publication_mode,
  configuration,
  configuration_hash,
  review_reference,
  created_by,
  published_by,
  published_at
)
values (
  '92000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000001',
  1,
  'storyops-company-config-v1',
  'published',
  'live',
  '{
    "schemaVersion":"storyops-company-config-v1",
    "testFixture":"scheduling-reconciliation",
    "territory":{
      "travelZones":[{"code":"DFW-CORE","postalCodes":["75001"]}],
      "travelZoneMappingReview":{
        "status":"approved",
        "reviewer":"Scheduling test reviewer",
        "reviewedAt":"2026-07-29T00:00:00Z",
        "evidenceReference":"TEST-SCHEDULING-TRAVEL-ZONE-MAP"
      }
    }
  }',
  repeat('a', 64),
  'TEST-SCHEDULING-RECONCILIATION',
  '10000000-0000-4000-8000-000000000102',
  '10000000-0000-4000-8000-000000000102',
  now()
);

insert into public.company_operating_baseline_publications(
  id,
  company_id,
  configuration_version_id,
  configuration_revision,
  configuration_hash,
  price_book_id,
  service_terms_id,
  retention_policy_id,
  baseline_hash,
  status,
  review_reference,
  activated_by,
  command_id,
  request_hash
)
values (
  '92000000-0000-4000-8000-000000000022',
  '10000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000021',
  1,
  repeat('a', 64),
  '10000000-0000-4000-8000-000000000401',
  '10000000-0000-4000-8000-000000000152',
  '10000000-0000-4000-8000-000000000151',
  repeat('b', 64),
  'active',
  'TEST-SCHEDULING-RECONCILIATION',
  '10000000-0000-4000-8000-000000000102',
  '92000000-0000-4000-8000-000000000023',
  repeat('c', 64)
);

insert into public.route_checks(
  id,
  company_id,
  provider,
  checked_at,
  route_feasible,
  drive_minutes,
  added_distance_miles,
  violations,
  request_payload,
  response_payload
)
values (
  '92000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000001',
  'vroom',
  now() - interval '20 minutes',
  true,
  20,
  8,
  '{}',
  '{"schemaVersion":"reconciliation-test-route-request-v1"}',
  '{"schemaVersion":"reconciliation-test-route-response-v1"}'
);

insert into public.weather_checks(
  id,
  company_id,
  property_id,
  provider,
  forecast_issued_at,
  checked_at,
  period_starts_at,
  period_ends_at,
  temperature_f,
  precipitation_probability,
  wind_speed_mph,
  lightning_risk,
  condition_codes,
  policy_disposition,
  raw_forecast
)
values (
  '92000000-0000-4000-8000-000000000012',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000211',
  'nws',
  now() - interval '30 minutes',
  now() - interval '20 minutes',
  now() + interval '4 days',
  now() + interval '6 days',
  78,
  0.1,
  8,
  'none',
  array['clear'],
  'eligible',
  '{"schemaVersion":"reconciliation-test-weather-v1"}'
);

insert into scheduling_reconciliation_fixture(
  company_id,
  actor_user_id,
  job_id,
  job_version,
  property_id,
  crew_id,
  crew_version,
  configuration_revision,
  baseline_id,
  baseline_hash,
  route_check_id,
  weather_check_id,
  receipt_id,
  idempotency_key,
  expected_event_id
)
select
  job.company_id,
  '10000000-0000-4000-8000-000000000102',
  job.id,
  job.version,
  job.property_id,
  crew.id,
  crew.version,
  baseline.configuration_revision,
  baseline.id,
  baseline.baseline_hash,
  '92000000-0000-4000-8000-000000000011',
  '92000000-0000-4000-8000-000000000012',
  '92000000-0000-4000-8000-000000000001',
  'scheduling-reconciliation:test:one',
  private.storyops_calendar_event_id(
    'scheduling-reconciliation:test:one:calendar'
  )
from public.jobs job
join public.crews crew
  on crew.id = '10000000-0000-4000-8000-000000000601'
join lateral (
  select publication.*
  from public.company_operating_baseline_publications publication
  where publication.company_id = job.company_id
    and publication.status = 'active'
  order by publication.activated_at desc, publication.id
  limit 1
) baseline on true
where job.id = '10000000-0000-4000-8000-000000000631';

do $$
begin
  if (select count(*) from scheduling_reconciliation_fixture) <> 1 then
    raise exception 'Scheduling reconciliation fixture is unavailable';
  end if;
end;
$$;

-- Reconciliation fixtures exercise real live-receipt gates, including one
-- explicitly confirmed provider geocode for the exact current address.
do $$
declare
  fixture scheduling_reconciliation_fixture%rowtype;
  operation_id_value constant uuid :=
    '92000000-0000-4000-8000-000000000090';
  candidate_id_value constant uuid :=
    '92000000-0000-4000-8000-000000000091';
  command_id_value constant uuid :=
    '92000000-0000-4000-8000-000000000092';
  property_version_value integer;
  address_hash_value text;
  lookup_hash_value text;
begin
  select * into fixture from scheduling_reconciliation_fixture;
  select
    property.version,
    public.storyops_json_sha256(property.service_address)
  into property_version_value, address_hash_value
  from public.properties property
  where property.company_id = fixture.company_id
    and property.id = fixture.property_id;
  lookup_hash_value := public.storyops_json_sha256(jsonb_build_object(
    'schemaVersion', 'storyops-property-geocode-lookup-v1',
    'operationId', operation_id_value,
    'propertyId', fixture.property_id,
    'propertyVersion', property_version_value
  ));
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );
  perform public.record_storyops_property_geocode_candidates(
    fixture.company_id,
    fixture.actor_user_id,
    fixture.property_id,
    property_version_value,
    operation_id_value,
    address_hash_value,
    jsonb_build_array(jsonb_build_object(
      'id', candidate_id_value,
      'provider', 'google_maps',
      'mode', 'live',
      'formattedAddress', '4100 Cedar Springs Rd, Dallas, TX 75219, USA',
      'latitude', 32.8119000,
      'longitude', -96.8098000,
      'precision', 'rooftop',
      'confidence', 0.9900,
      'providerPlaceId', 'scheduling-reconciliation-reviewed-property',
      'observedAt', date_trunc('milliseconds', now())
    )),
    lookup_hash_value
  );
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claim.sub',
    fixture.actor_user_id::text,
    true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', fixture.actor_user_id,
      'role', 'authenticated'
    )::text,
    true
  );
  perform public.confirm_storyops_property_geocode_candidate(
    fixture.company_id,
    command_id_value,
    fixture.property_id,
    property_version_value,
    candidate_id_value,
    public.storyops_json_sha256(jsonb_build_object(
      'action', 'property.geocode.confirm',
      'propertyId', fixture.property_id,
      'propertyVersion', property_version_value,
      'candidateId', candidate_id_value
    ))
  );
  if not private.storyops_property_has_reviewed_geocode(
    fixture.company_id,
    fixture.property_id
  ) then
    raise exception 'Reconciliation fixture did not establish reviewed geocode proof';
  end if;
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
end;
$$;

insert into public.scheduling_evidence_receipts(
  id,
  company_id,
  job_id,
  job_version,
  property_id,
  crew_id,
  crew_version,
  starts_at,
  ends_at,
  evidence_mode,
  configuration_revision,
  capacity_provider,
  capacity_reference,
  capacity_disposition,
  capacity_observed_at,
  capacity_expires_at,
  capacity_payload,
  capacity_payload_hash,
  calendar_event_id,
  calendar_event_status,
  calendar_event_etag,
  calendar_reconciled_at,
  calendar_payload_hash,
  operating_baseline_publication_id,
  operating_baseline_hash,
  route_check_id,
  route_disposition,
  route_observed_at,
  route_expires_at,
  route_request_hash,
  route_response_hash,
  weather_check_id,
  weather_disposition,
  weather_observed_at,
  weather_expires_at,
  weather_policy_version,
  weather_policy_hash,
  weather_payload_hash,
  unknowns,
  conflicts,
  expires_at,
  evidence_hash,
  idempotency_key,
  request_hash,
  trace_id,
  created_by
)
select
  fixture.receipt_id,
  fixture.company_id,
  fixture.job_id,
  fixture.job_version,
  fixture.property_id,
  fixture.crew_id,
  fixture.crew_version,
  now() + interval '5 days',
  now() + interval '5 days 254 minutes',
  'live',
  fixture.configuration_revision,
  'google_calendar',
  'operations@example.test',
  'eligible',
  now() - interval '20 minutes',
  now() - interval '10 minutes',
  '{"schemaVersion":"storyops-capacity-evidence-v1"}',
  repeat('1', 64),
  private.storyops_calendar_event_id(
    fixture.idempotency_key || ':calendar'
  ),
  'confirmed',
  '"calendar-etag-v1"',
  now() - interval '20 minutes',
  repeat('2', 64),
  fixture.baseline_id,
  fixture.baseline_hash,
  fixture.route_check_id,
  'eligible',
  now() - interval '20 minutes',
  now() - interval '10 minutes',
  repeat('3', 64),
  repeat('4', 64),
  fixture.weather_check_id,
  'eligible',
  now() - interval '20 minutes',
  now() - interval '10 minutes',
  'weather-policy-v1',
  repeat('5', 64),
  repeat('6', 64),
  '{}',
  '[]',
  now() - interval '10 minutes',
  repeat('0', 64),
  fixture.idempotency_key,
  repeat('7', 64),
  'scheduling-reconciliation-sql-test',
  fixture.actor_user_id
from scheduling_reconciliation_fixture fixture;

insert into public.scheduling_equipment_reservations(
  company_id,
  evidence_receipt_id,
  equipment_id,
  starts_at,
  ends_at,
  status
)
select
  fixture.company_id,
  fixture.receipt_id,
  '10000000-0000-4000-8000-000000000611',
  receipt.starts_at,
  receipt.ends_at,
  'held'
from scheduling_reconciliation_fixture fixture
join public.scheduling_evidence_receipts receipt
  on receipt.id = fixture.receipt_id;

grant select, update on scheduling_reconciliation_fixture
  to authenticated, service_role;

\echo '1/7 receipt insertion durably queues cleanup without another scheduling request'
do $$
declare
  fixture scheduling_reconciliation_fixture%rowtype;
begin
  select * into fixture from scheduling_reconciliation_fixture;
  if (
    select count(*)
    from public.scheduling_reconciliation_cases reconciliation
    where reconciliation.receipt_id = fixture.receipt_id
      and reconciliation.company_id = fixture.company_id
      and reconciliation.job_id = fixture.job_id
      and reconciliation.status = 'pending'
      and reconciliation.next_attempt_at <= now()
  ) <> 1 then
    raise exception 'Expired live receipt did not durably queue reconciliation';
  end if;
end;
$$;

\echo '2/7 authenticated users cannot claim, complete, fail, or mutate cleanup state'
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
begin
  if has_function_privilege(
    current_user,
    'public.claim_storyops_scheduling_reconciliation(uuid,uuid,integer)',
    'EXECUTE'
  )
    or has_function_privilege(
      current_user,
      'public.complete_storyops_scheduling_reconciliation(uuid,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      current_user,
      'public.fail_storyops_scheduling_reconciliation(uuid,uuid,text,text,integer)',
      'EXECUTE'
    )
    or has_table_privilege(
      current_user,
      'public.scheduling_reconciliation_cases',
      'INSERT,UPDATE,DELETE'
    )
    or has_table_privilege(
      current_user,
      'public.scheduling_reconciliation_attempts',
      'INSERT,UPDATE,DELETE'
    )
    or has_column_privilege(
      current_user,
      'public.scheduling_reconciliation_cases',
      'claim_token',
      'SELECT'
    )
  then
    raise exception 'Authenticated role retained scheduling cleanup mutation authority';
  end if;
end;
$$;
reset role;

\echo '3/7 service worker claims exact deterministic calendar identity under a lease'
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  fixture scheduling_reconciliation_fixture%rowtype;
  claimed jsonb;
  cross_company_claim jsonb;
begin
  select * into fixture from scheduling_reconciliation_fixture;
  cross_company_claim := public.claim_storyops_scheduling_reconciliation(
    '99000000-0000-4000-8000-000000000003',
    '92000000-0000-4000-8000-000000000100',
    90
  );
  if cross_company_claim is not null then
    raise exception 'Scheduling claim crossed company scope: %',
      cross_company_claim;
  end if;
  claimed := public.claim_storyops_scheduling_reconciliation(
    '10000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000101',
    90
  );
  if claimed is null
    or claimed ->> 'schemaVersion'
      <> 'storyops-scheduling-reconciliation-claim-v1'
    or claimed ->> 'receiptId' <> fixture.receipt_id::text
    or claimed ->> 'companyId' <> fixture.company_id::text
    or claimed ->> 'operation' <> 'cancel'
    or claimed ->> 'calendarId' <> 'operations@example.test'
    or claimed ->> 'eventId' <> fixture.expected_event_id
    or claimed ->> 'eventEtag' <> '"calendar-etag-v1"'
    or claimed ->> 'idempotencyKey'
      <> fixture.idempotency_key || ':calendar'
  then
    raise exception 'Worker claim did not bind the exact calendar identity: %', claimed;
  end if;
  update scheduling_reconciliation_fixture
  set claim = claimed;
end;
$$;

\echo '4/7 ambiguous provider outcome is quarantined and cannot claim cancellation'
do $$
declare
  fixture scheduling_reconciliation_fixture%rowtype;
  outcome jsonb;
  stale_completion_blocked boolean := false;
begin
  select * into fixture from scheduling_reconciliation_fixture;
  outcome := public.fail_storyops_scheduling_reconciliation(
    (fixture.claim ->> 'caseId')::uuid,
    (fixture.claim ->> 'claimToken')::uuid,
    'NETWORK_ERROR',
    'unknown',
    30
  );
  if outcome ->> 'status' <> 'provider_unknown'
    or outcome ->> 'externalStateUnknown' <> 'true'
    or outcome ->> 'calendarCancellationConfirmed' <> 'false'
    or outcome ->> 'manualReviewRequired' <> 'false'
  then
    raise exception 'Ambiguous provider outcome did not fail closed: %', outcome;
  end if;
  begin
    perform public.complete_storyops_scheduling_reconciliation(
      (fixture.claim ->> 'caseId')::uuid,
      (fixture.claim ->> 'claimToken')::uuid
    );
  exception
    when others then
      if position('SCHEDULING_RECONCILIATION_CLAIM_LOST' in sqlerrm) > 0 then
        stale_completion_blocked := true;
      else
        raise;
      end if;
  end;
  if not stale_completion_blocked then
    raise exception 'Unknown provider state accepted a stale success';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);

update public.scheduling_reconciliation_cases reconciliation
set next_attempt_at = now()
from scheduling_reconciliation_fixture fixture
where reconciliation.id = (fixture.claim ->> 'caseId')::uuid;

\echo '5/7 unknown outcome is reclaimed only as read-back reconciliation'
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  fixture scheduling_reconciliation_fixture%rowtype;
  reconcile_claim jsonb;
  outcome jsonb;
begin
  select * into fixture from scheduling_reconciliation_fixture;
  reconcile_claim := public.claim_storyops_scheduling_reconciliation(
    '10000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000102',
    90
  );
  if reconcile_claim is null
    or reconcile_claim ->> 'receiptId' <> fixture.receipt_id::text
    or reconcile_claim ->> 'operation' <> 'reconcile'
    or (reconcile_claim ->> 'attempt')::integer <> 2
  then
    raise exception 'Provider-unknown case did not require reconciliation: %',
      reconcile_claim;
  end if;
  outcome := public.complete_storyops_scheduling_reconciliation(
    (reconcile_claim ->> 'caseId')::uuid,
    (reconcile_claim ->> 'claimToken')::uuid
  );
  if outcome ->> 'status' <> 'cancelled'
    or outcome ->> 'calendarCancellationConfirmed' <> 'true'
    or outcome ->> 'externalStateUnknown' <> 'false'
  then
    raise exception
      'Exact provider reconciliation did not confirm calendar cancellation: %',
      outcome;
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);
do $$
declare
  fixture scheduling_reconciliation_fixture%rowtype;
begin
  select * into fixture from scheduling_reconciliation_fixture;
  if (
    select status
    from public.scheduling_equipment_reservations reservation
    where reservation.evidence_receipt_id = fixture.receipt_id
  ) <> 'released' then
    raise exception 'Exact provider reconciliation did not release equipment';
  end if;
end;
$$;

\echo '6/7 mismatched deterministic identity is manual-required without a lease'
insert into public.scheduling_evidence_receipts(
  id,
  company_id,
  job_id,
  job_version,
  property_id,
  crew_id,
  crew_version,
  starts_at,
  ends_at,
  evidence_mode,
  configuration_revision,
  capacity_provider,
  capacity_reference,
  capacity_disposition,
  capacity_observed_at,
  capacity_expires_at,
  capacity_payload,
  capacity_payload_hash,
  calendar_event_id,
  calendar_event_status,
  calendar_event_etag,
  calendar_reconciled_at,
  calendar_payload_hash,
  operating_baseline_publication_id,
  operating_baseline_hash,
  route_check_id,
  route_disposition,
  route_observed_at,
  route_expires_at,
  route_request_hash,
  route_response_hash,
  weather_check_id,
  weather_disposition,
  weather_observed_at,
  weather_expires_at,
  weather_policy_version,
  weather_policy_hash,
  weather_payload_hash,
  unknowns,
  conflicts,
  expires_at,
  evidence_hash,
  idempotency_key,
  request_hash,
  trace_id,
  created_by
)
select
  '92000000-0000-4000-8000-000000000002',
  fixture.company_id,
  fixture.job_id,
  fixture.job_version,
  fixture.property_id,
  fixture.crew_id,
  fixture.crew_version,
  now() + interval '5 days',
  now() + interval '5 days 254 minutes',
  'live',
  fixture.configuration_revision,
  'google_calendar',
  'operations@example.test',
  'eligible',
  now() - interval '20 minutes',
  now() - interval '10 minutes',
  '{"schemaVersion":"storyops-capacity-evidence-v1"}',
  repeat('1', 64),
  'storyops0000000000000000000000000000000000000000',
  'confirmed',
  '"calendar-etag-v2"',
  now() - interval '20 minutes',
  repeat('2', 64),
  fixture.baseline_id,
  fixture.baseline_hash,
  fixture.route_check_id,
  'eligible',
  now() - interval '20 minutes',
  now() - interval '10 minutes',
  repeat('3', 64),
  repeat('4', 64),
  fixture.weather_check_id,
  'eligible',
  now() - interval '20 minutes',
  now() - interval '10 minutes',
  'weather-policy-v1',
  repeat('5', 64),
  repeat('6', 64),
  '{}',
  '[]',
  now() - interval '10 minutes',
  repeat('0', 64),
  'scheduling-reconciliation:test:mismatch',
  repeat('8', 64),
  'scheduling-reconciliation-sql-mismatch',
  fixture.actor_user_id
from scheduling_reconciliation_fixture fixture;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  claim_value jsonb;
begin
  claim_value := public.claim_storyops_scheduling_reconciliation(
    '10000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000103',
    90
  );
  if claim_value is not null then
    raise exception 'Mismatched provider identity received a lease: %', claim_value;
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);

do $$
begin
  if (
    select status
    from public.scheduling_reconciliation_cases
    where receipt_id = '92000000-0000-4000-8000-000000000002'
  ) <> 'manual_required' then
    raise exception 'Mismatched provider identity was not quarantined';
  end if;
end;
$$;

\echo '7/7 consumed receipt closes as no-action and is never claimable'
insert into public.scheduling_evidence_receipts(
  id,
  company_id,
  job_id,
  job_version,
  property_id,
  crew_id,
  crew_version,
  starts_at,
  ends_at,
  evidence_mode,
  configuration_revision,
  capacity_provider,
  capacity_reference,
  capacity_disposition,
  capacity_observed_at,
  capacity_expires_at,
  capacity_payload,
  capacity_payload_hash,
  calendar_event_id,
  calendar_event_status,
  calendar_event_etag,
  calendar_reconciled_at,
  calendar_payload_hash,
  operating_baseline_publication_id,
  operating_baseline_hash,
  route_check_id,
  route_disposition,
  route_observed_at,
  route_expires_at,
  route_request_hash,
  route_response_hash,
  weather_check_id,
  weather_disposition,
  weather_observed_at,
  weather_expires_at,
  weather_policy_version,
  weather_policy_hash,
  weather_payload_hash,
  unknowns,
  conflicts,
  expires_at,
  evidence_hash,
  idempotency_key,
  request_hash,
  trace_id,
  created_by
)
select
  '92000000-0000-4000-8000-000000000003',
  fixture.company_id,
  fixture.job_id,
  fixture.job_version,
  fixture.property_id,
  fixture.crew_id,
  fixture.crew_version,
  now() + interval '5 days',
  now() + interval '5 days 254 minutes',
  'live',
  fixture.configuration_revision,
  'google_calendar',
  'operations@example.test',
  'eligible',
  now(),
  now() + interval '10 minutes',
  '{"schemaVersion":"storyops-capacity-evidence-v1"}',
  repeat('1', 64),
  private.storyops_calendar_event_id(
    'scheduling-reconciliation:test:consumed:calendar'
  ),
  'confirmed',
  '"calendar-etag-v3"',
  now(),
  repeat('2', 64),
  fixture.baseline_id,
  fixture.baseline_hash,
  fixture.route_check_id,
  'eligible',
  now(),
  now() + interval '10 minutes',
  repeat('3', 64),
  repeat('4', 64),
  fixture.weather_check_id,
  'eligible',
  now(),
  now() + interval '10 minutes',
  'weather-policy-v1',
  repeat('5', 64),
  repeat('6', 64),
  '{}',
  '[]',
  now() + interval '10 minutes',
  repeat('0', 64),
  'scheduling-reconciliation:test:consumed',
  repeat('9', 64),
  'scheduling-reconciliation-sql-consumed',
  fixture.actor_user_id
from scheduling_reconciliation_fixture fixture;

insert into public.scheduling_evidence_consumptions(
  company_id,
  evidence_receipt_id,
  visit_id,
  idempotency_key,
  consumed_by
)
select
  fixture.company_id,
  '92000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000641',
  'scheduling-reconciliation-consumed-test',
  fixture.actor_user_id
from scheduling_reconciliation_fixture fixture;

do $$
begin
  if (
    select status
    from public.scheduling_reconciliation_cases
    where receipt_id = '92000000-0000-4000-8000-000000000003'
  ) <> 'no_action' then
    raise exception 'Consumed scheduling receipt did not close cleanup state';
  end if;
end;
$$;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  claim_value jsonb;
begin
  claim_value := public.claim_storyops_scheduling_reconciliation(
    '10000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000104',
    90
  );
  if claim_value is not null then
    raise exception 'Consumed scheduling receipt became claimable: %', claim_value;
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);

\echo '8/12 pre-provider outbox survives an accepted-or-unknown provider call'
create temporary table scheduling_reconciliation_outbox_fixture (
  label text primary key,
  idempotency_key text not null,
  envelope jsonb not null,
  request_hash text not null,
  attempt jsonb,
  claim jsonb
) on commit drop;

insert into scheduling_reconciliation_outbox_fixture(
  label,
  idempotency_key,
  envelope,
  request_hash
)
select
  source.label,
  source.idempotency_key,
  payload.envelope,
  public.storyops_json_sha256(jsonb_build_object(
    'actorUserId', fixture.actor_user_id,
    'companyId', fixture.company_id,
    'schedulingIdempotencyKey', source.idempotency_key,
    'attempt', payload.envelope
  ))
from scheduling_reconciliation_fixture fixture
cross join (
  values
    ('unknown', 'scheduling-reconciliation:outbox:unknown'),
    ('duplicate', 'scheduling-reconciliation:outbox:duplicate'),
    ('confirmed', 'scheduling-reconciliation:outbox:confirmed'),
    ('linked', 'scheduling-reconciliation:outbox:linked')
) source(label, idempotency_key)
cross join lateral (
  select jsonb_build_object(
    'schemaVersion', 'storyops-calendar-booking-attempt-input-v1',
    'jobId', fixture.job_id,
    'jobVersion', fixture.job_version,
    'propertyId', fixture.property_id,
    'crewId', fixture.crew_id,
    'calendarId', 'operations@example.test',
    'eventId', private.storyops_calendar_event_id(
      source.idempotency_key || ':calendar'
    ),
    'providerIdempotencyKey', source.idempotency_key || ':calendar',
    'startsAt', now() + interval '6 days',
    'endsAt', now() + interval '6 days 254 minutes',
    'traceId', 'scheduling-reconciliation-' || source.label
  ) envelope
) payload;

grant select, update on scheduling_reconciliation_outbox_fixture
  to service_role;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  fixture scheduling_reconciliation_fixture%rowtype;
  outbox scheduling_reconciliation_outbox_fixture%rowtype;
  prepared jsonb;
  begun jsonb;
begin
  select * into fixture from scheduling_reconciliation_fixture;
  select * into outbox
  from scheduling_reconciliation_outbox_fixture
  where label = 'unknown';
  prepared := public.prepare_storyops_calendar_booking_attempt(
    fixture.company_id,
    fixture.actor_user_id,
    outbox.idempotency_key,
    outbox.request_hash,
    outbox.envelope
  );
  if prepared ->> 'status' <> 'prepared'
    or prepared ? 'receiptId'
  then
    raise exception 'Pre-provider attempt was not durably prepared: %', prepared;
  end if;
  begun := public.begin_storyops_calendar_booking_provider_call(
    (prepared ->> 'attemptId')::uuid
  );
  if begun ->> 'status' <> 'provider_unknown'
    or begun ? 'receiptId'
  then
    raise exception 'Provider call was not fenced as unknown before POST: %', begun;
  end if;
  update scheduling_reconciliation_outbox_fixture
  set attempt = begun
  where label = 'unknown';
end;
$$;

\echo '9/12 different-key concurrent prepare is fenced to one active job attempt'
do $$
declare
  fixture scheduling_reconciliation_fixture%rowtype;
  outbox scheduling_reconciliation_outbox_fixture%rowtype;
  blocked boolean := false;
begin
  select * into fixture from scheduling_reconciliation_fixture;
  select * into outbox
  from scheduling_reconciliation_outbox_fixture
  where label = 'duplicate';
  begin
    perform public.prepare_storyops_calendar_booking_attempt(
      fixture.company_id,
      fixture.actor_user_id,
      outbox.idempotency_key,
      outbox.request_hash,
      outbox.envelope
    );
  exception
    when others then
      if position(
        'CALENDAR_BOOKING_ATTEMPT_ACTIVE_ATTEMPT_EXISTS' in sqlerrm
      ) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Different key created a second active provider attempt';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);

update public.scheduling_reconciliation_cases reconciliation
set next_attempt_at = now()
from scheduling_reconciliation_outbox_fixture outbox
where outbox.label = 'unknown'
  and reconciliation.calendar_attempt_id =
    (outbox.attempt ->> 'attemptId')::uuid;
update public.scheduling_calendar_booking_attempts attempt
set reconcile_after = now()
from scheduling_reconciliation_outbox_fixture outbox
where outbox.label = 'unknown'
  and attempt.id = (outbox.attempt ->> 'attemptId')::uuid;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  outbox scheduling_reconciliation_outbox_fixture%rowtype;
  claim_value jsonb;
  outcome jsonb;
begin
  select * into outbox
  from scheduling_reconciliation_outbox_fixture
  where label = 'unknown';
  claim_value := public.claim_storyops_scheduling_reconciliation(
    '10000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000105',
    90
  );
  if claim_value is null
    or claim_value ->> 'operation' <> 'reconcile'
    or claim_value ? 'receiptId'
    or claim_value ? 'eventEtag'
    or claim_value ->> 'eventId' <> outbox.envelope ->> 'eventId'
  then
    raise exception 'Receipt-less provider-unknown attempt was not claimable: %',
      claim_value;
  end if;
  outcome := public.complete_storyops_scheduling_reconciliation(
    (claim_value ->> 'caseId')::uuid,
    (claim_value ->> 'claimToken')::uuid
  );
  if outcome ->> 'status' <> 'cancelled' then
    raise exception 'Authoritative absent read-back did not close outbox: %', outcome;
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);

\echo '10/12 confirmed provider state remains durable when receipt persistence is ambiguous'
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  fixture scheduling_reconciliation_fixture%rowtype;
  outbox scheduling_reconciliation_outbox_fixture%rowtype;
  prepared jsonb;
  confirmed jsonb;
begin
  select * into fixture from scheduling_reconciliation_fixture;
  select * into outbox
  from scheduling_reconciliation_outbox_fixture
  where label = 'confirmed';
  prepared := public.prepare_storyops_calendar_booking_attempt(
    fixture.company_id,
    fixture.actor_user_id,
    outbox.idempotency_key,
    outbox.request_hash,
    outbox.envelope
  );
  perform public.begin_storyops_calendar_booking_provider_call(
    (prepared ->> 'attemptId')::uuid
  );
  confirmed := public.confirm_storyops_calendar_booking_attempt(
    (prepared ->> 'attemptId')::uuid,
    outbox.envelope ->> 'eventId',
    '"confirmed-outbox-etag"'
  );
  if confirmed ->> 'status' <> 'confirmed'
    or confirmed ? 'receiptId'
  then
    raise exception 'Confirmed orphan attempt lost its durable identity: %',
      confirmed;
  end if;
  update scheduling_reconciliation_outbox_fixture
  set attempt = confirmed
  where label = 'confirmed';
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);

update public.scheduling_reconciliation_cases reconciliation
set next_attempt_at = now()
from scheduling_reconciliation_outbox_fixture outbox
where outbox.label = 'confirmed'
  and reconciliation.calendar_attempt_id =
    (outbox.attempt ->> 'attemptId')::uuid;
update public.scheduling_calendar_booking_attempts attempt
set reconcile_after = now()
from scheduling_reconciliation_outbox_fixture outbox
where outbox.label = 'confirmed'
  and attempt.id = (outbox.attempt ->> 'attemptId')::uuid;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  claim_value jsonb;
  outcome jsonb;
begin
  claim_value := public.claim_storyops_scheduling_reconciliation(
    '10000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000106',
    90
  );
  if claim_value is null
    or claim_value ->> 'operation' <> 'reconcile'
    or claim_value ? 'receiptId'
    or claim_value ->> 'eventEtag' <> '"confirmed-outbox-etag"'
  then
    raise exception 'Confirmed receipt-persistence ambiguity was not reconciled: %',
      claim_value;
  end if;
  outcome := public.complete_storyops_scheduling_reconciliation(
    (claim_value ->> 'caseId')::uuid,
    (claim_value ->> 'claimToken')::uuid
  );
  if outcome ->> 'status' <> 'cancelled' then
    raise exception 'Confirmed orphan cleanup did not complete: %', outcome;
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);

\echo '11/12 booking and cleanup share one fence; defensive completion fails closed'
create temporary table scheduling_reconciliation_race_fixture (
  receipt_id uuid primary key,
  visit_id uuid not null,
  claim jsonb
) on commit drop;

insert into public.scheduling_evidence_receipts
select (
  jsonb_populate_record(
    null::public.scheduling_evidence_receipts,
    to_jsonb(source) || jsonb_build_object(
      'id', '92000000-0000-4000-8000-000000000004',
      'capacity_observed_at', now() - interval '20 minutes',
      'capacity_expires_at', now() - interval '10 minutes',
      'calendar_event_id', private.storyops_calendar_event_id(
        'scheduling-reconciliation:test:race:calendar'
      ),
      'calendar_event_etag', '"calendar-etag-race"',
      'calendar_reconciled_at', now() - interval '20 minutes',
      'route_observed_at', now() - interval '20 minutes',
      'route_expires_at', now() - interval '10 minutes',
      'weather_observed_at', now() - interval '20 minutes',
      'weather_expires_at', now() - interval '10 minutes',
      'expires_at', now() - interval '10 minutes',
      'idempotency_key', 'scheduling-reconciliation:test:race',
      'request_hash', repeat('a', 64),
      'trace_id', 'scheduling-reconciliation-race',
      'created_at', now()
    )
  )
).*
from public.scheduling_evidence_receipts source
where source.id = '92000000-0000-4000-8000-000000000001';

insert into public.visits(
  id,
  company_id,
  job_id,
  sequence,
  status,
  starts_at,
  ends_at,
  crew_id,
  checklist_template_id
)
select
  '92000000-0000-4000-8000-000000000049',
  fixture.company_id,
  fixture.job_id,
  2,
  'planned',
  now() + interval '12 days',
  now() + interval '12 days 1 hour',
  fixture.crew_id,
  '10000000-0000-4000-8000-000000000301'
from scheduling_reconciliation_fixture fixture;

insert into scheduling_reconciliation_race_fixture(receipt_id, visit_id)
values (
  '92000000-0000-4000-8000-000000000004',
  '92000000-0000-4000-8000-000000000049'
);
grant select, update on scheduling_reconciliation_race_fixture to service_role;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  claim_value jsonb;
begin
  claim_value := public.claim_storyops_scheduling_reconciliation(
    '10000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000107',
    90
  );
  if claim_value is null or claim_value ->> 'operation' <> 'cancel' then
    raise exception 'Expired race receipt did not receive a cancellation lease: %',
      claim_value;
  end if;
  update scheduling_reconciliation_race_fixture
  set claim = claim_value;
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);

do $$
declare
  blocked boolean := false;
  race scheduling_reconciliation_race_fixture%rowtype;
  fixture scheduling_reconciliation_fixture%rowtype;
begin
  select * into race from scheduling_reconciliation_race_fixture;
  select * into fixture from scheduling_reconciliation_fixture;
  begin
    insert into public.scheduling_evidence_consumptions(
      company_id,
      evidence_receipt_id,
      visit_id,
      idempotency_key,
      consumed_by
    )
    values (
      fixture.company_id,
      race.receipt_id,
      race.visit_id,
      'scheduling-reconciliation-race-fenced',
      fixture.actor_user_id
    );
  exception
    when others then
      if position(
        'SCHEDULING_RECONCILIATION_BOOKING_FENCED' in sqlerrm
      ) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Booking consumption bypassed an active cleanup lease';
  end if;
end;
$$;

alter table public.scheduling_evidence_consumptions
  disable trigger scheduling_evidence_consumption_reconciliation_fence;
insert into public.scheduling_evidence_consumptions(
  company_id,
  evidence_receipt_id,
  visit_id,
  idempotency_key,
  consumed_by
)
select
  fixture.company_id,
  race.receipt_id,
  race.visit_id,
  'scheduling-reconciliation-race-corruption',
  fixture.actor_user_id
from scheduling_reconciliation_race_fixture race
cross join scheduling_reconciliation_fixture fixture;
alter table public.scheduling_evidence_consumptions
  enable trigger scheduling_evidence_consumption_reconciliation_fence;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  race scheduling_reconciliation_race_fixture%rowtype;
  outcome jsonb;
begin
  select * into race from scheduling_reconciliation_race_fixture;
  outcome := public.complete_storyops_scheduling_reconciliation(
    (race.claim ->> 'caseId')::uuid,
    (race.claim ->> 'claimToken')::uuid
  );
  if outcome ->> 'status' <> 'manual_required'
    or outcome ->> 'errorCode' <> 'CONSUMPTION_RACE_DETECTED'
    or outcome ->> 'calendarCancellationConfirmed' <> 'false'
  then
    raise exception 'Defensive completion falsely claimed cancellation: %', outcome;
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);

\echo '12/12 exact receipt commit transactionally links and postpones cleanup'
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  fixture scheduling_reconciliation_fixture%rowtype;
  outbox scheduling_reconciliation_outbox_fixture%rowtype;
  prepared jsonb;
  confirmed jsonb;
begin
  select * into fixture from scheduling_reconciliation_fixture;
  select * into outbox
  from scheduling_reconciliation_outbox_fixture
  where label = 'linked';
  prepared := public.prepare_storyops_calendar_booking_attempt(
    fixture.company_id,
    fixture.actor_user_id,
    outbox.idempotency_key,
    outbox.request_hash,
    outbox.envelope
  );
  perform public.begin_storyops_calendar_booking_provider_call(
    (prepared ->> 'attemptId')::uuid
  );
  confirmed := public.confirm_storyops_calendar_booking_attempt(
    (prepared ->> 'attemptId')::uuid,
    outbox.envelope ->> 'eventId',
    '"linked-outbox-etag"'
  );
  update scheduling_reconciliation_outbox_fixture
  set attempt = confirmed
  where label = 'linked';
end;
$$;
reset role;
select set_config('request.jwt.claim.role', '', true);

insert into public.scheduling_evidence_receipts
select (
  jsonb_populate_record(
    null::public.scheduling_evidence_receipts,
    to_jsonb(source) || jsonb_build_object(
      'id', '92000000-0000-4000-8000-000000000005',
      'starts_at', (outbox.envelope ->> 'startsAt')::timestamptz,
      'ends_at', (outbox.envelope ->> 'endsAt')::timestamptz,
      'capacity_reference', outbox.envelope ->> 'calendarId',
      'capacity_observed_at', now(),
      'capacity_expires_at', now() + interval '10 minutes',
      'calendar_event_id', outbox.envelope ->> 'eventId',
      'calendar_event_etag', '"linked-outbox-etag"',
      'calendar_reconciled_at', now(),
      'route_observed_at', now(),
      'route_expires_at', now() + interval '10 minutes',
      'weather_observed_at', now(),
      'weather_expires_at', now() + interval '10 minutes',
      'expires_at', now() + interval '10 minutes',
      'idempotency_key', outbox.idempotency_key,
      'request_hash', repeat('b', 64),
      'trace_id', 'scheduling-reconciliation-linked',
      'created_at', now()
    )
  )
).*
from public.scheduling_evidence_receipts source
cross join scheduling_reconciliation_outbox_fixture outbox
where source.id = '92000000-0000-4000-8000-000000000001'
  and outbox.label = 'linked';

do $$
begin
  if (
    select count(*)
    from public.scheduling_calendar_booking_attempts attempt
    join public.scheduling_reconciliation_cases reconciliation
      on reconciliation.calendar_attempt_id = attempt.id
    where attempt.receipt_id =
        '92000000-0000-4000-8000-000000000005'
      and attempt.status = 'receipt_linked'
      and reconciliation.receipt_id = attempt.receipt_id
      and reconciliation.status = 'pending'
      and reconciliation.next_attempt_at > now()
  ) <> 1 then
    raise exception 'Receipt did not atomically link and postpone its cleanup';
  end if;
end;
$$;

rollback;

\echo 'scheduling reconciliation: pass'
