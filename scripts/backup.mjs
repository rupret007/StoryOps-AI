#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  REPO_ROOT,
  fileRecord,
  hasFlag,
  loadEnvironmentFile,
  optionValue,
  parseDatabaseUrl,
  printErrorAndExit,
  runCommand,
  sha256Text,
  supabaseCommand,
  unknownOptions,
} from '../infra/scripts/common.mjs';
import {
  storyOpsSourceEvidence,
  validateStoryOpsSchemaDump,
} from '../infra/scripts/recovery-hardening.mjs';

const BACKUP_FORMAT = 'storyops-supabase-logical-v1';
const LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const argv = process.argv.slice(2);

function usage() {
  process.stdout.write(`StoryOps AI Supabase backup

Usage:
  node scripts/backup.mjs [options]

Options:
  --local                   Back up local Supabase (default when no URL is set)
  --db-url URL              PostgreSQL URL (prefer STORYOPS_DATABASE_URL env)
  --output DIRECTORY        Exact new backup directory
  --label LABEL             Non-sensitive operator label stored in the manifest
  --include-storage         Export Storage objects through the Supabase API
  --storage-url URL         Supabase project URL (or SUPABASE_URL env)
  --storage-key KEY         Service-role key (prefer environment; never shell history)
  --dry-run                 Validate and print the plan without network or disk writes
  --help                    Show this help

The command never overwrites a backup. Output contains sensitive customer data
and is created with owner-only permissions.
`);
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/gu, '-');
}

function safeLabel(value) {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/u.test(value)) {
    throw new Error('--label must be 1-80 characters using letters, numbers, spaces, ., _, or -.');
  }
  return value;
}

async function listStorageObjects(client, bucketId, prefix = '') {
  const objects = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await client.storage.from(bucketId).list(prefix, {
      limit: 1_000,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(`Unable to list Storage bucket "${bucketId}": ${error.message}`);
    const entries = data || [];
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.metadata === null) {
        objects.push(...(await listStorageObjects(client, bucketId, name)));
      } else {
        objects.push({ name, metadata: entry.metadata || {} });
      }
    }
    if (entries.length < 1_000) break;
    offset += entries.length;
  }
  return objects;
}

function assertStorageName(name) {
  if (
    !name ||
    name.includes('\0') ||
    name.startsWith('/') ||
    name.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`Storage returned an unsafe object name: "${name}".`);
  }
}

async function exportStorage({ targetDirectory, storageUrl, storageKey }) {
  let createClient;
  try {
    ({ createClient } = await import('@supabase/supabase-js'));
  } catch {
    throw new Error(
      'Storage export requires installed dependencies. Run npm install before --include-storage.',
    );
  }
  const client = createClient(storageUrl, storageKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { 'X-Client-Info': 'storyops-ai-backup/1.0' } },
  });
  const { data: buckets, error: bucketError } = await client.storage.listBuckets();
  if (bucketError) throw new Error(`Unable to list Storage buckets: ${bucketError.message}`);

  const objectDirectory = resolve(targetDirectory, 'storage/objects');
  await mkdir(objectDirectory, { recursive: true, mode: 0o700 });
  const bucketRecords = [];
  const objectRecords = [];

  for (const bucket of buckets || []) {
    const bucketId = bucket.id || bucket.name;
    if (!bucketId) throw new Error('Storage returned a bucket without an id.');
    bucketRecords.push({
      id: bucketId,
      name: bucket.name || bucketId,
      public: Boolean(bucket.public),
      fileSizeLimit: bucket.file_size_limit ?? null,
      allowedMimeTypes: bucket.allowed_mime_types ?? null,
    });
    const objects = await listStorageObjects(client, bucketId);
    for (const object of objects) {
      assertStorageName(object.name);
      const { data, error } = await client.storage.from(bucketId).download(object.name);
      if (error || !data) {
        throw new Error(
          `Unable to download Storage object "${bucketId}/${object.name}": ${error?.message || 'empty response'}`,
        );
      }
      const bytes = new Uint8Array(await data.arrayBuffer());
      const localName = sha256Text(`${bucketId}\0${object.name}`);
      const localPath = resolve(objectDirectory, localName);
      await writeFile(localPath, bytes, { mode: 0o600, flag: 'wx' });
      const record = await fileRecord(targetDirectory, localPath);
      objectRecords.push({
        bucket: bucketId,
        name: object.name,
        file: record.path,
        bytes: record.bytes,
        sha256: record.sha256,
        contentType: object.metadata.mimetype || object.metadata.contentType || data.type || null,
        cacheControl: object.metadata.cacheControl || object.metadata.cache_control || null,
      });
    }
  }
  return { buckets: bucketRecords, objects: objectRecords };
}

