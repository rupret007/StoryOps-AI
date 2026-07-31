\set ON_ERROR_STOP on

begin;

\echo '1/7 Supabase Auth invitation authority is finite and service-only'
do $$
begin
  if not exists (
    select 1
    from public.integration_connections connection
    where connection.company_id =
      '10000000-0000-4000-8000-000000000001'
    and connection.provider = 'supabase_auth'
    and connection.mode = 'disabled'
    and not connection.owner_enabled
  ) then
    raise exception
      'The company has no fail-closed Supabase Auth provider row';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.record_storyops_identity_invitation_environment_probe(uuid,uuid,uuid,text,jsonb)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.record_storyops_identity_invitation_environment_probe(uuid,uuid,uuid,text,jsonb)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.authorize_storyops_identity_invite(uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.authorize_storyops_identity_invite(uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) or to_regprocedure(
    'public.authorize_storyops_identity_invite(uuid,uuid,uuid,text)'
  ) is not null then
    raise exception
      'Identity invitation authority retained an unsafe RPC surface';
  end if;
end;
$$;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
set local role service_role;

\echo '2/7 the dedicated probe accepts only exact secret-safe current evidence'
do $$
declare
  invalid_result_blocked boolean := false;
  disabled_receipt jsonb;
  probe_receipt jsonb;
  probe_run_id_value uuid :=
    '51000000-0000-4000-8000-000000000001';
  checked_at_value timestamptz :=
    date_trunc('milliseconds', clock_timestamp());
begin
  begin
    perform
      public.record_storyops_identity_invitation_environment_probe(
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000101',
        '51000000-0000-4000-8000-000000000099',
        repeat('a', 64),
        jsonb_build_object(
          'provider', 'supabase_auth',
          'capability', 'identity_invitation',
          'mode', 'live',
          'status', 'healthy',
          'checkedAt', checked_at_value,
          'latencyMs', 3,
          'requiredEnvironment', jsonb_build_array(
            'STORYOPS_IDENTITY_INVITE_LIVE_ENABLED',
            'STORYOPS_IDENTITY_INVITE_MODE'
          )
        )
      );
  exception when others then
    invalid_result_blocked :=
      sqlerrm = 'IDENTITY_INVITATION_PROBE_INVALID_RESULT';
  end;
  if not invalid_result_blocked then
    raise exception
      'An incomplete identity invitation environment result was trusted';
  end if;

  disabled_receipt :=
    public.record_storyops_identity_invitation_environment_probe(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '51000000-0000-4000-8000-000000000098',
      repeat('a', 64),
      jsonb_build_object(
        'provider', 'supabase_auth',
        'capability', 'identity_invitation',
        'mode', 'disabled',
        'status', 'not_configured',
        'checkedAt', checked_at_value,
        'latencyMs', 0,
        'requiredEnvironment', jsonb_build_array(
          'STORYOPS_IDENTITY_INVITE_LIVE_ENABLED',
          'STORYOPS_IDENTITY_INVITE_MODE'
        )
      )
    );
  if disabled_receipt #>> '{providers,0,mode}' <> 'disabled'
    or disabled_receipt #>> '{providers,0,status}'
      <> 'not_configured'
  then
    raise exception
      'The no-key disabled identity probe did not persist safely: %',
      disabled_receipt;
  end if;

  probe_receipt :=
    public.record_storyops_identity_invitation_environment_probe(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      probe_run_id_value,
      repeat('a', 64),
      jsonb_build_object(
        'provider', 'supabase_auth',
        'capability', 'identity_invitation',
        'mode', 'live',
        'status', 'healthy',
        'checkedAt', checked_at_value,
        'latencyMs', 3,
        'requiredEnvironment', jsonb_build_array(
          'STORYOPS_IDENTITY_INVITE_LIVE_ENABLED',
          'STORYOPS_IDENTITY_INVITE_MODE',
          'STORYOPS_IDENTITY_INVITE_REDIRECT_URL',
          'SUPABASE_SERVICE_ROLE_KEY',
          'SUPABASE_URL'
        )
      )
    );
  if probe_receipt ->> 'schemaVersion'
      <> 'storyops-provider-probe-receipt-v1'
    or probe_receipt #>> '{providers,0,provider}'
      <> 'supabase_auth'
    or probe_receipt #>> '{providers,0,capability}'
      <> 'identity_invitation'
    or probe_receipt #>> '{providers,0,status}'
      <> 'healthy'
  then
    raise exception
      'The exact identity invitation probe was not persisted safely: %',
      probe_receipt;
  end if;
end;
$$;

reset role;
do $$
begin
  if not exists (
    select 1
    from public.integration_connections connection
    where connection.company_id =
      '10000000-0000-4000-8000-000000000001'
      and connection.provider = 'supabase_auth'
      and connection.environment_mode = 'live'
      and connection.environment_status = 'healthy'
      and connection.environment_fingerprint = repeat('a', 64)
      and connection.environment_capabilities =
        array['identity_invitation']::text[]
      and not connection.owner_enabled
      and connection.mode = 'disabled'
  ) then
    raise exception
      'The exact identity invitation probe was not persisted safely';
  end if;
end;
$$;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);

