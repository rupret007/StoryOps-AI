\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.worker_payload(
  p_mode text,
  p_generation text,
  p_unknown_worker text default null,
  p_oldest_age integer default null
)
returns jsonb
language sql
as $$
  select jsonb_agg(jsonb_build_object(
    'worker', required.worker,
    'activationMode', p_mode,
    'credentialStatus', case
      when p_mode = 'disabled' then 'missing'
      else 'valid'
    end,
    'acceptedTrigger', case
      when p_mode = 'scheduled' then 'scheduled'
      when p_mode = 'manual' then 'manual'
      else null
    end,
    'scheduleIntervalSeconds', case
      when p_mode = 'scheduled' then 120
      else null
    end,
    'configurationHash', encode(
      extensions.digest(
        required.worker || ':' || p_generation,
        'sha256'
      ),
      'hex'
    ),
    'deploymentIdentityStatus', 'valid',
    'queue', jsonb_build_object(
      'availability', 'verified',
      'backlogCount', case
        when required.worker = p_unknown_worker then 1
        when p_oldest_age is not null then 1
        else 0
      end,
      'dueCount', case
        when required.worker = p_unknown_worker
          or p_oldest_age is not null
        then 1
        else 0
      end,
      'submissionUnknownCount', case
        when required.worker = p_unknown_worker then 1
        else 0
      end,
      'oldestQueuedAt', case
        when required.worker = p_unknown_worker
          or p_oldest_age is not null
        then to_jsonb(clock_timestamp() - make_interval(
          secs => coalesce(p_oldest_age, 60)
        ))
        else 'null'::jsonb
      end,
      'oldestQueuedAgeSeconds', case
        when required.worker = p_unknown_worker then 60
        else p_oldest_age
      end,
      'actionCounts', jsonb_build_object(
        'postService', case
          when required.worker = 'post_service'
            and (
              required.worker = p_unknown_worker
              or p_oldest_age is not null
            )
          then 1 else 0
        end,
        'quoteDelivery', case
          when required.worker = 'transactional_outbound'
            and (
              required.worker = p_unknown_worker
              or p_oldest_age is not null
            )
          then 1 else 0
        end,
        'onMyWay', 0,
        'schedulingReconciliation', case
          when required.worker = 'scheduling_reconciliation'
            and (
              required.worker = p_unknown_worker
              or p_oldest_age is not null
            )
          then 1 else 0
        end,
        'scopePhotoCleanup', case
          when required.worker = 'scope_photo_cleanup'
            and (
              required.worker = p_unknown_worker
              or p_oldest_age is not null
            )
          then 1 else 0
        end
      )
    )
  ) order by required.ordinality)
  from unnest(array[
    'post_service',
    'transactional_outbound',
    'scheduling_reconciliation',
    'scope_photo_cleanup'
  ]::text[]) with ordinality as required(worker, ordinality)
$$;

create or replace function pg_temp.record_worker_heartbeats(
  p_deployment text,
  p_generation text,
  p_skip_worker text default null
)
returns void
language plpgsql
as $$
declare
  worker_name text;
begin
  foreach worker_name in array array[
    'post_service',
    'transactional_outbound',
    'scheduling_reconciliation',
    'scope_photo_cleanup'
  ]::text[] loop
    if worker_name is distinct from p_skip_worker then
      perform public.record_storyops_private_worker_heartbeat(
        '10000000-0000-4000-8000-000000000001',
        worker_name,
        p_deployment,
        encode(
          extensions.digest(worker_name || ':' || p_generation, 'sha256'),
          'hex'
        ),
        'scheduled',
        'succeeded'
      );
    end if;
  end loop;
end;
$$;

select set_config('request.jwt.claim.role', 'service_role', true);

\echo '1/9 no snapshot and malformed/empty worker sets fail closed'
delete from private.storyops_private_worker_readiness_snapshots
where company_id = '10000000-0000-4000-8000-000000000001';
delete from private.storyops_private_worker_heartbeats
where company_id = '10000000-0000-4000-8000-000000000001';

