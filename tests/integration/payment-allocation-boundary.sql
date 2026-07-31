\set ON_ERROR_STOP on

begin;

create temporary table payment_boundary_state (
  key text primary key,
  value jsonb not null
);
grant select, insert, update, delete on payment_boundary_state to service_role;
grant select on payment_boundary_state to authenticated;

\echo '1/10 checkout and payment identities are separate, constrained, and RPC-only'
do $$
declare
  missing_columns text[];
  fake_success_blocked boolean := false;
begin
  select array_agg(required.name order by required.name)
  into missing_columns
  from (
    values
      ('provider_checkout_id'),
      ('provider_amount_received'),
      ('allocation_status')
  ) required(name)
  where not exists (
    select 1
    from information_schema.columns column_definition
    where column_definition.table_schema = 'public'
      and column_definition.table_name = 'payments'
      and column_definition.column_name = required.name
  );
  if cardinality(missing_columns) > 0 then
    raise exception 'Payment truth columns are missing: %', missing_columns;
  end if;
  if has_table_privilege(
    'service_role',
    'public.payment_allocation_conflicts',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) then
    raise exception 'service_role received a base-table payment conflict privilege';
  end if;
  begin
    update public.payments
    set allocation_status = null
    where id = '10000000-0000-4000-8000-000000000655';
  exception when check_violation then
    fake_success_blocked := true;
  end;
  if not fake_success_blocked then
    raise exception 'A succeeded Stripe payment lost its signed allocation truth';
  end if;
end;
$$;

