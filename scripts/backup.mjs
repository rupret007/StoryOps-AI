#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  commandExists,
  databaseEnvironment,
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
import {
  REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS,
  REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS,
  extractStoryOpsStoragePolicyDump,
  validateStoryOpsExcludedDataDump,
  validateStoryOpsStoragePolicyDump,
} from '../infra/scripts/storage-recovery.mjs';

const BACKUP_FORMAT = 'storyops-supabase-logical-v2';
const LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const argv = process.argv.slice(2);

function usage() {
  process.stdout.write(`WashOps Supabase backup

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
and is created with owner-only permissions. Executable backups require psql.
The completion output includes a manifest SHA-256. Store that digest separately
from the backup; executable restore requires the independently retained value.
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
    { file: 'storage-schema-source.sql', flags: ['--schema', 'storage'] },
    {
      file: 'data.sql',
      flags: [
        '--use-copy',
        '--data-only',
        '--schema',
        REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS.join(','),
        ...REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS.flatMap((tablePattern) => [
          '--exclude',
          tablePattern,
        ]),
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

async function buildStoragePolicyDump(targetDirectory) {
  const sourcePath = resolve(targetDirectory, 'storage-schema-source.sql');
  const outputPath = resolve(targetDirectory, 'storage-policies.sql');
  const extracted = extractStoryOpsStoragePolicyDump(await readFile(sourcePath, 'utf8'));
  await writeFile(outputPath, extracted.sql, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rm(sourcePath);
  return extracted.policyNames;
}

async function inspectStoryOpsSource({ cli, database }) {
  if (!commandExists('psql')) {
    throw new Error(
      'psql is required for an executable recovery-grade backup and source isolation evidence.',
    );
  }
  const secrets = [database.raw];
  const systemResult = await runCommand({
    command: 'psql',
    args: [
      '--tuples-only',
      '--no-align',
      '--variable',
      'ON_ERROR_STOP=1',
      '--command',
      `SELECT json_build_object(
        'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
        'serverObservedAt', clock_timestamp(),
        'serviceRolePublicBaseTablePrivilegeCount', (
          SELECT count(*)::integer
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relkind IN ('r', 'p')
            AND has_table_privilege(
              'service_role',
              relation.oid,
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            )
        )
      )::text;`,
      '--dbname',
      database.database,
    ],
    env: databaseEnvironment(database),
    capture: true,
    secrets,
  });
  let system;
  try {
    system = JSON.parse(systemResult.stdout.trim());
  } catch {
    throw new Error('Source database did not return valid system identity evidence.');
  }
  if (
    !/^[1-9][0-9]{0,19}$/u.test(system?.systemIdentifier || '') ||
    !Number.isFinite(Date.parse(system?.serverObservedAt)) ||
    system?.serviceRolePublicBaseTablePrivilegeCount !== 0
  ) {
    throw new Error(
      'Source database returned invalid system identity or service-role base-table isolation evidence.',
    );
  }
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
  return {
    ...storyOpsSourceEvidence({
      migrationOutput: migrationResult.stdout,
      tableStatsOutput: tableStatsResult.stdout,
      observedAt: new Date().toISOString(),
    }),
    systemIdentifier: system.systemIdentifier,
    serverObservedAt: new Date(Date.parse(system.serverObservedAt)).toISOString(),
    serviceRolePublicBaseTablePrivilegeCount: system.serviceRolePublicBaseTablePrivilegeCount,
  };
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
  if (includeStorage) {
    process.stdout.write(
      'Consistency: database and Storage exports are not atomic; use a maintenance window or reconcile immutable object paths before accepting this recovery point.\n',
    );
  }
  process.stdout.write(
    'Security: output is owner-only but unencrypted; encrypt it with the approved backup system before off-site transfer.\n',
  );

  const cli = supabaseCommand();
  if (dryRun) {
    await runDump({ cli, database, targetDirectory: temporaryDirectory, dryRun: true });
    process.stdout.write(
      'PLAN verify WashOps schema sentinels, required migration, schema fingerprint, and estimated table counts\n',
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
    const databaseDumpStartedAt = new Date().toISOString();
    await runDump({ cli, database, targetDirectory: temporaryDirectory, dryRun: false });
    const databaseDumpCompletedAt = new Date().toISOString();
    const storagePolicyNames = await buildStoragePolicyDump(temporaryDirectory);
    const sourceEvidence = await inspectStoryOpsSource({ cli, database });
    const schemaPath = resolve(temporaryDirectory, 'schema.sql');
    const schemaSentinels = validateStoryOpsSchemaDump(await readFile(schemaPath, 'utf8'));
    const databaseFiles = [];
    for (const fileName of ['roles.sql', 'schema.sql', 'storage-policies.sql', 'data.sql']) {
      const filePath = resolve(temporaryDirectory, fileName);
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size === 0) {
        throw new Error(`Supabase created an empty or invalid dump file: ${fileName}`);
      }
      await chmod(filePath, 0o600);
      databaseFiles.push(await fileRecord(temporaryDirectory, filePath));
    }
    const schemaFile = databaseFiles.find((record) => record.path === 'schema.sql');
    if (!schemaFile) throw new Error('Validated WashOps schema dump record is missing.');
    validateStoryOpsStoragePolicyDump(
      await readFile(resolve(temporaryDirectory, 'storage-policies.sql'), 'utf8'),
    );
    validateStoryOpsExcludedDataDump(
      await readFile(resolve(temporaryDirectory, 'data.sql'), 'utf8'),
    );

    let storage = { buckets: [], objects: [] };
    let storageExportStartedAt = null;
    let storageExportCompletedAt = null;
    if (includeStorage) {
      storageExportStartedAt = new Date().toISOString();
      storage = await exportStorage({
        targetDirectory: temporaryDirectory,
        storageUrl,
        storageKey,
      });
      storageExportCompletedAt = new Date().toISOString();
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
          systemIdentifier: sourceEvidence.systemIdentifier,
          serverObservedAt: sourceEvidence.serverObservedAt,
        },
        supabaseCliVersion: versionResult.stdout.trim(),
        dumpStartedAt: databaseDumpStartedAt,
        dumpCompletedAt: databaseDumpCompletedAt,
        dataExclusions: REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS,
        dataSchemas: REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS,
        recoveryEvidence: {
          requiredMigration: sourceEvidence.requiredMigration,
          requiredMigrationCount: sourceEvidence.requiredMigrationCount,
          requiredMigrationSetFingerprint: sourceEvidence.requiredMigrationSetFingerprint,
          appliedMigrationCount: sourceEvidence.appliedMigrationCount,
          latestAppliedMigration: sourceEvidence.latestAppliedMigration,
          migrationSetFingerprint: sourceEvidence.migrationSetFingerprint,
          serviceRolePublicBaseTablePrivilegeCount:
            sourceEvidence.serviceRolePublicBaseTablePrivilegeCount,
          schemaFingerprint: {
            algorithm: 'sha256',
            value: schemaFile.sha256,
            sentinels: schemaSentinels,
          },
          storagePolicyNames,
          estimatedTableCounts: sourceEvidence.estimatedTableCounts,
        },
        files: databaseFiles,
      },
      storage: {
        included: includeStorage,
        sourceHost: includeStorage ? new URL(storageUrl).host : null,
        exportStartedAt: storageExportStartedAt,
        exportCompletedAt: storageExportCompletedAt,
        crossServiceAtomicWithDatabase: false,
        bucketCount: storage.buckets.length,
        objectCount: storage.objects.length,
        objectBytes: storage.objects.reduce((total, object) => total + object.bytes, 0),
        buckets: storage.buckets,
        objects: storage.objects,
      },
    };
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestSha256 = sha256Text(manifestBytes);
    await writeFile(resolve(temporaryDirectory, 'manifest.json'), manifestBytes, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryDirectory, targetDirectory);
    process.stdout.write(
      `Backup complete: ${targetDirectory} (${databaseFiles.length} database files, ${storage.objects.length} Storage objects)\n`,
    );
    process.stdout.write(
      `Manifest SHA-256 (retain in an independent trusted location): ${manifestSha256}\n`,
    );
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

main().catch(printErrorAndExit);
