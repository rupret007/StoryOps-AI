#!/usr/bin/env node

import { copyFile, mkdir, readFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  REPO_ROOT,
  hasFlag,
  loadEnvironmentFile,
  optionValue,
  printErrorAndExit,
  runCommand,
  supabaseCommand,
  unsafePublishedDockerBindings,
  unknownOptions,
} from '../infra/scripts/common.mjs';

const argv = process.argv.slice(2);
const help = hasFlag(argv, '--help');
const checkOnly = hasFlag(argv, '--check');
const dryRun = hasFlag(argv, '--dry-run');
const skipInstall = hasFlag(argv, '--skip-install') || checkOnly;
const withSupabase = hasFlag(argv, '--with-supabase');
const withRouting = hasFlag(argv, '--with-routing');
const verify = hasFlag(argv, '--verify');
const resetSupabase = hasFlag(argv, '--reset-supabase');
const unsafeAllowWildcardSupabasePorts = hasFlag(argv, '--unsafe-allow-wildcard-supabase-ports');
const envTarget = resolve(REPO_ROOT, optionValue(argv, '--env-file', '.env.local'));

const unknown = unknownOptions(
  argv,
  [
    '--help',
    '--check',
    '--dry-run',
    '--skip-install',
    '--with-supabase',
    '--with-routing',
    '--verify',
    '--reset-supabase',
    '--unsafe-allow-wildcard-supabase-ports',
  ],
  ['--env-file'],
);

function usage() {
  process.stdout.write(`StoryOps AI setup

Usage:
  node scripts/setup.mjs [options]

Options:
  --check             Validate prerequisites and provider configuration only
  --dry-run           Print changes and commands without executing them
  --skip-install      Do not install npm dependencies
  --with-supabase     Start the pinned local Supabase stack
  --with-routing      Build and start the pinned VROOM routing profile
  --verify            Run lint, typecheck, tests, and build after setup
  --reset-supabase    With --with-supabase --verify, rebuild local DB before its release contract
  --unsafe-allow-wildcard-supabase-ports
                      Explicitly allow Docker wildcard bindings for the local Supabase stack
  --env-file PATH     Environment file to create/read (default: .env.local)
  --help              Show this help

No provider keys are required. The generated environment stays in sandbox mode.
`);
}

function numericVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (!match) throw new Error(`Unable to parse runtime version "${value}".`);
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function compareVersion(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function validateNode() {
  const current = numericVersion(process.version);
  const minimum = [22, 22, 3];
  if (compareVersion(current, minimum) < 0 || current[0] >= 23) {
    throw new Error(
      `Node ${process.version} is unsupported. StoryOps AI requires >=22.22.3 and <23; use the version in .nvmrc.`,
    );
  }
  process.stdout.write(`OK Node ${process.version}\n`);
}

async function validateRepository() {
  for (const required of [
    'package.json',
    '.env.example',
    'src',
    'scripts/backup.mjs',
    'scripts/restore.mjs',
  ]) {
    if (!existsSync(resolve(REPO_ROOT, required))) {
      throw new Error(`Required repository path is missing: ${required}`);
    }
  }
  const packageJson = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  if (packageJson.name !== 'storyops-ai') {
    throw new Error('package.json is not the StoryOps AI package.');
  }
  process.stdout.write('OK repository structure\n');
}

function providerMode(name) {
  return (process.env[name] || 'sandbox').trim().toLowerCase();
}

function liveActivationEnabled(modeName, enableFlag) {
  const mode = providerMode(modeName);
  if (!enableFlag) return mode === 'live';
  const flag = (process.env[enableFlag] || 'false').trim().toLowerCase();
  if (!['true', 'false'].includes(flag)) {
    throw new Error(`${enableFlag} must be true or false; received "${flag}".`);
  }
  if ((mode === 'live') !== (flag === 'true')) {
    process.stderr.write(
      `WARNING ${modeName}/${enableFlag} activation is incomplete; the live adapter remains disabled until both ${modeName}=live and ${enableFlag}=true.\n`,
    );
  }
  return mode === 'live' && flag === 'true';
}

function requireLiveEnvironment(modeName, required, enableFlag) {
  const mode = providerMode(modeName);
  if (!['sandbox', 'live', 'disabled'].includes(mode)) {
    throw new Error(`${modeName} must be sandbox, live, or disabled; received "${mode}".`);
  }
  if (!liveActivationEnabled(modeName, enableFlag)) return;
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    const activation = enableFlag ? `${modeName}=live and ${enableFlag}=true` : `${modeName}=live`;
    throw new Error(`${activation} requires: ${missing.join(', ')}.`);
  }
}

