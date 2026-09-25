import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { supabaseCommand } from '../../infra/scripts/common.mjs';

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const OWNER_ID = '10000000-0000-4000-8000-000000000101';
const CUSTOMER_ID = '10000000-0000-4000-8000-000000000201';
const PROPERTY_ID = '10000000-0000-4000-8000-000000000211';
const ESTIMATE_ID = '10000000-0000-4000-8000-000000000501';
const VISIT_ID = '10000000-0000-4000-8000-000000000641';
const QUOTE_ID = '99000000-0000-4000-8000-000000000101';
const QUOTE_COMMAND_ID = '99000000-0000-4000-8000-000000000102';
const VISIT_COMMAND_ID = '99000000-0000-4000-8000-000000000103';
const WORKER_TOKEN = 'storyops-local-transactional-worker-token-v1-4c82';

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

function requestHash(action, entityId, entityVersion, channel) {
  return createHash('sha256')
    .update(`${action}|${entityId}|${entityVersion}|${channel}`)
    .digest('hex');
}

async function versionFromWorkspace(client, collection, entityId) {
  const { data, error } = await client.rpc('get_storyops_workspace', {
    p_company_id: COMPANY_ID,
  });
  assert.equal(error, null, `Workspace load failed for ${collection}.`);
  const record = data[collection].find((item) => item.id === entityId);
  assert.ok(record && Number.isInteger(record.version), `${collection} version is unavailable.`);
  return record.version;
}

async function queueDelivery(client, input) {
  const hash = requestHash(input.action, input.entityId, input.version, 'sms');
  const { data, error } = await client.rpc('queue_storyops_transactional_delivery', {
    p_company_id: COMPANY_ID,
    p_command_id: input.commandId,
    p_action_type: input.action,
    p_entity_id: input.entityId,
    p_expected_version: input.version,
    p_channel: 'sms',
    p_request_hash: hash,
  });
  assert.equal(error, null, `${input.action} could not be queued.`);
  assert.equal(data.status, 'queued');
  assert.equal(data.providerSubmissionAsserted, false);
  assert.equal(data.externalDeliveryClaimed, false);
  return data;
}

