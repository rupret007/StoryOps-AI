import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { supabaseCommand } from '../../infra/scripts/common.mjs';

const companyId = '10000000-0000-4000-8000-000000000001';
const ownerId = '10000000-0000-4000-8000-000000000101';
const jobId = '10000000-0000-4000-8000-000000000631';
const crewId = '10000000-0000-4000-8000-000000000601';
const configurationId = '91900000-0000-4000-8000-000000000011';
const baselineId = '91900000-0000-4000-8000-000000000012';
const commandId = '91900000-0000-4000-8000-000000000013';
const equipmentIds = [
  '91900000-0000-4000-8000-000000000021',
  '91900000-0000-4000-8000-000000000022',
  '91900000-0000-4000-8000-000000000023',
];

function localSupabaseEnvironment() {
  const cli = supabaseCommand();
  const output = execFileSync(cli.command, [...cli.prefix, 'status', '-o', 'env'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const values = Object.fromEntries(
    output
      .split(/\r?\n/u)
      .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/u))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
  const url = values.API_URL;
  const anonKey = values.ANON_KEY ?? values.PUBLISHABLE_KEY;
  assert.ok(url && anonKey, 'Local Supabase API URL and public key are required.');
  return { url, anonKey };
}

function runSql(sql) {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'supabase_db_storyops-ai',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { input: sql, stdio: ['pipe', 'ignore', 'pipe'] },
  );
}

function querySql(sql) {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'supabase_db_storyops-ai',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-At',
    ],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

async function errorPayload(error) {
  try {
    return await error?.context?.clone().json();
  } catch {
    return undefined;
  }
}

const { url, anonKey } = localSupabaseEnvironment();
const ownerClient = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const technicianClient = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const jobVersion = Number(querySql(`select version from public.jobs where id = '${jobId}'::uuid;`));
assert.ok(
  Number.isInteger(jobVersion) && jobVersion > 0,
  'The scheduling job version is required.',
);

