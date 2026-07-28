-- Durable, exact-payload execution boundary for owner-approved AI actions.
--
-- V1 deliberately supports only Stripe refunds. Other approval categories stay
-- non-executable until they have an equally authoritative, company-scoped
-- validator. The provider idempotency key is derived in the database and is
-- therefore independent of caller-controlled request keys.

create table public.approved_action_executions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  approval_request_id uuid not null
    references public.approval_requests(id) on delete restrict,
  request_key text not null check (length(request_key) between 8 and 256),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  provider_idempotency_key text not null
    check (length(provider_idempotency_key) between 32 and 255),
  tool_name text not null,
  risk_level text not null check (risk_level in ('low', 'medium', 'high', 'critical')),
  status text not null
    check (status in ('in_progress', 'retryable', 'succeeded', 'failed_terminal')),
  attempt_count integer not null default 1 check (attempt_count between 1 and 20),
  execution_token uuid,
  lease_expires_at timestamptz,
  response jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (approval_request_id),
  unique (company_id, request_key),
  unique (company_id, provider_idempotency_key),
  check (
    (status = 'in_progress' and execution_token is not null and lease_expires_at is not null)
    or (status <> 'in_progress' and execution_token is null and lease_expires_at is null)
  ),
  check (status <> 'succeeded' or (response is not null and completed_at is not null)),
  check (status <> 'failed_terminal' or (response is not null and completed_at is not null))
);

create index approved_action_executions_status_idx
  on public.approved_action_executions(company_id, status, lease_expires_at);

create unique index payments_one_refund_per_approval_idx
  on public.payments(approval_request_id)
  where payment_type = 'refund' and approval_request_id is not null;

alter table public.approved_action_executions enable row level security;
revoke all on table public.approved_action_executions from public, anon, authenticated;

