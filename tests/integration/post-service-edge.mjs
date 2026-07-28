import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { supabaseCommand } from '../../infra/scripts/common.mjs';

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const INVOICE_ID = '10000000-0000-4000-8000-000000000651';
const JOB_ID = '10000000-0000-4000-8000-000000000631';
const VISIT_ID = '10000000-0000-4000-8000-000000000641';
const COMMANDS = {
  review: '99000000-0000-4000-8000-000000000001',
  reviewDuplicate: '99000000-0000-4000-8000-000000000002',
  noConsent: '99000000-0000-4000-8000-000000000003',
  referral: '99000000-0000-4000-8000-000000000004',
  maintenance: '99000000-0000-4000-8000-000000000005',
  technician: '99000000-0000-4000-8000-000000000006',
  tenant: '99000000-0000-4000-8000-000000000007',
  unpaid: '99000000-0000-4000-8000-000000000008',
};

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
  const serviceRoleKey = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY;
  assert.ok(
    url && anonKey && serviceRoleKey,
    'Local Supabase API URL, public key, and service-role key are required.',
  );
  return { url, anonKey, serviceRoleKey };
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

async function signIn(client, email) {
  const { error } = await client.auth.signInWithPassword({
    email,
    password: 'StoryOpsDemo1!',
  });
  assert.equal(error, null, `Unable to sign in ${email}.`);
}

async function invoiceVersion(client) {
  const { data, error } = await client.rpc('get_storyops_workspace', {
    p_company_id: COMPANY_ID,
  });
  assert.equal(error, null, 'Workspace load failed.');
  const invoice = data.invoices.find((item) => item.id === INVOICE_ID);
  assert.ok(
    invoice && Number.isInteger(invoice.version),
    'Fixture invoice version is unavailable.',
  );
  return invoice.version;
}

async function invoke(client, body) {
  return client.functions.invoke('post-service', { body });
}

async function errorReceipt(result, expectedCode) {
  assert.ok(result.error, `Expected ${expectedCode} but invocation succeeded.`);
  const response = result.error.context;
  assert.ok(response instanceof Response, `Expected an HTTP error response for ${expectedCode}.`);
  const payload = await response.clone().json();
  assert.equal(payload.code, expectedCode);
  return payload;
}

const setupSql = `
delete from public.post_service_followups
where company_id = '${COMPANY_ID}';
delete from public.communication_messages
where company_id = '${COMPANY_ID}'
  and sent_by_agent = 'post-service-worker-v1';
delete from public.communication_threads
where company_id = '${COMPANY_ID}'
  and subject in ('How did we do?', 'Thank you for choosing us', 'Maintenance reminder');
delete from public.referrals
where company_id = '${COMPANY_ID}' and source_invoice_id = '${INVOICE_ID}';
delete from public.recurring_maintenance_plans
where company_id = '${COMPANY_ID}' and source_invoice_id = '${INVOICE_ID}';
delete from public.idempotency_keys
where company_id = '${COMPANY_ID}' and scope = 'post-service-action-v1';
delete from public.webhook_events
where provider = 'stripe' and provider_event_id = 'evt_post_service_edge_paid';

update public.visits set status = 'completed' where id = '${VISIT_ID}';
update public.jobs set status = 'invoiced' where id = '${JOB_ID}';
update public.invoices
set status = 'paid',
    provider_invoice_id = 'in_post_service_edge_fixture',
    amount_paid = total,
    balance_due = 0,
    paid_at = now()
where id = '${INVOICE_ID}';
update public.consent_records
set status = 'unknown',
    withdrawn_at = null
where id = '10000000-0000-4000-8000-000000000233';

with fixture(receipt) as (
  values (jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'stripe',
    'eventId', 'evt_post_service_edge_paid',
    'eventType', 'invoice.paid',
    'objectId', 'in_post_service_edge_fixture',
    'objectKind', 'invoice',
    'action', 'invoice_paid',
    'companyId', '${COMPANY_ID}',
    'occurredAt', now()::text,
    'jobId', '${JOB_ID}',
    'amountCents', 52800,
    'amountPaidCents', 52800,
    'amountRemainingCents', 0,
    'currency', 'usd'
  ))
)
insert into public.webhook_events(
  company_id, provider, provider_event_id, event_type, payload_hash,
  status, payload, processed_at
)
select
  '${COMPANY_ID}', 'stripe', 'evt_post_service_edge_paid', 'invoice.paid',
  encode(extensions.digest(receipt::text, 'sha256'), 'hex'),
  'processed', receipt, now()
from fixture;
`;

