import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '10000000-0000-4000-8000-000000000104';
const INVOICE_ID = '10000000-0000-4000-8000-000000000651';
const EVENT_NAME = 'evt_payment_lock_order_contract';

const dockerPsql = [
  'exec',
  '-i',
  'supabase_db_storyops-ai',
  'psql',
  '-v',
  'ON_ERROR_STOP=1',
  '-U',
  'postgres',
  '-d',
  'postgres',
];

function runSql(sql) {
  execFileSync('docker', dockerPsql, {
    input: sql,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

function queryJson(sql) {
  const output = execFileSync(
    'docker',
    [
      'exec',
      'supabase_db_storyops-ai',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-Atc',
      sql,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  return JSON.parse(output);
}

function runSession(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', dockerPsql, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Concurrent psql session timed out.\n${stderr}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Concurrent psql session exited ${code}.\n${stdout}\n${stderr}`));
    });
    child.stdin.end(sql);
  });
}

const setupSql = `
delete from public.payment_allocation_conflicts
where company_id = '${COMPANY_ID}';
delete from public.payment_checkout_retirements
where company_id = '${COMPANY_ID}';
delete from public.approval_requests
where company_id = '${COMPANY_ID}'
  and action_type like 'payment.allocation.%';
delete from public.payments
where company_id = '${COMPANY_ID}'
  and invoice_id = '${INVOICE_ID}'
  and payment_type = 'invoice';
delete from public.idempotency_keys
where company_id = '${COMPANY_ID}'
  and scope = 'invoice-checkout-v1';
delete from public.webhook_events
where provider = 'stripe' and provider_event_id = '${EVENT_NAME}';
update public.invoices
set status = 'open',
    issue_date = current_date,
    due_date = current_date,
    amount_paid = 132.00,
    balance_due = 396.00,
    paid_at = null
where id = '${INVOICE_ID}';
select set_config(
  'request.jwt.claims',
  '{"sub":"${CUSTOMER_ID}","role":"service_role"}',
  false
);
select set_config('request.jwt.claim.sub', '${CUSTOMER_ID}', false);
select set_config('request.jwt.claim.role', 'service_role', false);
do $$
declare
  invoice_version_value integer;
  claim jsonb;
  response jsonb;
  receipt jsonb;
  payload_hash text;
  event_id_value uuid;
  event_claimed boolean;
  event_status text;
  lease_id uuid;
begin
  select version into invoice_version_value
  from public.invoices where id = '${INVOICE_ID}';
  claim := public.prepare_storyops_invoice_checkout(
    '${COMPANY_ID}',
    '${CUSTOMER_ID}',
    '33000000-0000-4000-8000-000000000101',
    '${INVOICE_ID}',
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
    'checkoutId', 'cs_payment_lock_order',
    'sandboxReceipt', 'Concurrency contract fixture; no external funds moved.'
  );
  perform public.complete_storyops_invoice_checkout(
    '${COMPANY_ID}',
    '33000000-0000-4000-8000-000000000101',
    claim ->> 'requestHash',
    (claim ->> 'paymentId')::uuid,
    'cs_payment_lock_order',
    response
  );
  receipt := jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'stripe',
    'eventId', '${EVENT_NAME}',
    'eventType', 'checkout.session.completed',
    'objectId', 'cs_payment_lock_order',
    'objectKind', 'checkout',
    'action', 'payment_succeeded',
    'companyId', '${COMPANY_ID}',
    'occurredAt', now(),
    'quoteId', '10000000-0000-4000-8000-000000000521',
    'checkoutPurpose', 'invoice_balance',
    'checkoutAttempt', 1,
    'invoiceId', '${INVOICE_ID}',
    'invoiceVersion', invoice_version_value,
    'paymentIntentId', 'pi_payment_lock_order',
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
    '${EVENT_NAME}',
    'checkout.session.completed',
    payload_hash,
    receipt,
    '${COMPANY_ID}'
  );
  lease_id := public.start_storyops_intake_processing(event_id_value, payload_hash);
  if not event_claimed or event_status <> 'received' or lease_id is null then
    raise exception 'Concurrency provider fixture did not obtain a lease';
  end if;
end;
$$;
`;

const checkoutSessionSql = `
begin;
select set_config(
  'request.jwt.claims',
  '{"sub":"${CUSTOMER_ID}","role":"service_role"}',
  true
);
select set_config('request.jwt.claim.sub', '${CUSTOMER_ID}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select public.prepare_storyops_invoice_checkout(
  '${COMPANY_ID}',
  '${CUSTOMER_ID}',
  '33000000-0000-4000-8000-000000000102',
  '${INVOICE_ID}',
  (select version from public.invoices where id = '${INVOICE_ID}')
);
select pg_sleep(1.5);
commit;
`;

const reconciliationSessionSql = `
begin;
select set_config(
  'request.jwt.claims',
  '{"sub":"${CUSTOMER_ID}","role":"service_role"}',
  true
);
select set_config('request.jwt.claim.sub', '${CUSTOMER_ID}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select public.reconcile_provider_webhook(
  event.id,
  event.payload_hash,
  event.company_id,
  event.provider,
  event.payload
)
from public.webhook_events event
where event.provider = 'stripe'
  and event.provider_event_id = '${EVENT_NAME}';
commit;
`;

const cleanupSql = `
delete from public.payment_allocation_conflicts
where company_id = '${COMPANY_ID}';
delete from public.payment_checkout_retirements
where company_id = '${COMPANY_ID}';
delete from public.approval_requests
where company_id = '${COMPANY_ID}'
  and action_type like 'payment.allocation.%';
delete from public.payments
where company_id = '${COMPANY_ID}'
  and invoice_id = '${INVOICE_ID}'
  and payment_type = 'invoice';
delete from public.idempotency_keys
where company_id = '${COMPANY_ID}'
  and scope = 'invoice-checkout-v1';
delete from public.webhook_events
where provider = 'stripe' and provider_event_id = '${EVENT_NAME}';
update public.invoices
set status = 'draft',
    amount_paid = 0,
    balance_due = total,
    paid_at = null
where id = '${INVOICE_ID}';
`;

try {
  runSql(setupSql);
  const checkoutSession = runSession(checkoutSessionSql);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const reconciliationSession = runSession(reconciliationSessionSql);
  const results = await Promise.all([checkoutSession, reconciliationSession]);
  assert.ok(
    results.every(({ stderr }) => !/deadlock detected/iu.test(stderr)),
    'Invoice/payment lock order produced a database deadlock.',
  );

  const truth = queryJson(`
    select jsonb_build_object(
      'invoiceStatus', invoice.status,
      'amountPaid', invoice.amount_paid,
      'balanceDue', invoice.balance_due,
      'invoicePaymentCount', (
        select count(*)
        from public.payments payment
        where payment.invoice_id = invoice.id
          and payment.payment_type = 'invoice'
      ),
      'appliedPaymentCount', (
        select count(*)
        from public.payments payment
        where payment.invoice_id = invoice.id
          and payment.payment_type = 'invoice'
          and payment.status = 'succeeded'
          and payment.allocation_status = 'applied'
      )
    )
    from public.invoices invoice
    where invoice.id = '${INVOICE_ID}'
  `);
  assert.deepEqual(truth, {
    invoiceStatus: 'paid',
    amountPaid: 528.0,
    balanceDue: 0.0,
    invoicePaymentCount: 1,
    appliedPaymentCount: 1,
  });
} finally {
  runSql(cleanupSql);
}

process.stdout.write(
  'Two-session invoice checkout and signed payment reconciliation completed without deadlock or duplicate allocation.\n',
);
