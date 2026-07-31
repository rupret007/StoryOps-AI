import { describe, expect, it } from 'vitest';
import {
  SCOPE_PHOTO_MAX_BYTES,
  scopePhotoWorkflowRequestSchema,
} from '@/core/scopePhotos/contracts';

const companyId = '10000000-0000-4000-8000-000000000001';
const requestId = '10000000-0000-4000-8000-000000000801';
const analysisId = '10000000-0000-4000-8000-000000000802';
const assetId = '10000000-0000-4000-8000-000000000803';

describe('scope-photo workflow contracts', () => {
  it('accepts only bounded, private-image upload metadata', () => {
    const valid = {
      operation: 'prepare_upload',
      companyId,
      requestId,
      checklistItemCode: 'front_elevation',
      assetId,
      contentType: 'image/jpeg',
      byteSize: 2048,
      checksumSha256: 'a'.repeat(64),
      capturedAt: '2026-07-29T15:00:00.000Z',
      idempotencyKey: '10000000-0000-4000-8000-000000000804',
    };
    expect(scopePhotoWorkflowRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      scopePhotoWorkflowRequestSchema.safeParse({
        ...valid,
        contentType: 'application/pdf',
      }).success,
    ).toBe(false);
    expect(
      scopePhotoWorkflowRequestSchema.safeParse({
        ...valid,
        byteSize: SCOPE_PHOTO_MAX_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      scopePhotoWorkflowRequestSchema.safeParse({
        ...valid,
        objectPath: `${companyId}/forged.jpg`,
      }).success,
    ).toBe(false);
  });

  it('requires a human-entered, service-classified measurement with matching units', () => {
    const valid = {
      operation: 'confirm_measurement',
      companyId,
      requestId,
      analysisId,
      sourceAssetIds: [assetId],
      kind: 'length_linear_ft',
      label: 'Front gutter run',
      value: '88.5',
      unit: 'linear_ft',
      serviceCodes: ['gutter-cleaning'],
      addOnCodes: [],
      confirmationNote: 'Measured on site with a laser distance meter.',
      idempotencyKey: 'scope-measurement:unit-test',
    };
    expect(scopePhotoWorkflowRequestSchema.safeParse(valid).success).toBe(true);
    expect(scopePhotoWorkflowRequestSchema.safeParse({ ...valid, unit: 'sq_ft' }).success).toBe(
      false,
    );
    expect(
      scopePhotoWorkflowRequestSchema.safeParse({
        ...valid,
        serviceCodes: [],
        addOnCodes: [],
      }).success,
    ).toBe(false);
    expect(
      scopePhotoWorkflowRequestSchema.safeParse({
        ...valid,
        kind: 'stories',
        unit: 'story',
        value: '1.5',
      }).success,
    ).toBe(false);
  });

  it('does not accept price, multiplier, or total fields in any measurement command', () => {
    const injected = {
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
      confirmationNote: 'Customer plan dimensions were checked by the dispatcher.',
      idempotencyKey: 'scope-measurement:no-pricing',
      unitPrice: '0.01',
      total: '9.00',
      multiplier: '0.1',
    };
    expect(scopePhotoWorkflowRequestSchema.safeParse(injected).success).toBe(false);
  });
});
