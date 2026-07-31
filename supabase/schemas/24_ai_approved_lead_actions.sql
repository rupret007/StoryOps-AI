-- Exact-payload, owner-approved execution for the two finite AI lead commands.
--
-- These internal mutations are intentionally separate from provider actions.
-- The approval row is locked, the command is applied, and the approval is
-- consumed in one database transaction. A lost HTTP response replays the
-- stored receipt instead of applying a second mutation.

create or replace function public.execute_ai_approved_lead_action(
  p_company_id uuid,
  p_approval_request_id uuid,
  p_actor_user_id uuid,
  p_payload_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  approval_row public.approval_requests%rowtype;
  exact_payload jsonb;
  command_type_value text;
  command_id_value uuid := gen_random_uuid();
  entity_id_value uuid;
  expected_version_value integer;
  resulting_version integer;
  completed_time timestamptz := clock_timestamp();
  command_receipt jsonb;
  execution_receipt_value jsonb;
  result_response jsonb;
begin
  if not exists (
    select 1
    from public.company_memberships membership
    join public.companies company
      on company.id = membership.company_id
     and company.status = 'active'
    where membership.company_id = p_company_id
      and membership.user_id = p_actor_user_id
      and membership.role = 'owner'
      and membership.active
  ) then
    raise exception using message = 'APPROVED_LEAD_OWNER_REQUIRED';
  end if;
  if p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception using message = 'APPROVED_LEAD_PAYLOAD_MISMATCH';
  end if;

  select *
  into approval_row
  from public.approval_requests approval
  where approval.id = p_approval_request_id
    and approval.company_id = p_company_id
  for update;
  if not found then
    raise exception using message = 'APPROVED_LEAD_NOT_FOUND';
  end if;

  if approval_row.consumed_at is not null then
    if approval_row.status = 'approved'
      and approval_row.execution_receipt ->> 'toolName' = approval_row.action_type
      and approval_row.execution_receipt ->> 'payloadHash' = p_payload_hash
      and approval_row.execution_receipt ->> 'actionId'
        = approval_row.action_payload ->> 'actionId'
    then
      return jsonb_build_object(
        'approvalId', approval_row.id,
        'actionId', approval_row.action_payload ->> 'actionId',
        'toolName', approval_row.action_type,
        'status', 'succeeded',
        'receipt', approval_row.execution_receipt,
        'completedAt', approval_row.consumed_at,
        'replayed', true
      );
    end if;
    raise exception using message = 'APPROVED_LEAD_NOT_EXECUTABLE';
  end if;

  if approval_row.status <> 'approved'
    or (approval_row.expires_at is not null and approval_row.expires_at <= completed_time)
    or approval_row.action_type not in ('records.create_lead', 'records.update_lead')
    or approval_row.reason <> 'other'
    or approval_row.entity_type <> 'ai_action'
    or approval_row.entity_id is not null
    or jsonb_typeof(approval_row.action_payload) <> 'object'
    or jsonb_typeof(approval_row.action_payload -> 'exactPayload') <> 'object'
    or approval_row.action_payload ->> 'toolName' <> approval_row.action_type
    or nullif(approval_row.action_payload ->> 'runId', '') is null
    or nullif(approval_row.action_payload ->> 'actionId', '') is null
    or approval_row.action_payload ->> 'payloadHash' <> p_payload_hash
  then
    raise exception using message = 'APPROVED_LEAD_NOT_EXECUTABLE';
  end if;
  exact_payload := approval_row.action_payload -> 'exactPayload';

  if approval_row.action_type = 'records.create_lead' then
    if (exact_payload - array[
      'source', 'displayName', 'requestedServices', 'preferredContactChannel'
    ]) <> '{}'::jsonb
      or exact_payload ->> 'source' not in (
        'web', 'chat', 'sms', 'phone', 'email', 'referral', 'manual'
      )
      or jsonb_typeof(exact_payload -> 'displayName') <> 'string'
      or length(btrim(exact_payload ->> 'displayName')) not between 1 and 160
      or (
        exact_payload ? 'preferredContactChannel'
        and (
          jsonb_typeof(exact_payload -> 'preferredContactChannel') <> 'string'
          or exact_payload ->> 'preferredContactChannel' not in ('email', 'sms', 'phone')
        )
      )
      or jsonb_typeof(coalesce(exact_payload -> 'requestedServices', '[]'::jsonb))
        <> 'array'
      or jsonb_array_length(coalesce(exact_payload -> 'requestedServices', '[]'::jsonb)) > 12
      or exists (
        select 1
        from jsonb_array_elements(
          coalesce(exact_payload -> 'requestedServices', '[]'::jsonb)
        ) service
        where jsonb_typeof(service) <> 'string'
          or (service #>> '{}') !~ '^[a-z0-9][a-z0-9_-]{0,79}$'
      )
      or exists (
        select 1
        from jsonb_array_elements_text(
          coalesce(exact_payload -> 'requestedServices', '[]'::jsonb)
        ) service(code)
        group by service.code
        having count(*) > 1
      )
      or exists (
        select 1
        from jsonb_array_elements_text(
          coalesce(exact_payload -> 'requestedServices', '[]'::jsonb)
        ) service(code)
        where not exists (
          select 1
          from public.service_catalog catalog
          where catalog.company_id = p_company_id
            and catalog.code = service.code
            and catalog.active
        )
      )
    then
      raise exception using message = 'APPROVED_LEAD_PAYLOAD_MISMATCH';
    end if;

    entity_id_value := gen_random_uuid();
    command_type_value := 'lead.create';
    expected_version_value := 0;
    insert into public.leads(
      id, company_id, source, status, display_name, requested_services,
      preferred_contact_channel, owner_user_id
    )
    values (
      entity_id_value,
      p_company_id,
      exact_payload ->> 'source',
      'new',
      btrim(exact_payload ->> 'displayName'),
      array(
        select jsonb_array_elements_text(
          coalesce(exact_payload -> 'requestedServices', '[]'::jsonb)
        )
      ),
      nullif(exact_payload ->> 'preferredContactChannel', ''),
      p_actor_user_id
    )
    returning version into resulting_version;
  else
    if (exact_payload - array[
      'leadId', 'expectedVersion', 'status', 'qualificationSummary',
      'disqualificationReason'
    ]) <> '{}'::jsonb
      or coalesce(exact_payload ->> 'leadId', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(exact_payload ->> 'expectedVersion', '') !~ '^[1-9][0-9]{0,9}$'
      or exact_payload ->> 'status' not in (
        'qualifying', 'qualified', 'unqualified', 'lost'
      )
      or (
        exact_payload ? 'qualificationSummary'
        and (
          jsonb_typeof(exact_payload -> 'qualificationSummary') <> 'string'
          or length(btrim(exact_payload ->> 'qualificationSummary')) not between 1 and 2000
        )
      )
      or (
        exact_payload ->> 'status' = 'unqualified'
        and (
          jsonb_typeof(exact_payload -> 'disqualificationReason') <> 'string'
          or length(btrim(exact_payload ->> 'disqualificationReason')) not between 1 and 1000
        )
      )
      or (
        exact_payload ->> 'status' <> 'unqualified'
        and exact_payload ? 'disqualificationReason'
      )
    then
      raise exception using message = 'APPROVED_LEAD_PAYLOAD_MISMATCH';
    end if;

    entity_id_value := (exact_payload ->> 'leadId')::uuid;
    expected_version_value := (exact_payload ->> 'expectedVersion')::integer;
    command_type_value := 'lead.qualify';
    update public.leads lead
    set
      status = exact_payload ->> 'status',
      qualification_summary =
        nullif(btrim(exact_payload ->> 'qualificationSummary'), ''),
      disqualification_reason = case
        when exact_payload ->> 'status' = 'unqualified'
          then btrim(exact_payload ->> 'disqualificationReason')
        else null
      end
    where lead.id = entity_id_value
      and lead.company_id = p_company_id
      and lead.version = expected_version_value
      and lead.status in ('new', 'qualifying', 'qualified')
    returning version into resulting_version;
    if not found then
      raise exception using message = 'APPROVED_LEAD_TRANSITION_CONFLICT';
    end if;
  end if;

  command_receipt := jsonb_build_object(
    'commandId', command_id_value,
    'commandType', command_type_value,
    'status', 'applied',
    'replayed', false,
    'entityId', entity_id_value,
    'version', resulting_version,
    'requestHash', p_payload_hash,
    'serverTime', completed_time
  );
  execution_receipt_value := jsonb_build_object(
    'actionId', approval_row.action_payload ->> 'actionId',
    'runId', approval_row.action_payload ->> 'runId',
    'toolName', approval_row.action_type,
    'payloadHash', p_payload_hash,
    'command', command_receipt,
    'executedBy', p_actor_user_id,
    'executedAt', completed_time
  );
  result_response := jsonb_build_object(
    'approvalId', approval_row.id,
    'actionId', approval_row.action_payload ->> 'actionId',
    'toolName', approval_row.action_type,
    'status', 'succeeded',
    'receipt', execution_receipt_value,
    'completedAt', completed_time,
    'replayed', false
  );

  perform private.authorize_storyops_approval_consumption(
    p_company_id,
    approval_row.id
  );
  update public.approval_requests
  set
    consumed_at = completed_time,
    execution_receipt = execution_receipt_value
  where id = approval_row.id
    and consumed_at is null;
  if not found then
    raise exception using message = 'APPROVED_LEAD_NOT_EXECUTABLE';
  end if;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, retain_until
  )
  values (
    p_company_id,
    'user',
    p_actor_user_id::text,
    'ai.approved_lead_action.executed',
    'lead',
    entity_id_value,
    execution_receipt_value,
    now() + interval '7 years'
  );
  return result_response;
end;
$$;

revoke all on function public.execute_ai_approved_lead_action(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.execute_ai_approved_lead_action(
  uuid, uuid, uuid, text
) to service_role;

comment on function public.execute_ai_approved_lead_action(
  uuid, uuid, uuid, text
) is
  'Atomically executes and consumes one exact owner-approved finite lead create or qualification payload; replays the stored receipt after ambiguous HTTP completion.';
