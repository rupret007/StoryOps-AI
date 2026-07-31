\set ON_ERROR_STOP on

-- Fixture-backed database command contract only.
--
-- This suite directly arranges payment, geocode, provider-canary, scheduling,
-- and field-completion prerequisites so it can verify checkout preparation,
-- receipt-bound booking, invoice issuance, authorization, audit, and exact
-- replay behavior inside PostgreSQL. It does not prove that Stripe, Google
-- Calendar, maps, NWS, VROOM, Storage, or a field client produced those facts,
-- and it is not the lead-to-recurring golden path. The no-key full synthetic
-- product rehearsal is tests/e2e/golden-path.spec.ts.

begin;

delete from public.dispatch_assignments
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.visit_checklist_items
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.visits
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.payments
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.invoice_lines
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.invoices
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.jobs
where company_id = '10000000-0000-4000-8000-000000000001';

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  company_id_value constant uuid := '10000000-0000-4000-8000-000000000001';
  owner_user_id constant uuid := '10000000-0000-4000-8000-000000000101';
  customer_user_id constant uuid := '10000000-0000-4000-8000-000000000104';
  dispatcher_user_id constant uuid := '10000000-0000-4000-8000-000000000102';
  technician_user_id constant uuid := '10000000-0000-4000-8000-000000000103';
  deployment_fingerprint_value constant text := repeat('8', 64);
  quote_id_value constant uuid := '10000000-0000-4000-8000-000000000521';
  checkout_command_id constant uuid := '91000000-0000-4000-8000-000000000001';
  booking_command_id constant uuid := '91000000-0000-4000-8000-000000000002';
  invoice_command_id constant uuid := '91000000-0000-4000-8000-000000000003';
  claim jsonb;
  response jsonb;
  booking jsonb;
  replay jsonb;
  issuance jsonb;
  job_id_value uuid;
  invoice_id_value uuid;
  payment_id_value uuid;
  visit_id_value uuid;
  property_id_value uuid;
  crew_id_value uuid := '10000000-0000-4000-8000-000000000601';
  scheduling_receipt_id_value uuid;
  configuration_id_value uuid := '91000000-0000-4000-8000-000000000031';
  baseline_id_value uuid := '91000000-0000-4000-8000-000000000032';
  job_version_value integer;
  property_version_value integer;
  invoice_version_value integer;
  visit_version_value integer;
  estimate_duration_minutes integer;
  booking_starts_at timestamptz;
  booking_ends_at timestamptz;
  receipt jsonb;
  scheduling_evidence jsonb;
  booking_payload jsonb;
  invoice_payload jsonb;
  scheduling_request_hash text;
  booking_request_hash text;
  invoice_request_hash text;
  geocode_address_hash text;
  geocode_lookup_hash text;
  probe_run_id_value uuid;
  provider_record record;
  launch_command_id_value uuid;
  launch_version_value integer;
  launch_request_hash_value text;
  verifier_run_receipt jsonb;
  verifier_completion_receipt jsonb;
  field_verifier_receipt jsonb;
  field_verifier_claim jsonb;
  field_verifier_payload jsonb;
  launch_receipt jsonb;
  worker_name text;
  worker_configuration_hash text;
  worker_payload jsonb := '[]'::jsonb;
