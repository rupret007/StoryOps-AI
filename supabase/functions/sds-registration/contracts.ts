import { z } from 'zod';
import { sdsUploadAttestationReceiptSchema } from '../../../src/core/materials/sdsRegistry.ts';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const sdsRegistrationAttestationRequestSchema = z
  .object({
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: sha256Schema,
  })
  .strict();

export const sdsUploadVerificationSchema = z
  .object({
    schemaVersion: z.literal('storyops-sds-upload-verification-v1'),
    companyId: z.string().uuid(),
    actorUserId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: sha256Schema,
    registrationRequestId: z.string().uuid(),
    objectPath: z.string().min(1).max(500),
    contentType: z.literal('application/pdf'),
    byteSize: z
      .number()
      .int()
      .min(5)
      .max(10 * 1024 * 1024),
    checksumSha256: sha256Schema,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export { sdsUploadAttestationReceiptSchema };

export async function verifySdsUploadBytes(
  blob: Blob,
  expected: z.infer<typeof sdsUploadVerificationSchema>,
): Promise<string> {
  if (blob.size !== expected.byteSize || (blob.type !== '' && blob.type !== expected.contentType)) {
    throw new Error('STORYOPS_SDS_BYTES_MISMATCH');
  }
  const contents = await blob.arrayBuffer();
  const signature = new Uint8Array(contents, 0, Math.min(5, contents.byteLength));
  if (
    signature.length !== 5 ||
    signature[0] !== 0x25 ||
    signature[1] !== 0x50 ||
    signature[2] !== 0x44 ||
    signature[3] !== 0x46 ||
    signature[4] !== 0x2d
  ) {
    throw new Error('STORYOPS_SDS_PDF_SIGNATURE_MISMATCH');
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', contents));
  const checksum = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (checksum !== expected.checksumSha256) {
    throw new Error('STORYOPS_SDS_BYTES_MISMATCH');
  }
  return checksum;
}