\echo '2/10 SET ROLE service_role without a JWT service claim fails closed'
set local role service_role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.reconcile_provider_webhook(
      '33000000-0000-4000-8000-000000000001',
      repeat('0', 64),
      '10000000-0000-4000-8000-000000000001',
      'stripe',
      '{}'::jsonb
    );
  exception when others then
    blocked := position('EDGE_SERVICE_ROLE_REQUIRED' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Stripe reconciliation accepted a missing JWT service claim';
  end if;
end;
$$;

\echo '3/10 exact invoice checkout stores cs_* without claiming payment'
reset role;
update public.invoices
set status = 'open',
    issue_date = current_date,
    due_date = current_date,
    amount_paid = 132.00,
    balance_due = 396.00
where id = '10000000-0000-4000-8000-000000000651'
returning version;
insert into payment_boundary_state(key, value)
select 'exact_invoice_version', to_jsonb(invoice.version)
from public.invoices invoice
where invoice.id = '10000000-0000-4000-8000-000000000651';

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  claim jsonb;
  response jsonb;
  receipt jsonb;
  request_hash text;
  payload_hash text;
  event_id_value uuid;
  event_claimed boolean;
  event_status text;
  lease_id uuid;
  first_result jsonb;
  replay_result jsonb;
  invoice_version_value integer;
begin
  select (value #>> '{}')::integer
  into invoice_version_value
  from pg_temp.payment_boundary_state
  where key = 'exact_invoice_version';

  claim := public.prepare_storyops_invoice_checkout(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    '33000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000651',
    invoice_version_value
  );
  if claim ->> 'claimStatus' <> 'reserved'
    or claim ->> 'amount' <> '396.00'
    or claim ->> 'providerIdempotencyKey'
      <> 'storyops:invoice-balance:10000000-0000-4000-8000-000000000651'
        || ':v' || invoice_version_value::text || ':39600:attempt:1'
    or claim ->> 'checkoutAttempt' <> '1'
  then
    raise exception 'Exact invoice checkout reservation was invalid: %', claim;
  end if;

  request_hash := claim ->> 'requestHash';
  response := jsonb_build_object(
    'action', 'invoice.checkout',
    'status', 'checkout_open',
    'mode', 'sandbox',
    'quoteId', claim ->> 'quoteId',
    'jobId', claim ->> 'jobId',
    'invoiceId', claim ->> 'invoiceId',
    'invoiceVersion', invoice_version_value,
    'amount', '396.00',
    'currency', 'USD',
    'paymentVerified', false,
    'invoicePaid', false,
    'replayed', false,
    'checkoutId', 'cs_payment_boundary_exact',
    'sandboxReceipt', 'Contract fixture only; no external funds moved.'
  );
  perform public.complete_storyops_invoice_checkout(
    '10000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000002',
    request_hash,
    (claim ->> 'paymentId')::uuid,
    'cs_payment_boundary_exact',
    response
  );

  receipt := jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'stripe',
    'eventId', 'evt_payment_boundary_exact',
    'eventType', 'checkout.session.completed',
    'objectId', 'cs_payment_boundary_exact',
    'objectKind', 'checkout',
    'action', 'payment_succeeded',
    'companyId', '10000000-0000-4000-8000-000000000001',
    'occurredAt', now(),
    'quoteId', '10000000-0000-4000-8000-000000000521',
    'checkoutPurpose', 'invoice_balance',
    'checkoutAttempt', 1,
    'invoiceId', '10000000-0000-4000-8000-000000000651',
    'invoiceVersion', invoice_version_value,
    'paymentIntentId', 'pi_payment_boundary_exact',
    'amountCents', 39600,
    'currency', 'usd'
  );
  payload_hash := encode(
    extensions.digest(convert_to(receipt::text, 'UTF8'), 'sha256'),
    'hex'
  );
  select event_id, claimed, existing_status
  into event_id_value, event_claimed, event_status
  from public.claim_webhook_event(
    'stripe',
    'evt_payment_boundary_exact',
    'checkout.session.completed',
    payload_hash,
    receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  if not event_claimed or event_status <> 'received' then
    raise exception 'Exact provider event claim was not new';
  end if;
  lease_id := public.start_storyops_intake_processing(event_id_value, payload_hash);
  if lease_id is null then
    raise exception 'Exact provider event did not obtain a processing lease';
  end if;

  first_result := public.reconcile_provider_webhook(
    event_id_value,
    payload_hash,
    '10000000-0000-4000-8000-000000000001',
    'stripe',
    receipt
  );
  replay_result := public.reconcile_provider_webhook(
    event_id_value,
    payload_hash,
    '10000000-0000-4000-8000-000000000001',
    'stripe',
    receipt
  );
  if first_result ->> 'allocationStatus' <> 'applied'
    or not (first_result ->> 'changed')::boolean
    or replay_result ->> 'allocationStatus' <> 'applied'
    or (replay_result ->> 'changed')::boolean
  then
    raise exception 'Exact reconciliation or in-lease replay was invalid: %, %',
      first_result, replay_result;
  end if;
  perform public.complete_storyops_intake_webhook(
    event_id_value, payload_hash, lease_id, 'processed'
  );

  insert into pg_temp.payment_boundary_state(key, value)
  values
    ('exact_payment_id', to_jsonb(claim ->> 'paymentId')),
    ('exact_event_id', to_jsonb(event_id_value::text)),
    ('exact_payload_hash', to_jsonb(payload_hash)),
    ('exact_receipt', receipt);
end;
$$;

reset role;
do $$
declare
  payment_id_value uuid;
  payment_row public.payments%rowtype;
  invoice_row public.invoices%rowtype;
begin
  select (value #>> '{}')::uuid
  into payment_id_value
  from payment_boundary_state
  where key = 'exact_payment_id';
  select * into payment_row
  from public.payments payment
  where payment.id = payment_id_value;
  select * into invoice_row
  from public.invoices invoice
  where invoice.id = '10000000-0000-4000-8000-000000000651';
  if payment_row.provider_checkout_id <> 'cs_payment_boundary_exact'
    or payment_row.provider_payment_id <> 'pi_payment_boundary_exact'
    or payment_row.provider_amount_received <> 396.00
    or payment_row.status <> 'succeeded'
    or payment_row.allocation_status <> 'applied'
    or invoice_row.status <> 'paid'
    or invoice_row.amount_paid <> 528.00
    or invoice_row.balance_due <> 0
    or (
      select count(*)
      from public.audit_events event
      where event.request_id = (
        select value #>> '{}'
        from payment_boundary_state
        where key = 'exact_event_id'
      )
        and event.action = 'provider_webhook_reconciled'
    ) <> 1
  then
    raise exception 'Exact signed payment was not applied once: %, %',
      to_jsonb(payment_row), to_jsonb(invoice_row);
  end if;
end;
$$;

\echo '4/10 a processed provider-event replay is exact and does not run allocation again'
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  receipt jsonb;
  payload_hash text;
  event_id_value uuid;
  event_claimed boolean;
  event_status text;
begin
  select value into receipt
  from pg_temp.payment_boundary_state
  where key = 'exact_receipt';
  select value #>> '{}' into payload_hash
  from pg_temp.payment_boundary_state
  where key = 'exact_payload_hash';
  select event_id, claimed, existing_status
  into event_id_value, event_claimed, event_status
  from public.claim_webhook_event(
    'stripe',
    'evt_payment_boundary_exact',
    'checkout.session.completed',
    payload_hash,
    receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  if event_claimed
    or event_status <> 'processed'
    or event_id_value <> (
      select (value #>> '{}')::uuid
      from pg_temp.payment_boundary_state
      where key = 'exact_event_id'
    )
  then
    raise exception 'Processed provider replay was not exact';
  end if;
end;
$$;

\echo '5/10 stale signed success is durable but quarantined and never pays the invoice'
reset role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
delete from public.payments
where id = (
  select (value #>> '{}')::uuid
  from payment_boundary_state
  where key = 'exact_payment_id'
);
delete from public.idempotency_keys
where company_id = '10000000-0000-4000-8000-000000000001'
  and scope = 'invoice-checkout-v1'
  and key = '33000000-0000-4000-8000-000000000002';
update public.invoices
set status = 'open',
    paid_at = null,
    amount_paid = 132.00,
    balance_due = 396.00
where id = '10000000-0000-4000-8000-000000000651';
insert into payment_boundary_state(key, value)
select 'stale_invoice_version', to_jsonb(invoice.version)
from public.invoices invoice
where invoice.id = '10000000-0000-4000-8000-000000000651';

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  claim jsonb;
  response jsonb;
  receipt jsonb;
  payload_hash text;
  event_id_value uuid;
  event_claimed boolean;
  event_status text;
  lease_id uuid;
  invoice_version_value integer;
begin
  select (value #>> '{}')::integer
  into invoice_version_value
  from pg_temp.payment_boundary_state
  where key = 'stale_invoice_version';
  claim := public.prepare_storyops_invoice_checkout(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    '33000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000651',
    invoice_version_value
  );
  response := jsonb_build_object(
    'action', 'invoice.checkout',
    'status', 'checkout_open',
    'mode', 'sandbox',
    'quoteId', claim ->> 'quoteId',
    'jobId', claim ->> 'jobId',
    'invoiceId', claim ->> 'invoiceId',
    'invoiceVersion', invoice_version_value,
    'amount', '396.00',
    'currency', 'USD',
    'paymentVerified', false,
    'invoicePaid', false,
    'replayed', false,
    'checkoutId', 'cs_payment_boundary_stale',
    'sandboxReceipt', 'Contract fixture only; no external funds moved.'
  );
  perform public.complete_storyops_invoice_checkout(
    '10000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000003',
    claim ->> 'requestHash',
    (claim ->> 'paymentId')::uuid,
    'cs_payment_boundary_stale',
    response
  );
  receipt := jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'stripe',
    'eventId', 'evt_payment_boundary_stale',
    'eventType', 'checkout.session.completed',
    'objectId', 'cs_payment_boundary_stale',
    'objectKind', 'checkout',
    'action', 'payment_succeeded',
    'companyId', '10000000-0000-4000-8000-000000000001',
    'occurredAt', now(),
    'quoteId', '10000000-0000-4000-8000-000000000521',
    'checkoutPurpose', 'invoice_balance',
    'checkoutAttempt', 1,
    'invoiceId', '10000000-0000-4000-8000-000000000651',
    'invoiceVersion', invoice_version_value,
    'paymentIntentId', 'pi_payment_boundary_stale',
    'amountCents', 39600,
    'currency', 'usd'
  );
  payload_hash := encode(
    extensions.digest(convert_to(receipt::text, 'UTF8'), 'sha256'),
    'hex'
  );
  select event_id, claimed, existing_status
  into event_id_value, event_claimed, event_status
  from public.claim_webhook_event(
    'stripe',
    'evt_payment_boundary_stale',
    'checkout.session.completed',
    payload_hash,
    receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  lease_id := public.start_storyops_intake_processing(event_id_value, payload_hash);
  if not event_claimed or event_status <> 'received' or lease_id is null then
    raise exception 'Stale provider event was not durably leased';
  end if;
  insert into pg_temp.payment_boundary_state(key, value)
  values
    ('stale_payment_id', to_jsonb(claim ->> 'paymentId')),
    ('stale_event_id', to_jsonb(event_id_value::text)),
    ('stale_payload_hash', to_jsonb(payload_hash)),
    ('stale_lease_id', to_jsonb(lease_id::text)),
    ('stale_receipt', receipt);
end;
$$;

reset role;
update public.invoices
set due_date = due_date + 1
where id = '10000000-0000-4000-8000-000000000651';

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  event_id_value uuid;
  payload_hash text;
  lease_id uuid;
  receipt jsonb;
  first_result jsonb;
  replay_result jsonb;
begin
  select (value #>> '{}')::uuid into event_id_value
  from pg_temp.payment_boundary_state where key = 'stale_event_id';
  select value #>> '{}' into payload_hash
  from pg_temp.payment_boundary_state where key = 'stale_payload_hash';
  select (value #>> '{}')::uuid into lease_id
  from pg_temp.payment_boundary_state where key = 'stale_lease_id';
  select value into receipt
  from pg_temp.payment_boundary_state where key = 'stale_receipt';

  first_result := public.reconcile_provider_webhook(
    event_id_value,
    payload_hash,
    '10000000-0000-4000-8000-000000000001',
    'stripe',
    receipt
  );
  replay_result := public.reconcile_provider_webhook(
    event_id_value,
    payload_hash,
    '10000000-0000-4000-8000-000000000001',
    'stripe',
    receipt
  );
  if first_result ->> 'allocationStatus' <> 'unapplied'
    or first_result ->> 'entityType' <> 'payment_allocation_conflict'
    or not (first_result ->> 'changed')::boolean
    or replay_result ->> 'entityId' <> first_result ->> 'entityId'
    or (replay_result ->> 'changed')::boolean
  then
    raise exception 'Stale allocation quarantine or replay was invalid: %, %',
      first_result, replay_result;
  end if;
  perform public.complete_storyops_intake_webhook(
    event_id_value, payload_hash, lease_id, 'processed'
  );
end;
$$;

reset role;
do $$
declare
  payment_id_value uuid;
  payment_row public.payments%rowtype;
  invoice_row public.invoices%rowtype;
  conflict_row public.payment_allocation_conflicts%rowtype;
  approval_row public.approval_requests%rowtype;
begin
  select (value #>> '{}')::uuid into payment_id_value
  from payment_boundary_state where key = 'stale_payment_id';
  select * into payment_row
  from public.payments payment where payment.id = payment_id_value;
  select * into invoice_row
  from public.invoices invoice
  where invoice.id = '10000000-0000-4000-8000-000000000651';
  select * into conflict_row
  from public.payment_allocation_conflicts conflict
  where conflict.payment_id = payment_id_value and conflict.status = 'open';
  select * into approval_row
  from public.approval_requests approval
  where approval.id = conflict_row.approval_request_id;
  if payment_row.provider_checkout_id <> 'cs_payment_boundary_stale'
    or payment_row.provider_payment_id <> 'pi_payment_boundary_stale'
    or payment_row.status <> 'succeeded'
    or payment_row.allocation_status <> 'unapplied'
    or payment_row.provider_amount_received <> 396.00
    or invoice_row.status <> 'open'
    or invoice_row.amount_paid <> 132.00
    or invoice_row.balance_due <> 396.00
    or conflict_row.conflict_code <> 'stale_invoice_version'
    or conflict_row.status <> 'open'
    or approval_row.status <> 'pending'
    or approval_row.risk_level <> 'high'
    or approval_row.action_type
      <> 'payment.allocation.apply_exact_current_balance'
  then
    raise exception 'Stale provider success was not durably quarantined: %, %, %, %',
      to_jsonb(payment_row), to_jsonb(invoice_row),
      to_jsonb(conflict_row), to_jsonb(approval_row);
  end if;
end;
$$;

\echo '6/10 a succeeded payment replay with a different amount is rejected'
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  original_receipt jsonb;
  conflicting_receipt jsonb;
  payload_hash text;
  event_id_value uuid;
  event_claimed boolean;
  event_status text;
  lease_id uuid;
  blocked boolean := false;
begin
  select value into original_receipt
  from pg_temp.payment_boundary_state where key = 'stale_receipt';
  conflicting_receipt := jsonb_set(
    jsonb_set(
      original_receipt,
      '{eventId}',
      to_jsonb('evt_payment_boundary_amount_conflict'::text)
    ),
    '{amountCents}',
    to_jsonb(39700)
  );
  payload_hash := encode(
    extensions.digest(convert_to(conflicting_receipt::text, 'UTF8'), 'sha256'),
    'hex'
  );
  select event_id, claimed, existing_status
  into event_id_value, event_claimed, event_status
  from public.claim_webhook_event(
    'stripe',
    'evt_payment_boundary_amount_conflict',
    'checkout.session.completed',
    payload_hash,
    conflicting_receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  lease_id := public.start_storyops_intake_processing(event_id_value, payload_hash);
  begin
    perform public.reconcile_provider_webhook(
      event_id_value,
      payload_hash,
      '10000000-0000-4000-8000-000000000001',
      'stripe',
      conflicting_receipt
    );
  exception when others then
    blocked := position('STRIPE_PAYMENT_REPLAY_CONFLICT' in sqlerrm) > 0;
  end;
  if not event_claimed
    or event_status <> 'received'
    or lease_id is null
    or not blocked
  then
    raise exception 'Amount-conflicting provider replay was not rejected';
  end if;
end;
$$;

\echo '7/10 an open allocation conflict blocks every new collection attempt'
do $$
declare
  blocked boolean := false;
  invoice_version_value integer;
begin
  select (value #>> '{}')::integer
  into invoice_version_value
  from pg_temp.payment_boundary_state
  where key = 'stale_invoice_version';
  begin
    perform public.prepare_storyops_invoice_checkout(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000104',
      '33000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000651',
      invoice_version_value + 1
    );
  exception when others then
    blocked := position('PAYMENT_RECONCILIATION_REQUIRED' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Open payment allocation conflict allowed another checkout';
  end if;
end;
$$;

\echo '8/10 customer projection pauses Pay without exposing provider conflict details'
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  portal jsonb;
  invoice jsonb;
begin
  portal := public.get_customer_portal_state(
    '10000000-0000-4000-8000-000000000001'
  );
  select value into invoice
  from jsonb_array_elements(
    portal #> '{customers,0,commercial,invoices}'
  )
  where value ->> 'id' = '10000000-0000-4000-8000-000000000651';
  if invoice ->> 'paymentReconciliationRequired' <> 'true'
    or nullif(invoice ->> 'paymentReconciliationMessage', '') is null
    or portal #>> '{customers,0,commercial,paymentReconciliationRequired}' <> 'true'
    or portal::text like '%pi_payment_boundary_stale%'
    or portal::text like '%stale_invoice_version%'
  then
    raise exception 'Customer payment-hold projection was unsafe: %', portal;
  end if;
end;
$$;

\echo '9/10 owner workspace has the exact conflict, approval, and next action'
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  workspace jsonb;
  conflict jsonb;
begin
  workspace := public.get_storyops_workspace(
    '10000000-0000-4000-8000-000000000001'
  );
  select value into conflict
  from jsonb_array_elements(workspace -> 'paymentAllocationConflicts')
  where value ->> 'paymentId' = (
    select value #>> '{}'
    from pg_temp.payment_boundary_state
    where key = 'stale_payment_id'
  );
  if conflict ->> 'conflictCode' <> 'stale_invoice_version'
    or conflict ->> 'status' <> 'open'
    or nullif(conflict ->> 'approvalRequestId', '') is null
    or nullif(conflict ->> 'nextAction', '') is null
    or conflict ->> 'verifiedAmount' <> '396.00'
    or conflict ->> 'resolutionAction'
      <> 'payment.allocation.apply_exact_current_balance'
    or conflict ->> 'canApplyExactCurrentBalance' <> 'true'
  then
    raise exception 'Owner payment allocation queue was incomplete: %', workspace;
  end if;
end;
$$;

\echo '10/10 a paused company cannot consume allocation approval; reactivation resolves exactly once'
reset role;
-- Production authenticated users retain no raw payment/approval table reads.
-- This rolled-back grant exists only so the finite-command test can assert
-- atomic non-consumption while running under the real authenticated JWT role.
grant select on
  public.approval_requests,
  public.payment_allocation_conflicts,
  public.payments
to authenticated;
insert into payment_boundary_state(key, value)
select
  'resolution_fixture',
  jsonb_build_object(
    'conflictId', conflict.id,
    'conflictVersion', conflict.version,
    'paymentId', conflict.payment_id,
    'invoiceId', conflict.invoice_id,
    'invoiceVersion', invoice.version,
    'approvalRequestId', approval.id,
    'approvalVersion', approval.version
  )
from public.payment_allocation_conflicts conflict
join public.invoices invoice on invoice.id = conflict.invoice_id
join public.approval_requests approval
  on approval.id = conflict.approval_request_id
where conflict.payment_id = (
  select (value #>> '{}')::uuid
  from payment_boundary_state
  where key = 'stale_payment_id'
)
  and conflict.status = 'open';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  fixture jsonb;
  result jsonb;
  replay jsonb;
  paused_resolution_blocked boolean := false;
  pause_request text;
  pause_hash text;
  reactivate_request text;
  reactivate_hash text;
begin
  select value into fixture
  from pg_temp.payment_boundary_state
  where key = 'resolution_fixture';
  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000006',
    'approval.decide',
    (fixture ->> 'approvalVersion')::integer,
    jsonb_build_object(
      'entityId', fixture ->> 'approvalRequestId',
      'decision', 'approved',
      'decisionNote', 'Exact Stripe amount and current invoice balance reviewed.'
    ),
    repeat('0', 64)
  );

  pause_request := jsonb_build_object(
    'action',
    'company.operational_status.set',
    'payload',
    jsonb_build_object(
      'expectedStatus',
      'active',
      'reason',
      'Pause while proving allocation approval cannot be consumed.',
      'targetStatus',
      'paused'
    )
  )::text;
  pause_hash := encode(
    extensions.digest(convert_to(pause_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.set_storyops_company_operational_status(
    '10000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000007',
    'active',
    'paused',
    'Pause while proving allocation approval cannot be consumed.',
    pause_request,
    pause_hash
  );

  begin
    perform public.resolve_storyops_payment_allocation(
      '10000000-0000-4000-8000-000000000001',
      (fixture ->> 'conflictId')::uuid,
      (fixture ->> 'approvalRequestId')::uuid,
      (fixture ->> 'conflictVersion')::integer,
      (fixture ->> 'invoiceVersion')::integer,
      'This paused-company resolution must not consume approval or mutate ledgers.'
    );
  exception
    when insufficient_privilege then
      paused_resolution_blocked := sqlerrm = 'STORYOPS_COMPANY_NOT_ACTIVE';
  end;

  if not paused_resolution_blocked
    or exists (
      select 1
      from public.approval_requests approval
      where approval.id = (fixture ->> 'approvalRequestId')::uuid
        and approval.consumed_at is not null
    )
    or exists (
      select 1
      from public.payment_allocation_conflicts conflict
      where conflict.id = (fixture ->> 'conflictId')::uuid
        and conflict.status <> 'open'
    )
    or exists (
      select 1
      from public.payments payment
      where payment.id = (fixture ->> 'paymentId')::uuid
        and payment.allocation_status <> 'unapplied'
    )
  then
    raise exception 'Paused allocation resolution changed approval, conflict, or ledger state';
  end if;

  reactivate_request := jsonb_build_object(
    'action',
    'company.operational_status.set',
    'payload',
    jsonb_build_object(
      'expectedStatus',
      'paused',
      'reason',
      'Resume after the paused allocation boundary was verified.',
      'targetStatus',
      'active'
    )
  )::text;
  reactivate_hash := encode(
    extensions.digest(convert_to(reactivate_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.set_storyops_company_operational_status(
    '10000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000008',
    'paused',
    'active',
    'Resume after the paused allocation boundary was verified.',
    reactivate_request,
    reactivate_hash
  );

  result := public.resolve_storyops_payment_allocation(
    '10000000-0000-4000-8000-000000000001',
    (fixture ->> 'conflictId')::uuid,
    (fixture ->> 'approvalRequestId')::uuid,
    (fixture ->> 'conflictVersion')::integer,
    (fixture ->> 'invoiceVersion')::integer,
    'Applied only after owner verified the exact Stripe charge and current balance.'
  );
  replay := public.resolve_storyops_payment_allocation(
    '10000000-0000-4000-8000-000000000001',
    (fixture ->> 'conflictId')::uuid,
    (fixture ->> 'approvalRequestId')::uuid,
    (fixture ->> 'conflictVersion')::integer,
    (fixture ->> 'invoiceVersion')::integer,
    'Applied only after owner verified the exact Stripe charge and current balance.'
  );
  if result ->> 'schemaVersion'
      <> 'storyops-payment-allocation-resolution-v1'
    or result ->> 'status' <> 'applied'
    or result ->> 'companyId'
      <> '10000000-0000-4000-8000-000000000001'
    or result ->> 'amount' <> '396.00'
    or nullif(result ->> 'serverTime', '') is null
    or replay <> result
  then
    raise exception 'Exact allocation resolution receipt was invalid: %', result;
  end if;
end;
$$;

reset role;
revoke select on
  public.approval_requests,
  public.payment_allocation_conflicts,
  public.payments
from authenticated;
do $$
declare
  fixture jsonb;
begin
  select value into fixture
  from payment_boundary_state
  where key = 'resolution_fixture';
  if not exists (
      select 1
      from public.payment_allocation_conflicts conflict
      where conflict.id = (fixture ->> 'conflictId')::uuid
        and conflict.status = 'resolved'
        and conflict.resolved_by =
          '10000000-0000-4000-8000-000000000101'
    )
    or not exists (
      select 1
      from public.payments payment
      where payment.id = (fixture ->> 'paymentId')::uuid
        and payment.status = 'succeeded'
        and payment.allocation_status = 'applied'
    )
    or not exists (
      select 1
      from public.invoices invoice
      where invoice.id = (fixture ->> 'invoiceId')::uuid
        and invoice.status = 'paid'
        and invoice.amount_paid = 528.00
        and invoice.balance_due = 0
    )
    or not exists (
      select 1
      from public.approval_requests approval
      where approval.id = (fixture ->> 'approvalRequestId')::uuid
        and approval.consumed_at is not null
        and approval.execution_receipt ->> 'disposition'
          = 'applied_exact_current_balance'
    )
    or (
      select count(*)
      from public.audit_events event
      where event.request_id = fixture ->> 'approvalRequestId'
        and event.action =
          'payment_allocation_applied_exact_current_balance'
    ) <> 1
  then
    raise exception 'Exact allocation resolution did not close atomically';
  end if;
end;
$$;

rollback;
