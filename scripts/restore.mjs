#!/usr/bin/env node

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { chmod, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  commandExists,
  databaseEnvironment,
  hasFlag,
  loadEnvironmentFile,
  optionValue,
  parseDatabaseUrl,
  printErrorAndExit,
  resolveManifestPath,
  runCommand,
  sha256File,
  unknownOptions,
} from '../infra/scripts/common.mjs';
import {
  REQUIRED_STORYOPS_MIGRATION,
  REQUIRED_STORYOPS_MIGRATIONS,
  assertStoragePolicyDriftConfirmation,
  storageBucketPolicyDrift,
  validateStorageBucketManifest,
  validateStoryOpsSchemaDump,
} from '../infra/scripts/recovery-hardening.mjs';
import {
  REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS,
  REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS,
  REQUIRED_STORYOPS_STORAGE_POLICIES,
  validateStoryOpsExcludedDataDump,
  validateStoryOpsStoragePolicyDump,
} from '../infra/scripts/storage-recovery.mjs';

const BACKUP_FORMAT = 'storyops-supabase-logical-v2';
const LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SIGNED_RESTORE_PROOF_VERSION = 'storyops-signed-isolated-restore-proof-v2';
const SIGNED_RESTORE_PROOF_DOMAIN = `${SIGNED_RESTORE_PROOF_VERSION}\u001f`;
const STORAGE_BYTE_VERIFICATION_VERSION = 'storyops-storage-byte-verification-v1';
const PILOT_LOCAL_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const SOURCE_LOOPBACK_DATABASE_HOSTS = new Set([
  ...PILOT_LOCAL_DATABASE_HOSTS,
  'host.docker.internal',
]);
const PILOT_REQUIRED_TABLES = Object.freeze([
  'public.integration_environment_probe_results',
  'public.company_launch_authorization_events',
  'public.trusted_pilot_verification_runs',
  'public.dispatch_clearance_receipts',
  'public.dispatch_clearance_consumptions',
  'public.identity_provisioning_targets',
  'public.identity_provisioning_commands',
  'public.identity_invitation_attempts',
  'public.property_geocode_candidates',
]);
const PILOT_REQUIRED_PRIVATE_TABLES = Object.freeze([
  'private.storyops_setup_receipts',
  'private.storyops_setup_receipt_quarantines',
  'private.dispatch_current_origin_ephemera',
  'private.dispatch_current_origin_verifiers',
  'private.dispatch_origin_purge_worker_health',
  'private.storyops_field_media_canary_crews',
  'private.storyops_field_media_canary_registry_quarantine',
  'private.storyops_field_media_canary_crew_capabilities',
]);
const PILOT_DISPATCH_ORIGIN_UNLOGGED_TABLES = Object.freeze([
  'private.dispatch_current_origin_ephemera',
  'private.dispatch_current_origin_verifiers',
]);
const PILOT_DISPATCH_ORIGIN_PRIVATE_FUNCTIONS = Object.freeze([
  'private.storyops_redact_dispatch_route_origin()',
  'private.storyops_redact_dispatch_origin_audit_event()',
  'private.storyops_capture_dispatch_current_origin()',
  'private.storyops_dispatch_current_origin_payload(uuid)',
  'private.storyops_dispatch_current_origin_actor_authorized(uuid,uuid,uuid)',
  'private.storyops_protect_dispatch_current_origin()',
  'private.storyops_purge_dispatch_current_origins(integer)',
  'private.run_storyops_dispatch_origin_purge_worker()',
  'private.storyops_dispatch_origin_retention_healthy()',
  'private.storyops_launch_authorization_base_before_origin(uuid)',
  'private.storyops_launch_authorization_base_before_canary_quarantine(uuid)',
  'private.storyops_launch_authorization_effective(uuid)',
  'private.storyops_current_trusted_proofs(uuid)',
  'private.load_storyops_dispatch_clearance_candidate(uuid,uuid,uuid,integer,text)',
  'private.record_storyops_dispatch_clearance(uuid,uuid,text,text,jsonb)',
  'private.consume_storyops_dispatch_clearance(uuid,uuid,integer,uuid,text)',
  'private.reject_storyops_setup_receipt_mutation()',
  'private.backfill_storyops_setup_receipts_v1_2()',
  'private.complete_storyops_setup_v1_1_adapter(uuid,uuid,text,text,text,text,text,text[],boolean)',
  'private.capture_storyops_field_media_canary_crew()',
  'private.authorize_storyops_field_media_canary_crew_activation(uuid,uuid,uuid,uuid,uuid)',
  'private.enforce_storyops_canary_quarantine_launch_gate()',
  'private.enforce_storyops_retired_field_media_job()',
  'private.enforce_storyops_retired_field_media_visit()',
  'private.enforce_storyops_retired_field_media_dispatch()',
  'private.claim_storyops_identity_invitation_attempt(uuid,uuid,uuid,text)',
  'private.sync_storyops_identity_invitation_attempt()',
]);
const PILOT_DISPATCH_ORIGIN_RESTRICTED_PUBLIC_FUNCTIONS = Object.freeze([
  'public.storyops_dispatch_clearance_receipt_json(public.dispatch_clearance_receipts,boolean)',
  'public.enforce_storyops_dispatch_current_origin_consumption()',
  'public.enforce_storyops_controlled_rehearsal_crew_inactive()',
  'public.enforce_storyops_field_media_canary_completion_isolation()',
]);
const PILOT_DISPATCH_ORIGIN_SERVICE_FUNCTIONS = Object.freeze([
  'public.load_storyops_dispatch_clearance_candidate(uuid,uuid,uuid,integer,text)',
  'public.record_storyops_dispatch_clearance(uuid,uuid,text,text,jsonb)',
  'public.replay_storyops_dispatch_clearance(uuid,uuid,uuid,integer,text,text,jsonb)',
  'public.purge_storyops_dispatch_current_origins(integer)',
  'public.get_storyops_dispatch_origin_retention_health()',
  'public.finalize_storyops_media_upload_from_edge(uuid,uuid,uuid,jsonb,text)',
  'public.authorize_storyops_identity_invite(uuid,uuid,uuid,text,text)',
  'public.record_storyops_identity_invite_blocked(uuid,uuid,uuid,text)',
  'public.load_storyops_identity_invitation_attempt_state(uuid,uuid)',
]);
const PILOT_DISPATCH_ORIGIN_AUTHENTICATED_FUNCTIONS = Object.freeze([
  'public.consume_storyops_dispatch_clearance(uuid,uuid,integer,uuid,text)',
  'public.complete_storyops_setup(uuid,uuid,text,text,text,text,text,text[],boolean)',
  'public.get_storyops_field_media_canary_quarantine_state(uuid)',
  'public.resolve_storyops_field_media_canary_quarantine(uuid,uuid,uuid,text,text,text)',
]);
const PILOT_REQUIRED_FUNCTIONS = Object.freeze([
  'public.get_storyops_provider_launch_state(uuid)',
  'public.reserve_storyops_trusted_pilot_verification(uuid,uuid,uuid,text,text,text,text)',
  'public.complete_storyops_restore_verification(uuid,text)',
  'public.record_storyops_trusted_pilot_proof(uuid)',
  'public.execute_storyops_command(uuid,uuid,text,integer,jsonb,text)',
  'public.storyops_visit_has_open_incident(uuid,uuid)',
  'public.enforce_storyops_incident_update()',
  'public.enforce_storyops_incident_stop_work()',
  'public.can_upload_job_media_object(text)',
  'public.enforce_storyops_incident_media_association()',
  'public.finalize_storyops_media_upload(uuid,uuid,uuid,jsonb,text)',
  'public.finalize_storyops_media_upload_from_edge(uuid,uuid,uuid,jsonb,text)',
  'public.reserve_storyops_field_media_verification(uuid,uuid,uuid,uuid,text)',
  'public.claim_storyops_field_media_verification(uuid,uuid,uuid,uuid,text)',
  'public.complete_storyops_field_media_verification(uuid,text)',
  'private.is_storyops_field_media_canary_object(text)',
  'public.link_storyops_identity(uuid,uuid,uuid,text,uuid)',
  'public.revoke_storyops_identity(uuid,uuid,uuid,text,uuid)',
  'public.create_storyops_customer_property(uuid,uuid,jsonb,text)',
  'public.confirm_storyops_property_geocode_candidate(uuid,uuid,uuid,integer,uuid,text)',
  'public.report_storyops_incident_and_pause(uuid,uuid,integer,jsonb,text)',
  'public.authorize_storyops_identity_invite(uuid,uuid,uuid,text,text)',
  'public.complete_storyops_setup(uuid,uuid,text,text,text,text,text,text[],boolean)',
  'public.get_storyops_field_media_canary_quarantine_state(uuid)',
  'public.resolve_storyops_field_media_canary_quarantine(uuid,uuid,uuid,text,text,text)',
  'public.record_storyops_identity_invite_blocked(uuid,uuid,uuid,text)',
  'public.load_storyops_identity_invitation_attempt_state(uuid,uuid)',
  ...PILOT_DISPATCH_ORIGIN_PRIVATE_FUNCTIONS,
  ...PILOT_DISPATCH_ORIGIN_RESTRICTED_PUBLIC_FUNCTIONS,
  ...PILOT_DISPATCH_ORIGIN_SERVICE_FUNCTIONS,
  ...PILOT_DISPATCH_ORIGIN_AUTHENTICATED_FUNCTIONS,
]);
const PILOT_RLS_TABLES = Object.freeze([
  'public.companies',
  'public.company_memberships',
  'public.customers',
  'public.properties',
  'public.jobs',
  'public.media_assets',
  'public.audit_events',
  'public.integration_connections',
  ...PILOT_REQUIRED_TABLES,
]);
const PILOT_RELEASE_REQUIRED_TRIGGERS = Object.freeze([
  'public.audit_events|audit_events_00_dispatch_origin_redaction',
  'public.route_checks|route_checks_00_redact_dispatch_origin',
  'public.dispatch_clearance_receipts|dispatch_clearance_receipts_00_ephemeral_origin',
  'private.dispatch_current_origin_ephemera|dispatch_current_origin_ephemera_immutable',
  'private.dispatch_current_origin_verifiers|dispatch_current_origin_verifiers_immutable',
  'public.dispatch_clearance_consumptions|dispatch_clearance_consumption_current_origin_guard',
  'private.storyops_setup_receipts|storyops_setup_receipts_append_only',
  'private.storyops_setup_receipt_quarantines|storyops_setup_receipt_quarantines_append_only',
  'public.companies|companies_guard_system_state',
  'public.trusted_pilot_verification_runs|trusted_pilot_field_media_registry_capture',
  'public.company_launch_authorization_events|storyops_00_canary_quarantine_launch_gate',
  'public.crews|crews_controlled_rehearsal_inactive',
  'public.jobs|jobs_retired_field_media_canary_guard',
  'public.visits|visits_retired_field_media_canary_guard',
  'public.dispatch_assignments|dispatch_retired_field_media_canary_guard',
  'public.trusted_pilot_verification_runs|trusted_pilot_field_media_completion_isolation',
  'public.identity_invitation_attempts|identity_invitation_attempts_touch',
  'public.identity_invitation_attempts|storyops_active_company_mutation_gate',
  'public.identity_provisioning_commands|identity_provisioning_commands_invitation_attempt',
]);
const PILOT_JOB_MEDIA_MIME_TYPES = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const argv = process.argv.slice(2);
let activeRestoreStagingDirectory;

