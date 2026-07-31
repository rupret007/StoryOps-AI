\set ON_ERROR_STOP on

begin;

create temporary table scheduling_evidence_fixture (
  company_id uuid not null,
  actor_user_id uuid not null,
  job_id uuid not null,
  job_version integer not null,
  property_id uuid not null,
  crew_id uuid not null,
  crew_version integer not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  sandbox_evidence jsonb,
  sandbox_changed_evidence jsonb,
  sandbox_request_hash text,
  sandbox_changed_request_hash text,
  sandbox_receipt jsonb,
  live_evidence jsonb,
  live_changed_evidence jsonb,
  live_request_hash text,
  live_changed_request_hash text,
  live_offboarded_request_hash text,
  live_rerolled_request_hash text,
  live_secondary_request_hash text,
  live_receipt jsonb,
  booking_payload jsonb,
  booking_request_hash text,
  changed_booking_payload jsonb,
  changed_booking_request_hash text
) on commit drop;

insert into scheduling_evidence_fixture(
  company_id, actor_user_id, job_id, job_version, property_id, crew_id,
  crew_version, starts_at, ends_at
)
select
  job.company_id,
  '10000000-0000-4000-8000-000000000102',
  job.id,
  job.version,
  job.property_id,
  '10000000-0000-4000-8000-000000000601',
  crew.version,
  date_trunc('day', now() + interval '5 days') + interval '9 hours',
  date_trunc('day', now() + interval '5 days') + interval '9 hours'
    + make_interval(mins => estimate.duration_minutes)
from public.jobs job
join public.quotes quote on quote.id = job.quote_id
join public.estimates estimate on estimate.id = quote.estimate_id
join public.crews crew
  on crew.id = '10000000-0000-4000-8000-000000000601'
where job.id = '10000000-0000-4000-8000-000000000631'
  and job.status = 'ready_to_schedule';

do $$
begin
  if (select count(*) from scheduling_evidence_fixture) <> 1 then
    raise exception 'Scheduling fixture requires the seeded ready-to-schedule job';
  end if;
end;
$$;

-- Live scheduling must use the real reviewed-geocode boundary. This is an
-- explicit transaction-only provider fixture, never seed or production proof.
do $$
declare
  fixture scheduling_evidence_fixture%rowtype;
  operation_id_value constant uuid :=
    '91600000-0000-4000-8000-000000000090';
  candidate_id_value constant uuid :=
    '91600000-0000-4000-8000-000000000091';
  command_id_value constant uuid :=
    '91600000-0000-4000-8000-000000000092';
  property_version_value integer;
  address_hash_value text;
  lookup_hash_value text;
begin
  select * into fixture from scheduling_evidence_fixture;
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
      'providerPlaceId', 'scheduling-boundary-reviewed-property',
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
    raise exception 'Scheduling fixture did not establish reviewed geocode proof';
  end if;
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
end;
$$;

grant select, update on scheduling_evidence_fixture
  to authenticated, service_role;

\echo '1/10 authenticated clients cannot write scheduling state or record trusted evidence'
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
  job_update_blocked boolean := false;
  recorder_blocked boolean := false;
