import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import {
  REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS,
  REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS,
  REQUIRED_STORYOPS_STORAGE_POLICIES,
  extractStoryOpsStoragePolicyDump,
  validateStorageExcludedDataDump,
  validateStoryOpsExcludedDataDump,
  validateStoryOpsStoragePolicyDump,
} from '../../infra/scripts/storage-recovery.mjs';

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
    { name: 'public.scheduling_evidence_receipts', estimated_row_count: '2' },
    { name: 'public.customer_portal_requests', estimated_row_count: '3' },
    { name: 'public.scheduling_reconciliation_cases', estimated_row_count: '1' },
    { name: 'public.scheduling_calendar_booking_attempts', estimated_row_count: '2' },
    { name: 'public.job_actual_cost_snapshots', estimated_row_count: '4' },
    { name: 'public.automation_runs', estimated_row_count: '3' },
    { name: 'public.owner_briefings', estimated_row_count: '1' },
    { name: 'public.customer_quote_change_requests', estimated_row_count: '2' },
    { name: 'public.payment_allocation_conflicts', estimated_row_count: '1' },
    { name: 'public.payment_checkout_retirements', estimated_row_count: '3' },
    { name: 'public.customer_quote_acceptances', estimated_row_count: '2' },
    { name: 'public.lead_intake_operational_dispositions', estimated_row_count: '6' },
    { name: 'public.transactional_delivery_attempts', estimated_row_count: '4' },
    { name: 'public.field_change_requests', estimated_row_count: '2' },
    { name: 'public.recurring_due_occurrences', estimated_row_count: '1' },
    { name: 'public.sds_registration_requests', estimated_row_count: '1' },
    { name: 'public.sds_upload_attestations', estimated_row_count: '1' },
    { name: 'public.integration_environment_probe_results', estimated_row_count: '10' },
    { name: 'public.company_launch_authorization_events', estimated_row_count: '1' },
    { name: 'public.trusted_pilot_verification_runs', estimated_row_count: '2' },
    { name: 'public.dispatch_clearance_receipts', estimated_row_count: '1' },
    { name: 'public.dispatch_clearance_consumptions', estimated_row_count: '1' },
    { name: 'public.identity_provisioning_targets', estimated_row_count: '2' },
    { name: 'public.identity_provisioning_commands', estimated_row_count: '3' },
    { name: 'public.identity_invitation_attempts', estimated_row_count: '1' },
    { name: 'public.property_geocode_candidates', estimated_row_count: '2' },
    { name: 'private.storyops_private_worker_heartbeats', estimated_row_count: '4' },
    {
      name: 'private.storyops_private_worker_readiness_snapshots',
      estimated_row_count: '2',
    },
    { name: 'public.jobs', estimated_row_count: '7' },
  ],
});

const fakeStoragePolicyStatements = [
  `CREATE POLICY "company_assets_owner_insert" ON "storage"."objects" FOR INSERT WITH CHECK (("bucket_id" = 'company-assets') AND "public"."lock_storyops_active_company"(null) AND "public"."has_company_role"(null, null));`,
  `CREATE POLICY "company_assets_owner_update" ON "storage"."objects" FOR UPDATE USING (("bucket_id" = 'company-assets') AND "public"."lock_storyops_active_company"(null) AND "public"."has_company_role"(null, null)) WITH CHECK (("bucket_id" = 'company-assets'));`,
  `CREATE POLICY "company_assets_select" ON "storage"."objects" FOR SELECT USING (("bucket_id" = 'company-assets') AND "public"."has_company_role"(null, null));`,
  `CREATE POLICY "job_media_insert" ON "storage"."objects" FOR INSERT WITH CHECK (("bucket_id" = 'job-media') AND "public"."can_upload_job_media_object"("name"));`,
  `CREATE POLICY "job_media_select" ON "storage"."objects" FOR SELECT USING (("bucket_id" = 'job-media') AND ("public"."can_read_job_media_object"("name") OR "public"."can_upload_job_media_object"("name")));`,
  `CREATE POLICY "sds_owner_insert" ON "storage"."objects" FOR INSERT WITH CHECK (("bucket_id" = 'sds') AND "public"."can_upload_storyops_sds_object"("name"));`,
  `CREATE POLICY "sds_select" ON "storage"."objects" FOR SELECT USING (("bucket_id" = 'sds') AND "public"."has_company_role"(null, null));`,
];