\echo '3/7 only the active owner can activate exact current invitation proof'
do $$
declare
  connection_version integer;
  provider_state jsonb;
  command_id_value uuid :=
    '51000000-0000-4000-8000-000000000002';
  request_hash_value text;
  receipt jsonb;
  replay jsonb;
begin
  provider_state := public.get_storyops_provider_launch_state(
    '10000000-0000-4000-8000-000000000001'
  );
  select (connection ->> 'version')::integer
  into connection_version
  from jsonb_array_elements(
    provider_state -> 'connections'
  ) connection
  where connection ->> 'provider' = 'supabase_auth';
  request_hash_value := encode(extensions.digest(
    array_to_string(array[
      'storyops-provider-activation-v1',
      'supabase_auth',
      connection_version::text,
      'live'
    ], chr(31)),
    'sha256'
  ), 'hex');
  receipt := public.set_storyops_provider_activation(
    '10000000-0000-4000-8000-000000000001',
    command_id_value,
    'supabase_auth',
    connection_version,
    'live',
    request_hash_value
  );
  replay := public.set_storyops_provider_activation(
    '10000000-0000-4000-8000-000000000001',
    command_id_value,
    'supabase_auth',
    connection_version,
    'live',
    request_hash_value
  );
  if receipt ->> 'provider' <> 'supabase_auth'
    or receipt ->> 'mode' <> 'live'
    or receipt ->> 'ownerEnabled' <> 'true'
    or receipt #>> '{capabilities,0}'
      <> 'identity_invitation'
    or replay ->> 'replayed' <> 'true'
  then
    raise exception
      'Owner activation or idempotent replay was invalid: %, %',
      receipt,
      replay;
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
set local role service_role;

\echo '4/7 current provider invocation works internally but launch-start remains independently blocked'
do $$
declare
  receipt jsonb;
  wrong_generation_blocked boolean := false;
  launch_blocked boolean := false;
begin
  receipt := public.assert_storyops_provider_invocation(
    '10000000-0000-4000-8000-000000000001',
    'supabase_auth',
    'identity_invitation',
    'internal',
    repeat('a', 64)
  );
  if receipt ->> 'authorized' <> 'true'
    or receipt ->> 'provider' <> 'supabase_auth'
    or receipt ->> 'capability' <> 'identity_invitation'
  then
    raise exception
      'Current provider authority did not authorize the exact capability';
  end if;
  begin
    perform public.assert_storyops_provider_invocation(
      '10000000-0000-4000-8000-000000000001',
      'supabase_auth',
      'identity_invitation',
      'internal',
      repeat('b', 64)
    );
  exception when others then
    wrong_generation_blocked :=
      sqlerrm = 'PROVIDER_INVOCATION_ENVIRONMENT_NOT_READY';
  end;
  begin
    perform public.assert_storyops_provider_invocation(
      '10000000-0000-4000-8000-000000000001',
      'supabase_auth',
      'identity_invitation',
      'launch_start',
      repeat('a', 64)
    );
  exception when others then
    launch_blocked :=
      sqlerrm = 'PROVIDER_INVOCATION_LAUNCH_NOT_AUTHORIZED';
  end;
  if not wrong_generation_blocked or not launch_blocked then
    raise exception
      'Deployment generation or controlled launch was bypassed';
  end if;