create or replace function public.claim_ai_approved_action(
  p_company_id uuid,
  p_approval_request_id uuid,
  p_actor_user_id uuid,
  p_request_key text,
  p_payload_hash text
)
returns table(
  claim_status text,
  execution_id uuid,
  execution_token uuid,
  provider_idempotency_key text,
  stored_response jsonb,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  approval_row public.approval_requests%rowtype;
  execution_row public.approved_action_executions%rowtype;
  original_payment public.payments%rowtype;
  refund_payment public.payments%rowtype;
  exact_payload jsonb;
  stored_payload_hash text;
  amount_text text;
  refund_amount numeric(12, 2);
  reserved_refunds numeric(12, 2);
  generated_provider_key text;
  generated_request_hash text;
  generated_execution_token uuid;
  reconciliation_receipt jsonb;
  reconciliation_response jsonb;
begin
  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = p_actor_user_id
      and membership.role = 'owner'
      and membership.active
  ) then
    raise exception using message = 'APPROVED_ACTION_OWNER_REQUIRED';
  end if;

  if p_request_key is null
    or length(p_request_key) not between 8 and 256
    or p_request_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  then
    raise exception using message = 'APPROVED_ACTION_INVALID_IDEMPOTENCY_KEY';
  end if;
  if p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception using message = 'APPROVED_ACTION_PAYLOAD_MISMATCH';
  end if;

  select *
  into approval_row
  from public.approval_requests approval
  where approval.id = p_approval_request_id
    and approval.company_id = p_company_id
  for update;
  if not found then
    raise exception using message = 'APPROVED_ACTION_NOT_FOUND';
  end if;

  select *
  into execution_row
  from public.approved_action_executions execution
  where execution.approval_request_id = approval_row.id
  for update;

  if found then
    if execution_row.request_key <> p_request_key then
      raise exception using message = 'APPROVED_ACTION_IDEMPOTENCY_CONFLICT';
    end if;
    if execution_row.payload_hash <> p_payload_hash then
      raise exception using message = 'APPROVED_ACTION_PAYLOAD_MISMATCH';
    end if;
    if execution_row.status = 'succeeded' then
      return query
      select
        'completed'::text,
        execution_row.id,
        null::uuid,
        null::text,
        execution_row.response,
        execution_row.attempt_count;
      return;
    end if;
    if execution_row.status = 'failed_terminal' then
      return query
      select
        'failed'::text,
        execution_row.id,
        null::uuid,
        null::text,
        execution_row.response,
        execution_row.attempt_count;
      return;
    end if;
  end if;

  if approval_row.status = 'pending' then
    raise exception using message = 'APPROVED_ACTION_PENDING';
  elsif approval_row.status = 'rejected' then
    raise exception using message = 'APPROVED_ACTION_REJECTED';
  elsif approval_row.status in ('expired', 'cancelled') then
    raise exception using message = 'APPROVED_ACTION_EXPIRED';
  elsif approval_row.status <> 'approved' then
    raise exception using message = 'APPROVED_ACTION_NOT_APPROVED';
  end if;
  if approval_row.expires_at is not null and approval_row.expires_at <= now() then
    raise exception using message = 'APPROVED_ACTION_EXPIRED';
  end if;
  if approval_row.consumed_at is not null then
    raise exception using message = 'APPROVED_ACTION_CONSUMED';
  end if;

  if jsonb_typeof(approval_row.action_payload) <> 'object'
    or jsonb_typeof(approval_row.action_payload -> 'exactPayload') <> 'object'
  then
    raise exception using message = 'APPROVED_ACTION_PAYLOAD_MISMATCH';
  end if;
  exact_payload := approval_row.action_payload -> 'exactPayload';
  stored_payload_hash := approval_row.action_payload ->> 'payloadHash';
  if stored_payload_hash is null
    or stored_payload_hash !~ '^[a-f0-9]{64}$'
    or stored_payload_hash <> p_payload_hash
    or approval_row.action_type <> approval_row.action_payload ->> 'toolName'
    or nullif(approval_row.action_payload ->> 'runId', '') is null
    or nullif(approval_row.action_payload ->> 'actionId', '') is null
  then
    raise exception using message = 'APPROVED_ACTION_PAYLOAD_MISMATCH';
  end if;

  -- Exact allowlist plus database validator. Unregistered legal, safety,
  -- messaging, vendor, bank, destructive, pricing, calendar, and storage
  -- actions fail closed here even if an approval row names them.
  if approval_row.action_type <> 'payments.refund'
    or approval_row.reason <> 'refund'
    or approval_row.risk_level not in ('high', 'critical')
  then
    raise exception using message = 'APPROVED_ACTION_UNSUPPORTED_TOOL';
  end if;

  if (exact_payload - array['paymentProviderId', 'amount', 'reason']) <> '{}'::jsonb
    or jsonb_typeof(exact_payload -> 'amount') <> 'object'
    or ((exact_payload -> 'amount') - array['amount', 'currency']) <> '{}'::jsonb
    or exact_payload #>> '{amount,currency}' <> 'USD'
    or nullif(exact_payload ->> 'paymentProviderId', '') is null
    or length(exact_payload ->> 'paymentProviderId') > 255
    or nullif(btrim(exact_payload ->> 'reason'), '') is null
    or length(exact_payload ->> 'reason') > 1000
  then
    raise exception using message = 'APPROVED_ACTION_PAYLOAD_MISMATCH';
  end if;

  amount_text := exact_payload #>> '{amount,amount}';
  if amount_text is null or amount_text !~ '^(0|[1-9][0-9]*)\.[0-9]{2}$' then
    raise exception using message = 'APPROVED_ACTION_PAYLOAD_MISMATCH';
  end if;
  begin
    refund_amount := amount_text::numeric(12, 2);
  exception
    when numeric_value_out_of_range then
      raise exception using message = 'APPROVED_ACTION_PAYLOAD_MISMATCH';
  end;
  if refund_amount <= 0 then
    raise exception using message = 'APPROVED_ACTION_PAYLOAD_MISMATCH';
  end if;

  if execution_row.id is not null then
    select *
    into refund_payment
    from public.payments payment
    where payment.approval_request_id = approval_row.id
      and payment.payment_type = 'refund'
    for update;
    if not found
      or refund_payment.amount <> refund_amount
      or refund_payment.idempotency_key <> execution_row.provider_idempotency_key
    then
      raise exception using message = 'APPROVED_ACTION_AUTHORITATIVE_STATE_MISMATCH';
    end if;

    -- A verified provider webhook may win the race with an Edge response.
    -- Reconcile that durable success instead of issuing another provider call.
    if refund_payment.status = 'succeeded'
      and refund_payment.provider_payment_id is not null
    then
      reconciliation_receipt := jsonb_build_object(
        'actionId', approval_row.action_payload ->> 'actionId',
        'runId', approval_row.action_payload ->> 'runId',
        'toolName', approval_row.action_type,
        'payloadHash', stored_payload_hash,
        'provider', 'stripe',
        'providerReference', refund_payment.provider_payment_id,
        'providerMode', 'reconciled_webhook',
        'providerStatus', 'refunded',
        'amount', jsonb_build_object('amount', amount_text, 'currency', 'USD'),
        'providerIdempotencyKeySha256', encode(
          extensions.digest(
            execution_row.provider_idempotency_key::bytea,
            'sha256'
          ),
          'hex'
        ),
        'executedBy', p_actor_user_id,
        'executedAt', coalesce(refund_payment.processed_at, now())
      );
      reconciliation_response := jsonb_build_object(
        'approvalId', approval_row.id,
        'actionId', approval_row.action_payload ->> 'actionId',
        'toolName', approval_row.action_type,
        'status', 'succeeded',
        'receipt', reconciliation_receipt,
        'completedAt', now()
      );
      update public.approval_requests
      set consumed_at = now(), execution_receipt = reconciliation_receipt
      where id = approval_row.id and consumed_at is null;
      update public.approved_action_executions
      set
        status = 'succeeded',
        execution_token = null,
        lease_expires_at = null,
        response = reconciliation_response,
        error_code = null,
        completed_at = now(),
        updated_at = now()
      where id = execution_row.id;
      return query
      select
        'completed'::text,
        execution_row.id,
        null::uuid,
        null::text,
        reconciliation_response,
        execution_row.attempt_count;
      return;
    end if;

    if execution_row.status = 'in_progress'
      and execution_row.lease_expires_at > now()
    then
      return query
      select
        'in_progress'::text,
        execution_row.id,
        null::uuid,
        null::text,
        null::jsonb,
        execution_row.attempt_count;
      return;
    end if;
    if execution_row.attempt_count >= 20 then
      raise exception using message = 'APPROVED_ACTION_ATTEMPT_LIMIT';
    end if;

    generated_execution_token := gen_random_uuid();
    update public.approved_action_executions execution
    set
      status = 'in_progress',
      attempt_count = execution.attempt_count + 1,
      execution_token = generated_execution_token,
      lease_expires_at = now() + interval '2 minutes',
      error_code = null,
      updated_at = now()
    where id = execution_row.id
    returning * into execution_row;

    return query
    select
      'reserved'::text,
      execution_row.id,
      generated_execution_token,
      execution_row.provider_idempotency_key,
      null::jsonb,
      execution_row.attempt_count;
    return;
  end if;

  perform 1
  from public.approved_action_executions execution
  where execution.company_id = p_company_id
    and execution.request_key = p_request_key
  for update;
  if found then
    raise exception using message = 'APPROVED_ACTION_IDEMPOTENCY_CONFLICT';
  end if;

  -- The provider payment ID is unique within the company. Lock the original
  -- payment so two approvals cannot reserve the same refundable balance.
  select *
  into original_payment
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.provider = 'stripe'
    and payment.provider_payment_id = exact_payload ->> 'paymentProviderId'
    and payment.payment_type <> 'refund'
  for update;
  if not found
    or original_payment.status not in ('succeeded', 'partially_refunded')
  then
    raise exception using message = 'APPROVED_ACTION_REFUND_NOT_ALLOWED';
  end if;
  if (
    select count(*)
    from public.payments payment
    where payment.company_id = p_company_id
      and payment.provider = 'stripe'
      and payment.invoice_id = original_payment.invoice_id
      and payment.payment_type <> 'refund'
  ) <> 1 then
    raise exception using message = 'APPROVED_ACTION_AUTHORITATIVE_STATE_AMBIGUOUS';
  end if;

  select coalesce(sum(payment.amount), 0)::numeric(12, 2)
  into reserved_refunds
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.provider = 'stripe'
    and payment.invoice_id = original_payment.invoice_id
    and payment.payment_type = 'refund'
    and payment.status <> 'failed';
  if refund_amount > original_payment.amount - reserved_refunds then
    raise exception using message = 'APPROVED_ACTION_REFUND_NOT_ALLOWED';
  end if;

  generated_request_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'companyId', p_company_id,
        'approvalId', p_approval_request_id
      )::text::bytea,
      'sha256'
    ),
    'hex'
  );
  generated_provider_key := 'storyops-approved-' || encode(
    extensions.digest(
      concat_ws(
        ':',
        'storyops-ai-approved-action-v1',
        p_company_id,
        p_approval_request_id,
        stored_payload_hash
      )::bytea,
      'sha256'
    ),
    'hex'
  );
  generated_execution_token := gen_random_uuid();

  insert into public.approved_action_executions (
    company_id,
    approval_request_id,
    request_key,
    request_hash,
    payload_hash,
    provider_idempotency_key,
    tool_name,
    risk_level,
    status,
    attempt_count,
    execution_token,
    lease_expires_at
  )
  values (
    p_company_id,
    approval_row.id,
    p_request_key,
    generated_request_hash,
    stored_payload_hash,
    generated_provider_key,
    approval_row.action_type,
    approval_row.risk_level,
    'in_progress',
    1,
    generated_execution_token,
    now() + interval '2 minutes'
  )
  returning * into execution_row;

  insert into public.payments (
    company_id,
    invoice_id,
    customer_id,
    provider,
    provider_payment_id,
    payment_type,
    status,
    amount,
    processed_at,
    failure_code,
    idempotency_key,
    approval_request_id
  )
  values (
    p_company_id,
    original_payment.invoice_id,
    original_payment.customer_id,
    'stripe',
    null,
    'refund',
    'pending',
    refund_amount,
    null,
    null,
    generated_provider_key,
    approval_row.id
  );

  return query
  select
    'reserved'::text,
    execution_row.id,
    generated_execution_token,
    generated_provider_key,
    null::jsonb,
    execution_row.attempt_count;