function requireLiveEnvironmentAlternatives(modeName, required, alternatives, enableFlag) {
  const mode = providerMode(modeName);
  if (!['sandbox', 'live', 'disabled'].includes(mode)) {
    throw new Error(`${modeName} must be sandbox, live, or disabled; received "${mode}".`);
  }
  if (!liveActivationEnabled(modeName, enableFlag)) return;
  const missingRequired = required.filter((name) => !process.env[name]?.trim());
  const hasAlternative = alternatives.some((group) =>
    group.every((name) => process.env[name]?.trim()),
  );
  if (missingRequired.length > 0 || !hasAlternative) {
    const alternativeDescription = alternatives.map((group) => group.join(' + ')).join(' or ');
    const missingDescription = [...missingRequired];
    if (!hasAlternative) {
      missingDescription.push(`one credential set (${alternativeDescription})`);
    }
    throw new Error(
      `${modeName}=live and ${enableFlag}=true require: ${missingDescription.join(', ')}.`,
    );
  }
}

function validateEnvironment() {
  requireLiveEnvironment('OPENAI_MODE', ['OPENAI_API_KEY', 'OPENAI_MODEL'], 'OPENAI_LIVE_ENABLED');
  requireLiveEnvironment(
    'OPENAI_MODE',
    ['OPENAI_API_KEY', 'OPENAI_VISION_MODEL'],
    'OPENAI_VISION_LIVE_ENABLED',
  );
  requireLiveEnvironment(
    'TWILIO_MODE',
    [
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_SMS_FROM',
      'TWILIO_VOICE_FROM',
      'TWILIO_WEBHOOK_URL',
      'TWILIO_COMPANY_ID',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ],
    'TWILIO_LIVE_ENABLED',
  );
  requireLiveEnvironment('LEAD_INTAKE_MODE', [
    'LEAD_INTAKE_COMPANY_ID',
    'LEAD_INTAKE_SIGNING_SECRET',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);
  requireLiveEnvironment(
    'EMAIL_MODE',
    [
      'EMAIL_PROVIDER',
      'EMAIL_PROVIDER_ENDPOINT',
      'EMAIL_PROVIDER_TOKEN',
      'EMAIL_FROM',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ],
    'EMAIL_LIVE_ENABLED',
  );
  requireLiveEnvironment(
    'STRIPE_MODE',
    [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_CHECKOUT_SUCCESS_URL',
      'STRIPE_CHECKOUT_CANCEL_URL',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ],
    'STRIPE_LIVE_ENABLED',
  );
  requireLiveEnvironmentAlternatives(
    'GOOGLE_CALENDAR_MODE',
    ['GOOGLE_CALENDAR_ID'],
    [
      [
        'GOOGLE_CALENDAR_CLIENT_ID',
        'GOOGLE_CALENDAR_CLIENT_SECRET',
        'GOOGLE_CALENDAR_REFRESH_TOKEN',
      ],
      ['GOOGLE_CALENDAR_ACCESS_TOKEN'],
    ],
    'GOOGLE_CALENDAR_LIVE_ENABLED',
  );
  requireLiveEnvironment('MAPS_MODE', ['GOOGLE_MAPS_API_KEY'], 'MAPS_LIVE_ENABLED');
  requireLiveEnvironment('WEATHER_MODE', ['NWS_USER_AGENT'], 'NWS_LIVE_ENABLED');
  requireLiveEnvironment('ROUTING_MODE', ['VROOM_URL'], 'VROOM_LIVE_ENABLED');
  requireLiveEnvironment(
    'SIGNED_STORAGE_TARGETS_MODE',
    ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STORAGE_BUCKET_JOB_PHOTOS'],
    'SIGNED_STORAGE_TARGETS_LIVE_ENABLED',
  );
  if (
    process.env.STORAGE_BUCKET_JOB_PHOTOS &&
    process.env.STORAGE_BUCKET_JOB_PHOTOS !== 'job-media'
  ) {
    throw new Error(
      'STORAGE_BUCKET_JOB_PHOTOS is fixed to job-media in V1 so field and signed-target boundaries cannot drift.',
    );
  }
  requireLiveEnvironment('QUICKBOOKS_MODE', [], 'QUICKBOOKS_EXPORT_ENABLED');

  if ((process.env.VITE_STORYOPS_DATA_MODE || 'sandbox').toLowerCase() === 'supabase') {
    const missing = [
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_ANON_KEY',
      'VITE_STORYOPS_COMPANY_ID',
    ].filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(`VITE_STORYOPS_DATA_MODE=supabase requires: ${missing.join(', ')}.`);
    }
  }

  const exposedSecrets = Object.keys(process.env).filter(
    (name) =>
      name.startsWith('VITE_') &&
      name !== 'VITE_SUPABASE_ANON_KEY' &&
      /(SECRET|TOKEN|PASSWORD|PRIVATE|SERVICE_ROLE|AUTH_TOKEN|API_KEY)/u.test(name) &&
      process.env[name],
  );
  if (exposedSecrets.length > 0) {
    throw new Error(
      `Browser-exposed variables appear to contain secrets: ${exposedSecrets.join(', ')}.`,
    );
  }
  process.stdout.write(
    `OK provider configuration (${process.env.STORYOPS_PROVIDER_MODE || 'sandbox'} default)\n`,
  );
}

