import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, stat, writeFile, chmod, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SUPABASE_CLI_VERSION,
  supabaseCommand,
  unsafePublishedDockerBindings,
} from '../../infra/scripts/common.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sandboxEnvironment = {
  ...process.env,
  STORYOPS_PROVIDER_MODE: 'sandbox',
  OPENAI_MODE: 'sandbox',
  OPENAI_LIVE_ENABLED: 'false',
  OPENAI_VISION_LIVE_ENABLED: 'false',
  TWILIO_MODE: 'sandbox',
  TWILIO_LIVE_ENABLED: 'false',
  EMAIL_MODE: 'sandbox',
  EMAIL_LIVE_ENABLED: 'false',
  STRIPE_MODE: 'sandbox',
  STRIPE_LIVE_ENABLED: 'false',
  GOOGLE_CALENDAR_MODE: 'sandbox',
  GOOGLE_CALENDAR_LIVE_ENABLED: 'false',
  MAPS_MODE: 'sandbox',
  MAPS_LIVE_ENABLED: 'false',
  WEATHER_MODE: 'sandbox',
  NWS_LIVE_ENABLED: 'false',
  ROUTING_MODE: 'sandbox',
  VROOM_LIVE_ENABLED: 'false',
  SIGNED_STORAGE_TARGETS_MODE: 'sandbox',
  SIGNED_STORAGE_TARGETS_LIVE_ENABLED: 'false',
  QUICKBOOKS_MODE: 'sandbox',
  QUICKBOOKS_EXPORT_ENABLED: 'false',
};

function runScript(script, args = [], environment = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    env: { ...sandboxEnvironment, ...environment },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolvePromise, rejectPromise) =>
    server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
  );
  return port;
}

test('no-key setup check passes in forced sandbox mode', () => {
  const result = runScript('scripts/setup.mjs', ['--check', '--skip-install']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /prerequisite check passed/u);
  assert.doesNotMatch(result.stdout + result.stderr, /OPENAI_API_KEY=live/u);
});