end;
$$;

create or replace function public.complete_ai_approved_action(
  p_company_id uuid,
  p_approval_request_id uuid,
  p_actor_user_id uuid,
  p_execution_token uuid,
  p_provider text,
  p_provider_reference text,
  p_provider_mode text,
  p_provider_status text,
  p_amount text,
  p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  approval_row public.approval_requests%rowtype;
  execution_row public.approved_action_executions%rowtype;
  refund_payment public.payments%rowtype;
  receipt jsonb;
  result_response jsonb;
  completed_time timestamptz := now();
begin
  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = p_actor_user_id
      and membership.role = 'owner'
      and membership.active
  ) then
    raise exception using message = 'APPROVED_ACTION_OWNER_REQUIRED';
  end if;

  select *
  into approval_row
  from public.approval_requests approval
  where approval.id = p_approval_request_id
    and approval.company_id = p_company_id
  for update;
  if not found
    or approval_row.status <> 'approved'
    or approval_row.consumed_at is not null
    or (approval_row.expires_at is not null and approval_row.expires_at <= now())
  then
    raise exception using message = 'APPROVED_ACTION_COMPLETION_CONFLICT';
  end if;

  select *
  into execution_row
  from public.approved_action_executions execution
  where execution.approval_request_id = approval_row.id
    and execution.company_id = p_company_id
  for update;
  if not found
    or execution_row.status <> 'in_progress'
    or execution_row.execution_token <> p_execution_token
    or execution_row.tool_name <> 'payments.refund'
    or execution_row.payload_hash <> approval_row.action_payload ->> 'payloadHash'
  then
    raise exception using message = 'APPROVED_ACTION_COMPLETION_CONFLICT';
  end if;

  select *
  into refund_payment
  from public.payments payment
  where payment.approval_request_id = approval_row.id
    and payment.company_id = p_company_id
    and payment.payment_type = 'refund'
  for update;
  if not found
    or refund_payment.idempotency_key <> execution_row.provider_idempotency_key
    or refund_payment.amount::text <> p_amount::numeric(12, 2)::text
    or p_currency <> 'USD'
    or p_provider <> 'stripe'
    or p_provider_mode not in ('sandbox', 'live')
    or p_provider_status not in ('open', 'refunded')
    or p_provider_reference is null
    or length(p_provider_reference) not between 3 and 255
  then
    raise exception using message = 'APPROVED_ACTION_PROVIDER_RECEIPT_MISMATCH';
  end if;

  receipt := jsonb_build_object(
    'actionId', approval_row.action_payload ->> 'actionId',
    'runId', approval_row.action_payload ->> 'runId',
    'toolName', execution_row.tool_name,
    'payloadHash', execution_row.payload_hash,
    'provider', p_provider,
    'providerReference', p_provider_reference,
    'providerMode', p_provider_mode,
    'providerStatus', p_provider_status,
    'amount', jsonb_build_object('amount', p_amount, 'currency', p_currency),
    'providerIdempotencyKeySha256', encode(
      extensions.digest(execution_row.provider_idempotency_key::bytea, 'sha256'),
      'hex'
    ),
    'executedBy', p_actor_user_id,
    'executedAt', completed_time
  );
  result_response := jsonb_build_object(
    'approvalId', approval_row.id,
    'actionId', approval_row.action_payload ->> 'actionId',
    'toolName', execution_row.tool_name,
    'status', 'succeeded',
    'receipt', receipt,
    'completedAt', completed_time
  );

  update public.payments
  set
    provider_payment_id = p_provider_reference,
    status = case when p_provider_status = 'refunded' then 'succeeded' else 'pending' end,
    processed_at = case when p_provider_status = 'refunded' then completed_time else null end,
    failure_code = null
  where id = refund_payment.id;

  update public.approval_requests
  set consumed_at = completed_time, execution_receipt = receipt
  where id = approval_row.id and consumed_at is null;
  if not found then
    raise exception using message = 'APPROVED_ACTION_COMPLETION_CONFLICT';
  end if;

  update public.approved_action_executions
  set
    status = 'succeeded',
    execution_token = null,
    lease_expires_at = null,
    response = result_response,
    error_code = null,
    completed_at = completed_time,
    updated_at = completed_time
  where id = execution_row.id
    and execution_token = p_execution_token
    and status = 'in_progress';
  if not found then
    raise exception using message = 'APPROVED_ACTION_COMPLETION_CONFLICT';
  end if;

  insert into public.audit_events (
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data,
    retain_until
  )
  values (
    p_company_id,
    'user',
    p_actor_user_id::text,
    'ai.approved_action.executed',
    'approval_request',
    approval_row.id,
    receipt,
    now() + interval '7 years'
  );

  return result_response;