async function fakeSupabaseCommand(directory) {
  const executable = resolve(directory, 'npx');
  const psql = resolve(directory, 'psql');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_SUPABASE_LOG) {
  fs.appendFileSync(process.env.FAKE_SUPABASE_LOG, JSON.stringify(args) + '\\n');
}
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
      'CREATE TABLE public.scheduling_evidence_receipts (id uuid);',
      'CREATE TABLE public.customer_portal_requests (id uuid);',
      'CREATE TABLE public.scheduling_reconciliation_cases (id uuid);',
      'CREATE TABLE public.scheduling_calendar_booking_attempts (id uuid);',
      'CREATE TABLE public.job_actual_cost_snapshots (id uuid);',
      'CREATE TABLE public.automation_runs (id uuid);',
      'CREATE TABLE public.owner_briefings (id uuid);',
      'CREATE TABLE public.customer_quote_change_requests (id uuid);',
      'CREATE TABLE public.payment_allocation_conflicts (id uuid);',
      'CREATE TABLE public.payment_checkout_retirements (id uuid);',
      'CREATE TABLE public.customer_quote_acceptances (id uuid);',
      'CREATE TABLE public.lead_intake_operational_dispositions (id uuid);',
      'CREATE TABLE public.transactional_delivery_attempts (id uuid);',
      'CREATE TABLE public.field_change_requests (id uuid);',
      'CREATE TABLE public.recurring_due_occurrences (id uuid);',
      'CREATE TABLE public.sds_registration_requests (id uuid);',
      'CREATE TABLE public.sds_upload_attestations (id uuid);',
      'CREATE TABLE public.integration_environment_probe_results (id uuid);',
      'CREATE TABLE public.company_launch_authorization_events (id uuid);',
      'CREATE TABLE public.trusted_pilot_verification_runs (id uuid);',
      'CREATE TABLE public.dispatch_clearance_receipts (id uuid);',
      'CREATE TABLE public.dispatch_clearance_consumptions (id uuid);',
      'CREATE TABLE public.identity_provisioning_targets (id uuid);',
      'CREATE TABLE public.identity_provisioning_commands (id uuid);',
      'CREATE TABLE public.identity_invitation_attempts (id uuid);',
      'CREATE TABLE public.property_geocode_candidates (id uuid);',
      'CREATE TABLE private.storyops_private_worker_heartbeats (company_id uuid);',
      'CREATE TABLE private.storyops_private_worker_readiness_snapshots (company_id uuid);',
      'CREATE TABLE private.storyops_incident_stop_capabilities (capability_token uuid);',
      'CREATE TABLE private.storyops_incident_close_capabilities (capability_token uuid);',
      "ALTER TABLE public.dispatch_clearance_receipts ADD COLUMN current_origin jsonb CHECK (current_origin ->> 'schemaVersion' = 'storyops-dispatch-current-origin-v1');",
      'CREATE TRIGGER media_assets_incident_evidence_guard BEFORE INSERT OR UPDATE ON public.media_assets EXECUTE FUNCTION public.enforce_storyops_incident_media_association();',
      'CREATE TRIGGER aa_incidents_safe_update_guard BEFORE UPDATE ON public.incidents EXECUTE FUNCTION public.enforce_storyops_incident_update();',
      'CREATE TRIGGER media_assets_open_incident_stop_work BEFORE INSERT OR UPDATE ON public.media_assets EXECUTE FUNCTION public.enforce_storyops_incident_stop_work();',
      'CREATE TRIGGER dispatch_clearance_consumption_current_origin_guard BEFORE INSERT ON public.dispatch_clearance_consumptions EXECUTE FUNCTION public.enforce_storyops_dispatch_current_origin_consumption();',
      "COMMENT ON FUNCTION public.is_customer_user(uuid, uuid) IS 'Portal authorization requires both the exact portal mapping and a current active customer membership.';",
      'CREATE UNIQUE INDEX referrals_one_invite_per_source_invoice_idx',
      '  ON public.referrals(company_id, source_invoice_id);',
      'CREATE FUNCTION public.get_storyops_setup_state(uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.begin_storyops_post_service_submission(uuid, uuid, text) RETURNS jsonb;',
      'CREATE FUNCTION public.finalize_storyops_media_upload(uuid, uuid, uuid, jsonb, text) RETURNS jsonb;',
      'CREATE FUNCTION public.finalize_storyops_media_upload_from_edge(uuid, uuid, uuid, jsonb, text) RETURNS jsonb AS $$ BEGIN result := public.finalize_storyops_media_upload(null, null, null, null, null); RETURN result; END; $$ LANGUAGE plpgsql;',
      'CREATE FUNCTION public.reserve_storyops_field_media_verification(uuid, uuid, uuid, uuid, text) RETURNS jsonb;',
      'CREATE FUNCTION public.claim_storyops_field_media_verification(uuid, uuid, uuid, uuid, text) RETURNS jsonb;',
      'CREATE FUNCTION public.complete_storyops_field_media_verification(uuid, text) RETURNS jsonb;',
      'CREATE FUNCTION private.is_storyops_field_media_canary_object(text) RETURNS boolean;',
      'CREATE FUNCTION public.can_upload_job_media_object(target_name text) RETURNS boolean AS $$ BEGIN RETURN private.is_storyops_field_media_canary_object(target_name); END; $$ LANGUAGE plpgsql;',
      'CREATE FUNCTION public.claim_storyops_scheduling_reconciliation(uuid, uuid, integer) RETURNS jsonb;',
      'CREATE FUNCTION public.get_storyops_profitability_kpis(uuid) RETURNS jsonb;',
      'ALTER TABLE public.service_catalog ADD COLUMN scope_evidence_policy text;',
      'CREATE FUNCTION public.validate_travel_zone_configuration(jsonb, text) RETURNS jsonb;',
      'CREATE FUNCTION public.execute_ai_approved_lead_action(uuid, uuid, uuid, text, jsonb, text, uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.load_service_scope_evidence_policies(uuid, uuid, text[]) RETURNS jsonb;',
      "SELECT service_value ->> 'pricingUnit' = 'hour' AND measurement.kind = 'duration_hours';",
      'CREATE FUNCTION public.persist_priced_estimate(uuid) RETURNS jsonb AS $$',
      'DECLARE expected_service_measurement_ids jsonb;',
      "BEGIN RAISE EXCEPTION 'ESTIMATE_SUPPORTING_MEASUREMENT_EVIDENCE_MISMATCH'; END;",
      '$$ LANGUAGE plpgsql;',
      'CREATE FUNCTION public.enforce_active_company_approved_action_start() RETURNS trigger;',
      'CREATE FUNCTION public.load_estimate_scope_evidence_bundle(uuid, uuid, uuid, uuid, uuid[]) RETURNS jsonb;',
      'CREATE TRIGGER estimates_scope_evidence_bundle BEFORE INSERT ON public.estimates;',
      'CREATE FUNCTION public.begin_storyops_ai_office_run(uuid, uuid, uuid, text, text, jsonb, boolean, timestamptz) RETURNS jsonb;',
      'CREATE FUNCTION public.complete_storyops_ai_office_run(uuid, uuid, uuid, text, text, jsonb) RETURNS jsonb;',
      'CREATE FUNCTION public.fail_storyops_ai_office_run(uuid, uuid, uuid, text, text, text) RETURNS jsonb;',
      'CREATE FUNCTION public.get_storyops_ai_office_recent(uuid, integer) RETURNS jsonb;',
      'CREATE FUNCTION public.load_storyops_edge_actor(uuid, uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.load_storyops_ai_fact_rows(uuid, uuid, text, text, uuid[], integer) RETURNS jsonb;',
      'CREATE FUNCTION public.persist_storyops_photo_analysis(uuid, uuid, uuid, uuid, text, text, text, jsonb, timestamptz, timestamptz) RETURNS jsonb;',
      'CREATE FUNCTION public.load_storyops_billing_validation(uuid, text, text, uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.load_storyops_scheduling_candidate(uuid, uuid, uuid, timestamptz, timestamptz, uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.execute_customer_quote_action(uuid, uuid, uuid, uuid, integer, text, jsonb, text) RETURNS jsonb;',
      'CREATE FUNCTION public.prepare_storyops_invoice_checkout(uuid, uuid, uuid, uuid, integer, text) RETURNS jsonb;',
      'CREATE FUNCTION public.resolve_storyops_payment_allocation(uuid, uuid, uuid, uuid, uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.accept_customer_quote(uuid, uuid, uuid, uuid, integer, text, boolean, text, text, text, text) RETURNS jsonb;',
      'CREATE FUNCTION public.get_storyops_audit_feed(uuid, timestamptz, uuid, integer) RETURNS jsonb;',
      'CREATE FUNCTION public.assert_active_company_for_authenticated_mutation() RETURNS trigger;',
      'CREATE FUNCTION public.record_storyops_lead_intake_operational_disposition() RETURNS trigger;',
      'CREATE FUNCTION public.queue_storyops_transactional_delivery(uuid, uuid, text, uuid, integer, text, text) RETURNS jsonb;',
      'CREATE FUNCTION public.claim_storyops_transactional_delivery(uuid, uuid, integer) RETURNS jsonb;',
      'CREATE FUNCTION public.record_storyops_pilot_release_evidence() RETURNS jsonb;',
      'CREATE FUNCTION public.get_storyops_pilot_release_evidence(uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.submit_storyops_field_change_request() RETURNS jsonb;',
      'CREATE FUNCTION public.publish_storyops_completed_work_evidence() RETURNS jsonb;',
      'CREATE FUNCTION public.create_storyops_recurring_due_work() RETURNS jsonb;',
      'CREATE FUNCTION public.attach_storyops_recurring_due_estimate() RETURNS jsonb;',
      'CREATE FUNCTION public.get_storyops_recurring_due_work(uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.prepare_storyops_material_sds_registration() RETURNS jsonb;',
      'CREATE FUNCTION public.finalize_storyops_material_sds_registration() RETURNS jsonb;',
      'CREATE FUNCTION public.get_storyops_material_sds_registry(uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.load_storyops_sds_upload_for_attestation() RETURNS jsonb;',
      'CREATE FUNCTION public.attest_storyops_sds_upload() RETURNS jsonb;',
      'CREATE FUNCTION public.get_storyops_provider_launch_state(uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.reserve_storyops_trusted_pilot_verification(uuid, uuid, uuid, text, text, text, text) RETURNS jsonb;',
      'CREATE FUNCTION public.complete_storyops_restore_verification(uuid, text) RETURNS jsonb;',
      'CREATE FUNCTION public.record_storyops_trusted_pilot_proof(uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.record_storyops_dispatch_clearance(uuid, uuid, text, text, jsonb) RETURNS jsonb;',
      'CREATE FUNCTION public.consume_storyops_dispatch_clearance(uuid, uuid, integer, uuid, text) RETURNS jsonb;',
      'CREATE FUNCTION public.link_storyops_identity(uuid, uuid, uuid, text, uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.revoke_storyops_identity(uuid, uuid, uuid, text, uuid) RETURNS jsonb;',
      'CREATE FUNCTION public.create_storyops_customer_property(uuid, uuid, jsonb, text) RETURNS jsonb;',
      'CREATE FUNCTION public.confirm_storyops_property_geocode_candidate(uuid, uuid, uuid, integer, uuid, text) RETURNS jsonb;',
      'CREATE FUNCTION public.report_storyops_incident_and_pause(uuid, uuid, integer, jsonb, text) RETURNS jsonb;',
      'CREATE FUNCTION public.authorize_storyops_identity_invite(uuid, uuid, uuid, text, text) RETURNS jsonb;',
      'CREATE TABLE private.storyops_setup_receipts (id uuid);',
      'CREATE TABLE private.storyops_setup_receipt_quarantines (id uuid);',
      'CREATE TRIGGER storyops_setup_receipts_append_only BEFORE UPDATE OR DELETE ON private.storyops_setup_receipts EXECUTE FUNCTION private.reject_storyops_setup_receipt_mutation();',
      'CREATE TRIGGER storyops_setup_receipt_quarantines_append_only BEFORE UPDATE OR DELETE ON private.storyops_setup_receipt_quarantines EXECUTE FUNCTION private.reject_storyops_setup_receipt_mutation();',
      'CREATE FUNCTION public.complete_storyops_setup(uuid, uuid, text, text, text, text, text, text[], boolean) RETURNS jsonb;',
      'CREATE UNLOGGED TABLE private.dispatch_current_origin_ephemera (receipt_id uuid);',
      'CREATE UNLOGGED TABLE private.dispatch_current_origin_verifiers (receipt_id uuid);',
      'CREATE TABLE private.dispatch_origin_purge_worker_health (singleton boolean);',
      'CREATE FUNCTION private.storyops_dispatch_origin_retention_healthy() RETURNS boolean;',
      'CREATE TABLE private.storyops_field_media_canary_crews (verification_run_id uuid);',
      'CREATE TABLE private.storyops_field_media_canary_registry_quarantine (verification_run_id uuid);',
      'CREATE TABLE private.storyops_field_media_canary_crew_capabilities (capability_token uuid);',
      'CREATE TRIGGER jobs_retired_field_media_canary_guard BEFORE UPDATE OR DELETE ON public.jobs EXECUTE FUNCTION private.enforce_storyops_retired_field_media_job();',
      'CREATE TRIGGER visits_retired_field_media_canary_guard BEFORE UPDATE OR DELETE ON public.visits EXECUTE FUNCTION private.enforce_storyops_retired_field_media_visit();',
      'CREATE TRIGGER dispatch_retired_field_media_canary_guard BEFORE INSERT OR UPDATE OR DELETE ON public.dispatch_assignments EXECUTE FUNCTION private.enforce_storyops_retired_field_media_dispatch();',
      'CREATE TRIGGER trusted_pilot_field_media_registry_capture AFTER UPDATE ON public.trusted_pilot_verification_runs EXECUTE FUNCTION private.capture_storyops_field_media_canary_crew();',
      'CREATE TRIGGER storyops_00_canary_quarantine_launch_gate BEFORE INSERT ON public.company_launch_authorization_events EXECUTE FUNCTION private.enforce_storyops_canary_quarantine_launch_gate();',
      'CREATE TRIGGER crews_controlled_rehearsal_inactive BEFORE INSERT OR UPDATE ON public.crews EXECUTE FUNCTION public.enforce_storyops_controlled_rehearsal_crew_inactive();',
      'CREATE TRIGGER trusted_pilot_field_media_completion_isolation BEFORE UPDATE ON public.trusted_pilot_verification_runs EXECUTE FUNCTION public.enforce_storyops_field_media_canary_completion_isolation();',
      'CREATE UNIQUE INDEX identity_invitation_attempts_one_unresolved_email_idx ON public.identity_invitation_attempts(company_id, normalized_email);',
      'CREATE FUNCTION public.load_storyops_identity_invitation_attempt_state(uuid, uuid) RETURNS jsonb;',
      'CREATE FUNCTION private.claim_storyops_identity_invitation_attempt(uuid, uuid, uuid, text) RETURNS jsonb;',
      'ALTER TABLE ONLY public.identity_invitation_attempts FORCE ROW LEVEL SECURITY;',
      ''
    ].join('\\n'),
    'storage-schema-source.sql': [
      'CREATE TABLE "storage"."objects" ("id" uuid);',
      ...${JSON.stringify(fakeStoragePolicyStatements)},
      ''
    ].join('\\n'),
    'data.sql': process.env.FAKE_DATA_SQL || '-- StoryOps data\\n'
  };
  fs.writeFileSync(output, bodies[name], { mode: 0o600, flag: 'wx' });
  process.exit(0);
}
process.stderr.write('unexpected fake Supabase arguments: ' + args.join(' ') + '\\n');
process.exit(2);
`,
    { mode: 0o700 },
  );
  await writeFile(
    psql,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const commandIndex = args.indexOf('--command');
const command = commandIndex >= 0 ? args[commandIndex + 1] : '';
if (command.includes('pg_control_system') && command.includes('json_build_object')) {
  process.stdout.write(JSON.stringify({
    systemIdentifier: process.env.FAKE_SOURCE_SYSTEM_IDENTIFIER || '7668118205518053419',
    serverObservedAt: new Date().toISOString(),
    serviceRolePublicBaseTablePrivilegeCount: Number(
      process.env.FAKE_SOURCE_SERVICE_ROLE_BASE_TABLE_PRIVILEGE_COUNT || '0'
    )
  }) + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected fake backup psql arguments: ' + args.join(' ') + '\\n');
process.exit(2);
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  await chmod(psql, 0o700);
  return executable;
}

function runBackupWithFakeCli({
  target,
  fakeBin,
  migrations = completeMigrationOutput,
  environment = {},
}) {
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
        ...environment,
      },
    },
  );
}

const pilotCompanyId = '11111111-1111-4111-8111-111111111111';
const pilotProofSecret = 'restore-proof-only-secret-32-bytes-minimum';
const sourceSystemIdentifier = '7668118205518053419';
const targetSystemIdentifier = '7668408443751252011';
const signedRestoreProofDomain = 'storyops-signed-isolated-restore-proof-v2\u001f';

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

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function signedRestoreRequest(secret, request) {
  return createHmac('sha256', secret)
    .update(`${signedRestoreProofDomain}${canonicalJson(request)}`)
    .digest('hex');
}

function expectedStorageVerification(records) {
  const objects = records
    .map(({ bucket, name, bytes, sha256 }) => ({ bucket, name, bytes, sha256 }))
    .sort((left, right) => {
      const leftKey = `${left.bucket}\0${left.name}`;
      const rightKey = `${right.bucket}\0${right.name}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return {
    schemaVersion: 'storyops-storage-byte-verification-v1',
    objectCount: objects.length,
    byteCount: objects.reduce((total, object) => total + object.bytes, 0),
    fingerprintSha256: sha256Bytes(
      canonicalJson({
        schemaVersion: 'storyops-storage-byte-verification-v1',
        objects,
      }),
    ),
  };
}

async function fakeRestoreCommands(directory) {
  const psql = resolve(directory, 'psql');
  const pgDump = resolve(directory, 'pg_dump');
  await writeFile(
    psql,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_RESTORE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_RESTORE_LOG,
    JSON.stringify({ tool: 'psql', args: args }) + '\\n'
  );
}
if (process.env.FAKE_RESTORE_FILE_LOG && args.includes('--single-transaction')) {
  const files = args
    .map((argument, index) => args[index - 1] === '--file' ? argument : null)
    .filter(Boolean)
    .map((path) => ({
      path,
      sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(path)).digest('hex'),
      text: fs.readFileSync(path, 'utf8')
    }));
  fs.writeFileSync(process.env.FAKE_RESTORE_FILE_LOG, JSON.stringify(files) + '\\n');
}
const commandIndex = args.indexOf('--command');
const command = commandIndex >= 0 ? args[commandIndex + 1] : '';
if (command.includes('pg_catalog.pg_tables')) {
  if (process.env.FAKE_ARCHIVE_SWAPS_JSON) {
    for (const swap of JSON.parse(process.env.FAKE_ARCHIVE_SWAPS_JSON)) {
      fs.writeFileSync(swap.path, Buffer.from(swap.bodyBase64, 'base64'));
    }
  }
  process.stdout.write((process.env.FAKE_PREFLIGHT_COUNT || '0') + '\\n');
  process.exit(0);
}
if (command.trim() === 'SELECT system_identifier::text FROM pg_control_system();') {
  process.stdout.write(
    (process.env.FAKE_TARGET_SYSTEM_IDENTIFIER || '${targetSystemIdentifier}') + '\\n'
  );
  process.exit(0);
}
if (
  command.includes(
    "SELECT CASE WHEN private.storyops_dispatch_origin_retention_healthy()"
  )
) {
  if (process.env.FAKE_DISPATCH_SCHEDULER_HEALTH === 'error') {
    process.stderr.write('dispatch scheduler health unavailable\\n');
    process.exit(10);
  }
  process.stdout.write(
    (process.env.FAKE_DISPATCH_SCHEDULER_HEALTH || 'verified') + '\\n'
  );
  process.exit(0);
}
if (command.includes('storyops-isolated-target-verification-v1')) {
  if (process.env.FAKE_TARGET_QUERY_FAILURE === 'true') {
    process.stderr.write('target verification failed\\n');
    process.exit(9);
  }
  if (process.env.FAKE_TARGET_VERIFICATION_JSON) {
    process.stdout.write(process.env.FAKE_TARGET_VERIFICATION_JSON + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    schemaVersion: 'storyops-isolated-target-verification-v1',
    serverCompletedAt: new Date().toISOString(),
    systemIdentifier:
      process.env.FAKE_TARGET_SYSTEM_IDENTIFIER || '${targetSystemIdentifier}',
    activeCompanyIds: ['${pilotCompanyId}'],
    missingTables: [],
    missingFunctions: [],
    rlsDisabledTables: [],
    storageObjectsRlsEnabled: true,
    dispatchOriginFunctionAclMismatchCount: 0,
    dispatchOriginPrivateApiPrivilegeCount: 0,
    dispatchOriginTransientRowCount: 0,
    dispatchOriginTransientTablesUnlogged: true,
    dispatchOriginRetentionHealthy: true,
    releaseBoundaryCatalogMismatchCount: 0,
    serviceRolePublicBaseTablePrivilegeCount: 0,
    jobMediaBucket: {
      public: false,
      fileSizeLimit: 26214400,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    },
    jobMediaPolicies: ['job_media_insert', 'job_media_select']
  }) + '\\n');
  process.exit(0);
}
if (args.includes('--single-transaction')) process.exit(0);
process.stderr.write('unexpected fake psql arguments: ' + args.join(' ') + '\\n');
process.exit(2);
`,
    { mode: 0o700 },
  );
  await writeFile(
    pgDump,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_RESTORE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_RESTORE_LOG,
    JSON.stringify({ tool: 'pg_dump', args: args }) + '\\n'
  );
}
if (process.env.FAKE_TARGET_DUMP_FAILURE === 'true') {
  process.stderr.write('target dump failed\\n');
  process.exit(8);
}
const output = args[args.indexOf('--file') + 1];
fs.copyFileSync(process.env.FAKE_TARGET_DUMP_SOURCE, output);
process.exit(0);
`,
    { mode: 0o700 },
  );
  await chmod(psql, 0o700);
  await chmod(pgDump, 0o700);
}