function usage() {
  process.stdout.write(`WashOps Supabase restore

Usage:
  node scripts/restore.mjs --backup DIRECTORY [options]

Safety defaults:
  The command is a dry run unless --execute is present. Execution always
  requires --confirm-target HOST:PORT/DATABASE. Remote targets additionally
  require --allow-remote. Existing application tables are rejected unless
  --allow-nonempty is explicitly supplied.

Options:
  --backup DIRECTORY          Backup containing manifest.json
  --expected-manifest-sha256 SHA256
                              Independently retained manifest digest; mandatory
                              for --execute (or STORYOPS_BACKUP_MANIFEST_SHA256)
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
  --pilot-evidence-out FILE    Write a signed, authorization-grade isolated
                              proof after verified fresh DB + Storage recovery
  --pilot-isolation-id ID      Stable identifier for the isolated restore target
  --pilot-evidence-reference ID
                              Operator evidence/run identifier (no free-form text)
  --help                      Show this help

The SQL restore is transactional and does not issue DROP/--clean. Use a fresh
Supabase project whenever possible.
`);
}

const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

function sameFileSnapshot(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function readRegularFileOnce(filePath, label) {
  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | NO_FOLLOW_FLAG);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} is missing: ${filePath}`);
    }
    if (error?.code === 'ELOOP') {
      throw new Error(`${label} must be a regular file, not a symbolic link.`);
    }
    throw error;
  }
  try {
    const before = await file.stat();
    if (!before.isFile()) {
      throw new Error(`${label} must be a regular file, not a symbolic link.`);
    }
    const bytes = await file.readFile();
    const after = await file.stat();
    if (!sameFileSnapshot(before, after) || bytes.byteLength !== before.size) {
      throw new Error(`${label} changed while it was being authenticated.`);
    }
    return bytes;
  } finally {
    await file.close();
  }
}

async function stageValidatedFile({
  backupDirectory,
  record,
  seenPaths,
  stagingDirectory,
  stagingIndex,
}) {
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
  const sourcePath = resolveManifestPath(backupDirectory, record.path);
  const bytes = await readRegularFileOnce(sourcePath, `Backup file "${record.path}"`);
  if (bytes.byteLength !== record.bytes) {
    throw new Error(`Backup size check failed for "${record.path}".`);
  }
  const actualHash = hashBytes(bytes);
  if (actualHash !== record.sha256) {
    throw new Error(`Backup checksum check failed for "${record.path}".`);
  }
  const stagedPath = join(stagingDirectory, `archive-${String(stagingIndex).padStart(6, '0')}.bin`);
  await writeFile(stagedPath, bytes, { mode: 0o600, flag: 'wx' });
  return stagedPath;
}

function assertNoUnsafePsqlMetaCommands(fileName, sql) {
  for (const [index, line] of sql.split(/\r?\n/u).entries()) {
    const command = line.trimStart();
    if (!command.startsWith('\\')) continue;
    if (fileName === 'data.sql' && command === '\\.') continue;
    throw new Error(
      `Backup SQL file "${fileName}" contains a forbidden psql meta-command at line ${index + 1}. Restore accepts SQL only; shell, include, output, connection, and other psql control commands are prohibited.`,
    );
  }
}

async function validateBackup(backupDirectory, expectedManifestSha256) {
  if (activeRestoreStagingDirectory) {
    throw new Error('A restore staging directory is already active.');
  }
  const stagingDirectory = await mkdtemp(join(tmpdir(), 'storyops-restore-stage-'));
  await chmod(stagingDirectory, 0o700);
  activeRestoreStagingDirectory = stagingDirectory;
  const sourceManifestPath = resolve(backupDirectory, 'manifest.json');
  const manifestBytes = await readRegularFileOnce(sourceManifestPath, 'Backup manifest');
  const sourceManifestSha256 = hashBytes(manifestBytes);
  if (expectedManifestSha256 !== undefined && sourceManifestSha256 !== expectedManifestSha256) {
    throw new Error(
      'Backup manifest authenticity check failed before restore target mutation. The manifest does not match the independently trusted SHA-256.',
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error(`${sourceManifestPath} does not contain valid JSON.`);
  }
  const manifestPath = join(stagingDirectory, 'manifest.json');
  await writeFile(manifestPath, manifestBytes, { mode: 0o600, flag: 'wx' });
  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error(
      `Unsupported backup format "${String(manifest.format)}"; expected "${BACKUP_FORMAT}".`,
    );
  }
  if (!manifest.database || !Array.isArray(manifest.database.files)) {
    throw new Error('Backup manifest has no database file list.');
  }
  const source = manifest.database.source;
  const dumpStartedAt = Date.parse(manifest.database.dumpStartedAt);
  const dumpCompletedAt = Date.parse(manifest.database.dumpCompletedAt);
  if (
    !source ||
    typeof source.host !== 'string' ||
    source.host.length === 0 ||
    !/^[0-9]{1,5}$/u.test(String(source.port || '')) ||
    typeof source.database !== 'string' ||
    source.database.length === 0 ||
    typeof source.user !== 'string' ||
    source.user.length === 0 ||
    typeof source.local !== 'boolean' ||
    !/^[1-9][0-9]{0,19}$/u.test(source.systemIdentifier || '') ||
    !Number.isFinite(Date.parse(source.serverObservedAt)) ||
    !Number.isFinite(dumpStartedAt) ||
    !Number.isFinite(dumpCompletedAt) ||
    dumpCompletedAt < dumpStartedAt ||
    canonicalJson(manifest.database.dataExclusions) !==
      canonicalJson(REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS) ||
    canonicalJson(manifest.database.dataSchemas) !==
      canonicalJson(REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS)
  ) {
    throw new Error('Backup manifest has invalid V2 database source or dump evidence.');
  }

  const seenPaths = new Set();
  const databaseFiles = new Map();
  let stagingIndex = 0;
  for (const record of manifest.database.files) {
    const filePath = await stageValidatedFile({
      backupDirectory,
      record,
      seenPaths,
      stagingDirectory,
      stagingIndex,
    });
    stagingIndex += 1;
    databaseFiles.set(record.path, filePath);
  }
  for (const required of ['roles.sql', 'schema.sql', 'storage-policies.sql', 'data.sql']) {
    if (!databaseFiles.has(required)) {
      throw new Error(`Backup is missing required database file "${required}".`);
    }
  }
  const databaseSql = new Map();
  for (const required of ['roles.sql', 'schema.sql', 'storage-policies.sql', 'data.sql']) {
    const sql = await readFile(databaseFiles.get(required), 'utf8');
    assertNoUnsafePsqlMetaCommands(required, sql);
    databaseSql.set(required, sql);
  }
  validateStoryOpsStoragePolicyDump(databaseSql.get('storage-policies.sql'));
  validateStoryOpsExcludedDataDump(databaseSql.get('data.sql'));

  const storageObjects = [];
  const seenObjects = new Set();
  if (
    !manifest.storage ||
    !Array.isArray(manifest.storage.buckets) ||
    !Array.isArray(manifest.storage.objects)
  ) {
    throw new Error('Backup Storage manifest is malformed.');
  }
  if (manifest.storage?.included) {
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
      if (
        object.name.includes('\0') ||
        object.name.startsWith('/') ||
        object.name.split('/').some((segment) => segment === '..')
      ) {
        throw new Error(
          `Backup contains an unsafe Storage object name "${object.bucket}/${object.name}".`,
        );
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
      const filePath = await stageValidatedFile({
        backupDirectory,
        record: {
          path: object.file,
          bytes: object.bytes,
          sha256: object.sha256,
        },
        seenPaths,
        stagingDirectory,
        stagingIndex,
      });
      stagingIndex += 1;
      storageObjects.push({ ...object, filePath });
    }
  }
  const storageObjectBytes = storageObjects.reduce((total, object) => total + object.bytes, 0);
  const storageStartedAt = Date.parse(manifest.storage?.exportStartedAt);
  const storageCompletedAt = Date.parse(manifest.storage?.exportCompletedAt);
  if (
    manifest.storage?.crossServiceAtomicWithDatabase !== false ||
    manifest.storage?.bucketCount !== (manifest.storage?.buckets || []).length ||
    manifest.storage?.objectCount !== storageObjects.length ||
    manifest.storage?.objectBytes !== storageObjectBytes ||
    (manifest.storage?.included &&
      (typeof manifest.storage.sourceHost !== 'string' ||
        manifest.storage.sourceHost.length === 0 ||
        !Number.isFinite(storageStartedAt) ||
        !Number.isFinite(storageCompletedAt) ||
        storageCompletedAt < storageStartedAt)) ||
    (!manifest.storage?.included &&
      (manifest.storage.exportStartedAt !== null ||
        manifest.storage.exportCompletedAt !== null ||
        manifest.storage.sourceHost !== null ||
        manifest.storage.buckets.length !== 0 ||
        manifest.storage.objects.length !== 0))
  ) {
    throw new Error('Backup manifest has invalid Storage source time or count evidence.');
  }
  return {
    manifest,
    manifestPath,
    sourceManifestSha256,
    stagingDirectory,
    databaseFiles,
    storageObjects,
  };
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedServiceHost(host) {
  const parsed = new URL(`http://${host}`);
  const hostname = parsed.hostname.toLowerCase();
  const normalizedHostname = SOURCE_LOOPBACK_DATABASE_HOSTS.has(hostname) ? 'loopback' : hostname;
  return `${normalizedHostname}:${parsed.port}`;
}

