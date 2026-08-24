import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  REPO_ROOT,
  supabaseCommand,
  unsafePublishedDockerBindings,
} from '../../infra/scripts/common.mjs';

const PROJECT_ID = 'storyops-residential-cadence-upgrade';
const DATABASE_CONTAINER = `supabase_db_${PROJECT_ID}`;
const LOOPBACK_NETWORK = `${PROJECT_ID}-supabase-loopback`;
const LOOPBACK_BINDING_OPTION = 'com.docker.network.bridge.host_binding_ipv4';
const LOOPBACK_BINDING_ADDRESS = '127.0.0.1';
const BASELINE_MIGRATION = '20260728660000_private_worker_launch_readiness.sql';
const UPGRADE_MIGRATION = '20260728670000_residential_service_pack_cadence.sql';

function sanitized(value) {
  return String(value).replace(/eyJ[a-zA-Z0-9._-]+/gu, '[REDACTED_JWT]');
}

function runSupabase(workdir, arguments_, allowFailure = false) {
  const cli = supabaseCommand();
  const result = spawnSync(cli.command, [...cli.prefix, ...arguments_, '--workdir', workdir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `Supabase ${arguments_.join(' ')} failed.\n${sanitized(result.stdout)}\n${sanitized(
        result.stderr,
      )}`,
    );
  }
  return result;
}

function runDocker(arguments_, allowFailure = false) {
  const result = spawnSync('docker', arguments_, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `Docker ${arguments_.join(' ')} failed.\n${sanitized(result.stdout)}\n${sanitized(
        result.stderr,
      )}`,
    );
  }
  return result;
}

function ensureLoopbackNetwork() {
  const listing = runDocker([
    'network',
    'ls',
    '--filter',
    `name=^${LOOPBACK_NETWORK}$`,
    '--format',
    '{{.Name}}',
  ]);
  const existing = listing.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (existing.some((name) => name !== LOOPBACK_NETWORK) || existing.length > 1) {
    throw new Error(`Docker returned an ambiguous network match for ${LOOPBACK_NETWORK}.`);
  }
  const created = existing.length === 0;
  if (created) {
    runDocker([
      'network',
      'create',
      '--driver',
      'bridge',
      '--opt',
      `${LOOPBACK_BINDING_OPTION}=${LOOPBACK_BINDING_ADDRESS}`,
      LOOPBACK_NETWORK,
    ]);
  }
  const inspection = runDocker(['network', 'inspect', '--format', '{{json .}}', LOOPBACK_NETWORK]);
  const network = JSON.parse(inspection.stdout.trim());
  if (
    network?.Name !== LOOPBACK_NETWORK ||
    network?.Driver !== 'bridge' ||
    network?.Options?.[LOOPBACK_BINDING_OPTION] !== LOOPBACK_BINDING_ADDRESS
  ) {
    throw new Error(`Disposable upgrade network ${LOOPBACK_NETWORK} is not loopback-only.`);
  }
  return created;
}

function assertLoopbackBindings() {
  const listing = runDocker([
    'ps',
    '--filter',
    `label=com.supabase.cli.project=${PROJECT_ID}`,
    '--format',
    '{{.ID}}',
  ]);
  const containerIds = listing.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (containerIds.length === 0) {
    throw new Error('Disposable cadence-upgrade stack started without any containers.');
  }
  const inspection = runDocker([
    'inspect',
    '--format',
    '{{json .NetworkSettings.Ports}}',
    ...containerIds,
  ]);
  const bindings = inspection.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({ containerId: containerIds[index], ports: JSON.parse(line) }));
  if (bindings.length !== containerIds.length) {
    throw new Error('Docker returned incomplete cadence-upgrade port metadata.');
  }
  const unsafe = unsafePublishedDockerBindings(bindings);
  if (unsafe.length > 0) {
    throw new Error('Disposable cadence-upgrade stack published a non-loopback port.');
  }
}

function waitForDatabase(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    const ready = spawnSync(
      'docker',
      ['exec', DATABASE_CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
      { encoding: 'utf8', stdio: 'ignore', timeout: 2_000 },
    );
    if (ready.status === 0) return;
    Atomics.wait(pause, 0, 0, 500);
  }
  throw new Error('Disposable cadence-upgrade database did not become ready.');
}

function runSql(sql) {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      DATABASE_CONTAINER,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    {
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    },
  );
}