async function addStorageBackupFixture(backup, { reverse = false } = {}) {
  const objectDirectory = resolve(backup, 'storage/objects');
  await mkdir(objectDirectory, { recursive: true });
  const objectInputs = [
    {
      bucket: 'job-media',
      name: 'recovery/canary-before.png',
      bytes: Buffer.from('storyops-recovery-canary-before'),
      contentType: 'image/png',
    },
    {
      bucket: 'job-media',
      name: 'recovery/canary-after.png',
      bytes: Buffer.from('storyops-recovery-canary-after'),
      contentType: 'image/png',
    },
  ];
  const records = [];
  for (const [index, object] of objectInputs.entries()) {
    const file = `storage/objects/object-${index + 1}`;
    await writeFile(resolve(backup, file), object.bytes, { mode: 0o600 });
    records.push({
      bucket: object.bucket,
      name: object.name,
      file,
      bytes: object.bytes.byteLength,
      sha256: sha256Bytes(object.bytes),
      contentType: object.contentType,
      cacheControl: '3600',
    });
  }
  const manifestPath = resolve(backup, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.storage = {
    included: true,
    sourceHost: 'source.example.test',
    exportStartedAt: '2026-07-30T12:00:01.000Z',
    exportCompletedAt: '2026-07-30T12:00:02.000Z',
    crossServiceAtomicWithDatabase: false,
    bucketCount: 1,
    objectCount: records.length,
    objectBytes: records.reduce((total, record) => total + record.bytes, 0),
    buckets: [
      {
        id: 'job-media',
        name: 'job-media',
        public: false,
        fileSizeLimit: 26_214_400,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      },
    ],
    objects: reverse ? [...records].reverse() : records,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return records;
}

async function replaceBackupDatabaseFile(backup, name, body) {
  await writeFile(resolve(backup, name), body, { mode: 0o600 });
  const manifestPath = resolve(backup, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const record = manifest.database.files.find((file) => file.path === name);
  assert.ok(record);
  record.bytes = Buffer.byteLength(body);
  record.sha256 = sha256Bytes(body);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function fakeStorageFetchModule(directory) {
  const modulePath = resolve(directory, 'fake-storage-fetch.mjs');
  await writeFile(
    modulePath,
    `import { appendFileSync } from 'node:fs';

const buckets = new Map();
const objects = new Map(
  Object.entries(JSON.parse(process.env.FAKE_STORAGE_INITIAL_OBJECTS || '{}')).map(
    ([key, value]) => [key, Buffer.from(value, 'base64')]
  )
);

function response(value, status = 200, headers = {}) {
  const body =
    value instanceof Uint8Array || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...headers
    }
  });
}

async function requestBytes(body) {
  if (body instanceof FormData) {
    const file = body.get('file');
    return Buffer.from(await file.arrayBuffer());
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  return Buffer.from(body || '');
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || (typeof input === 'string' ? 'GET' : input.method)).toUpperCase();
  const path = decodeURIComponent(url.pathname);
  if (process.env.FAKE_STORAGE_LOG) {
    appendFileSync(
      process.env.FAKE_STORAGE_LOG,
      JSON.stringify({ method, path }) + '\\n'
    );
  }
  if (path === '/storage/v1/bucket' && method === 'GET') {
    return response([...buckets.values()]);
  }
  if (path === '/storage/v1/bucket' && method === 'POST') {
    const body = JSON.parse(String(init.body || '{}'));
    const id = body.id || body.name;
    buckets.set(id, {
      id,
      name: id,
      public: Boolean(body.public),
      file_size_limit: body.file_size_limit ?? null,
      allowed_mime_types: body.allowed_mime_types ?? null
    });
    return response({ name: id });
  }
  const authenticatedPrefix = '/storage/v1/object/authenticated/';
  if (path.startsWith(authenticatedPrefix) && method === 'GET') {
    const key = path.slice(authenticatedPrefix.length);
    const value = objects.get(key);
    if (!value) return response({ message: 'not found' }, 404);
    const bytes =
      process.env.FAKE_STORAGE_TAMPER_READBACK === 'true'
        ? Buffer.concat([value, Buffer.from('tampered')])
        : value;
    return response(bytes, 200, { 'content-type': 'application/octet-stream' });
  }
  const objectPrefix = '/storage/v1/object/';
  if (path.startsWith(objectPrefix) && method === 'GET') {
    const key = path.slice(objectPrefix.length);
    const value = objects.get(key);
    if (!value) return response({ message: 'not found' }, 404);
    const bytes =
      process.env.FAKE_STORAGE_TAMPER_READBACK === 'true'
        ? Buffer.concat([value, Buffer.from('tampered')])
        : value;
    return response(bytes, 200, { 'content-type': 'application/octet-stream' });
  }
  if (path.startsWith(objectPrefix) && (method === 'POST' || method === 'PUT')) {
    const key = path.slice(objectPrefix.length);
    if (process.env.FAKE_STORAGE_UPLOAD_CONFLICT === 'true' && objects.has(key)) {
      return response({ message: 'The resource already exists' }, 409);
    }
    objects.set(key, await requestBytes(init.body));
    return response({ Key: key });
  }
  return response(
    { message: 'unexpected fake Storage request ' + method + ' ' + path, method, path },
    500
  );
};
`,
    { mode: 0o600 },
  );
  return modulePath;
}

async function pilotRestoreFixture({ reverseStorageObjects = false } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'storyops-pilot-restore-'));
  const fakeBin = resolve(directory, 'bin');
  const backup = resolve(directory, 'backup');
  const evidenceOutput = resolve(directory, 'isolated-restore-proof.json');
  const commandLog = resolve(directory, 'restore-commands.jsonl');
  const restoreFileLog = resolve(directory, 'restore-files.json');
  const storageLog = resolve(directory, 'storage-commands.jsonl');
  await mkdir(fakeBin);
  await fakeSupabaseCommand(fakeBin);
  const backupResult = runBackupWithFakeCli({ target: backup, fakeBin });
  assert.equal(backupResult.status, 0, backupResult.stderr);
  const storageObjects = await addStorageBackupFixture(backup, {
    reverse: reverseStorageObjects,
  });
  await fakeRestoreCommands(fakeBin);
  const storageFetchModule = await fakeStorageFetchModule(directory);
  return {
    directory,
    fakeBin,
    backup,
    evidenceOutput,
    commandLog,
    restoreFileLog,
    storageLog,
    storageFetchModule,
    storageObjects,
  };
}

function pilotRestoreArguments(fixture) {
  return [
    'scripts/restore.mjs',
    '--backup',
    fixture.backup,
    '--execute',
    '--db-url',
    'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
    '--confirm-target',
    '127.0.0.1:55322/postgres',
    '--restore-storage',
    '--storage-url',
    'http://127.0.0.1:55321',
    '--storage-key',
    'fake-storage-service-role-key',
    '--pilot-evidence-out',
    fixture.evidenceOutput,
    '--pilot-isolation-id',
    'isolated-local-test',
    '--pilot-evidence-reference',
    'restore-drill-test',
  ];
}

function runPilotRestore(
  fixture,
  {
    args = pilotRestoreArguments(fixture),
    env = {},
    trustedManifestSha256 = sha256Bytes(readFileSync(resolve(fixture.backup, 'manifest.json'))),
  } = {},
) {
  const restoreEnvironment = {
    ...process.env,
    PATH: `${fixture.fakeBin}:${process.env.PATH}`,
    PILOT_RESTORE_PROOF_HMAC_SECRET: pilotProofSecret,
    FAKE_TARGET_DUMP_SOURCE: resolve(fixture.backup, 'schema.sql'),
    FAKE_RESTORE_LOG: fixture.commandLog,
    FAKE_RESTORE_FILE_LOG: fixture.restoreFileLog,
    FAKE_STORAGE_LOG: fixture.storageLog,
    NODE_OPTIONS: `--import=${fixture.storageFetchModule}`,
    ...env,
  };
  delete restoreEnvironment.STORYOPS_BACKUP_MANIFEST_SHA256;
  if (typeof trustedManifestSha256 === 'string') {
    restoreEnvironment.STORYOPS_BACKUP_MANIFEST_SHA256 = trustedManifestSha256;
  }
  return spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: restoreEnvironment,
  });
}