begin
  if has_table_privilege(
    current_user,
    'public.scheduling_evidence_receipts',
    'INSERT,UPDATE,DELETE'
  ) then
    raise exception 'Authenticated retained scheduling receipt DML';
  end if;
  if has_table_privilege(current_user, 'public.jobs', 'INSERT,UPDATE,DELETE')
    or has_table_privilege(current_user, 'public.visits', 'INSERT,UPDATE,DELETE')
    or has_table_privilege(
      current_user,
      'public.dispatch_assignments',
      'INSERT,UPDATE,DELETE'
    )
    or has_table_privilege(
      current_user,
      'public.route_checks',
      'INSERT,UPDATE,DELETE'
    )
    or has_table_privilege(
      current_user,
      'public.weather_checks',
      'INSERT,UPDATE,DELETE'
    )
  then
    raise exception 'Authenticated retained direct scheduling-state DML';
  end if;
  if has_function_privilege(
    current_user,
    'public.record_storyops_scheduling_evidence(uuid,uuid,text,text,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Authenticated retained trusted evidence recorder execution';
  end if;

  begin
    insert into public.scheduling_evidence_receipts default values;
  exception
    when insufficient_privilege then receipt_insert_blocked := true;
  end;
  begin
    update public.jobs
    set priority = priority
    where id = '10000000-0000-4000-8000-000000000631';
  exception
    when insufficient_privilege then job_update_blocked := true;
  end;
  begin
    perform public.record_storyops_scheduling_evidence(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000102',
      'forbidden-evidence-call',
      repeat('0', 64),
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then recorder_blocked := true;
  end;

  if not receipt_insert_blocked
    or not job_update_blocked
    or not recorder_blocked
  then
    raise exception 'Authenticated direct scheduling mutation boundary failed';
  end if;
end;
$$;

\echo '2/10 generic visit commands cannot promote planned or weather-held work'
do $$
declare
  result jsonb;
  blocked boolean := false;
begin
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '91600000-0000-4000-8000-000000000001',
      'visit.transition',
      1,
      jsonb_build_object(
        'entityId', '10000000-0000-4000-8000-000000000641',
        'status', 'confirmed'
      ),
      repeat('1', 64)
    );
  exception
    when others then
      if position('SCHEDULING_PROMOTION_EVIDENCE_REQUIRED' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Generic planned-to-confirmed transition succeeded';
  end if;

  result := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '91600000-0000-4000-8000-000000000002',
    'visit.transition',
    1,
    jsonb_build_object(
      'entityId', '10000000-0000-4000-8000-000000000641',
      'status', 'weather_hold'
    ),
    repeat('2', 64)
  );
  if result ->> 'status' <> 'applied' then
    raise exception 'Non-promoting weather hold unexpectedly failed: %', result;
  end if;

  blocked := false;
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '91600000-0000-4000-8000-000000000003',
      'visit.transition',
      (result ->> 'version')::integer,
      jsonb_build_object(
        'entityId', '10000000-0000-4000-8000-000000000641',
        'status', 'confirmed'
      ),
      repeat('3', 64)
    );
  exception
    when others then
      if position('SCHEDULING_PROMOTION_EVIDENCE_REQUIRED' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Generic weather-hold-to-confirmed transition succeeded';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);

-- The seeded planned visit is useful for the promotion checks above, but the
-- finite booking command owns sequence 1 and must create it itself.
delete from public.dispatch_assignments
where visit_id = '10000000-0000-4000-8000-000000000641';
delete from public.visit_checklist_items
where visit_id = '10000000-0000-4000-8000-000000000641';
delete from public.visits
where id = '10000000-0000-4000-8000-000000000641';

create or replace function pg_temp.build_scheduling_evidence(
  p_mode text,
  p_configuration_revision integer,
  p_baseline_id uuid,
  p_trace_id text
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'schemaVersion', 'storyops-scheduling-evidence-input-v1',
    'evidenceMode', p_mode,
    'jobId', fixture.job_id,
    'jobVersion', fixture.job_version,
    'propertyId', fixture.property_id,
    'crewId', fixture.crew_id,
    'crewVersion', fixture.crew_version,
    'startsAt', fixture.starts_at,
    'endsAt', fixture.ends_at,
    'configurationRevision', p_configuration_revision,
    'operatingBaselinePublicationId', p_baseline_id,
    'capacity', jsonb_build_object(
      'provider', case
        when p_mode = 'live' then 'google_calendar'
        else 'mock'
      end,
      'reference', case
        when p_mode = 'live' then 'operations@test.invalid'
        else 'sandbox-calendar'
      end,
      'disposition', 'eligible',
      'observedAt', now(),
      'expiresAt', now() + interval '10 minutes',
      'calendarEventId', case
        when p_mode = 'live' then private.storyops_calendar_event_id(
          'scheduling-boundary-live:calendar'
        )
        else 'calendar-event-sandbox-boundary'
      end,
      'calendarEventStatus', 'confirmed',
      'calendarEventEtag', 'etag-' || p_mode || '-boundary',
      'calendarReconciledAt', now(),
      'payload', jsonb_build_object(
        'schemaVersion', 'storyops-capacity-evidence-v1',
        'companyId', fixture.company_id,
        'jobId', fixture.job_id,
        'propertyId', fixture.property_id,
        'crewId', fixture.crew_id,
        'startsAt', fixture.starts_at,
        'endsAt', fixture.ends_at,
        'mode', p_mode,
        'capacity', jsonb_build_object(
          'disposition', 'eligible',
          'eligibleCrewIds', jsonb_build_array(fixture.crew_id),
          'requiredSkillCodes', jsonb_build_array(),
          'requiredEquipmentTypes', jsonb_build_array(),
          'unknowns', jsonb_build_array(),
          'conflicts', jsonb_build_array()
        ),
        'freeBusy', jsonb_build_object(
          'disposition', 'eligible',
          'sourceCalendarIds', jsonb_build_array(
            case
              when p_mode = 'live' then 'operations@test.invalid'
              else 'sandbox-calendar'
            end
          ),
          'busyWindows', jsonb_build_array(),
          'unknowns', jsonb_build_array(),
          'conflicts', jsonb_build_array()
        ),
        'busy', false,
        'readBackConfirmed', true,
        'eventId', case
          when p_mode = 'live' then private.storyops_calendar_event_id(
            'scheduling-boundary-live:calendar'
          )
          else 'calendar-event-sandbox-boundary'
        end,
        'eventStatus', 'confirmed',
        'eventEtag', 'etag-' || p_mode || '-boundary'
      ),
      'calendarPayload', jsonb_build_object(
        'id', case
          when p_mode = 'live' then private.storyops_calendar_event_id(
            'scheduling-boundary-live:calendar'
          )
          else 'calendar-event-sandbox-boundary'
        end,
        'status', 'confirmed',
        'etag', 'etag-' || p_mode || '-boundary'
      )
    ),
    'route', jsonb_build_object(
      'provider', case when p_mode = 'live' then 'vroom' else 'mock' end,
      'disposition', 'eligible',
      'observedAt', now(),
      'expiresAt', now() + interval '20 minutes',
      'routeFeasible', true,
      'driveMinutes', 18,
      'addedDistanceMiles', 6.2,
      'violations', jsonb_build_array(),
      'requestPayload', jsonb_build_object(
        'schemaVersion', 'storyops-route-context-v1',
        'jobId', fixture.job_id,
        'targetRoutingJobId', 'candidate:' || fixture.job_id::text,
        'propertyId', fixture.property_id,
        'propertyVersion', (
          select property.version
          from public.properties property
          where property.id = fixture.property_id
        ),
        'crewId', fixture.crew_id,
        'startsAt', fixture.starts_at,
        'endsAt', fixture.ends_at,
        'origin', jsonb_build_object(
          'latitude', 32.7767,
          'longitude', -96.7970
        ),
        'destination', (
          select jsonb_build_object(
            'latitude', property.latitude,
            'longitude', property.longitude
          )
          from public.properties property
          where property.id = fixture.property_id
        ),
        'operatingWindow', jsonb_build_object(
          'start', date_trunc('day', fixture.starts_at) + interval '7 hours',
          'end', date_trunc('day', fixture.starts_at) + interval '19 hours'
        ),
        'committedVisits', jsonb_build_array(),
        'requiredSkills', jsonb_build_array(),
        'requiredEquipment', jsonb_build_array()
      ),
      'responsePayload', jsonb_build_object(
        'provider', case when p_mode = 'live' then 'vroom' else 'mock' end,
        'vehicleId', fixture.crew_id,
        'jobIds', jsonb_build_array('candidate:' || fixture.job_id::text),
        'travelSeconds', 1080,
        'serviceSeconds', extract(
          epoch from (fixture.ends_at - fixture.starts_at)
        )::integer,
        'distanceMeters', 9978,
        'summary', jsonb_build_object(
          'travelSeconds', 1080,
          'serviceSeconds', extract(
            epoch from (fixture.ends_at - fixture.starts_at)
          )::integer,
          'distanceMeters', 9978
        ),
        'unassignedJobIds', jsonb_build_array(),
        'baseline', jsonb_build_object(
          'vehicleId', fixture.crew_id,
          'jobIds', jsonb_build_array(),
          'travelSeconds', 0,
          'serviceSeconds', 0,
          'distanceMeters', 0,
          'unassignedJobIds', jsonb_build_array()
        ),
        'incremental', jsonb_build_object(
          'travelSeconds', 1080,
          'distanceMeters', 9978
        )
      )
    ),
    'weather', jsonb_build_object(
      'provider', case when p_mode = 'live' then 'nws' else 'mock' end,
      'disposition', 'eligible',
      'observedAt', now(),
      'expiresAt', now() + interval '40 minutes',
      'forecastIssuedAt', now() - interval '5 minutes',
      'periodStartsAt', fixture.starts_at - interval '1 hour',
      'periodEndsAt', fixture.ends_at + interval '1 hour',
      'temperatureF', 78,
      'precipitationProbability', 0.1,
      'windSpeedMph', 7,
      'lightningRisk', 'none',
      'conditionCodes', jsonb_build_array('clear'),
      'policyVersion', 'weather-policy-boundary-v1',
      'policy', jsonb_build_object(
        'maxWindMph', 20,
        'maxPrecipitationProbability', 0.5,
        'lightningAllowed', false
      ),
      'payload', jsonb_build_object(
        'mode', p_mode,
        'forecastId', 'forecast-' || p_mode || '-boundary'
      )
    ),
    'unknowns', jsonb_build_array(),
    'conflicts', jsonb_build_array(),
    'traceId', p_trace_id
  )
  from scheduling_evidence_fixture fixture;
$$;

insert into public.company_configuration_versions(
  id, company_id, revision, schema_version, status, publication_mode,
  configuration, configuration_hash, review_reference, created_by,
  published_by, published_at
)
values (
  '91600000-0000-4000-8000-000000000031',
  '10000000-0000-4000-8000-000000000001',
  1,
  'storyops-company-config-v1',
  'published',
  'sandbox',
  jsonb_build_object(
    'schemaVersion', 'storyops-company-config-v1',
    'testFixture', 'scheduling-evidence-boundary-sandbox',
    'territory', jsonb_build_object(
      'travelZones', jsonb_build_array(jsonb_build_object(
        'code', 'DFW-CORE',
        'postalCodes', jsonb_build_array('75001')
      )),
      'travelZoneMappingReview', jsonb_build_object(
        'status', 'approved',
        'reviewer', 'Scheduling test reviewer',
        'reviewedAt', '2026-07-29T00:00:00Z',
        'evidenceReference', 'TEST-SCHEDULING-TRAVEL-ZONE-MAP'
      )
    )
  ),
  repeat('a', 64),
  'TEST-SCHEDULING-SANDBOX-BOUNDARY',
  '10000000-0000-4000-8000-000000000102',
  '10000000-0000-4000-8000-000000000102',
  now()
);

insert into public.company_operating_baseline_publications(
  id, company_id, configuration_version_id, configuration_revision,
  configuration_hash, price_book_id, service_terms_id, retention_policy_id,
  baseline_hash, status, review_reference, activated_by, command_id,
  request_hash
)
values (
  '91600000-0000-4000-8000-000000000032',
  '10000000-0000-4000-8000-000000000001',
  '91600000-0000-4000-8000-000000000031',
  1,
  repeat('a', 64),
  '10000000-0000-4000-8000-000000000401',
  '10000000-0000-4000-8000-000000000152',
  '10000000-0000-4000-8000-000000000151',
  repeat('b', 64),
  'active',
  'TEST-SCHEDULING-SANDBOX-BOUNDARY',
  '10000000-0000-4000-8000-000000000102',
  '91600000-0000-4000-8000-000000000033',
  repeat('c', 64)
);

update scheduling_evidence_fixture
set sandbox_evidence = pg_temp.build_scheduling_evidence(
  'sandbox',
  1,
  '91600000-0000-4000-8000-000000000032',
  'scheduling-boundary-sandbox'
);
update scheduling_evidence_fixture
set
  sandbox_changed_evidence =
    sandbox_evidence || jsonb_build_object(
      'traceId', 'scheduling-boundary-sandbox-changed'
    ),
  sandbox_request_hash = public.storyops_json_sha256(jsonb_build_object(
    'actorUserId', actor_user_id,
    'companyId', company_id,
    'evidence', sandbox_evidence,
    'idempotencyKey', 'scheduling-boundary-sandbox'
  ));
update scheduling_evidence_fixture
set sandbox_changed_request_hash =
  public.storyops_json_sha256(jsonb_build_object(
    'actorUserId', actor_user_id,
    'companyId', company_id,
    'evidence', sandbox_changed_evidence,
    'idempotencyKey', 'scheduling-boundary-sandbox'
  ));

\echo '3/10 service role records sandbox evidence idempotently, but sandbox cannot book'
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);
do $$
declare
  fixture scheduling_evidence_fixture%rowtype;
  first_result jsonb;
  replay_result jsonb;
  conflict_blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  first_result := public.record_storyops_scheduling_evidence(
    fixture.company_id,
    fixture.actor_user_id,
    'scheduling-boundary-sandbox',
    fixture.sandbox_request_hash,
    fixture.sandbox_evidence
  );
  if first_result ->> 'replayed' <> 'false'
    or first_result ->> 'evidenceMode' <> 'sandbox'
  then
    raise exception 'Sandbox evidence receipt was not newly recorded: %', first_result;
  end if;

  replay_result := public.record_storyops_scheduling_evidence(
    fixture.company_id,
    fixture.actor_user_id,
    'scheduling-boundary-sandbox',
    fixture.sandbox_request_hash,
    fixture.sandbox_evidence
  );
  if replay_result ->> 'replayed' <> 'true'
    or replay_result ->> 'receiptId' <> first_result ->> 'receiptId'
    or replay_result ->> 'evidenceHash' <> first_result ->> 'evidenceHash'
  then
    raise exception 'Exact sandbox evidence replay changed identity: %', replay_result;
  end if;

  begin
    perform public.record_storyops_scheduling_evidence(
      fixture.company_id,
      fixture.actor_user_id,
      'scheduling-boundary-sandbox',
      fixture.sandbox_changed_request_hash,
      fixture.sandbox_changed_evidence
    );
  exception
    when others then
      if position('SCHEDULING_EVIDENCE_IDEMPOTENCY_CONFLICT' in sqlerrm) > 0 then
        conflict_blocked := true;
      else
        raise;
      end if;
  end;
  if not conflict_blocked then
    raise exception 'Changed evidence reused an idempotency key';
  end if;

  update scheduling_evidence_fixture
  set sandbox_receipt = first_result;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);