test('Google Calendar live setup accepts server-side refresh credentials', () => {
  const result = runScript('scripts/setup.mjs', ['--check', '--skip-install'], {
    GOOGLE_CALENDAR_MODE: 'live',
    GOOGLE_CALENDAR_LIVE_ENABLED: 'true',
    GOOGLE_CALENDAR_ID: 'calendar@example.test',
    GOOGLE_CALENDAR_CLIENT_ID: 'client-redacted',
    GOOGLE_CALENDAR_CLIENT_SECRET: 'secret-redacted',
    GOOGLE_CALENDAR_REFRESH_TOKEN: 'refresh-redacted',
    GOOGLE_CALENDAR_ACCESS_TOKEN: '',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-redacted|refresh-redacted/u);
});

test('provider setup requires both switches before treating OpenAI as live', () => {
  const credentials = {
    OPENAI_API_KEY: 'openai-redacted',
    OPENAI_MODEL: 'evaluated-model',
  };
  const modeOnly = runScript('scripts/setup.mjs', ['--check', '--skip-install'], {
    OPENAI_MODE: 'live',
    OPENAI_LIVE_ENABLED: 'false',
    OPENAI_API_KEY: '',
    OPENAI_MODEL: '',
  });
  assert.equal(modeOnly.status, 0, modeOnly.stderr);
  assert.match(modeOnly.stderr, /activation is incomplete/u);

  const flagOnly = runScript('scripts/setup.mjs', ['--check', '--skip-install'], {
    OPENAI_MODE: 'sandbox',
    OPENAI_LIVE_ENABLED: 'true',
    OPENAI_API_KEY: '',
    OPENAI_MODEL: '',
  });
  assert.equal(flagOnly.status, 0, flagOnly.stderr);
  assert.match(flagOnly.stderr, /activation is incomplete/u);

  const bothMissingCredentials = runScript('scripts/setup.mjs', ['--check', '--skip-install'], {
    OPENAI_MODE: 'live',
    OPENAI_LIVE_ENABLED: 'true',
    OPENAI_API_KEY: '',
    OPENAI_MODEL: '',
  });
  assert.notEqual(bothMissingCredentials.status, 0);
  assert.match(
    bothMissingCredentials.stderr,
    /OPENAI_MODE=live and OPENAI_LIVE_ENABLED=true require/u,
  );

  const both = runScript('scripts/setup.mjs', ['--check', '--skip-install'], {
    OPENAI_MODE: 'live',
    OPENAI_LIVE_ENABLED: 'true',
    ...credentials,
  });
  assert.equal(both.status, 0, both.stderr);
  assert.doesNotMatch(both.stdout + both.stderr, /openai-redacted|evaluated-model/u);
});

test('MCP OpenAI adapter requires both live switches', () => {
  const adapterUrl = pathToFileURL(
    resolve(repositoryRoot, 'mcp/openai-agents-adapter.ts'),
  ).toString();
  const source = `
    import { openAiAgentsFromEnvironment } from ${JSON.stringify(adapterUrl)};
    const credentials = {
      OPENAI_API_KEY: 'openai-redacted',
      OPENAI_MODEL: 'evaluated-model',
    };
    const disabledCases = [
      { ...credentials, OPENAI_MODE: 'live', OPENAI_LIVE_ENABLED: 'false' },
      { ...credentials, OPENAI_MODE: 'sandbox', OPENAI_LIVE_ENABLED: 'true' },
      { ...credentials, OPENAI_MODE: 'disabled', OPENAI_LIVE_ENABLED: 'true' },
    ];
    for (const environment of disabledCases) {
      if (openAiAgentsFromEnvironment(environment) !== undefined) process.exit(1);
    }
    if (openAiAgentsFromEnvironment({
      ...credentials,
      OPENAI_MODE: 'live',
      OPENAI_LIVE_ENABLED: 'true',
    })?.mode !== 'live') process.exit(1);
  `;
  const result = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs'), '--eval', source],
    {
      cwd: repositoryRoot,
      env: sandboxEnvironment,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('signed inbound lead intake remains the explicit mode-only boundary', () => {
  const result = runScript('scripts/setup.mjs', ['--check', '--skip-install'], {
    LEAD_INTAKE_MODE: 'live',
    LEAD_INTAKE_COMPANY_ID: '10000000-0000-4000-8000-000000000001',
    LEAD_INTAKE_SIGNING_SECRET: 'intake-signing-redacted',
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-redacted',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /intake-signing-redacted|service-role-redacted/u,
  );
  assert.doesNotMatch(result.stdout + result.stderr, /LEAD_INTAKE_LIVE_ENABLED/u);
});

test('all script-level Supabase execution uses the exact pinned npx package', () => {
  const cli = supabaseCommand();
  assert.match(cli.command, /^npx(?:\.cmd)?$/u);
  assert.deepEqual(cli.prefix, ['--yes', `supabase@${SUPABASE_CLI_VERSION}`]);
  assert.equal(SUPABASE_CLI_VERSION, '2.110.0');

  for (const path of [
    'scripts/setup.mjs',
    'scripts/verify-local-supabase.mjs',
    'tests/integration/live-estimating-edge.mjs',
    'tests/integration/post-service-edge.mjs',
  ]) {
    const body = readFileSync(resolve(repositoryRoot, path), 'utf8');
    assert.doesNotMatch(body, /['"]supabase['"]\s*,\s*['"](?:status|start|db|functions)/u);
    assert.doesNotMatch(body, /spawn(?:Sync)?\(\s*['"]supabase['"]/u);
  }
});

test('Docker binding classifier rejects IPv4, IPv6, and empty wildcard hosts', () => {
  const unsafe = unsafePublishedDockerBindings([
    {
      containerId: 'safe',
      ports: {
        '8000/tcp': [
          { HostIp: '127.0.0.1', HostPort: '54321' },
          { HostIp: '::1', HostPort: '54321' },
        ],
      },
    },
    {
      containerId: 'unsafe',
      ports: {
        '5432/tcp': [
          { HostIp: '0.0.0.0', HostPort: '54322' },
          { HostIp: '::', HostPort: '54322' },
          { HostIp: '', HostPort: '54322' },
        ],
      },
    },
  ]);
  assert.equal(unsafe.length, 3);
  assert.deepEqual(
    unsafe.map((binding) => binding.hostIp),
    ['0.0.0.0', '::', ''],
  );
});

test('setup verification runs the live contract without reset unless explicitly requested', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'storyops-setup-verification-'));
  const envFile = resolve(directory, '.env.local');
  try {
    await writeFile(envFile, 'STORYOPS_PROVIDER_MODE=sandbox\nVITE_STORYOPS_DATA_MODE=sandbox\n', {
      mode: 0o600,
    });
    const regular = runScript('scripts/setup.mjs', [
      '--dry-run',
      '--skip-install',
      '--with-supabase',
      '--verify',
      '--env-file',
      envFile,
    ]);
    assert.equal(regular.status, 0, regular.stderr);
    assert.match(regular.stdout, /\bnpx --yes supabase@2\.110\.0 start\b/u);
    assert.match(regular.stdout, /\bnpm run test:supabase\b/u);
    assert.doesNotMatch(regular.stdout, /test:supabase -- --reset/u);

    const reset = runScript('scripts/setup.mjs', [
      '--dry-run',
      '--skip-install',
      '--with-supabase',
      '--verify',
      '--reset-supabase',
      '--env-file',
      envFile,
    ]);
    assert.equal(reset.status, 0, reset.stderr);
    assert.match(reset.stdout, /\bnpm run test:supabase -- --reset\b/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'setup stops a just-started Supabase stack with wildcard ports unless explicitly overridden',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'storyops-setup-network-'));
    const binDirectory = resolve(directory, 'bin');
    const statePath = resolve(directory, 'started');
    const logPath = resolve(directory, 'npx.log');
    const envFile = resolve(directory, '.env.local');
    try {
      await mkdir(binDirectory);
      await writeFile(
        resolve(binDirectory, 'npx'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPX_LOG, JSON.stringify(args) + '\\n');
if (args.includes('start')) fs.writeFileSync(process.env.FAKE_SUPABASE_STATE, 'started');
if (args.includes('stop')) fs.rmSync(process.env.FAKE_SUPABASE_STATE, { force: true });
`,
      );
      await writeFile(
        resolve(binDirectory, 'docker'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'info') process.stdout.write('27.0.0\\n');
if (args[0] === 'ps' && fs.existsSync(process.env.FAKE_SUPABASE_STATE)) {
  process.stdout.write('fake-container\\n');
}
if (args[0] === 'inspect') {
  process.stdout.write(JSON.stringify({
    '8000/tcp': [
      { HostIp: '0.0.0.0', HostPort: '54321' },
      { HostIp: '::', HostPort: '54321' }
    ]
  }) + '\\n');
}
`,
      );
      await chmod(resolve(binDirectory, 'npx'), 0o755);
      await chmod(resolve(binDirectory, 'docker'), 0o755);
      await writeFile(
        envFile,
        'STORYOPS_PROVIDER_MODE=sandbox\nVITE_STORYOPS_DATA_MODE=sandbox\n',
        { mode: 0o600 },
      );
      const environment = {
        PATH: `${binDirectory}${delimiter}${process.env.PATH || ''}`,
        FAKE_NPX_LOG: logPath,
        FAKE_SUPABASE_STATE: statePath,
      };

      const blocked = runScript(
        'scripts/setup.mjs',
        ['--skip-install', '--with-supabase', '--env-file', envFile],
        environment,
      );
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /non-loopback Docker binding/u);
      const blockedCalls = readFileSync(logPath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line));
      assert.deepEqual(blockedCalls[0], ['--yes', 'supabase@2.110.0', 'start']);
      assert.deepEqual(blockedCalls[1], ['--yes', 'supabase@2.110.0', 'stop', '--no-backup']);
      await assert.rejects(stat(statePath), { code: 'ENOENT' });

      await writeFile(logPath, '');
      const allowed = runScript(
        'scripts/setup.mjs',
        [
          '--skip-install',
          '--with-supabase',
          '--unsafe-allow-wildcard-supabase-ports',
          '--env-file',
          envFile,
        ],
        environment,
      );
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.match(allowed.stderr, /explicit unsafe override accepted/u);
      const allowedCalls = readFileSync(logPath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line));
      assert.deepEqual(allowedCalls, [['--yes', 'supabase@2.110.0', 'start']]);
      assert.equal(await stat(statePath).then((metadata) => metadata.isFile()), true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('Compose and Docker builds require an explicit, complete data-mode contract', () => {
  const compose = readFileSync(resolve(repositoryRoot, 'docker-compose.yml'), 'utf8');
  const dockerfile = readFileSync(resolve(repositoryRoot, 'Dockerfile'), 'utf8');
  assert.match(
    compose,
    /VITE_STORYOPS_DATA_MODE: \$\{VITE_STORYOPS_DATA_MODE:\?Run docker compose with --env-file \.env\.local\}/u,
  );
  assert.doesNotMatch(compose, /VITE_STORYOPS_DATA_MODE:.*:-sandbox/u);
  assert.match(compose, /STORYOPS_EXPECTED_DATA_MODE:/u);
  assert.match(dockerfile, /ARG VITE_STORYOPS_DATA_MODE\s*$/mu);
  assert.match(dockerfile, /Supabase build requires VITE_SUPABASE_URL/u);
  assert.match(dockerfile, /dist\/storyops-build\.json/u);
});

test('the distributable CI artifact preserves every required notice', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  const artifactStep = workflow.match(
    /- name: Preserve production bundle[\s\S]*?retention-days: 7/u,
  )?.[0];
  assert.ok(artifactStep, 'The production bundle upload step must exist.');
  for (const requiredPath of [
    'dist',
    'NOTICE.md',
    'LICENSE.atomic-crm.md',
    'THIRD_PARTY.md',
    'NPM_THIRD_PARTY_NOTICES.txt',
  ]) {
    assert.match(artifactStep, new RegExp(`^\\s+${requiredPath.replaceAll('.', '\\.')}$`, 'mu'));
  }
});

test('static runtime reports compiled mode and revision and rejects expected-mode mismatch', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'storyops-runtime-'));
  const distDirectory = resolve(directory, 'dist');
  let child;
  try {
    await mkdir(distDirectory);
    await copyFile(
      resolve(repositoryRoot, 'infra/runtime/server.mjs'),
      resolve(directory, 'server.mjs'),
    );
    await writeFile(resolve(distDirectory, 'index.html'), '<!doctype html><title>StoryOps</title>');
    await writeFile(
      resolve(distDirectory, 'storyops-build.json'),
      '{"dataMode":"sandbox","revision":"test-revision-123"}\n',
    );

    const mismatch = spawnSync(process.execPath, ['server.mjs'], {
      cwd: directory,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '18080',
        STORYOPS_EXPECTED_DATA_MODE: 'supabase',
      },
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /does not match expected startup mode/u);

    const port = await availablePort();
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: directory,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        STORYOPS_EXPECTED_DATA_MODE: 'sandbox',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let response;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) break;
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    assert.ok(response?.ok, 'Runtime health endpoint did not become ready.');
    const health = await response.json();
    assert.deepEqual(
      {
        status: health.status,
        service: health.service,
        dataMode: health.dataMode,
        revision: health.revision,
      },
      {
        status: 'healthy',
        service: 'storyops-ai-web',
        dataMode: 'sandbox',
        revision: 'test-revision-123',
      },
    );
    assert.match(health.startedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(health.checkedAt, /^\d{4}-\d{2}-\d{2}T/u);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('backup dry run performs no writes and redacts database credentials', async () => {
  const outputParent = await mkdtemp(resolve(tmpdir(), 'storyops-backup-dry-run-'));
  const target = resolve(outputParent, 'must-not-exist');
  const secret = 'correct-horse-battery-staple';
  try {
    const result = runScript('scripts/backup.mjs', [
      '--dry-run',
      '--db-url',
      `postgresql://operator:${secret}@db.example.test:5432/storyops`,
      '--output',
      target,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret, 'u'));
    assert.match(result.stdout, /\[REDACTED\]/u);
    await assert.rejects(stat(target), { code: 'ENOENT' });
  } finally {
    await rm(outputParent, { recursive: true, force: true });
  }
});

test('restore dry run validates checksums and never exposes the target password', async () => {
  const backupDirectory = await mkdtemp(resolve(tmpdir(), 'storyops-restore-dry-run-'));
  const contents = new Map([
    ['roles.sql', '-- roles\n'],
    ['schema.sql', 'create table public.example(id bigint);\n'],
    ['data.sql', 'copy public.example (id) from stdin;\n1\n\\.\n'],
  ]);
  try {
    const files = [];
    for (const [name, body] of contents) {
      await writeFile(resolve(backupDirectory, name), body, { mode: 0o600 });
      files.push({
        path: name,
        bytes: Buffer.byteLength(body),
        sha256: hash(body),
      });
    }
    await writeFile(
      resolve(backupDirectory, 'manifest.json'),
      JSON.stringify({
        format: 'storyops-supabase-logical-v1',
        createdAt: new Date().toISOString(),
        database: { files },
        storage: { included: false, buckets: [], objects: [] },
      }),
      { mode: 0o600 },
    );

    const secret = 'restore-password-never-print';
    const result = runScript('scripts/restore.mjs', [
      '--backup',
      backupDirectory,
      '--dry-run',
      '--db-url',
      `postgresql://restore:${secret}@db.example.test:5432/storyops`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Validated: 3 database files/u);
    assert.match(result.stdout, /no database, network, or filesystem changes/u);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret, 'u'));

    await writeFile(resolve(backupDirectory, 'data.sql'), 'tampered\n', { mode: 0o600 });
    const tampered = runScript('scripts/restore.mjs', ['--backup', backupDirectory, '--dry-run']);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /size check failed|checksum check failed/u);
  } finally {
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test('VROOM is commit-pinned and compiled without GLPK', () => {
  const dockerfile = readFileSync(resolve(repositoryRoot, 'infra/vroom/Dockerfile'), 'utf8');
  const compose = readFileSync(resolve(repositoryRoot, 'docker-compose.yml'), 'utf8');
  assert.match(dockerfile, /VROOM_VERSION=v1\.15\.0/u);
  assert.match(dockerfile, /VROOM_REF=43dd7d0b8b560431eb555bf335cf4797eb7343c4/u);
  assert.doesNotMatch(dockerfile, /\b(?:apt-get install[^\n]*|^\s+)libglpk/imu);
  assert.match(dockerfile, /test ! -e \/usr\/include\/glpk\.h/u);
  assert.match(dockerfile, /! ldd .*grep -qi glpk/u);
  assert.match(compose, /43dd7d0b8b560431eb555bf335cf4797eb7343c4/u);
});

test('environment template leaves server-side credentials empty', () => {
  const body = readFileSync(resolve(repositoryRoot, '.env.example'), 'utf8');
  for (const name of [
    'OPENAI_API_KEY',
    'TWILIO_AUTH_TOKEN',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GOOGLE_CALENDAR_CLIENT_SECRET',
  ]) {
    assert.match(body, new RegExp(`^${name}=$`, 'mu'));
  }
  assert.doesNotMatch(body, /^VITE_.*(?:SECRET|PASSWORD|SERVICE_ROLE|AUTH_TOKEN)=.+$/imu);
});