do $$
declare
  projection jsonb;
  empty_rejected boolean := false;
begin
  projection := private.storyops_private_worker_snapshot(
    '10000000-0000-4000-8000-000000000001'
  );
  if (projection ->> 'liveReady')::boolean
    or projection ->> 'status' <> 'blocked'
    or jsonb_array_length(projection -> 'workers') <> 4
  then
    raise exception 'Missing worker evidence did not fail closed';
  end if;
  begin
    perform public.record_storyops_private_worker_readiness(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      gen_random_uuid(),
      repeat('d', 64),
      clock_timestamp(),
      900,
      '[]'::jsonb
    );
  exception when others then
    empty_rejected := sqlerrm like '%PRIVATE_WORKER_READINESS_INVALID%';
  end;
  if not empty_rejected then
    raise exception 'An empty worker set was accepted';
  end if;
end;
$$;

\echo '2/9 all-disabled is safe but explicitly never live-ready'
do $$
declare
  projection jsonb;
begin
  projection := public.record_storyops_private_worker_readiness(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    gen_random_uuid(),
    repeat('d', 64),
    clock_timestamp(),
    900,
    pg_temp.worker_payload('disabled', 'disabled')
  );
  if not (projection ->> 'safeDisabled')::boolean
    or (projection ->> 'liveReady')::boolean
    or exists (
      select 1
      from jsonb_array_elements(projection -> 'workers') worker
      where worker ->> 'status' <> 'inactive'
        or (worker ->> 'liveReady')::boolean
        or not (worker -> 'blockers') ? 'WORKER_INACTIVE'
    )
  then
    raise exception 'Disabled workers were presented as live-ready';
  end if;
end;
$$;

\echo '3/9 any missing worker heartbeat blocks the exact worker'
select pg_temp.record_worker_heartbeats(
  repeat('d', 64),
  'generation-a',
  'scope_photo_cleanup'
);
do $$
declare
  projection jsonb;
  scope_worker jsonb;
begin
  projection := public.record_storyops_private_worker_readiness(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    gen_random_uuid(),
    repeat('d', 64),
    clock_timestamp(),
    900,
    pg_temp.worker_payload('scheduled', 'generation-a')
  );
  select worker into scope_worker
  from jsonb_array_elements(projection -> 'workers') worker
  where worker ->> 'worker' = 'scope_photo_cleanup';
  if (projection ->> 'liveReady')::boolean
    or scope_worker ->> 'schedulerEvidence' <> 'missing'
    or not (scope_worker -> 'blockers') ? 'WORKER_HEARTBEAT_MISSING'
  then
    raise exception 'Missing scope-photo worker did not block readiness';
  end if;
end;
$$;

\echo '4/9 stale heartbeat, deployment drift, and configuration drift are distinct'
select pg_temp.record_worker_heartbeats(repeat('d', 64), 'generation-a');
update private.storyops_private_worker_heartbeats
set observed_at = clock_timestamp() - interval '1 hour'
where company_id = '10000000-0000-4000-8000-000000000001'
  and worker = 'post_service';
do $$
declare
  projection jsonb;
begin
  projection := public.record_storyops_private_worker_readiness(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    gen_random_uuid(),
    repeat('d', 64),
    clock_timestamp(),
    900,
    pg_temp.worker_payload('scheduled', 'generation-a')
  );
  if not exists (
    select 1
    from jsonb_array_elements(projection -> 'workers') worker
    where worker ->> 'worker' = 'post_service'
      and (worker -> 'blockers') ? 'WORKER_HEARTBEAT_STALE'
  ) then
    raise exception 'Stale heartbeat was not identified';
  end if;
end;
$$;

select pg_temp.record_worker_heartbeats(repeat('d', 64), 'generation-a');
do $$
declare
  projection jsonb;
