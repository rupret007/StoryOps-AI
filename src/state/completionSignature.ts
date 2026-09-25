export const COMPLETION_SIGNATURE_CONTENT_TYPE = 'image/png' as const;

export interface CompletionSignatureArtifact {
  blob: Blob;
  contentType: typeof COMPLETION_SIGNATURE_CONTENT_TYPE;
  filename: string;
}

export interface CompletionSignatureArtifactInput {
  signerName: string;
  signedAt: string;
  visitId: string;
}

type CanvasFactory = () => HTMLCanvasElement;

function normalizedLabel(value: string, maximumLength: number): string {
  const printable = [...value.normalize('NFKC')]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('');
  return printable.replaceAll(/\s+/gu, ' ').trim().slice(0, maximumLength);
}

function safeVisitId(value: string): string {
  const normalized = value.toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)
  ) {
    throw new Error('A valid visit ID is required to create completion-signature evidence.');
  }
  return normalized;
}

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob || blob.size < 1 || blob.type !== COMPLETION_SIGNATURE_CONTENT_TYPE) {
        reject(new Error('The browser could not create a valid PNG signature artifact.'));
        return;
      }
      resolve(blob);
    }, COMPLETION_SIGNATURE_CONTENT_TYPE);
  });
}

export async function createCompletionSignaturePng(
  input: CompletionSignatureArtifactInput,
  createCanvas: CanvasFactory = () => document.createElement('canvas'),
): Promise<CompletionSignatureArtifact> {
  const signerName = normalizedLabel(input.signerName, 160);
  if (signerName.length < 2) {
    throw new Error('A verified signer name is required.');
  }
  const signedAt = new Date(input.signedAt);
  if (Number.isNaN(signedAt.valueOf())) {
    throw new Error('A valid signature timestamp is required.');
  }
  const visitId = safeVisitId(input.visitId);
  const canvas = createCanvas();
  canvas.width = 960;
  canvas.height = 320;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('This browser cannot rasterize completion-signature evidence.');
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#183c35';
  context.font = '600 24px system-ui, sans-serif';
  context.fillText('WashOps completion acknowledgement', 48, 68, 864);
  context.fillStyle = '#122a25';
  context.font = '52px cursive';
  context.fillText(signerName, 48, 172, 864);
  context.strokeStyle = '#527066';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(48, 198);
  context.lineTo(912, 198);
  context.stroke();
  context.fillStyle = '#527066';
  context.font = '18px system-ui, sans-serif';
  context.fillText(`Signed ${signedAt.toISOString()}`, 48, 242, 864);
  context.fillText(`Visit ${visitId} · disclosure completion-v1`, 48, 276, 864);

  const blob = await pngBlob(canvas);
  return {
    blob,
    contentType: COMPLETION_SIGNATURE_CONTENT_TYPE,
    filename: `completion-signature-${visitId}.png`,
  };
}
