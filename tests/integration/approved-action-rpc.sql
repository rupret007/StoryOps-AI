\set ON_ERROR_STOP on

begin;

insert into auth.users (id)
values
  ('90000000-0000-4000-8000-000000000101'),
  ('90000000-0000-4000-8000-000000000102');

insert into public.companies (id, name, status)
values (
  '90000000-0000-4000-8000-000000000001',
  'Approved action RPC test',
  'active'
);

insert into public.company_memberships (company_id, user_id, role)
values
  (
    '90000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000101',
    'owner'
  ),
  (
    '90000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000102',
    'dispatcher'
  );

insert into public.customers (id, company_id, display_name)
values (
  '90000000-0000-4000-8000-000000000201',
  '90000000-0000-4000-8000-000000000001',
  'Approved action customer'
);

insert into public.invoices (
  id,
  company_id,
  invoice_number,
  customer_id,
  status,
  issue_date,
  due_date,
  subtotal,
  tax,
  total,
  amount_paid,
  balance_due
)
values (
  '90000000-0000-4000-8000-000000000301',
  '90000000-0000-4000-8000-000000000001',
  'RPC-REFUND-1',
  '90000000-0000-4000-8000-000000000201',
  'paid',
  current_date - 2,
  current_date - 1,
  100.00,
  0.00,
  100.00,
  100.00,
  0.00
);

insert into public.payments (
  id,
  company_id,
  invoice_id,
  customer_id,
  provider,
  provider_payment_id,
  payment_type,
  status,
  amount,
  processed_at,
  idempotency_key,
  provider_amount_received,
  allocation_status
)
values (
  '90000000-0000-4000-8000-000000000401',
  '90000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000301',
  '90000000-0000-4000-8000-000000000201',
  'stripe',
  'pi_rpc_original_1',
  'invoice',
  'succeeded',
  100.00,
  now() - interval '1 day',
  'rpc-original-payment-1',
  100.00,
  'applied'
);

insert into public.approval_requests (
  id,
  company_id,
  reason,
  risk_level,
  status,
  requested_by_type,
  requested_by_id,
  requested_at,
  expires_at,
  entity_type,
  entity_id,
  action_type,
  action_payload,
  summary,
  policy_version,
  decided_by,
  decided_at
)
values (
  '90000000-0000-4000-8000-000000000501',
  '90000000-0000-4000-8000-000000000001',
  'refund',
  'high',
  'approved',
  'agent',
  'finance',
  now() - interval '5 minutes',
  now() + interval '1 day',
  'payment',
  '90000000-0000-4000-8000-000000000401',
  'payments.refund',
  '{
    "exactPayload": {
      "paymentProviderId": "pi_rpc_original_1",
      "amount": {"amount": "25.00", "currency": "USD"},
      "reason": "RPC exact-payload test"
    },
    "payloadHash": "a1996ba0d030273265778e44684c6f62a05fab305dbcb384dd0a4b52a336a316",
    "runId": "rpc-run-1",
    "actionId": "rpc-refund-1",
    "toolName": "payments.refund"
  }',
  'Exact $25.00 refund',
  'storyops-policy-v1.0.0',
  '90000000-0000-4000-8000-000000000101',
  now() - interval '1 minute'
);

insert into public.approval_requests (
  id,
  company_id,
  reason,
  risk_level,
  status,
  requested_by_type,
  requested_by_id,
  requested_at,
  expires_at,
  entity_type,
  entity_id,
  action_type,
  action_payload,
  summary,
  policy_version,
  decided_by,
  decided_at
)
values (
  '90000000-0000-4000-8000-000000000502',
  '90000000-0000-4000-8000-000000000001',
  'other',
  'low',
  'approved',
  'system',
  'approval-capability-regression',
  now() - interval '5 minutes',
  now() + interval '1 day',
  'company',
  '90000000-0000-4000-8000-000000000001',
  'test.consume_approval',
  jsonb_build_object(
    'exactPayload',
    jsonb_build_object(
      'companyId', '90000000-0000-4000-8000-000000000001'::uuid
    ),
    'payloadHash', repeat('a', 64)
  ),
  'Approval consumption capability regression',
  'storyops-policy-v1.0.0',
  '90000000-0000-4000-8000-000000000101',
  now() - interval '1 minute'
);

do $$
declare
  direct_update_blocked boolean := false;
  forged_setting_blocked boolean := false;
