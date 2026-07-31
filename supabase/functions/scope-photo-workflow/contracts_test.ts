import { scopePhotoWorkflowRequestSchema, verifyScopePhotoBytes } from './contracts.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
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

const companyId = '10000000-0000-4000-8000-000000000001';
const requestId = '10000000-0000-4000-8000-000000000801';
const assetId = '10000000-0000-4000-8000-000000000802';
const commandId = '10000000-0000-4000-8000-000000000803';

Deno.test('scope photo upload metadata is finite and rejects caller-owned paths', () => {
  const valid = {
    operation: 'prepare_upload',
    companyId,
    requestId,
    checklistItemCode: 'front_elevation',
    assetId,
    contentType: 'image/png',
    byteSize: 68,
    checksumSha256: '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460',
    capturedAt: '2026-07-29T12:00:00.000Z',
    idempotencyKey: commandId,
  };
  assert(scopePhotoWorkflowRequestSchema.safeParse(valid).success);
  assert(
    !scopePhotoWorkflowRequestSchema.safeParse({
      ...valid,
      objectPath: `${companyId}/other-company/injected.png`,
    }).success,
  );
  assert(
    !scopePhotoWorkflowRequestSchema.safeParse({
      ...valid,
      contentType: 'image/svg+xml',
    }).success,
  );
});

Deno.test('scope photo finalization verifies actual format, size, and checksum', async () => {
  const pngBytes = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    ),
    (character) => character.charCodeAt(0),
  );
  const expected = {
    content_type: 'image/png' as const,
    byte_size: pngBytes.byteLength,
    checksum_sha256: '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460',
  };
  await verifyScopePhotoBytes(new Blob([pngBytes], { type: 'image/png' }), expected);
  const tampered = pngBytes.slice();
  tampered[40] ^= 1;
  await assertRejects(
    () => verifyScopePhotoBytes(new Blob([tampered], { type: 'image/png' }), expected),
    'SHA-256',
  );
});

Deno.test('measurement confirmation accepts evidence identity but no price fields', () => {
  const valid = {
    operation: 'confirm_measurement',
    companyId,
    requestId,
    analysisId: null,
    sourceAssetIds: [assetId],
    kind: 'area_sq_ft',
    label: 'Driveway',
    value: '900',
    unit: 'sq_ft',
    serviceCodes: ['pressure-wash-flatwork'],
    addOnCodes: [],
    confirmationNote: 'Verified from the customer plan by the dispatcher.',
    idempotencyKey: 'scope-measurement:edge-contract',
  };
  assert(scopePhotoWorkflowRequestSchema.safeParse(valid).success);
  assert(
    !scopePhotoWorkflowRequestSchema.safeParse({
      ...valid,
      unitPrice: '0.01',
      total: '9.00',
    }).success,
  );
});
