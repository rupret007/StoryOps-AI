\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.reconcile_checkout_event(
  p_provider_event_id text,
  p_event_type text,
  p_checkout_id text,
  p_action text,
  p_checkout_purpose text,
  p_checkout_attempt integer,
  p_quote_id uuid,
  p_invoice_id uuid,
  p_invoice_version integer,
  p_payment_intent_id text,
  p_amount_cents bigint
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public, extensions
as $$
declare
  receipt jsonb;
  payload_hash text;
  event_id_value uuid;
  event_claimed boolean;
  event_status text;
  lease_id uuid;
  result jsonb;
begin
  receipt := jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'stripe',
    'eventId', p_provider_event_id,
    'eventType', p_event_type,
    'objectId', p_checkout_id,
    'objectKind', case
      when p_event_type like 'payment_intent.%' then 'payment_intent'
      else 'checkout'
    end,
    'action', p_action,
    'companyId', '10000000-0000-4000-8000-000000000001',
    'occurredAt', now(),
    'quoteId', p_quote_id,
    'checkoutPurpose', p_checkout_purpose,
    'checkoutAttempt', p_checkout_attempt,
    'invoiceId', p_invoice_id,
    'invoiceVersion', p_invoice_version,
    'paymentIntentId', p_payment_intent_id,
    'amountCents', p_amount_cents,
    'currency', 'usd',
    'failureCode', case
      when p_action = 'payment_failed' then 'checkout_session_expired'
      else null
    end
  ));
  payload_hash := encode(
    extensions.digest(convert_to(receipt::text, 'UTF8'), 'sha256'),
    'hex'
  );
  select event_id, claimed, existing_status
  into event_id_value, event_claimed, event_status
  from public.claim_webhook_event(
    'stripe',
    p_provider_event_id,
    p_event_type,
    payload_hash,
    receipt,
    '10000000-0000-4000-8000-000000000001'
  );
  lease_id := public.start_storyops_intake_processing(
    event_id_value,
    payload_hash
  );
  if not event_claimed or event_status <> 'received' or lease_id is null then
    raise exception 'Checkout retirement fixture could not claim %',
      p_provider_event_id;
  end if;
  result := public.reconcile_provider_webhook(
    event_id_value,
    payload_hash,
    '10000000-0000-4000-8000-000000000001',
    'stripe',
    receipt
  );
  perform public.complete_storyops_intake_webhook(
    event_id_value,
    payload_hash,
    lease_id,
    'processed'
  );
  return result;
end;
$$;

grant execute on function pg_temp.reconcile_checkout_event(
  text, text, text, text, text, integer, uuid, uuid, integer, text, bigint
) to service_role;

create temporary table checkout_retirement_state (
  key text primary key,
  value text not null
);
grant select on checkout_retirement_state to service_role;
insert into checkout_retirement_state(key, value)
select 'quote_version', quote.version::text
from public.quotes quote
where quote.id = '10000000-0000-4000-8000-000000000521';

-- Privileged fixture reset. No end-user JWT is present, so the exact-delete
-- guard remains enabled for every authenticated path.
update public.payments
set provider_checkout_id = null,
    provider_payment_id = null,
    provider_amount_received = null,
    allocation_status = null,
    checkout_attempt = 1,
    status = 'pending',
    processed_at = null,
    failure_code = null
where id = '10000000-0000-4000-8000-000000000655';
delete from public.payment_allocation_conflicts
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.payment_checkout_retirements
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.approval_requests
where company_id = '10000000-0000-4000-8000-000000000001'
  and action_type like 'payment.allocation.%';
delete from public.payments
where company_id = '10000000-0000-4000-8000-000000000001'
  and invoice_id = '10000000-0000-4000-8000-000000000651'
  and payment_type = 'invoice';
delete from public.idempotency_keys
where company_id = '10000000-0000-4000-8000-000000000001'
  and scope in ('deposit-checkout-v1', 'invoice-checkout-v1');