async function runDump({ cli, database, targetDirectory, dryRun }) {
  const secretValues = [database.raw];
  const dumpPlans = [
    { file: 'roles.sql', flags: ['--role-only'] },
    { file: 'schema.sql', flags: [] },
    {
      file: 'data.sql',
      flags: [
        '--use-copy',
        '--data-only',
        '--exclude',
        'storage.buckets_vectors',
        '--exclude',
        'storage.vector_indexes',
      ],
    },
  ];

  for (const plan of dumpPlans) {
    const output = resolve(targetDirectory, plan.file);
    const args = [
      ...cli.prefix,
      'db',
      'dump',
      '--db-url',
      database.raw,
      '--file',
      output,
      ...plan.flags,
    ];
    const displayArgs = [
      ...cli.prefix,
      'db',
      'dump',
      '--db-url',
      database.redacted,
      '--file',
      output,
      ...plan.flags,
    ];
    await runCommand({
      command: cli.command,
      args,
      displayArgs,
      secrets: secretValues,
      dryRun,
    });
  }
}

async function inspectStoryOpsSource({ cli, database }) {
  const secrets = [database.raw];
  const migrationArgs = [
    ...cli.prefix,
    'migration',
    'list',
    '--db-url',
    database.raw,
    '--output-format',
    'json',
  ];
  const migrationResult = await runCommand({
    command: cli.command,
    args: migrationArgs,
    displayArgs: migrationArgs.map((argument) =>
      argument === database.raw ? database.redacted : argument,
    ),
    capture: true,
    secrets,
  });
  const tableStatsArgs = [
    ...cli.prefix,
    'inspect',
    'db',
    'table-stats',
    '--db-url',
    database.raw,
    '--output-format',
    'json',
  ];
  const tableStatsResult = await runCommand({
    command: cli.command,
    args: tableStatsArgs,
    displayArgs: tableStatsArgs.map((argument) =>
      argument === database.raw ? database.redacted : argument,
    ),
    capture: true,
    secrets,
  });
  return storyOpsSourceEvidence({
    migrationOutput: migrationResult.stdout,
    tableStatsOutput: tableStatsResult.stdout,
    observedAt: new Date().toISOString(),
  });
}