function assertPilotEvidenceIdentifier(name, value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{4,119}$/u.test(value || '')) {
    throw new Error(
      `${name} must be 5-120 characters using only letters, numbers, period, underscore, or dash.`,
    );
  }
}

function pilotRestoreProofSecret() {
  const secret = process.env.PILOT_RESTORE_PROOF_HMAC_SECRET || '';
  const reusesAnotherSecret = Object.entries(process.env).some(
    ([name, value]) =>
      name !== 'PILOT_RESTORE_PROOF_HMAC_SECRET' &&
      /(?:AUTHORIZATION|DATABASE_URL|KEY|PASSWORD|SECRET|TOKEN)$/u.test(name) &&
      Boolean(value) &&
      secret === value,
  );
  if (secret.length < 32 || Buffer.byteLength(secret, 'utf8') < 32 || reusesAnotherSecret) {
    throw new Error(
      'PILOT_RESTORE_PROOF_HMAC_SECRET must be an independent secret of at least 32 bytes.',
    );
  }
  return secret;
}

function sqlTextArray(values) {
  for (const value of values) {
    if (!/^[a-z0-9_.,()[\]|]+$/u.test(value)) {
      throw new Error(`Internal restore-verification identifier is invalid: ${value}`);
    }
  }
  return `ARRAY[${values.map((value) => `'${value}'`).join(',')}]::text[]`;
}