update scheduling_evidence_fixture
set
  booking_payload = jsonb_build_object(
    'entityId', job_id,
    'schedulingEvidenceReceiptId', sandbox_receipt ->> 'receiptId'
  );
update scheduling_evidence_fixture
set booking_request_hash = public.storyops_json_sha256(jsonb_build_object(
  'commandType', 'job.book',
  'expectedVersion', job_version,
  'payload', booking_payload
));

update public.company_operating_baseline_publications
set status = 'retired', retired_at = now()
where id = '91600000-0000-4000-8000-000000000032';
update public.company_configuration_versions
set status = 'retired'
where id = '91600000-0000-4000-8000-000000000031';

insert into public.company_configuration_versions(
  id, company_id, revision, schema_version, status, publication_mode,
  configuration, configuration_hash, review_reference, created_by,
  published_by, published_at
)
values (
  '91600000-0000-4000-8000-000000000041',
  '10000000-0000-4000-8000-000000000001',
  2,
  'storyops-company-config-v1',
  'published',
  'live',
  jsonb_build_object(
    'schemaVersion', 'storyops-company-config-v1',
    'testFixture', 'scheduling-evidence-boundary-live',
    'territory', jsonb_build_object(
      'travelZones', jsonb_build_array(jsonb_build_object(
        'code', 'DFW-CORE',
        'postalCodes', jsonb_build_array('75001')
      )),
      'travelZoneMappingReview', jsonb_build_object(
        'status', 'approved',
        'reviewer', 'Scheduling test reviewer',
        'reviewedAt', '2026-07-29T00:00:00Z',
        'evidenceReference', 'TEST-SCHEDULING-TRAVEL-ZONE-MAP'
      )
    ),
    'pricing', jsonb_build_object(
      'taxReview', jsonb_build_object('status', 'approved')
    ),
    'policies', jsonb_build_object(
      'legalReview', jsonb_build_object('status', 'approved'),
      'privacyReview', jsonb_build_object('status', 'approved'),
      'safetyReview', jsonb_build_object('status', 'approved'),
      'insuranceReview', jsonb_build_object('status', 'approved'),
      'environmentalReview', jsonb_build_object('status', 'approved')
    ),
    'integrations', jsonb_build_object(
      'providers', jsonb_build_array(
        jsonb_build_object('provider', 'email', 'requestedMode', 'live'),
        jsonb_build_object('provider', 'stripe', 'requestedMode', 'live'),
        jsonb_build_object(
          'provider', 'google_calendar', 'requestedMode', 'live'
        ),
        jsonb_build_object('provider', 'maps', 'requestedMode', 'live'),
        jsonb_build_object('provider', 'nws', 'requestedMode', 'live'),
        jsonb_build_object('provider', 'vroom', 'requestedMode', 'live'),
        jsonb_build_object('provider', 'storage', 'requestedMode', 'live')
      )
    )
  ),
  repeat('d', 64),
  'TEST-SCHEDULING-LIVE-BOUNDARY',
  '10000000-0000-4000-8000-000000000102',
  '10000000-0000-4000-8000-000000000102',
  now()
);

insert into public.company_operating_baseline_publications(
  id, company_id, configuration_version_id, configuration_revision,
  configuration_hash, price_book_id, service_terms_id, retention_policy_id,
  baseline_hash, status, review_reference, activated_by, command_id,
  request_hash
)
values (
  '91600000-0000-4000-8000-000000000042',
  '10000000-0000-4000-8000-000000000001',
  '91600000-0000-4000-8000-000000000041',
  2,
  repeat('d', 64),
  '10000000-0000-4000-8000-000000000401',
  '10000000-0000-4000-8000-000000000152',
  '10000000-0000-4000-8000-000000000151',
  repeat('e', 64),
  'active',
  'TEST-SCHEDULING-LIVE-BOUNDARY',
  '10000000-0000-4000-8000-000000000102',
  '91600000-0000-4000-8000-000000000043',
  repeat('f', 64)
);

