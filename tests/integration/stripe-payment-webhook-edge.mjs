import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseCommand } from '../../infra/scripts/common.mjs';

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '10000000-0000-4000-8000-000000000201';
const QUOTE_ID = '10000000-0000-4000-8000-000000000521';
const JOB_ID = '10000000-0000-4000-8000-000000000631';
const INVOICE_ID = '10000000-0000-4000-8000-000000000651';
const DEPOSIT_PAYMENT_ID = '10000000-0000-4000-8000-000000000655';
const WEBHOOK_SECRET = 'whsec_storyops_local_contract_only';

function localSupabaseEnvironment() {
  const cli = supabaseCommand();
  const output = execFileSync(cli.command, [...cli.prefix, 'status', '-o', 'env'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const values = Object.fromEntries(
    output
      .split(/\r?\n/u)
      .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/u))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
  const url = values.API_URL;
  const anonKey = values.ANON_KEY ?? values.PUBLISHABLE_KEY;
  assert.ok(url && anonKey, 'Local Supabase API URL and public key are required.');
  return { url, anonKey };
}

function runSql(sql) {
  execFileSync(
    'docker',
    [
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
    ],
    { input: sql, stdio: ['pipe', 'ignore', 'pipe'] },
  );
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
  assert.ok(output, 'Expected a database JSON result.');
  return JSON.parse(output);
}

async function errorPayload(error) {
  try {
    return await error?.context?.clone().json();
  } catch {
    return undefined;
  }
}

async function signIn(client, email) {
  const { error } = await client.auth.signInWithPassword({
    email,
    password: 'StoryOpsDemo1!',
  });
  assert.equal(error, null, `Unable to sign in ${email}.`);
}

async function portalInvoice(client) {
  const { data, error } = await client.rpc('get_customer_portal_state', {
    p_company_id: COMPANY_ID,
  });
  assert.equal(error, null, error?.message);
  const invoice = data.customers
    .flatMap((customer) => customer.commercial.invoices)
    .find((candidate) => candidate.id === INVOICE_ID);
  assert.ok(invoice, 'Issued invoice was not projected to its exact portal customer.');
  return { invoice, portal: data };
}

async function invokeCheckout(client, action, entityId, expectedVersion) {
  return client.functions.invoke('golden-path', {
    body: {
      companyId: COMPANY_ID,
      action,
      commandId: randomUUID(),
      entityId,
      expectedVersion,
    },
  });
}

function checkoutEvent({
  eventId,
  checkoutId,
  paymentIntentId,
  amountCents,
  checkoutPurpose,
  invoiceVersion,
  checkoutAttempt = 1,
}) {
  return {
    id: eventId,
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1_000),
    data: {
      object: {
        id: checkoutId,
        payment_intent: paymentIntentId,
        payment_status: 'paid',
        amount_total: amountCents,
        currency: 'usd',
        metadata: {
          company_id: COMPANY_ID,
          quote_id: QUOTE_ID,
          checkout_purpose: checkoutPurpose,
          checkout_attempt: String(checkoutAttempt),
          ...(checkoutPurpose === 'invoice_balance'
            ? { invoice_id: INVOICE_ID, invoice_version: String(invoiceVersion) }
            : {}),
        },
      },
    },
  };
}

function expiredCheckoutEvent({
  eventId,
  checkoutId,
  amountCents,
  checkoutPurpose,
  invoiceVersion,
  checkoutAttempt = 1,
}) {
  return {
    id: eventId,
    type: 'checkout.session.expired',
    created: Math.floor(Date.now() / 1_000),
    data: {
      object: {
        id: checkoutId,
        payment_status: 'unpaid',
        amount_total: amountCents,
        currency: 'usd',
        metadata: {
          company_id: COMPANY_ID,
          quote_id: QUOTE_ID,
          checkout_purpose: checkoutPurpose,
          checkout_attempt: String(checkoutAttempt),
          ...(checkoutPurpose === 'invoice_balance'
            ? { invoice_id: INVOICE_ID, invoice_version: String(invoiceVersion) }
            : {}),
        },
      },
    },
  };
}

