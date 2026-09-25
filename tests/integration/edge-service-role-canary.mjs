import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseCommand } from '../../infra/scripts/common.mjs';

const companyId = '10000000-0000-4000-8000-000000000001';
const ownerId = '10000000-0000-4000-8000-000000000101';
const propertyId = '10000000-0000-4000-8000-000000000211';
const jobId = '10000000-0000-4000-8000-000000000631';

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

async function functionErrorPayload(error) {
  try {
    return await error?.context?.clone().json();
  } catch {
    return undefined;
  }
}

const { url, anonKey } = localSupabaseEnvironment();
const client = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const { error: authError } = await client.auth.signInWithPassword({
  email: 'owner@storyops.local',
  password: 'WashOpsDemo1!',
});
assert.equal(authError, null, authError?.message);

const runId = randomUUID();
const requestedAt = new Date().toISOString();
const { data: office, error: officeError } = await client.functions.invoke('ai-office', {
  body: {
    runId,
    companyId,
    agent: 'owner_briefing',
    objective:
      'Produce a read-only owner briefing from current server-resolved company facts. Preserve every unknown and do not add side effects.',
    actor: { id: ownerId, role: 'owner' },
    trustedFacts: [],
    untrustedContent: [],
    idempotencyKey: `ai-office:manual:${runId}`,
    requestedAt,
  },
});
assert.equal(officeError, null, JSON.stringify(await functionErrorPayload(officeError)));
assert.equal(office.companyId, companyId);
assert.equal(office.actorUserId, ownerId);
assert.equal(office.run.agent, 'owner_briefing');
assert.equal(office.run.modelMode, 'sandbox');
assert.equal(office.run.durableStatus, 'succeeded');
assert.equal(office.run.schedulerConfigured, false);

const { data: health, error: healthError } = await client.functions.invoke('integration-health', {
  body: { companyId },
});
assert.equal(healthError, null, JSON.stringify(await functionErrorPayload(healthError)));
assert.ok(health && typeof health === 'object', 'Integration health returned no projection.');
assert.equal(health.dispatchOriginRetention?.availability, 'verified');
assert.equal(health.dispatchOriginRetention?.p0ReleaseCheck, 'passed');
assert.equal(health.dispatchOriginRetention?.scheduleActive, true);
assert.equal(health.dispatchOriginRetention?.scheduleSeconds, 5);
assert.equal(health.dispatchOriginRetention?.schedulerExecutionVerified, true);
assert.equal(health.dispatchOriginRetention?.schedulerLastRunStatus, 'succeeded');
assert.equal(health.dispatchOriginRetention?.coordinateStaleCount, 0);
assert.equal(health.dispatchOriginRetention?.verifierStaleCount, 0);
assert.equal(health.dispatchOriginRetention?.cronHistoryStaleCount, 0);
assert.equal(health.dispatchOriginRetention?.cronHistoryRetentionHours, 24);

