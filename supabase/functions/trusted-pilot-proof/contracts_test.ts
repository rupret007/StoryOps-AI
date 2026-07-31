import {
  canonicalJson,
  signedRestoreProofMaterial,
  trustedVerificationRequestMaterial,
  trustedPilotProofRequestSchema,
} from './contracts.ts';

function assertEquals<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertThrows(callback: () => unknown): void {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error('Expected callback to throw.');
}

Deno.test('trusted proof contracts bind supported provider capabilities', () => {
  const base = {
    operation: 'provider_canary',
    companyId: '11111111-1111-4111-8111-111111111111',
    commandId: '22222222-2222-4222-8222-222222222222',
    requestedAt: '2026-07-30T12:00:00.000Z',
    expiresAt: '2026-08-06T12:00:00.000Z',
    provider: 'stripe',
    capability: 'payments',
  };
  const parsed = trustedPilotProofRequestSchema.parse(base);
  if (parsed.operation !== 'provider_canary') {
    throw new Error('Expected provider_canary request.');
  }
  assertEquals(parsed.capability, 'payments');
  const identityInvitation = trustedPilotProofRequestSchema.parse({
    ...base,
    provider: 'supabase_auth',
    capability: 'identity_invitation',
  });
  if (identityInvitation.operation !== 'provider_canary') {
    throw new Error('Expected identity provider canary request.');
  }
  assertEquals(identityInvitation.capability, 'identity_invitation');
  assertThrows(() =>
    trustedPilotProofRequestSchema.parse({ ...base, capability: 'refund_anything' }),
  );
});

Deno.test(
  'field-media canary separates owner reservation from exact field-worker completion',
  () => {
    const start = trustedPilotProofRequestSchema.parse({
      operation: 'field_media_canary_start',
      companyId: '11111111-1111-4111-8111-111111111111',
      commandId: '22222222-2222-4222-8222-222222222222',
      fieldWorkerUserId: '33333333-3333-4333-8333-333333333333',
      requestedAt: '2026-07-30T12:00:00.000Z',
      expiresAt: '2026-08-29T12:00:00.000Z',
    });
    const complete = trustedPilotProofRequestSchema.parse({
      operation: 'field_media_canary_complete',
      companyId: '11111111-1111-4111-8111-111111111111',
      commandId: '44444444-4444-4444-8444-444444444444',
      verificationRunId: '55555555-5555-4555-8555-555555555555',
      requestedAt: '2026-07-30T12:01:00.000Z',
    });
    assertEquals(start.operation, 'field_media_canary_start');
    assertEquals(complete.operation, 'field_media_canary_complete');
    if (
      trustedVerificationRequestMaterial({
        ...complete,
        commandId: '66666666-6666-4666-8666-666666666666',
      }) === trustedVerificationRequestMaterial(complete)
    ) {
      throw new Error('Field execution idempotency did not bind the full completion request.');
    }
    assertThrows(() =>
      trustedPilotProofRequestSchema.parse({
        ...start,
        fieldWorkerUserId: undefined,
      }),
    );
  },
);

Deno.test('restore proof requires exact isolated committed migration evidence', () => {
  const restoreEvidence = {
    schemaVersion: 'storyops-isolated-restore-evidence-v2',
    restoreCommandId: '33333333-3333-4333-8333-333333333333',
    evidenceReference: 'restore-drill-20260730',
    isolationId: 'isolated-db-20260730',
    status: 'committed',
    isolatedTarget: true,
    sourceManifestSha256: 'a'.repeat(64),
    restoredDatabaseSha256: 'b'.repeat(64),
    verifiedMigrationId: '20260728530000',
    sourceDatabaseSystemIdentifier: '7668118205518053419',
    targetDatabaseSystemIdentifier: '7668408443751252011',
    sourceStorageHost: 'source.example.test',
    targetStorageHost: '127.0.0.1:55321',
    storageVerification: {
      schemaVersion: 'storyops-storage-byte-verification-v1',
      objectCount: 3,
      byteCount: 1_024,
      fingerprintSha256: 'c'.repeat(64),
    },
    completedAt: '2026-07-30T12:00:00.000Z',
  };
  const parsed = trustedPilotProofRequestSchema.parse({
    operation: 'backup_restore',
    companyId: '11111111-1111-4111-8111-111111111111',
    commandId: '22222222-2222-4222-8222-222222222222',
    requestedAt: restoreEvidence.completedAt,
    expiresAt: '2026-08-29T12:00:00.000Z',
    restoreEvidence,
  });
  assertEquals(parsed.operation, 'backup_restore');
  assertEquals(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assertThrows(() =>
    trustedPilotProofRequestSchema.parse({
      ...parsed,
      restoreEvidence: { ...restoreEvidence, isolatedTarget: false },
    }),
  );
  assertThrows(() =>
    trustedPilotProofRequestSchema.parse({
      ...parsed,
      restoreEvidence: {
        ...restoreEvidence,
        targetStorageHost: restoreEvidence.sourceStorageHost,
      },
    }),
  );
  assertThrows(() =>
    trustedPilotProofRequestSchema.parse({
      ...parsed,
      restoreEvidence: {
        ...restoreEvidence,
        targetDatabaseSystemIdentifier: restoreEvidence.sourceDatabaseSystemIdentifier,
      },
    }),
  );
  assertThrows(() =>
    trustedPilotProofRequestSchema.parse({
      ...parsed,
      restoreEvidence: { ...restoreEvidence, storageVerification: undefined },
    }),
  );
  assertThrows(() =>
    trustedPilotProofRequestSchema.parse({
      ...parsed,
      restoreEvidence: {
        ...restoreEvidence,
        storageVerification: {
          ...restoreEvidence.storageVerification,
          objectCount: 0,
          byteCount: 0,
        },
      },
    }),
  );
  if (parsed.operation !== 'backup_restore') {
    throw new Error('Expected backup_restore request.');
  }
  const signed = signedRestoreProofMaterial(parsed);
  for (const changed of [
    { ...parsed, companyId: '44444444-4444-4444-8444-444444444444' },
    { ...parsed, commandId: '55555555-5555-4555-8555-555555555555' },
    { ...parsed, requestedAt: '2026-07-30T12:00:01.000Z' },
    { ...parsed, expiresAt: '2026-08-28T12:00:00.000Z' },
  ]) {
    if (signedRestoreProofMaterial(changed) === signed) {
      throw new Error('Signed restore material did not bind every request field.');
    }
  }
});