function paymentIntentEvent({
  eventId,
  paymentIntentId,
  amountCents,
  invoiceVersion,
  checkoutAttempt = 1,
}) {
  return {
    id: eventId,
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1_000),
    data: {
      object: {
        id: paymentIntentId,
        amount_received: amountCents,
        currency: 'usd',
        metadata: {
          company_id: COMPANY_ID,
          quote_id: QUOTE_ID,
          checkout_purpose: 'invoice_balance',
          checkout_attempt: String(checkoutAttempt),
          invoice_id: INVOICE_ID,
          invoice_version: String(invoiceVersion),
        },
      },
    },
  };
}

async function signedStripeResponse(url, rawBody, signingSecret = WEBHOOK_SECRET) {
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = createHmac('sha256', signingSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const response = await fetch(`${url}/functions/v1/provider-webhook?provider=stripe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${timestamp},v1=${signature}`,
      'x-storyops-sandbox': 'true',
    },
    body: rawBody,
  });
  return { response, body: await response.json() };
}

async function sendSignedStripeEvent(url, payload) {
  const { response, body } = await signedStripeResponse(url, JSON.stringify(payload));
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.accepted, true);
  assert.equal(body.status, 'processed');
  return body;
}

const initialSetupSql = `
with removed_conflicts as (
  delete from public.payment_allocation_conflicts
  where company_id = '${COMPANY_ID}'
    and invoice_id = '${INVOICE_ID}'
  returning approval_request_id
)
delete from public.approval_requests
where id in (
  select approval_request_id
  from removed_conflicts
  where approval_request_id is not null
);
delete from public.payment_checkout_retirements
where company_id = '${COMPANY_ID}'
  and invoice_id = '${INVOICE_ID}';
delete from public.payments
where company_id = '${COMPANY_ID}'
  and invoice_id = '${INVOICE_ID}'
  and payment_type = 'invoice';
delete from public.idempotency_keys
where company_id = '${COMPANY_ID}'
  and scope in ('deposit-checkout-v1', 'invoice-checkout-v1');
delete from public.webhook_events
where provider = 'stripe'
  and (
    provider_event_id like 'evt_edge_payment_%'
    or provider_event_id = 'evt_storyops_local_deposit_1'
  );
update public.payments
set provider_checkout_id = null,
    provider_payment_id = null,
    provider_amount_received = null,
    allocation_status = null,
    checkout_attempt = 1,
    status = 'pending',
    processed_at = null,
    failure_code = null
where id = '${DEPOSIT_PAYMENT_ID}';
update public.invoices
set status = 'draft',
    issue_date = current_date,
    due_date = current_date,
    amount_paid = 0,
    balance_due = total,
    paid_at = null
where id = '${INVOICE_ID}';
update public.jobs
set status = 'pending_deposit'
where id = '${JOB_ID}';
`;