-- Booking is launch-gated before its scheduling receipt is inspected. Establish
-- the real migration 43/44 provider, verifier-proof, and owner-authorization
-- state so the sandbox assertion below tests evidence mode rather than merely
-- proving that an unrelated launch prerequisite is absent.
do $$
declare
  company_id_value constant uuid :=
    '10000000-0000-4000-8000-000000000001';
  owner_user_id_value constant uuid :=
    '10000000-0000-4000-8000-000000000101';
  technician_user_id_value constant uuid :=
    '10000000-0000-4000-8000-000000000103';
  deployment_fingerprint_value constant text := repeat('9', 64);
  probe_run_id_value uuid := gen_random_uuid();
  provider_record record;
  command_id_value uuid;
  request_hash_value text;
  run_receipt jsonb;
  completion_receipt jsonb;
  field_receipt jsonb;
  field_claim jsonb;
  field_payload jsonb;
  canary_crew_id_value uuid;
  canary_customer_id_value uuid;
  replacement_crew_id_value uuid := gen_random_uuid();
  insert_guard_crew_id_value uuid := gen_random_uuid();
  insert_guard_run_id_value uuid := gen_random_uuid();
  legacy_evidence_id_value uuid := gen_random_uuid();
  legacy_audit_id_value uuid := gen_random_uuid();
  launch_receipt jsonb;
  worker_name text;
  worker_configuration_hash text;
  worker_payload jsonb := '[]'::jsonb;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );
  perform public.record_storyops_integration_environment_probe(
    company_id_value,
    owner_user_id_value,
    probe_run_id_value,
    deployment_fingerprint_value,
    jsonb_build_array(
      jsonb_build_object(
        'provider', 'email',
        'capability', 'email',
        'mode', 'live',
        'status', 'healthy',
        'checkedAt', date_trunc('milliseconds', now()),
        'latencyMs', 5,
        'requiredEnvironment', jsonb_build_array()
      ),
      jsonb_build_object(
        'provider', 'stripe',
        'capability', 'payments',
        'mode', 'live',
        'status', 'healthy',
        'checkedAt', date_trunc('milliseconds', now()),
        'latencyMs', 5,
        'requiredEnvironment', jsonb_build_array()
      ),
      jsonb_build_object(
        'provider', 'google_calendar',
        'capability', 'calendar',
        'mode', 'live',
        'status', 'healthy',
        'checkedAt', date_trunc('milliseconds', now()),
        'latencyMs', 5,
        'requiredEnvironment', jsonb_build_array()
      ),
      jsonb_build_object(
        'provider', 'maps',
        'capability', 'geocoding',
        'mode', 'live',
        'status', 'healthy',
        'checkedAt', date_trunc('milliseconds', now()),
        'latencyMs', 5,
        'requiredEnvironment', jsonb_build_array()
      ),
      jsonb_build_object(
        'provider', 'nws',
        'capability', 'weather',
        'mode', 'live',
        'status', 'healthy',
        'checkedAt', date_trunc('milliseconds', now()),
        'latencyMs', 5,
        'requiredEnvironment', jsonb_build_array()
      ),
      jsonb_build_object(
        'provider', 'vroom',
        'capability', 'routing',
        'mode', 'live',
        'status', 'healthy',
        'checkedAt', date_trunc('milliseconds', now()),
        'latencyMs', 5,
        'requiredEnvironment', jsonb_build_array()
      ),
      jsonb_build_object(
        'provider', 'storage',
        'capability', 'server_signed_targets',
        'mode', 'live',
        'status', 'healthy',
        'checkedAt', date_trunc('milliseconds', now()),
        'latencyMs', 5,
        'requiredEnvironment', jsonb_build_array()
      ),
      jsonb_build_object(
        'provider', 'scheduling_evidence_gate',
        'capability', 'calendar_weather_route_booking_evidence',
        'mode', 'live',
        'status', 'healthy',
        'checkedAt', date_trunc('milliseconds', now()),
        'latencyMs', 1,
        'requiredEnvironment', jsonb_build_array()
      )
    )
  );

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claim.sub',
    owner_user_id_value::text,
    true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', owner_user_id_value,
      'role', 'authenticated'
    )::text,
    true
  );
  for provider_record in
    select connection.provider, connection.version
    from public.integration_connections connection
    where connection.company_id = company_id_value
      and connection.provider in (
        'email', 'stripe', 'google_calendar', 'maps', 'nws', 'vroom',
        'signed_storage_targets'
      )
    order by connection.provider
  loop
    command_id_value := gen_random_uuid();
    request_hash_value := encode(extensions.digest(array_to_string(array[
      'storyops-provider-activation-v1',
      provider_record.provider,
      provider_record.version::text,
      'live'
    ], chr(31)), 'sha256'), 'hex');
    perform public.set_storyops_provider_activation(
      company_id_value,
      command_id_value,
      provider_record.provider,
      provider_record.version,
      'live',
      request_hash_value
    );
  end loop;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );
  for provider_record in
    select
      connection.provider,
      capability,
      case
        when connection.provider = 'email' then 'email.health.retrieve'
        when connection.provider = 'stripe' then 'stripe.balance.retrieve'
        when connection.provider = 'google_calendar'
          then 'google_calendar.list.retrieve'
        when connection.provider = 'maps'
          then 'google_maps.geocode.retrieve'
        when connection.provider = 'nws' then 'nws.points.retrieve'
        when connection.provider = 'vroom' then 'vroom.health.retrieve'
        when connection.provider = 'signed_storage_targets'
          then 'supabase_storage.bucket.retrieve'
      end as operation
    from public.integration_connections connection
    cross join lateral unnest(connection.capabilities) capability
    where connection.company_id = company_id_value
      and connection.owner_enabled
      and connection.mode = 'live'
    order by connection.provider, capability
  loop
    command_id_value := gen_random_uuid();
    request_hash_value := public.storyops_json_sha256(jsonb_build_object(
      'kind', 'provider_canary',
      'provider', provider_record.provider,
      'capability', provider_record.capability,
      'commandId', command_id_value
    ));
    run_receipt := public.reserve_storyops_trusted_pilot_verification(
      company_id_value,
      owner_user_id_value,
      command_id_value,
      'provider_canary',
      provider_record.provider,
      provider_record.capability,
      request_hash_value
    );
    if run_receipt ->> 'execute' <> 'true' then
      raise exception 'Provider verifier run was not executable: %', run_receipt;
    end if;
    completion_receipt :=
      public.complete_storyops_provider_canary_verification(
        (run_receipt ->> 'runId')::uuid,
        jsonb_build_object(
          'schemaVersion', 'storyops-integration-probe-evidence-v1',
          'basis', 'external_read',
          'operation', provider_record.operation,
          'responseDigest', encode(extensions.digest(
            provider_record.provider || chr(31) ||
              provider_record.capability,
            'sha256'
          ), 'hex')
        ),
        deployment_fingerprint_value
      );
    if completion_receipt ->> 'status' <> 'verified' then
      raise exception 'Provider verifier run did not verify: %',
        completion_receipt;
    end if;
    perform public.record_storyops_trusted_pilot_proof(
      (run_receipt ->> 'runId')::uuid
    );
  end loop;

  command_id_value := gen_random_uuid();
  run_receipt := public.reserve_storyops_trusted_pilot_verification(
    company_id_value,
    owner_user_id_value,
    command_id_value,
    'backup_restore',
    null,
    'isolated_database_restore',
    public.storyops_json_sha256(jsonb_build_object(
      'kind', 'backup_restore',
      'commandId', command_id_value
    ))
  );
  if run_receipt ->> 'execute' <> 'true' then
    raise exception 'Restore verifier run was not executable: %', run_receipt;
  end if;
  completion_receipt := public.complete_storyops_restore_verification(
    (run_receipt ->> 'runId')::uuid,
    repeat('b', 64)
  );
  if completion_receipt ->> 'status' <> 'verified' then
    raise exception 'Restore verifier run did not verify: %',
      completion_receipt;
  end if;
  perform public.record_storyops_trusted_pilot_proof(
    (run_receipt ->> 'runId')::uuid
  );

  command_id_value := gen_random_uuid();
  field_receipt := public.reserve_storyops_field_media_verification(
    company_id_value,
    owner_user_id_value,
    command_id_value,
    technician_user_id_value,
    public.storyops_json_sha256(jsonb_build_object(
      'kind', 'field_media_canary',
      'commandId', command_id_value,
      'fieldWorkerUserId', technician_user_id_value
    ))
  );
  if field_receipt ->> 'status' <> 'awaiting_field_worker' then
    raise exception 'Field-media verifier was not reserved: %', field_receipt;
  end if;
  field_claim := public.claim_storyops_field_media_verification(
    company_id_value,
    technician_user_id_value,
    (field_receipt ->> 'runId')::uuid,
    gen_random_uuid(),
    public.storyops_json_sha256(jsonb_build_object(
      'runId', field_receipt ->> 'runId',
      'action', 'claim'
    ))
  );
  if field_claim ->> 'execute' <> 'true'
    or field_claim ->> 'status' <> 'executing'
  then
    raise exception 'Field-media verifier was not claimed: %', field_claim;
  end if;
  select registry.crew_id, registry.customer_id
  into canary_crew_id_value, canary_customer_id_value
  from private.storyops_field_media_canary_crews registry
  where registry.verification_run_id = (field_receipt ->> 'runId')::uuid
    and registry.company_id = company_id_value
    and registry.capture_authority = 'runtime_transition';
  if canary_crew_id_value is null or canary_customer_id_value is null then
    raise exception
      'Controlled rehearsal crew was not captured by immutable authority';
  end if;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claim.sub',
    owner_user_id_value::text,
    true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', owner_user_id_value,
      'role', 'authenticated'
    )::text,
    true
  );
  begin
    update public.crews
    set active = true
    where id = canary_crew_id_value;
    raise exception
      'Owner directly activated the controlled rehearsal crew';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'CONTROLLED_REHEARSAL_CREW_ACTIVATION_FORBIDDEN' then
        raise;
      end if;
  end;
  if exists (
    select 1
    from public.crews crew
    where crew.id = canary_crew_id_value
      and crew.active
  ) then
    raise exception
      'Denied direct activation left the controlled rehearsal crew active';
  end if;

  -- This transaction-only fixture intentionally changes the mutable customer
  -- marker to prove it cannot release the registry-bound crew. Clearing a
  -- suppression still crosses the same explicit trusted-review boundary as
  -- production; the canary does not bypass that safety control.
  perform set_config('storyops.suppression_review', 'on', true);
  update public.customers
  set do_not_contact = false
  where id = canary_customer_id_value;
  perform set_config('storyops.suppression_review', 'off', true);
  begin
    update public.crews
    set active = true
    where id = canary_crew_id_value;
    raise exception
      'Mutable customer marker bypassed controlled crew isolation';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'CONTROLLED_REHEARSAL_CREW_ACTIVATION_FORBIDDEN' then
        raise;
      end if;
  end;
  update public.customers
  set do_not_contact = true
  where id = canary_customer_id_value;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );
  insert into public.crews(
    id, company_id, name, active, lead_technician_id,
    skill_codes, home_base_postal_code
  )
  values (
    replacement_crew_id_value,
    company_id_value,
    'Controlled rehearsal link-tamper replacement',
    true,
    technician_user_id_value,
    '{}',
    '00000'
  );
  update public.visits
  set crew_id = replacement_crew_id_value
  where id = (field_claim ->> 'visitId')::uuid;
  update public.jobs
  set assigned_crew_id = replacement_crew_id_value
  where id = (field_claim ->> 'jobId')::uuid;
  begin
    update public.crews
    set active = true
    where id = canary_crew_id_value;
    raise exception
      'Mutable visit/job links bypassed controlled crew isolation';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'CONTROLLED_REHEARSAL_CREW_ACTIVATION_FORBIDDEN' then
        raise;
      end if;
  end;
  update public.visits
  set crew_id = canary_crew_id_value
  where id = (field_claim ->> 'visitId')::uuid;
  update public.jobs
  set assigned_crew_id = canary_crew_id_value
  where id = (field_claim ->> 'jobId')::uuid;

  insert into private.storyops_field_media_canary_crews(
    verification_run_id, company_id, crew_id, customer_id, job_id, visit_id,
    capture_authority
  )
  values (
    insert_guard_run_id_value,
    company_id_value,
    insert_guard_crew_id_value,
    canary_customer_id_value,
    (field_claim ->> 'jobId')::uuid,
    (field_claim ->> 'visitId')::uuid,
    'runtime_transition'
  );
  begin
    insert into public.crews(
      id, company_id, name, active, lead_technician_id,
      skill_codes, home_base_postal_code
    )
    values (
      insert_guard_crew_id_value,
      company_id_value,
      'Controlled rehearsal active insert replacement',
      true,
      technician_user_id_value,
      '{}',
      '00000'
    );
    raise exception
      'Active INSERT recreated a registry-protected controlled crew';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'CONTROLLED_REHEARSAL_CREW_ACTIVATION_FORBIDDEN' then
        raise;
      end if;
  end;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claim.sub',
    technician_user_id_value::text,
    true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', technician_user_id_value,
      'role', 'authenticated'
    )::text,
    true
  );
  if not public.can_upload_job_media_object(field_claim ->> 'objectPath')
    or public.can_upload_job_media_object(
      (field_claim ->> 'objectPath') || '.different'
    )
  then
    raise exception
      'Controlled rehearsal Storage scope was not exact and actor-bound';
  end if;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );
  insert into storage.objects(
    id, bucket_id, name, owner, owner_id, metadata
  )
  values (
    gen_random_uuid(),
    'job-media',
    field_claim ->> 'objectPath',
    technician_user_id_value,
    technician_user_id_value::text,
    jsonb_build_object('size', 68, 'mimetype', 'image/png')
  );
  field_payload := jsonb_build_object(
    'entityId', field_claim ->> 'mediaAssetId',
    'visitId', field_claim ->> 'visitId',
    'jobId', field_claim ->> 'jobId',
    'propertyId', field_claim ->> 'propertyId',
    'purpose', 'before',
    'objectPath', field_claim ->> 'objectPath',
    'contentType', 'image/png',
    'byteSize', 68,
    'checksumSha256',
      '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460',
    'capturedAt', field_claim ->> 'mediaCapturedAt',
    'customerVisible', false
  );

  -- Simulate a legacy/pre-migration active fixture without weakening the
  -- installed guard. The Edge adapter must reject it before delegating to the
  -- canonical finalizer, then the fixture is returned to inactive for the
  -- positive round trip.
  execute
    'alter table public.crews disable trigger crews_controlled_rehearsal_inactive';
  update public.crews
  set active = true
  where id = canary_crew_id_value;
  execute
    'alter table public.crews enable trigger crews_controlled_rehearsal_inactive';
  begin
    perform public.finalize_storyops_media_upload_from_edge(
      company_id_value,
      (field_claim ->> 'mediaCommandId')::uuid,
      technician_user_id_value,
      field_payload,
      public.storyops_json_sha256(jsonb_build_object(
        'commandType', 'media.register',
        'expectedVersion', 0,
        'payload', field_payload
      ))
    );
    raise exception
      'Pre-activated controlled rehearsal crew reached media finalization';
  exception
    when object_not_in_prerequisite_state then
      if sqlerrm <> 'FIELD_MEDIA_CANARY_CREW_ISOLATION_INVALID' then
        raise;
      end if;
  end;
  update public.crews
  set active = false
  where id = canary_crew_id_value;

  perform public.finalize_storyops_media_upload_from_edge(
    company_id_value,
    (field_claim ->> 'mediaCommandId')::uuid,
    technician_user_id_value,
    field_payload,
    public.storyops_json_sha256(jsonb_build_object(
      'commandType', 'media.register',
      'expectedVersion', 0,
      'payload', field_payload
    ))
  );
  if exists (
    select 1
    from public.trusted_pilot_verification_runs run
    join public.visits visit
      on visit.id = run.visit_id
     and visit.company_id = run.company_id
    join public.crews crew
      on crew.id = visit.crew_id
     and crew.company_id = visit.company_id
    where run.id = (field_receipt ->> 'runId')::uuid
      and crew.active
  ) then
    raise exception 'Controlled rehearsal crew remained operationally active';
  end if;

  -- Completion is a second isolation boundary. Even if a privileged legacy
  -- write bypassed the activation trigger, no authorization-grade proof may
  -- be minted until the exact crew is inactive again.
  execute
    'alter table public.crews disable trigger crews_controlled_rehearsal_inactive';
  update public.crews
  set active = true
  where id = canary_crew_id_value;
  execute
    'alter table public.crews enable trigger crews_controlled_rehearsal_inactive';
  begin
    perform public.complete_storyops_field_media_verification(
      (field_receipt ->> 'runId')::uuid,
      deployment_fingerprint_value
    );
    raise exception
      'Field-media proof completed while the rehearsal crew was active';
  exception
    when object_not_in_prerequisite_state then
      if sqlerrm <> 'FIELD_MEDIA_CANARY_COMPLETION_NOT_ISOLATED' then
        raise;
      end if;
  end;
  update public.crews
  set active = false
  where id = canary_crew_id_value;

  completion_receipt := public.complete_storyops_field_media_verification(
    (field_receipt ->> 'runId')::uuid,
    deployment_fingerprint_value
  );
  if completion_receipt ->> 'status' <> 'verified' then
    raise exception 'Field-media verifier run did not verify: %',
      completion_receipt;
  end if;
  perform public.record_storyops_trusted_pilot_proof(
    (field_receipt ->> 'runId')::uuid
  );

  insert into public.audit_events(
    id, company_id, occurred_at, actor_type, actor_id, action,
    entity_type, entity_id, after_data, request_id,
    retention_class, retain_until
  )
  values (
    legacy_audit_id_value,
    company_id_value,
    clock_timestamp() + interval '1 second',
    'system',
    'legacy-proof-regression-fixture',
    'pilot.evidence_recorded',
    'pilot_release_evidence',
    legacy_evidence_id_value,
    jsonb_build_object(
      'kind', 'field_media_canary',
      'provider', 'signed_storage_targets',
      'outcome', 'passed',
      'source', 'storage_roundtrip',
      'evidenceReference', 'legacy-unbound-field-proof',
      'artifactSha256', repeat('7', 64),
      'observedAt', clock_timestamp(),
      'expiresAt', clock_timestamp() + interval '30 days',
      'reviewedByUserId', owner_user_id_value,
      'verificationBasis', 'trusted_system_proof',
      'binding', jsonb_build_object(
        'configurationRevision', 2,
        'configurationHash', repeat('d', 64),
        'baselineId', '91600000-0000-4000-8000-000000000042',
        'baselineHash', repeat('e', 64),
        'capability', 'private_media_roundtrip',
        'integrationProvider', 'signed_storage_targets',
        'integrationVersion', 2
      )
    ),
    legacy_evidence_id_value::text,
    'audit',
    clock_timestamp() + interval '7 years'
  );
  if exists (
    select 1
    from jsonb_array_elements(
      private.storyops_current_trusted_proofs(company_id_value)
    ) proof
    where proof ->> 'auditEventId' = legacy_audit_id_value::text
  ) then
    raise exception
      'Legacy trusted proof without a verifier-run binding remained eligible';
  end if;

  update private.storyops_field_media_canary_crews
  set capture_authority = 'migration_unverified'
  where verification_run_id = (field_receipt ->> 'runId')::uuid;
  if exists (
    select 1
    from jsonb_array_elements(
      private.storyops_current_trusted_proofs(company_id_value)
    ) proof
    where proof #>> '{binding,verificationRunId}' =
      field_receipt ->> 'runId'
  ) then
    raise exception
      'Pre-upgrade field-media proof remained eligible after migration';
  end if;
  update private.storyops_field_media_canary_crews
  set capture_authority = 'runtime_transition'
  where verification_run_id = (field_receipt ->> 'runId')::uuid;

  -- Migration 66 makes current scheduler/queue evidence an independent launch
  -- prerequisite. Exercise the same service-only heartbeat and readiness APIs
  -- used by the deployed workers instead of bypassing the launch trigger.
  foreach worker_name in array array[
    'post_service',
    'transactional_outbound',
    'scheduling_reconciliation',
    'scope_photo_cleanup'
  ]::text[] loop
    worker_configuration_hash := encode(
      extensions.digest(
        worker_name || ':scheduling-boundary',
        'sha256'
      ),
      'hex'
    );
    perform public.record_storyops_private_worker_heartbeat(
      company_id_value,
      worker_name,
      deployment_fingerprint_value,
      worker_configuration_hash,
      'scheduled',
      'succeeded'
    );
    worker_payload := worker_payload || jsonb_build_array(
      jsonb_build_object(
        'worker', worker_name,
        'activationMode', 'scheduled',
        'credentialStatus', 'valid',
        'acceptedTrigger', 'scheduled',
        'scheduleIntervalSeconds', 120,
        'configurationHash', worker_configuration_hash,
        'deploymentIdentityStatus', 'valid',
        'queue', jsonb_build_object(
          'availability', 'verified',
          'backlogCount', 0,
          'dueCount', 0,
          'submissionUnknownCount', 0,
          'oldestQueuedAt', null,
          'oldestQueuedAgeSeconds', null,
          'actionCounts', jsonb_build_object(
            'postService', 0,
            'quoteDelivery', 0,
            'onMyWay', 0,
            'schedulingReconciliation', 0,
            'scopePhotoCleanup', 0
          )
        )
      )
    );
  end loop;
  if (
    public.record_storyops_private_worker_readiness(
      company_id_value,
      owner_user_id_value,
      gen_random_uuid(),
      deployment_fingerprint_value,
      clock_timestamp(),
      900,
      worker_payload
    ) ->> 'liveReady'
  ) <> 'true'
  then
    raise exception 'Private worker readiness fixture did not become healthy';
  end if;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claim.sub',
    owner_user_id_value::text,
    true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', owner_user_id_value,
      'role', 'authenticated'
    )::text,
    true
  );
  command_id_value := gen_random_uuid();
  request_hash_value := encode(extensions.digest(array_to_string(array[
    'storyops-launch-authorization-v1',
    'authorize',
    '0',
    'TEST-SCHEDULING-LAUNCH-REVIEW'
  ], chr(31)), 'sha256'), 'hex');
  launch_receipt := public.set_storyops_company_launch_authorization(
    company_id_value,
    command_id_value,
    0,
    'authorize',
    'TEST-SCHEDULING-LAUNCH-REVIEW',
    request_hash_value
  );
  if launch_receipt ->> 'launchAuthorized' <> 'true'
    or not private.storyops_launch_authorization_effective(company_id_value)
  then
    raise exception 'Scheduling launch authority is not effective: %',
      launch_receipt;
  end if;
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
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
  fixture scheduling_evidence_fixture%rowtype;
  blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  begin
    perform public.execute_storyops_golden_path_command(
      fixture.company_id,
      '91600000-0000-4000-8000-000000000034',
      'job.book',
      fixture.job_version,
      fixture.booking_payload,
      fixture.booking_request_hash
    );
  exception
    when others then
      if position('GOLDEN_PATH_LIVE_ELIGIBLE_EVIDENCE_REQUIRED' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Sandbox scheduling evidence confirmed a booking';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);

do $$
begin
  if (
    select status
    from public.jobs
    where id = '10000000-0000-4000-8000-000000000631'
  ) <> 'ready_to_schedule'
    or exists (
      select 1
      from public.scheduling_evidence_consumptions consumption
      where consumption.evidence_receipt_id = (
        select (sandbox_receipt ->> 'receiptId')::uuid
        from scheduling_evidence_fixture
      )
    )
  then
    raise exception 'Rejected sandbox booking mutated scheduling state';
  end if;
end;
$$;

update scheduling_evidence_fixture
set live_evidence = pg_temp.build_scheduling_evidence(
  'live',
  2,
  '91600000-0000-4000-8000-000000000042',
  'scheduling-boundary-live'
);
update scheduling_evidence_fixture
set
  live_changed_evidence =
    live_evidence || jsonb_build_object(
      'traceId', 'scheduling-boundary-live-changed'
    ),
  live_request_hash = public.storyops_json_sha256(jsonb_build_object(
    'actorUserId', actor_user_id,
    'companyId', company_id,
    'evidence', live_evidence,
    'idempotencyKey', 'scheduling-boundary-live'
  ));
update scheduling_evidence_fixture
set
  live_changed_request_hash =
    public.storyops_json_sha256(jsonb_build_object(
      'actorUserId', actor_user_id,
      'companyId', company_id,
      'evidence', live_changed_evidence,
      'idempotencyKey', 'scheduling-boundary-live'
    )),
  live_offboarded_request_hash =
    public.storyops_json_sha256(jsonb_build_object(
      'actorUserId', actor_user_id,
      'companyId', company_id,
      'evidence', live_evidence,
      'idempotencyKey', 'scheduling-boundary-live-offboarded'
    )),
  live_rerolled_request_hash =
    public.storyops_json_sha256(jsonb_build_object(
      'actorUserId', actor_user_id,
      'companyId', company_id,
      'evidence', live_evidence,
      'idempotencyKey', 'scheduling-boundary-live-rerolled'
    )),
  live_secondary_request_hash =
    public.storyops_json_sha256(jsonb_build_object(
      'actorUserId', actor_user_id,
      'companyId', company_id,
      'evidence', live_evidence,
      'idempotencyKey', 'scheduling-boundary-live-secondary'
    ));

\echo '4a/14 offboarded or re-roled crew members cannot produce trusted evidence'
update public.company_memberships
set active = false
where company_id = '10000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000103';
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);
do $$
declare
  fixture scheduling_evidence_fixture%rowtype;
  key_value text := 'scheduling-boundary-live-offboarded';
  blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  begin
    perform public.record_storyops_scheduling_evidence(
      fixture.company_id,
      fixture.actor_user_id,
      key_value,
      fixture.live_offboarded_request_hash,
      fixture.live_evidence
    );
  exception
    when others then
      if position(
        'SCHEDULING_EVIDENCE_INTERNAL_CAPACITY_CONFLICT' in sqlerrm
      ) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Offboarded crew member produced trusted evidence';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);