end;
$$;

\echo '5/7 a disable after an earlier provider assertion blocks the final invitation marker'
do $$
declare
  canonical_request text;
  request_hash_value text;
begin
  canonical_request := jsonb_build_object(
    'schemaVersion',
      'storyops-identity-provisioning-request-v1',
    'companyId',
      '10000000-0000-4000-8000-000000000001'::uuid,
    'commandId',
      '51000000-0000-4000-8000-000000000003'::uuid,
    'action', 'invite',
    'email', 'authority-race@example.test',
    'role', 'dispatcher',
    'customerId', null
  )::text;
  request_hash_value := encode(
    extensions.digest(
      convert_to(canonical_request, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '51000000-0000-4000-8000-000000000003',
    'invite',
    'authority-race@example.test',
    'dispatcher',
    null,
    canonical_request,
    request_hash_value
  );
  -- This represents an earlier Edge-side provider assertion.
  perform public.assert_storyops_provider_invocation(
    '10000000-0000-4000-8000-000000000001',
    'supabase_auth',
    'identity_invitation',
    'internal',
    repeat('a', 64)
  );
end;
$$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
declare
  connection_version integer;
  provider_state jsonb;
  request_hash_value text;
begin
  provider_state := public.get_storyops_provider_launch_state(
    '10000000-0000-4000-8000-000000000001'
  );
  select (connection ->> 'version')::integer
  into connection_version
  from jsonb_array_elements(
    provider_state -> 'connections'
  ) connection
  where connection ->> 'provider' = 'supabase_auth';
  request_hash_value := encode(extensions.digest(
    array_to_string(array[
      'storyops-provider-activation-v1',
      'supabase_auth',
      connection_version::text,
      'disabled'
    ], chr(31)),
    'sha256'
  ), 'hex');
  perform public.set_storyops_provider_activation(
    '10000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000004',
    'supabase_auth',
    connection_version,
    'disabled',
    request_hash_value
  );
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
set local role service_role;
do $$
declare
  canonical_request text;
  request_hash_value text;
  replay_context jsonb;
  blocked_after_disable boolean := false;
begin
  canonical_request := jsonb_build_object(
    'schemaVersion',
      'storyops-identity-provisioning-request-v1',
    'companyId',
      '10000000-0000-4000-8000-000000000001'::uuid,
    'commandId',
      '51000000-0000-4000-8000-000000000003'::uuid,
    'action', 'invite',
    'email', 'authority-race@example.test',
    'role', 'dispatcher',
    'customerId', null
  )::text;
  request_hash_value := encode(
    extensions.digest(
      convert_to(canonical_request, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  begin
    perform public.authorize_storyops_identity_invite(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '51000000-0000-4000-8000-000000000003',
      request_hash_value,
      repeat('a', 64)
    );
  exception when others then
    blocked_after_disable :=
      sqlerrm = 'PROVIDER_INVOCATION_NOT_AUTHORIZED';
  end;
  replay_context := public.begin_storyops_identity_provisioning(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '51000000-0000-4000-8000-000000000003',
    'invite',
    'authority-race@example.test',
    'dispatcher',
    null,
    canonical_request,
    request_hash_value
  );
  if not blocked_after_disable
    or replay_context ->> 'inviteAttemptAuthorized' <> 'false'
  then
    raise exception
      'A stale provider assertion authorized an invitation after disable';
  end if;
end;
$$;

\echo '6/7 a paused company blocks provider use and invitation authorization'
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
do $$
declare
  connection_version integer;
  provider_state jsonb;
  request_hash_value text;
begin
  provider_state := public.get_storyops_provider_launch_state(
    '10000000-0000-4000-8000-000000000001'
  );
  select (connection ->> 'version')::integer
  into connection_version
  from jsonb_array_elements(
    provider_state -> 'connections'
  ) connection
  where connection ->> 'provider' = 'supabase_auth';
  request_hash_value := encode(extensions.digest(
    array_to_string(array[
      'storyops-provider-activation-v1',
      'supabase_auth',
      connection_version::text,
      'live'
    ], chr(31)),
    'sha256'
  ), 'hex');
  perform public.set_storyops_provider_activation(
    '10000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000005',
    'supabase_auth',
    connection_version,
    'live',
    request_hash_value
  );
end;
$$;
reset role;
update public.companies
set status = 'paused'
where id = '10000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
set local role service_role;
do $$
declare
  company_blocked boolean := false;
  invite_blocked boolean := false;
  request_hash_value text;
begin
  begin
    perform public.assert_storyops_provider_invocation(
      '10000000-0000-4000-8000-000000000001',
      'supabase_auth',
      'identity_invitation',
      'internal',
      repeat('a', 64)
    );
  exception when others then
    company_blocked :=
      sqlerrm = 'PROVIDER_INVOCATION_COMPANY_NOT_ACTIVE';
  end;
  request_hash_value := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'schemaVersion',
          'storyops-identity-provisioning-request-v1',
        'companyId',
          '10000000-0000-4000-8000-000000000001'::uuid,
        'commandId',
          '51000000-0000-4000-8000-000000000003'::uuid,
        'action', 'invite',
        'email', 'authority-race@example.test',
        'role', 'dispatcher',
        'customerId', null
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  begin
    perform public.authorize_storyops_identity_invite(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '51000000-0000-4000-8000-000000000003',
      request_hash_value,
      repeat('a', 64)
    );
  exception when others then
    invite_blocked :=
      sqlerrm = 'IDENTITY_ACTIVE_OWNER_REQUIRED';
  end;
  if not company_blocked or not invite_blocked then
    raise exception
      'Company pause did not block provider and invitation authority';
  end if;
end;
$$;

\echo '7/7 canary and final marker definitions bind exact Supabase Auth evidence'
reset role;
do $$
declare
  canary_definition text;
  marker_definition text;
begin
  select pg_get_functiondef(
    'public.complete_storyops_provider_canary_verification(uuid,jsonb,text)'::regprocedure
  )
  into canary_definition;
  select pg_get_functiondef(
    'public.authorize_storyops_identity_invite(uuid,uuid,uuid,text,text)'::regprocedure
  )
  into marker_definition;
  if position(
    'supabase_auth.admin_directory.retrieve'
    in canary_definition
  ) = 0
    or position(
      'assert_storyops_provider_invocation'
      in marker_definition
    ) = 0
    or exists (
      select 1
      from public.integration_environment_probe_results result
      where result.provider = 'supabase_auth'
        and (
          not (
            result.required_settings @> array[
              'STORYOPS_IDENTITY_INVITE_LIVE_ENABLED',
              'STORYOPS_IDENTITY_INVITE_MODE'
            ]::text[]
          )
          or not (
            result.required_settings <@ array[
              'STORYOPS_IDENTITY_INVITE_LIVE_ENABLED',
              'STORYOPS_IDENTITY_INVITE_MODE',
              'STORYOPS_IDENTITY_INVITE_REDIRECT_URL',
              'SUPABASE_SERVICE_ROLE_KEY',
              'SUPABASE_URL'
            ]::text[]
          )
        )
    )
  then
    raise exception
      'Exact canary, marker, or secret-safe setting authority is missing';
  end if;
end;
$$;

rollback;
