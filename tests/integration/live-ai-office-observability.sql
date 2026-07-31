\set ON_ERROR_STOP on

begin;

\echo '1/5 browser roles cannot fabricate AI Office run or owner-briefing truth'
do $$
begin
  if has_table_privilege('authenticated', 'public.automation_runs', 'INSERT')
    or has_table_privilege('authenticated', 'public.automation_runs', 'UPDATE')
    or has_table_privilege('authenticated', 'public.automation_runs', 'DELETE')
    or has_table_privilege('authenticated', 'public.owner_briefings', 'INSERT')
    or has_table_privilege('authenticated', 'public.owner_briefings', 'UPDATE')
    or has_table_privilege('authenticated', 'public.owner_briefings', 'DELETE')
  then
    raise exception 'Authenticated browser roles retain AI Office truth write authority';
  end if;
end;
$$;

\echo '2/5 service boundary begins and completes one manual owner briefing'
set local role service_role;
do $$
declare
  requested_at_value timestamptz := date_trunc('milliseconds', now());
  started jsonb;
  completed jsonb;
  result_payload jsonb;
begin
  started := public.begin_storyops_ai_office_run(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '30000000-0000-4000-8000-000000000001',
    'owner_briefing',
    'ai-office:manual:30000000-0000-4000-8000-000000000001',
    '{}'::jsonb,
    false,
    requested_at_value
  );
  if started ->> 'durableStatus' <> 'running'
    or started ->> 'actorUserId' <> '10000000-0000-4000-8000-000000000101'
    or started ->> 'schedulerConfigured' <> 'false'
  then
    raise exception 'AI Office start receipt is incorrect: %', started;
  end if;

  result_payload := jsonb_build_object(
    'traceId', '30000000-0000-4000-8000-000000000002',
    'runId', '30000000-0000-4000-8000-000000000001',
    'agent', 'owner_briefing',
    'modelProvider', 'sandbox-openai',
    'output', jsonb_build_object(
      'summary', 'Sandbox owner briefing completed without external AI or side effects.',
      'confidence', 0.5,
      'evidence', '[]'::jsonb,
      'unknowns', jsonb_build_array('Live OpenAI is disabled.'),
      'proposedActions', '[]'::jsonb,
      'ownerAttention', false
    ),
    'actions', '[]'::jsonb,
    'injectionSignals', '[]'::jsonb,
    'completedAt', to_jsonb(date_trunc('milliseconds', now())::text),
    'replayed', false
  );
  completed := public.complete_storyops_ai_office_run(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '30000000-0000-4000-8000-000000000001',
    'owner_briefing',
    'sandbox',
    result_payload
  );
  if completed ->> 'durableStatus' <> 'succeeded'
    or completed ->> 'modelMode' <> 'sandbox'
    or completed ->> 'ownerBriefingId' is null
    or completed #>> '{result,traceId}' <> '30000000-0000-4000-8000-000000000002'
  then
    raise exception 'AI Office completion receipt is incorrect: %', completed;
  end if;
  if public.begin_storyops_ai_office_run(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '30000000-0000-4000-8000-000000000001',
    'owner_briefing',
    'ai-office:manual:30000000-0000-4000-8000-000000000001',
    '{}'::jsonb,
    false,
    requested_at_value
  ) ->> 'durableStatus' <> 'succeeded' then
    raise exception 'Exact retry did not recover the completed durable result';
  end if;
end;
$$;
reset role;
do $$
begin
  if (
    select input ? 'manualInput'
      or input::text like '%Sandbox owner briefing%'
      or input ->> 'schedulerConfigured' <> 'false'
    from public.automation_runs
    where id = '30000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Durable run stored manual text or claimed a scheduler';
  end if;
  if (
    select count(*)
    from public.owner_briefings
    where generated_by_run_id = '30000000-0000-4000-8000-000000000001'
      and status = 'ready'
  ) <> 1 then
    raise exception 'Owner briefing was not persisted from the completed run';
  end if;
end;
$$;

\echo '3/5 authenticated owner sees only their manual run and no scheduler claim'
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
do $$
declare
  projection jsonb;
begin
  projection := public.get_storyops_ai_office_recent(
    '10000000-0000-4000-8000-000000000001',
    20
  );
  if projection ->> 'actorUserId' <> '10000000-0000-4000-8000-000000000101'
    or projection ->> 'manualTriggeredOnly' <> 'true'
    or projection ->> 'schedulerConfigured' <> 'false'
    or jsonb_array_length(projection -> 'runs') <> 1
    or projection #>> '{runs,0,automationRunId}'
      <> '30000000-0000-4000-8000-000000000001'
  then
    raise exception 'Owner AI Office readback is incorrect: %', projection;
  end if;
end;
$$;
reset role;

\echo '4/5 dispatcher readback is actor-bound and technician readback is denied'
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000102',
  true
);
do $$
declare
  projection jsonb;
begin
  projection := public.get_storyops_ai_office_recent(
    '10000000-0000-4000-8000-000000000001',
    20
  );
  if projection ->> 'actorUserId' <> '10000000-0000-4000-8000-000000000102'
    or jsonb_array_length(projection -> 'runs') <> 0
  then
    raise exception 'Dispatcher readback exposed another actor run: %', projection;
  end if;
end;
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000103',
  true
);
do $$
declare
  denied boolean := false;
begin
  begin
    perform public.get_storyops_ai_office_recent(
      '10000000-0000-4000-8000-000000000001',
      10
    );
  exception when others then
    denied := sqlerrm like '%AI_OFFICE_READ_FORBIDDEN%';
  end;
  if not denied then
    raise exception 'Technician AI Office readback did not fail closed';
  end if;
end;
$$;
reset role;

\echo '5/5 paused companies cannot begin runs while prior readback remains available'
update public.companies
set status = 'paused'
where id = '10000000-0000-4000-8000-000000000001';
set local role service_role;
do $$
declare
  denied boolean := false;
begin
  begin
    perform public.begin_storyops_ai_office_run(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '30000000-0000-4000-8000-000000000003',
      'owner_briefing',
      'ai-office:manual:30000000-0000-4000-8000-000000000003',
      '{}'::jsonb,
      false,
      now()
    );
  exception when others then
    denied := sqlerrm like '%AI_OFFICE_RUN_COMPANY_NOT_ACTIVE%';
  end;
  if not denied then
    raise exception 'Paused company was allowed to begin an AI Office run';
  end if;
end;
$$;
reset role;

rollback;
