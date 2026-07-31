\set ON_ERROR_STOP on

begin;

\echo '1/6 owner-approved lead creation is applied and consumed atomically'
do $$
declare
  create_result jsonb;
  replay_result jsonb;
  lead_id_value uuid;
  update_result jsonb;
  update_replay jsonb;
  lead_version integer;
begin
  insert into public.approval_requests(
    id, company_id, reason, risk_level, status, requested_by_type,
    requested_by_id, requested_at, expires_at, entity_type, entity_id,
    action_type, action_payload, summary, policy_version, decided_by,
    decided_at, decision_note
  )
  values (
    '97000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000001',
    'other',
    'low',
    'approved',
    'agent',
    'intake',
    now() - interval '1 minute',
    now() + interval '1 hour',
    'ai_action',
    null,
    'records.create_lead',
    jsonb_build_object(
      'exactPayload', jsonb_build_object(
        'source', 'web',
        'displayName', 'Approved AI lead',
        'requestedServices', jsonb_build_array('gutter-cleaning'),
        'preferredContactChannel', 'email'
      ),
      'payloadHash', repeat('a', 64),
      'runId', 'approved-lead-run-1',
      'actionId', 'approved-lead-create-1',
      'toolName', 'records.create_lead'
    ),
    'Create the exact reviewed lead shell.',
    'AI-100-sensitive-action',
    '10000000-0000-4000-8000-000000000101',
    now(),
    'Exact payload reviewed.'
  );

  create_result := public.execute_ai_approved_lead_action(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000101',
    repeat('a', 64)
  );
  if create_result ->> 'status' <> 'succeeded'
    or coalesce((create_result ->> 'replayed')::boolean, true)
  then
    raise exception 'Approved lead creation did not return a first-run receipt';
  end if;
  lead_id_value := (create_result #>> '{receipt,command,entityId}')::uuid;
  if not exists (
    select 1
    from public.leads lead
    where lead.id = lead_id_value
      and lead.company_id = '10000000-0000-4000-8000-000000000001'
      and lead.status = 'new'
      and lead.display_name = 'Approved AI lead'
      and lead.requested_services = array['gutter-cleaning']
  ) then
    raise exception 'Approved lead was not persisted exactly';
  end if;
  if not exists (
    select 1
    from public.approval_requests approval
    where approval.id = '97000000-0000-4000-8000-000000000101'
      and approval.consumed_at is not null
      and approval.execution_receipt #>> '{command,entityId}' = lead_id_value::text
  ) then
    raise exception 'Approved lead creation did not consume the approval';
  end if;

  replay_result := public.execute_ai_approved_lead_action(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000101',
    repeat('a', 64)
  );
  if not (replay_result ->> 'replayed')::boolean
    or replay_result #>> '{receipt,command,entityId}' <> lead_id_value::text
    or (
      select count(*)
      from public.leads lead
      where lead.display_name = 'Approved AI lead'
        and lead.company_id = '10000000-0000-4000-8000-000000000001'
    ) <> 1
  then
    raise exception 'Approved lead creation did not replay exactly once';
  end if;

  select version
  into lead_version
  from public.leads
  where id = lead_id_value;
  insert into public.approval_requests(
    id, company_id, reason, risk_level, status, requested_by_type,
    requested_by_id, requested_at, expires_at, entity_type, entity_id,
    action_type, action_payload, summary, policy_version, decided_by,
    decided_at, decision_note
  )
  values (
    '97000000-0000-4000-8000-000000000102',
    '10000000-0000-4000-8000-000000000001',
    'other',
    'low',
    'approved',
    'agent',
    'intake',
    now() - interval '1 minute',
    now() + interval '1 hour',
    'ai_action',
    null,
    'records.update_lead',
    jsonb_build_object(
      'exactPayload', jsonb_build_object(
        'leadId', lead_id_value,
        'expectedVersion', lead_version,
        'status', 'qualified',
        'qualificationSummary', 'Service and timing were owner reviewed.'
      ),
      'payloadHash', repeat('b', 64),
      'runId', 'approved-lead-run-1',
      'actionId', 'approved-lead-update-1',
      'toolName', 'records.update_lead'
    ),
    'Apply the exact reviewed qualification.',
    'AI-100-sensitive-action',
    '10000000-0000-4000-8000-000000000101',
    now(),
    'Exact payload reviewed.'
  );

  update_result := public.execute_ai_approved_lead_action(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000102',
    '10000000-0000-4000-8000-000000000101',
    repeat('b', 64)
  );
  if update_result ->> 'status' <> 'succeeded'
    or not exists (
      select 1
      from public.leads lead
      where lead.id = lead_id_value
        and lead.status = 'qualified'
        and lead.qualification_summary = 'Service and timing were owner reviewed.'
    )
  then
    raise exception 'Approved qualification was not applied';
  end if;
  update_replay := public.execute_ai_approved_lead_action(
    '10000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000102',
    '10000000-0000-4000-8000-000000000101',
    repeat('b', 64)
  );
  if not (update_replay ->> 'replayed')::boolean then
    raise exception 'Approved qualification did not replay';
  end if;
end;
$$;

\echo '2/6 a dispatcher cannot execute an owner-only approved lead action'
do $$
begin
  begin
    perform public.execute_ai_approved_lead_action(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000102',
      repeat('a', 64)
    );
    raise exception 'Dispatcher unexpectedly executed an approved lead action';
  exception
    when raise_exception then
      if sqlerrm = 'Dispatcher unexpectedly executed an approved lead action' then
        raise;
      end if;
  end;
end;
$$;

\echo '3/6 payload hash changes cannot replay a consumed approval'
do $$
begin
  begin
    perform public.execute_ai_approved_lead_action(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000101',
      repeat('c', 64)
    );
    raise exception 'Changed payload hash unexpectedly replayed';
  exception
    when raise_exception then
      if sqlerrm = 'Changed payload hash unexpectedly replayed' then
        raise;
      end if;
  end;
end;
$$;

\echo '4/6 paused companies cannot consume an otherwise valid lead approval'
insert into public.approval_requests(
  id, company_id, reason, risk_level, status, requested_by_type,
  requested_by_id, requested_at, expires_at, entity_type, entity_id,
  action_type, action_payload, summary, policy_version, decided_by,
  decided_at, decision_note
)
values (
  '97000000-0000-4000-8000-000000000103',
  '10000000-0000-4000-8000-000000000001',
  'other',
  'low',
  'approved',
  'agent',
  'intake',
  now() - interval '1 minute',
  now() + interval '1 hour',
  'ai_action',
  null,
  'records.create_lead',
  jsonb_build_object(
    'exactPayload', jsonb_build_object(
      'source', 'web',
      'displayName', 'Paused company lead',
      'requestedServices', jsonb_build_array('gutter-cleaning')
    ),
    'payloadHash', repeat('d', 64),
    'runId', 'approved-lead-run-paused',
    'actionId', 'approved-lead-create-paused',
    'toolName', 'records.create_lead'
  ),
  'This action must remain unconsumed while the company is paused.',
  'AI-100-sensitive-action',
  '10000000-0000-4000-8000-000000000101',
  now(),
  'Exact payload reviewed before pause.'
);
update public.companies
set status = 'paused'
where id = '10000000-0000-4000-8000-000000000001';
do $$
declare
  denied boolean := false;
begin
  begin
    perform public.execute_ai_approved_lead_action(
      '10000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000103',
      '10000000-0000-4000-8000-000000000101',
      repeat('d', 64)
    );
  exception
    when others then
      denied := position('APPROVED_LEAD_OWNER_REQUIRED' in sqlerrm) > 0;
      if not denied then
        raise;
      end if;
  end;
  if not denied
    or exists (
      select 1 from public.leads
      where company_id = '10000000-0000-4000-8000-000000000001'
        and display_name = 'Paused company lead'
    )
    or exists (
      select 1 from public.approval_requests
      where id = '97000000-0000-4000-8000-000000000103'
        and consumed_at is not null
    )
  then
    raise exception 'Paused company executed or consumed an approved lead action';
  end if;
end;
$$;

\echo '5/6 direct authenticated execution is not granted'
do $$
begin
  if has_function_privilege(
    'authenticated',
    'public.execute_ai_approved_lead_action(uuid,uuid,uuid,text)',
    'execute'
  ) then
    raise exception 'Authenticated role unexpectedly has direct execution privilege';
  end if;
end;
$$;

\echo '6/6 approved lead action integration contract passed'

rollback;