begin
  perform set_config('storyops.approval_consumption_token', '', true);
  begin
    update public.approval_requests
    set
      consumed_at = now(),
      execution_receipt = '{"source":"direct-update"}'::jsonb
    where id = '90000000-0000-4000-8000-000000000502';
  exception
    when others then
      if position('Approval consumption is server-controlled' in sqlerrm) > 0 then
        direct_update_blocked := true;
      else
        raise;
      end if;
  end;

  perform set_config(
    'storyops.approval_consumption_token',
    '90000000-0000-4000-8000-000000000503',
    true
  );
  begin
    update public.approval_requests
    set
      consumed_at = now(),
      execution_receipt = '{"source":"forged-setting"}'::jsonb
    where id = '90000000-0000-4000-8000-000000000502';
  exception
    when others then
      if position('Approval consumption is server-controlled' in sqlerrm) > 0 then
        forged_setting_blocked := true;
      else
        raise;
      end if;
  end;
  perform set_config('storyops.approval_consumption_token', '', true);

  if not direct_update_blocked or not forged_setting_blocked then
    raise exception 'A direct approval-consumption update bypassed the capability';
  end if;
  if not exists (
    select 1
    from public.approval_requests
    where id = '90000000-0000-4000-8000-000000000502'
      and consumed_at is null
      and execution_receipt is null
  ) then
    raise exception 'A rejected approval-consumption forgery changed the row';
  end if;
  if has_table_privilege(
      'authenticated', 'public.approval_requests', 'update'
    )
    or has_table_privilege(
      'service_role', 'public.approval_requests', 'update'
    )
    or has_schema_privilege('authenticated', 'private', 'usage')
    or has_schema_privilege('service_role', 'private', 'usage')
    or has_function_privilege(
      'authenticated',
      'private.authorize_storyops_approval_consumption(uuid,uuid)',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'private.authorize_storyops_approval_consumption(uuid,uuid)',
      'execute'
    )
  then
    raise exception 'An API role can forge an approval-consumption capability';
  end if;
end;
$$;

do $$
declare
  first_claim record;
  duplicate_claim record;
  retry_claim record;
  replay_claim record;
  first_provider_key text;
  completion jsonb;
  receipt jsonb;