begin
  projection := public.record_storyops_private_worker_readiness(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    gen_random_uuid(),
    repeat('e', 64),
    clock_timestamp(),
    900,
    pg_temp.worker_payload('scheduled', 'generation-a')
  );
  if not exists (
    select 1
    from jsonb_array_elements(projection -> 'workers') worker
    where (worker -> 'blockers') ? 'WORKER_DEPLOYMENT_DRIFT'
  ) then
    raise exception 'Old-deployment heartbeat was accepted';
  end if;
end;
$$;

do $$
declare
  projection jsonb;
  missing_release_payload jsonb;
begin
  projection := public.record_storyops_private_worker_readiness(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    gen_random_uuid(),
    repeat('d', 64),
    clock_timestamp(),
    900,
    pg_temp.worker_payload('scheduled', 'generation-b')
  );
  if not exists (
    select 1
    from jsonb_array_elements(projection -> 'workers') worker
    where (worker -> 'blockers') ? 'WORKER_CONFIGURATION_HASH_DRIFT'
  ) then
    raise exception 'Worker configuration-hash drift was accepted';
  end if;
  select jsonb_agg(
    item || jsonb_build_object('deploymentIdentityStatus', 'missing')
  )
  into missing_release_payload
  from jsonb_array_elements(
    pg_temp.worker_payload('scheduled', 'generation-a')
  ) item;
  projection := public.record_storyops_private_worker_readiness(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    gen_random_uuid(),
    repeat('d', 64),
    clock_timestamp(),
    900,
    missing_release_payload
  );
  if not exists (
    select 1
    from jsonb_array_elements(projection -> 'workers') worker
    where (worker -> 'blockers')
      ? 'WORKER_DEPLOYMENT_IDENTITY_MISSING'
  ) then
    raise exception 'A missing release identity was accepted';
  end if;
end;
$$;

\echo '5/9 queue uncertainty and an over-age queue both block launch readiness'
select pg_temp.record_worker_heartbeats(repeat('d', 64), 'generation-a');
do $$
declare
  unknown_projection jsonb;
  stale_projection jsonb;
begin
  unknown_projection := public.record_storyops_private_worker_readiness(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    gen_random_uuid(),
    repeat('d', 64),
    clock_timestamp(),
    900,
    pg_temp.worker_payload(
      'scheduled',
      'generation-a',
      'transactional_outbound'
    )
  );
  stale_projection := public.record_storyops_private_worker_readiness(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    gen_random_uuid(),
    repeat('d', 64),
    clock_timestamp(),
    900,
    pg_temp.worker_payload('scheduled', 'generation-a', null, 901)
  );
  if not exists (
    select 1
    from jsonb_array_elements(unknown_projection -> 'workers') worker
    where worker ->> 'worker' = 'transactional_outbound'
      and (worker -> 'blockers') ? 'WORKER_SUBMISSION_UNKNOWN'
  ) or not exists (
    select 1
    from jsonb_array_elements(stale_projection -> 'workers') worker
    where (worker -> 'blockers') ? 'WORKER_QUEUE_STALE'
  ) then
    raise exception 'Queue uncertainty/age did not block readiness';
  end if;
end;
$$;

insert into public.transactional_delivery_attempts(
  id,
  company_id,
  action_type,
  quote_id,
  entity_version,
  customer_id,
  channel,
  consent_record_id,
  communication_message_id,
  command_id,
  request_hash,
  status,
  last_error_code,
  requested_by_user_id,
  completed_at,
  created_at
)
values (
  '96600000-0000-4000-8000-000000000901',
  '10000000-0000-4000-8000-000000000001',
  'quote_delivery',
  '10000000-0000-4000-8000-000000000521',
  1,
  '10000000-0000-4000-8000-000000000201',
  'email',
  '10000000-0000-4000-8000-000000000231',
  '10000000-0000-4000-8000-000000000702',
  '96600000-0000-4000-8000-000000000902',
  repeat('e', 64),
  'failed',
  'RECONCILIATION_EXHAUSTED',
  '10000000-0000-4000-8000-000000000101',
  clock_timestamp(),
  clock_timestamp() - interval '5 minutes'
);
do $$
declare
  queue jsonb;