const assetId = randomUUID();
const objectId = randomUUID();
const commandId = randomUUID();
const objectPath = `${companyId}/edge-acl/${assetId}-before.jpg`;
let fixtureCreated = false;
try {
  runSql(`
  begin;
  insert into storage.objects(id, bucket_id, name, owner, metadata)
  values (
    '${objectId}', 'job-media', '${objectPath}', '${ownerId}',
    '{"size":128,"mimetype":"image/jpeg"}'::jsonb
  );
  grant insert on public.media_assets to service_role;
  set local role service_role;
  select set_config('request.jwt.claim.role', 'service_role', true);
  select set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select public.attest_storyops_media_upload(
    '${companyId}',
    '${commandId}',
    '${ownerId}',
    '${assetId}',
    '${objectPath}',
    '${'b'.repeat(64)}',
    128,
    'image/jpeg'
  );
  insert into public.media_assets(
    id, company_id, property_id, purpose, object_path, content_type, byte_size,
    checksum_sha256, captured_at, captured_by, offline_client_id, sync_state,
    retention_class, retain_until
  )
  values (
    '${assetId}', '${companyId}', '${propertyId}', 'before', '${objectPath}',
    'image/jpeg', 128, '${'b'.repeat(64)}', now(), '${ownerId}', '${commandId}',
    'synced', 'operational', now() + interval '30 days'
  );
  reset role;
  revoke insert on public.media_assets from service_role;
  commit;
`);
  fixtureCreated = true;
  const { data: photo, error: photoError } = await client.functions.invoke('photo-analyze', {
    body: {
      companyId,
      propertyId,
      assetId,
      purpose: 'before',
      idempotencyKey: `photo-canary:${randomUUID()}`,
    },
  });
  assert.equal(photoError, null, JSON.stringify(await functionErrorPayload(photoError)));
  assert.equal(photo.mode, 'sandbox');
  assert.equal(photo.analysis.sourceAssetId, assetId);
  assert.match(photo.analysisId, /^[0-9a-f-]{36}$/u);

  const missingApprovalId = randomUUID();
  const denied = await client.functions.invoke('ai-approved-action', {
    body: {
      companyId,
      approvalId: missingApprovalId,
      idempotencyKey: `approved-action-canary:${randomUUID()}`,
    },
  });
  assert.ok(denied.error, 'A nonexistent approval unexpectedly executed.');
  const deniedPayload = await functionErrorPayload(denied.error);
  assert.equal(deniedPayload?.code, 'APPROVAL_NOT_FOUND');

  const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1_000);
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1_000);
  const { data: scheduling, error: schedulingError } = await client.functions.invoke(
    'scheduling-evidence',
    {
      body: {
        companyId,
        jobId,
        expectedJobVersion: 1,
        window: { start: startsAt.toISOString(), end: endsAt.toISOString() },
        idempotencyKey: `scheduling-canary:${randomUUID()}`,
      },
    },
  );
  assert.equal(schedulingError, null, JSON.stringify(await functionErrorPayload(schedulingError)));
  assert.equal(scheduling.status, 'not_bookable');
  assert.equal(scheduling.bookable, false);
  assert.equal(scheduling.mode, 'sandbox');
  assert.equal(scheduling.reasonCode, 'LIVE_SCHEDULING_DISABLED');

  const technicianClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error: technicianAuthError } = await technicianClient.auth.signInWithPassword({
    email: 'technician@storyops.local',
    password: 'WashOpsDemo1!',
  });
  assert.equal(technicianAuthError, null, technicianAuthError?.message);
  const forbiddenScheduling = await technicianClient.functions.invoke('scheduling-evidence', {
    body: {
      companyId,
      jobId,
      expectedJobVersion: 1,
      window: { start: startsAt.toISOString(), end: endsAt.toISOString() },
      idempotencyKey: `scheduling-canary:${randomUUID()}`,
    },
  });
  assert.ok(forbiddenScheduling.error, 'A technician unexpectedly refreshed scheduling evidence.');
  const forbiddenSchedulingPayload = await functionErrorPayload(forbiddenScheduling.error);
  assert.equal(forbiddenSchedulingPayload?.code, 'ROLE_FORBIDDEN');

  process.stdout.write(
    'Authenticated Edge ACL canaries passed: AI Office, integration health, photo persistence, approved-action denial, and owner/dispatcher-only scheduling.\n',
  );
} finally {
  if (fixtureCreated) {
    runSql(`
      begin;
      select set_config('storyops.retention_purge', 'on', true);
      select set_config('storage.allow_delete_query', 'true', true);
      delete from public.ai_traces
      where company_id = '${companyId}'
        and operation = 'photo.analyze'
        and input_redacted ->> 'assetId' = '${assetId}';
      delete from public.photo_analyses
      where company_id = '${companyId}'
        and source_asset_id = '${assetId}';
      delete from public.media_assets
      where company_id = '${companyId}'
        and id = '${assetId}';
      delete from public.media_upload_attestations
      where company_id = '${companyId}'
        and asset_id = '${assetId}';
      delete from storage.objects
      where id = '${objectId}'
        and bucket_id = 'job-media'
        and name = '${objectPath}';
      commit;
    `);
  }
}
