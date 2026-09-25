import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  REPO_ROOT,
  supabaseCommand,
  unsafePublishedDockerBindings,
} from '../../infra/scripts/common.mjs';

const PROJECT_ID = 'storyops-canary-upgrade-proof';
const DATABASE_CONTAINER = `supabase_db_${PROJECT_ID}`;
const LOOPBACK_NETWORK = `${PROJECT_ID}-supabase-loopback`;
const LOOPBACK_BINDING_OPTION = 'com.docker.network.bridge.host_binding_ipv4';
const LOOPBACK_BINDING_ADDRESS = '127.0.0.1';
const CURRENT_MIGRATION = '20260728620000_field_media_canary_crew_isolation.sql';
const OWNER_ID = '10000000-0000-4000-8000-000000000101';
const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const CONSUMED_RUN_ID = '96410000-0000-4000-8000-000000000701';
const VERIFIED_RUN_ID = '96420000-0000-4000-8000-000000000701';
const TAMPERED_RUN_ID = '96430000-0000-4000-8000-000000000701';
const CONTROLLED_QUARANTINE_RUN_ID = '96440000-0000-4000-8000-000000000701';
const CONSUMED_CREW_ID = '96410000-0000-4000-8000-000000000601';
const VERIFIED_CREW_ID = '96420000-0000-4000-8000-000000000601';
const CONTROLLED_QUARANTINE_CREW_ID = '96440000-0000-4000-8000-000000000601';
const REAL_CREW_ID = '10000000-0000-4000-8000-000000000601';
const PROOF_AUDIT_ID = '96410000-0000-4000-8000-000000000902';
const PROOF_EVIDENCE_ID = '96410000-0000-4000-8000-000000000901';
const LEGACY_AUDIT_ID = '96490000-0000-4000-8000-000000000902';
const LEGACY_EVIDENCE_ID = '96490000-0000-4000-8000-000000000901';

function sanitized(value) {
  return String(value)
    .replace(/eyJ[a-zA-Z0-9._-]+/gu, '[REDACTED_JWT]')
    .replace(
      /(anon key|service_role key|JWT secret|Access token|Secret key)\s+\S+/giu,
      '$1 [REDACTED]',
    );
}

function runSupabase(workdir, arguments_, allowFailure = false) {
  const cli = supabaseCommand();
  const result = spawnSync(cli.command, [...cli.prefix, ...arguments_, '--workdir', workdir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `Supabase ${arguments_.join(' ')} failed.\n${sanitized(result.stdout)}\n${sanitized(
        result.stderr,
      )}`,
    );
  }
  return result;
}

function runDocker(arguments_, allowFailure = false) {
  const result = spawnSync('docker', arguments_, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `Docker ${arguments_.join(' ')} failed.\n${sanitized(result.stdout)}\n${sanitized(
        result.stderr,
      )}`,
    );
  }
  return result;
}

function ensureLoopbackNetwork() {
  const listing = runDocker([
    'network',
    'ls',
    '--filter',
    `name=^${LOOPBACK_NETWORK}$`,
    '--format',
    '{{.Name}}',
  ]);
  const existingNames = listing.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (existingNames.some((name) => name !== LOOPBACK_NETWORK) || existingNames.length > 1) {
    throw new Error(`Docker returned an ambiguous network match for ${LOOPBACK_NETWORK}.`);
  }

  const created = existingNames.length === 0;
  if (created) {
    runDocker([
      'network',
      'create',
      '--driver',
      'bridge',
      '--opt',
      `${LOOPBACK_BINDING_OPTION}=${LOOPBACK_BINDING_ADDRESS}`,
      LOOPBACK_NETWORK,
    ]);
  }

  const inspection = runDocker(['network', 'inspect', '--format', '{{json .}}', LOOPBACK_NETWORK]);
  const lines = inspection.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`Docker returned incomplete network metadata for ${LOOPBACK_NETWORK}.`);
  }
  let network;
  try {
    network = JSON.parse(lines[0]);
  } catch {
    throw new Error(`Docker returned invalid network metadata for ${LOOPBACK_NETWORK}.`);
  }
  if (
    network?.Name !== LOOPBACK_NETWORK ||
    network?.Driver !== 'bridge' ||
    network?.Options?.[LOOPBACK_BINDING_OPTION] !== LOOPBACK_BINDING_ADDRESS
  ) {
    throw new Error(
      `Refusing Docker network ${LOOPBACK_NETWORK}: it is not the required loopback-only bridge.`,
    );
  }
  return created;
}

function assertLoopbackBindings() {
  const listing = runDocker([
    'ps',
    '--filter',
    `label=com.supabase.cli.project=${PROJECT_ID}`,
    '--format',
    '{{.ID}}',
  ]);
  const containerIds = listing.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (containerIds.length === 0) {
    throw new Error('Disposable upgrade stack started without any project containers.');
  }
  const inspection = runDocker([
    'inspect',
    '--format',
    '{{json .NetworkSettings.Ports}}',
    ...containerIds,
  ]);
  const lines = inspection.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (lines.length !== containerIds.length) {
    throw new Error('Docker returned incomplete upgrade-stack port metadata.');
  }
  const unsafe = unsafePublishedDockerBindings(
    lines.map((line, index) => {
      try {
        return { containerId: containerIds[index], ports: JSON.parse(line) };
      } catch {
        throw new Error(`Docker returned invalid port metadata for ${containerIds[index]}.`);
      }
    }),
  );
  if (unsafe.length > 0) {
    const details = unsafe
      .map(
        ({ containerId, containerPort, hostIp, hostPort }) =>
          `${containerId}:${containerPort} -> ${hostIp || '*'}:${hostPort || '*'}`,
      )
      .join(', ');
    throw new Error(`Disposable upgrade stack published a non-loopback binding: ${details}.`);
  }
}