function expectedMigrationSetSha256() {
  return hashBytes(REQUIRED_STORYOPS_MIGRATIONS.join('\n'));
}

async function assertPilotBackupAuthority(backup) {
  const evidence = backup.manifest.database?.recoveryEvidence;
  const schemaRecord = backup.manifest.database?.files?.find(
    (record) => record?.path === 'schema.sql',
  );
  const expectedMigrationHash = expectedMigrationSetSha256();
  const expectedSchemaSentinels = validateStoryOpsSchemaDump(
    await readFile(backup.databaseFiles.get('schema.sql'), 'utf8'),
  );
  const storagePolicyNames = validateStoryOpsStoragePolicyDump(
    await readFile(backup.databaseFiles.get('storage-policies.sql'), 'utf8'),
  );
  const migrationEvidenceIsExact =
    evidence?.requiredMigration === REQUIRED_STORYOPS_MIGRATION &&
    evidence?.requiredMigrationCount === REQUIRED_STORYOPS_MIGRATIONS.length &&
    evidence?.requiredMigrationSetFingerprint?.algorithm === 'sha256' &&
    evidence?.requiredMigrationSetFingerprint?.value === expectedMigrationHash &&
    evidence?.appliedMigrationCount === REQUIRED_STORYOPS_MIGRATIONS.length &&
    evidence?.latestAppliedMigration === REQUIRED_STORYOPS_MIGRATION &&
    evidence?.migrationSetFingerprint?.algorithm === 'sha256' &&
    evidence?.migrationSetFingerprint?.value === expectedMigrationHash &&
    evidence?.serviceRolePublicBaseTablePrivilegeCount === 0;
  const schemaEvidenceIsExact =
    schemaRecord &&
    evidence?.schemaFingerprint?.algorithm === 'sha256' &&
    evidence?.schemaFingerprint?.value === schemaRecord.sha256 &&
    canonicalJson(evidence?.schemaFingerprint?.sentinels) ===
      canonicalJson(expectedSchemaSentinels);
  if (!migrationEvidenceIsExact || !schemaEvidenceIsExact) {
    throw new Error(
      `Pilot restore evidence requires a backup produced from the exact WashOps release migration ${REQUIRED_STORYOPS_MIGRATION}.`,
    );
  }
  if (
    canonicalJson(storagePolicyNames) !== canonicalJson(REQUIRED_STORYOPS_STORAGE_POLICIES) ||
    canonicalJson(evidence?.storagePolicyNames) !== canonicalJson(storagePolicyNames)
  ) {
    throw new Error('Pilot restore evidence requires the exact release Storage policy inventory.');
  }
  if (
    canonicalJson(backup.manifest.database?.dataExclusions) !==
      canonicalJson(REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS) ||
    canonicalJson(backup.manifest.database?.dataSchemas) !==
      canonicalJson(REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS)
  ) {
    throw new Error(
      'Pilot restore evidence requires the exact auth/public/private data-schema allowlist and transient-table exclusions.',
    );
  }
  if (!backup.manifest.storage?.included) {
    throw new Error('Pilot restore evidence requires a backup that includes Storage objects.');
  }
  if (backup.storageObjects.length === 0) {
    throw new Error(
      'Pilot restore evidence requires at least one included Storage object to prove byte recovery.',
    );
  }
  if (!backup.storageObjects.some((object) => object.bytes > 0)) {
    throw new Error(
      'Pilot restore evidence requires at least one non-empty Storage object to prove byte recovery.',
    );
  }
  if (!/^[1-9][0-9]{0,19}$/u.test(backup.manifest.database?.source?.systemIdentifier || '')) {
    throw new Error('Pilot restore evidence requires a trusted source database system identifier.');
  }
  if ((await sha256File(backup.manifestPath)) !== backup.sourceManifestSha256) {
    throw new Error('Backup manifest changed while the restore proof was being prepared.');
  }
}

