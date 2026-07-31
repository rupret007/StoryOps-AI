import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const OWNER_ID = '10000000-0000-4000-8000-000000000101';
const LEAD_ID = '10000000-0000-4000-8000-000000000221';
const ORIGINAL_NOTE = 'Active-company concurrency baseline.';

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

function queryJson(sql) {
  const output = execFileSync(
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
  ).trim();
  return JSON.parse(output);
}

function runSession(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', dockerPsql, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Active-company concurrent session timed out.\n${stderr}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Concurrent psql session exited ${code}.\n${stdout}\n${stderr}`));
    });
    child.stdin.end(sql);
  });
}

const authenticatedClaims = `
select set_config(
  'request.jwt.claims',
  '{"sub":"${OWNER_ID}","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.sub', '${OWNER_ID}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
`;

const resetSql = `
update public.companies set status = 'active' where id = '${COMPANY_ID}';
update public.leads
set qualification_summary = '${ORIGINAL_NOTE}'
where id = '${LEAD_ID}';
`;

try {
  runSql(resetSql);

  const mutationFirst = runSession(`
    begin;
    ${authenticatedClaims}
    update public.leads
    set qualification_summary = 'Mutation committed before pause.'
    where id = '${LEAD_ID}';
    select pg_sleep(1.2);
    commit;
  `);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const pauseSecond = runSession(`
    begin;
    update public.companies set status = 'paused' where id = '${COMPANY_ID}';
    commit;
  `);
  await Promise.all([mutationFirst, pauseSecond]);

  assert.deepEqual(
    queryJson(`
      select jsonb_build_object(
        'companyStatus', company.status,
        'leadNote', lead.qualification_summary
      )
      from public.companies company
      join public.leads lead on lead.company_id = company.id
      where company.id = '${COMPANY_ID}' and lead.id = '${LEAD_ID}'
    `),
    {
      companyStatus: 'paused',
      leadNote: 'Mutation committed before pause.',
    },
    'A pause overtook an already locked authenticated mutation.',
  );

  runSql(resetSql);
  const pauseFirst = runSession(`
    begin;
    update public.companies set status = 'paused' where id = '${COMPANY_ID}';
    select pg_sleep(1.2);
    commit;
  `);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const mutationSecond = runSession(`
    begin;
    ${authenticatedClaims}
    do $$
    begin
      begin
        update public.leads
        set qualification_summary = 'Mutation must not commit after pause.'
        where id = '${LEAD_ID}';
        raise exception 'Concurrent mutation unexpectedly succeeded after pause won';
      exception
        when insufficient_privilege then
          if sqlerrm <> 'STORYOPS_COMPANY_NOT_ACTIVE' then
            raise;
          end if;
      end;
    end;
    $$;
    commit;
  `);
  await Promise.all([pauseFirst, mutationSecond]);

  assert.deepEqual(
    queryJson(`
      select jsonb_build_object(
        'companyStatus', company.status,
        'leadNote', lead.qualification_summary
      )
      from public.companies company
      join public.leads lead on lead.company_id = company.id
      where company.id = '${COMPANY_ID}' and lead.id = '${LEAD_ID}'
    `),
    {
      companyStatus: 'paused',
      leadNote: ORIGINAL_NOTE,
    },
    'An authenticated mutation committed after the pause committed.',
  );
} finally {
  runSql(resetSql);
}

process.stdout.write(
  'Two-session active-company lock ordering prevented any authenticated mutation from committing after pause.\n',
);