const cleanupSql = `
with removed_conflicts as (
  delete from public.payment_allocation_conflicts
  where company_id = '${COMPANY_ID}'
    and invoice_id = '${INVOICE_ID}'
  returning approval_request_id
)
delete from public.approval_requests
where id in (
  select approval_request_id
  from removed_conflicts
  where approval_request_id is not null
);
delete from public.payment_checkout_retirements
where company_id = '${COMPANY_ID}'
  and invoice_id = '${INVOICE_ID}';
delete from public.payments
where company_id = '${COMPANY_ID}'
  and invoice_id = '${INVOICE_ID}'
  and payment_type = 'invoice';
delete from public.idempotency_keys
where company_id = '${COMPANY_ID}'
  and scope in ('deposit-checkout-v1', 'invoice-checkout-v1');
delete from public.webhook_events
where provider = 'stripe'
  and (
    provider_event_id like 'evt_edge_payment_%'
    or provider_event_id = 'evt_storyops_local_deposit_1'
  );
update public.payments
set provider_checkout_id = 'cs_storyops_local_deposit_1',
    provider_payment_id = 'pi_storyops_local_deposit_1',
    provider_amount_received = 132.00,
    allocation_status = 'applied',
    checkout_attempt = 1,
    status = 'succeeded',
    processed_at = now() - interval '2 days',
    failure_code = null
where id = '${DEPOSIT_PAYMENT_ID}';
with fixture(receipt) as (
  values (jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'stripe',
    'eventId', 'evt_storyops_local_deposit_1',
    'eventType', 'checkout.session.completed',
    'objectId', 'cs_storyops_local_deposit_1',
    'objectKind', 'checkout',
    'action', 'payment_succeeded',
    'companyId', '${COMPANY_ID}',
    'occurredAt', (now() - interval '2 days')::text,
    'quoteId', '${QUOTE_ID}',
    'checkoutPurpose', 'quote_deposit',
    'checkoutAttempt', 1,
    'paymentIntentId', 'pi_storyops_local_deposit_1',
    'amountCents', 13200,
    'currency', 'usd'
  ))
)
insert into public.webhook_events(
  company_id, provider, provider_event_id, event_type, payload_hash,
  status, payload, processed_at
)
select
  '${COMPANY_ID}', 'stripe', 'evt_storyops_local_deposit_1',
  'checkout.session.completed',
  encode(extensions.digest(receipt::text, 'sha256'), 'hex'),
  'processed', receipt, now() - interval '2 days'
from fixture;
update public.invoices
set status = 'draft',
    issue_date = current_date,
    due_date = current_date,
    amount_paid = 0,
    balance_due = total,
    paid_at = null
where id = '${INVOICE_ID}';
update public.jobs
set status = 'ready_to_schedule'
where id = '${JOB_ID}';
`;

const { url, anonKey } = localSupabaseEnvironment();
const customer = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const owner = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

