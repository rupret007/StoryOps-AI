import { z } from 'zod';

const incidentEvidencePurposes = new Set(['incident', 'safety', 'damage']);

export const fieldMediaPayloadSchema = z
  .object({
    entityId: z.string().uuid(),
    visitId: z.string().uuid(),
    jobId: z.string().uuid(),
    propertyId: z.string().uuid(),
    incidentId: z.string().uuid().optional(),
    purpose: z.enum(['before', 'after', 'signature', 'incident', 'safety', 'damage']),
    objectPath: z.string().min(1).max(500),
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    byteSize: z
      .number()
      .int()
      .min(1)
      .max(15 * 1024 * 1024),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    capturedAt: z.string().datetime({ offset: true }),
    customerVisible: z.literal(false),
  })
  .strict();

export const fieldMediaFinalizeRequestSchema = z
  .object({
    companyId: z.string().uuid(),
    command: z
      .object({
        commandId: z.string().uuid(),
        commandType: z.literal('media.register'),
        expectedVersion: z.literal(0),
        payload: fieldMediaPayloadSchema,
        requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    const { companyId, command } = request;
    const isIncidentEvidence = incidentEvidencePurposes.has(command.payload.purpose);
    if (isIncidentEvidence !== Boolean(command.payload.incidentId)) {
      context.addIssue({
        code: 'custom',
        path: ['command', 'payload', 'incidentId'],
        message:
          'Incident, safety, and damage evidence require one incident UUID; ordinary visit media forbids it.',
      });
      return;
    }
    const expectedPrefix = isIncidentEvidence
      ? `${companyId}/incidents/${command.payload.incidentId}/visits/${command.payload.visitId}/${command.payload.entityId}-`
      : `${companyId}/visits/${command.payload.visitId}/${command.payload.entityId}-`;
    if (
      !command.payload.objectPath.startsWith(expectedPrefix) ||
      !command.payload.objectPath.includes(command.payload.checksumSha256.slice(0, 16))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['command', 'payload', 'objectPath'],
        message:
          'Object path must bind company, incident when applicable, visit, asset UUID, and checksum prefix.',
      });
    }
  });

export type FieldMediaFinalizeRequest = z.infer<typeof fieldMediaFinalizeRequestSchema>;

async function sha256Hex(contents: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', contents);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export async function verifyMediaCommandRequestHash(
  command: FieldMediaFinalizeRequest['command'],
): Promise<void> {
  const canonical = JSON.stringify(
    canonicalize({
      commandType: command.commandType,
      expectedVersion: command.expectedVersion,
      payload: command.payload,
    }),
  );
  const actual = await sha256Hex(new TextEncoder().encode(canonical).buffer);
  if (actual !== command.requestHash) {
    throw new Error('Media command request hash does not match its canonical payload.');
  }
}

export async function verifyDurableMediaBytes(
  blob: Blob,
  expected: z.infer<typeof fieldMediaPayloadSchema>,
): Promise<void> {
  if (blob.size !== expected.byteSize) {
    throw new Error('Stored media byte size does not match the captured packet.');
  }
  if (blob.type && blob.type !== expected.contentType) {
    throw new Error('Stored media content type does not match the captured packet.');
  }
  const contents = await blob.arrayBuffer();
  const bytes = new Uint8Array(contents);
  const validSignature =
    expected.contentType === 'image/png'
      ? bytes.length >= 8 &&
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
          (byte, index) => bytes[index] === byte,
        )
      : expected.contentType === 'image/jpeg'
        ? bytes.length >= 5 &&
          bytes[0] === 0xff &&
          bytes[1] === 0xd8 &&
          bytes[2] === 0xff &&
          bytes.at(-2) === 0xff &&
          bytes.at(-1) === 0xd9
        : bytes.length >= 12 &&
          new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
          new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  if (!validSignature) {
    throw new Error('Stored media bytes do not match the declared image format signature.');
  }
  const checksum = await sha256Hex(contents);
  if (checksum !== expected.checksumSha256) {
    throw new Error('Stored media SHA-256 does not match the captured packet.');
  }
}
