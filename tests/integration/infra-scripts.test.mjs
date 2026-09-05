import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
  redactText,
  supabaseCommand,
  unsafePublishedDockerBindings,
} from '../../infra/scripts/common.mjs';
import {
  REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS,
  REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS,
  extractStoryOpsStoragePolicyDump,
} from '../../infra/scripts/storage-recovery.mjs';
import {
  HOSTED_CI_EXIT_CODES,
  HOSTED_CI_VERDICTS,
  assertLinuxRollupNativeInstalled,
  classifyHostedJob,
  classifyHostedRun,
  detectLinuxLibcFamily,
  requiredLinuxRollupNativeName,
} from '../../infra/scripts/ci-build-honesty.mjs';

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

test('redactText removes credential values from Supabase JSON without obscuring metadata', () => {
  const output = JSON.stringify({
    API_URL: 'http://127.0.0.1:54321',
    DB_URL: 'postgresql://postgres:json-db-password@127.0.0.1:54322/postgres',
    PROJECT_ID: 'storyops-local',
    SECRET_KEY: 'secret-key-value',
    SERVICE_ROLE_KEY: 'service-role-value',
    ANON_KEY: 'anon-key-value',
    PUBLISHABLE_KEY: 'publishable-key-value',
    JWT_SECRET: 'jwt-secret-value',
    S3_PROTOCOL_ACCESS_KEY_ID: 's3-access-id-value',
    S3_PROTOCOL_ACCESS_KEY_SECRET: 's3-access-secret-value',
    API_TOKEN: 'API_TOKEN',
    refreshToken: 'refresh-token-value',
    description: 'SECRET_KEY is configured; key rotation metadata remains visible.',
  });

  const redacted = redactText(output);

  for (const secret of [
    'json-db-password',
    'secret-key-value',
    'service-role-value',
    'anon-key-value',
    'publishable-key-value',
    'jwt-secret-value',
    's3-access-id-value',
    's3-access-secret-value',
    '"API_TOKEN":"API_TOKEN"',
    'refresh-token-value',
  ]) {
    assert.doesNotMatch(redacted, new RegExp(secret, 'u'));
  }
  assert.match(redacted, /"SECRET_KEY":"\[REDACTED\]"/u);
  assert.match(redacted, /"API_TOKEN":"\[REDACTED\]"/u);
  assert.match(redacted, /"refreshToken":"\[REDACTED\]"/u);
  assert.match(redacted, /"API_URL":"http:\/\/127\.0\.0\.1:54321"/u);
  assert.match(redacted, /"PROJECT_ID":"storyops-local"/u);
  assert.match(
    redacted,
    /"description":"SECRET_KEY is configured; key rotation metadata remains visible\."/u,
  );
  assert.match(
    redacted,
    /"DB_URL":"postgresql:\/\/postgres:\[REDACTED\]@127\.0\.0\.1:54322\/postgres"/u,
  );
});

test('redactText removes quoted and unquoted credential values from Supabase env output', () => {
  const output = [
    'API_URL="http://127.0.0.1:54321"',
    'PROJECT_ID="storyops-local"',
    'SECRET_KEY="quoted-secret-key-value"',
    "SERVICE_ROLE_KEY='single-quoted-service-role-value'",
    'ANON_KEY=unquoted-anon-key-value',
    'PUBLISHABLE_KEY="publishable-key-value"',
    'JWT_SECRET="jwt-secret-value"',
    'S3_PROTOCOL_ACCESS_KEY_ID="s3-access-id-value"',
    'S3_PROTOCOL_ACCESS_KEY_SECRET="s3-access-secret-value"',
    'PROVIDER_AUTH_TOKEN="provider-token-value"',
    'SMTP_PASSWORD="smtp-password-value"',
    'LOG_MESSAGE="SECRET_KEY is configured; key rotation metadata remains visible."',
  ].join('\n');

  const redacted = redactText(output);

  for (const secret of [
    'quoted-secret-key-value',
    'single-quoted-service-role-value',
    'unquoted-anon-key-value',
    'publishable-key-value',
    'jwt-secret-value',
    's3-access-id-value',
    's3-access-secret-value',
    'provider-token-value',
    'smtp-password-value',
  ]) {
    assert.doesNotMatch(redacted, new RegExp(secret, 'u'));
  }
  assert.match(redacted, /^SECRET_KEY="\[REDACTED\]"$/mu);
  assert.match(redacted, /^SERVICE_ROLE_KEY='\[REDACTED\]'$/mu);
  assert.match(redacted, /^ANON_KEY=\[REDACTED\]$/mu);
  assert.match(redacted, /^PROVIDER_AUTH_TOKEN="\[REDACTED\]"$/mu);
  assert.match(redacted, /^API_URL="http:\/\/127\.0\.0\.1:54321"$/mu);
  assert.match(redacted, /^PROJECT_ID="storyops-local"$/mu);
  assert.match(
    redacted,
    /^LOG_MESSAGE="SECRET_KEY is configured; key rotation metadata remains visible\."$/mu,
  );
});