function waitForDatabase(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));

  while (Date.now() < deadline) {
    const state = spawnSync(
      'docker',
      ['inspect', '--format', '{{.State.Running}} {{.State.Restarting}}', DATABASE_CONTAINER],
      {
        encoding: 'utf8',
        timeout: 2_000,
      },
    );
    if (state.status !== 0 || state.stdout.trim() !== 'true false') {
      Atomics.wait(pause, 0, 0, 500);
      continue;
    }

    const ready = spawnSync(
      'docker',
      ['exec', DATABASE_CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
      {
        encoding: 'utf8',
        stdio: 'ignore',
        timeout: 2_000,
      },
    );
    if (ready.status === 0) {
      return;
    }
    Atomics.wait(pause, 0, 0, 500);
  }

  const logs = spawnSync('docker', ['logs', '--tail', '80', DATABASE_CONTAINER], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  throw new Error(
    `Disposable upgrade database did not become ready.\n${sanitized(logs.stdout)}\n${sanitized(
      logs.stderr,
    )}`,
  );
}

function runSql(sql) {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      DATABASE_CONTAINER,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    {
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    },
  );
}

function queryJson(sql) {
  const output = execFileSync(
    'docker',
    [
      'exec',
      DATABASE_CONTAINER,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-Atc',
      sql,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
  return JSON.parse(output);
}

function runSession(sql, marker = undefined) {
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      DATABASE_CONTAINER,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  let markerSeen = marker === undefined;
  let resolveMarker;
  let rejectMarker;
  const markerReady = new Promise((resolve, reject) => {
    resolveMarker = resolve;
    rejectMarker = reject;
  });
  if (markerSeen) resolveMarker();
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      const error = new Error(
        `Disposable upgrade concurrency session timed out.\n${stdout}\n${stderr}`,
      );
      rejectMarker(error);
      reject(error);
    }, 15_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (!markerSeen && stdout.includes(marker)) {
        markerSeen = true;
        resolveMarker();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectMarker(error);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0 && markerSeen) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(
        `Disposable upgrade concurrency session exited ${code}.\n${stdout}\n${stderr}`,
      );
      rejectMarker(error);
      reject(error);
    });
    child.stdin.end(sql);
  });
  return { markerReady, completion };
}

const config = `
project_id = "${PROJECT_ID}"

[api]
enabled = true
port = 56321
schemas = ["public", "storage", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = 56322
shadow_port = 56320
major_version = 15

[db.seed]
enabled = false

[realtime]
enabled = false

[studio]
enabled = false
port = 56323
api_url = "http://127.0.0.1"

[local_smtp]
enabled = false
port = 56324

[storage]
enabled = true
file_size_limit = "25MiB"

[auth]
enabled = true
site_url = "http://127.0.0.1:5173"
additional_redirect_urls = ["http://localhost:5173", "http://127.0.0.1:5173"]
jwt_expiry = 3600
enable_refresh_token_rotation = true
refresh_token_reuse_interval = 10
enable_signup = false
minimum_password_length = 12

[auth.email]
enable_signup = false
double_confirm_changes = true
enable_confirmations = true

[analytics]
enabled = false

[edge_runtime]
enabled = false
policy = "per_worker"
`;

