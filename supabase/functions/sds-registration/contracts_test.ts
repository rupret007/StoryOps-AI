import { verifySdsUploadBytes } from './contracts.ts';

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) return;
    throw error;
  }
  throw new Error(`Expected rejection containing ${expectedMessage}.`);
}

const expected = {
  schemaVersion: 'storyops-sds-upload-verification-v1' as const,
  companyId: '10000000-0000-4000-8000-000000000001',
  actorUserId: '10000000-0000-4000-8000-000000000101',
  commandId: '42000000-0000-4000-8000-000000000001',
  requestHash: 'a'.repeat(64),
  registrationRequestId: '42000000-0000-4000-8000-000000000002',
  objectPath:
    '10000000-0000-4000-8000-000000000001/materials/soft-wash-mix/sds/v1-' +
    `${'b'.repeat(64)}.pdf`,
  contentType: 'application/pdf' as const,
  byteSize: 9,
  checksumSha256: '3c87d37f1dbea6909f917ce437c390fb8e655a774387d9e69301c0b2283d5b63',
  expiresAt: '2026-07-29T18:00:00.000Z',
};

Deno.test('trusted SDS verifier accepts only the exact private bytes', async () => {
  assertEquals(
    await verifySdsUploadBytes(new Blob(['%PDF-test'], { type: 'application/pdf' }), expected),
    expected.checksumSha256,
  );
});

Deno.test('trusted SDS verifier rejects wrong bytes even when size and MIME match', async () => {
  await assertRejects(
    () => verifySdsUploadBytes(new Blob(['%PDF-tesu'], { type: 'application/pdf' }), expected),
    'STORYOPS_SDS_BYTES_MISMATCH',
  );
});

Deno.test(
  'trusted SDS verifier rejects non-PDF bytes with matching size and declared MIME',
  async () => {
    await assertRejects(
      () =>
        verifySdsUploadBytes(new Blob(['NOTP-test'], { type: 'application/pdf' }), {
          ...expected,
          checksumSha256: 'de5490d9df4757a63e1a3618def1f5467bfd2629201fbaafb1f6bed303ff3f9b',
        }),
      'STORYOPS_SDS_PDF_SIGNATURE_MISMATCH',
    );
  },
);