begin
  queue := public.load_storyops_private_worker_queue_evidence(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101'
  ) -> 'transactionalOutbound';
  if (queue ->> 'backlogCount')::integer <> 1
    or (queue ->> 'submissionUnknownCount')::integer <> 1
    or queue -> 'actionCounts' ->> 'quoteDelivery' <> '1'
    or queue -> 'oldestQueuedAt' = 'null'::jsonb
    or queue -> 'oldestQueuedAgeSeconds' = 'null'::jsonb
  then
    raise exception
      'Reconciliation-exhausted transactional truth disappeared: %',
      queue;
  end if;
end;
$$;
delete from public.transactional_delivery_attempts
where id = '96600000-0000-4000-8000-000000000901';

\echo '6/9 all four current scheduled workers produce one healthy finite snapshot'
select pg_temp.record_worker_heartbeats(repeat('d', 64), 'generation-a');
do $$
declare
  projection jsonb;
begin
  projection := public.record_storyops_private_worker_readiness(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    gen_random_uuid(),
    repeat('d', 64),
    clock_timestamp(),
    900,
    pg_temp.worker_payload('scheduled', 'generation-a')
  );
  if not (projection ->> 'liveReady')::boolean
    or projection ->> 'status' <> 'healthy'
    or (projection ->> 'safeDisabled')::boolean
    or jsonb_array_length(projection -> 'workers') <> 4
    or exists (
      select 1
      from jsonb_array_elements(projection -> 'workers') worker
      where not (worker ->> 'liveReady')::boolean
        or worker ->> 'schedulerEvidence' <> 'verified'
    )
  then
    raise exception 'Four-current-worker evidence was not healthy';
  end if;
end;
$$;

\echo '7/9 healthy refresh advances version without changing stable binding hash'
do $$
declare
  first_projection jsonb;
  second_projection jsonb;
  policy_projection jsonb;
begin
  first_projection := private.storyops_private_worker_snapshot(
    '10000000-0000-4000-8000-000000000001'
  );
  perform pg_temp.record_worker_heartbeats(
    repeat('d', 64),
    'generation-a'
  );
  second_projection := public.record_storyops_private_worker_readiness(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    gen_random_uuid(),
    repeat('d', 64),
    clock_timestamp(),
    900,
    pg_temp.worker_payload('scheduled', 'generation-a')
  );
  policy_projection := public.record_storyops_private_worker_readiness(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    gen_random_uuid(),
    repeat('d', 64),
    clock_timestamp(),
    901,
    pg_temp.worker_payload('scheduled', 'generation-a')
  );
  if (second_projection ->> 'evidenceVersion')::integer
      <= (first_projection ->> 'evidenceVersion')::integer
    or second_projection ->> 'evidenceHash'
      <> first_projection ->> 'evidenceHash'
  then
    raise exception 'Healthy rolling refresh changed its stable binding';
  end if;
  if policy_projection ->> 'evidenceHash'
    = second_projection ->> 'evidenceHash'
  then
    raise exception 'Queue-age policy drift did not change the binding hash';
  end if;
end;
$$;

\echo '8/9 authorization events bind worker version/hash and policy drift invalidates'
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
  '96600000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  66,
  'storyops-company-config-v1',
  'published',
  'live',
  '{
    "schemaVersion":"storyops-company-config-v1",
    "testFixture":"worker-readiness",
    "territory":{
      "travelZones":[{"code":"DFW-CORE","postalCodes":["75001"]}],
      "travelZoneMappingReview":{
        "status":"approved",
        "reviewer":"Worker readiness test reviewer",
        "reviewedAt":"2026-07-30T00:00:00Z",
        "evidenceReference":"TEST-WORKER-READINESS-TRAVEL-ZONE"
      }
    }
  }',
  repeat('a', 64),
  'TEST-WORKER-READINESS',
  '10000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000101',
  clock_timestamp()
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
  '96600000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  '96600000-0000-4000-8000-000000000001',
  66,
  repeat('a', 64),
  '10000000-0000-4000-8000-000000000401',
  '10000000-0000-4000-8000-000000000152',
  '10000000-0000-4000-8000-000000000151',
  repeat('b', 64),
  'active',
  'TEST-WORKER-READINESS',
  '10000000-0000-4000-8000-000000000101',
  '96600000-0000-4000-8000-000000000003',
  repeat('c', 64)
);