const fixtureSql = `
insert into public.company_configuration_versions(
  id, company_id, revision, schema_version, status, publication_mode,
  configuration, configuration_hash, review_reference, created_by,
  published_by, published_at
)
values (
  '96400000-0000-4000-8000-000000000001',
  '${COMPANY_ID}',
  1,
  'storyops-company-config-v1',
  'published',
  'live',
  jsonb_build_object(
    'schemaVersion', 'storyops-company-config-v1',
    'testFixture', 'field-media-canary-upgrade',
    'territory', jsonb_build_object(
      'travelZones', jsonb_build_array(jsonb_build_object(
        'code', 'DFW-CORE',
        'postalCodes', jsonb_build_array('75001')
      )),
      'travelZoneMappingReview', jsonb_build_object(
        'status', 'approved',
        'reviewer', 'Upgrade harness',
        'reviewedAt', '2026-07-30T00:00:00Z',
        'evidenceReference', 'TEST-CANARY-UPGRADE-ZONE'
      )
    ),
    'pricing', jsonb_build_object(
      'taxReview', jsonb_build_object('status', 'approved')
    ),
    'policies', jsonb_build_object(
      'legalReview', jsonb_build_object('status', 'approved'),
      'privacyReview', jsonb_build_object('status', 'approved'),
      'safetyReview', jsonb_build_object('status', 'approved'),
      'insuranceReview', jsonb_build_object('status', 'approved'),
      'environmentalReview', jsonb_build_object('status', 'approved')
    ),
    'integrations', jsonb_build_object('providers', jsonb_build_array())
  ),
  repeat('d', 64),
  'TEST-CANARY-UPGRADE-CONFIG',
  '${OWNER_ID}',
  '${OWNER_ID}',
  clock_timestamp()
);

insert into public.company_operating_baseline_publications(
  id, company_id, configuration_version_id, configuration_revision,
  configuration_hash, price_book_id, service_terms_id, retention_policy_id,
  baseline_hash, status, review_reference, activated_by, command_id,
  request_hash
)
values (
  '96400000-0000-4000-8000-000000000002',
  '${COMPANY_ID}',
  '96400000-0000-4000-8000-000000000001',
  1,
  repeat('d', 64),
  '10000000-0000-4000-8000-000000000401',
  '10000000-0000-4000-8000-000000000152',
  '10000000-0000-4000-8000-000000000151',
  repeat('e', 64),
  'active',
  'TEST-CANARY-UPGRADE-BASELINE',
  '${OWNER_ID}',
  '96400000-0000-4000-8000-000000000003',
  repeat('f', 64)
);

insert into public.customers(
  id, company_id, kind, display_name, lifecycle, tags,
  acquisition_source, do_not_contact, notes
)
values (
  '96400000-0000-4000-8000-000000000201',
  '${COMPANY_ID}',
  'business',
  'WashOps controlled rehearsal',
  'inactive',
  array['storyops-controlled-rehearsal'],
  'system_controlled_rehearsal',
  true,
  'Non-customer, non-outbound field-media authorization canary fixture.'
);

insert into public.properties(
  id, company_id, customer_id, name, property_type, service_address,
  access_instructions, known_hazards
)
values (
  '96400000-0000-4000-8000-000000000211',
  '${COMPANY_ID}',
  '96400000-0000-4000-8000-000000000201',
  'WashOps controlled rehearsal property',
  'other',
  '{"line1":"Internal controlled rehearsal only","city":"Internal","region":"TX","postalCode":"75001"}',
  'No customer site or outbound work.',
  '{}'
);

insert into public.estimates(
  id, company_id, estimate_number, customer_id, property_id,
  price_book_id, price_book_version, status, service_subtotal,
  minimum_adjustment, travel_fee, manual_adjustment, discount,
  taxable_subtotal, tax, total, deposit_required, estimated_cost,
  estimated_margin_pct, duration_minutes, calculation_version,
  calculation_input, calculation_issues, calculated_at
)
values (
  '96400000-0000-4000-8000-000000000501',
  '${COMPANY_ID}',
  'CANARY-UPGRADE-ESTIMATE',
  '96400000-0000-4000-8000-000000000201',
  '96400000-0000-4000-8000-000000000211',
  '10000000-0000-4000-8000-000000000401',
  '2026.1',
  'draft',
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15,
  'storyops-controlled-rehearsal-v1',
  jsonb_build_object(
    'controlledRehearsal', true,
    'travelZoneCode', 'DFW-CORE',
    'travelZoneEvidence', jsonb_build_object(
      'source', 'reviewed_postal_code',
      'postalCode', '75001',
      'mappingReviewedBy', 'Demo fixture owner',
      'mappingReviewedAt', '2026-07-28T12:00:00.000Z',
      'mappingReviewReference', 'demo-seed-reviewed-zip-mappings-v1'
    ),
    'services', jsonb_build_array(jsonb_build_object(
      'serviceCode', 'pressure-wash-flatwork',
      'measurementId', '96400000-0000-4000-8000-000000000551'
    )),
    'scopeEvidencePolicies', jsonb_build_array(jsonb_build_object(
      'serviceCode', 'pressure-wash-flatwork',
      'policy', 'photo_required'
    )),
    'scopeEvidenceDisposition', 'human_review_required'
  ),
  '[]',
  clock_timestamp()
);

insert into public.quotes(
  id, company_id, quote_number, estimate_id, customer_id, property_id,
  status, valid_until, terms_version, terms_snapshot, total, deposit_required
)
values
  (
    '96410000-0000-4000-8000-000000000511',
    '${COMPANY_ID}',
    'CANARY-UPGRADE-Q1',
    '96400000-0000-4000-8000-000000000501',
    '96400000-0000-4000-8000-000000000201',
    '96400000-0000-4000-8000-000000000211',
    'draft',
    current_date + 1,
    'controlled-rehearsal-v1',
    'Internal controlled rehearsal. Not a customer quote.',
    0,
    0
  ),
  (
    '96420000-0000-4000-8000-000000000511',
    '${COMPANY_ID}',
    'CANARY-UPGRADE-Q2',
    '96400000-0000-4000-8000-000000000501',
    '96400000-0000-4000-8000-000000000201',
    '96400000-0000-4000-8000-000000000211',
    'draft',
    current_date + 1,
    'controlled-rehearsal-v1',
    'Internal controlled rehearsal. Not a customer quote.',
    0,
    0
  ),
  (
    '96430000-0000-4000-8000-000000000511',
    '${COMPANY_ID}',
    'CANARY-UPGRADE-Q3',
    '96400000-0000-4000-8000-000000000501',
    '96400000-0000-4000-8000-000000000201',
    '96400000-0000-4000-8000-000000000211',
    'draft',
    current_date + 1,
    'controlled-rehearsal-v1',
    'Internal controlled rehearsal. Not a customer quote.',
    0,
    0
  ),
  (
    '96440000-0000-4000-8000-000000000511',
    '${COMPANY_ID}',
    'CANARY-UPGRADE-Q4',
    '96400000-0000-4000-8000-000000000501',
    '96400000-0000-4000-8000-000000000201',
    '96400000-0000-4000-8000-000000000211',
    'draft',
    current_date + 1,
    'controlled-rehearsal-v1',
    'Internal controlled rehearsal. Not a customer quote.',
    0,
    0
  );

insert into public.crews(
  id, company_id, name, active, lead_technician_id,
  skill_codes, home_base_postal_code
)
values
  (
    '${CONSUMED_CREW_ID}',
    '${COMPANY_ID}',
    'WashOps controlled rehearsal 96410000',
    false,
    '10000000-0000-4000-8000-000000000103',
    '{}',
    '00000'
  ),
  (
    '${VERIFIED_CREW_ID}',
    '${COMPANY_ID}',
    'WashOps controlled rehearsal 96420000',
    true,
    '10000000-0000-4000-8000-000000000103',
    '{}',
    '00000'
  ),
  (
    '${CONTROLLED_QUARANTINE_CREW_ID}',
    '${COMPANY_ID}',
    'WashOps controlled rehearsal 96440000',
    false,
    '10000000-0000-4000-8000-000000000103',
    '{}',
    '00000'
  );

insert into public.jobs(
  id, company_id, job_number, quote_id, customer_id, property_id,
  status, priority, service_codes, estimated_duration_minutes,
  estimated_revenue, estimated_cost, assigned_crew_id
)
values
  (
    '96410000-0000-4000-8000-000000000401',
    '${COMPANY_ID}',
    'CANARY-96410000-0000-4000',
    '96410000-0000-4000-8000-000000000511',
    '96400000-0000-4000-8000-000000000201',
    '96400000-0000-4000-8000-000000000211',
    'in_progress', 'routine', '{}', 15, 0, 0, '${CONSUMED_CREW_ID}'
  ),
  (
    '96420000-0000-4000-8000-000000000401',
    '${COMPANY_ID}',
    'CANARY-96420000-0000-4000',
    '96420000-0000-4000-8000-000000000511',
    '96400000-0000-4000-8000-000000000201',
    '96400000-0000-4000-8000-000000000211',
    'in_progress', 'routine', '{}', 15, 0, 0, '${VERIFIED_CREW_ID}'
  ),
  (
    '96430000-0000-4000-8000-000000000401',
    '${COMPANY_ID}',
    'CANARY-96430000-0000-4000',
    '96430000-0000-4000-8000-000000000511',
    '96400000-0000-4000-8000-000000000201',
    '96400000-0000-4000-8000-000000000211',
    'in_progress', 'routine', '{}', 15, 0, 0, '${REAL_CREW_ID}'
  ),
  (
    '96440000-0000-4000-8000-000000000401',
    '${COMPANY_ID}',
    'CANARY-96440000-0000-4000',
    '96440000-0000-4000-8000-000000000511',
    '96400000-0000-4000-8000-000000000201',
    '96400000-0000-4000-8000-000000000211',
    'in_progress', 'routine', '{}', 15, 0, 0,
    '${CONTROLLED_QUARANTINE_CREW_ID}'
  );

insert into public.visits(
  id, company_id, job_id, sequence, status, starts_at, ends_at,
  crew_id, checklist_template_id, internal_notes
)
values
  (
    '96410000-0000-4000-8000-000000000641',
    '${COMPANY_ID}',
    '96410000-0000-4000-8000-000000000401',
    1, 'on_site', clock_timestamp() - interval '1 minute',
    clock_timestamp() + interval '14 minutes',
    '${CONSUMED_CREW_ID}',
    '10000000-0000-4000-8000-000000000301',
    'Controlled rehearsal only; no customer work or outbound action.'
  ),
  (
    '96420000-0000-4000-8000-000000000641',
    '${COMPANY_ID}',
    '96420000-0000-4000-8000-000000000401',
    1, 'on_site', clock_timestamp() + interval '20 minutes',
    clock_timestamp() + interval '35 minutes',
    '${VERIFIED_CREW_ID}',
    '10000000-0000-4000-8000-000000000301',
    'Controlled rehearsal only; no customer work or outbound action.'
  ),
  (
    '96430000-0000-4000-8000-000000000641',
    '${COMPANY_ID}',
    '96430000-0000-4000-8000-000000000401',
    1, 'on_site', clock_timestamp() + interval '40 minutes',
    clock_timestamp() + interval '55 minutes',
    '${REAL_CREW_ID}',
    '10000000-0000-4000-8000-000000000301',
    'Controlled rehearsal only; no customer work or outbound action.'
  ),
  (
    '96440000-0000-4000-8000-000000000641',
    '${COMPANY_ID}',
    '96440000-0000-4000-8000-000000000401',
    1, 'on_site', clock_timestamp() + interval '60 minutes',
    clock_timestamp() + interval '75 minutes',
    '${CONTROLLED_QUARANTINE_CREW_ID}',
    '10000000-0000-4000-8000-000000000301',
    'Controlled rehearsal only; no customer work or outbound action.'
  );

insert into public.trusted_pilot_verification_runs(
  id, company_id, command_id, request_hash, execution_command_id,
  execution_request_hash, kind, provider, capability, status,
  requested_by_user_id, assigned_user_id, field_worker_role,
  configuration_revision, configuration_hash, baseline_id, baseline_hash,
  visit_id, job_id, property_id, evidence_basis, external_operation,
  evidence_reference, artifact_sha256, observed_at, expires_at,
  proof_receipt, started_at, completed_at, consumed_at
)
values
  (
    '${CONSUMED_RUN_ID}',
    '${COMPANY_ID}',
    '96410000-0000-4000-8000-000000000711',
    repeat('1', 64),
    '96410000-0000-4000-8000-000000000712',
    repeat('2', 64),
    'field_media_canary',
    'signed_storage_targets',
    'private_media_roundtrip',
    'consumed',
    '${OWNER_ID}',
    '10000000-0000-4000-8000-000000000103',
    'technician',
    1,
    repeat('d', 64),
    '96400000-0000-4000-8000-000000000002',
    repeat('e', 64),
    '96410000-0000-4000-8000-000000000641',
    '96410000-0000-4000-8000-000000000401',
    '96400000-0000-4000-8000-000000000211',
    'authenticated_field_media',
    'field_media.field_worker_roundtrip',
    'verify-96410000-0000-4000-8000-000000000701',
    repeat('3', 64),
    clock_timestamp() - interval '1 minute',
    clock_timestamp() + interval '30 days',
    jsonb_build_object(
      'evidenceId', '${PROOF_EVIDENCE_ID}',
      'verificationRunId', '${CONSUMED_RUN_ID}'
    ),
    clock_timestamp() - interval '2 minutes',
    clock_timestamp() - interval '1 minute',
    clock_timestamp() - interval '30 seconds'
  ),
  (
    '${VERIFIED_RUN_ID}',
    '${COMPANY_ID}',
    '96420000-0000-4000-8000-000000000711',
    repeat('4', 64),
    '96420000-0000-4000-8000-000000000712',
    repeat('5', 64),
    'field_media_canary',
    'signed_storage_targets',
    'private_media_roundtrip',
    'verified',
    '${OWNER_ID}',
    '10000000-0000-4000-8000-000000000103',
    'technician',
    1,
    repeat('d', 64),
    '96400000-0000-4000-8000-000000000002',
    repeat('e', 64),
    '96420000-0000-4000-8000-000000000641',
    '96420000-0000-4000-8000-000000000401',
    '96400000-0000-4000-8000-000000000211',
    'authenticated_field_media',
    'field_media.field_worker_roundtrip',
    'verify-96420000-0000-4000-8000-000000000701',
    repeat('6', 64),
    clock_timestamp() - interval '1 minute',
    clock_timestamp() + interval '30 days',
    null,
    clock_timestamp() - interval '2 minutes',
    clock_timestamp() - interval '1 minute',
    null
  ),
  (
    '${TAMPERED_RUN_ID}',
    '${COMPANY_ID}',
    '96430000-0000-4000-8000-000000000711',
    repeat('7', 64),
    '96430000-0000-4000-8000-000000000712',
    repeat('8', 64),
    'field_media_canary',
    'signed_storage_targets',
    'private_media_roundtrip',
    'executing',
    '${OWNER_ID}',
    '10000000-0000-4000-8000-000000000103',
    'technician',
    1,
    repeat('d', 64),
    '96400000-0000-4000-8000-000000000002',
    repeat('e', 64),
    '96430000-0000-4000-8000-000000000641',
    '96430000-0000-4000-8000-000000000401',
    '96400000-0000-4000-8000-000000000211',
    null, null, null, null, null, null, null,
    clock_timestamp() - interval '1 minute',
    null,
    null
  ),
  (
    '${CONTROLLED_QUARANTINE_RUN_ID}',
    '${COMPANY_ID}',
    '96440000-0000-4000-8000-000000000711',
    repeat('a', 64),
    null,
    null,
    'field_media_canary',
    'signed_storage_targets',
    'private_media_roundtrip',
    'awaiting_field_worker',
    '${OWNER_ID}',
    '10000000-0000-4000-8000-000000000103',
    'technician',
    1,
    repeat('d', 64),
    '96400000-0000-4000-8000-000000000002',
    repeat('e', 64),
    '96440000-0000-4000-8000-000000000641',
    '96440000-0000-4000-8000-000000000401',
    '96400000-0000-4000-8000-000000000211',
    null, null, null, null, null,
    clock_timestamp() + interval '30 days',
    null,
    clock_timestamp() - interval '1 minute',
    null,
    null
  );

insert into public.audit_events(
  id, company_id, occurred_at, actor_type, actor_id, action,
  entity_type, entity_id, after_data, request_id,
  retention_class, retain_until
)
values
  (
    '96410000-0000-4000-8000-000000000801',
    '${COMPANY_ID}',
    clock_timestamp() - interval '3 minutes',
    'user',
    '${OWNER_ID}',
    'pilot.field_media_canary_session_created',
    'trusted_pilot_verification_run',
    '${CONSUMED_RUN_ID}',
    jsonb_build_object(
      'assignedUserId', '10000000-0000-4000-8000-000000000103',
      'controlledRehearsal', true,
      'customerVisible', false,
      'jobId', '96410000-0000-4000-8000-000000000401',
      'visitId', '96410000-0000-4000-8000-000000000641'
    ),
    '96410000-0000-4000-8000-000000000711',
    'audit',
    clock_timestamp() + interval '7 years'
  ),
  (
    '96420000-0000-4000-8000-000000000801',
    '${COMPANY_ID}',
    clock_timestamp() - interval '3 minutes',
    'user',
    '${OWNER_ID}',
    'pilot.field_media_canary_session_created',
    'trusted_pilot_verification_run',
    '${VERIFIED_RUN_ID}',
    jsonb_build_object(
      'assignedUserId', '10000000-0000-4000-8000-000000000103',
      'controlledRehearsal', true,
      'customerVisible', false,
      'jobId', '96420000-0000-4000-8000-000000000401',
      'visitId', '96420000-0000-4000-8000-000000000641'
    ),
    '96420000-0000-4000-8000-000000000711',
    'audit',
    clock_timestamp() + interval '7 years'
  ),
  (
    '96430000-0000-4000-8000-000000000801',
    '${COMPANY_ID}',
    clock_timestamp() - interval '3 minutes',
    'user',
    '${OWNER_ID}',
    'pilot.field_media_canary_session_created',
    'trusted_pilot_verification_run',
    '${TAMPERED_RUN_ID}',
    jsonb_build_object(
      'assignedUserId', '10000000-0000-4000-8000-000000000103',
      'controlledRehearsal', true,
      'customerVisible', false,
      'jobId', '96430000-0000-4000-8000-000000000401',
      'visitId', '96430000-0000-4000-8000-000000000641'
    ),
    '96430000-0000-4000-8000-000000000711',
    'audit',
    clock_timestamp() + interval '7 years'
  ),
  (
    '${PROOF_AUDIT_ID}',
    '${COMPANY_ID}',
    clock_timestamp() - interval '10 seconds',
    'system',
    'trusted-verification-run',
    'pilot.evidence_recorded',
    'pilot_release_evidence',
    '${PROOF_EVIDENCE_ID}',
    jsonb_build_object(
      'kind', 'field_media_canary',
      'provider', 'signed_storage_targets',
      'outcome', 'passed',
      'source', 'authenticated_field_media_roundtrip',
      'evidenceReference', 'verify-96410000-0000-4000-8000-000000000701',
      'artifactSha256', repeat('3', 64),
      'observedAt', clock_timestamp() - interval '1 minute',
      'expiresAt', clock_timestamp() + interval '30 days',
      'verificationBasis', 'trusted_system_proof',
      'binding', jsonb_build_object(
        'configurationRevision', 1,
        'configurationHash', repeat('d', 64),
        'baselineId', '96400000-0000-4000-8000-000000000002',
        'baselineHash', repeat('e', 64),
        'capability', 'private_media_roundtrip',
        'integrationProvider', 'signed_storage_targets',
        'verificationRunId', '${CONSUMED_RUN_ID}',
        'visitId', '96410000-0000-4000-8000-000000000641',
        'fieldWorkerRole', 'technician'
      )
    ),
    '96410000-0000-4000-8000-000000000711',
    'audit',
    clock_timestamp() + interval '7 years'
  ),
  (
    '${LEGACY_AUDIT_ID}',
    '${COMPANY_ID}',
    clock_timestamp() - interval '20 seconds',
    'system',
    'trusted-canary-worker',
    'pilot.evidence_recorded',
    'pilot_release_evidence',
    '${LEGACY_EVIDENCE_ID}',
    jsonb_build_object(
      'kind', 'field_media_canary',
      'provider', 'signed_storage_targets',
      'outcome', 'passed',
      'source', 'storage_roundtrip',
      'evidenceReference', 'legacy-unbound-upgrade-proof',
      'artifactSha256', repeat('9', 64),
      'observedAt', clock_timestamp() - interval '1 minute',
      'expiresAt', clock_timestamp() + interval '30 days',
      'verificationBasis', 'trusted_system_proof',
      'binding', jsonb_build_object(
        'configurationRevision', 1,
        'configurationHash', repeat('d', 64),
        'baselineId', '96400000-0000-4000-8000-000000000002',
        'baselineHash', repeat('e', 64),
        'capability', 'private_media_roundtrip',
        'integrationProvider', 'signed_storage_targets'
      )
    ),
    '96490000-0000-4000-8000-000000000911',
    'audit',
    clock_timestamp() + interval '7 years'
  );

insert into public.company_launch_authorization_events(
  id, company_id, version, action, configuration_revision,
  configuration_hash, baseline_id, baseline_hash,
  provider_snapshot_hash, proof_snapshot_hash, provider_bindings,
  proof_event_ids, review_reference, actor_user_id, command_id,
  request_hash
)
values (
  '96400000-0000-4000-8000-000000000951',
  '${COMPANY_ID}',
  1,
  'authorize',
  1,
  repeat('d', 64),
  '96400000-0000-4000-8000-000000000002',
  repeat('e', 64),
  repeat('a', 64),
  repeat('b', 64),
  '[]',
  jsonb_build_array('${PROOF_AUDIT_ID}'::uuid),
  'TEST-CANARY-UPGRADE-LAUNCH',
  '${OWNER_ID}',
  '96400000-0000-4000-8000-000000000952',
  repeat('c', 64)
);
`;

