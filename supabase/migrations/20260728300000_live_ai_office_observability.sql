-- Durable, manual-triggered AI Office execution/readback.
--
-- Browser roles may observe company-scoped runs but cannot fabricate run or
-- briefing truth. The Edge function records start/completion/failure through
-- finite service-role RPCs, and the authenticated read model is bound to
-- auth.uid() plus an active owner/dispatcher membership.

drop policy if exists automation_runs_owner_manage on public.automation_runs;
drop policy if exists owner_briefings_backoffice_insert on public.owner_briefings;
drop policy if exists owner_briefings_backoffice_update on public.owner_briefings;
drop policy if exists owner_briefings_backoffice_delete on public.owner_briefings;

revoke insert, update, delete on public.automation_runs
  from public, anon, authenticated, service_role;
revoke insert, update, delete on public.owner_briefings
  from public, anon, authenticated, service_role;

create or replace function private.storyops_ai_office_run_json(
  p_run public.automation_runs
)
returns jsonb
language sql
security definer
stable
set search_path = pg_catalog, public, private
as $$
  select jsonb_build_object(
    'schemaVersion', 'storyops-ai-office-run-v1',
    'companyId', p_run.company_id,
    'actorUserId', p_run.input ->> 'actorUserId',
    'automationRunId', p_run.id,
    'agent', p_run.input ->> 'agent',
    'triggerType', 'manual',
    'schedulerConfigured', false,
    'modelMode', case
      when p_run.output is null then null
      else p_run.output -> 'modelMode'
    end,
    'durableStatus', p_run.status,
    'startedAt', p_run.started_at,
    'completedAt', p_run.completed_at,
    'ownerBriefingId', (
      select briefing.id
      from public.owner_briefings briefing
      where briefing.company_id = p_run.company_id
        and briefing.generated_by_run_id = p_run.id
      order by briefing.updated_at desc, briefing.id
      limit 1
    ),
    'result', case
      when p_run.output is null then null
      else p_run.output -> 'result'
    end,
    'errorCode', p_run.error_code,
    'errorMessage', p_run.error_message
  );
$$;

revoke all on function private.storyops_ai_office_run_json(public.automation_runs)
  from public, anon, authenticated, service_role;