let fixtureCreated = false;
try {
  runSql(`
    begin;
    insert into public.company_configuration_versions(
      id, company_id, revision, schema_version, status, publication_mode,
      configuration, configuration_hash, review_reference, created_by,
      published_by, published_at
    )
    values (
      '${configurationId}', '${companyId}', 919,
      'storyops-company-config-v1', 'published', 'live',
      jsonb_build_object(
        'schemaVersion', 'storyops-company-config-v1',
        'testFixture', 'scheduling-suggestions-edge-v1',
        'territory', jsonb_build_object(
          'travelZones', jsonb_build_array(jsonb_build_object(
            'code', 'DFW-CORE',
            'name', 'Reviewed local canary zone',
            'maximumMiles', '',
            'fee', '0.00',
            'postalCodes', jsonb_build_array('75219')
          )),
          'travelZoneMappingReview', jsonb_build_object(
            'status', 'approved',
            'reviewer', 'Scheduling suggestion canary',
            'reviewedAt', '2026-07-30T00:00:00.000Z',
            'evidenceReference', 'TEST-SCHEDULING-SUGGESTION-TRAVEL'
          )
        ),
        'schedule', jsonb_build_object(
          'businessHours', jsonb_build_array(
            jsonb_build_object('day','monday','closed',false,'opensAt','08:00','closesAt','17:00'),
            jsonb_build_object('day','tuesday','closed',false,'opensAt','08:00','closesAt','17:00'),
            jsonb_build_object('day','wednesday','closed',false,'opensAt','08:00','closesAt','17:00'),
            jsonb_build_object('day','thursday','closed',false,'opensAt','08:00','closesAt','17:00'),
            jsonb_build_object('day','friday','closed',false,'opensAt','08:00','closesAt','17:00'),
            jsonb_build_object('day','saturday','closed',false,'opensAt','09:00','closesAt','14:00'),
            jsonb_build_object('day','sunday','closed',true,'opensAt','09:00','closesAt','14:00')
          ),
          'appointmentBufferMinutes', 30,
          'minimumLeadTimeHours', 2,
          'maximumBookingDays', 10
        )
      ),
      repeat('9', 64), 'TEST-SCHEDULING-SUGGESTIONS-EDGE',
      '${ownerId}', '${ownerId}', now()
    );
    insert into public.company_operating_baseline_publications(
      id, company_id, configuration_version_id, configuration_revision,
      configuration_hash, price_book_id, service_terms_id, retention_policy_id,
      baseline_hash, status, review_reference, activated_by, command_id, request_hash
    )
    values (
      '${baselineId}', '${companyId}', '${configurationId}', 919, repeat('9', 64),
      '10000000-0000-4000-8000-000000000401',
      '10000000-0000-4000-8000-000000000152',
      '10000000-0000-4000-8000-000000000151',
      repeat('8', 64), 'active', 'TEST-SCHEDULING-SUGGESTIONS-EDGE',
      '${ownerId}', '${commandId}', repeat('7', 64)
    );
    insert into public.equipment(
      id, company_id, asset_tag, name, equipment_type, status, assigned_crew_id,
      next_inspection_due
    )
    values
      ('${equipmentIds[0]}', '${companyId}', 'SUG-CANARY-PW', 'Suggestion pressure washer',
       'pressure-washer', 'assigned', '${crewId}', current_date + 90),
      ('${equipmentIds[1]}', '${companyId}', 'SUG-CANARY-SC', 'Suggestion surface cleaner',
       'surface-cleaner', 'assigned', '${crewId}', current_date + 90),
      ('${equipmentIds[2]}', '${companyId}', 'SUG-CANARY-LD', 'Suggestion ladder',
       'ladder', 'assigned', '${crewId}', current_date + 90);
    commit;
  `);
  fixtureCreated = true;

  const { error: ownerAuthError } = await ownerClient.auth.signInWithPassword({
    email: 'owner@storyops.local',
    password: 'WashOpsDemo1!',
  });
  assert.equal(ownerAuthError, null, ownerAuthError?.message);

  const { data: suggestions, error: suggestionsError } = await ownerClient.functions.invoke(
    'scheduling-suggestions',
    {
      body: { companyId, jobId, expectedJobVersion: jobVersion, crewId },
    },
  );
  assert.equal(suggestionsError, null, JSON.stringify(await errorPayload(suggestionsError)));
  assert.equal(suggestions.schemaVersion, 'storyops-scheduling-suggestions-v1');
  assert.equal(suggestions.status, 'suggestions_ready');
  assert.equal(suggestions.bookable, false);
  assert.equal(suggestions.companyId, companyId);
  assert.equal(suggestions.jobId, jobId);
  assert.equal(suggestions.jobVersion, jobVersion);
  assert.ok(suggestions.candidates.length > 0 && suggestions.candidates.length <= 5);
  assert.ok(suggestions.scannedWindowCount >= suggestions.candidates.length);
  suggestions.candidates.forEach((candidate, index) => {
    assert.equal(candidate.rank, index + 1);
    assert.equal(candidate.crewId, crewId);
    assert.deepEqual(candidate.liveValidation, {
      providerCalendar: 'unknown',
      route: 'unknown',
      weather: 'unknown',
    });
    assert.deepEqual(candidate.internalEvidence, {
      businessHours: 'eligible',
      leadTime: 'eligible',
      crew: 'eligible',
      equipment: 'eligible',
      visitCapacity: 'eligible',
    });
  });
  assert.ok(suggestions.unknowns.some((unknown) => unknown.includes('Google Calendar')));
  assert.ok(suggestions.unknowns.some((unknown) => unknown.includes('VROOM')));
  assert.ok(suggestions.unknowns.some((unknown) => unknown.includes('NWS')));

  const stale = await ownerClient.functions.invoke('scheduling-suggestions', {
    body: { companyId, jobId, expectedJobVersion: jobVersion + 100, crewId },
  });
  assert.ok(stale.error, 'A stale job version unexpectedly returned suggestions.');
  assert.equal((await errorPayload(stale.error))?.code, 'JOB_VERSION_OR_STATUS_CONFLICT');

  const { error: technicianAuthError } = await technicianClient.auth.signInWithPassword({
    email: 'technician@storyops.local',
    password: 'WashOpsDemo1!',
  });
  assert.equal(technicianAuthError, null, technicianAuthError?.message);
  const forbidden = await technicianClient.functions.invoke('scheduling-suggestions', {
    body: { companyId, jobId, expectedJobVersion: jobVersion, crewId },
  });
  assert.ok(forbidden.error, 'A technician unexpectedly received capacity suggestions.');
  assert.equal((await errorPayload(forbidden.error))?.code, 'ROLE_FORBIDDEN');

  process.stdout.write(
    'Scheduling suggestions Edge canary passed: ranked internal capacity, explicit provider unknowns, stale-version denial, and technician denial.\n',
  );
} finally {
  if (fixtureCreated) {
    runSql(`
      begin;
      delete from public.operation_budget_windows
      where company_id = '${companyId}'::uuid
        and scope = 'scheduling-suggestions:user:hour';
      delete from public.equipment
      where id = any(array[${equipmentIds.map((id) => `'${id}'::uuid`).join(',')}]);
      -- Local contract fixture cleanup only. The transaction-local replica mode
      -- bypasses immutable-history triggers for these exact canary IDs and is
      -- never part of an application or production recovery path.
      set local session_replication_role = replica;
      delete from public.company_operating_baseline_publications
      where id = '${baselineId}'::uuid;
      delete from public.company_configuration_versions
      where id = '${configurationId}'::uuid;
      commit;
    `);
  }
}
