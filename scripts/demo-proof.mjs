#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  REPO_ROOT,
  hasFlag,
  optionValue,
  printErrorAndExit,
  runCommand,
  unknownOptions,
} from '../infra/scripts/common.mjs';

const argv = process.argv.slice(2);
const dryRun = hasFlag(argv, '--dry-run');
const quick = hasFlag(argv, '--quick');
const skipE2e = hasFlag(argv, '--skip-e2e') || quick;
const withVroom = hasFlag(argv, '--with-vroom');
const baseUrl = optionValue(argv, '--base-url');
const reportPath = resolve(
  optionValue(
    argv,
    '--report',
    resolve(
      REPO_ROOT,
      'artifacts',
      `demo-proof-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`,
    ),
  ),
);

const results = [];
const startedAt = new Date().toISOString();
let sourceEvidence;

function usage() {
  process.stdout.write(`StoryOps AI executable demo proof

Usage:
  node scripts/demo-proof.mjs [options]

Options:
  --quick             Run setup checks, infra integration tests, unit tests, build
  --skip-e2e          Skip Playwright (recorded in the proof report)
  --base-url URL      Smoke-test an already running StoryOps web application
  --with-vroom        Exercise an already running VROOM custom-matrix route
  --report PATH       Write the machine-readable proof report to a new file
  --dry-run           Print all local commands without running or writing
  --help              Show this help

Default mode runs lint, typecheck, unit tests, infra integration tests, build,
and every Playwright project. It requires no provider credentials.
`);
}

async function recordStep(name, action) {
  const start = performance.now();
  process.stdout.write(`\n[proof] ${name}\n`);
  try {
    const detail = await action();
    results.push({
      name,
      status: dryRun ? 'planned' : 'passed',
      durationMs: Math.round(performance.now() - start),
      detail: artifactSafeValue(detail || null),
    });
  } catch (error) {
    results.push({
      name,
      status: 'failed',
      durationMs: Math.round(performance.now() - start),
      error: artifactSafeText(error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }
}

function artifactSafeText(value) {
  return String(value).replaceAll(REPO_ROOT, '<REPO_ROOT>').replaceAll(homedir(), '<HOME>');
}

function artifactSafeValue(value) {
  if (typeof value === 'string') return artifactSafeText(value);
  if (Array.isArray(value)) return value.map(artifactSafeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, artifactSafeValue(nested)]),
    );
  }
  return value;
}

async function collectSourceEvidence() {
  if (dryRun) {
    return {
      productVersion: 'planned',
      sourceRevision: 'planned',
      sourceTreeCleanAtStart: null,
    };
  }
  const packageMetadata = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  const revision = await runCommand({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    capture: true,
  });
  const status = await runCommand({
    command: 'git',
    args: ['status', '--porcelain=v1', '--untracked-files=all'],
    capture: true,
  });
  return {
    productVersion: String(packageMetadata.version),
    sourceRevision: revision.stdout.trim(),
    sourceTreeCleanAtStart: status.stdout.trim() === '',
  };
}

function npmCommand(args, environment = process.env) {
  return runCommand({
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    env: environment,
    dryRun,
  });
}

async function hasE2eTests() {
  const directory = resolve(REPO_ROOT, 'tests/e2e');
  if (!existsSync(directory)) return false;
  const entries = await readdir(directory, { recursive: true });
  return entries.some((entry) => /\.(spec|test)\.[cm]?[jt]sx?$/u.test(entry));
}