update public.company_memberships
set active = true, role = 'dispatcher'
where company_id = '10000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000103';
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);
do $$
declare
  fixture scheduling_evidence_fixture%rowtype;
  key_value text := 'scheduling-boundary-live-rerolled';
  blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  begin
    perform public.record_storyops_scheduling_evidence(
      fixture.company_id,
      fixture.actor_user_id,
      key_value,
      fixture.live_rerolled_request_hash,
      fixture.live_evidence
    );
  exception
    when others then
      if position(
        'SCHEDULING_EVIDENCE_INTERNAL_CAPACITY_CONFLICT' in sqlerrm
      ) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Re-roled crew member produced trusted evidence';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);
update public.company_memberships
set role = 'technician'
where company_id = '10000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000103';

\echo '4/10 service role records the exact live provider receipt once'
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);
do $$
declare
  fixture scheduling_evidence_fixture%rowtype;
  first_result jsonb;
  replay_result jsonb;
  conflict_blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  first_result := public.record_storyops_scheduling_evidence(
    fixture.company_id,
    fixture.actor_user_id,
    'scheduling-boundary-live',
    fixture.live_request_hash,
    fixture.live_evidence
  );
  if first_result ->> 'replayed' <> 'false'
    or first_result ->> 'evidenceMode' <> 'live'
    or first_result ->> 'capacityDisposition' <> 'eligible'
    or first_result ->> 'routeDisposition' <> 'eligible'
    or first_result ->> 'weatherDisposition' <> 'eligible'
  then
    raise exception 'Live evidence receipt was incomplete: %', first_result;
  end if;

  replay_result := public.record_storyops_scheduling_evidence(
    fixture.company_id,
    fixture.actor_user_id,
    'scheduling-boundary-live',
    fixture.live_request_hash,
    fixture.live_evidence
  );
  if replay_result ->> 'replayed' <> 'true'
    or replay_result ->> 'receiptId' <> first_result ->> 'receiptId'
    or replay_result ->> 'routeCheckId' <> first_result ->> 'routeCheckId'
    or replay_result ->> 'weatherCheckId' <> first_result ->> 'weatherCheckId'
  then
    raise exception 'Exact live evidence replay changed identity: %', replay_result;
  end if;

  begin
    perform public.record_storyops_scheduling_evidence(
      fixture.company_id,
      fixture.actor_user_id,
      'scheduling-boundary-live',
      fixture.live_changed_request_hash,
      fixture.live_changed_evidence
    );
  exception
    when others then
      if position('SCHEDULING_EVIDENCE_IDEMPOTENCY_CONFLICT' in sqlerrm) > 0 then
        conflict_blocked := true;
      else
        raise;
      end if;
  end;
  if not conflict_blocked then
    raise exception 'Changed live evidence reused an idempotency key';
  end if;

  update scheduling_evidence_fixture
  set live_receipt = first_result;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);