try {
  runSql(initialSetupSql);
  await signIn(customer, 'customer@storyops.local');
  await signIn(owner, 'owner@storyops.local');

  const invalidSignatureEvent = checkoutEvent({
    eventId: 'evt_edge_payment_invalid_signature',
    checkoutId: 'cs_edge_payment_invalid_signature',
    paymentIntentId: 'pi_edge_payment_invalid_signature',
    amountCents: 13200,
    checkoutPurpose: 'quote_deposit',
  });
  const invalidSignature = await signedStripeResponse(
    url,
    JSON.stringify(invalidSignatureEvent),
    'whsec_wrong_contract_secret',
  );
  assert.equal(invalidSignature.response.status, 401, JSON.stringify(invalidSignature.body));
  assert.equal(invalidSignature.body.code, 'INVALID_SIGNATURE');

  const malformed = await signedStripeResponse(url, '{"id":');
  assert.equal(malformed.response.status, 400, JSON.stringify(malformed.body));
  assert.equal(malformed.body.code, 'INVALID_JSON');
  const rejectedIngressCount = queryJson(`
    select jsonb_build_object(
      'count', count(*)
    )
    from public.webhook_events
    where provider = 'stripe'
      and provider_event_id in (
        'evt_edge_payment_invalid_signature',
        'evt_edge_payment_malformed'
      )
  `);
  assert.equal(rejectedIngressCount.count, 0);

  const { data: initialPortal, error: initialPortalError } = await customer.rpc(
    'get_customer_portal_state',
    { p_company_id: COMPANY_ID },
  );
  assert.equal(initialPortalError, null, initialPortalError?.message);
  assert.ok(
    initialPortal.customers.some((portalCustomer) => portalCustomer.customerId === CUSTOMER_ID),
    'The signed-in portal identity lost its exact seeded customer mapping.',
  );
  // The estimating Edge canary may have published a newer quote for this same
  // customer. Deposit reconciliation remains bound to the exact accepted
  // contract, so read that version directly instead of assuming it is the
  // portal's single latest-quote card.
  const quote = queryJson(`
    select jsonb_build_object(
      'id', quote.id,
      'customerId', quote.customer_id,
      'version', quote.version,
      'status', quote.status
    )
    from public.quotes quote
    where quote.company_id = '${COMPANY_ID}'
      and quote.id = '${QUOTE_ID}'
  `);
  assert.equal(quote.id, QUOTE_ID);
  assert.equal(quote.customerId, CUSTOMER_ID);
  assert.equal(quote.status, 'accepted');

  const depositCheckout = await invokeCheckout(
    customer,
    'deposit.checkout',
    QUOTE_ID,
    quote.version,
  );
  assert.equal(
    depositCheckout.error,
    null,
    JSON.stringify(await errorPayload(depositCheckout.error)),
  );
  assert.equal(depositCheckout.data.mode, 'sandbox');
  assert.equal(depositCheckout.data.paymentVerified, false);
  assert.equal(depositCheckout.data.depositReady, false);
  await sendSignedStripeEvent(
    url,
    expiredCheckoutEvent({
      eventId: 'evt_edge_payment_deposit_expired',
      checkoutId: depositCheckout.data.checkoutId,
      amountCents: 13200,
      checkoutPurpose: 'quote_deposit',
    }),
  );
  const replacementDepositCheckout = await invokeCheckout(
    customer,
    'deposit.checkout',
    QUOTE_ID,
    quote.version,
  );
  assert.equal(
    replacementDepositCheckout.error,
    null,
    JSON.stringify(await errorPayload(replacementDepositCheckout.error)),
  );
  assert.notEqual(
    replacementDepositCheckout.data.checkoutId,
    depositCheckout.data.checkoutId,
    'A signed-expired deposit session reused its retired provider identity.',
  );
  const depositCompletionEvent = checkoutEvent({
    eventId: 'evt_edge_payment_deposit_checkout',
    checkoutId: replacementDepositCheckout.data.checkoutId,
    paymentIntentId: 'pi_edge_payment_deposit',
    amountCents: 13200,
    checkoutPurpose: 'quote_deposit',
    checkoutAttempt: 2,
  });
  await sendSignedStripeEvent(url, depositCompletionEvent);
  const duplicateDeposit = await sendSignedStripeEvent(url, depositCompletionEvent);
  assert.equal(duplicateDeposit.duplicate, true);
  const changedReplay = structuredClone(depositCompletionEvent);
  changedReplay.data.object.amount_total = 13100;
  const replayConflict = await signedStripeResponse(url, JSON.stringify(changedReplay));
  assert.equal(replayConflict.response.status, 409, JSON.stringify(replayConflict.body));
  assert.equal(replayConflict.body.code, 'WEBHOOK_REPLAY_CONFLICT');
  const depositTruth = queryJson(`
    select jsonb_build_object(
      'checkoutId', payment.provider_checkout_id,
      'paymentId', payment.provider_payment_id,
      'amount', payment.provider_amount_received,
      'allocation', payment.allocation_status,
      'checkoutAttempt', payment.checkout_attempt,
      'paymentStatus', payment.status,
      'jobStatus', job.status,
      'retirementCount', (
        select count(*)
        from public.payment_checkout_retirements retirement
        where retirement.payment_id = payment.id
      )
    )
    from public.payments payment
    join public.jobs job on job.id = '${JOB_ID}'
    where payment.id = '${DEPOSIT_PAYMENT_ID}'
  `);
  assert.deepEqual(depositTruth, {
    checkoutId: replacementDepositCheckout.data.checkoutId,
    paymentId: 'pi_edge_payment_deposit',
    amount: 132.0,
    allocation: 'applied',
    checkoutAttempt: 2,
    paymentStatus: 'succeeded',
    jobStatus: 'ready_to_schedule',
    retirementCount: 1,
  });

  runSql(`
    update public.invoices
    set status = 'open',
        issue_date = current_date,
        due_date = current_date,
        amount_paid = 132.00,
        balance_due = 396.00,
        paid_at = null
    where id = '${INVOICE_ID}';
  `);
  const exactInvoice = (await portalInvoice(customer)).invoice;
  const invoiceCheckout = await invokeCheckout(
    customer,
    'invoice.checkout',
    INVOICE_ID,
    exactInvoice.version,
  );
  assert.equal(
    invoiceCheckout.error,
    null,
    JSON.stringify(await errorPayload(invoiceCheckout.error)),
  );
  assert.equal(invoiceCheckout.data.invoicePaid, false);
  await sendSignedStripeEvent(
    url,
    expiredCheckoutEvent({
      eventId: 'evt_edge_payment_invoice_expired',
      checkoutId: invoiceCheckout.data.checkoutId,
      amountCents: 39600,
      checkoutPurpose: 'invoice_balance',
      invoiceVersion: exactInvoice.version,
    }),
  );
  const replacementInvoiceCheckout = await invokeCheckout(
    customer,
    'invoice.checkout',
    INVOICE_ID,
    exactInvoice.version,
  );
  assert.equal(
    replacementInvoiceCheckout.error,
    null,
    JSON.stringify(await errorPayload(replacementInvoiceCheckout.error)),
  );
  assert.notEqual(
    replacementInvoiceCheckout.data.checkoutId,
    invoiceCheckout.data.checkoutId,
    'A signed-expired invoice session reused its retired provider identity.',
  );
  const exactPi = 'pi_edge_payment_invoice';
  await sendSignedStripeEvent(
    url,
    checkoutEvent({
      eventId: 'evt_edge_payment_invoice_checkout',
      checkoutId: replacementInvoiceCheckout.data.checkoutId,
      paymentIntentId: exactPi,
      amountCents: 39600,
      checkoutPurpose: 'invoice_balance',
      invoiceVersion: exactInvoice.version,
      checkoutAttempt: 2,
    }),
  );
  await sendSignedStripeEvent(
    url,
    paymentIntentEvent({
      eventId: 'evt_edge_payment_invoice_intent',
      paymentIntentId: exactPi,
      amountCents: 39600,
      invoiceVersion: exactInvoice.version,
      checkoutAttempt: 2,
    }),
  );
  const paidTruth = queryJson(`
    select jsonb_build_object(
      'status', invoice.status,
      'amountPaid', invoice.amount_paid,
      'balanceDue', invoice.balance_due,
      'paymentCount', (
        select count(*)
        from public.payments payment
        where payment.invoice_id = invoice.id
          and payment.payment_type = 'invoice'
      ),
      'retirementCount', (
        select count(*)
        from public.payment_checkout_retirements retirement
        where retirement.invoice_id = invoice.id
          and retirement.provider_checkout_id =
            '${invoiceCheckout.data.checkoutId}'
      )
    )
    from public.invoices invoice
    where invoice.id = '${INVOICE_ID}'
  `);
  assert.deepEqual(paidTruth, {
    status: 'paid',
    amountPaid: 528.0,
    balanceDue: 0.0,
    paymentCount: 1,
    retirementCount: 1,
  });

  runSql(`
    delete from public.payment_checkout_retirements
    where company_id = '${COMPANY_ID}'
      and invoice_id = '${INVOICE_ID}'
      and payment_id in (
        select payment.id
        from public.payments payment
        where payment.company_id = '${COMPANY_ID}'
          and payment.invoice_id = '${INVOICE_ID}'
          and payment.payment_type = 'invoice'
      );
    delete from public.payments
    where company_id = '${COMPANY_ID}'
      and invoice_id = '${INVOICE_ID}'
      and payment_type = 'invoice';
    delete from public.idempotency_keys
    where company_id = '${COMPANY_ID}'
      and scope = 'invoice-checkout-v1';
    update public.invoices
    set status = 'open',
        amount_paid = 132.00,
        balance_due = 396.00,
        paid_at = null
    where id = '${INVOICE_ID}';
  `);
  const staleInvoice = (await portalInvoice(customer)).invoice;
  const staleCheckout = await invokeCheckout(
    customer,
    'invoice.checkout',
    INVOICE_ID,
    staleInvoice.version,
  );
  assert.equal(staleCheckout.error, null, JSON.stringify(await errorPayload(staleCheckout.error)));
  runSql(`
    update public.invoices
    set due_date = due_date + 1
    where id = '${INVOICE_ID}';
  `);
  await sendSignedStripeEvent(
    url,
    checkoutEvent({
      eventId: 'evt_edge_payment_invoice_stale',
      checkoutId: staleCheckout.data.checkoutId,
      paymentIntentId: 'pi_edge_payment_invoice_stale',
      amountCents: 39600,
      checkoutPurpose: 'invoice_balance',
      invoiceVersion: staleInvoice.version,
    }),
  );

  const staleTruth = queryJson(`
    select jsonb_build_object(
      'invoiceStatus', invoice.status,
      'amountPaid', invoice.amount_paid,
      'balanceDue', invoice.balance_due,
      'paymentStatus', payment.status,
      'allocation', payment.allocation_status,
      'conflictCode', conflict.conflict_code,
      'conflictStatus', conflict.status,
      'approvalStatus', approval.status,
      'approvalRisk', approval.risk_level
    )
    from public.invoices invoice
    join public.payments payment
      on payment.invoice_id = invoice.id
     and payment.payment_type = 'invoice'
    join public.payment_allocation_conflicts conflict
      on conflict.payment_id = payment.id
     and conflict.status = 'open'
    join public.approval_requests approval
      on approval.id = conflict.approval_request_id
    where invoice.id = '${INVOICE_ID}'
  `);
  assert.deepEqual(staleTruth, {
    invoiceStatus: 'open',
    amountPaid: 132.0,
    balanceDue: 396.0,
    paymentStatus: 'succeeded',
    allocation: 'unapplied',
    conflictCode: 'stale_invoice_version',
    conflictStatus: 'open',
    approvalStatus: 'pending',
    approvalRisk: 'high',
  });

  const heldPortal = await portalInvoice(customer);
  assert.equal(heldPortal.invoice.paymentReconciliationRequired, true);
  assert.match(heldPortal.invoice.paymentReconciliationMessage, /not charged twice/iu);
  const heldCheckout = await invokeCheckout(
    customer,
    'invoice.checkout',
    INVOICE_ID,
    heldPortal.invoice.version,
  );
  assert.ok(heldCheckout.error, 'Payment hold unexpectedly allowed another Checkout Session.');
  assert.equal((await errorPayload(heldCheckout.error))?.code, 'PAYMENT_RECONCILIATION_REQUIRED');

  const { data: ownerWorkspace, error: ownerWorkspaceError } = await owner.rpc(
    'get_storyops_workspace',
    { p_company_id: COMPANY_ID },
  );
  assert.equal(ownerWorkspaceError, null, ownerWorkspaceError?.message);
  const ownerConflict = ownerWorkspace.paymentAllocationConflicts.find(
    (conflict) => conflict.invoiceId === INVOICE_ID,
  );
  assert.equal(ownerConflict.conflictCode, 'stale_invoice_version');
  assert.equal(ownerConflict.status, 'open');
  assert.ok(ownerConflict.approvalRequestId);
} finally {
  runSql(cleanupSql);
}

process.stdout.write(
  'Signed Stripe checkout/payment reconciliation passed: signature/JSON rejection, duplicate and replay-conflict safety, exact deposit and invoice allocation, PI replay, stale-version quarantine, approval, and customer collection hold.\n',
);
