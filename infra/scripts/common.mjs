import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { access, constants, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SUPABASE_CLI_VERSION = '2.110.0';

export function hasFlag(argv, flag) {
  return argv.includes(flag);
}

export function optionValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function unknownOptions(argv, knownFlags, valuedOptions = []) {
  const allowedFlags = new Set(knownFlags);
  const allowedValues = new Set(valuedOptions);
  const unknown = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    if (allowedFlags.has(argument)) continue;
    if (allowedValues.has(argument)) {
      index += 1;
      continue;
    }
    unknown.push(argument);
  }
  return unknown;
}

export function loadEnvironmentFile(filePath = resolve(REPO_ROOT, '.env.local')) {
  if (!existsSync(filePath)) return {};
  const loaded = {};
  for (const originalLine of readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    loaded[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return loaded;
}

export function parseDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Database URL is invalid. Use a percent-encoded PostgreSQL connection URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Database URL must use the postgres:// or postgresql:// protocol.');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/u, ''));
  if (!parsed.hostname || !database || !parsed.username) {
    throw new Error('Database URL must include a host, database name, and user.');
  }
  const port = parsed.port || '5432';
  const localHosts = new Set(['127.0.0.1', '::1', 'localhost', 'host.docker.internal']);
  return {
    raw: value,
    host: parsed.hostname,
    port,
    database,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    sslMode:
      parsed.searchParams.get('sslmode') ||
      (localHosts.has(parsed.hostname) ? 'disable' : 'require'),
    isLocal: localHosts.has(parsed.hostname),
    target: `${parsed.hostname}:${port}/${database}`,
    redacted: `${parsed.protocol}//${decodeURIComponent(parsed.username)}:***@${parsed.hostname}:${port}/${database}`,
  };
}

export function databaseEnvironment(descriptor, additions = {}) {
  return {
    ...process.env,
    PGHOST: descriptor.host,
    PGPORT: descriptor.port,
    PGUSER: descriptor.user,
    PGPASSWORD: descriptor.password,
    PGDATABASE: descriptor.database,
    PGSSLMODE: descriptor.sslMode,
    ...additions,
  };
}

export function shellQuote(value) {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function redactText(value, secrets = []) {
  let output = String(value);
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    output = output.replaceAll(secret, '[REDACTED]');
  }
  output = output.replace(/\b(postgres(?:ql)?:\/\/[^:\s/]+:)([^@\s]+)(@)/giu, '$1[REDACTED]$3');
  return output;
}

export async function runCommand({
  command,
  args = [],
  cwd = REPO_ROOT,
  env = process.env,
  displayArgs = args,
  dryRun = false,
  capture = false,
  secrets = [],
}) {
  const rendered = [command, ...displayArgs].map((part) => shellQuote(String(part))).join(' ');
  process.stdout.write(`$ ${redactText(rendered, secrets)}\n`);
  if (dryRun) return { code: 0, stdout: '', stderr: '' };

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!capture) process.stdout.write(redactText(chunk, secrets));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (!capture) process.stderr.write(redactText(chunk, secrets));
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = redactText(stderr.trim() || stdout.trim(), secrets);
        rejectPromise(
          new Error(
            detail
              ? `${command} exited with status ${code}: ${detail}`
              : `${command} exited with status ${code}.`,
          ),
        );
        return;
      }
      resolvePromise({
        code,
        stdout: redactText(stdout, secrets),
        stderr: redactText(stderr, secrets),
      });
    });
  });
}

export function commandExists(command) {
  const lookup = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  return (
    spawnSync(lookup, args, {
      shell: process.platform !== 'win32',
      stdio: 'ignore',
    }).status === 0
  );
}

export function supabaseCommand() {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  if (!commandExists(npx)) {
    throw new Error(
      `Supabase CLI v${SUPABASE_CLI_VERSION} requires Node/npm so the pinned npx command can run.`,
    );
  }
  return {
    command: npx,
    prefix: ['--yes', `supabase@${SUPABASE_CLI_VERSION}`],
  };
}

export function unsafePublishedDockerBindings(entries) {
  const unsafe = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const containerId =
      typeof entry.containerId === 'string' && entry.containerId ? entry.containerId : 'unknown';
    const ports =
      entry.ports && typeof entry.ports === 'object' && !Array.isArray(entry.ports)
        ? entry.ports
        : {};
    for (const [containerPort, bindings] of Object.entries(ports)) {
      if (!Array.isArray(bindings)) continue;
      for (const binding of bindings) {
        if (!binding || typeof binding !== 'object') continue;
        const hostIp = typeof binding.HostIp === 'string' ? binding.HostIp : '';
        const hostPort = typeof binding.HostPort === 'string' ? binding.HostPort : '';
        if (!['127.0.0.1', '::1'].includes(hostIp)) {
          unsafe.push({ containerId, containerPort, hostIp, hostPort });
        }
      }
    }
  }
  return unsafe;
}

export async function sha256File(filePath) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.on('error', rejectPromise);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function fileRecord(baseDirectory, filePath) {
  const resolvedBase = resolve(baseDirectory);
  const resolvedFile = resolve(filePath);
  const pathWithin = relative(resolvedBase, resolvedFile);
  if (
    !pathWithin ||
    pathWithin.startsWith(`..${sep}`) ||
    pathWithin === '..' ||
    pathWithin.startsWith(sep)
  ) {
    throw new Error(`Backup file must be below ${resolvedBase}.`);
  }
  const metadata = await stat(resolvedFile);
  if (!metadata.isFile()) throw new Error(`${resolvedFile} is not a regular file.`);
  return {
    path: pathWithin.split(sep).join('/'),
    bytes: metadata.size,
    sha256: await sha256File(resolvedFile),
  };
}

export async function assertReadableFile(filePath) {
  await access(filePath, constants.R_OK);
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error(`${filePath} is not a regular file.`);
}

export function resolveManifestPath(baseDirectory, manifestPath) {
  if (
    typeof manifestPath !== 'string' ||
    !manifestPath ||
    manifestPath.includes('\0') ||
    manifestPath.startsWith('/') ||
    manifestPath.split('/').includes('..')
  ) {
    throw new Error(`Unsafe manifest path: "${String(manifestPath)}".`);
  }
  const base = resolve(baseDirectory);
  const candidate = resolve(base, manifestPath);
  if (!candidate.startsWith(`${base}${sep}`)) {
    throw new Error(`Manifest path escapes the backup directory: "${manifestPath}".`);
  }
  return candidate;
}

export async function readJson(filePath) {
  const body = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${filePath} does not contain valid JSON.`);
  }
}

export function printErrorAndExit(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ERROR: ${redactText(message)}\n`);
  process.exitCode = 1;
}