const cleanupSql = `
delete from public.post_service_followups
where company_id = '${COMPANY_ID}';
delete from public.communication_messages
where company_id = '${COMPANY_ID}'
  and sent_by_agent = 'post-service-worker-v1';
delete from public.communication_threads
where company_id = '${COMPANY_ID}'
  and subject in ('How did we do?', 'Thank you for choosing us', 'Maintenance reminder');
delete from public.referrals
where company_id = '${COMPANY_ID}' and source_invoice_id = '${INVOICE_ID}';
delete from public.recurring_maintenance_plans
where company_id = '${COMPANY_ID}' and source_invoice_id = '${INVOICE_ID}';
delete from public.idempotency_keys
where company_id = '${COMPANY_ID}' and scope = 'post-service-action-v1';
delete from public.webhook_events
where provider = 'stripe' and provider_event_id = 'evt_post_service_edge_paid';
update public.invoices
set status = 'draft',
    provider_invoice_id = null,
    amount_paid = 0,
    balance_due = total,
    paid_at = null
where id = '${INVOICE_ID}';
update public.visits set status = 'confirmed' where id = '${VISIT_ID}';
update public.jobs set status = 'scheduled' where id = '${JOB_ID}';
update public.companies set timezone = 'America/Chicago' where id = '${COMPANY_ID}';
update public.consent_records
set status = 'granted',
    withdrawn_at = null
where id = '10000000-0000-4000-8000-000000000233';
`;

const { url, anonKey, serviceRoleKey } = localSupabaseEnvironment();
const client = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