select pg_temp.record_worker_heartbeats(repeat('d', 64), 'generation-a');
select public.record_storyops_private_worker_readiness(
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000101',
  gen_random_uuid(),
  repeat('d', 64),
  clock_timestamp(),
  900,
  pg_temp.worker_payload('scheduled', 'generation-a')
);

insert into public.company_launch_authorization_events(
  id,
  company_id,
  version,
  action,
  configuration_revision,
  configuration_hash,
  baseline_id,
  baseline_hash,
  provider_snapshot_hash,
  proof_snapshot_hash,
  provider_bindings,
  proof_event_ids,
  review_reference,
  actor_user_id,
  command_id,
  request_hash
)
values (
  '96600000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000001',
  1,
  'authorize',
  66,
  repeat('a', 64),
  '96600000-0000-4000-8000-000000000002',
  repeat('b', 64),
  repeat('d', 64),
  repeat('e', 64),
  '[]'::jsonb,
  '[]'::jsonb,
  'TEST-WORKER-READINESS',
  '10000000-0000-4000-8000-000000000101',
  '96600000-0000-4000-8000-000000000005',
  repeat('f', 64)
);

do $$
begin
  if not private.storyops_private_worker_launch_binding_effective(
    '10000000-0000-4000-8000-000000000001'
  ) or exists (
    select 1
    from public.company_launch_authorization_events event
    where event.id = '96600000-0000-4000-8000-000000000004'
      and (
        event.private_worker_evidence_version is null
        or event.private_worker_evidence_hash is null
        or event.private_worker_evidence_expires_at is null
      )
  ) then
    raise exception 'Authorization event did not bind current worker evidence';
  end if;
end;
$$;

\echo '8a/9 scheduled heartbeats sustain expired evidence without false human attribution'
do $$
declare
  refresh_definition text :=
    pg_get_functiondef(
      'private.refresh_storyops_private_worker_readiness()'::regprocedure
    );
begin
  if position('pg_advisory_xact_lock' in refresh_definition) = 0
    or position('select * into prior_snapshot' in refresh_definition) = 0
    or position('pg_advisory_xact_lock' in refresh_definition)
      > position('select * into prior_snapshot' in refresh_definition)
  then
    raise exception
      'Scheduled refresh does not serialize before baseline selection';
  end if;
end;
$$;
update private.storyops_private_worker_readiness_snapshots snapshot
set
  checked_at = clock_timestamp() - interval '20 minutes',
  expires_at = clock_timestamp() - interval '15 minutes'
where snapshot.id = (
  select latest.id
  from private.storyops_private_worker_readiness_snapshots latest
  where latest.company_id = '10000000-0000-4000-8000-000000000001'
  order by latest.evidence_version desc
  limit 1
);

