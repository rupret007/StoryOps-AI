import { describe, expect, it, vi } from 'vitest';
import {
  COMPLETION_SIGNATURE_CONTENT_TYPE,
  createCompletionSignaturePng,
} from '@/state/completionSignature';

function canvasFixture(blob: Blob) {
  const context = {
    beginPath: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillStyle: '',
    font: '',
    strokeStyle: '',
    lineWidth: 0,
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback, type?: string) => {
      expect(type).toBe(COMPLETION_SIGNATURE_CONTENT_TYPE);
      callback(blob);
    }),
  } as unknown as HTMLCanvasElement;
  return { canvas, context };
}

describe('completion signature rasterization', () => {
  it('creates an allowed PNG artifact and draws normalized evidence labels', async () => {
    const fixture = canvasFixture(
      new Blob([new Uint8Array([137, 80, 78, 71])], {
        type: COMPLETION_SIGNATURE_CONTENT_TYPE,
      }),
    );
    const visitId = '88888888-8888-4888-8888-888888888888';

    const artifact = await createCompletionSignaturePng(
      {
        signerName: '  Casey\u0000 Customer  ',
        signedAt: '2026-07-28T18:00:00.000Z',
        visitId,
      },
      () => fixture.canvas,
    );

    expect(artifact).toMatchObject({
      contentType: 'image/png',
      filename: `completion-signature-${visitId}.png`,
    });
    expect(artifact.blob.type).toBe('image/png');
    expect(fixture.context.fillText).toHaveBeenCalledWith('Casey Customer', 48, 172, 864);
  });

  it('fails closed when the browser does not return PNG bytes', async () => {
    const fixture = canvasFixture(new Blob(['not a raster'], { type: 'image/svg+xml' }));

    await expect(
      createCompletionSignaturePng(
        {
          signerName: 'Casey Customer',
          signedAt: '2026-07-28T18:00:00.000Z',
          visitId: '88888888-8888-4888-8888-888888888888',
        },
        () => fixture.canvas,
      ),
    ).rejects.toThrow(/valid PNG signature artifact/u);
  });
});
