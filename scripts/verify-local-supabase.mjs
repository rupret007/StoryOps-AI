#!/usr/bin/env node

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { supabaseCommand } from '../infra/scripts/common.mjs';

const reset = process.argv.includes('--reset');
const LOCAL_SUPABASE_NETWORK = 'storyops-ai-supabase-loopback';
const unknown = process.argv.slice(2).filter((argument) => argument !== '--reset');
if (unknown.length > 0) {
  console.error(`Unknown option(s): ${unknown.join(', ')}`);
  process.exit(2);
}

const sqlContracts = [
  'supabase/tests/database_security.sql',
  'supabase/tests/outbound_authorization.sql',
  'supabase/tests/provider_webhook_reconciliation.sql',
  'supabase/tests/stripe_customer_mapping.sql',
  'supabase/tests/live_estimating_security.sql',
  'supabase/tests/post_service_lifecycle.sql',
  'supabase/tests/post_service_outbound_worker.sql',
  'tests/integration/transactional-delivery-lifecycle.sql',
  'tests/integration/recurring-due-work.sql',
  'tests/integration/live-setup.sql',
  'tests/integration/setup-forward-compatibility.sql',
  'tests/integration/setup-receipt-authority.sql',
  'tests/integration/company-configuration.sql',
  'tests/integration/material-sds-registry.sql',
  'tests/integration/approved-action-rpc.sql',
  'tests/integration/ai-approved-lead-actions.sql',
  'tests/integration/pricing-unit-persistence.sql',
  'tests/integration/live-lead-scope.sql',
  'tests/integration/lead-intake-operational-disposition.sql',
  'tests/integration/live-field-completion.sql',
  'tests/integration/live-field-safety.sql',
  'tests/integration/atomic-incident-stop-work.sql',
  'tests/integration/incident-evidence-media.sql',
  'tests/integration/field-packet-customer-evidence.sql',
  'tests/integration/scope-photo-workflow.sql',
  'tests/integration/estimate-scope-evidence-bundle.sql',
  'tests/integration/estimate-approval-exact-payload.sql',
  'tests/integration/customer-portal-requests.sql',
  'tests/integration/customer-commercial-portal.sql',
  'tests/integration/payment-allocation-boundary.sql',
  'tests/integration/deposit-provider-truth.sql',
  'tests/integration/payment-checkout-retirement.sql',
  'tests/integration/audit-quote-acceptance-boundary.sql',
  'tests/integration/active-company-mutation-gate.sql',
  'tests/integration/active-company-setup-control.sql',
  'tests/integration/active-company-service-boundaries.sql',
  'tests/integration/role-offboarding-security.sql',
  'tests/integration/identity-provisioning.sql',
  'tests/integration/identity-invitation-provider-authority.sql',
  'tests/integration/identity-invitation-attempt-authority.sql',
  'tests/integration/industry-pack-kernel.sql',
  'tests/integration/scheduling-evidence-boundary.sql',
  'tests/integration/owner-field-eligibility.sql',
  'tests/integration/customer-property-atomic.sql',
  'tests/integration/property-geocode-review.sql',
  'tests/integration/dispatch-clearance.sql',
  'tests/integration/private-worker-launch-readiness.sql',
  'tests/integration/scheduling-reconciliation.sql',
  'tests/integration/live-profitability-kpis.sql',
  'tests/integration/live-ai-office-observability.sql',
  'tests/integration/edge-service-role-boundaries.sql',
  'tests/integration/fixture-backed-booking-invoice-contract.sql',
  'tests/integration/pilot-release-evidence.sql',
];
const supabaseCli = supabaseCommand();