\echo '5/10 a second fresh live receipt for the same job is blocked'
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
  true
);
do $$
declare
  fixture scheduling_evidence_fixture%rowtype;
  second_key text := 'scheduling-boundary-live-secondary';
  blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  begin
    perform public.record_storyops_scheduling_evidence(
      fixture.company_id,
      fixture.actor_user_id,
      second_key,
      fixture.live_secondary_request_hash,
      fixture.live_evidence
    );
  exception
    when others then
      if position('SCHEDULING_EVIDENCE_ACTIVE_RECEIPT_EXISTS' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'A second fresh live receipt was recorded for one job';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);

\echo '6/10 receipts and their exact route/weather facts are immutable'
do $$
declare
  fixture scheduling_evidence_fixture%rowtype;
  receipt_blocked boolean := false;
  route_blocked boolean := false;
  weather_blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  begin
    update public.scheduling_evidence_receipts
    set trace_id = trace_id
    where id = (fixture.live_receipt ->> 'receiptId')::uuid;
  exception
    when others then
      if position('SCHEDULING_EVIDENCE_IMMUTABLE' in sqlerrm) > 0 then
        receipt_blocked := true;
      else
        raise;
      end if;
  end;
  begin
    update public.route_checks
    set drive_minutes = drive_minutes
    where id = (fixture.live_receipt ->> 'routeCheckId')::uuid;
  exception
    when others then
      if position('SCHEDULING_EVIDENCE_IMMUTABLE' in sqlerrm) > 0 then
        route_blocked := true;
      else
        raise;
      end if;
  end;
  begin
    update public.weather_checks
    set temperature_f = temperature_f
    where id = (fixture.live_receipt ->> 'weatherCheckId')::uuid;
  exception
    when others then
      if position('SCHEDULING_EVIDENCE_IMMUTABLE' in sqlerrm) > 0 then
        weather_blocked := true;
      else
        raise;
      end if;
  end;
  if not receipt_blocked or not route_blocked or not weather_blocked then
    raise exception 'One or more scheduling evidence facts remained mutable';
  end if;
