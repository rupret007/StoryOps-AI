import { describe, expect, it } from 'vitest';
import {
  materialSdsRegistryStateSchema,
  normalizeSdsRegistrationMetadata,
  reviewedSdsPdfChecksum,
  sdsRegistrationRequestHashMaterial,
} from '@/core/materials/sdsRegistry';

const companyId = '10000000-0000-4000-8000-000000000001';

describe('material SDS registry contracts', () => {
  it('calculates the reviewed PDF checksum and rejects MIME spoofing', async () => {
    const reviewedPdf = (contents: string) => {
      const bytes = new TextEncoder().encode(contents);
      return {
        type: 'application/pdf',
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.buffer,
      } as Blob;
    };
    await expect(reviewedSdsPdfChecksum(reviewedPdf('%PDF-test'))).resolves.toBe(
      '3c87d37f1dbea6909f917ce437c390fb8e655a774387d9e69301c0b2283d5b63',
    );
    await expect(reviewedSdsPdfChecksum(reviewedPdf('NOTP-test'))).rejects.toThrow(
      'valid PDF file signature',
    );
  });

  it('builds a stable bounded request hash payload without file bytes or instructions', () => {
    const metadata = normalizeSdsRegistrationMetadata({
      materialConfigurationKey: 'soft-wash-mix',
      productName: 'Reviewed exterior cleaner',
      manufacturer: 'Example Manufacturer',
      revisionDate: '2026-07-01',
      reviewReference: 'owner-sds-review-2026-07',
      contentType: 'application/pdf',
      byteSize: 9,
      checksumSha256: 'a'.repeat(64),
    });
    expect(sdsRegistrationRequestHashMaterial(companyId, metadata)).toBe(
      [
        'storyops-material-sds-registration-v1',
        companyId,
        'soft-wash-mix',
        'Reviewed exterior cleaner',
        'Example Manufacturer',
        '2026-07-01',
        'application/pdf',
        '9',
        'a'.repeat(64),
        'owner-sds-review-2026-07',
      ].join('\u001f'),
    );
  });

  it('accepts a pre-baseline exact configuration registry without inventing material identity', () => {
    expect(
      materialSdsRegistryStateSchema.parse({
        schemaVersion: 'storyops-material-sds-registry-v1',
        companyId,
        baselineId: null,
        baselineHash: null,
        configurationRevision: 2,
        configurationHash: 'b'.repeat(64),
        materials: [
          {
            materialId: null,
            materialVersion: null,
            configurationKey: 'soft-wash-mix',
            configurationRevision: 2,
            configurationHash: 'b'.repeat(64),
            baselineId: null,
            baselineHash: null,
            name: 'Owner-reviewed exterior cleaner',
            unit: 'gal',
            requiresSds: true,
            active: false,
            registrationStatus: 'registration_required',
            expectedChecksumSha256: 'a'.repeat(64),
            sdsDocument: null,
          },
        ],
        serverTime: '2026-07-30T12:00:00.000Z',
      }).materials[0]?.registrationStatus,
    ).toBe('registration_required');
  });
});
