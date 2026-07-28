#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  REPO_ROOT,
  commandExists,
  databaseEnvironment,
  hasFlag,
  loadEnvironmentFile,
  optionValue,
  parseDatabaseUrl,
  printErrorAndExit,
  readJson,
  resolveManifestPath,
  runCommand,
  sha256File,
  unknownOptions,
} from '../infra/scripts/common.mjs';
import {
  assertStoragePolicyDriftConfirmation,
  storageBucketPolicyDrift,
  validateStorageBucketManifest,
} from '../infra/scripts/recovery-hardening.mjs';

const BACKUP_FORMAT = 'storyops-supabase-logical-v1';
const LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const argv = process.argv.slice(2);

function usage() {
  process.stdout.write(`StoryOps AI Supabase restore

Usage:
  node scripts/restore.mjs --backup DIRECTORY [options]

Safety defaults:
  The command is a dry run unless --execute is present. Execution always
  requires --confirm-target HOST:PORT/DATABASE. Remote targets additionally
  require --allow-remote. Existing application tables are rejected unless
  --allow-nonempty is explicitly supplied.

Options:
  --backup DIRECTORY          Backup containing manifest.json
  --local                     Restore to local Supabase (default)
  --db-url URL                Target URL (prefer STORYOPS_DATABASE_URL env)
  --execute                   Perform the restore
  --dry-run                   Explicitly select dry-run mode
  --confirm-target TARGET     Exact HOST:PORT/DATABASE confirmation
  --allow-remote              Permit an explicitly confirmed remote target
  --allow-nonempty            Permit a target with existing application tables
  --skip-roles                Do not apply roles.sql
  --restore-storage           Restore Storage objects from the manifest
  --storage-url URL           Target Supabase URL (or SUPABASE_URL env)
  --storage-key KEY           Target service-role key (prefer environment)
  --replace-storage           Overwrite conflicting Storage objects
  --confirm-storage-host HOST Exact host confirmation for overwrite
  --allow-storage-policy-drift
                              Preserve reviewed existing bucket policy drift
  --confirm-storage-policy-drift SHA256
                              Exact target/policy drift fingerprint confirmation
  --help                      Show this help

The SQL restore is transactional and does not issue DROP/--clean. Use a fresh
Supabase project whenever possible.
`);
}

async function validatedFile(backupDirectory, record, seenPaths) {
  if (
    !record ||
    typeof record.path !== 'string' ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0 ||
    !/^[a-f0-9]{64}$/u.test(record.sha256)
  ) {
    throw new Error('Backup manifest contains an invalid file record.');
  }
  if (seenPaths.has(record.path)) {
    throw new Error(`Backup manifest repeats file path "${record.path}".`);
  }
  seenPaths.add(record.path);
  const filePath = resolveManifestPath(backupDirectory, record.path);
  const linkMetadata = await lstat(filePath);
  if (linkMetadata.isSymbolicLink()) {
    throw new Error(`Backup files may not be symbolic links: ${record.path}`);
  }
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size !== record.bytes) {
    throw new Error(`Backup size check failed for "${record.path}".`);
  }
  const actualHash = await sha256File(filePath);
  if (actualHash !== record.sha256) {
    throw new Error(`Backup checksum check failed for "${record.path}".`);
  }
  return filePath;
}

