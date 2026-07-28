#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { supabaseCommand } from '../infra/scripts/common.mjs';

const reset = process.argv.includes('--reset');
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
  'tests/integration/live-setup.sql',
  'tests/integration/approved-action-rpc.sql',
  'tests/integration/live-lead-scope.sql',
  'tests/integration/live-field-completion.sql',
  'tests/integration/live-field-safety.sql',
  'tests/integration/live-golden-path.sql',
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
  const child = spawn(supabaseCli.command, [...supabaseCli.prefix, 'functions', 'serve'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
  });
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
  return { child, ready, detached };
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

async function stopEdgeFunctions(child, detached) {
  if (child.exitCode === null) signalEdgeFunctions(child, detached, 'SIGINT');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    signalEdgeFunctions(child, detached, 'SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

async function main() {
  process.stdout.write('[local-supabase] validating local stack\n');
  runSupabase(['status', '--output', 'json'], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (reset) {
    process.stdout.write('[local-supabase] rebuilding migrations and synthetic seed\n');
    try {
      runSupabase(['db', 'reset', '--local']);
    } catch {
      process.stderr.write(
        '[local-supabase] direct reset bootstrap failed; rebuilding the explicitly local stack without retaining its database volume\n',
      );
      runSupabase(['stop', '--no-backup']);
      runSupabase(['start', '--ignore-health-check']);
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

  const edge = startEdgeFunctions();
  try {
    await edge.ready;
    process.stdout.write('\n[local-supabase] Edge Functions ready\n');
    run(process.execPath, ['tests/integration/live-estimating-edge.mjs']);
    run(process.execPath, ['tests/integration/post-service-edge.mjs']);
    run(process.execPath, ['tests/integration/live-offline-media-edge.mjs']);
  } finally {
    await stopEdgeFunctions(edge.child, edge.detached);
  }
  process.stdout.write('\nStoryOps local Supabase release contract passed.\n');
}

main().catch((error) => {
  console.error(sanitized(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
