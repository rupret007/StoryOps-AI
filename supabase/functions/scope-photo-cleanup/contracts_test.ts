import {
  inspectPrivateWorkerConfiguration,
  PRIVATE_WORKER_TOKEN_MINIMUM_BYTES,
} from '../_shared/private-worker.ts';
import { scopePhotoCleanupRequestSchema, scopePhotoCleanupResponseSchema } from './contracts.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}

const serviceRoleKey = 'storyops-local-service-role-key-that-is-independent';
const workerToken = 'storyops-local-scope-photo-cleanup-token-v2-4f19';
const settings = {
  label: 'scope-photo cleanup worker',
  tokenName: 'SCOPE_PHOTO_CLEANUP_TOKEN',
  modeName: 'SCOPE_PHOTO_CLEANUP_MODE',
  peerTokenNames: [
    'POST_SERVICE_WORKER_TOKEN',
    'TRANSACTIONAL_OUTBOUND_WORKER_TOKEN',
    'SCHEDULING_RECONCILIATION_TOKEN',
  ],
} as const;

Deno.test('scope-photo cleanup requires an explicit bounded trigger', () => {
  assertEquals(scopePhotoCleanupRequestSchema.safeParse({}).success, false);
  assertEquals(
    scopePhotoCleanupRequestSchema.safeParse({
      companyId: '10000000-0000-4000-8000-000000000001',
      trigger: 'scheduled',
      limit: 50,
    }).success,
    true,
  );
  assertEquals(
    scopePhotoCleanupRequestSchema.safeParse({
      trigger: 'scheduled',
      limit: 50,
    }).success,
    false,
  );
  assertEquals(
    scopePhotoCleanupRequestSchema.safeParse({
      companyId: '10000000-0000-4000-8000-000000000001',
      trigger: 'manual',
      limit: 200,
    }).success,
    true,
  );
  assertEquals(
    scopePhotoCleanupRequestSchema.safeParse({
      companyId: '10000000-0000-4000-8000-000000000001',
      trigger: 'manual',
      limit: 201,
    }).success,
    false,
  );
});

Deno.test('scope-photo cleanup credential is independent and at least 32 bytes', () => {
  assert(new TextEncoder().encode(workerToken).byteLength >= PRIVATE_WORKER_TOKEN_MINIMUM_BYTES);
  const base = {
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    SCOPE_PHOTO_CLEANUP_MODE: 'scheduled',
    POST_SERVICE_WORKER_TOKEN: 'storyops-independent-post-service-token-v2',
    TRANSACTIONAL_OUTBOUND_WORKER_TOKEN: 'storyops-independent-transactional-token-v2',
    SCHEDULING_RECONCILIATION_TOKEN: 'storyops-independent-scheduling-token-v2',
  };
  assertEquals(
    inspectPrivateWorkerConfiguration(
      { ...base, SCOPE_PHOTO_CLEANUP_TOKEN: workerToken },
      settings,
    ),
    {
      activationMode: 'scheduled',
      credentialStatus: 'valid',
      readiness: 'ready',
      acceptedTrigger: 'scheduled',
    },
  );
  for (const [token, expected] of [
    ['short', 'too_short'],
    [` ${workerToken}`, 'surrounding_whitespace'],
    [serviceRoleKey, 'service_role_reuse'],
    [base.POST_SERVICE_WORKER_TOKEN, 'peer_worker_reuse'],
    [base.TRANSACTIONAL_OUTBOUND_WORKER_TOKEN, 'peer_worker_reuse'],
    [base.SCHEDULING_RECONCILIATION_TOKEN, 'peer_worker_reuse'],
  ] as const) {
    assertEquals(
      inspectPrivateWorkerConfiguration({ ...base, SCOPE_PHOTO_CLEANUP_TOKEN: token }, settings)
        .credentialStatus,
      expected,
    );
  }
});

Deno.test('scope-photo cleanup response cannot fake successful counts', () => {
  const base = {
    schemaVersion: 'storyops-scope-photo-cleanup-run-v2',
    activationMode: 'manual',
    trigger: 'manual',
    status: 'processed',
    claimed: 2,
    cleaned: 1,
    failed: 1,
    empty: false,
    checkedAt: '2026-07-30T12:00:00.000Z',
  } as const;
  assertEquals(scopePhotoCleanupResponseSchema.safeParse(base).success, true);
  assertEquals(
    scopePhotoCleanupResponseSchema.safeParse({
      ...base,
      cleaned: 2,
      failed: 1,
    }).success,
    false,
  );
  assertEquals(
    scopePhotoCleanupResponseSchema.safeParse({
      ...base,
      claimed: 0,
      cleaned: 0,
      failed: 0,
      empty: false,
    }).success,
    false,
  );
});
