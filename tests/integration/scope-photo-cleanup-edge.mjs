import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { supabaseCommand } from '../../infra/scripts/common.mjs';

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const WORKER_TOKEN = 'storyops-local-scope-photo-cleanup-token-v2-4f19';

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
  const serviceRoleKey = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY;
  assert.ok(url && serviceRoleKey, 'Local Supabase URL and service-role key are required.');
  return { url, serviceRoleKey };
}

async function invoke(url, token, body) {
  const response = await fetch(`${url}/functions/v1/scope-photo-cleanup`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

const { url, serviceRoleKey } = localSupabaseEnvironment();

const serviceRoleAttempt = await invoke(url, serviceRoleKey, {
  companyId: COMPANY_ID,
  trigger: 'manual',
  limit: 1,
});
assert.equal(serviceRoleAttempt.response.status, 401);
assert.equal(serviceRoleAttempt.payload.code, 'WORKER_UNAUTHENTICATED');

const mismatchedTrigger = await invoke(url, WORKER_TOKEN, {
  companyId: COMPANY_ID,
  trigger: 'scheduled',
  limit: 1,
});
assert.equal(mismatchedTrigger.response.status, 403);
assert.equal(mismatchedTrigger.payload.code, 'WORKER_TRIGGER_NOT_ALLOWED');

const run = await invoke(url, WORKER_TOKEN, {
  companyId: COMPANY_ID,
  trigger: 'manual',
  limit: 50,
});
assert.equal(run.response.status, 200, JSON.stringify(run.payload));
assert.equal(run.payload.schemaVersion, 'storyops-scope-photo-cleanup-run-v2');
assert.equal(run.payload.activationMode, 'manual');
assert.equal(run.payload.trigger, 'manual');
assert.equal(run.payload.status, 'processed');
assert.equal(run.payload.cleaned + run.payload.failed, run.payload.claimed);
assert.equal(run.payload.empty, run.payload.claimed === 0);

process.stdout.write(
  `Scope-photo cleanup Edge canary passed: service role rejected, trigger bound, ${run.payload.claimed} synthetic orphan(s) processed.\n`,
);