async function createSupabaseSetupFixture({
  networkMetadata,
  publishedHostIps = ['127.0.0.1'],
} = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'storyops-setup-network-'));
  const binDirectory = resolve(directory, 'bin');
  const stackStatePath = resolve(directory, 'started');
  const networkStatePath = resolve(directory, 'network.json');
  const npxLogPath = resolve(directory, 'npx.log');
  const dockerLogPath = resolve(directory, 'docker.log');
  const envFile = resolve(directory, '.env.local');
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
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'info') {
  process.stdout.write('27.0.0\\n');
} else if (args[0] === 'network' && args[1] === 'ls') {
  if (fs.existsSync(process.env.FAKE_DOCKER_NETWORK_STATE)) {
    process.stdout.write(JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_NETWORK_STATE, 'utf8')).Name + '\\n');
  }
} else if (args[0] === 'network' && args[1] === 'create') {
  const option = args[args.indexOf('--opt') + 1];
  const separator = option.indexOf('=');
  const metadata = {
    Name: args.at(-1),
    Driver: args[args.indexOf('--driver') + 1],
    Options: { [option.slice(0, separator)]: option.slice(separator + 1) }
  };
  fs.writeFileSync(process.env.FAKE_DOCKER_NETWORK_STATE, JSON.stringify(metadata));
  process.stdout.write('fake-network-id\\n');
} else if (args[0] === 'network' && args[1] === 'inspect') {
  if (!fs.existsSync(process.env.FAKE_DOCKER_NETWORK_STATE)) process.exit(1);
  process.stdout.write(fs.readFileSync(process.env.FAKE_DOCKER_NETWORK_STATE, 'utf8') + '\\n');
} else if (args[0] === 'ps' && fs.existsSync(process.env.FAKE_SUPABASE_STATE)) {
  process.stdout.write('fake-container\\n');
} else if (args[0] === 'inspect') {
  const bindings = JSON.parse(process.env.FAKE_PUBLISHED_HOST_IPS).map((HostIp) => ({
    HostIp,
    HostPort: '54321'
  }));
  process.stdout.write(JSON.stringify({ '8000/tcp': bindings }) + '\\n');
}
`,
  );
  await chmod(resolve(binDirectory, 'npx'), 0o755);
  await chmod(resolve(binDirectory, 'docker'), 0o755);
  await writeFile(envFile, 'STORYOPS_PROVIDER_MODE=sandbox\nVITE_STORYOPS_DATA_MODE=sandbox\n', {
    mode: 0o600,
  });
  if (networkMetadata) {
    await writeFile(networkStatePath, JSON.stringify(networkMetadata));
  }
  const environment = {
    PATH: `${binDirectory}${delimiter}${process.env.PATH || ''}`,
    FAKE_DOCKER_LOG: dockerLogPath,
    FAKE_DOCKER_NETWORK_STATE: networkStatePath,
    FAKE_NPX_LOG: npxLogPath,
    FAKE_PUBLISHED_HOST_IPS: JSON.stringify(publishedHostIps),
    FAKE_SUPABASE_STATE: stackStatePath,
  };
  const readCalls = (path) => {
    const contents = readFileSync(path, { encoding: 'utf8', flag: 'a+' }).trim();
    if (!contents) return [];
    return contents.split(/\r?\n/u).map((line) => JSON.parse(line));
  };

  return {
    directory,
    dockerCalls: () => readCalls(dockerLogPath),
    envFile,
    environment,
    networkStatePath,
    npxCalls: () => readCalls(npxLogPath),
    npxLogPath,
    stackStatePath,
  };
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

test('setup creates an explicit owner-only environment target under pinned Node', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'storyops-setup-env-target-'));
  const envFile = resolve(directory, 'custom.env');
  try {
    const result = runScript('scripts/setup.mjs', [
      '--skip-install',
      '--storyops-env-file',
      envFile,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`CREATE ${envFile.replaceAll('\\', '\\\\')}`, 'u'));
    assert.match(readFileSync(envFile, 'utf8'), /^STORYOPS_PROVIDER_MODE=sandbox$/mu);
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local Edge contract runner uses an owner-only ephemeral webhook environment file', () => {
  const runner = readFileSync(resolve(repositoryRoot, 'scripts/verify-local-supabase.mjs'), 'utf8');

  assert.match(
    runner,
    /'functions',\s*'serve',\s*'--env-file',\s*environmentFile,\s*'--network-id',\s*LOCAL_SUPABASE_NETWORK/u,
    'Supabase Edge must receive its sandbox webhook secret through the supported env-file boundary on the loopback-only project network.',
  );
  assert.match(
    runner,
    /\{ encoding: 'utf8', flag: 'wx', mode: 0o600 \}/u,
    'The ephemeral Edge environment file must be created exclusively with owner-only permissions.',
  );
  assert.match(
    runner,
    /rmSync\(environmentDirectory, \{ recursive: true, force: true \}\)/u,
    'The ephemeral Edge environment directory must be removed during startup failure and teardown.',
  );
  assert.match(runner, /'db', 'reset', '--local', '--network-id', LOCAL_SUPABASE_NETWORK/u);
  assert.match(runner, /'start', '--ignore-health-check', '--network-id', LOCAL_SUPABASE_NETWORK/u);
  assert.match(runner, /'SCOPE_PHOTO_CLEANUP_MODE=manual'/u);
  assert.match(
    runner,
    /run\(process\.execPath, \['tests\/integration\/scope-photo-cleanup-edge\.mjs'\]\)/u,
    'The release contract must exercise the dedicated scope-photo cleanup credential at the real Edge boundary.',
  );
  assert.match(
    runner,
    /run\(process\.execPath, \['tests\/integration\/scheduling-suggestions-edge\.mjs'\]\)/u,
    'The release contract must exercise ranked scheduling suggestions and their fail-closed role/version boundary at the real Edge runtime.',
  );
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

test('signed inbound lead intake documents and retains both live switches', () => {
  const result = runScript('scripts/setup.mjs', ['--check', '--skip-install'], {
    LEAD_INTAKE_MODE: 'live',
    LEAD_INTAKE_LIVE_ENABLED: 'true',
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
  const template = readFileSync(resolve(repositoryRoot, '.env.example'), 'utf8');
  const activation = readFileSync(
    resolve(repositoryRoot, 'supabase/functions/lead-intake/activation.ts'),
    'utf8',
  );
  assert.match(template, /^LEAD_INTAKE_MODE=sandbox$/mu);
  assert.match(template, /^LEAD_INTAKE_LIVE_ENABLED=false$/mu);
  assert.match(activation, /LEAD_INTAKE_LIVE_ENABLED/u);
  assert.match(activation, /LEAD_INTAKE_MODE/u);
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
    'tests/integration/scheduling-suggestions-edge.mjs',
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
      '--storyops-env-file',
      envFile,
    ]);
    assert.equal(regular.status, 0, regular.stderr);
    assert.match(
      regular.stdout,
      /\bnpx --yes supabase@2\.110\.0 start --network-id storyops-ai-supabase-loopback\b/u,
    );
    assert.match(
      regular.stdout,
      /PLAN ensure dedicated Docker network storyops-ai-supabase-loopback uses bridge driver with com\.docker\.network\.bridge\.host_binding_ipv4=127\.0\.0\.1/u,
    );
    assert.match(
      regular.stdout,
      /\bdocker network create --driver bridge --opt com\.docker\.network\.bridge\.host_binding_ipv4=127\.0\.0\.1 storyops-ai-supabase-loopback\b/u,
    );
    assert.match(regular.stdout, /\bnpm run test:supabase\b/u);
    assert.doesNotMatch(regular.stdout, /test:supabase -- --reset/u);

    const reset = runScript('scripts/setup.mjs', [
      '--dry-run',
      '--skip-install',
      '--with-supabase',
      '--verify',
      '--reset-supabase',
      '--storyops-env-file',
      envFile,
    ]);
    assert.equal(reset.status, 0, reset.stderr);
    assert.match(reset.stdout, /\bnpm run test:supabase -- --reset\b/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'setup creates a deterministic loopback-only Supabase Docker network',
  { skip: process.platform === 'win32' },
  async () => {
    const fixture = await createSupabaseSetupFixture();
    try {
      const result = runScript(
        'scripts/setup.mjs',
        ['--skip-install', '--with-supabase', '--storyops-env-file', fixture.envFile],
        fixture.environment,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(fixture.networkStatePath, 'utf8')), {
        Name: 'storyops-ai-supabase-loopback',
        Driver: 'bridge',
        Options: {
          'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1',
        },
      });
      assert.ok(
        fixture
          .dockerCalls()
          .some(
            (call) =>
              JSON.stringify(call) ===
              JSON.stringify([
                'network',
                'create',
                '--driver',
                'bridge',
                '--opt',
                'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
                'storyops-ai-supabase-loopback',
              ]),
          ),
      );
      assert.deepEqual(fixture.npxCalls(), [
        ['--yes', 'supabase@2.110.0', 'start', '--network-id', 'storyops-ai-supabase-loopback'],
      ]);
      assert.match(result.stdout, /OK Supabase Docker ports are loopback-only/u);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
);

test(
  'setup reuses an exactly compatible dedicated Supabase Docker network',
  { skip: process.platform === 'win32' },
  async () => {
    const fixture = await createSupabaseSetupFixture({
      networkMetadata: {
        Name: 'storyops-ai-supabase-loopback',
        Driver: 'bridge',
        Options: {
          'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1',
        },
      },
    });
    try {
      const result = runScript(
        'scripts/setup.mjs',
        ['--skip-install', '--with-supabase', '--storyops-env-file', fixture.envFile],
        fixture.environment,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        fixture.dockerCalls().some((call) => call[0] === 'network' && call[1] === 'create'),
        false,
      );
      assert.equal(
        fixture.dockerCalls().some((call) => call[0] === 'network' && call[1] === 'inspect'),
        true,
      );
      assert.deepEqual(fixture.npxCalls(), [
        ['--yes', 'supabase@2.110.0', 'start', '--network-id', 'storyops-ai-supabase-loopback'],
      ]);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
);

test(
  'setup rejects an existing Supabase Docker network with the wrong driver or binding option',
  { skip: process.platform === 'win32' },
  async () => {
    for (const networkMetadata of [
      {
        Name: 'storyops-ai-supabase-loopback',
        Driver: 'host',
        Options: {
          'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1',
        },
      },
      {
        Name: 'storyops-ai-supabase-loopback',
        Driver: 'bridge',
        Options: {
          'com.docker.network.bridge.host_binding_ipv4': '0.0.0.0',
        },
      },
    ]) {
      const fixture = await createSupabaseSetupFixture({ networkMetadata });
      try {
        const result = runScript(
          'scripts/setup.mjs',
          [
            '--skip-install',
            '--with-supabase',
            '--unsafe-allow-wildcard-supabase-ports',
            '--storyops-env-file',
            fixture.envFile,
          ],
          fixture.environment,
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Refusing Docker network storyops-ai-supabase-loopback/u);
        assert.deepEqual(fixture.npxCalls(), []);
      } finally {
        await rm(fixture.directory, { recursive: true, force: true });
      }
    }
  },
);

test(
  'setup stops a just-started Supabase stack with wildcard ports unless explicitly overridden',
  { skip: process.platform === 'win32' },
  async () => {
    const fixture = await createSupabaseSetupFixture({
      networkMetadata: {
        Name: 'storyops-ai-supabase-loopback',
        Driver: 'bridge',
        Options: {
          'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1',
        },
      },
      publishedHostIps: ['0.0.0.0', '::'],
    });
    try {
      const blocked = runScript(
        'scripts/setup.mjs',
        ['--skip-install', '--with-supabase', '--storyops-env-file', fixture.envFile],
        fixture.environment,
      );
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /non-loopback Docker binding/u);
      assert.deepEqual(fixture.npxCalls(), [
        ['--yes', 'supabase@2.110.0', 'start', '--network-id', 'storyops-ai-supabase-loopback'],
        [
          '--yes',
          'supabase@2.110.0',
          'stop',
          '--no-backup',
          '--network-id',
          'storyops-ai-supabase-loopback',
        ],
      ]);
      await assert.rejects(stat(fixture.stackStatePath), { code: 'ENOENT' });

      await writeFile(fixture.npxLogPath, '');
      const allowed = runScript(
        'scripts/setup.mjs',
        [
          '--skip-install',
          '--with-supabase',
          '--unsafe-allow-wildcard-supabase-ports',
          '--storyops-env-file',
          fixture.envFile,
        ],
        fixture.environment,
      );
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.match(allowed.stderr, /explicit unsafe override accepted/u);
      assert.deepEqual(fixture.npxCalls(), [
        ['--yes', 'supabase@2.110.0', 'start', '--network-id', 'storyops-ai-supabase-loopback'],
      ]);
      assert.equal(await stat(fixture.stackStatePath).then((metadata) => metadata.isFile()), true);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
);

test('isolated upgrade rehearsal uses and verifies a loopback-only Docker network', () => {
  const source = readFileSync(
    resolve(repositoryRoot, 'tests/integration/field-media-canary-upgrade.mjs'),
    'utf8',
  );
  assert.match(source, /const LOOPBACK_NETWORK = `\$\{PROJECT_ID\}-supabase-loopback`;/u);
  assert.match(source, /com\.docker\.network\.bridge\.host_binding_ipv4[\s\S]*127\.0\.0\.1/u);
  assert.match(source, /'start',\s*'--ignore-health-check',\s*'--network-id',\s*LOOPBACK_NETWORK/u);
  assert.match(source, /'stop',\s*'--no-backup',\s*'--network-id',\s*LOOPBACK_NETWORK/u);
  assert.match(source, /unsafePublishedDockerBindings\(/u);
  assert.match(source, /assertLoopbackBindings\(\);/u);
});

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
  assert.equal(
    (
      dockerfile.match(
        /FROM node:22\.22\.3-alpine3\.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8/gu,
      ) ?? []
    ).length,
    2,
  );
});

test('root optional Rollup natives cover Alpine images and Ubuntu CI', () => {
  const pkg = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(readFileSync(resolve(repositoryRoot, 'package-lock.json'), 'utf8'));
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  const dockerfile = readFileSync(resolve(repositoryRoot, 'Dockerfile'), 'utf8');
  const optional = pkg.optionalDependencies ?? {};
  const rootOptional = lockfile.packages?.['']?.optionalDependencies ?? {};

  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.match(dockerfile, /node:22\.22\.3-alpine3\.22/u);
  assert.equal(optional['@rollup/rollup-linux-x64-gnu'], '4.62.3');
  assert.equal(optional['@rollup/rollup-linux-x64-musl'], '4.62.3');
  assert.equal(optional['@rollup/rollup-linux-arm64-gnu'], '4.62.3');
  assert.equal(optional['@rollup/rollup-linux-arm64-musl'], '4.62.3');
  assert.equal(rootOptional['@rollup/rollup-linux-x64-gnu'], '4.62.3');
  assert.equal(rootOptional['@rollup/rollup-linux-x64-musl'], '4.62.3');
  assert.equal(rootOptional['@rollup/rollup-linux-arm64-gnu'], '4.62.3');
  assert.equal(rootOptional['@rollup/rollup-linux-arm64-musl'], '4.62.3');

  for (const name of [
    '@rollup/rollup-linux-x64-gnu',
    '@rollup/rollup-linux-x64-musl',
    '@rollup/rollup-linux-arm64-gnu',
    '@rollup/rollup-linux-arm64-musl',
  ]) {
    const entry = lockfile.packages?.[`node_modules/${name}`];
    assert.equal(entry?.version, '4.62.3', `${name} must be lock-pinned`);
    assert.equal(entry?.optional, true, `${name} must remain optional`);
    assert.match(
      entry?.resolved ?? '',
      new RegExp(`${name.slice(name.lastIndexOf('/') + 1)}-4\\.62\\.3\\.tgz$`, 'u'),
    );
    assert.match(entry?.integrity ?? '', /^sha512-/u);
  }

  if (process.platform === 'linux') {
    const libc = detectLinuxLibcFamily();
    const nativeName = requiredLinuxRollupNativeName();
    assert.equal(libc === 'gnu' || libc === 'musl', true);
    assert.equal(assertLinuxRollupNativeInstalled(repositoryRoot), nativeName);
    assert.equal(existsSync(resolve(repositoryRoot, 'node_modules', nativeName)), true);
  }
});

const MAIN_BFD980A_UNEXECUTED_JOBS = {
  jobs: [
    {
      name: 'Locked install, audit, tests, build',
      conclusion: 'failure',
      runner_name: '',
      runner_group_name: '',
      started_at: '2026-08-27T05:36:13Z',
      completed_at: '2026-08-27T05:36:15Z',
      steps: [],
    },
    {
      name: 'Supabase migration, seed, and lint',
      conclusion: 'failure',
      runner_name: '',
      runner_group_name: '',
      started_at: '2026-08-27T05:36:13Z',
      completed_at: '2026-08-27T05:36:15Z',
      steps: [],
    },
    {
      name: 'Desktop and mobile golden path',
      conclusion: 'skipped',
      runner_name: null,
      runner_group_name: null,
      started_at: '2026-08-27T05:36:16Z',
      completed_at: '2026-08-27T05:36:15Z',
      steps: [],
    },
  ],
};

test('hosted CI classifier refuses to treat empty Ubuntu jobs as a test result', () => {
  const emptyFailure = classifyHostedJob(MAIN_BFD980A_UNEXECUTED_JOBS.jobs[0]);
  assert.equal(emptyFailure.status, HOSTED_CI_VERDICTS.UNEXECUTED);
  assert.equal(emptyFailure.executed, false);
  assert.match(emptyFailure.reason ?? '', /not a test pass or a product-test failure/u);

  const falseSuccess = classifyHostedJob({
    name: 'Locked install, audit, tests, build',
    conclusion: 'success',
    runner_name: '',
    steps: [],
  });
  assert.equal(falseSuccess.status, HOSTED_CI_VERDICTS.UNEXECUTED);
  assert.notEqual(falseSuccess.status, HOSTED_CI_VERDICTS.EXECUTED_PASS);

  const executedFailure = classifyHostedJob({
    name: 'Locked install, audit, tests, build',
    conclusion: 'failure',
    runner_name: 'GitHub Actions 1000000000000000000',
    steps: [{ name: 'Prove this Ubuntu runner claimed the job', conclusion: 'failure' }],
  });
  assert.equal(executedFailure.status, HOSTED_CI_VERDICTS.EXECUTED_FAIL);
  assert.equal(executedFailure.executed, true);

  const executedPass = classifyHostedJob({
    name: 'Locked install, audit, tests, build',
    conclusion: 'success',
    runner_name: 'GitHub Actions 1000000000000000000',
    steps: [{ name: 'Prove this Ubuntu runner claimed the job', conclusion: 'success' }],
  });
  assert.equal(executedPass.status, HOSTED_CI_VERDICTS.EXECUTED_PASS);
  assert.equal(executedPass.executed, true);

  const run = classifyHostedRun(MAIN_BFD980A_UNEXECUTED_JOBS);
  assert.equal(run.verdict, HOSTED_CI_VERDICTS.UNEXECUTED);
  assert.equal(HOSTED_CI_EXIT_CODES[run.verdict], 2);
  assert.equal(run.jobs.map((job) => job.status).join(','), 'unexecuted,unexecuted,skipped');

  assert.equal(classifyHostedRun({ jobs: [] }).verdict, HOSTED_CI_VERDICTS.UNPROVEN);
  assert.equal(classifyHostedRun({}).verdict, HOSTED_CI_VERDICTS.UNPROVEN);
  assert.equal(classifyHostedJob(null).status, HOSTED_CI_VERDICTS.UNPROVEN);
});

test('hosted CI run classifier preserves the strongest mixed job truth', () => {
  const executedPass = {
    name: 'Executed pass',
    conclusion: 'success',
    runner_name: 'GitHub Actions 1000000000000000000',
    steps: [{ name: 'Executed step', conclusion: 'success' }],
  };
  const executedFailure = {
    name: 'Executed failure',
    conclusion: 'failure',
    runner_name: 'GitHub Actions 1000000000000000000',
    steps: [{ name: 'Executed step', conclusion: 'failure' }],
  };
  const unexecuted = {
    name: 'Unclaimed runner',
    conclusion: 'failure',
    runner_name: '',
    steps: [],
  };
  const skipped = {
    name: 'Skipped dependency',
    conclusion: 'skipped',
    runner_name: null,
    steps: [],
  };
  const unproven = {
    name: 'Unknown conclusion',
    conclusion: 'cancelled',
    runner_name: 'GitHub Actions 1000000000000000000',
    steps: [{ name: 'Started step', conclusion: 'cancelled' }],
  };

  const failedWithUnexecuted = classifyHostedRun({ jobs: [executedFailure, unexecuted] });
  assert.equal(failedWithUnexecuted.verdict, HOSTED_CI_VERDICTS.EXECUTED_FAIL);
  assert.equal(HOSTED_CI_EXIT_CODES[failedWithUnexecuted.verdict], 1);
  assert.match(failedWithUnexecuted.reason ?? '', /Other job states do not erase/u);

  const failedWithUnproven = classifyHostedRun({ jobs: [unproven, executedFailure] });
  assert.equal(failedWithUnproven.verdict, HOSTED_CI_VERDICTS.EXECUTED_FAIL);

  const passWithUnexecuted = classifyHostedRun({ jobs: [executedPass, unexecuted] });
  assert.equal(passWithUnexecuted.verdict, HOSTED_CI_VERDICTS.UNEXECUTED);
  assert.equal(HOSTED_CI_EXIT_CODES[passWithUnexecuted.verdict], 2);

  const passWithSkipped = classifyHostedRun({ jobs: [executedPass, skipped] });
  assert.equal(passWithSkipped.verdict, HOSTED_CI_VERDICTS.SKIPPED);
  assert.equal(HOSTED_CI_EXIT_CODES[passWithSkipped.verdict], 3);
  assert.match(passWithSkipped.reason ?? '', /not a complete hosted test pass/u);

  assert.equal(
    classifyHostedRun({ jobs: [executedPass, { ...executedPass, name: 'Another pass' }] }).verdict,
    HOSTED_CI_VERDICTS.EXECUTED_PASS,
  );
});

test('hosted CI classifier CLI fail-closes empty Ubuntu job records', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'storyops-hosted-ci-'));
  const jobsFile = resolve(directory, 'jobs.json');
  try {
    await writeFile(jobsFile, JSON.stringify(MAIN_BFD980A_UNEXECUTED_JOBS), { mode: 0o600 });
    const emptyRun = runScript('infra/scripts/ci-build-honesty.mjs', ['--jobs-file', jobsFile]);
    assert.equal(emptyRun.status, 2);
    assert.match(emptyRun.stderr, /unexecuted, not a test result/u);
    const parsed = JSON.parse(emptyRun.stdout);
    assert.equal(parsed.verdict, HOSTED_CI_VERDICTS.UNEXECUTED);

    await writeFile(
      jobsFile,
      JSON.stringify({
        jobs: [
          {
            name: 'Executed failure',
            conclusion: 'failure',
            runner_name: 'GitHub Actions 1000000000000000000',
            steps: [{ name: 'Executed step', conclusion: 'failure' }],
          },
          MAIN_BFD980A_UNEXECUTED_JOBS.jobs[0],
        ],
      }),
      { mode: 0o600 },
    );
    const mixedFailure = runScript('infra/scripts/ci-build-honesty.mjs', ['--jobs-file', jobsFile]);
    assert.equal(mixedFailure.status, 1);
    assert.equal(JSON.parse(mixedFailure.stdout).verdict, HOSTED_CI_VERDICTS.EXECUTED_FAIL);

    await writeFile(
      jobsFile,
      JSON.stringify({
        jobs: [
          {
            name: 'Executed pass',
            conclusion: 'success',
            runner_name: 'GitHub Actions 1000000000000000000',
            steps: [{ name: 'Executed step', conclusion: 'success' }],
          },
          MAIN_BFD980A_UNEXECUTED_JOBS.jobs[2],
        ],
      }),
      { mode: 0o600 },
    );
    const partialRun = runScript('infra/scripts/ci-build-honesty.mjs', ['--jobs-file', jobsFile]);
    assert.equal(partialRun.status, 3);
    assert.equal(JSON.parse(partialRun.stdout).verdict, HOSTED_CI_VERDICTS.SKIPPED);

    const missing = runScript('infra/scripts/ci-build-honesty.mjs', []);
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /unproven, not a pass/u);

    if (process.platform === 'linux') {
      const native = runScript('infra/scripts/ci-build-honesty.mjs', ['--assert-rollup-native']);
      assert.equal(native.status, 0);
      assert.match(native.stdout, /installed @rollup\/rollup-linux-(?:x64|arm64)-(?:gnu|musl)/u);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality and database jobs stay fail-closed when Ubuntu never claims a runner', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  const quality = workflow.match(/ {2}quality:[\s\S]*?(?=\n  [a-z])/u)?.[0];
  const database = workflow.match(/ {2}database:[\s\S]*$/u)?.[0];
  const e2e = workflow.match(/ {2}e2e:[\s\S]*?(?=\n  [a-z])/u)?.[0];
  assert.ok(quality && database && e2e, 'CI job blocks must remain parseable.');
  assert.doesNotMatch(quality, /^\s+needs:/mu);
  assert.doesNotMatch(database, /^\s+needs:/mu);
  assert.match(e2e, /^\s+needs: quality$/mu);
  assert.equal(
    (workflow.match(/- name: Prove this Ubuntu runner claimed the job/gu) ?? []).length,
    3,
  );
  assert.match(
    quality,
    /- name: Fail closed if this glibc host skipped the GNU Rollup native\n\s+run: npm run check:hosted-ci -- --assert-rollup-native/u,
  );
  assert.match(
    workflow,
    /unexecuted[\s\S]*Do not treat that red X as a test pass or as a product-test failure/u,
  );
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
    'infra/vroom/runtime-package/NPM_THIRD_PARTY_NOTICES.txt',
  ]) {
    assert.match(artifactStep, new RegExp(`^\\s+${requiredPath.replaceAll('.', '\\.')}$`, 'mu'));
  }
  assert.match(workflow, /- name: Check formatting\s+run: npm run format:check/u);
  assert.match(workflow, /- name: Run AI evaluations\s+run: npm run eval:ai/u);
  assert.match(
    workflow,
    /- name: Install Playwright browsers\s+run: npx playwright install --with-deps chromium webkit/u,
  );
  assert.match(
    workflow,
    /- name: Run disposable migration upgrade rehearsal\s+run: npm run test:upgrade/u,
  );
});

test('CI and operator docs keep local Supabase on the reviewed loopback network', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  const backupRunbook = readFileSync(
    resolve(repositoryRoot, 'docs/compliance/BACKUP-RESTORE.md'),
    'utf8',
  );
  const developerGuide = readFileSync(resolve(repositoryRoot, 'docs/DEVELOPER_GUIDE.md'), 'utf8');
  assert.match(
    workflow,
    /node scripts\/setup\.mjs --skip-install --with-supabase --storyops-env-file \.env\.local/u,
  );
  assert.doesNotMatch(
    workflow,
    /node scripts\/setup\.mjs[^\n]*\s--env-file(?:\s|=)/u,
    'Node 22 reserves --env-file and consumes it before setup.mjs can create the target.',
  );
  assert.match(workflow, /--network-id storyops-ai-supabase-loopback/u);
  assert.doesNotMatch(workflow, /run:\s*npx --yes supabase@2\.110\.0 start\s*$/mu);
  assert.match(backupRunbook, /com\.docker\.network\.bridge\.host_binding_ipv4=127\.0\.0\.1/u);
  assert.match(backupRunbook, /--network-id storyops-restore-loopback/u);
  assert.match(developerGuide, /--network-id storyops-ai-supabase-loopback/u);
});

test('demo proof binds source identity and removes developer absolute paths', () => {
  const source = readFileSync(resolve(repositoryRoot, 'scripts/demo-proof.mjs'), 'utf8');
  assert.match(source, /format: 'storyops-demo-proof-v2'/u);
  assert.match(source, /sourceRevision: revision\.stdout\.trim\(\)/u);
  assert.match(source, /sourceTreeCleanAtStart: status\.stdout\.trim\(\) === ''/u);
  assert.match(source, /\.replaceAll\(REPO_ROOT, '<REPO_ROOT>'\)/u);
  assert.match(source, /\.replaceAll\(homedir\(\), '<HOME>'\)/u);
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
  const storagePolicies = extractStoryOpsStoragePolicyDump(
    [
      `CREATE POLICY "company_assets_owner_insert" ON "storage"."objects" FOR INSERT WITH CHECK (("bucket_id" = 'company-assets') AND "public"."lock_storyops_active_company"(null) AND "public"."has_company_role"(null, null));`,
      `CREATE POLICY "company_assets_owner_update" ON "storage"."objects" FOR UPDATE USING (("bucket_id" = 'company-assets') AND "public"."lock_storyops_active_company"(null) AND "public"."has_company_role"(null, null)) WITH CHECK (("bucket_id" = 'company-assets'));`,
      `CREATE POLICY "company_assets_select" ON "storage"."objects" FOR SELECT USING (("bucket_id" = 'company-assets') AND "public"."has_company_role"(null, null));`,
      `CREATE POLICY "job_media_insert" ON "storage"."objects" FOR INSERT WITH CHECK (("bucket_id" = 'job-media') AND "public"."can_upload_job_media_object"("name"));`,
      `CREATE POLICY "job_media_select" ON "storage"."objects" FOR SELECT USING (("bucket_id" = 'job-media') AND ("public"."can_read_job_media_object"("name") OR "public"."can_upload_job_media_object"("name")));`,
      `CREATE POLICY "sds_owner_insert" ON "storage"."objects" FOR INSERT WITH CHECK (("bucket_id" = 'sds') AND "public"."can_upload_storyops_sds_object"("name"));`,
      `CREATE POLICY "sds_select" ON "storage"."objects" FOR SELECT USING (("bucket_id" = 'sds') AND "public"."has_company_role"(null, null));`,
    ].join('\n'),
  ).sql;
  const contents = new Map([
    ['roles.sql', '-- roles\n'],
    ['schema.sql', 'create table public.example(id bigint);\n'],
    ['storage-policies.sql', storagePolicies],
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
        format: 'storyops-supabase-logical-v2',
        createdAt: new Date().toISOString(),
        database: {
          source: {
            host: 'source.example.test',
            port: '5432',
            database: 'storyops',
            user: 'operator',
            local: false,
            systemIdentifier: '7668118205518053419',
            serverObservedAt: '2026-07-30T12:00:00.000Z',
          },
          dumpStartedAt: '2026-07-30T12:00:00.000Z',
          dumpCompletedAt: '2026-07-30T12:00:01.000Z',
          dataExclusions: REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS,
          dataSchemas: REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS,
          files,
        },
        storage: {
          included: false,
          sourceHost: null,
          exportStartedAt: null,
          exportCompletedAt: null,
          crossServiceAtomicWithDatabase: false,
          bucketCount: 0,
          objectCount: 0,
          objectBytes: 0,
          buckets: [],
          objects: [],
        },
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
    assert.match(result.stdout, /Validated: 4 database files/u);
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
  assert.equal(
    (
      dockerfile.match(
        /FROM ubuntu:24\.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.match(
    dockerfile,
    /FROM node:22\.22\.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS node-runtime/u,
  );
  assert.match(compose, /43dd7d0b8b560431eb555bf335cf4797eb7343c4/u);
});

test('VROOM runtime notices are generated from its exact lock and shipped in the image', () => {
  const dockerfile = readFileSync(resolve(repositoryRoot, 'infra/vroom/Dockerfile'), 'utf8');
  const generator = readFileSync(
    resolve(repositoryRoot, 'scripts/generate-npm-notices.mjs'),
    'utf8',
  );
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  const lock = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'infra/vroom/runtime-package/package-lock.json'), 'utf8'),
  );
  const notices = readFileSync(
    resolve(repositoryRoot, 'infra/vroom/runtime-package/NPM_THIRD_PARTY_NOTICES.txt'),
    'utf8',
  );

  assert.match(
    dockerfile,
    /COPY runtime-package\/NPM_THIRD_PARTY_NOTICES\.txt \/usr\/share\/licenses\/vroom-express-runtime\/NPM_THIRD_PARTY_NOTICES\.txt/u,
  );
  assert.match(generator, /infra\/vroom\/runtime-package\/package-lock\.json/u);
  assert.match(generator, /infra\/vroom\/runtime-package\/NPM_THIRD_PARTY_NOTICES\.txt/u);
  assert.match(generator, /\['cookie-signature@1\.0\.6', \['Readme\.md'\]\]/u);
  assert.match(workflow, /run: npm run install:vroom-runtime/u);
  assert.match(
    workflow,
    /run: npm audit --prefix infra\/vroom\/runtime-package --audit-level=high/u,
  );

  const cookieSignature = lock.packages['node_modules/cookie-signature'];
  assert.equal(cookieSignature.version, '1.0.6');
  assert.equal(cookieSignature.license, 'MIT');
  assert.equal(
    cookieSignature.integrity,
    'sha512-QADzlaHc8icV8I7vbaJXJwod9HWYp8uCqf1xa4OfNu1T7JVxQIrUgOWtHdNDtPiywmFbiS12VjotIXLrKM3orQ==',
  );
  assert.match(
    notices,
    /^Lockfile: infra\/vroom\/runtime-package\/package-lock\.json \(lockfileVersion 3\)$/mu,
  );
  assert.match(notices, /^Packages with UNKNOWN declared license metadata: 0$/mu);
  assert.match(notices, /^Lock entries with UNKNOWN resolved artifact URL: 0$/mu);
  assert.match(notices, /^Lock entries with UNKNOWN integrity hash: 0$/mu);
  assert.match(
    notices,
    /^Installed non-optional packages with no captured license\/notice material: 0$/mu,
  );
  assert.match(notices, /^Explicit supplemental notice sources: 1$/mu);
  assert.match(notices, /^cookie-signature@1\.0\.6$/mu);
  assert.match(
    notices,
    /Package: cookie-signature@1\.0\.6; installed file\(s\): infra\/vroom\/runtime-package\/node_modules\/cookie-signature\/Readme\.md/u,
  );
  assert.match(notices, /Copyright \(c\) 2012 LearnBoost &lt;tj@learnboost\.com&gt;/u);
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