async function validateBackup(backupDirectory) {
  const manifestPath = resolve(backupDirectory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Backup manifest is missing: ${manifestPath}`);
  }
  const manifest = await readJson(manifestPath);
  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error(
      `Unsupported backup format "${String(manifest.format)}"; expected "${BACKUP_FORMAT}".`,
    );
  }
  if (!manifest.database || !Array.isArray(manifest.database.files)) {
    throw new Error('Backup manifest has no database file list.');
  }

  const seenPaths = new Set();
  const databaseFiles = new Map();
  for (const record of manifest.database.files) {
    const filePath = await validatedFile(backupDirectory, record, seenPaths);
    databaseFiles.set(record.path, filePath);
  }
  for (const required of ['roles.sql', 'schema.sql', 'data.sql']) {
    if (!databaseFiles.has(required)) {
      throw new Error(`Backup is missing required database file "${required}".`);
    }
  }

  const storageObjects = [];
  const seenObjects = new Set();
  if (manifest.storage?.included) {
    if (!Array.isArray(manifest.storage.buckets) || !Array.isArray(manifest.storage.objects)) {
      throw new Error('Backup Storage manifest is malformed.');
    }
    const bucketIds = new Set(
      validateStorageBucketManifest(manifest.storage.buckets).map((bucket) => bucket.id),
    );
    for (const object of manifest.storage.objects) {
      if (
        !object ||
        typeof object.bucket !== 'string' ||
        typeof object.name !== 'string' ||
        typeof object.file !== 'string'
      ) {
        throw new Error('Backup contains an invalid Storage object record.');
      }
      if (!bucketIds.has(object.bucket)) {
        throw new Error(
          `Backup Storage object "${object.bucket}/${object.name}" references an undeclared bucket.`,
        );
      }
      const objectKey = `${object.bucket}\0${object.name}`;
      if (seenObjects.has(objectKey)) {
        throw new Error(`Backup repeats Storage object "${object.bucket}/${object.name}".`);
      }
      seenObjects.add(objectKey);
      const filePath = await validatedFile(
        backupDirectory,
        {
          path: object.file,
          bytes: object.bytes,
          sha256: object.sha256,
        },
        seenPaths,
      );
      storageObjects.push({ ...object, filePath });
    }
  }
  return { manifest, databaseFiles, storageObjects };
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function createStorageClient(storageUrl, storageKey) {
  let createClient;
  try {
    ({ createClient } = await import('@supabase/supabase-js'));
  } catch {
    throw new Error(
      'Storage restore requires installed dependencies. Run npm install before --restore-storage.',
    );
  }
  return createClient(storageUrl, storageKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { 'X-Client-Info': 'storyops-ai-restore/1.0' } },
  });
}

async function validateExistingBucketPolicies({
  backup,
  client,
  storageUrl,
  allowPolicyDrift,
  policyDriftConfirmation,
}) {
  const { data: existingBuckets, error: listError } = await client.storage.listBuckets();
  if (listError) throw new Error(`Unable to list target Storage buckets: ${listError.message}`);
  const comparison = storageBucketPolicyDrift({
    manifestBuckets: backup.manifest.storage.buckets,
    existingBuckets: existingBuckets || [],
    targetHost: new URL(storageUrl).host,
  });
  const approvedDriftBucketIds = assertStoragePolicyDriftConfirmation({
    comparison,
    allowPolicyDrift,
    policyDriftConfirmation,
  });
  if (approvedDriftBucketIds.length > 0) {
    process.stdout.write(
      `OVERRIDE confirmed existing Storage bucket policy drift for ${approvedDriftBucketIds.join(', ')} on ${new URL(storageUrl).host}.\n`,
    );
  }
  return existingBuckets || [];
}

async function restoreStorage({
  backup,
  client,
  storageUrl,
  replace,
  allowPolicyDrift,
  policyDriftConfirmation,
}) {
  const existingBuckets = await validateExistingBucketPolicies({
    backup,
    client,
    storageUrl,
    allowPolicyDrift,
    policyDriftConfirmation,
  });
  const existingIds = new Set((existingBuckets || []).map((bucket) => bucket.id));

  for (const bucket of backup.manifest.storage.buckets) {
    if (existingIds.has(bucket.id)) continue;
    const { error } = await client.storage.createBucket(bucket.id, {
      public: Boolean(bucket.public),
      fileSizeLimit: bucket.fileSizeLimit ?? undefined,
      allowedMimeTypes: bucket.allowedMimeTypes ?? undefined,
    });
    if (error) throw new Error(`Unable to create Storage bucket "${bucket.id}": ${error.message}`);
    existingIds.add(bucket.id);
  }

  let uploaded = 0;
  let alreadyPresent = 0;
  for (const object of backup.storageObjects) {
    const bytes = new Uint8Array(await readFile(object.filePath));
    const { error } = await client.storage.from(object.bucket).upload(object.name, bytes, {
      cacheControl: object.cacheControl || undefined,
      contentType: object.contentType || undefined,
      upsert: replace,
    });
    if (!error) {
      uploaded += 1;
      continue;
    }
    if (replace) {
      throw new Error(
        `Unable to replace Storage object "${object.bucket}/${object.name}": ${error.message}`,
      );
    }

    // A retry after interruption is safe when the existing object is byte-for-byte
    // identical. A different object is never overwritten without explicit approval.
    const { data: existing, error: downloadError } = await client.storage
      .from(object.bucket)
      .download(object.name);
    if (downloadError || !existing) {
      throw new Error(
        `Unable to restore Storage object "${object.bucket}/${object.name}": ${error.message}`,
      );
    }
    const existingHash = hashBytes(new Uint8Array(await existing.arrayBuffer()));
    if (existingHash !== object.sha256) {
      throw new Error(
        `Storage conflict for "${object.bucket}/${object.name}". Re-run only after review with --replace-storage and confirmation.`,
      );
    }
    alreadyPresent += 1;
  }
  return { uploaded, alreadyPresent };
}

async function main() {
  if (hasFlag(argv, '--help')) {
    usage();
    return;
  }
  const unknown = unknownOptions(
    argv,
    [
      '--help',
      '--local',
      '--execute',
      '--dry-run',
      '--allow-remote',
      '--allow-nonempty',
      '--skip-roles',
      '--restore-storage',
      '--replace-storage',
      '--allow-storage-policy-drift',
    ],
    [
      '--backup',
      '--db-url',
      '--confirm-target',
      '--storage-url',
      '--storage-key',
      '--confirm-storage-host',
      '--confirm-storage-policy-drift',
    ],
  );
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(', ')}`);
  if (hasFlag(argv, '--execute') && hasFlag(argv, '--dry-run')) {
    throw new Error('--execute and --dry-run are mutually exclusive.');
  }
  if (hasFlag(argv, '--replace-storage') && !hasFlag(argv, '--restore-storage')) {
    throw new Error('--replace-storage requires --restore-storage.');
  }
  if (hasFlag(argv, '--allow-storage-policy-drift') && !hasFlag(argv, '--restore-storage')) {
    throw new Error('--allow-storage-policy-drift requires --restore-storage.');
  }
  if (
    optionValue(argv, '--confirm-storage-policy-drift') &&
    !hasFlag(argv, '--allow-storage-policy-drift')
  ) {
    throw new Error('--confirm-storage-policy-drift requires --allow-storage-policy-drift.');
  }

  loadEnvironmentFile();
  const backupOption = optionValue(argv, '--backup');
  if (!backupOption) throw new Error('--backup DIRECTORY is required.');
  const backupDirectory = resolve(backupOption);
  const backup = await validateBackup(backupDirectory);

  const explicitDatabaseUrl = optionValue(argv, '--db-url');
  if (hasFlag(argv, '--local') && explicitDatabaseUrl) {
    throw new Error('--local and --db-url are mutually exclusive.');
  }
  const databaseUrl = hasFlag(argv, '--local')
    ? LOCAL_DATABASE_URL
    : explicitDatabaseUrl || process.env.STORYOPS_DATABASE_URL || LOCAL_DATABASE_URL;
  const database = parseDatabaseUrl(databaseUrl);
  const execute = hasFlag(argv, '--execute');
  const restoreStorageRequested = hasFlag(argv, '--restore-storage');
  const replaceStorage = hasFlag(argv, '--replace-storage');
  const allowStoragePolicyDrift = hasFlag(argv, '--allow-storage-policy-drift');
  const storagePolicyDriftConfirmation = optionValue(argv, '--confirm-storage-policy-drift');
  const confirmation = optionValue(argv, '--confirm-target');
  if (allowStoragePolicyDrift && !/^[a-f0-9]{64}$/u.test(storagePolicyDriftConfirmation || '')) {
    throw new Error(
      '--allow-storage-policy-drift requires an exact lowercase SHA-256 from --confirm-storage-policy-drift.',
    );
  }

  if (restoreStorageRequested && !backup.manifest.storage?.included) {
    throw new Error('This backup does not include Storage objects.');
  }
  const storageUrl = optionValue(argv, '--storage-url', process.env.SUPABASE_URL);
  const storageKey = optionValue(argv, '--storage-key', process.env.SUPABASE_SERVICE_ROLE_KEY);
  let storageClient;
  if (execute) {
    if (confirmation !== database.target) {
      throw new Error(
        `Restore confirmation mismatch. Re-run with --confirm-target ${database.target}`,
      );
    }
    if (!database.isLocal && !hasFlag(argv, '--allow-remote')) {
      throw new Error('Remote database restore requires --allow-remote.');
    }
    if (!commandExists('psql')) {
      throw new Error('psql is required for an executable restore.');
    }
    if (restoreStorageRequested && (!storageUrl || !storageKey)) {
      throw new Error(
        '--restore-storage execution requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
      );
    }
    if (
      restoreStorageRequested &&
      storageUrl &&
      !['127.0.0.1', 'localhost', '::1'].includes(new URL(storageUrl).hostname) &&
      !hasFlag(argv, '--allow-remote')
    ) {
      throw new Error('Remote Storage restore requires --allow-remote.');
    }
    if (
      replaceStorage &&
      optionValue(argv, '--confirm-storage-host') !== new URL(storageUrl).host
    ) {
      throw new Error(
        `Storage overwrite confirmation mismatch. Re-run with --confirm-storage-host ${new URL(storageUrl).host}`,
      );
    }
    if (restoreStorageRequested) {
      storageClient = await createStorageClient(storageUrl, storageKey);
      await validateExistingBucketPolicies({
        backup,
        client: storageClient,
        storageUrl,
        allowPolicyDrift: allowStoragePolicyDrift,
        policyDriftConfirmation: storagePolicyDriftConfirmation,
      });
    }
  }

  process.stdout.write(`Backup: ${backupDirectory}\n`);
  process.stdout.write(`Target: ${database.target} (${database.isLocal ? 'local' : 'remote'})\n`);
  process.stdout.write(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}\n`);
  process.stdout.write(
    `Validated: ${backup.databaseFiles.size} database files, ${backup.storageObjects.length} Storage objects\n`,
  );

  const psqlArgs = ['--single-transaction', '--variable', 'ON_ERROR_STOP=1'];
  if (!hasFlag(argv, '--skip-roles')) {
    psqlArgs.push('--file', backup.databaseFiles.get('roles.sql'));
  }
  psqlArgs.push(
    '--file',
    backup.databaseFiles.get('schema.sql'),
    '--command',
    'SET session_replication_role = replica',
    '--file',
    backup.databaseFiles.get('data.sql'),
    '--dbname',
    database.database,
  );
  const psqlEnvironment = databaseEnvironment(database);

  if (!execute) {
    await runCommand({
      command: 'psql',
      args: psqlArgs,
      env: psqlEnvironment,
      dryRun: true,
      secrets: [database.raw, storageKey],
    });
    if (restoreStorageRequested) {
      process.stdout.write(
        `PLAN restore ${backup.storageObjects.length} Storage objects${replaceStorage ? ' with reviewed overwrite' : ' without overwrite'}\n`,
      );
    }
    process.stdout.write(
      'Dry run complete; no database, network, or filesystem changes were made.\n',
    );
    return;
  }

  const preflight = await runCommand({
    command: 'psql',
    args: [
      '--tuples-only',
      '--no-align',
      '--variable',
      'ON_ERROR_STOP=1',
      '--command',
      "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema','auth','storage','extensions','realtime','supabase_functions','supabase_migrations','vault','graphql','net') AND schemaname NOT LIKE 'pg_toast%';",
      '--dbname',
      database.database,
    ],
    env: psqlEnvironment,
    capture: true,
    secrets: [database.raw],
  });
  const existingApplicationTables = Number.parseInt(preflight.stdout.trim(), 10);
  if (!Number.isInteger(existingApplicationTables)) {
    throw new Error('Unable to determine whether the target database is empty.');
  }
  if (existingApplicationTables > 0 && !hasFlag(argv, '--allow-nonempty')) {
    throw new Error(
      `Target contains ${existingApplicationTables} application table(s). Use a fresh target or obtain review before --allow-nonempty.`,
    );
  }

  await runCommand({
    command: 'psql',
    args: psqlArgs,
    env: psqlEnvironment,
    secrets: [database.raw],
  });
  process.stdout.write('Database restore transaction committed.\n');

  if (restoreStorageRequested) {
    const result = await restoreStorage({
      backup,
      client: storageClient,
      storageUrl,
      replace: replaceStorage,
      allowPolicyDrift: allowStoragePolicyDrift,
      policyDriftConfirmation: storagePolicyDriftConfirmation,
    });
    process.stdout.write(
      `Storage restore complete: ${result.uploaded} uploaded, ${result.alreadyPresent} already identical.\n`,
    );
  }
  process.stdout.write(
    'Restore complete. Validate RLS, authentication, provider health, row counts, and a read-only application smoke test before cutover.\n',
  );
}

main().catch(printErrorAndExit);
