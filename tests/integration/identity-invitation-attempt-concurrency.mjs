import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const OWNER_ID = '10000000-0000-4000-8000-000000000101';
const COMMAND_A = '63000000-0000-4000-8000-000000000101';
const COMMAND_B = '63000000-0000-4000-8000-000000000102';
const EMAIL = 'attempt-concurrency@example.test';

const dockerPsql = [
  'exec',
  '-i',
  'supabase_db_storyops-ai',
  'psql',
  '-qAt',
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
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-c',
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
      reject(new Error(`Identity invitation authority session timed out.\n${stderr}`));
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
      if (code !== 0) {
        reject(
          new Error(`Identity invitation authority session exited ${code}.\n${stdout}\n${stderr}`),
        );
        return;
      }
      const jsonLine = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.startsWith('{'));
      if (!jsonLine) {
        reject(new Error(`Identity invitation authority returned no receipt.\n${stdout}`));
        return;
      }
      resolve(JSON.parse(jsonLine));
    });
    child.stdin.end(sql);
  });
}

function request(commandId, role) {
  const canonicalRequest = JSON.stringify({
    schemaVersion: 'storyops-identity-provisioning-request-v1',
    companyId: COMPANY_ID,
    commandId,
    action: 'invite',
    email: EMAIL,
    role,
    customerId: null,
  });
  return {
    canonicalRequest,
    requestHash: createHash('sha256').update(canonicalRequest).digest('hex'),
    role,
  };
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const requestA = request(COMMAND_A, 'technician');
const requestB = request(COMMAND_B, 'dispatcher');
const serviceClaims = `
do $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end;
$$;
`;

function beginCommandSql(commandId, requestValue) {
  return `
select public.begin_storyops_identity_provisioning(
  '${COMPANY_ID}',
  '${OWNER_ID}',
  '${commandId}',
  'invite',
  '${EMAIL}',
  '${requestValue.role}',
  null,
  ${sqlLiteral(requestValue.canonicalRequest)},
  '${requestValue.requestHash}'
);
`;
}

function claimSessionSql(commandId, requestValue, holdLock) {
  return `
begin;
${serviceClaims}
select private.claim_storyops_identity_invitation_attempt(
  '${COMPANY_ID}',
  '${OWNER_ID}',
  '${commandId}',
  '${requestValue.requestHash}'
);
${holdLock ? 'select pg_sleep(1.2);' : ''}
commit;
`;
}

const cleanupSql = `
delete from public.identity_invitation_attempts attempt
where attempt.company_id = '${COMPANY_ID}'
  and attempt.provider_command_id in ('${COMMAND_A}', '${COMMAND_B}');
delete from public.identity_provisioning_commands command
where command.company_id = '${COMPANY_ID}'
  and command.command_id in ('${COMMAND_A}', '${COMMAND_B}');
`;

try {
  runSql(cleanupSql);
  runSql(`
    begin;
    ${serviceClaims}
    ${beginCommandSql(COMMAND_A, requestA)}
    ${beginCommandSql(COMMAND_B, requestB)}
    commit;
  `);

  const first = runSession(claimSessionSql(COMMAND_A, requestA, true));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = runSession(claimSessionSql(COMMAND_B, requestB, false));
  const claims = await Promise.all([first, second]);

  const providerInvocationClaims = claims.filter(
    (claim) => claim.attemptAlreadyAuthorized === false,
  );
  const blockedClaims = claims.filter((claim) => claim.attemptAlreadyAuthorized === true);
  assert.equal(
    providerInvocationClaims.length,
    1,
    'Two command IDs obtained permission to invoke the identity provider.',
  );
  assert.equal(blockedClaims.length, 1, 'The losing command did not observe existing authority.');

  const blocked = blockedClaims[0];
  const blockedRequest = blocked.commandId === COMMAND_A ? requestA : requestB;
  runSql(`
    begin;
    ${serviceClaims}
    select public.record_storyops_identity_invite_blocked(
      '${COMPANY_ID}',
      '${OWNER_ID}',
      '${blocked.commandId}',
      '${blockedRequest.requestHash}'
    );
    commit;
  `);

  assert.deepEqual(
    queryJson(`
      select jsonb_build_object(
        'attemptCount', (
          select count(*)
          from public.identity_invitation_attempts attempt
          where attempt.company_id = '${COMPANY_ID}'
            and attempt.normalized_email = '${EMAIL}'
            and attempt.status = 'pending'
        ),
        'linkedCommandCount', (
          select count(*)
          from public.identity_provisioning_commands command
          where command.company_id = '${COMPANY_ID}'
            and command.command_id in ('${COMMAND_A}', '${COMMAND_B}')
            and command.invitation_attempt_id is not null
        ),
        'distinctAuthorityCount', (
          select count(distinct command.invitation_attempt_id)
          from public.identity_provisioning_commands command
          where command.company_id = '${COMPANY_ID}'
            and command.command_id in ('${COMMAND_A}', '${COMMAND_B}')
        ),
        'blockedUnknownCount', (
          select count(*)
          from public.identity_provisioning_commands command
          where command.company_id = '${COMPANY_ID}'
            and command.command_id in ('${COMMAND_A}', '${COMMAND_B}')
            and command.status = 'completed'
            and command.response ->> 'deliveryStatus' = 'provider_submission_unknown'
        ),
        'targetMutationCount', (
          select count(*)
          from public.identity_provisioning_targets target
          where target.company_id = '${COMPANY_ID}'
            and target.normalized_email = '${EMAIL}'
        )
      )
    `),
    {
      attemptCount: 1,
      linkedCommandCount: 2,
      distinctAuthorityCount: 1,
      blockedUnknownCount: 1,
      targetMutationCount: 0,
    },
  );
} finally {
  runSql(cleanupSql);
}

process.stdout.write(
  'Two cross-role invitation commands crossed the email barrier with exactly one provider invocation claim.\n',
);
