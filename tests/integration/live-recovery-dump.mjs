#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateStoryOpsSchemaDump } from '../../infra/scripts/recovery-hardening.mjs';
import {
  REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS,
  REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS,
  validateStoryOpsExcludedDataDump,
} from '../../infra/scripts/storage-recovery.mjs';
import { supabaseCommand } from '../../infra/scripts/common.mjs';

const LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const LOCAL_DATABASE_CONTAINER = 'supabase_db_storyops-ai';

function execute(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(' ')} exited ${result.status ?? 'without status'}: ${
        result.stderr || result.stdout
      }`,
    );
  }
  return result;
}

function assertCopy(dataSql, schema, table) {
  const qualified = new RegExp(
    `^COPY\\s+(?:ONLY\\s+)?(?:"${schema}"|${schema})\\s*\\.\\s*(?:"${table}"|${table})(?![a-z0-9_"])`,
    'imu',
  );
  if (!qualified.test(dataSql)) {
    throw new Error(`Real data dump did not retain required ${schema}.${table} rows.`);
  }
}

async function main() {
  const schemaResult = execute('docker', [
    'exec',
    LOCAL_DATABASE_CONTAINER,
    'pg_dump',
    '--format=plain',
    '--no-owner',
    '--no-privileges',
    '--schema-only',
    '--schema=public',
    '--schema=private',
    '-U',
    'postgres',
    '-d',
    'postgres',
  ]);
  const schemaSentinels = validateStoryOpsSchemaDump(schemaResult.stdout);

  const directory = await mkdtemp(join(tmpdir(), 'storyops-live-recovery-dump-'));
  const sourceSchemaPath = join(directory, 'source-schema.sql');
  const dataPath = join(directory, 'data.sql');
  try {
    const cli = supabaseCommand();
    execute(cli.command, [
      ...cli.prefix,
      'db',
      'dump',
      '--db-url',
      LOCAL_DATABASE_URL,
      '--file',
      sourceSchemaPath,
    ]);
    const sourceSchemaSentinels = validateStoryOpsSchemaDump(
      await readFile(sourceSchemaPath, 'utf8'),
    );
    if (sourceSchemaSentinels.length !== schemaSentinels.length) {
      throw new Error(
        'Source Supabase CLI and restored-target pg_dump schema sentinel inventories differ.',
      );
    }
    execute(cli.command, [
      ...cli.prefix,
      'db',
      'dump',
      '--db-url',
      LOCAL_DATABASE_URL,
      '--file',
      dataPath,
      '--use-copy',
      '--data-only',
      '--schema',
      REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS.join(','),
      ...REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS.flatMap((table) => ['--exclude', table]),
    ]);
    const dataSql = await readFile(dataPath, 'utf8');
    validateStoryOpsExcludedDataDump(dataSql);
    assertCopy(dataSql, 'auth', 'users');
    assertCopy(dataSql, 'public', 'companies');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  process.stdout.write(
    `Real target pg_dump and source Supabase CLI schema (${schemaSentinels.length} sentinels), plus the auth/public/private data allowlist, passed.\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