async function invokeWorker(url, token, body) {
  return fetch(`${url}/functions/v1/transactional-outbound-worker`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function integrationHealth(client) {
  const { data, error } = await client.functions.invoke('integration-health', {
    body: { companyId: COMPANY_ID },
  });
  assert.equal(error, null, 'Integration health invocation failed.');
  return data.outboundWorkers;
}

const setupSql = `
delete from public.transactional_delivery_attempts
where command_id in ('${QUOTE_COMMAND_ID}', '${VISIT_COMMAND_ID}');
delete from public.idempotency_keys
where company_id = '${COMPANY_ID}'
  and scope = 'transactional-delivery-v1'
  and key in ('${QUOTE_COMMAND_ID}', '${VISIT_COMMAND_ID}');
delete from public.quotes where id = '${QUOTE_ID}';

insert into public.quotes(
  id, company_id, quote_number, estimate_id, customer_id, property_id, status,
  valid_until, terms_version, terms_snapshot, total, deposit_required,
  sent_at, portal_published_at
)
values (
  '${QUOTE_ID}', '${COMPANY_ID}', 'Q-OUTBOUND-EDGE', '${ESTIMATE_ID}',
  '${CUSTOMER_ID}', '${PROPERTY_ID}', 'sent', current_date + 14, 'terms-v1',
  'Sandbox transactional outbound Edge canary.', 528.00, 132.00, now(), now()
);

alter table public.visits disable trigger visits_dispatch_clearance_guard;
update public.visits
set status = 'en_route',
    starts_at = now() + interval '30 minutes',
    ends_at = now() + interval '4 hours'
where id = '${VISIT_ID}';
alter table public.visits enable trigger visits_dispatch_clearance_guard;
`;

const cleanupSql = `
delete from public.transactional_delivery_attempts
where command_id in ('${QUOTE_COMMAND_ID}', '${VISIT_COMMAND_ID}');
delete from public.communication_messages message
using public.communication_threads thread
where message.thread_id = thread.id
  and thread.company_id = '${COMPANY_ID}'
  and message.sent_by_user_id = '${OWNER_ID}'
  and thread.subject in (
    'Quote Q-OUTBOUND-EDGE is ready',
    'Your WashOps crew is on the way'
  );
delete from public.communication_threads
where company_id = '${COMPANY_ID}'
  and assigned_user_id = '${OWNER_ID}'
  and subject in (
    'Quote Q-OUTBOUND-EDGE is ready',
    'Your WashOps crew is on the way'
  )
  and not exists (
    select 1 from public.communication_messages message
    where message.thread_id = communication_threads.id
  );
delete from public.idempotency_keys
where company_id = '${COMPANY_ID}'
  and scope = 'transactional-delivery-v1'
  and key in ('${QUOTE_COMMAND_ID}', '${VISIT_COMMAND_ID}');
delete from public.quotes where id = '${QUOTE_ID}';
alter table public.visits disable trigger visits_dispatch_clearance_guard;
update public.visits
set status = 'planned',
    starts_at = date_trunc('day', now() + interval '2 days') + interval '9 hours',
    ends_at = date_trunc('day', now() + interval '2 days') + interval '13 hours 30 minutes'
where id = '${VISIT_ID}';
alter table public.visits enable trigger visits_dispatch_clearance_guard;
`;

const { url, anonKey, serviceRoleKey } = localSupabaseEnvironment();
const client = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

try {
  runSql(setupSql);
  const { error: authError } = await client.auth.signInWithPassword({
    email: 'owner@storyops.local',
    password: 'WashOpsDemo1!',
  });
  assert.equal(authError, null, 'Owner sign-in failed.');

  const quoteVersion = await versionFromWorkspace(client, 'quotes', QUOTE_ID);
  const visitVersion = await versionFromWorkspace(client, 'visits', VISIT_ID);
  await queueDelivery(client, {
    action: 'quote.delivery',
    entityId: QUOTE_ID,
    version: quoteVersion,
    commandId: QUOTE_COMMAND_ID,
  });
  await queueDelivery(client, {
    action: 'visit.on_my_way',
    entityId: VISIT_ID,
    version: visitVersion,
    commandId: VISIT_COMMAND_ID,
  });

  const before = await integrationHealth(client);
  assert.equal(before.status, 'blocked');
  assert.equal(before.liveReady, false);
  const transactionalBefore = before.workers.find(
    (worker) => worker.worker === 'transactional_outbound',
  );
  assert.equal(transactionalBefore.status, 'blocked');
  assert.equal(transactionalBefore.liveReady, false);
  assert.equal(transactionalBefore.configurationEnabled, true);
  assert.equal(transactionalBefore.activationMode, 'manual');
  assert.equal(transactionalBefore.credentialStatus, 'valid');
  assert.equal(transactionalBefore.deploymentIdentityStatus, 'missing');
  assert.ok(
    transactionalBefore.blockers.includes('WORKER_DEPLOYMENT_IDENTITY_MISSING') &&
      transactionalBefore.blockers.includes('WORKER_SCHEDULE_REQUIRED') &&
      transactionalBefore.blockers.includes('WORKER_HEARTBEAT_MISSING'),
  );
  assert.equal(transactionalBefore.queue.availability, 'verified');
  assert.equal(transactionalBefore.queue.backlogCount, 2);
  assert.equal(transactionalBefore.queue.actionCounts.quoteDelivery, 1);
  assert.equal(transactionalBefore.queue.actionCounts.onMyWay, 1);
  assert.equal(transactionalBefore.queue.submissionUnknownCount, 0);

  const rejected = await invokeWorker(url, serviceRoleKey, {
    companyId: COMPANY_ID,
    trigger: 'manual',
    batchSize: 1,
    leaseSeconds: 90,
  });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).code, 'WORKER_UNAUTHENTICATED');

  const response = await invokeWorker(url, WORKER_TOKEN, {
    companyId: COMPANY_ID,
    trigger: 'manual',
    workerId: '99000000-0000-4000-8000-000000000104',
    batchSize: 25,
    leaseSeconds: 90,
  });
  assert.equal(response.status, 200);
  const run = await response.json();
  assert.equal(run.schemaVersion, 'storyops-transactional-worker-run-v2');
  assert.equal(run.activationMode, 'manual');
  assert.equal(run.trigger, 'manual');
  assert.equal(run.status, 'processed');
  assert.equal(run.claimed, 2);
  assert.equal(run.counts.sandboxed, 2);
  assert.ok(
    run.results.every(
      (result) =>
        result.status === 'sandboxed' &&
        result.providerMode === 'sandbox' &&
        result.providerStatus === 'sandbox_recorded' &&
        result.externalDeliveryClaimed === false,
    ),
  );

  const emptyResponse = await invokeWorker(url, WORKER_TOKEN, {
    companyId: COMPANY_ID,
    trigger: 'manual',
    batchSize: 25,
    leaseSeconds: 90,
  });
  assert.equal(emptyResponse.status, 200);
  const emptyRun = await emptyResponse.json();
  assert.equal(emptyRun.claimed, 0);
  assert.equal(emptyRun.empty, true);

  const after = await integrationHealth(client);
  const transactionalAfter = after.workers.find(
    (worker) => worker.worker === 'transactional_outbound',
  );
  assert.equal(after.status, 'blocked');
  assert.equal(after.liveReady, false);
  assert.equal(transactionalAfter.status, 'blocked');
  assert.equal(transactionalAfter.liveReady, false);
  assert.equal(transactionalAfter.heartbeat.status, 'failed');
  assert.ok(
    transactionalAfter.blockers.includes('WORKER_DEPLOYMENT_IDENTITY_MISSING') &&
      transactionalAfter.blockers.includes('WORKER_SCHEDULE_REQUIRED') &&
      transactionalAfter.blockers.includes('WORKER_HEARTBEAT_FAILED'),
  );
  assert.equal(transactionalAfter.queue.availability, 'verified');
  assert.equal(transactionalAfter.queue.backlogCount, 0);
  assert.equal(transactionalAfter.queue.submissionUnknownCount, 0);

  const { data: attempts, error: attemptsError } = await client
    .from('transactional_delivery_attempts')
    .select('status,provider_mode,provider_status')
    .in('command_id', [QUOTE_COMMAND_ID, VISIT_COMMAND_ID]);
  assert.equal(attemptsError, null);
  assert.equal(attempts.length, 2);
  assert.ok(
    attempts.every(
      (attempt) =>
        attempt.status === 'sandboxed' &&
        attempt.provider_mode === 'sandbox' &&
        attempt.provider_status === 'sandbox_recorded',
    ),
  );

  process.stdout.write(
    'Transactional outbound Edge canary passed: dedicated credential, quote/on-my-way queue visibility, sandbox processing, empty replay, and no submission uncertainty.\n',
  );
} finally {
  await client.auth.signOut();
  runSql(cleanupSql);
}