try {
  await signIn(client, 'owner@storyops.local');
  const unpaidVersion = await invoiceVersion(client);
  await errorReceipt(
    await invoke(client, {
      companyId: COMPANY_ID,
      action: 'review.request',
      commandId: COMMANDS.unpaid,
      invoiceId: INVOICE_ID,
      expectedVersion: unpaidVersion,
      channel: 'email',
    }),
    'PAID_INVOICE_REQUIRED',
  );

  runSql(setupSql);
  const paidVersion = await invoiceVersion(client);

  await errorReceipt(
    await invoke(client, {
      companyId: COMPANY_ID,
      action: 'review.request',
      commandId: COMMANDS.noConsent,
      invoiceId: INVOICE_ID,
      expectedVersion: paidVersion,
      channel: 'sms',
    }),
    'CONSENT_REQUIRED',
  );
  runSql(`
update public.consent_records
set status = 'granted',
    withdrawn_at = null
where id = '10000000-0000-4000-8000-000000000233';
`);

  const reviewBody = {
    companyId: COMPANY_ID,
    action: 'review.request',
    commandId: COMMANDS.review,
    invoiceId: INVOICE_ID,
    expectedVersion: paidVersion,
    channel: 'email',
  };
  const review = await invoke(client, reviewBody);
  assert.equal(review.error, null);
  assert.equal(review.data.status, 'queued');
  assert.equal(review.data.replayed, false);
  assert.equal(review.data.alreadyExisted, false);
  assert.equal(review.data.domainRecordId, review.data.recordId);
  assert.equal('providerMessageId' in review.data, false);

  const replay = await invoke(client, reviewBody);
  assert.equal(replay.error, null);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.recordId, review.data.recordId);

  await errorReceipt(
    await invoke(client, {
      ...reviewBody,
      action: 'referral.invite',
    }),
    'IDEMPOTENCY_CONFLICT',
  );

  const reviewDuplicate = await invoke(client, {
    ...reviewBody,
    commandId: COMMANDS.reviewDuplicate,
  });
  assert.equal(reviewDuplicate.error, null);
  assert.equal(reviewDuplicate.data.alreadyExisted, true);
  assert.equal(reviewDuplicate.data.recordId, review.data.recordId);

  await errorReceipt(
    await invoke(client, {
      ...reviewBody,
      companyId: '99000000-0000-4000-8000-000000000099',
      commandId: COMMANDS.tenant,
    }),
    'FORBIDDEN',
  );

  await client.auth.signOut();
  await signIn(client, 'customer@storyops.local');
  const referral = await invoke(client, {
    companyId: COMPANY_ID,
    action: 'referral.invite',
    commandId: COMMANDS.referral,
    invoiceId: INVOICE_ID,
    expectedVersion: paidVersion,
    channel: 'email',
  });
  assert.equal(referral.error, null);
  assert.equal(referral.data.status, 'queued');
  assert.notEqual(referral.data.domainRecordId, referral.data.recordId);

  const nextDueDate = new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10);
  const maintenance = await invoke(client, {
    companyId: COMPANY_ID,
    action: 'maintenance.activate',
    commandId: COMMANDS.maintenance,
    invoiceId: INVOICE_ID,
    expectedVersion: paidVersion,
    cadence: 'semiannual',
    nextDueDate,
  });
  assert.equal(maintenance.error, null);
  assert.equal(maintenance.data.status, 'active');
  assert.equal(maintenance.data.requiresFreshEstimate, true);

  const { data: status, error: statusError } = await client.rpc(
    'get_storyops_post_service_status',
    { p_company_id: COMPANY_ID },
  );
  assert.equal(statusError, null);
  assert.equal(status.followups.length, 2);
  assert.equal(status.maintenancePlans.length, 1);
  assert.ok(
    status.followups.some(
      (item) =>
        item.action === 'referral.invite' && item.domainRecordId === referral.data.domainRecordId,
    ),
  );

  runSql(`
update public.companies
set timezone = 'Pacific/Honolulu'
where id = '${COMPANY_ID}';
update public.post_service_followups
set scheduled_at = now(), next_attempt_at = now()
where company_id = '${COMPANY_ID}'
  and action_type in ('review_request', 'referral_invite');
`);
  const workerResponse = await fetch(`${url}/functions/v1/post-service-worker`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      workerId: '99000000-0000-4000-8000-000000000020',
      batchSize: 10,
      leaseSeconds: 90,
    }),
  });
  assert.equal(workerResponse.status, 200);
  const worker = await workerResponse.json();
  assert.equal(worker.claimed, 2);
  assert.equal(worker.counts.sandboxed, 2);
  assert.ok(
    worker.results.every(
      (item) =>
        item.status === 'sandboxed' &&
        item.providerMode === 'sandbox' &&
        item.providerStatus === 'sandbox_recorded' &&
        item.externalDeliveryClaimed === false,
    ),
  );

  const emptyWorkerResponse = await fetch(`${url}/functions/v1/post-service-worker`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ batchSize: 10 }),
  });
  assert.equal(emptyWorkerResponse.status, 200);
  const emptyWorker = await emptyWorkerResponse.json();
  assert.equal(emptyWorker.empty, true);
  assert.equal(emptyWorker.claimed, 0);

  const { data: workerStatus, error: workerStatusError } = await client.rpc(
    'get_storyops_post_service_status',
    { p_company_id: COMPANY_ID },
  );
  assert.equal(workerStatusError, null);
  assert.ok(
    workerStatus.followups.every(
      (item) =>
        item.status === 'sandboxed' &&
        item.providerMode === 'sandbox' &&
        item.providerStatus === 'sandbox_recorded' &&
        item.externalDeliveryClaimed === false,
    ),
  );

  await client.auth.signOut();
  await signIn(client, 'technician@storyops.local');
  await errorReceipt(
    await invoke(client, {
      companyId: COMPANY_ID,
      action: 'review.request',
      commandId: COMMANDS.technician,
      invoiceId: INVOICE_ID,
      expectedVersion: paidVersion,
      channel: 'email',
    }),
    'FORBIDDEN',
  );

  process.stdout.write(
    'Post-service Edge integration passed: payment, consent, tenant, role, replay, conflict, dedupe, referral linkage, maintenance, sandbox worker delivery labeling, and customer projection.\n',
  );
} finally {
  await client.auth.signOut();
  runSql(cleanupSql);
}