async function checkApplication(url) {
  if (dryRun) return { url, request: 'GET' };
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Application smoke test returned HTTP ${response.status}.`);
  if (!/StoryOps AI|id=["']root["']/iu.test(body)) {
    throw new Error('Application smoke test did not return the StoryOps shell.');
  }
  return { url, status: response.status, bytes: Buffer.byteLength(body) };
}

async function checkVroom() {
  const vroomUrl = process.env.VROOM_URL || 'http://127.0.0.1:3000';
  if (dryRun) return { url: vroomUrl, request: 'health plus deterministic custom matrix' };
  const health = await fetch(`${vroomUrl.replace(/\/$/u, '')}/health`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!health.ok) throw new Error(`VROOM health returned HTTP ${health.status}.`);

  const problem = {
    jobs: [{ id: 101, location_index: 1, service: 300 }],
    vehicles: [
      {
        id: 7,
        profile: 'car',
        start_index: 0,
        end_index: 0,
        time_window: [0, 7_200],
      },
    ],
    matrices: {
      car: {
        durations: [
          [0, 600],
          [600, 0],
        ],
        distances: [
          [0, 8_000],
          [8_000, 0],
        ],
      },
    },
  };
  const response = await fetch(vroomUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(problem),
    signal: AbortSignal.timeout(10_000),
  });
  const solution = await response.json();
  if (!response.ok || solution.code !== 0 || solution.routes?.length !== 1) {
    throw new Error(
      `VROOM custom-matrix proof failed: HTTP ${response.status}, code ${String(solution.code)}.`,
    );
  }
  const jobStep = solution.routes[0].steps?.find((step) => step.job === 101);
  if (!jobStep) throw new Error('VROOM solution omitted the required job.');
  return {
    url: vroomUrl,
    code: solution.code,
    routes: solution.routes.length,
    unassigned: solution.unassigned?.length || 0,
    durationSeconds: solution.summary?.duration,
    distanceMeters: solution.summary?.distance,
  };
}

async function writeReport(status, error) {
  if (dryRun) return;
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  const report = {
    format: 'storyops-demo-proof-v2',
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    sourceEvidence,
    mode: quick ? 'quick' : 'full',
    sandbox: true,
    e2eSkipped: skipE2e,
    providerCredentialsUsed: false,
    results,
    error: error ? artifactSafeText(error instanceof Error ? error.message : String(error)) : null,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  process.stdout.write(`\nProof report: ${reportPath}\n`);
}

async function main() {
  if (hasFlag(argv, '--help')) {
    usage();
    return;
  }
  const unknown = unknownOptions(
    argv,
    ['--help', '--quick', '--skip-e2e', '--with-vroom', '--dry-run'],
    ['--base-url', '--report'],
  );
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(', ')}`);
  sourceEvidence = await collectSourceEvidence();

  const sandboxEnvironment = {
    ...process.env,
    STORYOPS_PROVIDER_MODE: 'sandbox',
    OPENAI_MODE: 'sandbox',
    TWILIO_MODE: 'sandbox',
    EMAIL_MODE: 'sandbox',
    STRIPE_MODE: 'sandbox',
    GOOGLE_CALENDAR_MODE: 'sandbox',
    MAPS_MODE: 'sandbox',
    WEATHER_MODE: 'sandbox',
    ROUTING_MODE: 'sandbox',
    SIGNED_STORAGE_TARGETS_MODE: 'sandbox',
    QUICKBOOKS_MODE: 'sandbox',
  };

  await recordStep('no-key sandbox prerequisite check', () =>
    runCommand({
      command: process.execPath,
      args: ['scripts/setup.mjs', '--check', '--skip-install'],
      env: sandboxEnvironment,
      dryRun,
    }),
  );
  await recordStep('backup safety dry run', () =>
    runCommand({
      command: process.execPath,
      args: ['scripts/backup.mjs', '--dry-run', '--local'],
      env: sandboxEnvironment,
      dryRun,
    }),
  );
  await recordStep('infra script integration tests', () =>
    npmCommand(['run', 'test:infra'], sandboxEnvironment),
  );

  if (!quick) {
    await recordStep('lint', () => npmCommand(['run', 'lint'], sandboxEnvironment));
    await recordStep('typecheck', () => npmCommand(['run', 'typecheck'], sandboxEnvironment));
  }
  await recordStep('unit and integration test suite', () =>
    npmCommand(['test'], sandboxEnvironment),
  );
  await recordStep('production build', () => npmCommand(['run', 'build'], sandboxEnvironment));

  if (!skipE2e) {
    if (!(await hasE2eTests())) {
      throw new Error(
        'Full proof requires Playwright tests in tests/e2e. Use --skip-e2e only for an explicitly partial proof.',
      );
    }
    await recordStep('Playwright desktop and mobile golden path', () =>
      npmCommand(['run', 'test:e2e'], sandboxEnvironment),
    );
  } else {
    results.push({
      name: 'Playwright desktop and mobile golden path',
      status: 'skipped',
      durationMs: 0,
      detail: 'Explicit --skip-e2e or --quick mode',
    });
  }

  if (baseUrl) {
    await recordStep('running application smoke test', () => checkApplication(baseUrl));
  }
  if (withVroom) {
    await recordStep('VROOM deterministic custom-matrix route', checkVroom);
  }

  if (dryRun) {
    process.stdout.write(
      '\nStoryOps AI demo-proof plan validated; no proof checks were executed.\n',
    );
    return;
  }
  await writeReport('passed');
  process.stdout.write('\nStoryOps AI demo proof passed.\n');
}

main().catch(async (error) => {
  try {
    await writeReport('failed', error);
  } catch (reportError) {
    process.stderr.write(
      `ERROR: unable to write proof report: ${reportError instanceof Error ? reportError.message : String(reportError)}\n`,
    );
  }
  printErrorAndExit(error);
});