function queryJson(sql) {
  const output = execFileSync(
    'docker',
    [
      'exec',
      DATABASE_CONTAINER,
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

const config = `
project_id = "${PROJECT_ID}"

[api]
enabled = true
port = 56421
schemas = ["public", "storage", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = 56422
shadow_port = 56420
major_version = 15

[db.seed]
enabled = false

[realtime]
enabled = false

[studio]
enabled = false
port = 56423
api_url = "http://127.0.0.1"

[local_smtp]
enabled = false
port = 56424

[storage]
enabled = true
file_size_limit = "25MiB"

[auth]
enabled = true
site_url = "http://127.0.0.1:5173"
additional_redirect_urls = ["http://localhost:5173", "http://127.0.0.1:5173"]
jwt_expiry = 3600
enable_refresh_token_rotation = true
refresh_token_reuse_interval = 10
enable_signup = false
minimum_password_length = 12

[auth.email]
enable_signup = false
double_confirm_changes = true
enable_confirmations = true

[analytics]
enabled = false

[edge_runtime]
enabled = false
policy = "per_worker"
`;

let workdir;
let startAttempted = false;
let createdLoopbackNetwork = false;
try {
  workdir = await mkdtemp(resolve(REPO_ROOT, '.storyops-residential-cadence-upgrade-'));
  const supabaseDirectory = join(workdir, 'supabase');
  const migrationsDirectory = join(supabaseDirectory, 'migrations');
  await mkdir(migrationsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(supabaseDirectory, 'config.toml'), config, { mode: 0o600, flag: 'wx' });

  const sourceMigrations = resolve(REPO_ROOT, 'supabase/migrations');
  for (const fileName of (await readdir(sourceMigrations)).sort()) {
    if (!fileName.endsWith('.sql') || fileName.localeCompare(BASELINE_MIGRATION) > 0) continue;
    await copyFile(join(sourceMigrations, fileName), join(migrationsDirectory, fileName));
  }

  createdLoopbackNetwork = ensureLoopbackNetwork();
  startAttempted = true;
  runSupabase(workdir, ['start', '--ignore-health-check', '--network-id', LOOPBACK_NETWORK]);
  assertLoopbackBindings();
  waitForDatabase();

  const before = queryJson(`
    select jsonb_build_object(
      'constraintSupportsWeekly', position(
        'weekly' in pg_get_constraintdef(constraint_record.oid)
      ) > 0,
      'postServiceSupportsWeekly', position(
        '''weekly''' in pg_get_functiondef(
          'public.execute_storyops_post_service_action(uuid,uuid,uuid,text,uuid,integer,jsonb)'::regprocedure
        )
      ) > 0,
      'dueWorkSupportsWeekly', position(
        'plan_row.cadence = ''weekly''' in pg_get_functiondef(
          'public.create_storyops_recurring_due_work(uuid,uuid,uuid,integer,date,text)'::regprocedure
        )
      ) > 0
    )
    from pg_constraint constraint_record
    where constraint_record.conname = 'recurring_maintenance_plans_cadence_check'
  `);
  assert.deepEqual(before, {
    constraintSupportsWeekly: false,
    postServiceSupportsWeekly: false,
    dueWorkSupportsWeekly: false,
  });

  runSql(await readFile(join(sourceMigrations, UPGRADE_MIGRATION), 'utf8'));

  const after = queryJson(`
    select jsonb_build_object(
      'constraintSupportsWeekly', position(
        'weekly' in pg_get_constraintdef(constraint_record.oid)
      ) > 0,
      'postServiceSupportsWeekly', position(
        '''weekly''' in pg_get_functiondef(
          'public.execute_storyops_post_service_action(uuid,uuid,uuid,text,uuid,integer,jsonb)'::regprocedure
        )
      ) > 0,
      'dueWorkSupportsWeekly', position(
        'plan_row.cadence = ''weekly''' in pg_get_functiondef(
          'public.create_storyops_recurring_due_work(uuid,uuid,uuid,integer,date,text)'::regprocedure
        )
      ) > 0
    )
    from pg_constraint constraint_record
    where constraint_record.conname = 'recurring_maintenance_plans_cadence_check'
  `);
  assert.deepEqual(after, {
    constraintSupportsWeekly: true,
    postServiceSupportsWeekly: true,
    dueWorkSupportsWeekly: true,
  });

  runSql(await readFile(resolve(REPO_ROOT, 'supabase/seed.sql'), 'utf8'));
  runSql(await readFile(resolve(REPO_ROOT, 'tests/integration/recurring-due-work.sql'), 'utf8'));
} finally {
  if (workdir && startAttempted) {
    runSupabase(workdir, ['stop', '--no-backup', '--network-id', LOOPBACK_NETWORK], true);
  }
  if (createdLoopbackNetwork) runDocker(['network', 'rm', LOOPBACK_NETWORK], true);
  if (workdir) await rm(workdir, { recursive: true, force: true });
}

process.stdout.write(
  'Isolated pre-67 cadence upgrade preserved the baseline, applied the forward migration, and passed weekly cadence SQL contracts.\n',
);