function storageVerificationFacts(objects) {
  const records = objects
    .map((object) => ({
      bucket: object.bucket,
      name: object.name,
      bytes: object.bytes,
      sha256: object.sha256,
    }))
    .sort((left, right) => {
      const leftKey = `${left.bucket}\0${left.name}`;
      const rightKey = `${right.bucket}\0${right.name}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  let byteCount = 0;
  for (const record of records) {
    byteCount += record.bytes;
    if (!Number.isSafeInteger(byteCount)) {
      throw new Error('Storage verification byte count exceeds the safe integer range.');
    }
  }
  return {
    schemaVersion: STORAGE_BYTE_VERIFICATION_VERSION,
    objectCount: records.length,
    byteCount,
    fingerprintSha256: hashBytes(
      canonicalJson({
        schemaVersion: STORAGE_BYTE_VERIFICATION_VERSION,
        objects: records,
      }),
    ),
  };
}

function targetVerificationSql() {
  const requiredTables = sqlTextArray([...PILOT_REQUIRED_TABLES, ...PILOT_REQUIRED_PRIVATE_TABLES]);
  const requiredFunctions = sqlTextArray(PILOT_REQUIRED_FUNCTIONS);
  const rlsTables = sqlTextArray(PILOT_RLS_TABLES);
  const dispatchOriginPrivateTables = sqlTextArray(PILOT_REQUIRED_PRIVATE_TABLES);
  const dispatchOriginUnloggedTables = sqlTextArray(PILOT_DISPATCH_ORIGIN_UNLOGGED_TABLES);
  const dispatchOriginPrivateFunctions = sqlTextArray(PILOT_DISPATCH_ORIGIN_PRIVATE_FUNCTIONS);
  const dispatchOriginRestrictedFunctions = sqlTextArray([
    ...PILOT_DISPATCH_ORIGIN_PRIVATE_FUNCTIONS,
    ...PILOT_DISPATCH_ORIGIN_RESTRICTED_PUBLIC_FUNCTIONS,
  ]);
  const dispatchOriginServiceFunctions = sqlTextArray(PILOT_DISPATCH_ORIGIN_SERVICE_FUNCTIONS);
  const dispatchOriginAuthenticatedFunctions = sqlTextArray(
    PILOT_DISPATCH_ORIGIN_AUTHENTICATED_FUNCTIONS,
  );
  const releaseRequiredTriggers = sqlTextArray(PILOT_RELEASE_REQUIRED_TRIGGERS);
  return `WITH
required_tables(name) AS (
  SELECT unnest(${requiredTables})
),
required_functions(name) AS (
  SELECT unnest(${requiredFunctions})
),
required_rls_tables(name) AS (
  SELECT unnest(${rlsTables})
)
SELECT jsonb_build_object(
  'schemaVersion', 'storyops-isolated-target-verification-v1',
  'serverCompletedAt', clock_timestamp(),
  'systemIdentifier', (
    SELECT system_identifier::text
    FROM pg_control_system()
  ),
  'activeCompanyIds', (
    SELECT coalesce(jsonb_agg(company.id::text ORDER BY company.id), '[]'::jsonb)
    FROM public.companies company
    WHERE company.status = 'active'
  ),
  'missingTables', (
    SELECT coalesce(jsonb_agg(required.name ORDER BY required.name), '[]'::jsonb)
    FROM required_tables required
    WHERE to_regclass(required.name) IS NULL
  ),
  'missingFunctions', (
    SELECT coalesce(jsonb_agg(required.name ORDER BY required.name), '[]'::jsonb)
    FROM required_functions required
    WHERE to_regprocedure(required.name) IS NULL
  ),
  'rlsDisabledTables', (
    SELECT coalesce(jsonb_agg(required.name ORDER BY required.name), '[]'::jsonb)
    FROM required_rls_tables required
    LEFT JOIN pg_catalog.pg_class relation
      ON relation.oid = to_regclass(required.name)
    WHERE relation.oid IS NULL OR NOT relation.relrowsecurity
  ),
  'storageObjectsRlsEnabled', coalesce((
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = to_regclass('storage.objects')
  ), false),
  'jobMediaBucket', (
    SELECT jsonb_build_object(
      'public', bucket.public,
      'fileSizeLimit', bucket.file_size_limit,
      'allowedMimeTypes', to_jsonb(bucket.allowed_mime_types)
    )
    FROM storage.buckets bucket
    WHERE bucket.id = 'job-media'
  ),
  'jobMediaPolicies', (
    SELECT coalesce(jsonb_agg(policy.policyname ORDER BY policy.policyname), '[]'::jsonb)
    FROM pg_catalog.pg_policies policy
    WHERE policy.schemaname = 'storage'
      AND policy.tablename = 'objects'
      AND policy.policyname IN ('job_media_insert', 'job_media_select', 'job_media_update')
  ),
  'dispatchOriginTransientRowCount', (
    SELECT
      (SELECT count(*) FROM private.dispatch_current_origin_ephemera)
      +
      (SELECT count(*) FROM private.dispatch_current_origin_verifiers)
  ),
  'dispatchOriginTransientTablesUnlogged', (
    SELECT
      count(relation.oid) = 2
      AND bool_and(relation.relpersistence = 'u')
    FROM unnest(${dispatchOriginUnloggedTables}) private_table(name)
    LEFT JOIN pg_catalog.pg_class relation
      ON relation.oid = to_regclass(private_table.name)
  ),
  'dispatchOriginPrivateApiPrivilegeCount', (
    SELECT
      (
        SELECT count(*)
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) api_role(name)
        CROSS JOIN unnest(${dispatchOriginPrivateTables}) private_table(name)
        WHERE has_table_privilege(
          api_role.name,
          private_table.name,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
      )
      +
      (
        SELECT count(*)
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) api_role(name)
        CROSS JOIN unnest(${dispatchOriginPrivateFunctions}) private_function(name)
        WHERE has_function_privilege(
          api_role.name,
          private_function.name,
          'EXECUTE'
        )
      )
      +
      (
        SELECT count(*)
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) api_role(name)
        WHERE has_schema_privilege(api_role.name, 'private', 'USAGE,CREATE')
      )
  ),
  'dispatchOriginFunctionAclMismatchCount', (
    SELECT count(*)
    FROM (
      SELECT
        private_function.name AS function_name,
        api_role.name AS role_name,
        false AS expected
      FROM unnest(${dispatchOriginRestrictedFunctions}) private_function(name)
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) api_role(name)
      UNION ALL
      SELECT
        service_function.name,
        api_role.name,
        api_role.name = 'service_role'
      FROM unnest(${dispatchOriginServiceFunctions}) service_function(name)
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) api_role(name)
      UNION ALL
      SELECT
        authenticated_function.name,
        api_role.name,
        api_role.name = 'authenticated'
      FROM unnest(${dispatchOriginAuthenticatedFunctions}) authenticated_function(name)
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) api_role(name)
    ) expectation
    WHERE has_function_privilege(
      expectation.role_name,
      expectation.function_name,
      'EXECUTE'
    ) IS DISTINCT FROM expectation.expected
  ),
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
  ),
  'releaseBoundaryCatalogMismatchCount', (
    SELECT count(*)::integer
    FROM unnest(${releaseRequiredTriggers}) required_trigger(binding)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger trigger_record
      WHERE trigger_record.tgrelid =
        to_regclass(split_part(required_trigger.binding, '|', 1))
        AND trigger_record.tgname =
          split_part(required_trigger.binding, '|', 2)
        AND NOT trigger_record.tgisinternal
        AND trigger_record.tgenabled = 'O'
    )
  )
  + CASE
      WHEN coalesce((
        SELECT relation.relrowsecurity AND relation.relforcerowsecurity
        FROM pg_catalog.pg_class relation
        WHERE relation.oid =
          to_regclass('public.identity_invitation_attempts')
      ), false)
      THEN 0
      ELSE 1
    END
  + CASE
      WHEN EXISTS (
        SELECT 1
        FROM pg_catalog.pg_index index_record
        JOIN pg_catalog.pg_class index_relation
          ON index_relation.oid = index_record.indexrelid
        WHERE index_relation.relname =
            'identity_invitation_attempts_one_unresolved_email_idx'
          AND index_record.indrelid =
            to_regclass('public.identity_invitation_attempts')
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indpred IS NOT NULL
          AND pg_get_indexdef(index_record.indexrelid)
            LIKE '%company_id%normalized_email%'
          AND pg_get_indexdef(index_record.indexrelid) LIKE '%pending%'
          AND pg_get_indexdef(index_record.indexrelid)
            LIKE '%provider_submission_accepted%'
          AND pg_get_indexdef(index_record.indexrelid)
            LIKE '%provider_submission_unknown%'
      )
      THEN 0
      ELSE 1
    END,
  'dispatchOriginRetentionHealthy',
    coalesce(private.storyops_dispatch_origin_retention_healthy(), false)
)::text;`;
}

function publicTableAclNormalizationSql() {
  return `DO $storyops_public_table_acl_normalization$
DECLARE
  public_relation record;
  remaining_elevated_privilege_count integer;
BEGIN
  FOR public_relation IN
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS relation_name
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
    ORDER BY relation.oid
  LOOP
    EXECUTE format(
      'REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE %I.%I FROM %I, %I, %I',
      public_relation.schema_name,
      public_relation.relation_name,
      'anon',
      'authenticated',
      'service_role'
    );
  END LOOP;

  SELECT count(*)::integer
  INTO remaining_elevated_privilege_count
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace
    ON namespace.oid = relation.relnamespace
  CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']::name[]) api_role(name)
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p')
    AND (
      has_table_privilege(api_role.name, relation.oid, 'TRUNCATE')
      OR has_table_privilege(api_role.name, relation.oid, 'REFERENCES')
      OR has_table_privilege(api_role.name, relation.oid, 'TRIGGER')
    );

  IF remaining_elevated_privilege_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION
      'STORYOPS_PUBLIC_TABLE_ACL_NORMALIZATION_FAILED: % elevated privilege binding(s) remain',
      remaining_elevated_privilege_count;
  END IF;
END;
$storyops_public_table_acl_normalization$;`;
}

function dispatchOriginRetentionRestoreSql() {
  return `SET session_replication_role = origin;
DO $storyops_dispatch_origin_restore$
DECLARE
  existing_job_id bigint;
  scheduled_job_id bigint;
