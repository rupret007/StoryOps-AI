import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  REQUIRED_STORYOPS_MIGRATION,
  REQUIRED_STORYOPS_MIGRATIONS,
  assertStoragePolicyDriftConfirmation,
  storageBucketPolicyDrift,
  storyOpsSourceEvidence,
  validateStorageBucketManifest,
  validateStoryOpsSchemaDump,
} from '../../infra/scripts/recovery-hardening.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');

const completeMigrationOutput = JSON.stringify({
  migrations: REQUIRED_STORYOPS_MIGRATIONS.map((version) => ({
    local: version,
    remote: version,
  })),
});

const completeTableStatsOutput = JSON.stringify({
  rows: [
    { name: 'public.companies', estimated_row_count: '2' },
    { name: 'public.audit_events', estimated_row_count: '41' },
    { name: 'public.post_service_followups', estimated_row_count: '-1' },
    { name: 'public.media_upload_attestations', estimated_row_count: '0' },
    { name: 'public.jobs', estimated_row_count: '7' },
  ],
});

async function fakeSupabaseCommand(directory) {
  const executable = resolve(directory, 'npx');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.110.0\\n');
  process.exit(0);
}
if (args.includes('migration') && args.includes('list')) {
  process.stdout.write(process.env.FAKE_MIGRATIONS_JSON);
  process.exit(0);
}
if (args.includes('table-stats')) {
  process.stdout.write(process.env.FAKE_TABLE_STATS_JSON);
  process.exit(0);
}
if (args.includes('db') && args.includes('dump')) {
  const output = args[args.indexOf('--file') + 1];
  const name = output.split('/').at(-1);
  const bodies = {
    'roles.sql': '-- StoryOps roles\\n',
    'schema.sql': [
      'CREATE TABLE public.companies (id uuid);',
      'CREATE TABLE public.audit_events (id uuid);',
      'CREATE TABLE public.post_service_followups (id uuid);',
      'CREATE TABLE public.media_upload_attestations (id uuid);',
      'CREATE UNIQUE INDEX referrals_one_invite_per_source_invoice_idx',
      '  ON public.referrals(company_id, source_invoice_id);',
      'CREATE FUNCTION public.get_storyops_setup_state(uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.begin_storyops_post_service_submission(uuid, uuid, text) RETURNS jsonb;',
      'CREATE FUNCTION public.finalize_storyops_media_upload(uuid, uuid, uuid, jsonb, text) RETURNS jsonb;',
      ''
    ].join('\\n'),
    'data.sql': '-- StoryOps data\\n'
  };
  fs.writeFileSync(output, bodies[name], { mode: 0o600, flag: 'wx' });
  process.exit(0);
}
process.stderr.write('unexpected fake Supabase arguments: ' + args.join(' ') + '\\n');
process.exit(2);
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return executable;
}

function runBackupWithFakeCli({ target, fakeBin, migrations = completeMigrationOutput }) {
  return spawnSync(
    process.execPath,
    [
      'scripts/backup.mjs',
      '--db-url',
      'postgresql://operator:redacted@db.test/storyops',
      '--output',
      target,
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FAKE_MIGRATIONS_JSON: migrations,
        FAKE_TABLE_STATS_JSON: completeTableStatsOutput,
      },
    },
  );
}

test('backup source evidence requires the exact release migration set and StoryOps sentinels', () => {
  assert.throws(
    () =>
      storyOpsSourceEvidence({
        migrationOutput: JSON.stringify({
          migrations: [{ local: '20260728000000', remote: '20260728000000' }],
        }),
        tableStatsOutput: completeTableStatsOutput,
      }),
    new RegExp(`migration set does not match this release.*missing`, 'u'),
  );
  assert.throws(
    () =>
      storyOpsSourceEvidence({
        migrationOutput: completeMigrationOutput,
        tableStatsOutput: JSON.stringify({
          rows: [{ name: 'public.companies', estimated_row_count: '1' }],
        }),
      }),
    /missing sentinel table\(s\): public\.audit_events, public\.post_service_followups, public\.media_upload_attestations/u,
  );
});