const resultSql = `
select jsonb_build_object(
  'consumedStatus', (
    select status from public.trusted_pilot_verification_runs
    where id = '${CONSUMED_RUN_ID}'
  ),
  'verifiedStatus', (
    select status from public.trusted_pilot_verification_runs
    where id = '${VERIFIED_RUN_ID}'
  ),
  'tamperedStatus', (
    select status from public.trusted_pilot_verification_runs
    where id = '${TAMPERED_RUN_ID}'
  ),
  'controlledQuarantineStatus', (
    select status from public.trusted_pilot_verification_runs
    where id = '${CONTROLLED_QUARANTINE_RUN_ID}'
  ),
  'consumedAuthority', (
    select capture_authority
    from private.storyops_field_media_canary_crews
    where verification_run_id = '${CONSUMED_RUN_ID}'
  ),
  'verifiedAuthority', (
    select capture_authority
    from private.storyops_field_media_canary_crews
    where verification_run_id = '${VERIFIED_RUN_ID}'
  ),
  'tamperedRegistered', exists (
    select 1 from private.storyops_field_media_canary_crews
    where verification_run_id = '${TAMPERED_RUN_ID}'
  ),
  'tamperedQuarantined', exists (
    select 1
    from private.storyops_field_media_canary_registry_quarantine
    where verification_run_id = '${TAMPERED_RUN_ID}'
      and requires_review
  ),
  'controlledQuarantined', exists (
    select 1
    from private.storyops_field_media_canary_registry_quarantine
    where verification_run_id = '${CONTROLLED_QUARANTINE_RUN_ID}'
      and requires_review
  ),
  'consumedCrewActive', (
    select active from public.crews where id = '${CONSUMED_CREW_ID}'
  ),
  'verifiedCrewActive', (
    select active from public.crews where id = '${VERIFIED_CREW_ID}'
  ),
  'realCrewActive', (
    select active from public.crews where id = '${REAL_CREW_ID}'
  ),
  'controlledQuarantineCrewActive', (
    select active from public.crews
    where id = '${CONTROLLED_QUARANTINE_CREW_ID}'
  ),
  'runInvalidationCount', (
    select count(*)::integer
    from public.audit_events
    where action = 'pilot.field_media_canary_invalidated'
      and entity_id in (
        '${CONSUMED_RUN_ID}'::uuid,
        '${VERIFIED_RUN_ID}'::uuid,
        '${TAMPERED_RUN_ID}'::uuid,
        '${CONTROLLED_QUARANTINE_RUN_ID}'::uuid
      )
  ),
  'legacyInvalidated', exists (
    select 1
    from public.audit_events
    where action = 'pilot.legacy_trusted_proof_invalidated'
      and entity_id = '${LEGACY_EVIDENCE_ID}'
  ),
  'latestLaunchAction', (
    select action
    from public.company_launch_authorization_events
    where company_id = '${COMPANY_ID}'
    order by version desc
    limit 1
  ),
  'proofEligible', exists (
    select 1
    from jsonb_array_elements(
      private.storyops_current_trusted_proofs('${COMPANY_ID}')
    ) proof
    where proof ->> 'auditEventId' in (
      '${PROOF_AUDIT_ID}',
      '${LEGACY_AUDIT_ID}'
    )
  ),
  'launchEffective',
    private.storyops_launch_authorization_effective('${COMPANY_ID}')
);
`;

