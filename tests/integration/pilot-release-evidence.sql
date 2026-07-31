\set ON_ERROR_STOP on

begin;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

\echo '1/7 active owner records exact append-only restore evidence'
do $$
declare
  observed_at_value timestamptz := date_trunc('milliseconds', now() - interval '1 minute');
  expires_at_value timestamptz := observed_at_value + interval '30 days';
  request_hash_value text;
  receipt jsonb;
begin
  request_hash_value := encode(
    extensions.digest(
      array_to_string(
        array[
          'storyops-pilot-release-evidence-v1',
          'backup_restore',
          '',
          'passed',
          'isolated_restore_drill',
          'isolated-restore-drill-artifact-2026-07-29',
          repeat('a', 64),
          to_char(
            observed_at_value at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          to_char(
            expires_at_value at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'owner-restore-review-001'
        ],
        chr(31)
      ),
      'sha256'
    ),
    'hex'
  );
  receipt := public.record_storyops_pilot_release_evidence(
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    request_hash_value,
    'backup_restore',
    null,
    'passed',
    'isolated_restore_drill',
    'isolated-restore-drill-artifact-2026-07-29',
    repeat('a', 64),
    observed_at_value,
    expires_at_value,
    'owner-restore-review-001'
  );
  if receipt ->> 'schemaVersion' <> 'storyops-pilot-evidence-receipt-v1'
    or receipt ->> 'replayed' <> 'false'
    or receipt #>> '{record,kind}' <> 'backup_restore'
    or receipt #>> '{record,outcome}' <> 'passed'
    or receipt #>> '{record,reviewedByUserId}'
      <> '10000000-0000-4000-8000-000000000101'
    or receipt #>> '{record,verificationBasis}' <> 'owner_attestation'
    or receipt #> '{record,provider}' is not null
  then
    raise exception 'Pilot evidence receipt is invalid: %', receipt;
  end if;

  receipt := public.record_storyops_pilot_release_evidence(
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    request_hash_value,
    'backup_restore',
    null,
    'passed',
    'isolated_restore_drill',
    'isolated-restore-drill-artifact-2026-07-29',
    repeat('a', 64),
    observed_at_value,
    expires_at_value,
    'owner-restore-review-001'
  );
  if receipt ->> 'replayed' <> 'true' then
    raise exception 'Exact pilot evidence replay was not reconciled: %', receipt;
  end if;
end;
$$;

\echo '2/7 latest evidence projection is scoped and contains no raw artifact'
do $$
declare
  projection jsonb;
begin
  projection := public.get_storyops_pilot_release_evidence(
    '10000000-0000-4000-8000-000000000001'
  );
  if projection ->> 'schemaVersion' <> 'storyops-pilot-evidence-state-v1'
    or jsonb_array_length(projection -> 'records') <> 1
    or projection #>> '{records,0,evidenceReference}'
      <> 'isolated-restore-drill-artifact-2026-07-29'
    or lower(projection::text) ~ '(password|secret|access[_-]?token)'
  then
    raise exception 'Pilot evidence projection is invalid: %', projection;
  end if;
end;
$$;

\echo '3/7 provider/media pass claims require authoritative live dual activation'
do $$
declare
  blocked_provider boolean := false;
  blocked_storage boolean := false;
  observed_at_value timestamptz := date_trunc('milliseconds', now() - interval '1 minute');
  expires_at_value timestamptz := date_trunc('milliseconds', now() + interval '1 day');
begin
  begin
    perform public.record_storyops_pilot_release_evidence(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000002',
      repeat('b', 64),
      'provider_canary',
      'stripe',
      'passed',
      'external_provider_receipt',
      'stripe-external-canary-receipt',
      repeat('b', 64),
      observed_at_value,
      expires_at_value,
      'owner-stripe-review-001'
    );
  exception
    when others then
      if sqlerrm in (
        'PILOT_EVIDENCE_PUBLISHED_CONFIGURATION_REQUIRED',
        'PILOT_EVIDENCE_LIVE_PROVIDER_REQUIRED'
      ) then
        blocked_provider := true;
      else
        raise;
      end if;
  end;
  begin
    perform public.record_storyops_pilot_release_evidence(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000003',
      repeat('c', 64),
      'field_media_canary',
      null,
      'passed',
      'storage_roundtrip',
      'private-storage-roundtrip-receipt',
      repeat('c', 64),
      observed_at_value,
      expires_at_value,
      'owner-storage-review-001'
    );
  exception
    when others then
      if sqlerrm in (
        'PILOT_EVIDENCE_PUBLISHED_CONFIGURATION_REQUIRED',
        'PILOT_EVIDENCE_LIVE_STORAGE_REQUIRED'
      ) then
        blocked_storage := true;
      else
        raise;
      end if;
  end;
  if not blocked_provider or not blocked_storage then
    raise exception 'Unactivated provider or Storage evidence was accepted';
  end if;
end;
$$;

\echo '4/7 wrong kind/source, expired evidence, forged hashes, and credential-like text fail closed'
do $$
declare
  blocked_shape boolean := false;
  blocked_time boolean := false;
  blocked_future boolean := false;
  blocked_hash boolean := false;
  blocked_secret boolean := false;
begin
  begin
    perform public.record_storyops_pilot_release_evidence(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000004',
      repeat('d', 64),
      'backup_restore',
      'stripe',
      'passed',
      'external_provider_receipt',
      'invalid-kind-source-evidence',
      repeat('d', 64),
      now() - interval '1 minute',
      now() + interval '1 day',
      'owner-invalid-shape-001'
    );
  exception
    when others then
      if sqlerrm = 'PILOT_EVIDENCE_KIND_SOURCE_MISMATCH' then
        blocked_shape := true;
      else
        raise;
      end if;
  end;
  begin
    perform public.record_storyops_pilot_release_evidence(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000005',
      repeat('e', 64),
      'backup_restore',
      null,
      'passed',
      'isolated_restore_drill',
      'expired-restore-evidence',
      repeat('e', 64),
      now() - interval '2 days',
      now() - interval '1 day',
      'owner-expired-review-001'
    );
  exception
    when others then
      if sqlerrm = 'PILOT_EVIDENCE_TIME_INVALID' then
        blocked_time := true;
      else
        raise;
      end if;
  end;
  begin
    perform public.record_storyops_pilot_release_evidence(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000009',
      repeat('9', 64),
      'backup_restore',
      null,
      'failed',
      'isolated_restore_drill',
      'future-restore-observation',
      repeat('9', 64),
      now() + interval '1 minute',
      now() + interval '1 day',
      'owner-future-review-001'
    );
  exception
    when others then
      if sqlerrm = 'PILOT_EVIDENCE_TIME_INVALID' then
        blocked_future := true;
      else
        raise;
      end if;
  end;
  begin
    perform public.record_storyops_pilot_release_evidence(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000006',
      repeat('f', 64),
      'backup_restore',
      null,
      'failed',
      'isolated_restore_drill',
      'forged-request-hash-evidence',
      repeat('f', 64),
      now() - interval '1 minute',
      now() + interval '1 day',
      'owner-forged-hash-001'
    );
  exception
    when others then
      if sqlerrm = 'PILOT_EVIDENCE_REQUEST_HASH_MISMATCH' then
        blocked_hash := true;
      else
        raise;
      end if;
  end;
  begin
    perform public.record_storyops_pilot_release_evidence(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000008',
      repeat('8', 64),
      'backup_restore',
      null,
      'failed',
      'isolated_restore_drill',
      'restore-report?token=must-not-be-stored',
      repeat('8', 64),
      now() - interval '1 minute',
      now() + interval '1 day',
      'owner-secret-rejection-001'
    );
  exception
    when others then
      if sqlerrm = 'PILOT_EVIDENCE_INVALID_REQUEST' then
        blocked_secret := true;
      else
        raise;
      end if;
  end;
  if not blocked_shape
    or not blocked_time
    or not blocked_future
    or not blocked_hash
    or not blocked_secret
  then
    raise exception 'One or more invalid release evidence forms were accepted';
  end if;
end;
$$;

\echo '5/7 dispatcher may read but cannot append owner review evidence'
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000102', true);
do $$
declare
  blocked boolean := false;
  projection jsonb;
begin
  projection := public.get_storyops_pilot_release_evidence(
    '10000000-0000-4000-8000-000000000001'
  );
  if jsonb_array_length(projection -> 'records') <> 1 then
    raise exception 'Dispatcher did not receive the scoped evidence projection';
  end if;
  begin
    perform public.record_storyops_pilot_release_evidence(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000007',
      repeat('7', 64),
      'backup_restore',
      null,
      'failed',
      'isolated_restore_drill',
      'dispatcher-cannot-attest',
      repeat('7', 64),
      now() - interval '1 minute',
      now() + interval '1 day',
      'dispatcher-attestation-001'
    );
  exception
    when others then
      if sqlerrm = 'PILOT_EVIDENCE_ACTIVE_OWNER_REQUIRED' then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Dispatcher appended owner-only release evidence';
  end if;
end;
$$;

\echo '6/7 cross-company and unauthenticated reads fail closed'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_storyops_pilot_release_evidence(
      '20000000-0000-4000-8000-000000000001'
    );
  exception
    when others then
      if sqlerrm = 'PILOT_EVIDENCE_ACTIVE_STAFF_REQUIRED' then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Cross-company release evidence was exposed';
  end if;
end;
$$;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_storyops_pilot_release_evidence(
      '10000000-0000-4000-8000-000000000001'
    );
  exception
    when others then
      if sqlerrm = 'PILOT_EVIDENCE_AUTHENTICATION_REQUIRED' then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Unauthenticated release evidence was exposed';
  end if;
end;
$$;

\echo '7/7 only authenticated finite RPCs are exposed'
reset role;
do $$
begin
  if not has_function_privilege(
    'authenticated',
    'public.record_storyops_pilot_release_evidence(uuid,uuid,text,text,text,text,text,text,text,timestamptz,timestamptz,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.get_storyops_pilot_release_evidence(uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.record_storyops_pilot_release_evidence(uuid,uuid,text,text,text,text,text,text,text,timestamptz,timestamptz,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'service_role',
    'public.record_storyops_pilot_release_evidence(uuid,uuid,text,text,text,text,text,text,text,timestamptz,timestamptz,text)',
    'EXECUTE'
  ) then
    raise exception 'Pilot evidence RPC execute privileges are unsafe';
  end if;
end;
$$;

rollback;