test('executable backup refuses a dump whose source lacks the required migration', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'storyops-backup-hardening-'));
  const fakeBin = resolve(directory, 'bin');
  const target = resolve(directory, 'backup');
  try {
    await mkdir(fakeBin);
    await fakeSupabaseCommand(fakeBin);
    const result = runBackupWithFakeCli({
      target,
      fakeBin,
      migrations: JSON.stringify({
        migrations: REQUIRED_STORYOPS_MIGRATIONS.slice(0, -1).map((version) => ({
          local: version,
          remote: version,
        })),
      }),
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`migration set does not match this release.*missing`, 'u'),
    );
    await assert.rejects(stat(target), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('executable backup publishes fingerprints and explicitly estimated counts', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'storyops-backup-hardening-'));
  const fakeBin = resolve(directory, 'bin');
  const target = resolve(directory, 'backup');
  try {
    await mkdir(fakeBin);
    await fakeSupabaseCommand(fakeBin);
    const result = runBackupWithFakeCli({ target, fakeBin });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(resolve(target, 'manifest.json'), 'utf8'));
    const evidence = manifest.database.recoveryEvidence;
    const schemaFile = manifest.database.files.find((file) => file.path === 'schema.sql');
    assert.equal(evidence.requiredMigration, REQUIRED_STORYOPS_MIGRATION);
    assert.equal(evidence.requiredMigrationCount, REQUIRED_STORYOPS_MIGRATIONS.length);
    assert.match(evidence.requiredMigrationSetFingerprint.value, /^[a-f0-9]{64}$/u);
    assert.equal(evidence.schemaFingerprint.value, schemaFile.sha256);
    assert.equal(evidence.estimatedTableCounts.transactionallyConsistentWithDump, false);
    assert.equal(evidence.estimatedTableCounts.tables['public.audit_events'], 41);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('backup evidence fingerprints migrations and labels catalog counts as estimates', () => {
  const evidence = storyOpsSourceEvidence({
    migrationOutput: completeMigrationOutput,
    tableStatsOutput: completeTableStatsOutput,
    observedAt: '2026-07-28T20:00:00.000Z',
  });

  assert.equal(evidence.requiredMigration, REQUIRED_STORYOPS_MIGRATION);
  assert.equal(evidence.requiredMigrationCount, REQUIRED_STORYOPS_MIGRATIONS.length);
  assert.equal(evidence.appliedMigrationCount, REQUIRED_STORYOPS_MIGRATIONS.length);
  assert.equal(evidence.latestAppliedMigration, REQUIRED_STORYOPS_MIGRATION);
  assert.equal(
    evidence.requiredMigrationSetFingerprint.value,
    evidence.migrationSetFingerprint.value,
  );
  assert.match(evidence.migrationSetFingerprint.value, /^[a-f0-9]{64}$/u);
  assert.equal(evidence.estimatedTableCounts.method, 'supabase-inspect-db-table-stats');
  assert.equal(evidence.estimatedTableCounts.transactionallyConsistentWithDump, false);
  assert.equal(evidence.estimatedTableCounts.tables['public.companies'], 2);
  assert.equal(evidence.estimatedTableCounts.tables['public.post_service_followups'], null);
});

test('schema dump must contain setup, outbound, and trusted-media StoryOps sentinels', () => {
  const completeSchema = `
    CREATE TABLE "public"."companies" (id uuid);
    CREATE TABLE public.audit_events (id uuid);
    CREATE TABLE IF NOT EXISTS "public".post_service_followups (id uuid);
    CREATE TABLE public.media_upload_attestations (id uuid);
    CREATE UNIQUE INDEX referrals_one_invite_per_source_invoice_idx
      ON public.referrals(company_id, source_invoice_id);
    CREATE FUNCTION public.get_storyops_setup_state(uuid) RETURNS jsonb;
    CREATE FUNCTION public.begin_storyops_post_service_submission(uuid, uuid, text)
      RETURNS jsonb;
    CREATE FUNCTION public.finalize_storyops_media_upload(uuid, uuid, uuid, jsonb, text)
      RETURNS jsonb;
  `;
  assert.deepEqual(validateStoryOpsSchemaDump(completeSchema), [
    'public.companies',
    'public.audit_events',
    'public.post_service_followups',
    'public.media_upload_attestations',
    'public.referrals_one_invite_per_source_invoice_idx',
    'public.get_storyops_setup_state',
    'public.begin_storyops_post_service_submission',
    'public.finalize_storyops_media_upload',
  ]);
  assert.throws(
    () =>
      validateStoryOpsSchemaDump(`
        CREATE TABLE public.companies (id uuid);
        CREATE TABLE public.audit_events (id uuid);
      `),
    /public\.post_service_followups, public\.media_upload_attestations/u,
  );
});

test('recovery migration authority exactly matches the repository migration set', async () => {
  const versions = (await readdir(resolve(repositoryRoot, 'supabase/migrations')))
    .map((name) => /^(\d{14})_.+\.sql$/u.exec(name)?.[1])
    .filter(Boolean)
    .sort();
  assert.deepEqual(versions, [...REQUIRED_STORYOPS_MIGRATIONS]);
  assert.equal(REQUIRED_STORYOPS_MIGRATION, versions.at(-1));
});

test('Storage restore fails closed on public, size, or MIME policy drift', () => {
  const manifestBuckets = [
    {
      id: 'job-media',
      public: false,
      fileSizeLimit: 25_000_000,
      allowedMimeTypes: ['image/jpeg', 'image/png'],
    },
  ];
  const matching = storageBucketPolicyDrift({
    manifestBuckets,
    existingBuckets: [
      {
        id: 'job-media',
        public: false,
        file_size_limit: 25_000_000,
        allowed_mime_types: ['image/png', 'image/jpeg'],
      },
    ],
    targetHost: 'project.supabase.co',
  });
  assert.deepEqual(matching.drift, []);
  assert.equal(matching.confirmationSha256, null);

  const comparison = storageBucketPolicyDrift({
    manifestBuckets,
    existingBuckets: [
      {
        id: 'job-media',
        public: true,
        file_size_limit: 50_000_000,
        allowed_mime_types: ['image/jpeg'],
      },
    ],
    targetHost: 'project.supabase.co',
  });
  assert.equal(comparison.drift.length, 1);
  assert.match(comparison.confirmationSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(
    comparison.confirmationSha256,
    storageBucketPolicyDrift({
      manifestBuckets,
      existingBuckets: [
        {
          id: 'job-media',
          public: true,
          file_size_limit: 50_000_000,
          allowed_mime_types: ['image/jpeg'],
        },
      ],
      targetHost: 'different.supabase.co',
    }).confirmationSha256,
  );
  assert.throws(
    () =>
      assertStoragePolicyDriftConfirmation({
        comparison,
        allowPolicyDrift: false,
      }),
    /No Storage changes were made/u,
  );
  assert.throws(
    () =>
      assertStoragePolicyDriftConfirmation({
        comparison,
        allowPolicyDrift: true,
        policyDriftConfirmation: '0'.repeat(64),
      }),
    /confirm-storage-policy-drift/u,
  );
  assert.deepEqual(
    assertStoragePolicyDriftConfirmation({
      comparison,
      allowPolicyDrift: true,
      policyDriftConfirmation: comparison.confirmationSha256,
    }),
    ['job-media'],
  );
});

test('Storage bucket manifests reject duplicate bucket identities', () => {
  const bucket = {
    id: 'job-media',
    public: false,
    fileSizeLimit: null,
    allowedMimeTypes: null,
  };
  assert.throws(
    () => validateStorageBucketManifest([bucket, { ...bucket }]),
    /repeats a bucket id/u,
  );
});