end;
$$;

update scheduling_evidence_fixture
set
  booking_payload = jsonb_build_object(
    'entityId', job_id,
    'schedulingEvidenceReceiptId', live_receipt ->> 'receiptId'
  ),
  changed_booking_payload = jsonb_build_object(
    'entityId', job_id,
    'schedulingEvidenceReceiptId', sandbox_receipt ->> 'receiptId'
  );
update scheduling_evidence_fixture
set
  booking_request_hash = public.storyops_json_sha256(jsonb_build_object(
    'commandType', 'job.book',
    'expectedVersion', job_version,
    'payload', booking_payload
  )),
  changed_booking_request_hash = public.storyops_json_sha256(
    jsonb_build_object(
      'commandType', 'job.book',
      'expectedVersion', job_version,
      'payload', changed_booking_payload
    )
  );

\echo '7c/16 scarce equipment is interval-reserved and overlapping holds are excluded'
do $$
declare
  fixture scheduling_evidence_fixture%rowtype;
  reservation public.scheduling_equipment_reservations%rowtype;
  blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  if (
    select count(*)
    from public.scheduling_equipment_reservations equipment_reservation
    where equipment_reservation.evidence_receipt_id =
        (fixture.live_receipt ->> 'receiptId')::uuid
      and equipment_reservation.status = 'held'
  ) <> 3 then
    raise exception 'Live receipt did not reserve every required physical asset';
  end if;
  select *
  into reservation
  from public.scheduling_equipment_reservations equipment_reservation
  where equipment_reservation.evidence_receipt_id =
      (fixture.live_receipt ->> 'receiptId')::uuid
  order by equipment_reservation.equipment_id
  limit 1;
  begin
    insert into public.scheduling_equipment_reservations(
      company_id,
      evidence_receipt_id,
      equipment_id,
      starts_at,
      ends_at,
      status
    )
    values (
      fixture.company_id,
      (fixture.sandbox_receipt ->> 'receiptId')::uuid,
      reservation.equipment_id,
      reservation.starts_at,
      reservation.ends_at,
      'held'
    );
  exception
    when exclusion_violation then blocked := true;
  end;
  if not blocked then
    raise exception 'One scarce machine received overlapping active holds';
  end if;
end;
$$;

\echo '7d/16 atomic booking rejects a missing equipment reservation'
update public.scheduling_equipment_reservations
set
  status = 'released',
  completed_at = now()
where id = (
  select equipment_reservation.id
  from public.scheduling_equipment_reservations equipment_reservation
  cross join scheduling_evidence_fixture fixture
  where equipment_reservation.evidence_receipt_id =
      (fixture.live_receipt ->> 'receiptId')::uuid
  order by equipment_reservation.equipment_id
  limit 1
);
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
  fixture scheduling_evidence_fixture%rowtype;
  blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  begin
    perform public.execute_storyops_golden_path_command(
      fixture.company_id,
      '91600000-0000-4000-8000-000000000049',
      'job.book',
      fixture.job_version,
      fixture.booking_payload,
      fixture.booking_request_hash
    );
  exception
    when others then
      if position(
        'GOLDEN_PATH_EQUIPMENT_RESERVATION_REQUIRED' in sqlerrm
      ) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Booking succeeded after a scarce-equipment hold was lost';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