end;
$$;

create or replace function public.fail_ai_approved_action(
  p_company_id uuid,
  p_approval_request_id uuid,
  p_execution_token uuid,
  p_error_code text,
  p_retryable boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  execution_row public.approved_action_executions%rowtype;
  safe_error_code text;
  failure_response jsonb;
begin
  safe_error_code := left(
    coalesce(nullif(regexp_replace(upper(p_error_code), '[^A-Z0-9_-]', '_', 'g'), ''), 'UNKNOWN'),
    100
  );

  select *
  into execution_row
  from public.approved_action_executions execution
  where execution.company_id = p_company_id
    and execution.approval_request_id = p_approval_request_id
  for update;
  if not found
    or execution_row.status <> 'in_progress'
    or execution_row.execution_token <> p_execution_token
  then
    raise exception using message = 'APPROVED_ACTION_FAILURE_CONFLICT';
  end if;

  if p_retryable then
    update public.approved_action_executions
    set
      status = 'retryable',
      execution_token = null,
      lease_expires_at = null,
      error_code = safe_error_code,
      updated_at = now()
    where id = execution_row.id;
  else
    failure_response := jsonb_build_object(
      'approvalId', p_approval_request_id,
      'toolName', execution_row.tool_name,
      'status', 'failed',
      'code', safe_error_code,
      'completedAt', now()
    );
    update public.payments
    set status = 'failed', failure_code = safe_error_code, processed_at = now()
    where company_id = p_company_id
      and approval_request_id = p_approval_request_id
      and payment_type = 'refund'
      and status = 'pending';
    update public.approved_action_executions
    set
      status = 'failed_terminal',
      execution_token = null,
      lease_expires_at = null,
      response = failure_response,
      error_code = safe_error_code,
      completed_at = now(),
      updated_at = now()
    where id = execution_row.id;
  end if;
end;
$$;

revoke all on function public.claim_ai_approved_action(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.complete_ai_approved_action(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.fail_ai_approved_action(
  uuid, uuid, uuid, text, boolean
) from public, anon, authenticated;

grant execute on function public.claim_ai_approved_action(
  uuid, uuid, uuid, text, text
) to service_role;
grant execute on function public.complete_ai_approved_action(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text
) to service_role;
grant execute on function public.fail_ai_approved_action(
  uuid, uuid, uuid, text, boolean
) to service_role;

comment on table public.approved_action_executions is
  'Durable owner-approved AI action leases. Provider idempotency keys are server-derived and never accepted from callers.';
comment on function public.claim_ai_approved_action(
  uuid, uuid, uuid, text, text
) is
  'Atomically verifies owner role, approval state, exact payload hash, tool allowlist, and authoritative refund state before reserving a stable provider key.';
comment on function public.complete_ai_approved_action(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text
) is
  'Atomically consumes an exact approval, stores a redacted provider receipt, and completes durable action idempotency.';
