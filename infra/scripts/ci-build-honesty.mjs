#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFlag, optionValue, REPO_ROOT, unknownOptions } from './common.mjs';

export const HOSTED_CI_VERDICTS = Object.freeze({
  EXECUTED_PASS: 'executed-pass',
  EXECUTED_FAIL: 'executed-fail',
  UNEXECUTED: 'unexecuted',
  SKIPPED: 'skipped',
  UNPROVEN: 'unproven',
});

export const HOSTED_CI_EXIT_CODES = Object.freeze({
  [HOSTED_CI_VERDICTS.EXECUTED_PASS]: 0,
  [HOSTED_CI_VERDICTS.EXECUTED_FAIL]: 1,
  [HOSTED_CI_VERDICTS.UNEXECUTED]: 2,
  [HOSTED_CI_VERDICTS.UNPROVEN]: 3,
  [HOSTED_CI_VERDICTS.SKIPPED]: 3,
});

function jobName(job) {
  return typeof job?.name === 'string' ? job.name : '';
}

function jobConclusion(job) {
  return typeof job?.conclusion === 'string' ? job.conclusion : null;
}

function claimedRunnerName(job) {
  return typeof job?.runner_name === 'string' ? job.runner_name.trim() : '';
}

function jobSteps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

export function hostedJobExecuted(job) {
  return claimedRunnerName(job).length > 0 && jobSteps(job).length > 0;
}

export function classifyHostedJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return {
      status: HOSTED_CI_VERDICTS.UNPROVEN,
      executed: false,
      name: '',
      reason: 'Job record is missing or malformed. Fail closed; this is not a test pass.',
    };
  }

  const name = jobName(job);
  const conclusion = jobConclusion(job);

  if (conclusion === 'skipped') {
    return {
      status: HOSTED_CI_VERDICTS.SKIPPED,
      executed: false,
      name,
      conclusion,
      reason: 'Job was skipped. That is not a hosted test pass.',
    };
  }

  if (!hostedJobExecuted(job)) {
    return {
      status: HOSTED_CI_VERDICTS.UNEXECUTED,
      executed: false,
      name,
      conclusion,
      reason:
        'Job completed without a runner claim or steps. This is not a test pass or a product-test failure.',
    };
  }

  if (conclusion === 'success') {
    return {
      status: HOSTED_CI_VERDICTS.EXECUTED_PASS,
      executed: true,
      name,
      conclusion,
    };
  }

  if (conclusion === 'failure') {
    return {
      status: HOSTED_CI_VERDICTS.EXECUTED_FAIL,
      executed: true,
      name,
      conclusion,
      reason: 'A claimed runner executed job steps and they failed.',
    };
  }

  return {
    status: HOSTED_CI_VERDICTS.UNPROVEN,
    executed: true,
    name,
    conclusion,
    reason: `Completed job conclusion ${conclusion ?? 'missing'} is not a proven pass. Fail closed.`,
  };
}

export function normalizeHostedJobsPayload(parsed) {
  if (Array.isArray(parsed)) {
    return { jobs: parsed };
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) {
    return parsed;
  }
  return null;
}

export function classifyHostedRun(payload) {
  const normalized = normalizeHostedJobsPayload(payload);
  if (!normalized || normalized.jobs.length === 0) {
    return {
      verdict: HOSTED_CI_VERDICTS.UNPROVEN,
      jobs: [],
      reason: 'No hosted jobs were supplied. Fail closed; this is not a test pass.',
    };
  }

  const jobs = normalized.jobs.map(classifyHostedJob);
  if (jobs.some((job) => job.status === HOSTED_CI_VERDICTS.UNPROVEN)) {
    return {
      verdict: HOSTED_CI_VERDICTS.UNPROVEN,
      jobs,
      reason: 'At least one hosted job could not be proven. Fail closed.',
    };
  }
  if (jobs.some((job) => job.status === HOSTED_CI_VERDICTS.UNEXECUTED)) {
    return {
      verdict: HOSTED_CI_VERDICTS.UNEXECUTED,
      jobs,
      reason:
        'Hosted Ubuntu CI completed without claiming a runner. That red X is unexecuted, not a test result.',
    };
  }
  if (jobs.some((job) => job.status === HOSTED_CI_VERDICTS.EXECUTED_FAIL)) {
    return {
      verdict: HOSTED_CI_VERDICTS.EXECUTED_FAIL,
      jobs,
      reason: 'A claimed Ubuntu runner executed job steps and they failed.',
    };
  }
  if (!jobs.some((job) => job.status === HOSTED_CI_VERDICTS.EXECUTED_PASS)) {
    return {
      verdict: HOSTED_CI_VERDICTS.UNPROVEN,
      jobs,
      reason: 'Every hosted job was skipped. That is not a hosted test pass.',
    };
  }

  return {
    verdict: HOSTED_CI_VERDICTS.EXECUTED_PASS,
    jobs,
  };
}

