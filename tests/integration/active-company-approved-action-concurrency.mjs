import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const OWNER_ID = '10000000-0000-4000-8000-000000000101';
const APPROVAL_ID = '35000000-0000-4000-8000-000000000101';
const EXECUTION_ID = '35000000-0000-4000-8000-000000000102';
const EXECUTION_TOKEN = '35000000-0000-4000-8000-000000000103';

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
      reject(new Error(`Approved-action concurrent session timed out.\n${stderr}`));
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

const serviceClaims = `
select set_config(
  'request.jwt.claims',
  '{"sub":"${OWNER_ID}","role":"service_role"}',
  true
);
`;

const executionInsert = `
insert into public.approved_action_executions(
  id,
  company_id,
  approval_request_id,
  request_key,
  request_hash,
  payload_hash,
  provider_idempotency_key,
  tool_name,
  risk_level,
  status,
  execution_token,
  lease_expires_at
)
values (
  '${EXECUTION_ID}',
  '${COMPANY_ID}',
  '${APPROVAL_ID}',
  'active-company-concurrency-action',
  repeat('a', 64),
  repeat('b', 64),
  'storyops-approved-active-company-concurrency-boundary',
  'payments.refund',
  'high',
  'in_progress',
  '${EXECUTION_TOKEN}',
  now() + interval '2 minutes'
);
`;

const resetSql = `
select set_config('request.jwt.claims', '{}', false);
delete from public.approved_action_executions where id = '${EXECUTION_ID}';
update public.companies set status = 'active' where id = '${COMPANY_ID}';
`;

try {
  runSql(`
    ${resetSql}
    delete from public.approval_requests where id = '${APPROVAL_ID}';
    insert into public.approval_requests(
      id,
      company_id,
      reason,
      risk_level,
      status,
      requested_by_type,
      requested_by_id,
      entity_type,
      action_type,
      action_payload,
      summary,
      policy_version,
      decided_by,
      decided_at
    )
    values (
      '${APPROVAL_ID}',
      '${COMPANY_ID}',
      'refund',
      'high',
      'approved',
      'agent',
      'finance',
      'payment',
      'payments.refund',
      '{}'::jsonb,
      'Concurrency-only approved action fixture',
      'storyops-policy-v1.0.0',
      '${OWNER_ID}',
      now()
    );
  `);

  const actionFirst = runSession(`
    begin;
    ${serviceClaims}
    ${executionInsert}
    select pg_sleep(1.2);
    commit;
  `);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const pauseSecond = runSession(`
    begin;
    update public.companies set status = 'paused' where id = '${COMPANY_ID}';
    commit;
  `);
  await Promise.all([actionFirst, pauseSecond]);

  assert.deepEqual(
    queryJson(`
      select jsonb_build_object(
        'companyStatus', company.status,
        'executionCount', (
          select count(*)
          from public.approved_action_executions execution
          where execution.id = '${EXECUTION_ID}'
        )
      )
      from public.companies company
      where company.id = '${COMPANY_ID}'
    `),
    {
      companyStatus: 'paused',
      executionCount: 1,
    },
    'A pause overtook an approved action that had already acquired the company lock.',
  );

  runSql(resetSql);
  const pauseFirst = runSession(`
    begin;
    update public.companies set status = 'paused' where id = '${COMPANY_ID}';
    select pg_sleep(1.2);
    commit;
  `);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const actionSecond = runSession(`
    begin;
    ${serviceClaims}
    do $$
    begin
      begin
        ${executionInsert}
        raise exception 'Approved action unexpectedly reserved after pause won';
      exception
        when insufficient_privilege then
          if sqlerrm <> 'STORYOPS_COMPANY_NOT_ACTIVE' then
            raise;
          end if;
        when others then
          if sqlerrm <> 'APPROVED_ACTION_OWNER_REQUIRED' then
            raise;
          end if;
      end;
    end;
    $$;
    commit;
  `);
  await Promise.all([pauseFirst, actionSecond]);

  assert.deepEqual(
    queryJson(`
      select jsonb_build_object(
        'companyStatus', company.status,
        'executionCount', (
          select count(*)
          from public.approved_action_executions execution
          where execution.id = '${EXECUTION_ID}'
        )
      )
      from public.companies company
      where company.id = '${COMPANY_ID}'
    `),
    {
      companyStatus: 'paused',
      executionCount: 0,
    },
    'An approved provider-action lease was created after the pause committed.',
  );
} finally {
  runSql(`
    ${resetSql}
    delete from public.approval_requests where id = '${APPROVAL_ID}';
  `);
}

process.stdout.write(
  'Two-session company locking prevented approved provider work from starting after pause.\n',
);