async function ensureEnvironmentFile() {
  if (existsSync(envTarget)) {
    process.stdout.write(`KEEP ${envTarget}\n`);
    loadEnvironmentFile(envTarget);
    return;
  }
  process.stdout.write(`CREATE ${envTarget} from .env.example\n`);
  if (dryRun) return;
  await mkdir(dirname(envTarget), { recursive: true });
  await copyFile(resolve(REPO_ROOT, '.env.example'), envTarget);
  await chmod(envTarget, 0o600);
  loadEnvironmentFile(envTarget);
}

async function installDependencies() {
  if (skipInstall) return;
  if (existsSync(resolve(REPO_ROOT, 'node_modules'))) {
    process.stdout.write('KEEP node_modules (dependencies already installed)\n');
    return;
  }
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = existsSync(resolve(REPO_ROOT, 'package-lock.json')) ? ['ci'] : ['install'];
  await runCommand({ command, args, dryRun });
}

async function ensureDocker() {
  await runCommand({
    command: 'docker',
    args: ['info', '--format', '{{.ServerVersion}}'],
    capture: true,
    dryRun,
  });
}

async function waitForHealth(url, label, timeoutMs = 90_000) {
  if (dryRun) {
    process.stdout.write(`WAIT ${label} health at ${url}\n`);
    return;
  }
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not checked';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) {
        process.stdout.write(`OK ${label} healthy at ${url}\n`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`${label} did not become healthy within ${timeoutMs}ms: ${lastError}`);
}