async function main() {
  if (hasFlag(argv, '--help')) {
    usage();
    return;
  }
  const unknown = unknownOptions(
    argv,
    ['--help', '--local', '--include-storage', '--dry-run'],
    ['--db-url', '--output', '--label', '--storage-url', '--storage-key'],
  );
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(', ')}`);

  loadEnvironmentFile();
  const dryRun = hasFlag(argv, '--dry-run');
  const explicitDatabaseUrl = optionValue(argv, '--db-url');
  if (hasFlag(argv, '--local') && explicitDatabaseUrl) {
    throw new Error('--local and --db-url are mutually exclusive.');
  }
  const databaseUrl = hasFlag(argv, '--local')
    ? LOCAL_DATABASE_URL
    : explicitDatabaseUrl || process.env.STORYOPS_DATABASE_URL || LOCAL_DATABASE_URL;
  const database = parseDatabaseUrl(databaseUrl);
  const label = safeLabel(optionValue(argv, '--label'));
  const includeStorage =
    hasFlag(argv, '--include-storage') ||
    (process.env.BACKUP_INCLUDE_STORAGE || '').toLowerCase() === 'true';
  const storageUrl = optionValue(argv, '--storage-url', process.env.SUPABASE_URL);
  const storageKey = optionValue(argv, '--storage-key', process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (includeStorage && (!storageUrl || !storageKey)) {
    throw new Error(
      '--include-storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or matching options).',
    );
  }

  const backupParent = resolve(REPO_ROOT, process.env.BACKUP_OUTPUT_DIR || 'backups');
  const targetDirectory = resolve(
    optionValue(argv, '--output', resolve(backupParent, `storyops-${timestampForPath()}`)),
  );
  if (existsSync(targetDirectory)) {
    throw new Error(`Refusing to overwrite existing backup: ${targetDirectory}`);
  }
  const targetParent = dirname(targetDirectory);
  const temporaryDirectory = resolve(targetParent, `.storyops-backup-tmp-${randomUUID()}`);

  process.stdout.write(`Backup target: ${targetDirectory}\n`);
  process.stdout.write(
    `Database target: ${database.target} (${database.isLocal ? 'local' : 'remote'})\n`,
  );
  process.stdout.write(`Storage objects: ${includeStorage ? 'included' : 'not included'}\n`);
  process.stdout.write(
    'Security: output is owner-only but unencrypted; encrypt it with the approved backup system before off-site transfer.\n',
  );

  const cli = supabaseCommand();
  if (dryRun) {
    await runDump({ cli, database, targetDirectory: temporaryDirectory, dryRun: true });
    process.stdout.write(
      'PLAN verify StoryOps schema sentinels, required migration, schema fingerprint, and estimated table counts\n',
    );
    if (includeStorage) {
      process.stdout.write(`PLAN export Storage from ${new URL(storageUrl).host}\n`);
    }
    process.stdout.write(
      'Dry run complete; no database, network, or filesystem changes were made.\n',
    );
    return;
  }

  await mkdir(targetParent, { recursive: true, mode: 0o700 });
  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    await runDump({ cli, database, targetDirectory: temporaryDirectory, dryRun: false });
    const sourceEvidence = await inspectStoryOpsSource({ cli, database });
    const schemaPath = resolve(temporaryDirectory, 'schema.sql');
    const schemaSentinels = validateStoryOpsSchemaDump(await readFile(schemaPath, 'utf8'));
    const databaseFiles = [];
    for (const fileName of ['roles.sql', 'schema.sql', 'data.sql']) {
      const filePath = resolve(temporaryDirectory, fileName);
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size === 0) {
        throw new Error(`Supabase created an empty or invalid dump file: ${fileName}`);
      }
      await chmod(filePath, 0o600);
      databaseFiles.push(await fileRecord(temporaryDirectory, filePath));
    }
    const schemaFile = databaseFiles.find((record) => record.path === 'schema.sql');
    if (!schemaFile) throw new Error('Validated StoryOps schema dump record is missing.');

    let storage = { buckets: [], objects: [] };
    if (includeStorage) {
      storage = await exportStorage({
        targetDirectory: temporaryDirectory,
        storageUrl,
        storageKey,
      });
    }

    const versionResult = await runCommand({
      command: cli.command,
      args: [...cli.prefix, '--version'],
      capture: true,
      secrets: [database.raw, storageKey],
    });
    const manifest = {
      format: BACKUP_FORMAT,
      createdAt: new Date().toISOString(),
      label,
      database: {
        source: {
          host: database.host,
          port: database.port,
          database: database.database,
          user: database.user,
          local: database.isLocal,
        },
        supabaseCliVersion: versionResult.stdout.trim(),
        recoveryEvidence: {
          requiredMigration: sourceEvidence.requiredMigration,
          requiredMigrationCount: sourceEvidence.requiredMigrationCount,
          requiredMigrationSetFingerprint: sourceEvidence.requiredMigrationSetFingerprint,
          appliedMigrationCount: sourceEvidence.appliedMigrationCount,
          latestAppliedMigration: sourceEvidence.latestAppliedMigration,
          migrationSetFingerprint: sourceEvidence.migrationSetFingerprint,
          schemaFingerprint: {
            algorithm: 'sha256',
            value: schemaFile.sha256,
            sentinels: schemaSentinels,
          },
          estimatedTableCounts: sourceEvidence.estimatedTableCounts,
        },
        files: databaseFiles,
      },
      storage: {
        included: includeStorage,
        sourceHost: includeStorage ? new URL(storageUrl).host : null,
        buckets: storage.buckets,
        objects: storage.objects,
      },
    };
    await writeFile(
      resolve(temporaryDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await rename(temporaryDirectory, targetDirectory);
    process.stdout.write(
      `Backup complete: ${targetDirectory} (${databaseFiles.length} database files, ${storage.objects.length} Storage objects)\n`,
    );
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

main().catch(printErrorAndExit);
