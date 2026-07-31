import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const CREW_ID = '96200000-0000-4000-8000-000000000001';
const RUN_ID = '96200000-0000-4000-8000-000000000002';
const CUSTOMER_ID = '96200000-0000-4000-8000-000000000003';
const JOB_ID = '96200000-0000-4000-8000-000000000004';
const VISIT_ID = '96200000-0000-4000-8000-000000000005';

const dockerPsql = [
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
];

function runSql(sql) {
  execFileSync('docker', dockerPsql, {
    input: sql,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

function queryBoolean(sql) {
  return (
    execFileSync(
      'docker',
      [
        'exec',
        'supabase_db_storyops-ai',
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
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim() === 't'
  );
}

function runSession(sql, marker = undefined) {
  const child = spawn('docker', dockerPsql, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let resolveMarker;
  let rejectMarker;
  const markerReady = new Promise((resolve, reject) => {
    resolveMarker = resolve;
    rejectMarker = reject;
  });
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      const error = new Error(
        `Field-media canary concurrency session timed out.\n${stdout}\n${stderr}`,
      );
      rejectMarker(error);
      reject(error);
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (marker && stdout.includes(marker)) resolveMarker();
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
      if (!marker) resolveMarker();
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(
          `Field-media canary concurrent psql exited ${code}.\n${stdout}\n${stderr}`,
        );
        rejectMarker(error);
        reject(error);
      }
    });
    child.stdin.end(sql);
  });
  return { markerReady, completion };
}

const cleanupSql = `
delete from private.storyops_field_media_canary_crews
where verification_run_id = '${RUN_ID}';
delete from public.crews where id = '${CREW_ID}';
`;

try {
  runSql(cleanupSql);
  runSql(`
    insert into public.crews(
      id, company_id, name, active, skill_codes, home_base_postal_code
    )
    values (
      '${CREW_ID}',
      '${COMPANY_ID}',
      'Concurrency-controlled rehearsal crew',
      false,
      '{}',
      '00000'
    );
    insert into private.storyops_field_media_canary_crews(
      verification_run_id, company_id, crew_id, customer_id, job_id, visit_id,
      capture_authority
    )
    values (
      '${RUN_ID}',
      '${COMPANY_ID}',
      '${CREW_ID}',
      '${CUSTOMER_ID}',
      '${JOB_ID}',
      '${VISIT_ID}',
      'runtime_transition'
    );
  `);

  const holder = runSession(
    `
      begin;
      select id
      from public.crews
      where id = '${CREW_ID}'
      for update;
      \\echo STORYOPS_CANARY_CREW_LOCKED
      select pg_sleep(1.2);
      commit;
    `,
    'STORYOPS_CANARY_CREW_LOCKED',
  );
  await holder.markerReady;

  const attemptedAt = Date.now();
  const activator = runSession(`
    begin;
    do $$
    begin
      begin
        update public.crews
        set active = true
        where id = '${CREW_ID}';
        raise exception
          'Concurrent controlled rehearsal activation unexpectedly succeeded';
      exception
        when insufficient_privilege then
          if sqlerrm <> 'CONTROLLED_REHEARSAL_CREW_ACTIVATION_FORBIDDEN' then
            raise;
          end if;
      end;
    end;
    $$;
    commit;
  `);

  await Promise.all([holder.completion, activator.completion]);
  assert.ok(
    Date.now() - attemptedAt >= 750,
    'The competing activation did not wait for the crew row lock.',
  );
  assert.equal(
    queryBoolean(`
      select not active
      from public.crews
      where id = '${CREW_ID}'
    `),
    true,
    'The controlled rehearsal crew became active after the lock released.',
  );
} finally {
  runSql(cleanupSql);
}

process.stdout.write(
  'Two-session controlled-rehearsal crew activation remained blocked after the adapter-equivalent row lock released.\n',
);