async function startSupabase() {
  const configPath = resolve(REPO_ROOT, 'supabase/config.toml');
  if (!existsSync(configPath)) {
    throw new Error('supabase/config.toml is required for --with-supabase.');
  }
  await ensureDocker();
  const config = await readFile(configPath, 'utf8');
  const projectId = /^\s*project_id\s*=\s*"([^"]+)"\s*$/mu.exec(config)?.[1];
  if (!projectId || !/^[a-zA-Z0-9_-]+$/u.test(projectId)) {
    throw new Error('supabase/config.toml must contain a safe project_id.');
  }
  const cli = supabaseCommand();
  const containerIds = async () => {
    const result = await runCommand({
      command: 'docker',
      args: [
        'ps',
        '--filter',
        `label=com.supabase.cli.project=${projectId}`,
        '--format',
        '{{.ID}}',
      ],
      capture: true,
      dryRun,
    });
    return result.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
  };
  const before = dryRun ? [] : await containerIds();
  await runCommand({
    command: cli.command,
    args: [...cli.prefix, 'start'],
    dryRun,
  });
  if (dryRun) {
    process.stdout.write(
      'CHECK Supabase Docker port bindings are loopback-only after the pinned start command.\n',
    );
    return;
  }
  const after = await containerIds();
  const justStarted = before.length === 0 && after.length > 0;
  const stopJustStartedStack = async () => {
    if (!justStarted) return;
    await runCommand({
      command: cli.command,
      args: [...cli.prefix, 'stop', '--no-backup'],
    });
  };
  try {
    if (after.length === 0) {
      throw new Error('Supabase start returned without any running project containers.');
    }
    const inspection = await runCommand({
      command: 'docker',
      args: ['inspect', '--format', '{{json .NetworkSettings.Ports}}', ...after],
      capture: true,
    });
    const lines = inspection.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
    if (lines.length !== after.length) {
      throw new Error('Docker returned an incomplete Supabase port-binding inspection.');
    }
    const entries = lines.map((line, index) => {
      try {
        return { containerId: after[index], ports: JSON.parse(line) };
      } catch {
        throw new Error(`Docker returned invalid port metadata for ${after[index]}.`);
      }
    });
    const unsafeBindings = unsafePublishedDockerBindings(entries);
    if (unsafeBindings.length > 0) {
      const summary = unsafeBindings
        .map(
          (binding) =>
            `${binding.containerId}:${binding.containerPort} -> ${binding.hostIp || '*'}:${binding.hostPort || '*'}`,
        )
        .join(', ');
      if (unsafeAllowWildcardSupabasePorts) {
        process.stderr.write(
          `WARNING: explicit unsafe override accepted wildcard Supabase bindings: ${summary}\n`,
        );
      } else {
        throw new Error(
          `Supabase published a non-loopback Docker binding: ${summary}. Reconfigure Docker networking or rerun with --unsafe-allow-wildcard-supabase-ports only after accepting local-network exposure.`,
        );
      }
    } else {
      process.stdout.write('OK Supabase Docker ports are loopback-only\n');
    }
  } catch (error) {
    await stopJustStartedStack();
    throw error;
  }
}

async function startRouting() {
  await ensureDocker();
  await runCommand({
    command: 'docker',
    args: [
      'compose',
      '--env-file',
      envTarget,
      '--profile',
      'routing',
      'up',
      '--detach',
      '--build',
      'vroom',
    ],
    dryRun,
  });
  await waitForHealth(process.env.HEALTHCHECK_VROOM_URL || 'http://127.0.0.1:3000/health', 'VROOM');
}

async function main() {
  if (help) {
    usage();
    return;
  }
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(', ')}`);
  if (checkOnly && (withSupabase || withRouting || verify)) {
    throw new Error('--check cannot be combined with start or verification options.');
  }
  if (resetSupabase && (!withSupabase || !verify)) {
    throw new Error('--reset-supabase requires both --with-supabase and --verify.');
  }
  if (unsafeAllowWildcardSupabasePorts && !withSupabase) {
    throw new Error('--unsafe-allow-wildcard-supabase-ports requires --with-supabase.');
  }

  validateNode();
  await validateRepository();
  if (!checkOnly) await ensureEnvironmentFile();
  else loadEnvironmentFile(envTarget);
  validateEnvironment();
  await installDependencies();

  if (withSupabase) await startSupabase();
  if (withRouting) await startRouting();
  if (verify) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await runCommand({ command: npm, args: ['run', 'verify'], dryRun });
    if (withSupabase) {
      await runCommand({
        command: npm,
        args: ['run', 'test:supabase', ...(resetSupabase ? ['--', '--reset'] : [])],
        dryRun,
      });
    }
  }

  process.stdout.write(
    checkOnly
      ? 'StoryOps AI prerequisite check passed.\n'
      : 'StoryOps AI setup completed. Sandbox mode is ready without provider keys.\n',
  );
}

main().catch(printErrorAndExit);
