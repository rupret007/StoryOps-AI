\set ON_ERROR_STOP on

begin;

\echo '1/8 service_role has no generic public base-table privileges'
do $$
declare
  privileged_relations text[];
begin
  select coalesce(array_agg(distinct table_name order by table_name), '{}'::text[])
  into privileged_relations
  from information_schema.role_table_grants
  where grantee = 'service_role' and table_schema = 'public';
  if cardinality(privileged_relations) <> 0 then
    raise exception 'service_role retains base-table privileges: %', privileged_relations;
  end if;
end;
$$;

\echo '2/8 browser roles cannot execute server-only Edge projections'
do $$
begin
  if has_function_privilege(
    'authenticated',
    'public.load_storyops_edge_actor(uuid,uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.persist_storyops_photo_analysis(uuid,uuid,uuid,uuid,text,text,text,jsonb,timestamptz,timestamptz)',
    'EXECUTE'
  ) then
    raise exception 'authenticated retained a server-only Edge RPC';
  end if;
end;
$$;

\echo '3/8 every service-executable definer uses a NULL-safe JWT role guard'
do $$
declare
  unsafe_functions text[];
begin
  select coalesce(
    array_agg(proc.oid::regprocedure::text order by proc.oid::regprocedure::text),
    '{}'::text[]
  )
  into unsafe_functions
  from pg_proc proc
  join pg_namespace namespace on namespace.oid = proc.pronamespace
  where namespace.nspname = 'public'
    and proc.prosecdef
    and has_function_privilege('service_role', proc.oid, 'EXECUTE')
    and (
      proc.prosrc ~* $pattern$auth[.]role[(][)][[:space:]]*(<>|!=)[[:space:]]*'service_role'$pattern$
      or proc.prosrc ~* $pattern$auth[.]role[(][)][[:space:]]*=[[:space:]]*'service_role'$pattern$
      or proc.prosrc ~* $pattern$current_user[[:space:]]*<>[[:space:]]*'postgres'$pattern$
      or proc.prosrc ~* $pattern$current_user[[:space:]]+not[[:space:]]+in[[:space:]]*[(][^)]*service_role$pattern$
    );
  if cardinality(unsafe_functions) <> 0 then
    raise exception 'service-executable functions retain nullable JWT guards: %',
      unsafe_functions;
  end if;
end;
$$;

\echo '4/8 setting the SQL role without a service JWT claim is denied across historical boundaries'
set local role service_role;
do $$
declare
  denial_count integer := 0;
begin
  begin
    perform public.load_storyops_edge_actor(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101'
    );
  exception when others then
    if sqlerrm = 'EDGE_SERVICE_ROLE_REQUIRED' then
      denial_count := denial_count + 1;
    end if;
  end;

  begin
    perform public.consume_operation_budget(
      '10000000-0000-4000-8000-000000000001',
      'edge-no-claim-test',
      repeat('a', 64),
      1,
      60,
      1
    );
  exception when others then
    if sqlerrm = 'Operation budgets are service-role controlled' then
      denial_count := denial_count + 1;
    end if;
  end;

  begin
    perform public.expire_pending_estimate_approvals(
      '10000000-0000-4000-8000-000000000001'
    );
  exception when others then
    if sqlerrm = 'Estimate approval expiry is service-role controlled' then
      denial_count := denial_count + 1;
    end if;
  end;

  begin
    perform public.attest_storyops_media_upload(
      '10000000-0000-4000-8000-000000000001',
      '31000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000101',
      '31000000-0000-4000-8000-000000000102',
      'edge-no-claim-test/before.jpg',
      repeat('a', 64),
      128,
      'image/jpeg'
    );
  exception when others then
    if sqlerrm = 'Media attestation requires the trusted service boundary' then
      denial_count := denial_count + 1;
    end if;
  end;

  begin
    perform public.load_scope_photo_context(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000211'
    );
  exception when others then
    if sqlerrm = 'SCOPE_PHOTO_TRUSTED_BOUNDARY_REQUIRED' then
      denial_count := denial_count + 1;
    end if;
  end;

  if public.authorize_scope_photo_analysis(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000211',
    '31000000-0000-4000-8000-000000000103'
  ) is not false then
    raise exception 'Scope-photo authorization did not fail closed without a service JWT';
  end if;

  if denial_count <> 5 then
    raise exception 'SQL role alone bypassed one or more service JWT guards (%/5 denied)',
      denial_count;
  end if;
end;
$$;
reset role;

\echo '5/8 exact active owner projection and model-safe fact read succeed'
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  actor jsonb;
  facts jsonb;
  metrics jsonb;