function sanitized(value) {
  return value
    .replace(/eyJ[a-zA-Z0-9._-]+/gu, '[REDACTED_JWT]')
    .replace(
      /(anon key|service_role key|JWT secret|Access token|Secret key)\s+\S+/giu,
      '$1 [REDACTED]',
    );
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...options,
  });
  if (result.stdout) process.stdout.write(sanitized(result.stdout));
  if (result.stderr) process.stderr.write(sanitized(result.stderr));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(' ')} exited ${result.status ?? 'without status'}`,
    );
  }
}

function runSqlContract(path) {
  process.stdout.write(`\n[local-supabase] ${path}\n`);
  run(
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
    { input: readFileSync(path, 'utf8') },
  );
}

function runSupabase(arguments_, options = {}) {
  run(supabaseCli.command, [...supabaseCli.prefix, ...arguments_], options);
}

function waitForLocalDatabase(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    const health = spawnSync(
      'docker',
      [
        'inspect',
        '--format',
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
        'supabase_db_storyops-ai',
      ],
      { encoding: 'utf8' },
    );
    const ready = health.status === 0 && ['healthy', 'running'].includes(health.stdout.trim());
    if (ready) {
      const probe = spawnSync(
        'docker',
        ['exec', 'supabase_db_storyops-ai', 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
        { encoding: 'utf8' },
      );
      if (probe.status === 0) return;
    }
    Atomics.wait(pause, 0, 0, 1_000);
  }
  throw new Error('Local Supabase database did not become ready within 60 seconds.');
}

function waitForHealthyContainer(containerName, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    const health = spawnSync(
      'docker',
      [
        'inspect',
        '--format',
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
        containerName,
      ],
      { encoding: 'utf8' },
    );
    if (health.status === 0 && health.stdout.trim() === 'healthy') return;
    Atomics.wait(pause, 0, 0, 1_000);
  }
  throw new Error(
    `${label} did not become healthy within ${Math.round(timeoutMs / 1_000)} seconds.`,
  );
}

function startEdgeFunctions() {
  const detached = process.platform !== 'win32';
  const environmentDirectory = mkdtempSync(join(tmpdir(), 'storyops-edge-env-'));
  chmodSync(environmentDirectory, 0o700);
  const environmentFile = join(environmentDirectory, '.env');
  let child;
  try {
    writeFileSync(
      environmentFile,
      [
        'STRIPE_MODE=sandbox',
        'STRIPE_LIVE_ENABLED=false',
        'STRIPE_WEBHOOK_SECRET=whsec_storyops_local_contract_only',
        'POST_SERVICE_WORKER_MODE=manual',
        'POST_SERVICE_WORKER_TOKEN=storyops-local-post-service-worker-token-v1-6a91',
        'POST_SERVICE_WORKER_SCHEDULE_INTERVAL_SECONDS=900',
        'TRANSACTIONAL_OUTBOUND_WORKER_MODE=manual',
        'TRANSACTIONAL_OUTBOUND_WORKER_TOKEN=storyops-local-transactional-worker-token-v1-4c82',
        'TRANSACTIONAL_OUTBOUND_WORKER_SCHEDULE_INTERVAL_SECONDS=60',
        'OUTBOUND_WORKER_QUEUE_ALERT_AFTER_SECONDS=900',
        'SCOPE_PHOTO_CLEANUP_MODE=manual',
        'SCOPE_PHOTO_CLEANUP_TOKEN=storyops-local-scope-photo-cleanup-token-v2-4f19',
        '',
      ].join('\n'),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    child = spawn(
      supabaseCli.command,
      [
        ...supabaseCli.prefix,
        'functions',
        'serve',
        '--env-file',
        environmentFile,
        '--network-id',
        LOCAL_SUPABASE_NETWORK,
      ],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached,
        env: process.env,
      },
    );
  } catch (error) {
    rmSync(environmentDirectory, { recursive: true, force: true });
    throw error;
  }
  let buffered = '';
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`Edge Functions did not become ready.\n${sanitized(buffered.slice(-4000))}`),
      );
    }, 30_000);
    const consume = (chunk) => {
      buffered += chunk.toString();
      if (/Serving functions on /u.test(buffered)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      if (!/Serving functions on /u.test(buffered)) {
        clearTimeout(timeout);
        reject(
          new Error(
            `Edge Functions exited ${code ?? 'without status'}.\n${sanitized(buffered.slice(-4000))}`,
          ),
        );
      }
    });
  });
  return { child, ready, detached, environmentDirectory };
}

function signalEdgeFunctions(child, detached, signal) {
  try {
    if (detached && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function stopEdgeFunctions(child, detached, environmentDirectory) {
  try {
    if (child.exitCode === null) {
      signalEdgeFunctions(child, detached, 'SIGINT');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (child.exitCode === null) {
      signalEdgeFunctions(child, detached, 'SIGKILL');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
  } finally {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    rmSync(environmentDirectory, { recursive: true, force: true });
  }
}

async function main() {
  process.stdout.write('[local-supabase] validating local stack\n');
  runSupabase(['status', '--output', 'json'], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (reset) {
    process.stdout.write('[local-supabase] rebuilding migrations and synthetic seed\n');
    try {
      runSupabase(['db', 'reset', '--local', '--network-id', LOCAL_SUPABASE_NETWORK]);
    } catch {
      process.stderr.write(
        '[local-supabase] direct reset bootstrap failed; rebuilding the explicitly local stack without retaining its database volume\n',
      );
      runSupabase(['stop', '--no-backup', '--network-id', LOCAL_SUPABASE_NETWORK]);
      runSupabase(['start', '--ignore-health-check', '--network-id', LOCAL_SUPABASE_NETWORK]);
    }
    waitForLocalDatabase();
  }
  waitForHealthyContainer('supabase_storage_storyops-ai', 'Local Supabase Storage');
  runSupabase([
    'db',
    'lint',
    '--local',
    '--schema',
    'public',
    '--level',
    'warning',
    '--fail-on',
    'error',
  ]);
  for (const path of sqlContracts) runSqlContract(path);
  run(process.execPath, ['tests/integration/payment-allocation-concurrency.mjs']);
  run(process.execPath, ['tests/integration/active-company-concurrency.mjs']);
  run(process.execPath, ['tests/integration/active-company-approved-action-concurrency.mjs']);
  run(process.execPath, ['tests/integration/identity-invitation-attempt-concurrency.mjs']);
  run(process.execPath, ['tests/integration/field-media-canary-crew-concurrency.mjs']);
  run(process.execPath, ['tests/integration/live-recovery-dump.mjs']);

  const edge = startEdgeFunctions();
  try {
    await edge.ready;
    process.stdout.write('\n[local-supabase] Edge Functions ready\n');
    run(process.execPath, ['tests/integration/live-estimating-edge.mjs']);
    run(process.execPath, ['tests/integration/post-service-edge.mjs']);
    run(process.execPath, ['tests/integration/transactional-outbound-edge.mjs']);
    run(process.execPath, ['tests/integration/scope-photo-cleanup-edge.mjs']);
    run(process.execPath, ['tests/integration/live-offline-media-edge.mjs']);
    run(process.execPath, ['tests/integration/edge-service-role-canary.mjs']);
    run(process.execPath, ['tests/integration/scheduling-suggestions-edge.mjs']);
    run(process.execPath, ['tests/integration/sds-registration-edge.mjs']);
    run(process.execPath, ['tests/integration/stripe-payment-webhook-edge.mjs']);
  } finally {
    await stopEdgeFunctions(edge.child, edge.detached, edge.environmentDirectory);
  }
  process.stdout.write('\nWashOps local Supabase release contract passed.\n');
}

main().catch((error) => {
  console.error(sanitized(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