do $$
begin
  if private.storyops_private_worker_launch_binding_effective(
    '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'An expired worker snapshot remained launch-effective';
  end if;
end;
$$;

select pg_temp.record_worker_heartbeats(repeat('d', 64), 'generation-a');
do $$
declare
  latest_snapshot private.storyops_private_worker_readiness_snapshots%rowtype;
  queues jsonb;
begin
  select * into latest_snapshot
  from private.storyops_private_worker_readiness_snapshots snapshot
  where snapshot.company_id = '10000000-0000-4000-8000-000000000001'
  order by snapshot.evidence_version desc
  limit 1;
  queues := public.load_storyops_private_worker_queue_evidence(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101'
  );
  if not private.storyops_private_worker_launch_binding_effective(
      '10000000-0000-4000-8000-000000000001'
    )
    or latest_snapshot.evidence_source <> 'scheduled_refresh'
    or latest_snapshot.recorded_by_user_id is not null
    or latest_snapshot.baseline_verified_by_user_id
      <> '10000000-0000-4000-8000-000000000101'
    or exists (
      select 1
      from jsonb_each(queues) queue
      where (queue.value ->> 'backlogCount')::integer = 0
        and (
          queue.value -> 'oldestQueuedAt' <> 'null'::jsonb
          or queue.value -> 'oldestQueuedAgeSeconds' <> 'null'::jsonb
        )
    )
  then
    raise exception 'Scheduled refresh was not current, system-attributed, and queue-safe';
  end if;
end;
$$;

\echo '8b/9 dynamic heartbeat/config/deployment/queue drift revokes immediately'
update private.storyops_private_worker_heartbeats
set observed_at = clock_timestamp() - interval '1 hour'
where company_id = '10000000-0000-4000-8000-000000000001'
  and worker = 'post_service';
do $$
begin
  if private.storyops_private_worker_launch_binding_effective(
    '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'A stale runtime heartbeat remained launch-effective';
  end if;
end;
$$;
select pg_temp.record_worker_heartbeats(repeat('d', 64), 'generation-a');

select public.record_storyops_private_worker_heartbeat(
  '10000000-0000-4000-8000-000000000001',
  'post_service',
  repeat('d', 64),
  encode(
    extensions.digest('post_service:generation-a', 'sha256'),
    'hex'
  ),
  'scheduled',
  'failed'
);
do $$
begin
  if private.storyops_private_worker_launch_binding_effective(
    '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'A failed scheduled invocation remained launch-effective';
  end if;
end;
$$;
select pg_temp.record_worker_heartbeats(repeat('d', 64), 'generation-a');

select public.record_storyops_private_worker_heartbeat(
  '10000000-0000-4000-8000-000000000001',
  'post_service',
  repeat('d', 64),
  repeat('9', 64),
  'scheduled',
  'succeeded'
);
do $$
begin
  if private.storyops_private_worker_launch_binding_effective(
    '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Runtime configuration drift remained launch-effective';
  end if;
end;
$$;
select pg_temp.record_worker_heartbeats(repeat('d', 64), 'generation-a');

select public.record_storyops_private_worker_heartbeat(
  '10000000-0000-4000-8000-000000000001',
  'transactional_outbound',
  repeat('8', 64),
  encode(
    extensions.digest(
      'transactional_outbound:generation-a',
      'sha256'
    ),
    'hex'
  ),
  'scheduled',
  'succeeded'
);
do $$
begin
  if private.storyops_private_worker_launch_binding_effective(
    '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Runtime deployment drift remained launch-effective';
  end if;
end;
$$;
select pg_temp.record_worker_heartbeats(repeat('d', 64), 'generation-a');

select public.record_storyops_private_worker_readiness(
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000101',
  gen_random_uuid(),
  repeat('d', 64),
  clock_timestamp(),
  900,
  pg_temp.worker_payload(
    'scheduled',
    'generation-a',
    'transactional_outbound'
  )
);
do $$
begin
  if private.storyops_private_worker_launch_binding_effective(
    '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Submission-unknown queue evidence remained launch-effective';
  end if;
end;
$$;
select pg_temp.record_worker_heartbeats(repeat('d', 64), 'generation-a');

select public.record_storyops_private_worker_readiness(
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000101',
  gen_random_uuid(),
  repeat('d', 64),
  clock_timestamp(),
  900,
  pg_temp.worker_payload('scheduled', 'generation-a', null, 901)
);
do $$
begin
  if private.storyops_private_worker_launch_binding_effective(
    '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Overdue queue evidence remained launch-effective';
  end if;
end;
$$;
select pg_temp.record_worker_heartbeats(repeat('d', 64), 'generation-a');

select public.record_storyops_private_worker_readiness(
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000101',
  gen_random_uuid(),
  repeat('d', 64),
  clock_timestamp(),
  901,
  pg_temp.worker_payload('scheduled', 'generation-a')
);

do $$
begin
  if private.storyops_private_worker_launch_binding_effective(
    '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Worker-policy hash drift left authorization effective';
  end if;
end;
$$;

\echo '8c/9 scheduled refresh retention is bounded without deleting canonical evidence'
do $$
declare
  company constant uuid := '10000000-0000-4000-8000-000000000001';
  first_version integer;
  referenced_version integer;
  staff_before integer;
  latest_fixture_version integer;
begin
  select coalesce(max(snapshot.evidence_version), 0)
  into first_version
  from private.storyops_private_worker_readiness_snapshots snapshot
  where snapshot.company_id = company;
  select event.private_worker_evidence_version
  into referenced_version
  from public.company_launch_authorization_events event
  where event.company_id = company
    and event.private_worker_evidence_version is not null
  order by event.version desc
  limit 1;
  select count(*)::integer
  into staff_before
  from private.storyops_private_worker_readiness_snapshots snapshot
  where snapshot.company_id = company
    and snapshot.evidence_source = 'staff_probe';

  insert into private.storyops_private_worker_readiness_snapshots(
    company_id,
    evidence_version,
    probe_run_id,
    deployment_fingerprint,
    evidence_hash,
    checked_at,
    expires_at,
    live_ready,
    status,
    projection,
    evidence_source,
    baseline_verified_by_user_id,
    recorded_by_user_id
  )
  select
    company,
    first_version + generated.ordinality::integer,
    gen_random_uuid(),
    repeat('d', 64),
    repeat('f', 64),
    clock_timestamp(),
    clock_timestamp() + interval '5 minutes',
    false,
    'blocked',
    jsonb_build_object(
      'schemaVersion',
      'storyops-private-worker-retention-fixture-v1',
      'ordinality',
      generated.ordinality
    ),
    'scheduled_refresh',
    '10000000-0000-4000-8000-000000000101',
    null
  from generate_series(1, 2112) with ordinality
    as generated(value, ordinality);
  latest_fixture_version := first_version + 2112;

  perform private.prune_storyops_private_worker_refresh_history(
    company,
    2048
  );
  if (
      select count(*)
      from private.storyops_private_worker_readiness_snapshots snapshot
      where snapshot.company_id = company
        and snapshot.evidence_source = 'scheduled_refresh'
        and not exists (
          select 1
          from public.company_launch_authorization_events event
          where event.company_id = company
            and event.private_worker_evidence_version =
              snapshot.evidence_version
        )
    ) > 2048
    or (
      select count(*)
      from private.storyops_private_worker_readiness_snapshots snapshot
      where snapshot.company_id = company
        and snapshot.evidence_source = 'staff_probe'
    ) <> staff_before
    or not exists (
      select 1
      from private.storyops_private_worker_readiness_snapshots snapshot
      where snapshot.company_id = company
        and snapshot.evidence_version = referenced_version
    )
    or not exists (
      select 1
      from private.storyops_private_worker_readiness_snapshots snapshot
      where snapshot.company_id = company
        and snapshot.evidence_version = latest_fixture_version
    )
  then
    raise exception
      'Refresh pruning removed canonical evidence or exceeded its hard cap';
  end if;
end;
$$;

\echo '9/9 browser roles cannot forge private worker evidence'
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
begin
  if has_function_privilege(
    current_user,
    'public.record_storyops_private_worker_heartbeat(uuid,text,text,text,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    current_user,
    'public.record_storyops_private_worker_readiness(uuid,uuid,uuid,text,timestamptz,integer,jsonb)',
    'EXECUTE'
  ) or has_schema_privilege(
    current_user,
    'private',
    'USAGE'
  ) then
    raise exception 'Browser role can forge or read private worker evidence';
  end if;
end;
$$;

rollback;