delete from public.webhook_events
where provider = 'stripe'
  and (
    provider_event_id like 'evt_checkout_retirement_%'
    or provider_event_id = 'evt_storyops_local_deposit_1'
  );
update public.invoices
set status = 'draft',
    amount_paid = 0,
    balance_due = total,
    paid_at = null
where id = '10000000-0000-4000-8000-000000000651';
update public.jobs
set status = 'pending_deposit'
where id = '10000000-0000-4000-8000-000000000631';

\echo '1/4 a signed terminal deposit session retires once and reopens the same command at attempt 2'
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
  quote_version_value integer;
  first_claim jsonb;
  retry_claim jsonb;
  response jsonb;
  retirement_result jsonb;
  success_result jsonb;
begin
  select value::integer
  into quote_version_value
  from pg_temp.checkout_retirement_state
  where key = 'quote_version';
  first_claim := public.prepare_storyops_deposit_checkout(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    '33000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000521',
    quote_version_value
  );
  if first_claim ->> 'providerIdempotencyKey'
      <> 'storyops:deposit:10000000-0000-4000-8000-000000000521:attempt:1'
    or first_claim ->> 'checkoutAttempt' <> '1'
  then
    raise exception 'Deposit attempt 1 was invalid: %', first_claim;
  end if;
  response := jsonb_build_object(
    'action', 'deposit.checkout',
    'status', 'checkout_open',
    'mode', 'sandbox',
    'quoteId', first_claim ->> 'quoteId',
    'jobId', first_claim ->> 'jobId',
    'invoiceId', first_claim ->> 'invoiceId',
    'amount', '132.00',
    'currency', 'USD',
    'paymentVerified', false,
    'depositReady', false,
    'replayed', false,
    'checkoutId', 'cs_checkout_retirement_deposit_1',
    'sandboxReceipt', 'Signed-expiry contract fixture; no external funds moved.'
  );
  perform public.complete_storyops_deposit_checkout(
    '10000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000201',
    first_claim ->> 'requestHash',
    (first_claim ->> 'paymentId')::uuid,
    'cs_checkout_retirement_deposit_1',
    response
  );
  retirement_result := pg_temp.reconcile_checkout_event(
    'evt_checkout_retirement_deposit_expired',
    'checkout.session.expired',
    'cs_checkout_retirement_deposit_1',
    'payment_failed',
    'quote_deposit',
    1,
    '10000000-0000-4000-8000-000000000521',
    null,
    null,
    null,
    13200
  );
  if retirement_result ->> 'checkoutRetired' <> 'true'
    or retirement_result ->> 'checkoutAttempt' <> '2'
  then
    raise exception 'Deposit terminal event did not retire attempt 1: %',
      retirement_result;
  end if;

  retry_claim := public.prepare_storyops_deposit_checkout(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    '33000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000521',
    quote_version_value
  );
  if retry_claim ->> 'claimStatus' <> 'reserved'
    or retry_claim ->> 'providerIdempotencyKey'
      <> 'storyops:deposit:10000000-0000-4000-8000-000000000521:attempt:2'
    or retry_claim ->> 'checkoutAttempt' <> '2'
  then
    raise exception 'Deposit attempt 2 did not reopen safely: %', retry_claim;
  end if;
  response := response
    || jsonb_build_object(
      'checkoutId', 'cs_checkout_retirement_deposit_2'
    );
  perform public.complete_storyops_deposit_checkout(
    '10000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000201',
    retry_claim ->> 'requestHash',
    (retry_claim ->> 'paymentId')::uuid,
    'cs_checkout_retirement_deposit_2',
    response
  );
  success_result := pg_temp.reconcile_checkout_event(
    'evt_checkout_retirement_deposit_succeeded',
    'checkout.session.completed',
    'cs_checkout_retirement_deposit_2',
    'payment_succeeded',
    'quote_deposit',
    2,
    '10000000-0000-4000-8000-000000000521',
    null,
    null,
    'pi_checkout_retirement_deposit_2',
    13200
  );
  if success_result ->> 'allocationStatus' <> 'applied' then
    raise exception 'Replacement deposit was not applied exactly: %',
      success_result;
  end if;