begin
  claim := public.prepare_storyops_deposit_checkout(
    company_id_value,
    customer_user_id,
    checkout_command_id,
    quote_id_value,
    1
  );
  if claim ->> 'claimStatus' <> 'reserved'
    or claim ->> 'amount' <> '132.00'
    or claim ->> 'providerIdempotencyKey'
      <> 'storyops:deposit:' || quote_id_value::text || ':attempt:1'
  then
    raise exception 'Checkout preparation contract failed: %', claim;
  end if;

  job_id_value := (claim ->> 'jobId')::uuid;
  invoice_id_value := (claim ->> 'invoiceId')::uuid;
  payment_id_value := (claim ->> 'paymentId')::uuid;

  begin
    perform public.prepare_storyops_deposit_checkout(
      company_id_value,
      technician_user_id,
      '91000000-0000-4000-8000-000000000011',
      quote_id_value,
      1
    );
    raise exception 'Technician checkout unexpectedly succeeded';
  exception
    when others then
      if sqlerrm not like '%EDGE_ACTOR_FORBIDDEN%' then
        raise;
      end if;
  end;

  response := jsonb_build_object(
    'action', 'deposit.checkout',
    'status', 'checkout_open',
    'mode', 'sandbox',
    'quoteId', quote_id_value,
    'jobId', job_id_value,
    'invoiceId', invoice_id_value,
    'amount', '132.00',
    'currency', 'USD',
    'paymentVerified', false,
    'depositReady', false,
    'replayed', false,
    'checkoutId', 'cs_golden_path_test',
    'sandboxReceipt', 'Sandbox only; no payment success.'
  );
  perform public.complete_storyops_deposit_checkout(
    company_id_value,
    checkout_command_id,
    claim ->> 'requestHash',
    payment_id_value,
    'cs_golden_path_test',
    response
  );

  claim := public.prepare_storyops_deposit_checkout(
    company_id_value,
    customer_user_id,
    checkout_command_id,
    quote_id_value,
    1
  );
  if claim ->> 'claimStatus' <> 'completed'
    or claim -> 'storedResponse' ->> 'paymentVerified' <> 'false'
  then
    raise exception 'Checkout replay contract failed: %', claim;
  end if;

  select version
  into job_version_value
  from public.jobs
  where id = job_id_value;

  perform set_config('request.jwt.claim.sub', dispatcher_user_id::text, true);
  if (
    select status
    from public.jobs
    where id = job_id_value
  ) <> 'pending_deposit' then
    raise exception 'Unverified checkout unexpectedly made the job schedulable';
  end if;

  update public.payments
  set
    status = 'succeeded',
    provider_payment_id = 'pi_golden_path_test',
    provider_amount_received = 132.00,
    allocation_status = 'applied',
    processed_at = now()
  where id = payment_id_value;

  receipt := jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'stripe',
    'eventId', 'evt_golden_path_test',
    'eventType', 'checkout.session.completed',
    'objectId', 'cs_golden_path_test',
    'objectKind', 'checkout',
    'action', 'payment_succeeded',
    'companyId', company_id_value,
    'occurredAt', now()::text,
    'quoteId', quote_id_value,
    'checkoutPurpose', 'quote_deposit',
    'checkoutAttempt', 1,
    'paymentIntentId', 'pi_golden_path_test',
    'amountCents', 13200,
    'currency', 'usd'
  );
  insert into public.webhook_events(
    id, company_id, provider, provider_event_id, event_type, status,
    payload_hash, payload, processed_at
  )
  values (
    '91000000-0000-4000-8000-000000000021',
    company_id_value,
    'stripe',
    'evt_golden_path_test',
    'checkout.session.completed',
    'processed',
    encode(extensions.digest(receipt::text, 'sha256'), 'hex'),
    receipt,
    now()
  );

  if not public.storyops_payment_has_provider_proof(payment_id_value, quote_id_value) then
    raise exception 'Processed provider evidence did not verify the deposit';
  end if;
  if (
    select status
    from public.jobs
    where id = job_id_value
  ) <> 'ready_to_schedule' then
    raise exception 'Verified deposit did not make the job ready';
  end if;

  select
    job.version,
    job.property_id,
    estimate.duration_minutes
  into
    job_version_value,
    property_id_value,
    estimate_duration_minutes
  from public.jobs job
  join public.quotes quote on quote.id = job.quote_id
  join public.estimates estimate on estimate.id = quote.estimate_id
  where job.id = job_id_value;

  select
    property.version,
    public.storyops_json_sha256(property.service_address)
  into property_version_value, geocode_address_hash
  from public.properties property
  where property.company_id = company_id_value
    and property.id = property_id_value;
  geocode_lookup_hash := public.storyops_json_sha256(jsonb_build_object(
    'schemaVersion', 'storyops-property-geocode-lookup-v1',
    'operationId', '91000000-0000-4000-8000-000000000041'::uuid,
    'propertyId', property_id_value,
    'propertyVersion', property_version_value
  ));
  perform public.record_storyops_property_geocode_candidates(
    company_id_value,
    dispatcher_user_id,
    property_id_value,
    property_version_value,
    '91000000-0000-4000-8000-000000000041',
    geocode_address_hash,
    jsonb_build_array(jsonb_build_object(
      'id', '91000000-0000-4000-8000-000000000042'::uuid,
      'provider', 'google_maps',
      'mode', 'live',
      'formattedAddress', '4100 Cedar Springs Rd, Dallas, TX 75219, USA',
      'latitude', 32.8119000,
      'longitude', -96.8098000,
      'precision', 'rooftop',
      'confidence', 0.9900,
      'providerPlaceId', 'live-golden-path-reviewed-property',
      'observedAt', date_trunc('milliseconds', now())
    )),
    geocode_lookup_hash
  );
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claim.sub',
    dispatcher_user_id::text,
    true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', dispatcher_user_id,
      'role', 'authenticated'
    )::text,
    true
  );
  perform public.confirm_storyops_property_geocode_candidate(
    company_id_value,
    '91000000-0000-4000-8000-000000000043',
    property_id_value,
    property_version_value,
    '91000000-0000-4000-8000-000000000042',
    public.storyops_json_sha256(jsonb_build_object(
      'action', 'property.geocode.confirm',
      'propertyId', property_id_value,
      'propertyVersion', property_version_value,
      'candidateId', '91000000-0000-4000-8000-000000000042'::uuid
    ))
  );
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claim.sub',
    customer_user_id::text,
    true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', customer_user_id,
      'role', 'service_role'
    )::text,
    true
  );
  if not private.storyops_property_has_reviewed_geocode(
    company_id_value,
    property_id_value
  ) then
    raise exception 'Golden path fixture did not establish reviewed geocode proof';
  end if;

  booking_starts_at := date_trunc('minute', now() + interval '2 hours');
  booking_ends_at := booking_starts_at
    + make_interval(mins => estimate_duration_minutes);

  insert into public.company_configuration_versions(
    id, company_id, revision, schema_version, status, publication_mode,
    configuration, configuration_hash, review_reference, created_by,
    published_by, published_at
  )
  values (
    configuration_id_value,
    company_id_value,
    1,
    'storyops-company-config-v1',
    'published',
    'live',
    jsonb_build_object(
      'schemaVersion', 'storyops-company-config-v1',
      'testFixture', 'live-golden-path-provider-contract',
      'territory', jsonb_build_object(
        'travelZones', jsonb_build_array(jsonb_build_object(
          'code', 'DFW-CORE',
          'name', 'Reviewed fixture zone',
          'maximumMiles', '',
          'fee', '0.00',
          'postalCodes', jsonb_build_array('75219')
        )),
        'travelZoneMappingReview', jsonb_build_object(
          'status', 'approved',
          'reviewer', 'Golden path fixture reviewer',
          'reviewedAt', '2026-07-29T12:00:00.000Z',
          'evidenceReference', 'golden-path-travel-zone-review'
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
    repeat('a', 64),
    'TEST-LIVE-PROVIDER-CONTRACT',
    dispatcher_user_id,
    dispatcher_user_id,
    now()
  );

  insert into public.company_operating_baseline_publications(
    id, company_id, configuration_version_id, configuration_revision,
    configuration_hash, price_book_id, service_terms_id,
    retention_policy_id, baseline_hash, status, review_reference,
    activated_by, command_id, request_hash
  )
  values (
    baseline_id_value,
    company_id_value,
    configuration_id_value,
    1,
    repeat('a', 64),
    '10000000-0000-4000-8000-000000000401',
    '10000000-0000-4000-8000-000000000152',
    '10000000-0000-4000-8000-000000000151',
    repeat('b', 64),
    'active',
    'TEST-LIVE-PROVIDER-CONTRACT',
    dispatcher_user_id,
    '91000000-0000-4000-8000-000000000033',
    repeat('c', 64)
  );

  -- Exercise the same launch authority required in production. Provider
  -- environment probes, owner activations, verifier-backed canaries, and the
  -- owner launch decision are all real; no private gate is mocked.
  probe_run_id_value := gen_random_uuid();
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );
  perform public.record_storyops_integration_environment_probe(
    company_id_value,
    owner_user_id,
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
  perform set_config('request.jwt.claim.sub', owner_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', owner_user_id,
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
    launch_command_id_value := gen_random_uuid();
    launch_request_hash_value := encode(extensions.digest(
      array_to_string(array[
        'storyops-provider-activation-v1',
        provider_record.provider,
        provider_record.version::text,
        'live'
      ], chr(31)),
      'sha256'
    ), 'hex');
    perform public.set_storyops_provider_activation(
      company_id_value,
      launch_command_id_value,
      provider_record.provider,
      provider_record.version,
      'live',
      launch_request_hash_value
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
    launch_command_id_value := gen_random_uuid();
    launch_request_hash_value := public.storyops_json_sha256(
      jsonb_build_object(
        'kind', 'provider_canary',
        'provider', provider_record.provider,
        'capability', provider_record.capability,
        'commandId', launch_command_id_value
      )
    );
    verifier_run_receipt :=
      public.reserve_storyops_trusted_pilot_verification(
        company_id_value,
        owner_user_id,
        launch_command_id_value,
        'provider_canary',
        provider_record.provider,
        provider_record.capability,
        launch_request_hash_value
      );
    if verifier_run_receipt ->> 'execute' <> 'true' then
      raise exception 'Provider verifier run was not executable: %',
        verifier_run_receipt;
    end if;
    verifier_completion_receipt :=
      public.complete_storyops_provider_canary_verification(
        (verifier_run_receipt ->> 'runId')::uuid,
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
    if verifier_completion_receipt ->> 'status' <> 'verified' then
      raise exception 'Provider verifier run did not verify: %',
        verifier_completion_receipt;
    end if;
    perform public.record_storyops_trusted_pilot_proof(
      (verifier_run_receipt ->> 'runId')::uuid
    );
  end loop;

  launch_command_id_value := gen_random_uuid();
  verifier_run_receipt :=
    public.reserve_storyops_trusted_pilot_verification(
      company_id_value,
      owner_user_id,
      launch_command_id_value,
      'backup_restore',
      null,
      'isolated_database_restore',
      public.storyops_json_sha256(jsonb_build_object(
        'kind', 'backup_restore',
        'commandId', launch_command_id_value
      ))
    );
  if verifier_run_receipt ->> 'execute' <> 'true' then
    raise exception 'Restore verifier run was not executable: %',
      verifier_run_receipt;
  end if;
  verifier_completion_receipt :=
    public.complete_storyops_restore_verification(
      (verifier_run_receipt ->> 'runId')::uuid,
      repeat('b', 64)
    );
  if verifier_completion_receipt ->> 'status' <> 'verified' then
    raise exception 'Restore verifier run did not verify: %',
      verifier_completion_receipt;
  end if;
  perform public.record_storyops_trusted_pilot_proof(
    (verifier_run_receipt ->> 'runId')::uuid
  );

  launch_command_id_value := gen_random_uuid();
  field_verifier_receipt :=
    public.reserve_storyops_field_media_verification(
      company_id_value,
      owner_user_id,
      launch_command_id_value,
      technician_user_id,
      public.storyops_json_sha256(jsonb_build_object(
        'kind', 'field_media_canary',
        'commandId', launch_command_id_value,
        'fieldWorkerUserId', technician_user_id
      ))
    );
  if field_verifier_receipt ->> 'status' <> 'awaiting_field_worker' then
    raise exception 'Field-media verifier was not reserved: %',
      field_verifier_receipt;
  end if;
  field_verifier_claim := public.claim_storyops_field_media_verification(
    company_id_value,
    technician_user_id,
    (field_verifier_receipt ->> 'runId')::uuid,
    gen_random_uuid(),
    public.storyops_json_sha256(jsonb_build_object(
      'runId', field_verifier_receipt ->> 'runId',
      'action', 'claim'
    ))
  );
  if field_verifier_claim ->> 'execute' <> 'true'
    or field_verifier_claim ->> 'status' <> 'executing'
  then
    raise exception 'Field-media verifier was not claimed: %',
      field_verifier_claim;
  end if;
  insert into storage.objects(
    id, bucket_id, name, owner, owner_id, metadata
  )
  values (
    gen_random_uuid(),
    'job-media',
    field_verifier_claim ->> 'objectPath',
    technician_user_id,
    technician_user_id::text,
    jsonb_build_object('size', 68, 'mimetype', 'image/png')
  );
  field_verifier_payload := jsonb_build_object(
    'entityId', field_verifier_claim ->> 'mediaAssetId',
    'visitId', field_verifier_claim ->> 'visitId',
    'jobId', field_verifier_claim ->> 'jobId',
    'propertyId', field_verifier_claim ->> 'propertyId',
    'purpose', 'before',
    'objectPath', field_verifier_claim ->> 'objectPath',
    'contentType', 'image/png',
    'byteSize', 68,
    'checksumSha256',
      '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460',
    'capturedAt', field_verifier_claim ->> 'mediaCapturedAt',
    'customerVisible', false
  );
  perform public.finalize_storyops_media_upload_from_edge(
    company_id_value,
    (field_verifier_claim ->> 'mediaCommandId')::uuid,
    technician_user_id,
    field_verifier_payload,
    public.storyops_json_sha256(jsonb_build_object(
      'commandType', 'media.register',
      'expectedVersion', 0,
      'payload', field_verifier_payload
    ))
  );
  verifier_completion_receipt :=
    public.complete_storyops_field_media_verification(
      (field_verifier_receipt ->> 'runId')::uuid,
      deployment_fingerprint_value
    );
  if verifier_completion_receipt ->> 'status' <> 'verified' then
    raise exception 'Field-media verifier run did not verify: %',
      verifier_completion_receipt;
  end if;
  perform public.record_storyops_trusted_pilot_proof(
    (field_verifier_receipt ->> 'runId')::uuid
  );

  foreach worker_name in array array[
    'post_service',
    'transactional_outbound',
    'scheduling_reconciliation',
    'scope_photo_cleanup'
  ]::text[] loop
    worker_configuration_hash := encode(
      extensions.digest(
        worker_name || ':fixture-backed-golden-path',
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
      owner_user_id,
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
  perform set_config('request.jwt.claim.sub', owner_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', owner_user_id,
      'role', 'authenticated'
    )::text,
    true
  );
  launch_version_value :=
    private.storyops_current_launch_version(company_id_value);
  launch_command_id_value := gen_random_uuid();
  launch_request_hash_value := encode(extensions.digest(
    array_to_string(array[
      'storyops-launch-authorization-v1',
      'authorize',
      launch_version_value::text,
      'TEST-LIVE-GOLDEN-LAUNCH-REVIEW'
    ], chr(31)),
    'sha256'
  ), 'hex');
  launch_receipt := public.set_storyops_company_launch_authorization(
    company_id_value,
    launch_command_id_value,
    launch_version_value,
    'authorize',
    'TEST-LIVE-GOLDEN-LAUNCH-REVIEW',
    launch_request_hash_value
  );
  if launch_receipt ->> 'launchAuthorized' <> 'true'
    or not private.storyops_launch_authorization_effective(company_id_value)
  then
    raise exception 'Golden path launch authority is not effective: %',
      launch_receipt;
  end if;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claim.sub',
    dispatcher_user_id::text,
    true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', dispatcher_user_id,
      'role', 'service_role'
    )::text,
    true
  );

  scheduling_evidence := jsonb_build_object(
    'schemaVersion', 'storyops-scheduling-evidence-input-v1',
    'evidenceMode', 'live',
    'jobId', job_id_value,
    'jobVersion', job_version_value,
    'propertyId', property_id_value,
    'crewId', crew_id_value,
    'crewVersion', (
      select version from public.crews where id = crew_id_value
    ),
    'startsAt', booking_starts_at,
    'endsAt', booking_ends_at,
    'configurationRevision', 1,
    'operatingBaselinePublicationId', baseline_id_value,
    'capacity', jsonb_build_object(
      'provider', 'google_calendar',
      'reference', 'gcal-event-live-golden-path',
      'disposition', 'eligible',
      'observedAt', now(),
      'expiresAt', now() + interval '10 minutes',
      'calendarEventId',
        private.storyops_calendar_event_id('live-golden-path-evidence:calendar'),
      'calendarEventStatus', 'confirmed',
      'calendarEventEtag', 'etag-live-golden-path',
      'calendarReconciledAt', now(),
      'payload', jsonb_build_object(
        'schemaVersion', 'storyops-capacity-evidence-v1',
        'companyId', company_id_value,
        'jobId', job_id_value,
        'propertyId', property_id_value,
        'crewId', crew_id_value,
        'startsAt', booking_starts_at,
        'endsAt', booking_ends_at,
        'mode', 'live',
        'capacity', jsonb_build_object(
          'disposition', 'eligible',
          'eligibleCrewIds', jsonb_build_array(crew_id_value),
          'requiredSkillCodes', jsonb_build_array(),
          'requiredEquipmentTypes', jsonb_build_array(),
          'unknowns', jsonb_build_array(),
          'conflicts', jsonb_build_array()
        ),
        'freeBusy', jsonb_build_object(
          'disposition', 'eligible',
          'sourceCalendarIds', jsonb_build_array('operations@test.invalid'),
          'busyWindows', jsonb_build_array(),
          'unknowns', jsonb_build_array(),
          'conflicts', jsonb_build_array()
        ),
        'busy', false,
        'readBackConfirmed', true,
        'eventId',
          private.storyops_calendar_event_id('live-golden-path-evidence:calendar'),
        'eventStatus', 'confirmed',
        'eventEtag', 'etag-live-golden-path'
      ),
      'calendarPayload', jsonb_build_object(
        'id', private.storyops_calendar_event_id(
          'live-golden-path-evidence:calendar'
        ),
        'status', 'confirmed',
        'etag', 'etag-live-golden-path'
      )
    ),
    'route', jsonb_build_object(
      'provider', 'vroom',
      'disposition', 'eligible',
      'observedAt', now(),
      'expiresAt', now() + interval '20 minutes',
      'routeFeasible', true,
      'driveMinutes', 18,
      'addedDistanceMiles', 6.2,
      'violations', jsonb_build_array(),
      'requestPayload', jsonb_build_object(
        'jobId', job_id_value,
        'propertyId', property_id_value,
        'crewId', crew_id_value,
        'startsAt', booking_starts_at,
        'endsAt', booking_ends_at
      ),
      'responsePayload', jsonb_build_object(
        'provider', 'vroom',
        'feasible', true,
        'driveMinutes', 18
      )
    ),
    'weather', jsonb_build_object(
      'provider', 'nws',
      'disposition', 'eligible',
      'observedAt', now(),
      'expiresAt', now() + interval '40 minutes',
      'forecastIssuedAt', now() - interval '5 minutes',
      'periodStartsAt', booking_starts_at - interval '1 hour',
      'periodEndsAt', booking_ends_at + interval '1 hour',
      'temperatureF', 78,
      'precipitationProbability', 0.1,
      'windSpeedMph', 7,
      'lightningRisk', 'none',
      'conditionCodes', jsonb_build_array('clear'),
      'policyVersion', 'weather-policy-test-v1',
      'policy', jsonb_build_object(
        'maxWindMph', 20,
        'maxPrecipitationProbability', 0.5,
        'lightningAllowed', false
      ),
      'payload', jsonb_build_object(
        'gridpoint', 'FWD/80,107',
        'forecastId', 'test-live-golden-path'
      )
    ),
    'unknowns', jsonb_build_array(),
    'conflicts', jsonb_build_array(),
    'traceId', 'live-golden-path-sql'
  );

  scheduling_request_hash := public.storyops_json_sha256(
    jsonb_build_object(
      'actorUserId', dispatcher_user_id,
      'companyId', company_id_value,
      'evidence', scheduling_evidence,
      'idempotencyKey', 'live-golden-path-evidence'
    )
  );
  receipt := public.record_storyops_scheduling_evidence(
    company_id_value,
    dispatcher_user_id,
    'live-golden-path-evidence',
    scheduling_request_hash,
    scheduling_evidence
  );
  scheduling_receipt_id_value := (receipt ->> 'receiptId')::uuid;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claim.sub',
    dispatcher_user_id::text,
    true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', dispatcher_user_id,
      'role', 'authenticated'
    )::text,
    true
  );

  booking_payload := jsonb_build_object(
    'entityId', job_id_value,
    'schedulingEvidenceReceiptId', scheduling_receipt_id_value
  );
  booking_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'commandType', 'job.book',
    'expectedVersion', job_version_value,
    'payload', booking_payload
  ));
  booking := public.execute_storyops_golden_path_command(
    company_id_value,
    booking_command_id,
    'job.book',
    job_version_value,
    booking_payload,
    booking_request_hash
  );
  if booking ->> 'status' <> 'applied'
    or booking ->> 'crewId' is null
    or booking ->> 'routeCheckId' is null
    or booking ->> 'weatherCheckId' is null
  then
    raise exception 'Capacity-aware booking failed: %', booking;
  end if;
  visit_id_value := (booking ->> 'entityId')::uuid;

  replay := public.execute_storyops_golden_path_command(
    company_id_value,
    booking_command_id,
    'job.book',
    job_version_value,
    booking_payload,
    booking_request_hash
  );
  if replay ->> 'replayed' <> 'true'
    or replay ->> 'entityId' <> visit_id_value::text
  then
    raise exception 'Booking did not replay exactly: %', replay;
  end if;

  if exists (
    select 1
    from public.visits left_visit
    join public.visits right_visit
      on right_visit.crew_id = left_visit.crew_id
      and right_visit.id > left_visit.id
      and right_visit.starts_at < left_visit.ends_at
      and right_visit.ends_at > left_visit.starts_at
      and right_visit.status <> 'cancelled'
    where left_visit.company_id = company_id_value
      and left_visit.status <> 'cancelled'
  ) then
    raise exception 'Booking created a crew overlap';
  end if;

  update public.visits
  set status = 'completed'
  where id = visit_id_value;
  update public.jobs
  set status = 'completed'
  where id = job_id_value;

  select version
  into job_version_value
  from public.jobs
  where id = job_id_value;
  select version
  into visit_version_value
  from public.visits
  where id = visit_id_value;
  select version
  into invoice_version_value
  from public.invoices
  where id = invoice_id_value;

  invoice_payload := jsonb_build_object(
    'entityId', job_id_value,
    'invoiceId', invoice_id_value,
    'invoiceVersion', invoice_version_value,
    'visitId', visit_id_value,
    'visitVersion', visit_version_value
  );
  invoice_request_hash := public.storyops_json_sha256(jsonb_build_object(
    'commandType', 'invoice.issue',
    'expectedVersion', job_version_value,
    'payload', invoice_payload
  ));
  issuance := public.execute_storyops_golden_path_command(
    company_id_value,
    invoice_command_id,
    'invoice.issue',
    job_version_value,
    invoice_payload,
    invoice_request_hash
  );
  if issuance ->> 'status' <> 'applied'
    or issuance ->> 'amountPaid' <> '132.00'
    or issuance ->> 'balanceDue' <> '396.00'
  then
    raise exception 'Completion-backed invoice issuance failed: %', issuance;
  end if;

  replay := public.execute_storyops_golden_path_command(
    company_id_value,
    invoice_command_id,
    'invoice.issue',
    job_version_value,
    invoice_payload,
    invoice_request_hash
  );
  if replay ->> 'replayed' <> 'true'
    or replay ->> 'entityId' <> invoice_id_value::text
  then
    raise exception 'Invoice issuance did not replay exactly: %', replay;
  end if;

  if (
    select count(*)
    from public.invoices
    where company_id = company_id_value
      and job_id = job_id_value
      and purpose = 'job'
  ) <> 1 then
    raise exception 'More than one job invoice was created';
  end if;
  if (
    select count(*)
    from public.invoice_lines
    where invoice_id = invoice_id_value
      and source_estimate_line_id is not null
  ) <> 3 then
    raise exception 'Accepted estimate lines were not copied exactly once';
  end if;
  if not exists (
    select 1
    from public.audit_events
    where company_id = company_id_value
      and entity_type in ('jobs', 'visits', 'invoices', 'payments')
  ) then
    raise exception 'Golden-path mutations were not appended to audit';
  end if;
end;
$$;

rollback;

\echo 'fixture-backed booking/invoice database contract: pass (external providers not exercised)'