update public.scheduling_equipment_reservations
set
  status = 'held',
  completed_at = null
where evidence_receipt_id = (
    select (fixture.live_receipt ->> 'receiptId')::uuid
    from scheduling_evidence_fixture fixture
  )
  and status = 'released';

\echo '7b/14 booking fails closed when an adjacent crew visit changed after routing'
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
  '91600000-0000-4000-8000-000000000047',
  fixture.company_id,
  fixture.job_id,
  2,
  'planned',
  date_trunc('day', fixture.starts_at) + interval '7 hours',
  date_trunc('day', fixture.starts_at) + interval '8 hours',
  fixture.crew_id,
  '10000000-0000-4000-8000-000000000301'
from scheduling_evidence_fixture fixture;
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
  fixture scheduling_evidence_fixture%rowtype;
  blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  begin
    perform public.execute_storyops_golden_path_command(
      fixture.company_id,
      '91600000-0000-4000-8000-000000000048',
      'job.book',
      fixture.job_version,
      fixture.booking_payload,
      fixture.booking_request_hash
    );
  exception
    when others then
      if position('GOLDEN_PATH_EXACT_LIVE_ROUTE_REQUIRED' in sqlerrm) > 0
        or position('GOLDEN_PATH_ROUTE_CONTEXT_CHANGED' in sqlerrm) > 0
      then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Changed adjacent visit reused stale route evidence';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
delete from public.visits
where id = '91600000-0000-4000-8000-000000000047';

\echo '7a/14 atomic booking rechecks active technician membership'
update public.company_memberships
set active = false
where company_id = '10000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000103';
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
  fixture scheduling_evidence_fixture%rowtype;
  blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  begin
    perform public.execute_storyops_golden_path_command(
      fixture.company_id,
      '91600000-0000-4000-8000-000000000045',
      'job.book',
      fixture.job_version,
      fixture.booking_payload,
      fixture.booking_request_hash
    );
  exception
    when others then
      if position('GOLDEN_PATH_CREW_CAPACITY_UNAVAILABLE' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Atomic booking accepted an offboarded crew member';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
update public.company_memberships
set active = true, role = 'dispatcher'
where company_id = '10000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000103';
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
  fixture scheduling_evidence_fixture%rowtype;
  blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  begin
    perform public.execute_storyops_golden_path_command(
      fixture.company_id,
      '91600000-0000-4000-8000-000000000046',
      'job.book',
      fixture.job_version,
      fixture.booking_payload,
      fixture.booking_request_hash
    );
  exception
    when others then
      if position('GOLDEN_PATH_CREW_CAPACITY_UNAVAILABLE' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Atomic booking accepted a re-roled crew member';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
update public.company_memberships
set role = 'technician'
where company_id = '10000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000103';

\echo '7/10 authenticated dispatcher books from the live receipt exactly once'
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
  fixture scheduling_evidence_fixture%rowtype;
  first_result jsonb;
  replay_result jsonb;
  conflict_blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  first_result := public.execute_storyops_golden_path_command(
    fixture.company_id,
    '91600000-0000-4000-8000-000000000044',
    'job.book',
    fixture.job_version,
    fixture.booking_payload,
    fixture.booking_request_hash
  );
  if first_result ->> 'status' <> 'applied'
    or first_result ->> 'replayed' <> 'false'
    or first_result ->> 'schedulingEvidenceReceiptId'
      <> fixture.live_receipt ->> 'receiptId'
    or first_result ->> 'routeCheckId'
      <> fixture.live_receipt ->> 'routeCheckId'
    or first_result ->> 'weatherCheckId'
      <> fixture.live_receipt ->> 'weatherCheckId'
  then
    raise exception 'Live receipt booking failed: %', first_result;
  end if;

  replay_result := public.execute_storyops_golden_path_command(
    fixture.company_id,
    '91600000-0000-4000-8000-000000000044',
    'job.book',
    fixture.job_version,
    fixture.booking_payload,
    fixture.booking_request_hash
  );
  if replay_result ->> 'replayed' <> 'true'
    or replay_result ->> 'entityId' <> first_result ->> 'entityId'
    or replay_result ->> 'requestHash' <> first_result ->> 'requestHash'
  then
    raise exception 'Exact booking replay changed its result: %', replay_result;
  end if;

  begin
    perform public.execute_storyops_golden_path_command(
      fixture.company_id,
      '91600000-0000-4000-8000-000000000044',
      'job.book',
      fixture.job_version,
      fixture.changed_booking_payload,
      fixture.changed_booking_request_hash
    );
  exception
    when others then
      if position('GOLDEN_PATH_IDEMPOTENCY_CONFLICT' in sqlerrm) > 0 then
        conflict_blocked := true;
      else
        raise;
      end if;
  end;
  if not conflict_blocked then
    raise exception 'Changed booking payload reused a command id';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);

\echo '8/10 booking promotion consumed one live receipt and created one exact visit'
do $$
declare
  fixture scheduling_evidence_fixture%rowtype;
  receipt_id_value uuid;
begin
  select * into fixture from scheduling_evidence_fixture;
  receipt_id_value := (fixture.live_receipt ->> 'receiptId')::uuid;
  if (
    select count(*)
    from public.visits visit
    where visit.scheduling_evidence_receipt_id = receipt_id_value
      and visit.status = 'confirmed'
      and visit.job_id = fixture.job_id
      and visit.crew_id = fixture.crew_id
      and visit.starts_at = fixture.starts_at
      and visit.ends_at = fixture.ends_at
  ) <> 1 then
    raise exception 'Booking did not create exactly one receipt-bound visit';
  end if;
  if (
    select count(*)
    from public.scheduling_evidence_consumptions consumption
    where consumption.evidence_receipt_id = receipt_id_value
      and consumption.idempotency_key =
        '91600000-0000-4000-8000-000000000044'
  ) <> 1 then
    raise exception 'Booking did not consume the live receipt exactly once';
  end if;
  if (
    select count(*)
    from public.idempotency_keys idempotency
    where idempotency.company_id = fixture.company_id
      and idempotency.scope = 'golden-path-booking-v2'
      and idempotency.key = '91600000-0000-4000-8000-000000000044'
      and idempotency.status = 'completed'
  ) <> 1 then
    raise exception 'Booking did not complete exactly one command reservation';
  end if;
  if (
    select status
    from public.jobs
    where id = fixture.job_id
  ) <> 'scheduled' then
    raise exception 'Receipt-backed booking did not schedule the job';
  end if;
end;
$$;

\echo '9/10 overlapping active crew windows are rejected at the database constraint'
do $$
declare
  fixture scheduling_evidence_fixture%rowtype;
  visit_row public.visits%rowtype;
  blocked boolean := false;
begin
  select * into fixture from scheduling_evidence_fixture;
  select *
  into visit_row
  from public.visits visit
  where visit.job_id = fixture.job_id
    and visit.scheduling_evidence_receipt_id =
      (fixture.live_receipt ->> 'receiptId')::uuid;
  begin
    insert into public.visits(
      company_id, job_id, sequence, status, starts_at, ends_at, crew_id,
      route_check_id, weather_check_id, checklist_template_id
    )
    values (
      fixture.company_id,
      fixture.job_id,
      2,
      'planned',
      fixture.starts_at + interval '15 minutes',
      fixture.ends_at + interval '15 minutes',
      fixture.crew_id,
      visit_row.route_check_id,
      visit_row.weather_check_id,
      visit_row.checklist_template_id
    );
  exception
    when exclusion_violation then blocked := true;
  end;
  if not blocked then
    raise exception 'Database allowed overlapping active visits for one crew';
  end if;
end;
$$;

\echo '10/10 no private promotion authorization leaked from the transaction'
do $$
begin
  if exists (
    select 1
    from private.scheduling_promotion_authorizations
    where company_id = '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Booking left a reusable private promotion authorization';
  end if;
end;
$$;

rollback;

\echo 'scheduling evidence boundary: pass'