BEGIN
  IF to_regclass('private.dispatch_current_origin_ephemera') IS NULL
    OR to_regclass('private.dispatch_current_origin_verifiers') IS NULL
    OR to_regclass('private.dispatch_origin_purge_worker_health') IS NULL
  THEN
    RAISE EXCEPTION 'DISPATCH_ORIGIN_RETENTION_SCHEMA_MISSING';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.dispatch_current_origin_ephemera
  ) OR EXISTS (
    SELECT 1
    FROM private.dispatch_current_origin_verifiers
  )
  THEN
    RAISE EXCEPTION 'DISPATCH_ORIGIN_TRANSIENT_ROWS_MUST_NOT_BE_RESTORED';
  END IF;

  INSERT INTO private.dispatch_origin_purge_worker_health(
    singleton,
    schedule_job_id,
    schedule_registered_at,
    last_started_at,
    last_completed_at,
    last_status,
    last_purged_count,
    last_cron_history_purged_count,
    last_error,
    updated_at
  )
  VALUES (
    true,
    null,
    null,
    null,
    null,
    'pending',
    0,
    0,
    null,
    statement_timestamp()
  )
  ON CONFLICT (singleton) DO UPDATE
  SET
    schedule_job_id = null,
    schedule_registered_at = null,
    last_started_at = null,
    last_completed_at = null,
    last_status = 'pending',
    last_purged_count = 0,
    last_cron_history_purged_count = 0,
    last_error = null,
    updated_at = statement_timestamp();

  FOR existing_job_id IN
    SELECT job.jobid
    FROM cron.job job
    WHERE job.jobname = 'storyops-dispatch-origin-purge'
  LOOP
    PERFORM cron.unschedule(existing_job_id);
  END LOOP;

  scheduled_job_id := cron.schedule(
    'storyops-dispatch-origin-purge',
    '5 seconds',
    'select private.run_storyops_dispatch_origin_purge_worker();'
  );

  UPDATE private.dispatch_origin_purge_worker_health
  SET
    schedule_job_id = scheduled_job_id,
    schedule_registered_at = statement_timestamp(),
    updated_at = statement_timestamp()
  WHERE singleton;

  -- This eagerly exercises the cleanup function. It deliberately cannot
  -- satisfy retention health without a later successful pg_cron run.
  PERFORM private.run_storyops_dispatch_origin_purge_worker();