end;
$$;

reset role;
do $$
begin
  if (
      select count(*)
      from public.payment_checkout_retirements retirement
      where retirement.provider_checkout_id =
        'cs_checkout_retirement_deposit_1'
        and retirement.checkout_attempt = 1
        and retirement.retirement_reason = 'checkout_session_expired'
    ) <> 1
    or not exists (
      select 1
      from public.payments payment
      where payment.id = '10000000-0000-4000-8000-000000000655'
        and payment.provider_checkout_id =
          'cs_checkout_retirement_deposit_2'
        and payment.provider_payment_id =
          'pi_checkout_retirement_deposit_2'
        and payment.checkout_attempt = 2
        and payment.status = 'succeeded'
        and payment.allocation_status = 'applied'
    )
  then
    raise exception 'Deposit retirement ledger or replacement truth was incomplete';
  end if;
end;
$$;

\echo '2/4 a signed terminal invoice session also gets one new provider generation'
update public.invoices
set status = 'open',
    issue_date = current_date,
    due_date = current_date
where id = '10000000-0000-4000-8000-000000000651';
insert into checkout_retirement_state(key, value)
select 'invoice_version', invoice.version::text
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
  invoice_version_value integer;
  first_claim jsonb;
  retry_claim jsonb;
  response jsonb;
  retirement_result jsonb;
begin
  select value::integer
  into invoice_version_value
  from pg_temp.checkout_retirement_state
  where key = 'invoice_version';
  first_claim := public.prepare_storyops_invoice_checkout(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    '33000000-0000-4000-8000-000000000202',
    '10000000-0000-4000-8000-000000000651',
    invoice_version_value
  );
  if first_claim ->> 'providerIdempotencyKey' not like '%:attempt:1'
    or first_claim ->> 'checkoutAttempt' <> '1'
  then
    raise exception 'Invoice attempt 1 was invalid: %', first_claim;
  end if;
  response := jsonb_build_object(
    'action', 'invoice.checkout',
    'status', 'checkout_open',
    'mode', 'sandbox',
    'quoteId', first_claim ->> 'quoteId',
    'jobId', first_claim ->> 'jobId',
    'invoiceId', first_claim ->> 'invoiceId',
    'invoiceVersion', invoice_version_value,
    'amount', '396.00',
    'currency', 'USD',
    'paymentVerified', false,
    'invoicePaid', false,
    'replayed', false,
    'checkoutId', 'cs_checkout_retirement_invoice_1',
    'sandboxReceipt', 'Signed-expiry contract fixture; no external funds moved.'
  );
  perform public.complete_storyops_invoice_checkout(
    '10000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000202',
    first_claim ->> 'requestHash',
    (first_claim ->> 'paymentId')::uuid,
    'cs_checkout_retirement_invoice_1',
    response
  );
  retirement_result := pg_temp.reconcile_checkout_event(
    'evt_checkout_retirement_invoice_expired',
    'checkout.session.expired',
    'cs_checkout_retirement_invoice_1',
    'payment_failed',
    'invoice_balance',
    1,
    '10000000-0000-4000-8000-000000000521',
    '10000000-0000-4000-8000-000000000651',
    invoice_version_value,
    null,
    39600
  );
  if retirement_result ->> 'checkoutRetired' <> 'true'
    or retirement_result ->> 'checkoutAttempt' <> '2'
  then
    raise exception 'Invoice terminal event did not retire attempt 1: %',
      retirement_result;
  end if;

  retry_claim := public.prepare_storyops_invoice_checkout(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    '33000000-0000-4000-8000-000000000202',
    '10000000-0000-4000-8000-000000000651',
    invoice_version_value
  );
  if retry_claim ->> 'claimStatus' <> 'reserved'
    or retry_claim ->> 'providerIdempotencyKey' not like '%:attempt:2'
    or retry_claim ->> 'checkoutAttempt' <> '2'
  then
    raise exception 'Invoice attempt 2 did not reopen safely: %', retry_claim;
  end if;
  response := response
    || jsonb_build_object(
      'checkoutId', 'cs_checkout_retirement_invoice_2'
    );
  perform public.complete_storyops_invoice_checkout(
    '10000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000202',
    retry_claim ->> 'requestHash',
    (retry_claim ->> 'paymentId')::uuid,
    'cs_checkout_retirement_invoice_2',
    response
  );