create or replace function public.begin_storyops_ai_office_run(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_run_id uuid,
  p_agent text,
  p_idempotency_key text,
  p_root_selector jsonb,
  p_manual_input_present boolean,
  p_requested_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  expected_input jsonb;
  run_row public.automation_runs%rowtype;
begin
  if p_company_id is null
    or p_actor_user_id is null
    or p_run_id is null
    or p_agent is null
    or p_agent not in (
      'intake', 'estimating', 'scheduling', 'follow_up', 'marketing',
      'finance', 'safety', 'owner_briefing'
    )
    or p_idempotency_key <> ('ai-office:manual:' || p_run_id::text)
    or p_requested_at is null
    or p_requested_at < now() - interval '10 minutes'
    or p_requested_at > now() + interval '2 minutes'
    or p_manual_input_present is null
    or p_root_selector is null
    or jsonb_typeof(p_root_selector) <> 'object'
    or octet_length(p_root_selector::text) > 1024
  then
    raise exception 'AI_OFFICE_RUN_INVALID';
  end if;

  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = p_actor_user_id
      and membership.active
      and membership.role in ('owner', 'dispatcher')
  ) then
    raise exception 'AI_OFFICE_RUN_ACTOR_FORBIDDEN';
  end if;
  if not exists (
    select 1
    from public.companies company
    where company.id = p_company_id
      and company.status = 'active'
  ) then
    raise exception 'AI_OFFICE_RUN_COMPANY_NOT_ACTIVE';
  end if;

  if (
    (p_agent = 'owner_briefing' and p_root_selector <> '{}'::jsonb)
    or (
      p_agent <> 'owner_briefing'
      and (
        (p_root_selector - array['type', 'id']) <> '{}'::jsonb
        or coalesce(p_root_selector ->> 'type', '') !~ '^[a-z][a-z_]{1,79}$'
        or coalesce(p_root_selector ->> 'id', '') !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    )
  )
  then
    raise exception 'AI_OFFICE_RUN_SELECTOR_INVALID';
  end if;
  if p_agent <> 'owner_briefing'
    and not (
      (p_agent = 'intake' and p_root_selector ->> 'type' in (
        'lead', 'customer', 'consent_record'
      ))
      or (p_agent = 'estimating' and p_root_selector ->> 'type' in (
        'estimate', 'property', 'lead', 'quote', 'property_measurement',
        'photo_analysis', 'estimate_line', 'price_book'
      ))
      or (p_agent = 'scheduling' and p_root_selector ->> 'type' in (
        'job', 'visit', 'scheduling_evidence_receipt', 'property'
      ))
      or (p_agent = 'follow_up' and p_root_selector ->> 'type' in (
        'customer', 'lead', 'quote', 'job', 'invoice', 'consent_record'
      ))
      or (p_agent = 'marketing' and p_root_selector ->> 'type' in (
        'customer', 'lead', 'consent_record'
      ))
      or (p_agent = 'finance' and p_root_selector ->> 'type' in (
        'invoice', 'customer', 'job', 'payment'
      ))
      or (p_agent = 'safety' and p_root_selector ->> 'type' in (
        'incident', 'job', 'visit', 'property', 'photo_analysis'
      ))
    )
  then
    raise exception 'AI_OFFICE_RUN_SELECTOR_OUT_OF_SCOPE';
  end if;

  expected_input := jsonb_build_object(
    'schemaVersion', 'storyops-ai-office-durable-input-v1',
    'actorUserId', p_actor_user_id,
    'agent', p_agent,
    'rootSelector', p_root_selector,
    'manualInputPresent', p_manual_input_present,
    'requestedAt', p_requested_at,
    'manualTriggered', true,
    'schedulerConfigured', false
  );

  insert into public.automation_runs(
    id,
    company_id,
    automation_key,
    trigger_type,
    trigger_reference,
    status,
    started_at,
    idempotency_key,
    attempt,
    input
  )
  values (
    p_run_id,
    p_company_id,
    'ai-office:' || p_agent,
    'manual',
    'user:' || p_actor_user_id::text,
    'running',
    now(),
    p_idempotency_key,
    1,
    expected_input
  )
  on conflict (id) do nothing;

  select *
  into run_row
  from public.automation_runs run
  where run.id = p_run_id
  for update;

  if not found
    or run_row.company_id <> p_company_id
    or run_row.automation_key <> ('ai-office:' || p_agent)
    or run_row.trigger_type <> 'manual'
    or run_row.idempotency_key <> p_idempotency_key
    or run_row.input <> expected_input
  then
    raise exception 'AI_OFFICE_RUN_IDEMPOTENCY_CONFLICT';
  end if;

  if run_row.status = 'failed' then
    update public.automation_runs
    set status = 'running',
        started_at = now(),
        completed_at = null,
        attempt = attempt + 1,
        output = null,
        error_code = null,
        error_message = null,
        approval_request_id = null
    where id = p_run_id
    returning * into run_row;
  end if;

  return private.storyops_ai_office_run_json(run_row);
end;
$$;

create or replace function public.complete_storyops_ai_office_run(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_run_id uuid,
  p_agent text,
  p_model_mode text,
  p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  run_row public.automation_runs%rowtype;
  completed_row public.automation_runs%rowtype;
  durable_status public.run_status;
  first_approval_id uuid;
  company_timezone text;
  briefing_date_value date;
  period_starts_value timestamptz;
  period_ends_value timestamptz;
  completed_at_value timestamptz;
begin
  if p_company_id is null
    or p_actor_user_id is null
    or p_run_id is null
    or p_agent is null
    or p_agent not in (
      'intake', 'estimating', 'scheduling', 'follow_up', 'marketing',
      'finance', 'safety', 'owner_briefing'
    )
    or p_model_mode is null
    or p_model_mode not in ('sandbox', 'live')
    or p_result is null
    or jsonb_typeof(p_result) <> 'object'
    or octet_length(p_result::text) > 262144
    or (p_result - array[
      'traceId', 'runId', 'agent', 'modelProvider', 'output', 'actions',
      'injectionSignals', 'completedAt', 'replayed'
    ]) <> '{}'::jsonb
    or not (p_result ?& array[
      'traceId', 'runId', 'agent', 'modelProvider', 'output', 'actions',
      'injectionSignals', 'completedAt', 'replayed'
    ])
    or p_result ->> 'runId' <> p_run_id::text
    or coalesce(p_result ->> 'traceId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or length(coalesce(p_result ->> 'modelProvider', '')) not between 1 and 120
    or coalesce(jsonb_typeof(p_result -> 'output'), 'missing') <> 'object'
    or coalesce(jsonb_typeof(p_result -> 'actions'), 'missing') <> 'array'
    or jsonb_array_length(p_result -> 'actions') > 25
    or coalesce(jsonb_typeof(p_result -> 'injectionSignals'), 'missing') <> 'array'
    or jsonb_array_length(p_result -> 'injectionSignals') > 100
    or coalesce(jsonb_typeof(p_result -> 'replayed'), 'missing') <> 'boolean'
    or p_result -> 'replayed' <> 'false'::jsonb
    or length(coalesce(p_result ->> 'completedAt', '')) not between 20 and 64
  then
    raise exception 'AI_OFFICE_RUN_RESULT_INVALID';
  end if;
  begin
    completed_at_value := (p_result ->> 'completedAt')::timestamptz;
  exception when others then
    raise exception 'AI_OFFICE_RUN_RESULT_INVALID';
  end;
  if completed_at_value < now() - interval '30 minutes'
    or completed_at_value > now() + interval '2 minutes'
  then
    raise exception 'AI_OFFICE_RUN_COMPLETION_TIME_INVALID';
  end if;

  select *
  into run_row
  from public.automation_runs run
  where run.id = p_run_id
    and run.company_id = p_company_id
  for update;
  if not found
    or run_row.input ->> 'actorUserId' <> p_actor_user_id::text
    or run_row.input ->> 'agent' <> p_agent
    or p_result ->> 'agent' <> p_agent
    or run_row.trigger_type <> 'manual'
  then
    raise exception 'AI_OFFICE_RUN_BINDING_CONFLICT';
  end if;

  if run_row.status in ('succeeded', 'waiting_approval') then
    if run_row.output ->> 'modelMode' <> p_model_mode
      or run_row.output -> 'result' <> p_result
    then
      raise exception 'AI_OFFICE_RUN_COMPLETION_CONFLICT';
    end if;
    return private.storyops_ai_office_run_json(run_row);
  end if;
  if run_row.status <> 'running' then
    raise exception 'AI_OFFICE_RUN_NOT_RUNNING';
  end if;

  durable_status := case
    when exists (
      select 1
      from jsonb_array_elements(p_result -> 'actions') action
      where action ->> 'status' = 'approval_required'
    ) then 'waiting_approval'::public.run_status
    else 'succeeded'::public.run_status
  end;

  select (action ->> 'approvalId')::uuid
  into first_approval_id
  from jsonb_array_elements(p_result -> 'actions') action
  where action ->> 'status' = 'approval_required'
    and coalesce(action ->> 'approvalId', '') ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  order by action ->> 'actionId'
  limit 1;

  update public.automation_runs
  set status = durable_status,
      completed_at = completed_at_value,
      output = jsonb_build_object(
        'schemaVersion', 'storyops-ai-office-durable-output-v1',
        'modelMode', p_model_mode,
        'result', p_result
      ),
      error_code = null,
      error_message = null,
      approval_request_id = first_approval_id
  where id = p_run_id
  returning * into completed_row;

  if p_result ->> 'agent' = 'owner_briefing' then
    select company.timezone
    into company_timezone
    from public.companies company
    where company.id = p_company_id;
    company_timezone := coalesce(company_timezone, 'UTC');
    briefing_date_value := (now() at time zone company_timezone)::date;
    period_starts_value :=
      briefing_date_value::timestamp at time zone company_timezone;
    period_ends_value :=
      (briefing_date_value + 1)::timestamp at time zone company_timezone;

    insert into public.owner_briefings(
      company_id,
      briefing_date,
      period_starts_at,
      period_ends_at,
      status,
      sections,
      generated_by_run_id
    )
    values (
      p_company_id,
      briefing_date_value,
      period_starts_value,
      period_ends_value,
      'ready',
      jsonb_build_array(jsonb_build_object(
        'schemaVersion', 'storyops-owner-briefing-section-v1',
        'summary', p_result #>> '{output,summary}',
        'confidence', p_result #> '{output,confidence}',
        'evidence', p_result #> '{output,evidence}',
        'unknowns', p_result #> '{output,unknowns}',
        'actions', p_result -> 'actions',
        'injectionSignals', p_result -> 'injectionSignals',
        'traceId', p_result ->> 'traceId',
        'completedAt', p_result ->> 'completedAt',
        'modelMode', p_model_mode,
        'modelProvider', p_result ->> 'modelProvider'
      )),
      p_run_id
    )
    on conflict (company_id, briefing_date) do update
    set period_starts_at = excluded.period_starts_at,
        period_ends_at = excluded.period_ends_at,
        status = 'ready',
        sections = excluded.sections,
        generated_by_run_id = excluded.generated_by_run_id,
        delivered_at = null;
  end if;

  select *
  into completed_row
  from public.automation_runs run
  where run.id = p_run_id;
  return private.storyops_ai_office_run_json(completed_row);
end;
$$;

create or replace function public.fail_storyops_ai_office_run(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_run_id uuid,
  p_agent text,
  p_error_code text,
  p_error_message text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  run_row public.automation_runs%rowtype;
begin
  if p_company_id is null
    or p_actor_user_id is null
    or p_run_id is null
    or p_agent is null
    or p_agent not in (
      'intake', 'estimating', 'scheduling', 'follow_up', 'marketing',
      'finance', 'safety', 'owner_briefing'
    )
  then
    raise exception 'AI_OFFICE_RUN_AGENT_INVALID';
  end if;

  select *
  into run_row
  from public.automation_runs run
  where run.id = p_run_id
    and run.company_id = p_company_id
  for update;
  if not found
    or run_row.input ->> 'actorUserId' <> p_actor_user_id::text
    or run_row.input ->> 'agent' <> p_agent
    or run_row.trigger_type <> 'manual'
  then
    raise exception 'AI_OFFICE_RUN_BINDING_CONFLICT';
  end if;

  if run_row.status in ('succeeded', 'waiting_approval') then
    return private.storyops_ai_office_run_json(run_row);
  end if;
  if run_row.status = 'running' then
    update public.automation_runs
    set status = 'failed',
        completed_at = now(),
        error_code = case
          when coalesce(p_error_code, '') ~ '^[A-Z0-9_]{1,120}$'
            then p_error_code
          else 'AI_OFFICE_RUN_FAILED'
        end,
        error_message = left(
          coalesce(nullif(btrim(p_error_message), ''), 'AI Office run failed.'),
          500
        )
    where id = p_run_id
    returning * into run_row;
  end if;
  return private.storyops_ai_office_run_json(run_row);
end;
$$;

create or replace function public.get_storyops_ai_office_recent(
  p_company_id uuid,
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private
as $$
declare
  actor_user_id uuid := auth.uid();
  bounded_limit integer;
begin
  if actor_user_id is null then
    raise exception 'AI_OFFICE_READ_AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = actor_user_id
      and membership.active
      and membership.role in ('owner', 'dispatcher')
  ) then
    raise exception 'AI_OFFICE_READ_FORBIDDEN';
  end if;
  bounded_limit := least(greatest(coalesce(p_limit, 10), 1), 20);

  return jsonb_build_object(
    'schemaVersion', 'storyops-ai-office-recent-v1',
    'companyId', p_company_id,
    'actorUserId', actor_user_id,
    'manualTriggeredOnly', true,
    'schedulerConfigured', false,
    'runs', coalesce((
      select jsonb_agg(
        private.storyops_ai_office_run_json(run)
        order by run.created_at desc, run.id desc
      )
      from (
        select candidate.*
        from public.automation_runs candidate
        where candidate.company_id = p_company_id
          and candidate.trigger_type = 'manual'
          and candidate.automation_key like 'ai-office:%'
          and candidate.input ->> 'actorUserId' = actor_user_id::text
        order by candidate.created_at desc, candidate.id desc
        limit bounded_limit
      ) run
    ), '[]'::jsonb),
    'asOf', now()
  );
end;
$$;

revoke all on function public.begin_storyops_ai_office_run(
  uuid, uuid, uuid, text, text, jsonb, boolean, timestamptz
) from public, anon, authenticated;
revoke all on function public.complete_storyops_ai_office_run(
  uuid, uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_storyops_ai_office_run(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.begin_storyops_ai_office_run(
  uuid, uuid, uuid, text, text, jsonb, boolean, timestamptz
) to service_role;
grant execute on function public.complete_storyops_ai_office_run(
  uuid, uuid, uuid, text, text, jsonb
) to service_role;
grant execute on function public.fail_storyops_ai_office_run(
  uuid, uuid, uuid, text, text, text
) to service_role;

revoke all on function public.get_storyops_ai_office_recent(uuid, integer)
  from public, anon;
grant execute on function public.get_storyops_ai_office_recent(uuid, integer)
  to authenticated;

comment on function public.get_storyops_ai_office_recent(uuid, integer) is
  'Returns finite manual-triggered AI Office run truth for the authenticated active owner/dispatcher. It never claims a scheduler exists.';