let workdir;
let startAttempted = false;
let createdLoopbackNetwork = false;
try {
  workdir = await mkdtemp(resolve(REPO_ROOT, '.storyops-canary-upgrade-'));
  const supabaseDirectory = join(workdir, 'supabase');
  const migrationsDirectory = join(supabaseDirectory, 'migrations');
  await mkdir(migrationsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(supabaseDirectory, 'config.toml'), config, {
    mode: 0o600,
    flag: 'wx',
  });

  const sourceMigrations = resolve(REPO_ROOT, 'supabase/migrations');
  for (const fileName of (await readdir(sourceMigrations)).sort()) {
    if (
      !fileName.endsWith('.sql') ||
      fileName.localeCompare('20260728610000_dispatch_current_origin_actor_privacy.sql') > 0
    ) {
      continue;
    }
    await copyFile(join(sourceMigrations, fileName), join(migrationsDirectory, fileName));
  }

  createdLoopbackNetwork = ensureLoopbackNetwork();
  startAttempted = true;
  runSupabase(workdir, ['start', '--ignore-health-check', '--network-id', LOOPBACK_NETWORK]);
  assertLoopbackBindings();
  waitForDatabase();
  runSql(await readFile(resolve(REPO_ROOT, 'supabase/seed.sql'), 'utf8'));
  runSql(fixtureSql);

  const before = queryJson(`
    select jsonb_build_object(
      'proofEligible', exists (
        select 1
        from jsonb_array_elements(
          private.storyops_current_trusted_proofs('${COMPANY_ID}')
        ) proof
        where proof ->> 'auditEventId' = '${PROOF_AUDIT_ID}'
      ),
      'launchAction', (
        select action
        from public.company_launch_authorization_events
        where company_id = '${COMPANY_ID}'
        order by version desc
        limit 1
      )
    )
  `);
  assert.deepEqual(before, {
    proofEligible: true,
    launchAction: 'authorize',
  });

  runSql(
    await readFile(resolve(REPO_ROOT, 'supabase/migrations', basename(CURRENT_MIGRATION)), 'utf8'),
  );

  assert.deepEqual(queryJson(resultSql), {
    consumedStatus: 'consumed',
    verifiedStatus: 'failed',
    tamperedStatus: 'failed',
    controlledQuarantineStatus: 'failed',
    consumedAuthority: 'migration_unverified',
    verifiedAuthority: 'migration_unverified',
    tamperedRegistered: false,
    tamperedQuarantined: true,
    controlledQuarantined: true,
    consumedCrewActive: false,
    verifiedCrewActive: false,
    realCrewActive: true,
    controlledQuarantineCrewActive: false,
    runInvalidationCount: 4,
    legacyInvalidated: true,
    latestLaunchAction: 'system_revoke',
    proofEligible: false,
    launchEffective: false,
  });

  const resolutionCommandId = '96430000-0000-4000-8000-000000000961';
  const reviewReference = 'TEST-CANARY-UPGRADE-OPERATIONAL-CREW';
  runSql(`
    select set_config(
      'request.jwt.claims',
      '{"sub":"${OWNER_ID}","role":"authenticated"}',
      false
    );
    select set_config('request.jwt.claim.sub', '${OWNER_ID}', false);
    select set_config('request.jwt.claim.role', 'authenticated', false);
    select public.resolve_storyops_field_media_canary_quarantine(
      '${COMPANY_ID}',
      '${TAMPERED_RUN_ID}',
      '${resolutionCommandId}',
      'observed_crew_confirmed_operational',
      '${reviewReference}',
      encode(extensions.digest(array_to_string(array[
        'storyops-field-media-canary-quarantine-resolution-v1',
        '${TAMPERED_RUN_ID}',
        'observed_crew_confirmed_operational',
        '${reviewReference}'
      ], chr(31)), 'sha256'), 'hex')
    );
  `);
  assert.deepEqual(
    queryJson(`
      select jsonb_build_object(
        'requiresReview', requires_review,
        'resolutionCode', resolution_code,
        'jobStatus', (
          select status from public.jobs
          where id = observed_job_id
        ),
        'jobCrewRetired', (
          select assigned_crew_id is null from public.jobs
          where id = observed_job_id
        ),
        'visitStatus', (
          select status from public.visits
          where id = observed_visit_id
        ),
        'operationalCrewActive', (
          select active from public.crews
          where id = observed_crew_id
        ),
        'auditRecorded', exists (
          select 1 from public.audit_events
          where action = 'pilot.field_media_canary_quarantine_resolved'
            and entity_id = '${TAMPERED_RUN_ID}'
        ),
        'freshProofStillRequired', not exists (
          select 1
          from jsonb_array_elements(
            private.storyops_current_trusted_proofs('${COMPANY_ID}')
          ) proof
          where proof ->> 'kind' = 'field_media_canary'
        )
      )
      from private.storyops_field_media_canary_registry_quarantine
      where verification_run_id = '${TAMPERED_RUN_ID}'
    `),
    {
      requiresReview: false,
      resolutionCode: 'observed_crew_confirmed_operational',
      jobStatus: 'cancelled',
      jobCrewRetired: true,
      visitStatus: 'cancelled',
      operationalCrewActive: true,
      auditRecorded: true,
      freshProofStillRequired: true,
    },
  );

  runSql(`
    do $storyops$
    begin
      begin
        update public.jobs
        set status = 'in_progress',
          assigned_crew_id = '${REAL_CREW_ID}'
        where id = '96430000-0000-4000-8000-000000000401';
        raise exception 'Retired operational fixture job was reactivated';
      exception
        when insufficient_privilege then
          if sqlerrm <> 'RETIRED_FIELD_MEDIA_CANARY_JOB_IMMUTABLE' then
            raise;
          end if;
      end;
      begin
        update public.visits
        set status = 'on_site'
        where id = '96430000-0000-4000-8000-000000000641';
        raise exception 'Retired operational fixture visit was reactivated';
      exception
        when insufficient_privilege then
          if sqlerrm <> 'RETIRED_FIELD_MEDIA_CANARY_VISIT_IMMUTABLE' then
            raise;
          end if;
      end;
      begin
        insert into public.dispatch_assignments(
          company_id, visit_id, crew_id, assigned_by, starts_at, ends_at,
          status
        )
        values (
          '${COMPANY_ID}',
          '96430000-0000-4000-8000-000000000641',
          '${REAL_CREW_ID}',
          '${OWNER_ID}',
          clock_timestamp(),
          clock_timestamp() + interval '15 minutes',
          'cancelled'
        );
        raise exception 'Retired operational fixture was redispatched';
      exception
        when insufficient_privilege then
          if sqlerrm <> 'RETIRED_FIELD_MEDIA_CANARY_DISPATCH_FORBIDDEN' then
            raise;
          end if;
      end;
      begin
        update public.dispatch_assignments
        set visit_id = '96430000-0000-4000-8000-000000000641',
          status = 'cancelled'
        where id = '10000000-0000-4000-8000-000000000642';
        raise exception 'Existing dispatch was rebound to a retired fixture';
      exception
        when insufficient_privilege then
          if sqlerrm <> 'RETIRED_FIELD_MEDIA_CANARY_DISPATCH_FORBIDDEN' then
            raise;
          end if;
      end;
    end;
    $storyops$;

    update public.crews set active = false where id = '${REAL_CREW_ID}';
    update public.crews set active = true where id = '${REAL_CREW_ID}';
  `);

  const controlledResolutionCommandId = '96440000-0000-4000-8000-000000000961';
  const controlledReviewReference = 'TEST-CANARY-UPGRADE-CONTROLLED-RETIREMENT';
  const retirement = runSession(
    `
      begin;
      select set_config(
        'request.jwt.claims',
        '{"sub":"${OWNER_ID}","role":"authenticated"}',
        true
      );
      select set_config('request.jwt.claim.sub', '${OWNER_ID}', true);
      select set_config('request.jwt.claim.role', 'authenticated', true);
      select public.resolve_storyops_field_media_canary_quarantine(
        '${COMPANY_ID}',
        '${CONTROLLED_QUARANTINE_RUN_ID}',
        '${controlledResolutionCommandId}',
        'controlled_fixture_retired',
        '${controlledReviewReference}',
        encode(extensions.digest(array_to_string(array[
          'storyops-field-media-canary-quarantine-resolution-v1',
          '${CONTROLLED_QUARANTINE_RUN_ID}',
          'controlled_fixture_retired',
          '${controlledReviewReference}'
        ], chr(31)), 'sha256'), 'hex')
      );
      \\echo STORYOPS_CONTROLLED_RETIREMENT_LOCKED
      select pg_sleep(1.2);
      commit;
    `,
    'STORYOPS_CONTROLLED_RETIREMENT_LOCKED',
  );
  await retirement.markerReady;

  const activationAttemptedAt = Date.now();
  const concurrentActivation = runSession(`
    begin;
    do $storyops$
    begin
      begin
        update public.crews
        set active = true
        where id = '${CONTROLLED_QUARANTINE_CREW_ID}';
        raise exception 'Retired controlled fixture crew became active';
      exception
        when insufficient_privilege then
          if sqlerrm <>
            'RETIRED_CONTROLLED_REHEARSAL_CREW_ACTIVATION_FORBIDDEN'
          then
            raise;
          end if;
      end;
    end;
    $storyops$;
    commit;
  `);
  await Promise.all([retirement.completion, concurrentActivation.completion]);
  assert.ok(
    Date.now() - activationAttemptedAt >= 750,
    'Concurrent crew activation did not wait for the retirement row lock.',
  );

  assert.deepEqual(
    queryJson(`
      select jsonb_build_object(
        'requiresReview', quarantine.requires_review,
        'resolutionCode', quarantine.resolution_code,
        'crewInactive', not crew.active,
        'jobStatus', job.status,
        'jobCrewRetired', job.assigned_crew_id is null,
        'visitStatus', visit.status,
        'auditRecorded', exists (
          select 1 from public.audit_events
          where action = 'pilot.field_media_canary_quarantine_resolved'
            and entity_id = '${CONTROLLED_QUARANTINE_RUN_ID}'
        )
      )
      from private.storyops_field_media_canary_registry_quarantine quarantine
      join public.crews crew
        on crew.id = quarantine.observed_crew_id
      join public.jobs job
        on job.id = quarantine.observed_job_id
      join public.visits visit
        on visit.id = quarantine.observed_visit_id
      where quarantine.verification_run_id =
        '${CONTROLLED_QUARANTINE_RUN_ID}'
    `),
    {
      requiresReview: false,
      resolutionCode: 'controlled_fixture_retired',
      crewInactive: true,
      jobStatus: 'cancelled',
      jobCrewRetired: true,
      visitStatus: 'cancelled',
      auditRecorded: true,
    },
  );

  runSql(`
    do $storyops$
    begin
      begin
        update public.jobs
        set status = 'in_progress',
          assigned_crew_id = '${CONTROLLED_QUARANTINE_CREW_ID}'
        where id = '96440000-0000-4000-8000-000000000401';
        raise exception 'Retired controlled fixture job was reactivated';
      exception
        when insufficient_privilege then
          if sqlerrm <> 'RETIRED_FIELD_MEDIA_CANARY_JOB_IMMUTABLE' then
            raise;
          end if;
      end;
      begin
        update public.visits
        set status = 'on_site'
        where id = '96440000-0000-4000-8000-000000000641';
        raise exception 'Retired controlled fixture visit was reactivated';
      exception
        when insufficient_privilege then
          if sqlerrm <> 'RETIRED_FIELD_MEDIA_CANARY_VISIT_IMMUTABLE' then
            raise;
          end if;
      end;
      begin
        insert into public.dispatch_assignments(
          company_id, visit_id, crew_id, assigned_by, starts_at, ends_at,
          status
        )
        values (
          '${COMPANY_ID}',
          '96440000-0000-4000-8000-000000000641',
          '${CONTROLLED_QUARANTINE_CREW_ID}',
          '${OWNER_ID}',
          clock_timestamp(),
          clock_timestamp() + interval '15 minutes',
          'cancelled'
        );
        raise exception 'Retired controlled fixture was redispatched';
      exception
        when insufficient_privilege then
          if sqlerrm <> 'RETIRED_FIELD_MEDIA_CANARY_DISPATCH_FORBIDDEN' then
            raise;
          end if;
      end;
    end;
    $storyops$;
  `);
} finally {
  if (workdir && startAttempted) {
    runSupabase(workdir, ['stop', '--no-backup', '--network-id', LOOPBACK_NETWORK], true);
  }
  if (createdLoopbackNetwork) {
    runDocker(['network', 'rm', LOOPBACK_NETWORK], true);
  }
  if (workdir) await rm(workdir, { recursive: true, force: true });
}

process.stdout.write(
  'Isolated pre-62 field-media proof upgrade invalidated legacy authority, retired both quarantine dispositions, blocked concurrent crew activation and redispatch, and required a fresh canary.\n',
);