export function detectLinuxLibcFamily() {
  if (process.platform !== 'linux') {
    return null;
  }

  const glibc = process.report?.getReport?.()?.header?.glibcVersionRuntime;
  if (typeof glibc === 'string' && glibc.length > 0) {
    return 'gnu';
  }

  const ldd = spawnSync('ldd', ['--version'], { encoding: 'utf8' });
  const text = `${ldd.stdout ?? ''}\n${ldd.stderr ?? ''}`;
  if (/\bmusl\b/iu.test(text)) {
    return 'musl';
  }
  if (/\b(?:gnu|glibc)\b/iu.test(text)) {
    return 'gnu';
  }

  throw new Error('Unable to classify this Linux libc as gnu or musl; fail closed.');
}

export function requiredLinuxRollupNativeName({
  arch = process.arch,
  libc = detectLinuxLibcFamily(),
} = {}) {
  if (libc == null) {
    throw new Error('requiredLinuxRollupNativeName is only defined on Linux.');
  }
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!cpu) {
    throw new Error(`Unsupported Linux architecture ${arch}; fail closed.`);
  }
  if (libc !== 'gnu' && libc !== 'musl') {
    throw new Error(`Unsupported Linux libc ${libc}; fail closed.`);
  }
  return `@rollup/rollup-linux-${cpu}-${libc}`;
}

export function installedLinuxRollupNativePath(repositoryRoot = REPO_ROOT) {
  return resolve(repositoryRoot, 'node_modules', requiredLinuxRollupNativeName());
}

export function assertLinuxRollupNativeInstalled(repositoryRoot = REPO_ROOT) {
  if (process.platform !== 'linux') {
    throw new Error(
      `--assert-rollup-native is a Linux install check; this platform is ${process.platform}.`,
    );
  }

  const nativeName = requiredLinuxRollupNativeName();
  const nativeDir = installedLinuxRollupNativePath(repositoryRoot);
  if (!existsSync(nativeDir)) {
    throw new Error(
      `${nativeName} is not installed after npm ci; a lockfile pin alone is not proof. Fail closed.`,
    );
  }
  return nativeName;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJobsJson(text, source) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON.`);
  }
  const normalized = normalizeHostedJobsPayload(parsed);
  if (!normalized) {
    throw new Error(`${source} must be a jobs array or an object with a jobs array.`);
  }
  return normalized;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const unknown = unknownOptions(argv, ['--assert-rollup-native'], ['--jobs-file']);
    if (unknown.length > 0) {
      throw new Error(`Unknown option: ${unknown.join(', ')}`);
    }

    if (hasFlag(argv, '--assert-rollup-native')) {
      const nativeName = assertLinuxRollupNativeInstalled();
      console.log(`installed ${nativeName}`);
      process.exitCode = 0;
      return;
    }

    const jobsFile = optionValue(argv, '--jobs-file', '');
    let source;
    let text;
    if (jobsFile) {
      source = jobsFile;
      text = readFileSync(jobsFile, 'utf8');
    } else if (!process.stdin.isTTY) {
      source = 'stdin';
      text = await readStdin();
      if (text.trim() === '') {
        throw new Error(
          'Supply --jobs-file or JSON on stdin. Missing hosted job records are unproven, not a pass.',
        );
      }
    } else {
      throw new Error(
        'Supply --jobs-file or JSON on stdin. Missing hosted job records are unproven, not a pass.',
      );
    }

    const result = classifyHostedRun(parseJobsJson(text, source));
    console.log(JSON.stringify(result, null, 2));
    if (result.reason) {
      console.error(result.reason);
    }
    process.exitCode = HOSTED_CI_EXIT_CODES[result.verdict] ?? 3;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 3;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
