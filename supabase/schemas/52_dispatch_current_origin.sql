-- Current departure-origin truth for dispatch clearance.
--
-- Booking-time route origins are immutable scheduling evidence, not proof of
-- where a technician is when they leave. New clearance receipts bind a
-- consented, accurate, fresh device reading to the actor, visit version,
-- provider request, append-only receipt hash, and short consumption window.

alter table public.dispatch_clearance_receipts
  drop constraint dispatch_clearance_receipts_schema_version_check,
  drop constraint dispatch_clearance_receipts_check3;

alter table public.dispatch_clearance_receipts
  alter column schema_version set default 'storyops-dispatch-clearance-v2',
  add constraint dispatch_clearance_receipts_schema_version_check
    check (
      schema_version in (
        'storyops-dispatch-clearance-v1',
        'storyops-dispatch-clearance-v2'
      )
    ),
  add column current_origin jsonb,
  add column current_origin_hash text
    check (
      current_origin_hash is null
      or current_origin_hash ~ '^[a-f0-9]{64}$'
    ),
  add column current_origin_expires_at timestamptz;

alter table public.dispatch_clearance_receipts
  add constraint dispatch_clearance_receipts_expiry_boundary_check
  check (
    (
      schema_version = 'storyops-dispatch-clearance-v1'
      and expires_at = least(route_expires_at, weather_expires_at)
    )
    or (
      schema_version = 'storyops-dispatch-clearance-v2'
      and expires_at = least(
        current_origin_expires_at,
        route_expires_at,
        weather_expires_at
      )
    )
  ),
  add constraint dispatch_clearance_receipts_current_origin_check
  check (
    (
      (
        schema_version = 'storyops-dispatch-clearance-v1'
        and current_origin is null
        and current_origin_hash is null
        and current_origin_expires_at is null
      )
      or (
        schema_version = 'storyops-dispatch-clearance-v2'
        and jsonb_typeof(current_origin) = 'object'
        and current_origin ?& array[
          'schemaVersion', 'readingId', 'source', 'coordinates',
          'observedAt', 'accuracyMeters', 'consent'
        ]::text[]
        and current_origin - array[
          'schemaVersion', 'readingId', 'source', 'coordinates',
          'observedAt', 'accuracyMeters', 'consent'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof(current_origin -> 'schemaVersion') = 'string'
        and jsonb_typeof(current_origin -> 'readingId') = 'string'
        and jsonb_typeof(current_origin -> 'source') = 'string'
        and jsonb_typeof(current_origin -> 'coordinates') = 'object'
        and jsonb_typeof(current_origin -> 'observedAt') = 'string'
        and jsonb_typeof(current_origin -> 'accuracyMeters') = 'number'
        and jsonb_typeof(current_origin -> 'consent') = 'object'
        and (current_origin -> 'coordinates') ?& array[
          'latitude', 'longitude'
        ]::text[]
        and (current_origin -> 'coordinates') - array[
          'latitude', 'longitude'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof(current_origin #> '{coordinates,latitude}') = 'number'
        and jsonb_typeof(current_origin #> '{coordinates,longitude}') = 'number'
        and (current_origin -> 'consent') ?& array[
          'kind', 'disclosureVersion', 'capturedAt'
        ]::text[]
        and (current_origin -> 'consent') - array[
          'kind', 'disclosureVersion', 'capturedAt'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof(current_origin #> '{consent,kind}') = 'string'
        and jsonb_typeof(
          current_origin #> '{consent,disclosureVersion}'
        ) = 'string'
        and jsonb_typeof(current_origin #> '{consent,capturedAt}') = 'string'
        and current_origin ->> 'schemaVersion'
          = 'storyops-dispatch-current-origin-v1'
        and current_origin ->> 'source' = 'device_geolocation'
        and (current_origin ->> 'readingId')::uuid is not null
        and (current_origin #>> '{coordinates,latitude}')::numeric
          between -90 and 90
        and (current_origin #>> '{coordinates,longitude}')::numeric
          between -180 and 180
        and (current_origin ->> 'accuracyMeters')::numeric
          between 0 and 100
        and isfinite((current_origin ->> 'observedAt')::timestamptz)
        and current_origin #>> '{consent,kind}' = 'explicit_user_action'
        and current_origin #>> '{consent,disclosureVersion}'
          = 'storyops-dispatch-origin-consent-v1'
        and isfinite(
          (current_origin #>> '{consent,capturedAt}')::timestamptz
        )
        and current_origin_hash is not null
        and current_origin_expires_at
          = (current_origin ->> 'observedAt')::timestamptz
            + interval '2 minutes'
        and expires_at <= current_origin_expires_at
      )
    ) is true
  );

create or replace function public.storyops_dispatch_clearance_receipt_json(
  p_receipt public.dispatch_clearance_receipts,
  p_replayed boolean default false
)
returns jsonb
language sql
stable
strict
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'schemaVersion', p_receipt.schema_version,
    'receiptId', p_receipt.id,
    'companyId', p_receipt.company_id,
    'visitId', p_receipt.visit_id,
    'visitVersion', p_receipt.visit_version,
    'jobId', p_receipt.job_id,
    'jobVersion', p_receipt.job_version,
    'propertyId', p_receipt.property_id,
    'propertyVersion', p_receipt.property_version,
    'crewId', p_receipt.crew_id,
    'crewVersion', p_receipt.crew_version,
    'startsAt', p_receipt.starts_at,
    'endsAt', p_receipt.ends_at,
    'evidenceMode', p_receipt.evidence_mode,
    'configurationRevision', p_receipt.configuration_revision,
    'configurationHash', p_receipt.configuration_hash,
    'operatingBaselinePublicationId',
      p_receipt.operating_baseline_publication_id,
    'operatingBaselineHash', p_receipt.operating_baseline_hash,
    'schedulingEvidenceReceiptId', p_receipt.scheduling_evidence_receipt_id,
    'providerSnapshotHash', p_receipt.provider_snapshot_hash,
    'currentOrigin', p_receipt.current_origin,
    'currentOriginHash', p_receipt.current_origin_hash,
    'currentOriginExpiresAt', p_receipt.current_origin_expires_at,
    'routeCheckId', p_receipt.route_check_id,
    'routeDisposition', p_receipt.route_disposition,
    'routeObservedAt', p_receipt.route_observed_at,
    'routeExpiresAt', p_receipt.route_expires_at,
    'weatherCheckId', p_receipt.weather_check_id,
    'weatherDisposition', p_receipt.weather_disposition,
    'weatherObservedAt', p_receipt.weather_observed_at,
    'weatherExpiresAt', p_receipt.weather_expires_at,
    'unknowns', to_jsonb(p_receipt.unknowns),
    'conflicts', p_receipt.conflicts,
    'expiresAt', p_receipt.expires_at,
    'evidenceHash', p_receipt.evidence_hash,
    'requestHash', p_receipt.request_hash,
    'createdAt', p_receipt.created_at,
    'replayed', p_replayed
  )
$$;

create or replace function public.record_storyops_dispatch_clearance(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions, auth
as $$
declare
  actor_role public.app_role;
  existing_row public.dispatch_clearance_receipts%rowtype;
  inserted_row public.dispatch_clearance_receipts%rowtype;
  visit_row public.visits%rowtype;
  job_row public.jobs%rowtype;
  property_row public.properties%rowtype;
  crew_row public.crews%rowtype;
  company_row public.companies%rowtype;
  configuration_row public.company_configuration_versions%rowtype;
  baseline_row public.company_operating_baseline_publications%rowtype;
  scheduling_row public.scheduling_evidence_receipts%rowtype;
  scheduling_route_row public.route_checks%rowtype;
  route_data jsonb;
  route_request jsonb;
  route_response jsonb;
  weather_data jsonb;
  weather_policy jsonb;
  current_weather_policy jsonb;
  current_origin_data jsonb;
  provider_bindings_value jsonb;
  provider_snapshot_hash_value text;
  route_check_id_value uuid;
  weather_check_id_value uuid;
  effective_request_hash text;
  current_origin_hash_value text;
  visit_id_value uuid;
  route_observed_at_value timestamptz;
  route_expires_at_value timestamptz;
  weather_observed_at_value timestamptz;
  weather_expires_at_value timestamptz;
  current_origin_observed_at_value timestamptz;
  current_origin_consent_at_value timestamptz;
  current_origin_expires_at_value timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DISPATCH_CLEARANCE_SERVICE_ROLE_REQUIRED';
  end if;
  if p_company_id is null
    or p_actor_user_id is null
    or p_idempotency_key is null
    or length(btrim(p_idempotency_key)) not between 16 and 160
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_evidence is null
    or jsonb_typeof(p_evidence) <> 'object'
  then
    raise exception 'DISPATCH_CLEARANCE_INVALID_REQUEST';
  end if;

  current_origin_data := p_evidence -> 'currentOrigin';
  if not (
      p_evidence ?& array[
        'schemaVersion', 'evidenceMode', 'visitId', 'visitVersion',
        'jobId', 'jobVersion', 'propertyId', 'propertyVersion',
        'propertyGeocodedAt', 'crewId', 'crewVersion', 'startsAt', 'endsAt',
        'configurationRevision', 'configurationHash',
        'operatingBaselinePublicationId', 'operatingBaselineHash',
        'schedulingEvidenceReceiptId', 'providerSnapshotHash', 'currentOrigin',
        'route', 'weather', 'unknowns', 'conflicts'
      ]::text[]
    )
    or p_evidence - array[
      'schemaVersion', 'evidenceMode', 'visitId', 'visitVersion',
      'jobId', 'jobVersion', 'propertyId', 'propertyVersion',
      'propertyGeocodedAt', 'crewId', 'crewVersion', 'startsAt', 'endsAt',
      'configurationRevision', 'configurationHash',
      'operatingBaselinePublicationId', 'operatingBaselineHash',
      'schedulingEvidenceReceiptId', 'providerSnapshotHash', 'currentOrigin',
      'route', 'weather', 'unknowns', 'conflicts', 'traceId'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(p_evidence -> 'schemaVersion') <> 'string'
    or jsonb_typeof(p_evidence -> 'evidenceMode') <> 'string'
    or jsonb_typeof(p_evidence -> 'visitId') <> 'string'
    or jsonb_typeof(p_evidence -> 'visitVersion') <> 'number'
    or jsonb_typeof(p_evidence -> 'jobId') <> 'string'
    or jsonb_typeof(p_evidence -> 'jobVersion') <> 'number'
    or jsonb_typeof(p_evidence -> 'propertyId') <> 'string'
    or jsonb_typeof(p_evidence -> 'propertyVersion') <> 'number'
    or jsonb_typeof(p_evidence -> 'propertyGeocodedAt') <> 'string'
    or jsonb_typeof(p_evidence -> 'crewId') <> 'string'
    or jsonb_typeof(p_evidence -> 'crewVersion') <> 'number'
    or jsonb_typeof(p_evidence -> 'startsAt') <> 'string'
    or jsonb_typeof(p_evidence -> 'endsAt') <> 'string'
    or jsonb_typeof(p_evidence -> 'configurationRevision') <> 'number'
    or jsonb_typeof(p_evidence -> 'configurationHash') <> 'string'
    or jsonb_typeof(
      p_evidence -> 'operatingBaselinePublicationId'
    ) <> 'string'
    or jsonb_typeof(p_evidence -> 'operatingBaselineHash') <> 'string'
    or jsonb_typeof(p_evidence -> 'schedulingEvidenceReceiptId') <> 'string'
    or jsonb_typeof(p_evidence -> 'providerSnapshotHash') <> 'string'
    or jsonb_typeof(current_origin_data) <> 'object'
    or jsonb_typeof(p_evidence -> 'route') <> 'object'
    or jsonb_typeof(p_evidence -> 'weather') <> 'object'
    or jsonb_typeof(p_evidence -> 'unknowns') <> 'array'
    or jsonb_array_length(p_evidence -> 'unknowns') <> 0
    or jsonb_typeof(p_evidence -> 'conflicts') <> 'array'
    or jsonb_array_length(p_evidence -> 'conflicts') <> 0
    or (
      p_evidence ? 'traceId'
      and (
        jsonb_typeof(p_evidence -> 'traceId') <> 'string'
        or char_length(btrim(p_evidence ->> 'traceId')) not between 1 and 160
      )
    )
    or p_evidence ->> 'schemaVersion'
      <> 'storyops-dispatch-clearance-evidence-v2'
    or p_evidence ->> 'evidenceMode' <> 'live'
    or coalesce(p_evidence ->> 'visitId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_evidence ->> 'jobId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_evidence ->> 'propertyId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_evidence ->> 'crewId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_evidence ->> 'operatingBaselinePublicationId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_evidence ->> 'schedulingEvidenceReceiptId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_evidence ->> 'configurationHash', '') !~ '^[a-f0-9]{64}$'
    or coalesce(p_evidence ->> 'operatingBaselineHash', '') !~ '^[a-f0-9]{64}$'
    or coalesce(p_evidence ->> 'providerSnapshotHash', '') !~ '^[a-f0-9]{64}$'
    or (p_evidence ->> 'visitVersion')::numeric
      not between 1 and 2147483647
    or (p_evidence ->> 'visitVersion')::numeric
      <> trunc((p_evidence ->> 'visitVersion')::numeric)
    or (p_evidence ->> 'jobVersion')::numeric
      not between 1 and 2147483647
    or (p_evidence ->> 'jobVersion')::numeric
      <> trunc((p_evidence ->> 'jobVersion')::numeric)
    or (p_evidence ->> 'propertyVersion')::numeric
      not between 1 and 2147483647
    or (p_evidence ->> 'propertyVersion')::numeric
      <> trunc((p_evidence ->> 'propertyVersion')::numeric)
    or (p_evidence ->> 'crewVersion')::numeric
      not between 1 and 2147483647
    or (p_evidence ->> 'crewVersion')::numeric
      <> trunc((p_evidence ->> 'crewVersion')::numeric)
    or (p_evidence ->> 'configurationRevision')::numeric
      not between 1 and 2147483647
    or (p_evidence ->> 'configurationRevision')::numeric
      <> trunc((p_evidence ->> 'configurationRevision')::numeric)
  then
    raise exception 'DISPATCH_CLEARANCE_EVIDENCE_INVALID';
  end if;

  if not (
      current_origin_data ?& array[
        'schemaVersion', 'readingId', 'source', 'coordinates',
        'observedAt', 'accuracyMeters', 'consent'
      ]::text[]
    )
    or current_origin_data - array[
      'schemaVersion', 'readingId', 'source', 'coordinates',
      'observedAt', 'accuracyMeters', 'consent'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(current_origin_data -> 'schemaVersion') <> 'string'
    or jsonb_typeof(current_origin_data -> 'readingId') <> 'string'
    or jsonb_typeof(current_origin_data -> 'source') <> 'string'
    or jsonb_typeof(current_origin_data -> 'coordinates') <> 'object'
    or jsonb_typeof(current_origin_data -> 'observedAt') <> 'string'
    or jsonb_typeof(current_origin_data -> 'accuracyMeters') <> 'number'
    or jsonb_typeof(current_origin_data -> 'consent') <> 'object'
    or not (
      (current_origin_data -> 'coordinates') ?& array[
        'latitude', 'longitude'
      ]::text[]
    )
    or (current_origin_data -> 'coordinates') - array[
      'latitude', 'longitude'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(current_origin_data #> '{coordinates,latitude}')
      <> 'number'
    or jsonb_typeof(current_origin_data #> '{coordinates,longitude}')
      <> 'number'
    or not (
      (current_origin_data -> 'consent') ?& array[
        'kind', 'disclosureVersion', 'capturedAt'
      ]::text[]
    )
    or (current_origin_data -> 'consent') - array[
      'kind', 'disclosureVersion', 'capturedAt'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(current_origin_data #> '{consent,kind}') <> 'string'
    or jsonb_typeof(
      current_origin_data #> '{consent,disclosureVersion}'
    ) <> 'string'
    or jsonb_typeof(current_origin_data #> '{consent,capturedAt}')
      <> 'string'
    or current_origin_data ->> 'schemaVersion'
      <> 'storyops-dispatch-current-origin-v1'
    or current_origin_data ->> 'source' <> 'device_geolocation'
    or current_origin_data #>> '{consent,kind}' <> 'explicit_user_action'
    or current_origin_data #>> '{consent,disclosureVersion}'
      <> 'storyops-dispatch-origin-consent-v1'
    or coalesce(current_origin_data ->> 'readingId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    raise exception 'DISPATCH_CLEARANCE_CURRENT_ORIGIN_INVALID';
  end if;

  route_data := p_evidence -> 'route';
  route_request := route_data -> 'requestPayload';
  route_response := route_data -> 'responsePayload';
  if not (
      route_data ?& array[
        'provider', 'disposition', 'observedAt', 'expiresAt',
        'routeFeasible', 'driveMinutes', 'distanceMiles', 'violations',
        'requestPayload', 'responsePayload'
      ]::text[]
    )
    or route_data - array[
      'provider', 'disposition', 'observedAt', 'expiresAt',
      'routeFeasible', 'driveMinutes', 'distanceMiles', 'violations',
      'requestPayload', 'responsePayload'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(route_data -> 'provider') <> 'string'
    or jsonb_typeof(route_data -> 'disposition') <> 'string'
    or jsonb_typeof(route_data -> 'observedAt') <> 'string'
    or jsonb_typeof(route_data -> 'expiresAt') <> 'string'
    or jsonb_typeof(route_data -> 'routeFeasible') <> 'boolean'
    or jsonb_typeof(route_data -> 'driveMinutes') <> 'number'
    or jsonb_typeof(route_data -> 'distanceMiles') <> 'number'
    or jsonb_typeof(route_data -> 'violations') <> 'array'
    or jsonb_typeof(route_request) <> 'object'
    or jsonb_typeof(route_response) <> 'object'
    or (route_data ->> 'driveMinutes')::numeric
      not between 0 and 2147483647
    or (route_data ->> 'driveMinutes')::numeric
      <> trunc((route_data ->> 'driveMinutes')::numeric)
    or (route_data ->> 'distanceMiles')::numeric < 0
  then
    raise exception 'DISPATCH_CLEARANCE_ROUTE_INVALID';
  end if;

  if not (
      route_request ?& array[
        'schemaVersion', 'companyId', 'visitId', 'visitVersion',
        'jobId', 'jobVersion', 'propertyId', 'propertyVersion',
        'crewId', 'crewVersion', 'currentOriginHash', 'origin',
        'destination', 'departureAt', 'arrivalDeadline', 'visitWindow',
        'routingJobId'
      ]::text[]
    )
    or route_request - array[
      'schemaVersion', 'companyId', 'visitId', 'visitVersion',
      'jobId', 'jobVersion', 'propertyId', 'propertyVersion',
      'crewId', 'crewVersion', 'currentOriginHash', 'origin',
      'destination', 'departureAt', 'arrivalDeadline', 'visitWindow',
      'routingJobId'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(route_request -> 'schemaVersion') <> 'string'
    or jsonb_typeof(route_request -> 'companyId') <> 'string'
    or jsonb_typeof(route_request -> 'visitId') <> 'string'
    or jsonb_typeof(route_request -> 'visitVersion') <> 'number'
    or jsonb_typeof(route_request -> 'jobId') <> 'string'
    or jsonb_typeof(route_request -> 'jobVersion') <> 'number'
    or jsonb_typeof(route_request -> 'propertyId') <> 'string'
    or jsonb_typeof(route_request -> 'propertyVersion') <> 'number'
    or jsonb_typeof(route_request -> 'crewId') <> 'string'
    or jsonb_typeof(route_request -> 'crewVersion') <> 'number'
    or jsonb_typeof(route_request -> 'currentOriginHash') <> 'string'
    or jsonb_typeof(route_request -> 'origin') <> 'object'
    or jsonb_typeof(route_request -> 'destination') <> 'object'
    or jsonb_typeof(route_request -> 'departureAt') <> 'string'
    or jsonb_typeof(route_request -> 'arrivalDeadline') <> 'string'
    or jsonb_typeof(route_request -> 'visitWindow') <> 'object'
    or jsonb_typeof(route_request -> 'routingJobId') <> 'string'
    or not (
      (route_request -> 'origin') ?& array['latitude', 'longitude']::text[]
    )
    or (route_request -> 'origin') - array[
      'latitude', 'longitude'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(route_request #> '{origin,latitude}') <> 'number'
    or jsonb_typeof(route_request #> '{origin,longitude}') <> 'number'
    or not (
      (route_request -> 'destination') ?& array[
        'latitude', 'longitude'
      ]::text[]
    )
    or (route_request -> 'destination') - array[
      'latitude', 'longitude'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(route_request #> '{destination,latitude}') <> 'number'
    or jsonb_typeof(route_request #> '{destination,longitude}') <> 'number'
    or not (
      (route_request -> 'visitWindow') ?& array['start', 'end']::text[]
    )
    or (route_request -> 'visitWindow') - array[
      'start', 'end'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(route_request #> '{visitWindow,start}') <> 'string'
    or jsonb_typeof(route_request #> '{visitWindow,end}') <> 'string'
    or coalesce(route_request ->> 'currentOriginHash', '')
      !~ '^[a-f0-9]{64}$'
    or (route_request ->> 'visitVersion')::numeric
      not between 1 and 2147483647
    or (route_request ->> 'visitVersion')::numeric
      <> trunc((route_request ->> 'visitVersion')::numeric)
    or (route_request ->> 'jobVersion')::numeric
      not between 1 and 2147483647
    or (route_request ->> 'jobVersion')::numeric
      <> trunc((route_request ->> 'jobVersion')::numeric)
    or (route_request ->> 'propertyVersion')::numeric
      not between 1 and 2147483647
    or (route_request ->> 'propertyVersion')::numeric
      <> trunc((route_request ->> 'propertyVersion')::numeric)
    or (route_request ->> 'crewVersion')::numeric
      not between 1 and 2147483647
    or (route_request ->> 'crewVersion')::numeric
      <> trunc((route_request ->> 'crewVersion')::numeric)
  then
    raise exception 'DISPATCH_CLEARANCE_ROUTE_INVALID';
  end if;

  if not (
      route_response ?& array[
        'provider', 'mode', 'vehicleId', 'jobIds', 'unassignedJobIds',
        'travelSeconds', 'serviceSeconds', 'distanceMeters', 'summary'
      ]::text[]
    )
    or route_response - array[
      'provider', 'mode', 'vehicleId', 'jobIds', 'unassignedJobIds',
      'travelSeconds', 'serviceSeconds', 'distanceMeters', 'summary'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(route_response -> 'provider') <> 'string'
    or jsonb_typeof(route_response -> 'mode') <> 'string'
    or jsonb_typeof(route_response -> 'vehicleId') <> 'string'
    or jsonb_typeof(route_response -> 'jobIds') <> 'array'
    or jsonb_typeof(route_response -> 'unassignedJobIds') <> 'array'
    or jsonb_typeof(route_response -> 'travelSeconds') <> 'number'
    or jsonb_typeof(route_response -> 'serviceSeconds') <> 'number'
    or jsonb_typeof(route_response -> 'distanceMeters') <> 'number'
    or jsonb_typeof(route_response -> 'summary') <> 'object'
    or not (
      (route_response -> 'summary') ?& array[
        'travelSeconds', 'serviceSeconds', 'distanceMeters'
      ]::text[]
    )
    or (route_response -> 'summary') - array[
      'travelSeconds', 'serviceSeconds', 'distanceMeters'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(route_response #> '{summary,travelSeconds}') <> 'number'
    or jsonb_typeof(route_response #> '{summary,serviceSeconds}') <> 'number'
    or jsonb_typeof(route_response #> '{summary,distanceMeters}') <> 'number'
    or (route_response ->> 'travelSeconds')::numeric
      <> trunc((route_response ->> 'travelSeconds')::numeric)
    or (route_response ->> 'serviceSeconds')::numeric
      <> trunc((route_response ->> 'serviceSeconds')::numeric)
    or (route_response #>> '{summary,travelSeconds}')::numeric
      <> trunc((route_response #>> '{summary,travelSeconds}')::numeric)
    or (route_response #>> '{summary,serviceSeconds}')::numeric
      <> trunc((route_response #>> '{summary,serviceSeconds}')::numeric)
  then
    raise exception 'DISPATCH_CLEARANCE_ROUTE_INVALID';
  end if;

  weather_data := p_evidence -> 'weather';
  weather_policy := weather_data -> 'policy';
  if not (
      weather_data ?& array[
        'provider', 'disposition', 'observedAt', 'expiresAt',
        'forecastIssuedAt', 'periodStartsAt', 'periodEndsAt', 'temperatureF',
        'precipitationProbability', 'windSpeedMph', 'lightningRisk',
        'conditionCodes', 'policyVersion', 'policyHash', 'policy', 'payload'
      ]::text[]
    )
    or weather_data - array[
      'provider', 'disposition', 'observedAt', 'expiresAt',
      'forecastIssuedAt', 'periodStartsAt', 'periodEndsAt', 'temperatureF',
      'precipitationProbability', 'windSpeedMph', 'lightningRisk',
      'conditionCodes', 'policyVersion', 'policyHash', 'policy', 'payload'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(weather_data -> 'provider') <> 'string'
    or jsonb_typeof(weather_data -> 'disposition') <> 'string'
    or jsonb_typeof(weather_data -> 'observedAt') <> 'string'
    or jsonb_typeof(weather_data -> 'expiresAt') <> 'string'
    or jsonb_typeof(weather_data -> 'forecastIssuedAt') <> 'string'
    or jsonb_typeof(weather_data -> 'periodStartsAt') <> 'string'
    or jsonb_typeof(weather_data -> 'periodEndsAt') <> 'string'
    or jsonb_typeof(weather_data -> 'temperatureF') <> 'number'
    or jsonb_typeof(weather_data -> 'precipitationProbability') <> 'number'
    or jsonb_typeof(weather_data -> 'windSpeedMph') <> 'number'
    or jsonb_typeof(weather_data -> 'lightningRisk') <> 'string'
    or jsonb_typeof(weather_data -> 'conditionCodes') <> 'array'
    or jsonb_typeof(weather_data -> 'policyVersion') <> 'string'
    or jsonb_typeof(weather_data -> 'policyHash') <> 'string'
    or jsonb_typeof(weather_policy) <> 'object'
    or jsonb_typeof(weather_data -> 'payload') <> 'object'
    or char_length(weather_data ->> 'policyVersion') not between 1 and 128
    or coalesce(weather_data ->> 'policyHash', '') !~ '^[a-f0-9]{64}$'
    or jsonb_array_length(weather_data -> 'conditionCodes') > 40
    or exists (
      select 1
      from jsonb_array_elements(weather_data -> 'conditionCodes') code
      where jsonb_typeof(code) <> 'string'
        or char_length(code #>> '{}') not between 1 and 80
    )
  then
    raise exception 'DISPATCH_CLEARANCE_WEATHER_INVALID';
  end if;

  effective_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'actorUserId', p_actor_user_id,
    'companyId', p_company_id,
    'currentOrigin', current_origin_data,
    'expectedVisitVersion', (p_evidence ->> 'visitVersion')::integer,
    'idempotencyKey', p_idempotency_key,
    'schemaVersion', 'storyops-dispatch-clearance-request-v2',
    'visitId', p_evidence ->> 'visitId'
  ));
  if effective_request_hash <> p_request_hash then
    raise exception 'DISPATCH_CLEARANCE_REQUEST_HASH_MISMATCH';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-dispatch-clearance-refresh:'
      || p_company_id::text || ':' || p_idempotency_key,
    0
  ));
  select * into existing_row
  from public.dispatch_clearance_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.idempotency_key = p_idempotency_key;
  if existing_row.id is not null then
    if existing_row.schema_version <> 'storyops-dispatch-clearance-v2'
      or existing_row.request_hash <> p_request_hash
      or existing_row.visit_id::text <> p_evidence ->> 'visitId'
      or existing_row.visit_version <> (p_evidence ->> 'visitVersion')::integer
      or existing_row.created_by <> p_actor_user_id
      or existing_row.current_origin is distinct from current_origin_data
    then
      raise exception 'DISPATCH_CLEARANCE_IDEMPOTENCY_CONFLICT';
    end if;
    return public.storyops_dispatch_clearance_receipt_json(existing_row, true);
  end if;

  current_origin_observed_at_value :=
    (current_origin_data ->> 'observedAt')::timestamptz;
  current_origin_consent_at_value :=
    (current_origin_data #>> '{consent,capturedAt}')::timestamptz;
  current_origin_expires_at_value :=
    current_origin_observed_at_value + interval '2 minutes';
  current_origin_hash_value :=
    public.storyops_json_sha256(current_origin_data);
  visit_id_value := (p_evidence ->> 'visitId')::uuid;
  if (current_origin_data ->> 'readingId')::uuid is null
    or p_idempotency_key <>
      'dispatch:' || visit_id_value::text
        || ':v' || (p_evidence ->> 'visitVersion')
        || ':origin:' || (current_origin_data ->> 'readingId')
    or (current_origin_data #>> '{coordinates,latitude}')::numeric
      not between -90 and 90
    or (current_origin_data #>> '{coordinates,longitude}')::numeric
      not between -180 and 180
    or (current_origin_data ->> 'accuracyMeters')::numeric
      not between 0 and 100
    or not isfinite(current_origin_observed_at_value)
    or not isfinite(current_origin_consent_at_value)
    or current_origin_observed_at_value < now() - interval '2 minutes'
    or current_origin_observed_at_value > now() + interval '30 seconds'
    or current_origin_expires_at_value <= now()
    or current_origin_consent_at_value < now() - interval '2 minutes'
    or current_origin_consent_at_value > now() + interval '30 seconds'
    or current_origin_consent_at_value
      < current_origin_observed_at_value - interval '30 seconds'
    or current_origin_consent_at_value
      > current_origin_observed_at_value + interval '30 seconds'
  then
    raise exception 'DISPATCH_CLEARANCE_CURRENT_ORIGIN_STALE_OR_INACCURATE';
  end if;

  actor_role := private.storyops_dispatch_actor_authorized(
    p_company_id, p_actor_user_id, visit_id_value
  );

  select * into visit_row
  from public.visits visit
  where visit.company_id = p_company_id and visit.id = visit_id_value
  for update;
  select * into job_row
  from public.jobs job
  where job.company_id = p_company_id and job.id = visit_row.job_id;
  select * into property_row
  from public.properties property
  where property.company_id = p_company_id and property.id = job_row.property_id;
  select * into crew_row
  from public.crews crew
  where crew.company_id = p_company_id and crew.id = visit_row.crew_id;
  select * into company_row
  from public.companies company
  where company.id = p_company_id;
  select * into configuration_row
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.status = 'published';
  select * into baseline_row
  from public.company_operating_baseline_publications baseline
  where baseline.company_id = p_company_id
    and baseline.status = 'active';
  select * into scheduling_row
  from public.scheduling_evidence_receipts receipt
  where receipt.company_id = p_company_id
    and receipt.id = visit_row.scheduling_evidence_receipt_id;
  select * into scheduling_route_row
  from public.route_checks route
  where route.company_id = p_company_id
    and route.id = scheduling_row.route_check_id;

  if company_row.status <> 'active'
    or not private.storyops_launch_authorization_effective(p_company_id)
    or visit_row.status <> 'confirmed'
    or visit_row.version <> (p_evidence ->> 'visitVersion')::integer
    or visit_row.job_id <> (p_evidence ->> 'jobId')::uuid
    or visit_row.crew_id <> (p_evidence ->> 'crewId')::uuid
    or not isfinite((p_evidence ->> 'startsAt')::timestamptz)
    or visit_row.starts_at <> (p_evidence ->> 'startsAt')::timestamptz
    or not isfinite((p_evidence ->> 'endsAt')::timestamptz)
    or visit_row.ends_at <> (p_evidence ->> 'endsAt')::timestamptz
    or job_row.id is null
    or job_row.version <> (p_evidence ->> 'jobVersion')::integer
    or job_row.property_id <> (p_evidence ->> 'propertyId')::uuid
    or job_row.assigned_crew_id is distinct from visit_row.crew_id
    or job_row.status not in ('scheduled', 'in_progress')
    or property_row.id is null
    or not private.storyops_property_has_reviewed_geocode(
      p_company_id,
      property_row.id
    )
    or property_row.version <> (p_evidence ->> 'propertyVersion')::integer
    or not isfinite((p_evidence ->> 'propertyGeocodedAt')::timestamptz)
    or property_row.geocoded_at
      is distinct from (p_evidence ->> 'propertyGeocodedAt')::timestamptz
    or property_row.latitude is null
    or property_row.longitude is null
    or property_row.geocode_confidence is null
    or property_row.geocode_confidence < 0.8
    or crew_row.id is null
    or crew_row.version <> (p_evidence ->> 'crewVersion')::integer
  then
    raise exception 'DISPATCH_CLEARANCE_CURRENT_SCOPE_CONFLICT';
  end if;

  if configuration_row.id is null
    or configuration_row.publication_mode <> 'live'
    or configuration_row.revision <> (p_evidence ->> 'configurationRevision')::integer
    or configuration_row.configuration_hash <> p_evidence ->> 'configurationHash'
    or baseline_row.id is null
    or baseline_row.configuration_revision <> configuration_row.revision
    or baseline_row.configuration_hash <> configuration_row.configuration_hash
    or baseline_row.id
      <> (p_evidence ->> 'operatingBaselinePublicationId')::uuid
    or baseline_row.baseline_hash <> p_evidence ->> 'operatingBaselineHash'
  then
    raise exception 'DISPATCH_CLEARANCE_CONFIGURATION_CHANGED';
  end if;

  if scheduling_row.id is null
    or scheduling_route_row.id is null
    or scheduling_row.id
      <> (p_evidence ->> 'schedulingEvidenceReceiptId')::uuid
    or scheduling_row.company_id <> p_company_id
    or scheduling_row.job_id <> job_row.id
    or scheduling_row.property_id <> property_row.id
    or scheduling_row.crew_id <> crew_row.id
    or scheduling_row.starts_at <> visit_row.starts_at
    or scheduling_row.ends_at <> visit_row.ends_at
    or scheduling_row.evidence_mode <> 'live'
    or scheduling_row.configuration_revision <> configuration_row.revision
    or scheduling_row.operating_baseline_publication_id <> baseline_row.id
    or scheduling_row.route_disposition <> 'eligible'
    or scheduling_row.weather_disposition <> 'eligible'
    or cardinality(scheduling_row.unknowns) <> 0
    or jsonb_array_length(scheduling_row.conflicts) <> 0
    or scheduling_row.evidence_hash
      <> public.storyops_scheduling_evidence_hash(scheduling_row)
  then
    raise exception 'DISPATCH_CLEARANCE_BOOKING_BINDING_INVALID';
  end if;

  provider_bindings_value :=
    private.storyops_dispatch_provider_bindings(p_company_id);
  provider_snapshot_hash_value :=
    private.storyops_dispatch_provider_snapshot_hash(p_company_id);
  if jsonb_array_length(provider_bindings_value) <> 2
    or exists (
      select 1
      from jsonb_array_elements(provider_bindings_value) binding
      where (binding ->> 'ownerEnabled')::boolean is not true
        or binding ->> 'ownerMode' <> 'live'
        or binding ->> 'ownerStatus' <> 'healthy'
        or binding ->> 'environmentMode' <> 'live'
        or binding ->> 'environmentStatus' <> 'healthy'
        or (binding ->> 'environmentCheckedAt')::timestamptz
          < now() - interval '15 minutes'
        or (binding ->> 'environmentCheckedAt')::timestamptz
          > now() + interval '1 minute'
        or (binding ->> 'environmentExpiresAt')::timestamptz <= now()
        or (
          binding ->> 'provider' = 'nws'
          and (
            not ((binding -> 'capabilities') ? 'weather')
            or not ((binding -> 'environmentCapabilities') ? 'weather')
          )
        )
        or (
          binding ->> 'provider' = 'vroom'
          and (
            not ((binding -> 'capabilities') ? 'routing')
            or not ((binding -> 'environmentCapabilities') ? 'routing')
          )
        )
    )
    or p_evidence ->> 'providerSnapshotHash'
      <> provider_snapshot_hash_value
  then
    raise exception 'DISPATCH_CLEARANCE_PROVIDER_AUTHORITY_CHANGED';
  end if;

  route_data := p_evidence -> 'route';
  route_request := route_data -> 'requestPayload';
  route_response := route_data -> 'responsePayload';
  route_observed_at_value := (route_data ->> 'observedAt')::timestamptz;
  route_expires_at_value := (route_data ->> 'expiresAt')::timestamptz;
  if route_data ->> 'provider' <> 'vroom'
    or route_data ->> 'disposition' <> 'eligible'
    or route_data ->> 'routeFeasible' <> 'true'
    or jsonb_typeof(route_data -> 'violations') <> 'array'
    or jsonb_array_length(route_data -> 'violations') <> 0
    or not isfinite(route_observed_at_value)
    or not isfinite(route_expires_at_value)
    or route_observed_at_value < now() - interval '2 minutes'
    or route_observed_at_value > now() + interval '1 minute'
    or route_expires_at_value
      <> route_observed_at_value + interval '10 minutes'
    or route_expires_at_value <= now()
    or route_request ->> 'schemaVersion'
      <> 'storyops-dispatch-route-request-v2'
    or route_request ->> 'companyId' <> p_company_id::text
    or route_request ->> 'visitId' <> visit_row.id::text
    or (route_request ->> 'visitVersion')::integer <> visit_row.version
    or route_request ->> 'jobId' <> job_row.id::text
    or (route_request ->> 'jobVersion')::integer <> job_row.version
    or route_request ->> 'propertyId' <> property_row.id::text
    or (route_request ->> 'propertyVersion')::integer <> property_row.version
    or route_request ->> 'crewId' <> crew_row.id::text
    or (route_request ->> 'crewVersion')::integer <> crew_row.version
    or route_request ->> 'currentOriginHash' <> current_origin_hash_value
    or (route_request #>> '{origin,latitude}')::numeric
      <> (current_origin_data #>> '{coordinates,latitude}')::numeric
    or (route_request #>> '{origin,longitude}')::numeric
      <> (current_origin_data #>> '{coordinates,longitude}')::numeric
    or (route_request #>> '{destination,latitude}')::numeric
      <> property_row.latitude
    or (route_request #>> '{destination,longitude}')::numeric
      <> property_row.longitude
    or (route_request ->> 'departureAt')::timestamptz
      <> route_observed_at_value
    or not isfinite((route_request ->> 'departureAt')::timestamptz)
    or route_observed_at_value
      < current_origin_observed_at_value - interval '30 seconds'
    or route_observed_at_value
      > current_origin_observed_at_value + interval '2 minutes'
    or (route_request ->> 'arrivalDeadline')::timestamptz
      <> visit_row.starts_at
    or not isfinite((route_request ->> 'arrivalDeadline')::timestamptz)
    or (route_request #>> '{visitWindow,start}')::timestamptz
      <> visit_row.starts_at
    or not isfinite(
      (route_request #>> '{visitWindow,start}')::timestamptz
    )
    or (route_request #>> '{visitWindow,end}')::timestamptz
      <> visit_row.ends_at
    or not isfinite((route_request #>> '{visitWindow,end}')::timestamptz)
    or route_request ->> 'routingJobId'
      <> 'dispatch:' || visit_row.id::text
    or route_response ->> 'provider' <> 'vroom'
    or route_response ->> 'mode' <> 'live'
    or route_response ->> 'vehicleId' <> crew_row.id::text
    or route_response -> 'jobIds'
      <> jsonb_build_array('dispatch:' || visit_row.id::text)
    or route_response -> 'unassignedJobIds' <> '[]'::jsonb
    or (route_response ->> 'travelSeconds')::numeric < 0
    or (route_response ->> 'serviceSeconds')::numeric
      <> extract(epoch from (visit_row.ends_at - visit_row.starts_at))
    or (route_response ->> 'distanceMeters')::numeric < 0
    or (route_response #>> '{summary,travelSeconds}')::numeric
      <> (route_response ->> 'travelSeconds')::numeric
    or (route_response #>> '{summary,serviceSeconds}')::numeric
      <> (route_response ->> 'serviceSeconds')::numeric
    or (route_response #>> '{summary,distanceMeters}')::numeric
      <> (route_response ->> 'distanceMeters')::numeric
    or (route_data ->> 'driveMinutes')::integer
      <> ceil((route_response ->> 'travelSeconds')::numeric / 60)
    or (route_data ->> 'distanceMiles')::numeric
      <> round(
        (route_response ->> 'distanceMeters')::numeric / 1609.344,
        2
      )
  then
    raise exception 'DISPATCH_CLEARANCE_ROUTE_INVALID';
  end if;

  weather_data := p_evidence -> 'weather';
  weather_policy := weather_data -> 'policy';
  current_weather_policy := company_row.settings -> 'weatherPolicy'
    || jsonb_build_object(
      'reviewReference',
        configuration_row.configuration #>>
          '{policies,safetyReview,evidenceReference}',
      'reviewedAt',
        configuration_row.configuration #>>
          '{policies,safetyReview,reviewedAt}',
      'configurationRevision', configuration_row.revision
    );
  weather_observed_at_value := (weather_data ->> 'observedAt')::timestamptz;
  weather_expires_at_value := (weather_data ->> 'expiresAt')::timestamptz;
  if weather_data ->> 'provider' <> 'nws'
    or weather_data ->> 'disposition' <> 'eligible'
    or not isfinite(weather_observed_at_value)
    or not isfinite(weather_expires_at_value)
    or weather_observed_at_value < now() - interval '2 minutes'
    or weather_observed_at_value > now() + interval '1 minute'
    or weather_expires_at_value
      <> weather_observed_at_value + interval '20 minutes'
    or weather_expires_at_value <= now()
    or (weather_data ->> 'forecastIssuedAt')::timestamptz
      < now() - interval '6 hours'
    or not isfinite((weather_data ->> 'forecastIssuedAt')::timestamptz)
    or (weather_data ->> 'forecastIssuedAt')::timestamptz
      > now() + interval '2 minutes'
    or (weather_data ->> 'periodStartsAt')::timestamptz > visit_row.starts_at
    or not isfinite((weather_data ->> 'periodStartsAt')::timestamptz)
    or (weather_data ->> 'periodEndsAt')::timestamptz < visit_row.ends_at
    or not isfinite((weather_data ->> 'periodEndsAt')::timestamptz)
    or (weather_data ->> 'precipitationProbability')::numeric not between 0 and 1
    or (weather_data ->> 'windSpeedMph')::numeric < 0
    or weather_data ->> 'lightningRisk'
      not in ('none', 'low', 'elevated', 'severe', 'unknown')
    or weather_policy is distinct from current_weather_policy
    or weather_data ->> 'policyHash'
      <> public.storyops_json_sha256(weather_policy)
    or weather_data ->> 'policyVersion' <> coalesce(
      nullif(weather_policy ->> 'version', ''),
      'weather-policy-'
        || left(public.storyops_json_sha256(weather_policy), 32)
    )
  then
    raise exception 'DISPATCH_CLEARANCE_WEATHER_INVALID';
  end if;

  insert into public.route_checks(
    company_id, provider, checked_at, route_feasible, drive_minutes,
    added_distance_miles, violations, request_payload, response_payload
  )
  values (
    p_company_id, 'vroom', route_observed_at_value, true,
    (route_data ->> 'driveMinutes')::integer,
    (route_data ->> 'distanceMiles')::numeric,
    '{}', route_request, route_response
  )
  returning id into route_check_id_value;

  insert into public.weather_checks(
    company_id, property_id, provider, forecast_issued_at, checked_at,
    period_starts_at, period_ends_at, temperature_f,
    precipitation_probability, wind_speed_mph, lightning_risk,
    condition_codes, policy_disposition, raw_forecast
  )
  values (
    p_company_id, property_row.id, 'nws',
    (weather_data ->> 'forecastIssuedAt')::timestamptz,
    weather_observed_at_value,
    (weather_data ->> 'periodStartsAt')::timestamptz,
    (weather_data ->> 'periodEndsAt')::timestamptz,
    (weather_data ->> 'temperatureF')::numeric,
    (weather_data ->> 'precipitationProbability')::numeric,
    (weather_data ->> 'windSpeedMph')::numeric,
    weather_data ->> 'lightningRisk',
    array(select jsonb_array_elements_text(weather_data -> 'conditionCodes')),
    'eligible', weather_data -> 'payload'
  )
  returning id into weather_check_id_value;

  insert into public.dispatch_clearance_receipts(
    schema_version, company_id, visit_id, visit_version, job_id, job_version,
    property_id, property_version, property_geocoded_at,
    crew_id, crew_version, starts_at, ends_at, evidence_mode,
    configuration_revision, configuration_hash,
    operating_baseline_publication_id, operating_baseline_hash,
    scheduling_evidence_receipt_id, provider_snapshot_hash,
    provider_bindings, current_origin, current_origin_hash,
    current_origin_expires_at, route_check_id, route_disposition,
    route_observed_at, route_expires_at, route_request_hash,
    route_response_hash, weather_check_id, weather_disposition,
    weather_observed_at, weather_expires_at, weather_policy_version,
    weather_policy_hash, weather_payload_hash, unknowns, conflicts,
    expires_at, evidence_hash, idempotency_key, request_hash,
    trace_id, created_by
  )
  values (
    'storyops-dispatch-clearance-v2',
    p_company_id, visit_row.id, visit_row.version, job_row.id, job_row.version,
    property_row.id, property_row.version, property_row.geocoded_at,
    crew_row.id, crew_row.version, visit_row.starts_at, visit_row.ends_at, 'live',
    configuration_row.revision, configuration_row.configuration_hash,
    baseline_row.id, baseline_row.baseline_hash,
    scheduling_row.id, provider_snapshot_hash_value, provider_bindings_value,
    current_origin_data, current_origin_hash_value,
    current_origin_expires_at_value,
    route_check_id_value, 'eligible', route_observed_at_value,
    route_expires_at_value, public.storyops_json_sha256(route_request),
    public.storyops_json_sha256(route_response), weather_check_id_value,
    'eligible', weather_observed_at_value, weather_expires_at_value,
    weather_data ->> 'policyVersion', weather_data ->> 'policyHash',
    public.storyops_json_sha256(weather_data -> 'payload'),
    '{}', '[]'::jsonb,
    least(
      current_origin_expires_at_value,
      route_expires_at_value,
      weather_expires_at_value
    ),
    repeat('0', 64), p_idempotency_key, p_request_hash,
    nullif(btrim(p_evidence ->> 'traceId'), ''), p_actor_user_id
  )
  returning * into inserted_row;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id, retention_class, retain_until
  )
  values (
    p_company_id, 'user', p_actor_user_id::text,
    'visit.dispatch_clearance_refreshed', 'dispatch_clearance_receipt',
    inserted_row.id,
    jsonb_build_object(
      'visitId', inserted_row.visit_id,
      'visitVersion', inserted_row.visit_version,
      'currentOriginSource', current_origin_data ->> 'source',
      'currentOriginObservedAt', current_origin_observed_at_value,
      'currentOriginAccuracyMeters',
        (current_origin_data ->> 'accuracyMeters')::numeric,
      'currentOriginHash', current_origin_hash_value,
      'routeCheckId', inserted_row.route_check_id,
      'weatherCheckId', inserted_row.weather_check_id,
      'expiresAt', inserted_row.expires_at,
      'actorRole', actor_role
    ),
    p_idempotency_key, 'audit', now() + interval '7 years'
  );

  return public.storyops_dispatch_clearance_receipt_json(inserted_row, false);
end;
$$;

-- Fail closed at the transaction boundary as well as in the consume RPC.
-- Any pre-migration/no-origin receipt is unusable after this migration.
create or replace function public.enforce_storyops_dispatch_current_origin_consumption()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  receipt_row public.dispatch_clearance_receipts%rowtype;
  route_row public.route_checks%rowtype;
begin
  select * into receipt_row
  from public.dispatch_clearance_receipts receipt
  where receipt.company_id = new.company_id
    and receipt.id = new.clearance_receipt_id;
  select * into route_row
  from public.route_checks route
  where route.company_id = new.company_id
    and route.id = receipt_row.route_check_id;

  if receipt_row.id is null
    or receipt_row.schema_version <> 'storyops-dispatch-clearance-v2'
    or receipt_row.current_origin is null
    or receipt_row.current_origin_hash is null
    or receipt_row.current_origin_expires_at is null
    or receipt_row.current_origin_expires_at <= now()
    or receipt_row.expires_at > receipt_row.current_origin_expires_at
    or receipt_row.current_origin_hash
      <> public.storyops_json_sha256(receipt_row.current_origin)
    or receipt_row.evidence_hash
      <> public.storyops_dispatch_clearance_hash(receipt_row)
    or jsonb_typeof(receipt_row.current_origin) is distinct from 'object'
    or not (
      receipt_row.current_origin ?& array[
        'schemaVersion', 'readingId', 'source', 'coordinates',
        'observedAt', 'accuracyMeters', 'consent'
      ]::text[]
    )
    or jsonb_typeof(receipt_row.current_origin -> 'coordinates')
      is distinct from 'object'
    or not (
      (receipt_row.current_origin -> 'coordinates') ?& array[
        'latitude', 'longitude'
      ]::text[]
    )
    or jsonb_typeof(
      receipt_row.current_origin #> '{coordinates,latitude}'
    ) is distinct from 'number'
    or jsonb_typeof(
      receipt_row.current_origin #> '{coordinates,longitude}'
    ) is distinct from 'number'
    or route_row.id is null
    or jsonb_typeof(route_row.request_payload) is distinct from 'object'
    or not (
      route_row.request_payload ?& array[
        'schemaVersion', 'currentOriginHash', 'origin'
      ]::text[]
    )
    or jsonb_typeof(route_row.request_payload -> 'schemaVersion')
      is distinct from 'string'
    or jsonb_typeof(route_row.request_payload -> 'currentOriginHash')
      is distinct from 'string'
    or jsonb_typeof(route_row.request_payload -> 'origin')
      is distinct from 'object'
    or not (
      (route_row.request_payload -> 'origin') ?& array[
        'latitude', 'longitude'
      ]::text[]
    )
    or jsonb_typeof(route_row.request_payload #> '{origin,latitude}')
      is distinct from 'number'
    or jsonb_typeof(route_row.request_payload #> '{origin,longitude}')
      is distinct from 'number'
    or route_row.request_payload ->> 'schemaVersion'
      <> 'storyops-dispatch-route-request-v2'
    or route_row.request_payload ->> 'currentOriginHash'
      <> receipt_row.current_origin_hash
    or (route_row.request_payload #>> '{origin,latitude}')::numeric
      <> (receipt_row.current_origin #>> '{coordinates,latitude}')::numeric
    or (route_row.request_payload #>> '{origin,longitude}')::numeric
      <> (receipt_row.current_origin #>> '{coordinates,longitude}')::numeric
  then
    raise exception 'DISPATCH_CLEARANCE_CURRENT_ORIGIN_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger dispatch_clearance_consumption_current_origin_guard
before insert on public.dispatch_clearance_consumptions
for each row execute function
  public.enforce_storyops_dispatch_current_origin_consumption();

revoke all on function public.record_storyops_dispatch_clearance(
  uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_storyops_dispatch_clearance(
  uuid, uuid, text, text, jsonb
) to service_role;

comment on column public.dispatch_clearance_receipts.current_origin is
  'Consented device departure coordinate, accuracy, observation, and consent timestamp retained in the immutable operational receipt under company retention policy.';
comment on function public.record_storyops_dispatch_clearance(
  uuid, uuid, text, text, jsonb
) is
  'Trusted v2 recorder binding an exact actor/visit request to fresh current-origin, VROOM, NWS, configuration, and baseline evidence.';