begin
  actor := public.load_storyops_edge_actor(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101'
  );
  facts := public.load_storyops_ai_fact_rows(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    'leads',
    'id',
    array['10000000-0000-4000-8000-000000000221']::uuid[],
    51
  );
  metrics := public.load_storyops_ai_metrics(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    'pipeline'
  );
  if actor ->> 'role' <> 'owner'
    or jsonb_array_length(facts) <> 1
    or (facts -> 0) ? 'display_name'
    or (facts -> 0) ? 'email'
    or metrics #>> '{metrics,leadsByStatus,lost}' is null
  then
    raise exception 'Scoped Edge projection was invalid: actor %, facts %, metrics %',
      actor, facts, metrics;
  end if;
end;
$$;

\echo '6/8 nonexistent and cross-company actors fail closed'
do $$
declare
  denied boolean := false;
begin
  begin
    perform public.load_storyops_ai_owner_briefing_rows(
      '10000000-0000-4000-8000-000000000001',
      '90000000-0000-4000-8000-000000000999'
    );
  exception when others then
    denied := sqlerrm = 'EDGE_ACTOR_FORBIDDEN';
  end;
  if not denied then
    raise exception 'An unbound actor read company briefing facts';
  end if;
end;
$$;

\echo '7/8 billing validation exposes one explicit authoritative projection'
do $$
declare
  quote_fact jsonb;
begin
  quote_fact := public.load_storyops_billing_validation(
    '10000000-0000-4000-8000-000000000001',
    'checkout',
    '10000000-0000-4000-8000-000000000521',
    null
  );
  if quote_fact ->> 'id' <> '10000000-0000-4000-8000-000000000521'
    or quote_fact ? 'terms_snapshot'
    or quote_fact ? 'acceptance_ip_hash'
  then
    raise exception 'Billing projection was missing or over-broad: %', quote_fact;
  end if;
end;
$$;
reset role;

\echo '8/8 photo persistence reauthorizes the asset and writes analysis plus trace atomically'
insert into storage.objects(id, bucket_id, name, owner, metadata)
values (
  '31000000-0000-4000-8000-000000000010',
  'job-media',
  'edge-boundary-test/before.jpg',
  '10000000-0000-4000-8000-000000000101',
  jsonb_build_object('size', 128, 'mimetype', 'image/jpeg')
);
insert into public.media_upload_attestations(
  id, company_id, command_id, actor_user_id, asset_id, object_path,
  checksum_sha256, byte_size, content_type, attested_at, expires_at
)
values (
  '31000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000012',
  '10000000-0000-4000-8000-000000000101',
  '31000000-0000-4000-8000-000000000001',
  'edge-boundary-test/before.jpg',
  repeat('a', 64),
  128,
  'image/jpeg',
  now(),
  now() + interval '10 minutes'
);
insert into public.media_assets(
  id, company_id, property_id, purpose, object_path, content_type, byte_size,
  checksum_sha256, captured_at, captured_by, offline_client_id, sync_state,
  retention_class, retain_until
)
values (
  '31000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000211',
  'before',
  'edge-boundary-test/before.jpg',
  'image/jpeg',
  128,
  repeat('a', 64),
  now(),
  '10000000-0000-4000-8000-000000000101',
  '31000000-0000-4000-8000-000000000012',
  'synced',
  'operational',
  now() + interval '30 days'
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  receipt jsonb;
begin
  receipt := public.persist_storyops_photo_analysis(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000211',
    '31000000-0000-4000-8000-000000000001',
    'sandbox-photo-evidence',
    'photo-scope-v1.0.0',
    'before',
    jsonb_build_object(
      'overallConfidence', 0.25,
      'observations', '[]'::jsonb,
      'measurementCandidates', '[]'::jsonb,
      'accessFlags', '[]'::jsonb,
      'riskFlags', '[]'::jsonb,
      'unknowns', jsonb_build_array('No verified measurement scale.'),
      'injectionSignals', '[]'::jsonb,
      'disposition', 'insufficient',
      'reasons', jsonb_build_array('Human review is required.')
    ),
    now(),
    now() + interval '90 days'
  );
  if receipt ->> 'analysis_id' is null then
    raise exception 'Photo persistence receipt was invalid: %', receipt;
  end if;
  perform set_config('storyops.test.analysis_id', receipt ->> 'analysis_id', true);
end;
$$;
reset role;
do $$
declare
  analysis_id_value uuid := current_setting('storyops.test.analysis_id')::uuid;
begin
  if not exists (
    select 1 from public.photo_analyses
    where id = analysis_id_value
      and source_asset_id = '31000000-0000-4000-8000-000000000001'
  )
    or not exists (
      select 1 from public.ai_traces
      where trace_id = 'photo-' || analysis_id_value::text
    )
  then
    raise exception 'Photo analysis and trace were not persisted atomically';
  end if;
end;
$$;

rollback;