begin
  update public.companies
  set status = 'paused'
  where id = '90000000-0000-4000-8000-000000000001';
  begin
    perform *
    from public.claim_ai_approved_action(
      '90000000-0000-4000-8000-000000000001',
      '90000000-0000-4000-8000-000000000501',
      '90000000-0000-4000-8000-000000000101',
      'rpc-refund-attempt-1',
      'a1996ba0d030273265778e44684c6f62a05fab305dbcb384dd0a4b52a336a316'
    );
    raise exception 'Paused-company claim unexpectedly succeeded';
  exception
    when others then
      if sqlerrm not like '%APPROVED_ACTION_OWNER_REQUIRED%' then
        raise;
      end if;
  end;
  if exists (
    select 1 from public.approved_action_executions
    where approval_request_id = '90000000-0000-4000-8000-000000000501'
  ) then
    raise exception 'Paused company created a provider execution lease';
  end if;
  update public.companies
  set status = 'active'
  where id = '90000000-0000-4000-8000-000000000001';

  begin
    perform *
    from public.claim_ai_approved_action(
      '90000000-0000-4000-8000-000000000001',
      '90000000-0000-4000-8000-000000000501',
      '90000000-0000-4000-8000-000000000102',
      'rpc-refund-attempt-1',
      'a1996ba0d030273265778e44684c6f62a05fab305dbcb384dd0a4b52a336a316'
    );
    raise exception 'Dispatcher claim unexpectedly succeeded';
  exception
    when others then
      if sqlerrm not like '%APPROVED_ACTION_OWNER_REQUIRED%' then
        raise;
      end if;
  end;

  select *
  into first_claim
  from public.claim_ai_approved_action(
    '90000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000501',
    '90000000-0000-4000-8000-000000000101',
    'rpc-refund-attempt-1',
    'a1996ba0d030273265778e44684c6f62a05fab305dbcb384dd0a4b52a336a316'
  );
  if first_claim.claim_status <> 'reserved'
    or first_claim.execution_token is null
    or first_claim.provider_idempotency_key not like 'storyops-approved-%'
  then
    raise exception 'First claim contract failed: %', row_to_json(first_claim);
  end if;
  first_provider_key := first_claim.provider_idempotency_key;

  select *
  into duplicate_claim
  from public.claim_ai_approved_action(
    '90000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000501',
    '90000000-0000-4000-8000-000000000101',
    'rpc-refund-attempt-1',
    'a1996ba0d030273265778e44684c6f62a05fab305dbcb384dd0a4b52a336a316'
  );
  if duplicate_claim.claim_status <> 'in_progress' then
    raise exception 'Duplicate active claim was not blocked';
  end if;

  perform public.fail_ai_approved_action(
    '90000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000501',
    first_claim.execution_token,
    'NETWORK_ERROR',
    true
  );

  select *
  into retry_claim
  from public.claim_ai_approved_action(
    '90000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000501',
    '90000000-0000-4000-8000-000000000101',
    'rpc-refund-attempt-1',
    'a1996ba0d030273265778e44684c6f62a05fab305dbcb384dd0a4b52a336a316'
  );
  if retry_claim.claim_status <> 'reserved'
    or retry_claim.attempt_count <> 2
    or retry_claim.provider_idempotency_key <> first_provider_key
  then
    raise exception 'Retry did not preserve the provider key';
  end if;

  completion := public.complete_ai_approved_action(
    '90000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000501',
    '90000000-0000-4000-8000-000000000101',
    retry_claim.execution_token,
    'stripe',
    're_sandbox_rpc_1',
    'sandbox',
    'refunded',
    '25.00',
    'USD'
  );
  if completion ->> 'status' <> 'succeeded' then
    raise exception 'Atomic completion did not succeed';
  end if;

  select *
  into replay_claim
  from public.claim_ai_approved_action(
    '90000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000501',
    '90000000-0000-4000-8000-000000000101',
    'rpc-refund-attempt-1',
    'a1996ba0d030273265778e44684c6f62a05fab305dbcb384dd0a4b52a336a316'
  );
  if replay_claim.claim_status <> 'completed'
    or replay_claim.stored_response ->> 'status' <> 'succeeded'
  then
    raise exception 'Completed result did not replay';
  end if;

  select execution_receipt
  into receipt
  from public.approval_requests
  where id = '90000000-0000-4000-8000-000000000501';
  if receipt is null
    or receipt::text like '%RPC exact-payload test%'
    or receipt::text like '%pi_rpc_original_1%'
    or receipt::text like '%' || first_provider_key || '%'
    or receipt ->> 'providerIdempotencyKeySha256' is null
  then
    raise exception 'Execution receipt was not correctly redacted';
  end if;

  begin
    perform *
    from public.claim_ai_approved_action(
      '90000000-0000-4000-8000-000000000001',
      '90000000-0000-4000-8000-000000000501',
      '90000000-0000-4000-8000-000000000101',
      'another-client-request-key',
      'a1996ba0d030273265778e44684c6f62a05fab305dbcb384dd0a4b52a336a316'
    );
    raise exception 'Consumed approval unexpectedly accepted a new key';
  exception
    when others then
      if sqlerrm not like '%APPROVED_ACTION_IDEMPOTENCY_CONFLICT%' then
        raise;
      end if;
  end;
end;
$$;

do $$
begin
  if has_table_privilege(
    'authenticated',
    'public.approved_action_executions',
    'select'
  ) then
    raise exception 'Authenticated role can read execution leases';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.claim_ai_approved_action(uuid,uuid,uuid,text,text)',
    'execute'
  ) then
    raise exception 'Authenticated role can call the service-only claim RPC';
  end if;
  if not exists (
    select 1
    from public.approval_requests
    where id = '90000000-0000-4000-8000-000000000501'
      and consumed_at is not null
      and execution_receipt ->> 'providerReference' = 're_sandbox_rpc_1'
  ) then
    raise exception 'Approval was not atomically consumed';
  end if;
  if not exists (
    select 1
    from public.approved_action_executions
    where approval_request_id = '90000000-0000-4000-8000-000000000501'
      and status = 'succeeded'
      and attempt_count = 2
  ) then
    raise exception 'Durable idempotency did not complete';
  end if;
  if not exists (
    select 1
    from public.payments
    where approval_request_id = '90000000-0000-4000-8000-000000000501'
      and payment_type = 'refund'
      and status = 'succeeded'
      and provider_payment_id = 're_sandbox_rpc_1'
      and amount = 25.00
  ) then
    raise exception 'Refund reservation was not reconciled';
  end if;
end;
$$;

rollback;