END;
$storyops_dispatch_origin_restore$;`;
}

async function waitForDispatchOriginSchedulerHealth({ database, psqlEnvironment, secretValues }) {
  const attempts = 30;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runCommand({
      command: 'psql',
      args: [
        '--tuples-only',
        '--no-align',
        '--variable',
        'ON_ERROR_STOP=1',
        '--command',
        "SELECT CASE WHEN private.storyops_dispatch_origin_retention_healthy() THEN 'verified' ELSE 'blocked' END;",
        '--dbname',
        database.database,
      ],
      env: psqlEnvironment,
      capture: true,
      secrets: secretValues,
    });
    const status = result.stdout.trim();
    if (status === 'verified') return;
    if (status !== 'blocked') {
      throw new Error('Dispatch-origin scheduler verification returned an invalid result.');
    }
    if (attempt < attempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
  }
  throw new Error(
    'Restore committed, but no successful pg_cron dispatch-origin purge run was observed within 30 seconds. Pilot proof and cutover remain blocked.',
  );
}

function stringArray(value) {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string') &&
    new Set(value).size === value.length
  );
}

function validateTargetVerification(value, verificationStartedAt, verificationFinishedAt) {
  const exactKeys = [
    'activeCompanyIds',
    'dispatchOriginFunctionAclMismatchCount',
    'dispatchOriginPrivateApiPrivilegeCount',
    'dispatchOriginRetentionHealthy',
    'dispatchOriginTransientRowCount',
    'dispatchOriginTransientTablesUnlogged',
    'jobMediaBucket',
    'jobMediaPolicies',
    'missingFunctions',
    'missingTables',
    'releaseBoundaryCatalogMismatchCount',
    'rlsDisabledTables',
    'schemaVersion',
    'serverCompletedAt',
    'serviceRolePublicBaseTablePrivilegeCount',
    'storageObjectsRlsEnabled',
    'systemIdentifier',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(exactKeys) ||
    value.schemaVersion !== 'storyops-isolated-target-verification-v1' ||
    !/^[1-9][0-9]{0,19}$/u.test(value.systemIdentifier || '') ||
    !stringArray(value.activeCompanyIds) ||
    value.activeCompanyIds.length !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      value.activeCompanyIds[0],
    ) ||
    !stringArray(value.missingTables) ||
    value.missingTables.length !== 0 ||
    !stringArray(value.missingFunctions) ||
    value.missingFunctions.length !== 0 ||
    !stringArray(value.rlsDisabledTables) ||
    value.rlsDisabledTables.length !== 0 ||
    value.storageObjectsRlsEnabled !== true ||
    value.dispatchOriginFunctionAclMismatchCount !== 0 ||
    value.dispatchOriginPrivateApiPrivilegeCount !== 0 ||
    value.serviceRolePublicBaseTablePrivilegeCount !== 0 ||
    value.releaseBoundaryCatalogMismatchCount !== 0 ||
    value.dispatchOriginTransientRowCount !== 0 ||
    value.dispatchOriginTransientTablesUnlogged !== true ||
    value.dispatchOriginRetentionHealthy !== true ||
    !stringArray(value.jobMediaPolicies) ||
    !value.jobMediaPolicies.includes('job_media_insert') ||
    !value.jobMediaPolicies.includes('job_media_select') ||
    value.jobMediaPolicies.includes('job_media_update') ||
    !value.jobMediaBucket ||
    typeof value.jobMediaBucket !== 'object' ||
    Array.isArray(value.jobMediaBucket) ||
    value.jobMediaBucket.public !== false ||
    Number(value.jobMediaBucket.fileSizeLimit) !== 26_214_400 ||
    !stringArray(value.jobMediaBucket.allowedMimeTypes) ||
    canonicalJson([...value.jobMediaBucket.allowedMimeTypes].sort()) !==
      canonicalJson(PILOT_JOB_MEDIA_MIME_TYPES)
  ) {
    throw new Error(
      'The restored target failed required schema, RLS, active-company, private job-media, or dispatch-origin retention verification.',
    );
  }
  const completedAt = Date.parse(value.serverCompletedAt);
  if (
    !Number.isFinite(completedAt) ||
    completedAt < verificationStartedAt - 5 * 60_000 ||
    completedAt > verificationFinishedAt + 5 * 60_000
  ) {
    throw new Error('The restored target returned an invalid or stale server completion time.');
  }
  return {
    companyId: value.activeCompanyIds[0],
    completedAt: new Date(completedAt).toISOString(),
  };
}

async function createPilotRestoreEvidence({
  backup,
  database,
  psqlEnvironment,
  evidenceOutput,
  evidenceReference,
  isolationId,
  secret,
  storageVerification,
  targetSystemIdentifier,
  targetStorageHost,
}) {
  if (!commandExists('pg_dump')) {
    throw new Error('pg_dump is required to produce target-derived restore evidence.');
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'storyops-restore-proof-'));
  const dumpPath = join(temporaryDirectory, 'restored-target.sql');
  try {
    await runCommand({
      command: 'pg_dump',
      args: [
        '--format=plain',
        '--no-owner',
        '--no-privileges',
        '--schema-only',
        '--schema=public',
        '--schema=private',
        '--file',
        dumpPath,
        '--dbname',
        database.database,
      ],
      env: psqlEnvironment,
      secrets: [database.raw, secret],
    });
    validateStoryOpsSchemaDump(await readFile(dumpPath, 'utf8'));
    const verificationStartedAt = Date.now();
    const targetState = await runCommand({
      command: 'psql',
      args: [
        '--tuples-only',
        '--no-align',
        '--variable',
        'ON_ERROR_STOP=1',
        '--command',
        targetVerificationSql(),
        '--dbname',
        database.database,
      ],
      env: psqlEnvironment,
      capture: true,
      secrets: [database.raw, secret],
    });
    const verificationFinishedAt = Date.now();
    let verifiedTarget;
    try {
      verifiedTarget = JSON.parse(targetState.stdout.trim());
    } catch {
      throw new Error('The restored target did not return valid verification evidence.');
    }
    const { companyId, completedAt } = validateTargetVerification(
      verifiedTarget,
      verificationStartedAt,
      verificationFinishedAt,
    );
    if (verifiedTarget.systemIdentifier !== targetSystemIdentifier) {
      throw new Error('The restored target database identity changed during verification.');
    }
    const sourceSystemIdentifier = backup.manifest.database.source.systemIdentifier;
    if (targetSystemIdentifier === sourceSystemIdentifier) {
      throw new Error(
        'Pilot restore evidence cannot be produced against the source database system.',
      );
    }
    if ((await sha256File(backup.manifestPath)) !== backup.sourceManifestSha256) {
      throw new Error('Backup manifest changed during the isolated restore.');
    }
    const expectedStorageVerification = storageVerificationFacts(backup.storageObjects);
    if (
      !storageVerification ||
      canonicalJson(storageVerification) !== canonicalJson(expectedStorageVerification)
    ) {
      throw new Error(
        'Signed pilot evidence requires exact target-read Storage byte verification.',
      );
    }
    const restoreEvidence = {
      schemaVersion: 'storyops-isolated-restore-evidence-v2',
      restoreCommandId: randomUUID(),
      evidenceReference,
      isolationId,
      status: 'committed',
      isolatedTarget: true,
      sourceManifestSha256: backup.sourceManifestSha256,
      restoredDatabaseSha256: await sha256File(dumpPath),
      verifiedMigrationId: REQUIRED_STORYOPS_MIGRATION,
      sourceDatabaseSystemIdentifier: sourceSystemIdentifier,
      targetDatabaseSystemIdentifier: targetSystemIdentifier,
      sourceStorageHost: backup.manifest.storage.sourceHost.toLowerCase(),
      targetStorageHost,
      storageVerification,
      completedAt,
    };
    const request = {
      operation: 'backup_restore',
      companyId,
      commandId: randomUUID(),
      requestedAt: completedAt,
      expiresAt: new Date(Date.parse(completedAt) + 30 * 24 * 60 * 60_000).toISOString(),
      restoreEvidence,
    };
    const signature = createHmac('sha256', secret)
      .update(`${SIGNED_RESTORE_PROOF_DOMAIN}${canonicalJson(request)}`)
      .digest('hex');
    const artifact = {
      schemaVersion: SIGNED_RESTORE_PROOF_VERSION,
      request,
      headerName: 'x-storyops-restore-proof',
      headerValue: signature,
    };
    await writeFile(evidenceOutput, `${JSON.stringify(artifact, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(evidenceOutput, 0o600);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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
  await validateExistingBucketPolicies({
    backup,
    client,
    storageUrl,
    allowPolicyDrift,
    policyDriftConfirmation,
  });

  let uploaded = 0;
  let alreadyPresent = 0;
  const verifiedObjects = [];
  for (const object of backup.storageObjects) {
    const bytes = new Uint8Array(await readFile(object.filePath));
    if (bytes.byteLength !== object.bytes || hashBytes(bytes) !== object.sha256) {
      throw new Error(
        `Backup Storage object "${object.bucket}/${object.name}" changed after manifest validation.`,
      );
    }
    const { error } = await client.storage.from(object.bucket).upload(object.name, bytes, {
      cacheControl: object.cacheControl || undefined,
      contentType: object.contentType || undefined,
      upsert: replace,
    });
    if (!error) {
      uploaded += 1;
    } else if (replace) {
      throw new Error(
        `Unable to replace Storage object "${object.bucket}/${object.name}": ${error.message}`,
      );
    } else {
      alreadyPresent += 1;
    }

    // Both a new upload and an idempotent retry are accepted only after a fresh
    // target read proves the exact manifest bytes. Provider acceptance is not
    // durable-object evidence.
    const { data: targetObject, error: downloadError } = await client.storage
      .from(object.bucket)
      .download(object.name);
    if (downloadError || !targetObject) {
      throw new Error(
        `Unable to verify restored Storage object "${object.bucket}/${object.name}": ${
          downloadError?.message || 'the target returned no bytes'
        }`,
      );
    }
    const targetBytes = new Uint8Array(await targetObject.arrayBuffer());
    const targetHash = hashBytes(targetBytes);
    if (targetBytes.byteLength !== object.bytes || targetHash !== object.sha256) {
      throw new Error(
        `Storage byte verification failed for "${object.bucket}/${object.name}". The target object does not match the backup manifest.`,
      );
    }
    verifiedObjects.push({
      bucket: object.bucket,
      name: object.name,
      bytes: targetBytes.byteLength,
      sha256: targetHash,
    });
  }
  return {
    uploaded,
    alreadyPresent,
    verification: storageVerificationFacts(verifiedObjects),
  };
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
      '--expected-manifest-sha256',
      '--db-url',
      '--confirm-target',
      '--storage-url',
      '--storage-key',
      '--confirm-storage-host',
      '--confirm-storage-policy-drift',
      '--pilot-evidence-out',
      '--pilot-isolation-id',
      '--pilot-evidence-reference',
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
  const execute = hasFlag(argv, '--execute');
  const backupOption = optionValue(argv, '--backup');
  if (!backupOption) throw new Error('--backup DIRECTORY is required.');
  const backupDirectory = resolve(backupOption);
  const expectedManifestSha256 = optionValue(
    argv,
    '--expected-manifest-sha256',
    process.env.STORYOPS_BACKUP_MANIFEST_SHA256,
  );
  if (expectedManifestSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(expectedManifestSha256)) {
    throw new Error('--expected-manifest-sha256 must be an exact lowercase SHA-256 digest.');
  }
  if (execute && expectedManifestSha256 === undefined) {
    throw new Error(
      'Executable restore requires an independently retained manifest digest via --expected-manifest-sha256 or STORYOPS_BACKUP_MANIFEST_SHA256.',
    );
  }
  const backup = await validateBackup(backupDirectory, expectedManifestSha256);

  const explicitDatabaseUrl = optionValue(argv, '--db-url');
  if (hasFlag(argv, '--local') && explicitDatabaseUrl) {
    throw new Error('--local and --db-url are mutually exclusive.');
  }
  const databaseUrl = hasFlag(argv, '--local')
    ? LOCAL_DATABASE_URL
    : explicitDatabaseUrl || process.env.STORYOPS_DATABASE_URL || LOCAL_DATABASE_URL;
  const database = parseDatabaseUrl(databaseUrl);
  const restoreStorageRequested = hasFlag(argv, '--restore-storage');
  const storageUrl = optionValue(argv, '--storage-url', process.env.SUPABASE_URL);
  const storageKey = optionValue(argv, '--storage-key', process.env.SUPABASE_SERVICE_ROLE_KEY);
  const replaceStorage = hasFlag(argv, '--replace-storage');
  const allowStoragePolicyDrift = hasFlag(argv, '--allow-storage-policy-drift');
  const storagePolicyDriftConfirmation = optionValue(argv, '--confirm-storage-policy-drift');
  const confirmation = optionValue(argv, '--confirm-target');
  const pilotEvidenceOption = optionValue(argv, '--pilot-evidence-out');
  const pilotIsolationId = optionValue(argv, '--pilot-isolation-id');
  const pilotEvidenceReference = optionValue(argv, '--pilot-evidence-reference');
  const pilotOptions = [pilotEvidenceOption, pilotIsolationId, pilotEvidenceReference].filter(
    Boolean,
  );
  let pilotProofSecret;
  if (pilotOptions.length !== 0 && pilotOptions.length !== 3) {
    throw new Error(
      '--pilot-evidence-out, --pilot-isolation-id, and --pilot-evidence-reference must be supplied together.',
    );
  }
  if (pilotEvidenceOption) {
    if (!execute) {
      throw new Error('--pilot-evidence-out is available only for an executed restore.');
    }
    if (!explicitDatabaseUrl || hasFlag(argv, '--local')) {
      throw new Error(
        'Pilot restore evidence requires an explicit isolated loopback --db-url target; --local is not accepted.',
      );
    }
    if (
      !database.isLocal ||
      !PILOT_LOCAL_DATABASE_HOSTS.has(database.host) ||
      hasFlag(argv, '--allow-remote')
    ) {
      throw new Error('Pilot restore evidence is restricted to an isolated local target.');
    }
    if (hasFlag(argv, '--allow-nonempty')) {
      throw new Error('Pilot restore evidence requires a fresh target without --allow-nonempty.');
    }
    if (hasFlag(argv, '--skip-roles')) {
      throw new Error('Pilot restore evidence requires the complete role restore.');
    }
    if (replaceStorage || allowStoragePolicyDrift) {
      throw new Error(
        'Pilot restore evidence does not permit Storage overwrite or policy-drift overrides.',
      );
    }
    if (!restoreStorageRequested) {
      throw new Error('Pilot restore evidence requires --restore-storage.');
    }
    if (!storageUrl) {
      throw new Error('Pilot restore evidence requires an explicit target Storage URL.');
    }
    const source = backup.manifest.database?.source;
    const sourceHost = typeof source?.host === 'string' ? source.host.toLowerCase() : source?.host;
    const normalizedSourceHost = SOURCE_LOOPBACK_DATABASE_HOSTS.has(sourceHost)
      ? 'loopback'
      : sourceHost;
    const normalizedTargetHost = PILOT_LOCAL_DATABASE_HOSTS.has(database.host)
      ? 'loopback'
      : database.host;
    if (
      normalizedSourceHost === normalizedTargetHost &&
      String(source?.port) === database.port &&
      source?.database === database.database
    ) {
      throw new Error(
        'Pilot restore evidence requires a target endpoint different from the backup source.',
      );
    }
    const targetStorageHost = new URL(storageUrl).host.toLowerCase();
    const sourceStorageHost =
      typeof backup.manifest.storage.sourceHost === 'string'
        ? backup.manifest.storage.sourceHost.toLowerCase()
        : null;
    if (
      sourceStorageHost &&
      normalizedServiceHost(sourceStorageHost) === normalizedServiceHost(targetStorageHost)
    ) {
      throw new Error(
        'Pilot restore evidence requires a target Storage endpoint different from the backup source.',
      );
    }
    assertPilotEvidenceIdentifier('--pilot-isolation-id', pilotIsolationId);
    assertPilotEvidenceIdentifier('--pilot-evidence-reference', pilotEvidenceReference);
    pilotProofSecret = pilotRestoreProofSecret();
    if (pilotProofSecret === storageKey || pilotProofSecret === database.password) {
      throw new Error(
        'PILOT_RESTORE_PROOF_HMAC_SECRET must not reuse target database or Storage credentials.',
      );
    }
    if (existsSync(resolve(pilotEvidenceOption))) {
      throw new Error('Pilot restore evidence output already exists and will not be overwritten.');
    }
    await assertPilotBackupAuthority(backup);
  }
  if (allowStoragePolicyDrift && !/^[a-f0-9]{64}$/u.test(storagePolicyDriftConfirmation || '')) {
    throw new Error(
      '--allow-storage-policy-drift requires an exact lowercase SHA-256 from --confirm-storage-policy-drift.',
    );
  }

  if (restoreStorageRequested && !backup.manifest.storage?.included) {
    throw new Error('This backup does not include Storage objects.');
  }
  if (
    restoreStorageRequested &&
    (canonicalJson(backup.manifest.database?.dataExclusions) !==
      canonicalJson(REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS) ||
      canonicalJson(backup.manifest.database?.dataSchemas) !==
        canonicalJson(REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS))
  ) {
    throw new Error(
      'Storage API restore requires an auth/public/private-only data dump with transient rows excluded.',
    );
  }
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
    '--file',
    backup.databaseFiles.get('storage-policies.sql'),
    '--command',
    'SET session_replication_role = replica',
    '--file',
    backup.databaseFiles.get('data.sql'),
    '--command',
    publicTableAclNormalizationSql(),
    '--command',
    dispatchOriginRetentionRestoreSql(),
    '--dbname',
    database.database,
  );
  const psqlEnvironment = databaseEnvironment(database);
  let targetSystemIdentifier;

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
      'PLAN require a successful scheduler-derived dispatch-origin purge run before completion\n',
    );
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
      "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema','auth','storage','extensions','realtime','_realtime','supabase_functions','supabase_migrations','vault','graphql','graphql_public','net','pgbouncer') AND schemaname NOT LIKE 'pg_toast%';",
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
  if (pilotEvidenceOption) {
    const identityResult = await runCommand({
      command: 'psql',
      args: [
        '--tuples-only',
        '--no-align',
        '--variable',
        'ON_ERROR_STOP=1',
        '--command',
        'SELECT system_identifier::text FROM pg_control_system();',
        '--dbname',
        database.database,
      ],
      env: psqlEnvironment,
      capture: true,
      secrets: [database.raw],
    });
    targetSystemIdentifier = identityResult.stdout.trim();
    if (!/^[1-9][0-9]{0,19}$/u.test(targetSystemIdentifier)) {
      throw new Error('The restore target returned an invalid database system identifier.');
    }
    if (targetSystemIdentifier === backup.manifest.database.source.systemIdentifier) {
      throw new Error(
        'Pilot restore evidence cannot be produced against the source database system.',
      );
    }
  }

  await runCommand({
    command: 'psql',
    args: psqlArgs,
    env: psqlEnvironment,
    secrets: [database.raw],
  });
  process.stdout.write(
    'Database restore transaction committed; waiting for scheduler-derived dispatch-origin retention health.\n',
  );
  await waitForDispatchOriginSchedulerHealth({
    database,
    psqlEnvironment,
    secretValues: [database.raw],
  });
  process.stdout.write('Dispatch-origin retention scheduler verified healthy.\n');

  let storageVerification;
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
    storageVerification = result.verification;
  }
  if (pilotEvidenceOption) {
    const evidenceOutput = resolve(pilotEvidenceOption);
    await createPilotRestoreEvidence({
      backup,
      database,
      psqlEnvironment,
      evidenceOutput,
      evidenceReference: pilotEvidenceReference,
      isolationId: pilotIsolationId,
      secret: pilotProofSecret,
      storageVerification,
      targetSystemIdentifier,
      targetStorageHost: new URL(storageUrl).host.toLowerCase(),
    });
    process.stdout.write(
      `Signed isolated-restore evidence written to ${evidenceOutput}. It was not submitted or sent anywhere.\n`,
    );
  }
  process.stdout.write(
    'Restore complete. Validate RLS, authentication, provider health, row counts, and a read-only application smoke test before cutover.\n',
  );
}

main()
  .finally(async () => {
    const stagingDirectory = activeRestoreStagingDirectory;
    activeRestoreStagingDirectory = undefined;
    if (stagingDirectory) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  })
  .catch(printErrorAndExit);
