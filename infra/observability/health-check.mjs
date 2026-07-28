#!/usr/bin/env node

import { hasFlag, optionValue, printErrorAndExit, unknownOptions } from '../scripts/common.mjs';

const argv = process.argv.slice(2);

function usage() {
  process.stdout.write(`StoryOps AI health probe

Usage:
  node infra/observability/health-check.mjs [options]

Options:
  --app-url URL       App health endpoint (default: HEALTHCHECK_APP_URL or
                      http://127.0.0.1:8080/healthz)
  --vroom-url URL     Optional VROOM health endpoint
  --require-vroom     Fail when VROOM is omitted or unhealthy
  --timeout-ms MS     Per-check timeout (default: 5000)
  --help              Show help

The probe emits newline-delimited JSON suitable for a scheduler or log alert.
`);
}

async function probe(name, url, required, timeoutMs) {
  const started = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    const result = {
      timestamp: new Date().toISOString(),
      level: response.ok ? 'info' : required ? 'error' : 'warn',
      event: 'health_probe',
      service: name,
      required,
      healthy: response.ok,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
      providerStatus: parsed?.status || parsed?.code || null,
      url: new URL(url).origin,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    const result = {
      timestamp: new Date().toISOString(),
      level: required ? 'error' : 'warn',
      event: 'health_probe',
      service: name,
      required,
      healthy: false,
      status: null,
      durationMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
      url: new URL(url).origin,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
}

async function main() {
  if (hasFlag(argv, '--help')) {
    usage();
    return;
  }
  const unknown = unknownOptions(
    argv,
    ['--help', '--require-vroom'],
    ['--app-url', '--vroom-url', '--timeout-ms'],
  );
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(', ')}`);

  const timeoutMs = Number.parseInt(optionValue(argv, '--timeout-ms', '5000'), 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 60_000) {
    throw new Error('--timeout-ms must be an integer from 250 through 60000.');
  }
  const appUrl = optionValue(
    argv,
    '--app-url',
    process.env.HEALTHCHECK_APP_URL || 'http://127.0.0.1:8080/healthz',
  );
  const requireVroom = hasFlag(argv, '--require-vroom');
  const vroomUrl = optionValue(
    argv,
    '--vroom-url',
    requireVroom ? process.env.HEALTHCHECK_VROOM_URL || 'http://127.0.0.1:3000/health' : undefined,
  );

  const checks = [await probe('storyops-ai-web', appUrl, true, timeoutMs)];
  if (vroomUrl) checks.push(await probe('vroom', vroomUrl, requireVroom, timeoutMs));

  const failedRequired = checks.filter((check) => check.required && !check.healthy);
  const summary = {
    timestamp: new Date().toISOString(),
    level: failedRequired.length > 0 ? 'error' : 'info',
    event: 'health_probe_summary',
    healthy: failedRequired.length === 0,
    checks: checks.length,
    failedRequired: failedRequired.map((check) => check.service),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!summary.healthy) process.exitCode = 1;
}

main().catch(printErrorAndExit);
