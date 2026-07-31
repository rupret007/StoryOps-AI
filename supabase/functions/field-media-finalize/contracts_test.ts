import {
  fieldMediaFinalizeRequestSchema,
  verifyDurableMediaBytes,
  verifyMediaCommandRequestHash,
} from './contracts.ts';

function assertEquals(actual: unknown, expected: unknown): void {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonicalize(item)]),
      );
    }
    return value;
  };
  if (JSON.stringify(canonicalize(actual)) !== JSON.stringify(canonicalize(expected))) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
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

const request = {
  companyId: '10000000-0000-4000-8000-000000000001',
  command: {
    commandId: '96000000-0000-4000-8000-000000000901',
    commandType: 'media.register',
    expectedVersion: 0,
    payload: {
      entityId: '96000000-0000-4000-8000-000000000811',
      visitId: '10000000-0000-4000-8000-000000000641',
      jobId: '10000000-0000-4000-8000-000000000631',
      propertyId: '10000000-0000-4000-8000-000000000211',
      purpose: 'before',
      objectPath:
        '10000000-0000-4000-8000-000000000001/visits/10000000-0000-4000-8000-000000000641/96000000-0000-4000-8000-000000000811-431ced6916a2a21a-before.png',
      contentType: 'image/png',
      byteSize: 68,
      checksumSha256: '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460',
      capturedAt: '2026-07-28T12:00:00.000Z',
      customerVisible: false,
    },
    requestHash: '12ccc82617de54c9667e62f366792af04f3f37b96649f740da0d970a50eccea0',
  },
} as const;

const incidentRequest = {
  ...request,
  command: {
    ...request.command,
    commandId: '96000000-0000-4000-8000-000000000902',
    payload: {
      ...request.command.payload,
      incidentId: '95000000-0000-4000-8000-000000000521',
      purpose: 'incident',
      objectPath:
        '10000000-0000-4000-8000-000000000001/incidents/95000000-0000-4000-8000-000000000521/visits/10000000-0000-4000-8000-000000000641/96000000-0000-4000-8000-000000000811-431ced6916a2a21a-incident.png',
    },
    requestHash: 'a'.repeat(64),
  },
} as const;

Deno.test('field media finalize accepts only a content-addressed visit command', () => {
  assertEquals(fieldMediaFinalizeRequestSchema.parse(request), request);
  assertEquals(
    fieldMediaFinalizeRequestSchema.safeParse({
      ...request,
      command: {
        ...request.command,
        payload: { ...request.command.payload, objectPath: 'other/path.png' },
      },
    }).success,
    false,
  );
});

Deno.test('incident evidence binds the incident and visit into one private object identity', () => {
  assertEquals(fieldMediaFinalizeRequestSchema.parse(incidentRequest), incidentRequest);
  assertEquals(
    fieldMediaFinalizeRequestSchema.safeParse({
      ...incidentRequest,
      command: {
        ...incidentRequest.command,
        payload: {
          ...incidentRequest.command.payload,
          incidentId: undefined,
        },
      },
    }).success,
    false,
  );
  assertEquals(
    fieldMediaFinalizeRequestSchema.safeParse({
      ...incidentRequest,
      command: {
        ...incidentRequest.command,
        payload: {
          ...incidentRequest.command.payload,
          purpose: 'before',
        },
      },
    }).success,
    false,
  );
  assertEquals(
    fieldMediaFinalizeRequestSchema.safeParse({
      ...incidentRequest,
      command: {
        ...incidentRequest.command,
        payload: {
          ...incidentRequest.command.payload,
          visitId: '10000000-0000-4000-8000-000000000642',
        },
      },
    }).success,
    false,
  );
});

Deno.test('field media finalize hashes actual stored bytes', async () => {
  const pngBytes = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    ),
    (character) => character.charCodeAt(0),
  );
  await verifyMediaCommandRequestHash(request.command);
  await verifyDurableMediaBytes(
    new Blob([pngBytes], { type: 'image/png' }),
    request.command.payload,
  );
  const tamperedBytes = pngBytes.slice();
  tamperedBytes[40] ^= 1;
  await assertRejects(
    () =>
      verifyDurableMediaBytes(
        new Blob([tamperedBytes], { type: 'image/png' }),
        request.command.payload,
      ),
    'SHA-256',
  );
  await assertRejects(
    () =>
      verifyDurableMediaBytes(new Blob(['hello'], { type: 'image/png' }), {
        ...request.command.payload,
        byteSize: 5,
        checksumSha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      }),
    'image format signature',
  );
  await assertRejects(
    () =>
      verifyMediaCommandRequestHash({
        ...request.command,
        requestHash: 'a'.repeat(64),
      }),
    'canonical payload',
  );
});