async function assertMissing(filePath) {
  await assert.rejects(stat(filePath), { code: 'ENOENT' });
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
    /missing sentinel table\(s\): public\.audit_events, public\.post_service_followups, public\.media_upload_attestations, public\.scheduling_evidence_receipts, public\.customer_portal_requests, public\.scheduling_reconciliation_cases, public\.scheduling_calendar_booking_attempts, public\.job_actual_cost_snapshots, public\.automation_runs, public\.owner_briefings, public\.customer_quote_change_requests, public\.payment_allocation_conflicts, public\.payment_checkout_retirements, public\.customer_quote_acceptances, public\.lead_intake_operational_dispositions, public\.transactional_delivery_attempts, public\.field_change_requests, public\.recurring_due_occurrences, public\.sds_registration_requests, public\.sds_upload_attestations/u,
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

test('executable backup refuses source service-role base-table privilege drift', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'storyops-backup-hardening-'));
  const fakeBin = resolve(directory, 'bin');
  const target = resolve(directory, 'backup');
  try {
    await mkdir(fakeBin);
    await fakeSupabaseCommand(fakeBin);
    const result = runBackupWithFakeCli({
      target,
      fakeBin,
      environment: {
        FAKE_SOURCE_SERVICE_ROLE_BASE_TABLE_PRIVILEGE_COUNT: '1',
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /service-role base-table isolation evidence/u);
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
    const manifestBytes = await readFile(resolve(target, 'manifest.json'));
    const manifestSha256 = sha256Bytes(manifestBytes);
    assert.match(
      result.stdout,
      new RegExp(
        `Manifest SHA-256 \\(retain in an independent trusted location\\): ${manifestSha256}`,
        'u',
      ),
    );
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const evidence = manifest.database.recoveryEvidence;
    const schemaFile = manifest.database.files.find((file) => file.path === 'schema.sql');
    const storagePolicyFile = manifest.database.files.find(
      (file) => file.path === 'storage-policies.sql',
    );
    assert.equal(manifest.format, 'storyops-supabase-logical-v2');
    assert.deepEqual(manifest.database.dataExclusions, REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS);
    assert.deepEqual(manifest.database.dataSchemas, REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS);
    assert.equal(manifest.database.source.systemIdentifier, sourceSystemIdentifier);
    assert.ok(Number.isFinite(Date.parse(manifest.database.source.serverObservedAt)));
    assert.ok(storagePolicyFile);
    assert.deepEqual(evidence.storagePolicyNames, REQUIRED_STORYOPS_STORAGE_POLICIES);
    assert.deepEqual(
      validateStoryOpsStoragePolicyDump(
        await readFile(resolve(target, 'storage-policies.sql'), 'utf8'),
      ),
      REQUIRED_STORYOPS_STORAGE_POLICIES,
    );
    assert.equal(evidence.requiredMigration, REQUIRED_STORYOPS_MIGRATION);
    assert.equal(evidence.requiredMigrationCount, REQUIRED_STORYOPS_MIGRATIONS.length);
    assert.equal(evidence.serviceRolePublicBaseTablePrivilegeCount, 0);
    assert.match(evidence.requiredMigrationSetFingerprint.value, /^[a-f0-9]{64}$/u);
    assert.equal(evidence.schemaFingerprint.value, schemaFile.sha256);
    assert.equal(evidence.estimatedTableCounts.transactionallyConsistentWithDump, false);
    assert.equal(evidence.estimatedTableCounts.tables['public.audit_events'], 41);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('backup data dump excludes Storage, pg_cron, and transient dispatch-origin rows without excluding Auth data', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'storyops-backup-exclusions-'));
  const fakeBin = resolve(directory, 'bin');
  const target = resolve(directory, 'backup');
  const commandLog = resolve(directory, 'supabase.jsonl');
  try {
    await mkdir(fakeBin);
    await fakeSupabaseCommand(fakeBin);
    const result = runBackupWithFakeCli({
      target,
      fakeBin,
      environment: { FAKE_SUPABASE_LOG: commandLog },
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = (await readFile(commandLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const dataDump = calls.find((args) => args.includes('dump') && args.includes('--data-only'));
    assert.ok(dataDump);
    const exclusions = dataDump
      .map((argument, index) => (dataDump[index - 1] === '--exclude' ? argument : null))
      .filter(Boolean);
    assert.deepEqual(exclusions, REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS);
    const schemaIndex = dataDump.indexOf('--schema');
    assert.equal(dataDump[schemaIndex + 1], REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS.join(','));
    assert.ok(REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS.includes('auth'));
    assert.ok(!REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS.includes('storage'));
    assert.ok(!REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS.includes('cron'));
    assert.ok(
      calls.some(
        (args) => args.includes('dump') && args.includes('--schema') && args.includes('storage'),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('backup and restore reject forged Storage DML and malformed policy artifacts', async () => {
  assert.throws(
    () =>
      validateStorageExcludedDataDump(
        'COPY "storage"."objects" ("bucket_id", "name") FROM stdin;\n',
      ),
    /Storage-managed rows/u,
  );
  assert.equal(
    validateStoryOpsExcludedDataDump(
      'COPY "auth"."users" ("id") FROM stdin;\nCOPY "public"."jobs" ("id") FROM stdin;\n',
    ),
    true,
  );
  for (const unsafeDataDump of [
    'COPY "vault"."secrets" ("id") FROM stdin;\n',
    'INSERT INTO "supabase_functions"."hooks" ("id") VALUES (1);\n',
    'UPDATE jobs SET status = NULL;\n',
    'DELETE FROM ONLY jobs;\n',
  ]) {
    assert.throws(
      () => validateStoryOpsExcludedDataDump(unsafeDataDump),
      /exact auth\/public\/private schema allowlist/u,
    );
  }
  assert.throws(
    () =>
      validateStoryOpsExcludedDataDump(
        'COPY "cron"."job_run_details" ("runid", "command") FROM stdin;\n',
      ),
    /pg_cron schedules or run history/u,
  );
  for (const table of [
    'dispatch_current_origin_ephemera',
    'dispatch_current_origin_verifiers',
    'dispatch_origin_purge_worker_health',
  ]) {
    assert.throws(
      () =>
        validateStoryOpsExcludedDataDump(`COPY "private"."${table}" ("created_at") FROM stdin;\n`),
      /transient dispatch-origin rows/u,
    );
  }
  const validPolicySource = fakeStoragePolicyStatements.join('\n');
  const extracted = extractStoryOpsStoragePolicyDump(validPolicySource);
  assert.deepEqual(extracted.policyNames, REQUIRED_STORYOPS_STORAGE_POLICIES);
  assert.throws(
    () => validateStoryOpsStoragePolicyDump(`${extracted.sql}DROP TABLE "storage"."objects";\n`),
    /SQL outside the allowlisted/u,
  );
  assert.throws(
    () =>
      extractStoryOpsStoragePolicyDump(
        validPolicySource.replace(
          'CREATE POLICY "job_media_insert"',
          'CREATE POLICY "job_media_insert"\n',
        ),
      ),
    /multiline, malformed/u,
  );
  assert.throws(
    () =>
      extractStoryOpsStoragePolicyDump(
        `${validPolicySource}\nCREATE POLICY "job_media_update" ON "storage"."objects" FOR UPDATE USING (false);`,
      ),
    /unexpected: job_media_update/u,
  );
  assert.throws(
    () =>
      extractStoryOpsStoragePolicyDump(
        validPolicySource.replace(
          `("bucket_id" = 'job-media') AND "public"."can_upload_job_media_object"("name")`,
          'true',
        ),
      ),
    /job_media_insert.*release guard contract/u,
  );

  const directory = await mkdtemp(resolve(tmpdir(), 'storyops-backup-tamper-'));
  const fakeBin = resolve(directory, 'bin');
  const target = resolve(directory, 'backup');
  try {
    await mkdir(fakeBin);
    await fakeSupabaseCommand(fakeBin);
    const result = runBackupWithFakeCli({
      target,
      fakeBin,
      environment: {
        FAKE_DATA_SQL: 'COPY "storage"."objects" ("bucket_id", "name") FROM stdin;\n',
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Storage-managed rows/u);
    await assertMissing(target);

    const transientResult = runBackupWithFakeCli({
      target,
      fakeBin,
      environment: {
        FAKE_DATA_SQL:
          'COPY "private"."dispatch_current_origin_ephemera" ("route_check_id") FROM stdin;\n',
      },
    });
    assert.notEqual(transientResult.status, 0);
    assert.match(transientResult.stderr, /transient dispatch-origin rows/u);
    await assertMissing(target);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const forgedDirectory = await mkdtemp(resolve(tmpdir(), 'storyops-restore-tamper-'));
  const forgedBin = resolve(forgedDirectory, 'bin');
  const forgedBackup = resolve(forgedDirectory, 'backup');
  try {
    await mkdir(forgedBin);
    await fakeSupabaseCommand(forgedBin);
    const goodBackup = runBackupWithFakeCli({ target: forgedBackup, fakeBin: forgedBin });
    assert.equal(goodBackup.status, 0, goodBackup.stderr);

    const forgedData = 'UPDATE "storage"."objects" SET "name" = \'forged\';\n';
    await replaceBackupDatabaseFile(forgedBackup, 'data.sql', forgedData);
    const dataRestore = spawnSync(
      process.execPath,
      [
        'scripts/restore.mjs',
        '--backup',
        forgedBackup,
        '--dry-run',
        '--db-url',
        'postgresql://operator:redacted@target.example.test/storyops',
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${forgedBin}:${process.env.PATH}` },
      },
    );
    assert.notEqual(dataRestore.status, 0);
    assert.match(dataRestore.stderr, /Storage-managed rows/u);

    await replaceBackupDatabaseFile(
      forgedBackup,
      'data.sql',
      'UPDATE private.dispatch_current_origin_verifiers SET last_error = null;\n',
    );
    const transientRestore = spawnSync(
      process.execPath,
      [
        'scripts/restore.mjs',
        '--backup',
        forgedBackup,
        '--dry-run',
        '--db-url',
        'postgresql://operator:redacted@target.example.test/storyops',
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${forgedBin}:${process.env.PATH}` },
      },
    );
    assert.notEqual(transientRestore.status, 0);
    assert.match(transientRestore.stderr, /transient dispatch-origin rows/u);

    await replaceBackupDatabaseFile(forgedBackup, 'data.sql', '-- StoryOps data\n');
    await replaceBackupDatabaseFile(
      forgedBackup,
      'storage-policies.sql',
      `${extractStoryOpsStoragePolicyDump(validPolicySource).sql}DROP TABLE "storage"."objects";\n`,
    );
    const policyRestore = spawnSync(
      process.execPath,
      [
        'scripts/restore.mjs',
        '--backup',
        forgedBackup,
        '--dry-run',
        '--db-url',
        'postgresql://operator:redacted@target.example.test/storyops',
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${forgedBin}:${process.env.PATH}` },
      },
    );
    assert.notEqual(policyRestore.status, 0);
    assert.match(policyRestore.stderr, /SQL outside the allowlisted/u);

    const manifestPath = resolve(forgedBackup, 'manifest.json');
    const v1Manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    v1Manifest.format = 'storyops-supabase-logical-v1';
    await writeFile(manifestPath, `${JSON.stringify(v1Manifest, null, 2)}\n`, { mode: 0o600 });
    const v1Restore = spawnSync(
      process.execPath,
      ['scripts/restore.mjs', '--backup', forgedBackup, '--dry-run'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${forgedBin}:${process.env.PATH}` },
      },
    );
    assert.notEqual(v1Restore.status, 0);
    assert.match(v1Restore.stderr, /expected "storyops-supabase-logical-v2"/u);
  } finally {
    await rm(forgedDirectory, { recursive: true, force: true });
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

test('schema dump must contain the release authorization, worker, finance, and core sentinels', () => {
  const completeSchema = `
    CREATE TABLE "public"."companies" (id uuid);
    CREATE TABLE public.audit_events (id uuid);
    CREATE TABLE IF NOT EXISTS "public".post_service_followups (id uuid);
    CREATE TABLE public.media_upload_attestations (id uuid);
    CREATE TABLE public.scheduling_evidence_receipts (id uuid);
    CREATE TABLE public.customer_portal_requests (id uuid);
    CREATE TABLE public.scheduling_reconciliation_cases (id uuid);
    CREATE TABLE public.scheduling_calendar_booking_attempts (id uuid);
    CREATE TABLE public.job_actual_cost_snapshots (id uuid);
    CREATE TABLE public.automation_runs (id uuid);
    CREATE TABLE public.owner_briefings (id uuid);
    CREATE TABLE public.customer_quote_change_requests (id uuid);
    CREATE TABLE public.payment_allocation_conflicts (id uuid);
    CREATE TABLE public.payment_checkout_retirements (id uuid);
    CREATE TABLE public.customer_quote_acceptances (id uuid);
    CREATE TABLE public.lead_intake_operational_dispositions (id uuid);
    CREATE TABLE public.transactional_delivery_attempts (id uuid);
    CREATE TABLE public.field_change_requests (id uuid);
    CREATE TABLE public.recurring_due_occurrences (id uuid);
    CREATE TABLE public.sds_registration_requests (id uuid);
    CREATE TABLE public.sds_upload_attestations (id uuid);
    CREATE TABLE public.integration_environment_probe_results (id uuid);
    CREATE TABLE public.company_launch_authorization_events (id uuid);
    CREATE TABLE public.trusted_pilot_verification_runs (id uuid);
    CREATE TABLE public.dispatch_clearance_receipts (id uuid);
    CREATE TABLE public.dispatch_clearance_consumptions (id uuid);
    CREATE TABLE public.identity_provisioning_targets (id uuid);
    CREATE TABLE public.identity_provisioning_commands (id uuid);
    CREATE TABLE public.identity_invitation_attempts (id uuid);
    CREATE TABLE public.property_geocode_candidates (id uuid);
    CREATE TABLE private.storyops_private_worker_heartbeats (company_id uuid);
    CREATE TABLE private.storyops_private_worker_readiness_snapshots (company_id uuid);
    CREATE TABLE private.storyops_incident_stop_capabilities (capability_token uuid);
    CREATE TABLE private.storyops_incident_close_capabilities (capability_token uuid);
    ALTER TABLE public.dispatch_clearance_receipts
      ADD COLUMN current_origin jsonb
      CHECK (current_origin ->> 'schemaVersion' = 'storyops-dispatch-current-origin-v1');
    CREATE TRIGGER media_assets_incident_evidence_guard
      BEFORE INSERT OR UPDATE ON public.media_assets
      EXECUTE FUNCTION public.enforce_storyops_incident_media_association();
    CREATE TRIGGER aa_incidents_safe_update_guard
      BEFORE UPDATE ON public.incidents
      EXECUTE FUNCTION public.enforce_storyops_incident_update();
    CREATE TRIGGER media_assets_open_incident_stop_work
      BEFORE INSERT OR UPDATE ON public.media_assets
      EXECUTE FUNCTION public.enforce_storyops_incident_stop_work();
    CREATE TRIGGER dispatch_clearance_consumption_current_origin_guard
      BEFORE INSERT ON public.dispatch_clearance_consumptions
      EXECUTE FUNCTION public.enforce_storyops_dispatch_current_origin_consumption();
    COMMENT ON FUNCTION public.is_customer_user(uuid, uuid) IS
      'Portal authorization requires both the exact portal mapping and a current active customer membership.';
    CREATE UNIQUE INDEX referrals_one_invite_per_source_invoice_idx
      ON public.referrals(company_id, source_invoice_id);
    CREATE FUNCTION public.get_storyops_setup_state(uuid) RETURNS jsonb;
    CREATE FUNCTION public.begin_storyops_post_service_submission(uuid, uuid, text)
      RETURNS jsonb;
    CREATE FUNCTION public.finalize_storyops_media_upload(uuid, uuid, uuid, jsonb, text)
      RETURNS jsonb;
    CREATE FUNCTION public.finalize_storyops_media_upload_from_edge(
      uuid, uuid, uuid, jsonb, text
    ) RETURNS jsonb AS $$
    BEGIN
      result := public.finalize_storyops_media_upload(null, null, null, null, null);
      RETURN result;
    END;
    $$ LANGUAGE plpgsql;
    CREATE FUNCTION public.reserve_storyops_field_media_verification(
      uuid, uuid, uuid, uuid, text
    ) RETURNS jsonb;
    CREATE FUNCTION public.claim_storyops_field_media_verification(
      uuid, uuid, uuid, uuid, text
    ) RETURNS jsonb;
    CREATE FUNCTION public.complete_storyops_field_media_verification(uuid, text)
      RETURNS jsonb;
    CREATE FUNCTION private.is_storyops_field_media_canary_object(text)
      RETURNS boolean;
    CREATE FUNCTION public.can_upload_job_media_object(target_name text)
      RETURNS boolean AS $$
    BEGIN
      RETURN private.is_storyops_field_media_canary_object(target_name);
    END;
    $$ LANGUAGE plpgsql;
    CREATE FUNCTION public.claim_storyops_scheduling_reconciliation(uuid, uuid, integer)
      RETURNS jsonb;
    CREATE FUNCTION public.get_storyops_profitability_kpis(uuid) RETURNS jsonb;
    ALTER TABLE public.service_catalog
      ADD COLUMN scope_evidence_policy text;
    CREATE FUNCTION public.validate_travel_zone_configuration(jsonb, text)
      RETURNS jsonb;
    CREATE FUNCTION public.execute_ai_approved_lead_action(
      uuid, uuid, uuid, text, jsonb, text, uuid
    ) RETURNS jsonb;
    CREATE FUNCTION public.load_service_scope_evidence_policies(uuid, uuid, text[])
      RETURNS jsonb;
    SELECT service_value ->> 'pricingUnit' = 'hour'
      AND measurement.kind = 'duration_hours';
    CREATE FUNCTION public.persist_priced_estimate(uuid) RETURNS jsonb AS $$
    DECLARE
      expected_service_measurement_ids jsonb;
    BEGIN
      RAISE EXCEPTION 'ESTIMATE_SUPPORTING_MEASUREMENT_EVIDENCE_MISMATCH';
    END;
    $$ LANGUAGE plpgsql;
    CREATE FUNCTION public.enforce_active_company_approved_action_start()
      RETURNS trigger;
    CREATE FUNCTION public.load_estimate_scope_evidence_bundle(
      uuid, uuid, uuid, uuid, uuid[]
    ) RETURNS jsonb;
    CREATE TRIGGER estimates_scope_evidence_bundle
      BEFORE INSERT ON public.estimates;
    CREATE FUNCTION public.begin_storyops_ai_office_run(
      uuid, uuid, uuid, text, text, jsonb, boolean, timestamptz
    ) RETURNS jsonb;
    CREATE FUNCTION public.complete_storyops_ai_office_run(
      uuid, uuid, uuid, text, text, jsonb
    ) RETURNS jsonb;
    CREATE FUNCTION public.fail_storyops_ai_office_run(
      uuid, uuid, uuid, text, text, text
    ) RETURNS jsonb;
    CREATE FUNCTION public.get_storyops_ai_office_recent(uuid, integer)
      RETURNS jsonb;
    CREATE FUNCTION public.load_storyops_edge_actor(uuid, uuid)
      RETURNS jsonb;
    CREATE FUNCTION public.load_storyops_ai_fact_rows(
      uuid, uuid, text, text, uuid[], integer
    ) RETURNS jsonb;
    CREATE FUNCTION public.persist_storyops_photo_analysis(
      uuid, uuid, uuid, uuid, text, text, text, jsonb, timestamptz, timestamptz
    ) RETURNS jsonb;
    CREATE FUNCTION public.load_storyops_billing_validation(
      uuid, text, text, uuid
    ) RETURNS jsonb;
    CREATE FUNCTION public.load_storyops_scheduling_candidate(
      uuid, uuid, uuid, timestamptz, timestamptz, uuid
    ) RETURNS jsonb;
    CREATE FUNCTION public.execute_customer_quote_action(
      uuid, uuid, uuid, uuid, integer, text, jsonb, text
    ) RETURNS jsonb;
    CREATE FUNCTION public.prepare_storyops_invoice_checkout(
      uuid, uuid, uuid, uuid, integer, text
    ) RETURNS jsonb;
    CREATE FUNCTION public.resolve_storyops_payment_allocation(
      uuid, uuid, uuid, uuid, uuid
    ) RETURNS jsonb;
    CREATE FUNCTION public.accept_customer_quote(
      uuid, uuid, uuid, uuid, integer, text, boolean, text, text, text, text
    ) RETURNS jsonb;
    CREATE FUNCTION public.get_storyops_audit_feed(
      uuid, timestamptz, uuid, integer
    ) RETURNS jsonb;
    CREATE FUNCTION public.assert_active_company_for_authenticated_mutation()
      RETURNS trigger;
    CREATE FUNCTION public.record_storyops_lead_intake_operational_disposition()
      RETURNS trigger;
    CREATE FUNCTION public.queue_storyops_transactional_delivery(
      uuid, uuid, text, uuid, integer, text, text
    ) RETURNS jsonb;
    CREATE FUNCTION public.claim_storyops_transactional_delivery(uuid, uuid, integer)
      RETURNS jsonb;
    CREATE FUNCTION public.record_storyops_pilot_release_evidence()
      RETURNS jsonb;
    CREATE FUNCTION public.get_storyops_pilot_release_evidence(uuid)
      RETURNS jsonb;
    CREATE FUNCTION public.submit_storyops_field_change_request()
      RETURNS jsonb;
    CREATE FUNCTION public.publish_storyops_completed_work_evidence()
      RETURNS jsonb;
    CREATE FUNCTION public.create_storyops_recurring_due_work()
      RETURNS jsonb;
    CREATE FUNCTION public.attach_storyops_recurring_due_estimate()
      RETURNS jsonb;
    CREATE FUNCTION public.get_storyops_recurring_due_work(uuid)
      RETURNS jsonb;
    CREATE FUNCTION public.prepare_storyops_material_sds_registration()
      RETURNS jsonb;
    CREATE FUNCTION public.finalize_storyops_material_sds_registration()
      RETURNS jsonb;
    CREATE FUNCTION public.get_storyops_material_sds_registry(uuid)
      RETURNS jsonb;
    CREATE FUNCTION public.load_storyops_sds_upload_for_attestation()
      RETURNS jsonb;
    CREATE FUNCTION public.attest_storyops_sds_upload()
      RETURNS jsonb;
    CREATE FUNCTION public.get_storyops_provider_launch_state(uuid)
      RETURNS jsonb;
    CREATE FUNCTION public.reserve_storyops_trusted_pilot_verification(
      uuid, uuid, uuid, text, text, text
    ) RETURNS jsonb;
    CREATE FUNCTION public.complete_storyops_restore_verification(uuid, text)
      RETURNS jsonb;
    CREATE FUNCTION public.record_storyops_trusted_pilot_proof(uuid)
      RETURNS jsonb;
    CREATE FUNCTION public.record_storyops_dispatch_clearance(
      uuid, uuid, text, text, jsonb
    ) RETURNS jsonb;
    CREATE FUNCTION public.consume_storyops_dispatch_clearance(
      uuid, uuid, integer, uuid, text
    ) RETURNS jsonb;
    CREATE FUNCTION public.link_storyops_identity(
      uuid, uuid, uuid, text, uuid
    ) RETURNS jsonb;
    CREATE FUNCTION public.revoke_storyops_identity(
      uuid, uuid, uuid, text, uuid
    ) RETURNS jsonb;
    CREATE FUNCTION public.create_storyops_customer_property(
      uuid, uuid, jsonb, text
    ) RETURNS jsonb;
    CREATE FUNCTION public.confirm_storyops_property_geocode_candidate(
      uuid, uuid, uuid, integer, uuid, text
    ) RETURNS jsonb;
    CREATE FUNCTION public.report_storyops_incident_and_pause(
      uuid, uuid, integer, jsonb, text
    ) RETURNS jsonb;
    CREATE FUNCTION public.authorize_storyops_identity_invite(
      uuid, uuid, uuid, text, text
    ) RETURNS jsonb;
    CREATE TABLE private.storyops_setup_receipts (id uuid);
    CREATE TABLE private.storyops_setup_receipt_quarantines (id uuid);
    CREATE TRIGGER storyops_setup_receipts_append_only
      BEFORE UPDATE OR DELETE ON private.storyops_setup_receipts;
    CREATE TRIGGER storyops_setup_receipt_quarantines_append_only
      BEFORE UPDATE OR DELETE ON private.storyops_setup_receipt_quarantines;
    CREATE FUNCTION public.complete_storyops_setup(
      uuid, uuid, text, text, text, text, text, text[], boolean
    ) RETURNS jsonb;
    CREATE UNLOGGED TABLE private.dispatch_current_origin_ephemera (receipt_id uuid);
    CREATE UNLOGGED TABLE private.dispatch_current_origin_verifiers (receipt_id uuid);
    CREATE TABLE private.dispatch_origin_purge_worker_health (singleton boolean);
    CREATE FUNCTION private.storyops_dispatch_origin_retention_healthy()
      RETURNS boolean;
    CREATE TABLE private.storyops_field_media_canary_crews (verification_run_id uuid);
    CREATE TABLE private.storyops_field_media_canary_registry_quarantine (
      verification_run_id uuid
    );
    CREATE TABLE private.storyops_field_media_canary_crew_capabilities (
      capability_token uuid
    );
    CREATE TRIGGER jobs_retired_field_media_canary_guard
      BEFORE UPDATE OR DELETE ON public.jobs;
    CREATE TRIGGER visits_retired_field_media_canary_guard
      BEFORE UPDATE OR DELETE ON public.visits;
    CREATE TRIGGER dispatch_retired_field_media_canary_guard
      BEFORE INSERT OR UPDATE OR DELETE ON public.dispatch_assignments;
    CREATE TRIGGER trusted_pilot_field_media_registry_capture
      AFTER UPDATE ON public.trusted_pilot_verification_runs;
    CREATE TRIGGER storyops_00_canary_quarantine_launch_gate
      BEFORE INSERT ON public.company_launch_authorization_events;
    CREATE TRIGGER crews_controlled_rehearsal_inactive
      BEFORE INSERT OR UPDATE ON public.crews;
    CREATE TRIGGER trusted_pilot_field_media_completion_isolation
      BEFORE UPDATE ON public.trusted_pilot_verification_runs;
    CREATE UNIQUE INDEX identity_invitation_attempts_one_unresolved_email_idx
      ON public.identity_invitation_attempts(company_id, normalized_email);
    CREATE FUNCTION public.load_storyops_identity_invitation_attempt_state(
      uuid, uuid
    ) RETURNS jsonb;
    CREATE FUNCTION private.claim_storyops_identity_invitation_attempt(
      uuid, uuid, uuid, text
    ) RETURNS jsonb;
    ALTER TABLE ONLY public.identity_invitation_attempts
      FORCE ROW LEVEL SECURITY;
  `;
  assert.deepEqual(validateStoryOpsSchemaDump(completeSchema), [
    'public.companies',
    'public.audit_events',
    'public.post_service_followups',
    'public.media_upload_attestations',
    'public.scheduling_evidence_receipts',
    'public.customer_portal_requests',
    'role-offboarding active-membership guard',
    'public.scheduling_reconciliation_cases',
    'public.scheduling_calendar_booking_attempts',
    'public.job_actual_cost_snapshots',
    'public.automation_runs',
    'public.owner_briefings',
    'public.customer_quote_change_requests',
    'public.payment_allocation_conflicts',
    'public.payment_checkout_retirements',
    'public.customer_quote_acceptances',
    'public.lead_intake_operational_dispositions',
    'public.transactional_delivery_attempts',
    'public.field_change_requests',
    'public.recurring_due_occurrences',
    'public.sds_registration_requests',
    'public.sds_upload_attestations',
    'public.integration_environment_probe_results',
    'public.company_launch_authorization_events',
    'public.trusted_pilot_verification_runs',
    'public.dispatch_clearance_receipts',
    'public.dispatch_clearance_consumptions',
    'public.identity_provisioning_targets',
    'public.identity_provisioning_commands',
    'public.identity_invitation_attempts',
    'public.property_geocode_candidates',
    'private.storyops_private_worker_heartbeats',
    'private.storyops_private_worker_readiness_snapshots',
    'private.storyops_incident_stop_capabilities',
    'private.storyops_incident_close_capabilities',
    'dispatch clearance current-origin v2 contract',
    'media-assets incident evidence guard',
    'incidents safe-update command guard',
    'open-incident stop-work media guard',
    'dispatch current-origin consumption guard',
    'public.referrals_one_invite_per_source_invoice_idx',
    'public.get_storyops_setup_state',
    'public.begin_storyops_post_service_submission',
    'public.finalize_storyops_media_upload',
    'public.finalize_storyops_media_upload_from_edge',
    'public.reserve_storyops_field_media_verification',
    'public.claim_storyops_field_media_verification',
    'public.complete_storyops_field_media_verification',
    'private.is_storyops_field_media_canary_object',
    'field-media Edge adapter canonical delegation',
    'field-media canary exact Storage predicate link',
    'public.claim_storyops_scheduling_reconciliation',
    'public.get_storyops_profitability_kpis',
    'industry-pack scope evidence policy',
    'authoritative reviewed travel-zone mappings',
    'public.execute_ai_approved_lead_action',
    'public.load_service_scope_evidence_policies',
    'flat/hour pricing evidence support',
    'persist_priced_estimate supporting-measurement provenance',
    'approved actions require an active company',
    'public.load_estimate_scope_evidence_bundle',
    'estimates_scope_evidence_bundle trigger',
    'public.begin_storyops_ai_office_run',
    'public.complete_storyops_ai_office_run',
    'public.fail_storyops_ai_office_run',
    'public.get_storyops_ai_office_recent',
    'public.load_storyops_edge_actor',
    'public.load_storyops_ai_fact_rows',
    'public.persist_storyops_photo_analysis',
    'public.load_storyops_billing_validation',
    'public.load_storyops_scheduling_candidate',
    'public.execute_customer_quote_action',
    'public.prepare_storyops_invoice_checkout',
    'public.resolve_storyops_payment_allocation',
    'public.accept_customer_quote',
    'public.get_storyops_audit_feed',
    'authenticated active-company mutation gate',
    'trusted lead-intake operational disposition',
    'public.queue_storyops_transactional_delivery',
    'public.claim_storyops_transactional_delivery',
    'public.record_storyops_pilot_release_evidence',
    'public.get_storyops_pilot_release_evidence',
    'public.submit_storyops_field_change_request',
    'public.publish_storyops_completed_work_evidence',
    'public.create_storyops_recurring_due_work',
    'public.attach_storyops_recurring_due_estimate',
    'public.get_storyops_recurring_due_work',
    'public.prepare_storyops_material_sds_registration',
    'public.finalize_storyops_material_sds_registration',
    'public.get_storyops_material_sds_registry',
    'public.load_storyops_sds_upload_for_attestation',
    'public.attest_storyops_sds_upload',
    'public.get_storyops_provider_launch_state',
    'public.reserve_storyops_trusted_pilot_verification',
    'public.complete_storyops_restore_verification',
    'public.record_storyops_trusted_pilot_proof',
    'public.consume_storyops_dispatch_clearance',
    'public.record_storyops_dispatch_clearance',
    'public.link_storyops_identity',
    'public.revoke_storyops_identity',
    'public.create_storyops_customer_property',
    'public.confirm_storyops_property_geocode_candidate',
    'public.report_storyops_incident_and_pause',
    'public.authorize_storyops_identity_invite',
    'private.storyops_setup_receipts',
    'private.storyops_setup_receipt_quarantines',
    'setup receipt append-only authority',
    'setup receipt quarantine append-only authority',
    'setup completion receipt authority',
    'dispatch origin UNLOGGED ephemera',
    'dispatch origin UNLOGGED verifiers',
    'dispatch origin purge worker health',
    'dispatch origin scheduler retention health',
    'private.storyops_field_media_canary_crews',
    'private.storyops_field_media_canary_registry_quarantine',
    'private.storyops_field_media_canary_crew_capabilities',
    'field-media retired job guard',
    'field-media retired visit guard',
    'field-media retired dispatch guard',
    'field-media canary runtime capture',
    'field-media canary launch quarantine gate',
    'field-media canary crew activation guard',
    'field-media canary completion isolation',
    'identity unresolved email authority',
    'identity attempt state authority',
    'identity invitation provider claim authority',
    'identity invitation attempts forced RLS',
  ]);
  for (const [schemaFragment, expectedSentinel] of [
    [
      'CREATE TABLE private.storyops_incident_close_capabilities',
      /private\.storyops_incident_close_capabilities/u,
    ],
    ['storyops-dispatch-current-origin-v1', /dispatch clearance current-origin v2 contract/u],
    ['media_assets_incident_evidence_guard', /media-assets incident evidence guard/u],
    ['aa_incidents_safe_update_guard', /incidents safe-update command guard/u],
    ['media_assets_open_incident_stop_work', /open-incident stop-work media guard/u],
    [
      'dispatch_clearance_consumption_current_origin_guard',
      /dispatch current-origin consumption guard/u,
    ],
    [
      'public.finalize_storyops_media_upload_from_edge',
      /public\.finalize_storyops_media_upload_from_edge/u,
    ],
    [
      'public.reserve_storyops_field_media_verification',
      /public\.reserve_storyops_field_media_verification/u,
    ],
    [
      'public.claim_storyops_field_media_verification',
      /public\.claim_storyops_field_media_verification/u,
    ],
    [
      'public.complete_storyops_field_media_verification',
      /public\.complete_storyops_field_media_verification/u,
    ],
    [
      'CREATE FUNCTION private.is_storyops_field_media_canary_object',
      /private\.is_storyops_field_media_canary_object/u,
    ],
    [
      'result := public.finalize_storyops_media_upload',
      /field-media Edge adapter canonical delegation/u,
    ],
    [
      'RETURN private.is_storyops_field_media_canary_object(target_name)',
      /field-media canary exact Storage predicate link/u,
    ],
    ['public.record_storyops_dispatch_clearance', /public\.record_storyops_dispatch_clearance/u],
    [
      'CREATE UNLOGGED TABLE private.dispatch_current_origin_ephemera',
      /dispatch origin UNLOGGED ephemera/u,
    ],
    ['trusted_pilot_field_media_registry_capture', /field-media canary runtime capture/u],
    ['FORCE ROW LEVEL SECURITY', /identity invitation attempts forced RLS/u],
  ]) {
    assert.throws(
      () => validateStoryOpsSchemaDump(completeSchema.replace(schemaFragment, 'removed_sentinel')),
      expectedSentinel,
    );
  }
  assert.throws(
    () =>
      validateStoryOpsSchemaDump(
        completeSchema.replace('expected_service_measurement_ids', 'removed_supporting_variable'),
      ),
    /persist_priced_estimate supporting-measurement provenance/u,
  );
  assert.throws(
    () =>
      validateStoryOpsSchemaDump(
        completeSchema.replace(
          'ESTIMATE_SUPPORTING_MEASUREMENT_EVIDENCE_MISMATCH',
          'REMOVED_SUPPORTING_EVIDENCE_GUARD',
        ),
      ),
    /persist_priced_estimate supporting-measurement provenance/u,
  );
  assert.throws(
    () =>
      validateStoryOpsSchemaDump(`
        CREATE TABLE public.companies (id uuid);
        CREATE TABLE public.audit_events (id uuid);
      `),
    /public\.post_service_followups, public\.media_upload_attestations, public\.scheduling_evidence_receipts, public\.customer_portal_requests, role-offboarding active-membership guard, public\.scheduling_reconciliation_cases, public\.scheduling_calendar_booking_attempts, public\.job_actual_cost_snapshots, public\.automation_runs, public\.owner_briefings, public\.customer_quote_change_requests, public\.payment_allocation_conflicts, public\.payment_checkout_retirements, public\.customer_quote_acceptances, public\.lead_intake_operational_dispositions, public\.transactional_delivery_attempts, public\.field_change_requests, public\.recurring_due_occurrences, public\.sds_registration_requests, public\.sds_upload_attestations/u,
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

test('executable restore requires the independently retained manifest digest before target work', async () => {
  const fixture = await pilotRestoreFixture();
  try {
    const missingDigest = runPilotRestore(fixture, {
      trustedManifestSha256: null,
    });
    assert.notEqual(missingDigest.status, 0);
    assert.match(
      missingDigest.stderr,
      /Executable restore requires an independently retained manifest digest/u,
    );
    await assertMissing(fixture.commandLog);
    await assertMissing(fixture.evidenceOutput);

    const wrongDigest = runPilotRestore(fixture, {
      trustedManifestSha256: '0'.repeat(64),
    });
    assert.notEqual(wrongDigest.status, 0);
    assert.match(
      wrongDigest.stderr,
      /manifest authenticity check failed before restore target mutation/u,
    );
    await assertMissing(fixture.commandLog);
    await assertMissing(fixture.evidenceOutput);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('trusted manifest evidence rejects self-checksummed SQL archive forgery before target work', async () => {
  const fixture = await pilotRestoreFixture();
  const manifestPath = resolve(fixture.backup, 'manifest.json');
  const originalManifest = await readFile(manifestPath);
  const trustedManifestSha256 = sha256Bytes(originalManifest);
  const sqlFiles = ['roles.sql', 'schema.sql', 'data.sql'];
  const originalSql = new Map(
    await Promise.all(
      sqlFiles.map(async (name) => [name, await readFile(resolve(fixture.backup, name), 'utf8')]),
    ),
  );
  try {
    for (const name of sqlFiles) {
      await writeFile(manifestPath, originalManifest, { mode: 0o600 });
      for (const [originalName, body] of originalSql) {
        await writeFile(resolve(fixture.backup, originalName), body, { mode: 0o600 });
      }
      await replaceBackupDatabaseFile(
        fixture.backup,
        name,
        `${originalSql.get(name)}\\! printf storyops-forged-archive\n`,
      );
      const receivedManifestSha256 = sha256Bytes(await readFile(manifestPath));
      assert.notEqual(receivedManifestSha256, trustedManifestSha256);

      const authenticityResult = runPilotRestore(fixture, {
        trustedManifestSha256,
      });
      assert.notEqual(authenticityResult.status, 0);
      assert.match(
        authenticityResult.stderr,
        /manifest authenticity check failed before restore target mutation/u,
      );
      await assertMissing(fixture.commandLog);
      await assertMissing(fixture.evidenceOutput);

      const defenseInDepthResult = runPilotRestore(fixture, {
        trustedManifestSha256: receivedManifestSha256,
      });
      assert.notEqual(defenseInDepthResult.status, 0);
      assert.match(defenseInDepthResult.stderr, /forbidden psql meta-command/u);
      await assertMissing(fixture.commandLog);
      await assertMissing(fixture.evidenceOutput);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('restore executes authenticated staged bytes when the source archive changes after validation', async () => {
  const fixture = await pilotRestoreFixture();
  const archiveSchemaPath = resolve(fixture.backup, 'schema.sql');
  const storageRecord = fixture.storageObjects[0];
  const archiveStoragePath = resolve(fixture.backup, storageRecord.file);
  const originalSchema = await readFile(archiveSchemaPath);
  const originalStorage = await readFile(archiveStoragePath);
  const targetSchema = resolve(fixture.directory, 'target-schema.sql');
  await writeFile(targetSchema, originalSchema, { mode: 0o600 });
  const forgedSchema = Buffer.from('\\! printf archive-race-won\\n', 'utf8');
  const forgedStorage = Buffer.from('forged-storage-after-validation', 'utf8');
  try {
    const result = runPilotRestore(fixture, {
      env: {
        FAKE_TARGET_DUMP_SOURCE: targetSchema,
        FAKE_ARCHIVE_SWAPS_JSON: JSON.stringify([
          { path: archiveSchemaPath, bodyBase64: forgedSchema.toString('base64') },
          { path: archiveStoragePath, bodyBase64: forgedStorage.toString('base64') },
        ]),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(archiveSchemaPath), forgedSchema);
    assert.deepEqual(await readFile(archiveStoragePath), forgedStorage);

    const restoredFiles = JSON.parse(await readFile(fixture.restoreFileLog, 'utf8'));
    assert.equal(restoredFiles.length, 4);
    assert.ok(restoredFiles.every(({ path }) => !path.startsWith(fixture.backup)));
    assert.ok(restoredFiles.every(({ text }) => !text.includes('archive-race-won')));
    assert.ok(restoredFiles.some(({ sha256 }) => sha256 === sha256Bytes(originalSchema)));

    const artifact = JSON.parse(await readFile(fixture.evidenceOutput, 'utf8'));
    assert.deepEqual(
      artifact.request.restoreEvidence.storageVerification,
      expectedStorageVerification(fixture.storageObjects),
    );
    assert.equal(
      artifact.request.restoreEvidence.storageVerification.fingerprintSha256,
      expectedStorageVerification([
        {
          ...storageRecord,
          bytes: originalStorage.byteLength,
          sha256: sha256Bytes(originalStorage),
        },
        ...fixture.storageObjects.slice(1),
      ]).fingerprintSha256,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('executed fresh local restore writes a complete signed proof with target-derived facts', async () => {
  const fixture = await pilotRestoreFixture();
  try {
    const startedAt = Date.now();
    const result = runPilotRestore(fixture);
    const finishedAt = Date.now();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /It was not submitted or sent anywhere\./u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(pilotProofSecret, 'u'));

    const artifact = JSON.parse(await readFile(fixture.evidenceOutput, 'utf8'));
    assert.equal(artifact.schemaVersion, 'storyops-signed-isolated-restore-proof-v2');
    assert.equal(artifact.headerName, 'x-storyops-restore-proof');
    assert.equal(artifact.request.operation, 'backup_restore');
    assert.equal(artifact.request.companyId, pilotCompanyId);
    assert.match(artifact.request.commandId, /^[a-f0-9-]{36}$/u);
    assert.match(artifact.request.restoreEvidence.restoreCommandId, /^[a-f0-9-]{36}$/u);
    assert.notEqual(artifact.request.commandId, artifact.request.restoreEvidence.restoreCommandId);
    assert.equal(artifact.request.requestedAt, artifact.request.restoreEvidence.completedAt);
    assert.ok(Date.parse(artifact.request.requestedAt) >= startedAt - 5_000);
    assert.ok(Date.parse(artifact.request.requestedAt) <= finishedAt + 5_000);
    assert.equal(
      Date.parse(artifact.request.expiresAt) - Date.parse(artifact.request.requestedAt),
      30 * 24 * 60 * 60_000,
    );
    assert.equal(artifact.request.restoreEvidence.verifiedMigrationId, REQUIRED_STORYOPS_MIGRATION);
    assert.equal(
      artifact.request.restoreEvidence.sourceDatabaseSystemIdentifier,
      sourceSystemIdentifier,
    );
    assert.equal(
      artifact.request.restoreEvidence.targetDatabaseSystemIdentifier,
      targetSystemIdentifier,
    );
    assert.equal(artifact.request.restoreEvidence.sourceStorageHost, 'source.example.test');
    assert.equal(artifact.request.restoreEvidence.targetStorageHost, '127.0.0.1:55321');
    assert.deepEqual(
      artifact.request.restoreEvidence.storageVerification,
      expectedStorageVerification(fixture.storageObjects),
    );
    assert.equal(
      artifact.request.restoreEvidence.sourceManifestSha256,
      sha256Bytes(await readFile(resolve(fixture.backup, 'manifest.json'))),
    );
    assert.equal(
      artifact.request.restoreEvidence.restoredDatabaseSha256,
      sha256Bytes(await readFile(resolve(fixture.backup, 'schema.sql'))),
    );
    assert.equal(artifact.headerValue, signedRestoreRequest(pilotProofSecret, artifact.request));
    assert.equal((await stat(fixture.evidenceOutput)).mode & 0o777, 0o600);

    const commands = (await readFile(fixture.commandLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      commands.map(({ tool }) => tool),
      ['psql', 'psql', 'psql', 'psql', 'pg_dump', 'psql'],
    );
    const preflight = commands.find(
      ({ tool, args }) =>
        tool === 'psql' && args.some((argument) => argument.includes('pg_catalog.pg_tables')),
    );
    const preflightSql = preflight.args[preflight.args.indexOf('--command') + 1];
    for (const platformSchema of ['_realtime', 'graphql_public', 'pgbouncer']) {
      assert.match(preflightSql, new RegExp(`'${platformSchema}'`, 'u'));
    }
    const restoreTransaction = commands.find(
      ({ tool, args }) => tool === 'psql' && args.includes('--single-transaction'),
    );
    assert.ok(restoreTransaction);
    const restoreTransactionIndex = commands.indexOf(restoreTransaction);
    const targetVerificationIndex = commands.findIndex(
      ({ tool, args }) =>
        tool === 'psql' &&
        args.some((argument) => argument.includes('storyops-isolated-target-verification-v1')),
    );
    assert.ok(targetVerificationIndex > restoreTransactionIndex);
    const restoreCommands = restoreTransaction.args
      .map((argument, index) =>
        restoreTransaction.args[index - 1] === '--command' ? argument : null,
      )
      .filter(Boolean);
    assert.equal(restoreCommands[0], 'SET session_replication_role = replica');
    const aclNormalization = restoreCommands[1];
    assert.match(aclNormalization, /storyops_public_table_acl_normalization/u);
    assert.match(aclNormalization, /relation\.relkind IN \('r', 'p'\)/u);
    assert.match(
      aclNormalization,
      /REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE %I\.%I FROM %I, %I, %I/u,
    );
    assert.match(aclNormalization, /'anon',\s*'authenticated',\s*'service_role'/u);
    assert.match(
      aclNormalization,
      /has_table_privilege\(api_role\.name, relation\.oid, 'TRUNCATE'\)/u,
    );
    assert.match(
      aclNormalization,
      /has_table_privilege\(api_role\.name, relation\.oid, 'REFERENCES'\)/u,
    );
    assert.match(
      aclNormalization,
      /has_table_privilege\(api_role\.name, relation\.oid, 'TRIGGER'\)/u,
    );
    assert.match(aclNormalization, /STORYOPS_PUBLIC_TABLE_ACL_NORMALIZATION_FAILED/u);
    assert.doesNotMatch(aclNormalization, /REVOKE[^;]*(?:SELECT|INSERT|UPDATE|DELETE)/iu);
    const restoreFiles = restoreTransaction.args
      .map((argument, index) => (restoreTransaction.args[index - 1] === '--file' ? argument : null))
      .filter(Boolean);
    assert.equal(restoreFiles.length, 4);
    assert.ok(restoreFiles.every((file) => !file.startsWith(fixture.backup)));
    const restoredFileEvidence = JSON.parse(await readFile(fixture.restoreFileLog, 'utf8'));
    assert.deepEqual(
      restoredFileEvidence.map(({ sha256 }) => sha256),
      await Promise.all(
        ['roles.sql', 'schema.sql', 'storage-policies.sql', 'data.sql'].map(async (name) =>
          sha256Bytes(await readFile(resolve(fixture.backup, name))),
        ),
      ),
    );
    const schemaFileIndex = restoreTransaction.args.indexOf(restoreFiles[1]);
    const storagePolicyFileIndex = restoreTransaction.args.indexOf(restoreFiles[2]);
    const aclNormalizationIndex = restoreTransaction.args.indexOf(aclNormalization);
    assert.ok(schemaFileIndex >= 0);
    assert.ok(storagePolicyFileIndex > schemaFileIndex);
    assert.ok(aclNormalizationIndex > storagePolicyFileIndex);
    assert.match(restoreCommands[2], /SET session_replication_role = origin;/u);
    assert.match(restoreCommands[2], /DISPATCH_ORIGIN_TRANSIENT_ROWS_MUST_NOT_BE_RESTORED/u);
    assert.match(restoreCommands[2], /last_status = 'pending'/u);
    assert.match(
      restoreCommands[2],
      /cron\.schedule\(\s*'storyops-dispatch-origin-purge',\s*'5 seconds'/u,
    );
    assert.match(restoreCommands[2], /private\.run_storyops_dispatch_origin_purge_worker\(\)/u);
    assert.doesNotMatch(
      restoreCommands[2],
      /private\.storyops_dispatch_origin_retention_healthy\(\)/u,
    );
    assert.ok(
      commands.find(
        ({ tool, args }) =>
          tool === 'psql' &&
          args.some((argument) =>
            argument.includes('private.storyops_dispatch_origin_retention_healthy()'),
          ),
      ),
    );
    assert.ok(commands.find(({ tool }) => tool === 'pg_dump').args.includes('--schema=public'));
    assert.ok(
      commands
        .find(
          ({ tool, args }) =>
            tool === 'psql' &&
            args.some((argument) => argument.includes('storyops-isolated-target-verification-v1')),
        )
        .args.some((argument) => argument.includes('storageObjectsRlsEnabled')),
    );
    const storageCommands = (await readFile(fixture.storageLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const uploads = storageCommands.filter(
      ({ method, path }) =>
        ['POST', 'PUT'].includes(method) && path.startsWith('/storage/v1/object/job-media/'),
    );
    const readbacks = storageCommands.filter(
      ({ method, path }) =>
        method === 'GET' &&
        (path.startsWith('/storage/v1/object/authenticated/job-media/') ||
          path.startsWith('/storage/v1/object/job-media/')),
    );
    assert.equal(uploads.length, fixture.storageObjects.length);
    assert.equal(readbacks.length, fixture.storageObjects.length);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('restore proof requires execute, an explicit loopback target, safe flags, and valid IDs', async () => {
  const fixture = await pilotRestoreFixture();
  try {
    const base = pilotRestoreArguments(fixture);
    const withoutFlag = (args, value) => args.filter((argument) => argument !== value);
    const withoutOption = (args, option) => {
      const changed = [...args];
      const index = changed.indexOf(option);
      changed.splice(index, 2);
      return changed;
    };
    const replaceOption = (args, option, value) => {
      const changed = [...args];
      changed[changed.indexOf(option) + 1] = value;
      return changed;
    };
    const cases = [
      {
        args: withoutFlag(base, '--execute'),
        message: /only for an executed restore/u,
      },
      {
        args: withoutOption(base, '--db-url'),
        message: /requires an explicit isolated loopback --db-url/u,
      },
      {
        args: [
          ...replaceOption(
            base,
            '--db-url',
            'postgresql://operator:redacted@db.example.test/storyops',
          ),
          '--allow-remote',
        ],
        message: /restricted to an isolated local target/u,
      },
      {
        args: [...base, '--allow-nonempty'],
        message: /requires a fresh target/u,
      },
      {
        args: [...base, '--skip-roles'],
        message: /requires the complete role restore/u,
      },
      {
        args: [...base, '--replace-storage', '--confirm-storage-host', '127.0.0.1:55321'],
        message: /does not permit Storage overwrite/u,
      },
      {
        args: [
          ...base,
          '--allow-storage-policy-drift',
          '--confirm-storage-policy-drift',
          'a'.repeat(64),
        ],
        message: /does not permit Storage overwrite or policy-drift overrides/u,
      },
      {
        args: withoutFlag(base, '--restore-storage'),
        message: /requires --restore-storage/u,
      },
      {
        args: replaceOption(base, '--pilot-isolation-id', '../unsafe'),
        message: /--pilot-isolation-id must be/u,
      },
    ];
    for (const scenario of cases) {
      const result = runPilotRestore(fixture, { args: scenario.args });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, scenario.message);
      await assertMissing(fixture.evidenceOutput);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('restore proof rejects a nonempty target even without an override flag', async () => {
  const fixture = await pilotRestoreFixture();
  try {
    const result = runPilotRestore(fixture, {
      env: { FAKE_PREFLIGHT_COUNT: '1' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Target contains 1 application table/u);
    await assertMissing(fixture.evidenceOutput);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('restore proof refuses omitted or zero-object Storage backup evidence', async () => {
  const omitted = await pilotRestoreFixture();
  try {
    const manifestPath = resolve(omitted.backup, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.storage = {
      included: false,
      sourceHost: null,
      exportStartedAt: null,
      exportCompletedAt: null,
      crossServiceAtomicWithDatabase: false,
      bucketCount: 0,
      objectCount: 0,
      objectBytes: 0,
      buckets: [],
      objects: [],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const result = runPilotRestore(omitted);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires a backup that includes Storage objects/u);
    await assertMissing(omitted.evidenceOutput);
    await assertMissing(omitted.commandLog);
  } finally {
    await rm(omitted.directory, { recursive: true, force: true });
  }

  const empty = await pilotRestoreFixture();
  try {
    const manifestPath = resolve(empty.backup, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.storage.objects = [];
    manifest.storage.objectCount = 0;
    manifest.storage.objectBytes = 0;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const result = runPilotRestore(empty);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /at least one included Storage object/u);
    await assertMissing(empty.evidenceOutput);
    await assertMissing(empty.commandLog);
  } finally {
    await rm(empty.directory, { recursive: true, force: true });
  }
});

test('restore proof rejects the source endpoint and source database system identity', async () => {
  const sameEndpoint = await pilotRestoreFixture();
  try {
    const manifestPath = resolve(sameEndpoint.backup, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.database.source.host = 'localhost';
    manifest.database.source.port = '55322';
    manifest.database.source.database = 'postgres';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const result = runPilotRestore(sameEndpoint);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /target endpoint different from the backup source/u);
    await assertMissing(sameEndpoint.evidenceOutput);
    await assertMissing(sameEndpoint.commandLog);
  } finally {
    await rm(sameEndpoint.directory, { recursive: true, force: true });
  }

  const sameSystem = await pilotRestoreFixture();
  try {
    const result = runPilotRestore(sameSystem, {
      env: { FAKE_TARGET_SYSTEM_IDENTIFIER: sourceSystemIdentifier },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot be produced against the source database system/u);
    await assertMissing(sameSystem.evidenceOutput);
    const commands = (await readFile(sameSystem.commandLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(!commands.some(({ args }) => args.includes('--single-transaction')));
  } finally {
    await rm(sameSystem.directory, { recursive: true, force: true });
  }

  const sameStorage = await pilotRestoreFixture();
  try {
    const args = [...pilotRestoreArguments(sameStorage)];
    args[args.indexOf('--storage-url') + 1] = 'http://source.example.test';
    const result = runPilotRestore(sameStorage, { args });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /target Storage endpoint different from the backup source/u);
    await assertMissing(sameStorage.evidenceOutput);
    await assertMissing(sameStorage.commandLog);
  } finally {
    await rm(sameStorage.directory, { recursive: true, force: true });
  }
});

test('Storage restore verifies successful uploads, safe retries, and tampered readbacks', async () => {
  const retry = await pilotRestoreFixture();
  try {
    const initialObjects = Object.fromEntries(
      retry.storageObjects.map((object) => [
        `${object.bucket}/${object.name}`,
        Buffer.from(
          object.name.endsWith('before.png')
            ? 'storyops-recovery-canary-before'
            : 'storyops-recovery-canary-after',
        ).toString('base64'),
      ]),
    );
    const result = runPilotRestore(retry, {
      env: {
        FAKE_STORAGE_UPLOAD_CONFLICT: 'true',
        FAKE_STORAGE_INITIAL_OBJECTS: JSON.stringify(initialObjects),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 uploaded, 2 already identical/u);
    const artifact = JSON.parse(await readFile(retry.evidenceOutput, 'utf8'));
    assert.deepEqual(
      artifact.request.restoreEvidence.storageVerification,
      expectedStorageVerification(retry.storageObjects),
    );
  } finally {
    await rm(retry.directory, { recursive: true, force: true });
  }

  const tampered = await pilotRestoreFixture();
  try {
    const result = runPilotRestore(tampered, {
      env: { FAKE_STORAGE_TAMPER_READBACK: 'true' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Storage byte verification failed/u);
    await assertMissing(tampered.evidenceOutput);
  } finally {
    await rm(tampered.directory, { recursive: true, force: true });
  }
});

test('Storage verification fingerprint is canonical across manifest object order', async () => {
  const normal = await pilotRestoreFixture();
  const reversed = await pilotRestoreFixture({ reverseStorageObjects: true });
  try {
    const normalResult = runPilotRestore(normal);
    const reversedResult = runPilotRestore(reversed);
    assert.equal(normalResult.status, 0, normalResult.stderr);
    assert.equal(reversedResult.status, 0, reversedResult.stderr);
    const normalArtifact = JSON.parse(await readFile(normal.evidenceOutput, 'utf8'));
    const reversedArtifact = JSON.parse(await readFile(reversed.evidenceOutput, 'utf8'));
    assert.equal(
      normalArtifact.request.restoreEvidence.storageVerification.fingerprintSha256,
      reversedArtifact.request.restoreEvidence.storageVerification.fingerprintSha256,
    );
  } finally {
    await rm(normal.directory, { recursive: true, force: true });
    await rm(reversed.directory, { recursive: true, force: true });
  }
});

test('restore proof rejects short or reused signing secrets before target mutation', async () => {
  const fixture = await pilotRestoreFixture();
  try {
    const shortSecret = runPilotRestore(fixture, {
      env: { PILOT_RESTORE_PROOF_HMAC_SECRET: 'too-short' },
    });
    assert.notEqual(shortSecret.status, 0);
    assert.match(shortSecret.stderr, /independent secret of at least 32 bytes/u);
    await assertMissing(fixture.evidenceOutput);

    const reusedSecret = 'service-role-secret-that-is-long-enough';
    const reused = runPilotRestore(fixture, {
      env: {
        PILOT_RESTORE_PROOF_HMAC_SECRET: reusedSecret,
        SUPABASE_SERVICE_ROLE_KEY: reusedSecret,
      },
    });
    assert.notEqual(reused.status, 0);
    assert.match(reused.stderr, /independent secret of at least 32 bytes/u);
    await assertMissing(fixture.evidenceOutput);
    await assertMissing(fixture.commandLog);

    const cliReuseArgs = [...pilotRestoreArguments(fixture)];
    cliReuseArgs[cliReuseArgs.indexOf('--storage-key') + 1] = pilotProofSecret;
    const cliReuse = runPilotRestore(fixture, { args: cliReuseArgs });
    assert.notEqual(cliReuse.status, 0);
    assert.match(cliReuse.stderr, /must not reuse target database or Storage credentials/u);
    await assertMissing(fixture.evidenceOutput);
    await assertMissing(fixture.commandLog);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('restore proof refuses stale source authority before restoring', async () => {
  const fixture = await pilotRestoreFixture();
  try {
    const manifestPath = resolve(fixture.backup, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.database.recoveryEvidence.requiredMigration = '20260728430000';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    const result = runPilotRestore(fixture);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`exact StoryOps release migration ${REQUIRED_STORYOPS_MIGRATION}`, 'u'),
    );
    await assertMissing(fixture.evidenceOutput);
    await assertMissing(fixture.commandLog);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('restore proof fails closed on target query failure or RLS/storage sentinel drift', async () => {
  const fixture = await pilotRestoreFixture();
  try {
    const queryFailure = runPilotRestore(fixture, {
      env: { FAKE_TARGET_QUERY_FAILURE: 'true' },
    });
    assert.notEqual(queryFailure.status, 0);
    assert.match(queryFailure.stderr, /target verification failed/u);
    await assertMissing(fixture.evidenceOutput);

    const schedulerFailure = runPilotRestore(fixture, {
      env: { FAKE_DISPATCH_SCHEDULER_HEALTH: 'error' },
    });
    assert.notEqual(schedulerFailure.status, 0);
    assert.match(schedulerFailure.stderr, /dispatch scheduler health unavailable/u);
    await assertMissing(fixture.evidenceOutput);

    const targetWithDrift = {
      schemaVersion: 'storyops-isolated-target-verification-v1',
      serverCompletedAt: new Date().toISOString(),
      systemIdentifier: targetSystemIdentifier,
      activeCompanyIds: [pilotCompanyId],
      missingTables: [],
      missingFunctions: [],
      rlsDisabledTables: ['public.customers'],
      storageObjectsRlsEnabled: true,
      dispatchOriginFunctionAclMismatchCount: 0,
      dispatchOriginPrivateApiPrivilegeCount: 0,
      dispatchOriginTransientRowCount: 0,
      dispatchOriginTransientTablesUnlogged: true,
      dispatchOriginRetentionHealthy: true,
      releaseBoundaryCatalogMismatchCount: 0,
      serviceRolePublicBaseTablePrivilegeCount: 0,
      jobMediaBucket: {
        public: false,
        fileSizeLimit: 26_214_400,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      },
      jobMediaPolicies: ['job_media_insert', 'job_media_select'],
    };
    const driftFailure = runPilotRestore(fixture, {
      env: { FAKE_TARGET_VERIFICATION_JSON: JSON.stringify(targetWithDrift) },
    });
    assert.notEqual(driftFailure.status, 0);
    assert.match(driftFailure.stderr, /failed required schema, RLS/u);
    await assertMissing(fixture.evidenceOutput);

    const targetMissingCanaryFinalizer = {
      ...targetWithDrift,
      missingFunctions: [
        'public.finalize_storyops_media_upload_from_edge(uuid,uuid,uuid,jsonb,text)',
      ],
      rlsDisabledTables: [],
    };
    const missingCanaryFailure = runPilotRestore(fixture, {
      env: {
        FAKE_TARGET_VERIFICATION_JSON: JSON.stringify(targetMissingCanaryFinalizer),
      },
    });
    assert.notEqual(missingCanaryFailure.status, 0);
    assert.match(missingCanaryFailure.stderr, /failed required schema, RLS/u);
    await assertMissing(fixture.evidenceOutput);

    const targetWithDispatchRetentionFailure = {
      ...targetWithDrift,
      rlsDisabledTables: [],
      dispatchOriginRetentionHealthy: false,
    };
    const dispatchRetentionFailure = runPilotRestore(fixture, {
      env: {
        FAKE_TARGET_VERIFICATION_JSON: JSON.stringify(targetWithDispatchRetentionFailure),
      },
    });
    assert.notEqual(dispatchRetentionFailure.status, 0);
    assert.match(dispatchRetentionFailure.stderr, /dispatch-origin retention verification/u);
    await assertMissing(fixture.evidenceOutput);

    const targetWithDispatchAclDrift = {
      ...targetWithDrift,
      rlsDisabledTables: [],
      dispatchOriginFunctionAclMismatchCount: 1,
    };
    const dispatchAclFailure = runPilotRestore(fixture, {
      env: {
        FAKE_TARGET_VERIFICATION_JSON: JSON.stringify(targetWithDispatchAclDrift),
      },
    });
    assert.notEqual(dispatchAclFailure.status, 0);
    assert.match(dispatchAclFailure.stderr, /dispatch-origin retention verification/u);
    await assertMissing(fixture.evidenceOutput);

    const targetWithServiceRoleTableDrift = {
      ...targetWithDrift,
      rlsDisabledTables: [],
      serviceRolePublicBaseTablePrivilegeCount: 1,
    };
    const serviceRoleTableDriftFailure = runPilotRestore(fixture, {
      env: {
        FAKE_TARGET_VERIFICATION_JSON: JSON.stringify(targetWithServiceRoleTableDrift),
      },
    });
    assert.notEqual(serviceRoleTableDriftFailure.status, 0);
    assert.match(serviceRoleTableDriftFailure.stderr, /failed required schema, RLS/u);
    await assertMissing(fixture.evidenceOutput);

    const targetWithLoggedCoordinates = {
      ...targetWithDrift,
      rlsDisabledTables: [],
      dispatchOriginTransientTablesUnlogged: false,
    };
    const loggedCoordinatesFailure = runPilotRestore(fixture, {
      env: {
        FAKE_TARGET_VERIFICATION_JSON: JSON.stringify(targetWithLoggedCoordinates),
      },
    });
    assert.notEqual(loggedCoordinatesFailure.status, 0);
    assert.match(loggedCoordinatesFailure.stderr, /dispatch-origin retention verification/u);
    await assertMissing(fixture.evidenceOutput);

    const targetWithPrivacyTriggerDrift = {
      ...targetWithDrift,
      rlsDisabledTables: [],
      releaseBoundaryCatalogMismatchCount: 1,
    };
    const privacyTriggerFailure = runPilotRestore(fixture, {
      env: {
        FAKE_TARGET_VERIFICATION_JSON: JSON.stringify(targetWithPrivacyTriggerDrift),
      },
    });
    assert.notEqual(privacyTriggerFailure.status, 0);
    assert.match(privacyTriggerFailure.stderr, /dispatch-origin retention verification/u);
    await assertMissing(fixture.evidenceOutput);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('restore proof output is never overwritten', async () => {
  const fixture = await pilotRestoreFixture();
  try {
    const existing = 'operator-owned-existing-evidence\n';
    await writeFile(fixture.evidenceOutput, existing, { mode: 0o600, flag: 'wx' });
    const result = runPilotRestore(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists and will not be overwritten/u);
    assert.equal(await readFile(fixture.evidenceOutput, 'utf8'), existing);
    await assertMissing(fixture.commandLog);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('restore proof signature binds every outer request and restore-evidence field', async () => {
  const fixture = await pilotRestoreFixture();
  try {
    const result = runPilotRestore(fixture);
    assert.equal(result.status, 0, result.stderr);
    const artifact = JSON.parse(await readFile(fixture.evidenceOutput, 'utf8'));
    assert.equal(signedRestoreRequest(pilotProofSecret, artifact.request), artifact.headerValue);

    const tamperedRequests = [
      {
        ...artifact.request,
        operation: 'provider_canary',
      },
      {
        ...artifact.request,
        companyId: '22222222-2222-4222-8222-222222222222',
      },
      {
        ...artifact.request,
        commandId: '33333333-3333-4333-8333-333333333333',
      },
      {
        ...artifact.request,
        requestedAt: new Date(Date.parse(artifact.request.requestedAt) - 60_000).toISOString(),
      },
      {
        ...artifact.request,
        expiresAt: new Date(Date.parse(artifact.request.expiresAt) - 60_000).toISOString(),
      },
      ...[
        { schemaVersion: 'storyops-isolated-restore-evidence-v1' },
        { restoreCommandId: '44444444-4444-4444-8444-444444444444' },
        { evidenceReference: 'restore-drill-tampered' },
        { isolationId: 'isolated-local-tampered' },
        { status: 'failed' },
        { isolatedTarget: false },
        { sourceManifestSha256: 'f'.repeat(64) },
        { restoredDatabaseSha256: '0'.repeat(64) },
        { verifiedMigrationId: '20260728480000' },
        { sourceDatabaseSystemIdentifier: '7668118205518053420' },
        { targetDatabaseSystemIdentifier: '7668408443751252012' },
        { sourceStorageHost: 'source-tampered.example.test' },
        { targetStorageHost: '127.0.0.1:55329' },
        {
          storageVerification: {
            ...artifact.request.restoreEvidence.storageVerification,
            fingerprintSha256: '1'.repeat(64),
          },
        },
        {
          completedAt: new Date(
            Date.parse(artifact.request.restoreEvidence.completedAt) - 60_000,
          ).toISOString(),
        },
      ].map((restoreEvidenceChange) => ({
        ...artifact.request,
        restoreEvidence: {
          ...artifact.request.restoreEvidence,
          ...restoreEvidenceChange,
        },
      })),
    ];
    for (const tampered of tamperedRequests) {
      assert.notEqual(signedRestoreRequest(pilotProofSecret, tampered), artifact.headerValue);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