end;
$$;

\echo '3/4 a late success for a retired identity is quarantined and never pays the invoice'
do $$
declare
  invoice_version_value integer;
  result jsonb;
begin
  -- The version is carried by the signed metadata, not inferred from an
  -- event-time invoice read.
  select value::integer
  into invoice_version_value
  from pg_temp.checkout_retirement_state
  where key = 'invoice_version';
  result := pg_temp.reconcile_checkout_event(
    'evt_checkout_retirement_invoice_late_success',
    'payment_intent.succeeded',
    'pi_checkout_retirement_invoice_late',
    'payment_succeeded',
    'invoice_balance',
    1,
    '10000000-0000-4000-8000-000000000521',
    '10000000-0000-4000-8000-000000000651',
    invoice_version_value,
    null,
    39600
  );
  if result ->> 'entityType' <> 'payment_allocation_conflict'
    or result ->> 'allocationStatus' is not null
  then
    raise exception 'Retired late success was not quarantined: %', result;
  end if;
end;
$$;

reset role;
do $$
begin
  if not exists (
      select 1
      from public.payments payment
      where payment.company_id = '10000000-0000-4000-8000-000000000001'
        and payment.invoice_id = '10000000-0000-4000-8000-000000000651'
        and payment.payment_type = 'invoice'
        and payment.provider_checkout_id =
          'cs_checkout_retirement_invoice_2'
        and payment.provider_payment_id is null
        and payment.status = 'pending'
        and payment.checkout_attempt = 2
    )
    or not exists (
      select 1
      from public.payment_allocation_conflicts conflict
      join public.approval_requests approval
        on approval.id = conflict.approval_request_id
      where conflict.company_id =
          '10000000-0000-4000-8000-000000000001'
        and conflict.conflict_code = 'retired_checkout_succeeded'
        and conflict.status = 'open'
        and conflict.provider_checkout_id =
          'cs_checkout_retirement_invoice_1'
        and conflict.provider_payment_id =
          'pi_checkout_retirement_invoice_late'
        and approval.action_type = 'payment.allocation.review_manual'
        and approval.status = 'pending'
    )
    or not exists (
      select 1
      from public.invoices invoice
      where invoice.id = '10000000-0000-4000-8000-000000000651'
        and invoice.status = 'open'
        and invoice.amount_paid = 132.00
        and invoice.balance_due = 396.00
    )
  then
    raise exception 'Retired-session late money altered active checkout or invoice truth';
  end if;
end;
$$;

\echo '4/4 the retired-session money hold blocks every subsequent collection attempt'
insert into checkout_retirement_state(key, value)
select 'held_invoice_version', invoice.version::text
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
  invoice_version_value integer;
  blocked boolean := false;
begin
  select value::integer
  into invoice_version_value
  from pg_temp.checkout_retirement_state
  where key = 'held_invoice_version';
  begin
    perform public.prepare_storyops_invoice_checkout(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000104',
      '33000000-0000-4000-8000-000000000203',
      '10000000-0000-4000-8000-000000000651',
      invoice_version_value
    );
  exception when others then
    blocked := position('PAYMENT_RECONCILIATION_REQUIRED' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Retired-session late success allowed another checkout';
  end if;
end;
$$;

rollback;
