import { z } from 'zod';
import {
  SCOPE_PHOTO_MAX_BYTES,
  scopePhotoWorkflowRequestSchema,
} from '../../../src/core/scopePhotos/contracts.ts';

export { scopePhotoWorkflowRequestSchema };

export const scopePhotoReservationSchema = z
  .object({
    id: z.string().uuid(),
    company_id: z.string().uuid(),
    request_id: z.string().uuid(),
    command_id: z.string().uuid(),
    request_hash: z.string().regex(/^[a-f0-9]{64}$/u),
    checklist_item_code: z.string(),
    asset_id: z.string().uuid(),
    object_path: z.string(),
    content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    byte_size: z.coerce.number().int().min(1).max(SCOPE_PHOTO_MAX_BYTES),
    checksum_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    captured_at: z.string(),
    prepared_by: z.string().uuid(),
    status: z.enum(['prepared', 'finalized', 'cleanup_claimed', 'cleanup_failed', 'cleaned']),
    expires_at: z.string(),
  })
  .passthrough();

export function scopePhotoExtension(contentType: string): 'jpg' | 'png' | 'webp' {
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  throw new Error('Unsupported scope-photo content type.');
}

async function sha256Bytes(contents: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', contents);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyScopePhotoBytes(
  blob: Blob,
  expected: {
    content_type: 'image/jpeg' | 'image/png' | 'image/webp';
    byte_size: number;
    checksum_sha256: string;
  },
): Promise<void> {
  if (blob.size !== expected.byte_size) {
    throw new Error('Stored scope-photo byte size does not match its reservation.');
  }
  if (blob.type && blob.type !== expected.content_type) {
    throw new Error('Stored scope-photo content type does not match its reservation.');
  }
  const contents = await blob.arrayBuffer();
  const bytes = new Uint8Array(contents);
  const validSignature =
    expected.content_type === 'image/png'
      ? bytes.length >= 8 &&
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
          (byte, index) => bytes[index] === byte,
        )
      : expected.content_type === 'image/jpeg'
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
    throw new Error('Stored scope-photo bytes do not match the declared image format.');
  }
  if ((await sha256Bytes(contents)) !== expected.checksum_sha256) {
    throw new Error('Stored scope-photo SHA-256 does not match its reservation.');
  }
}
