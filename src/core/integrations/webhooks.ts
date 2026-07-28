import { IntegrationError } from './contracts.ts';

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

export async function sha256TextHex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function hmac(
  algorithm: 'SHA-1' | 'SHA-256',
  secret: string,
  value: string,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const max = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < max; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

export async function verifyStripeWebhook(options: {
  rawBody: string;
  signatureHeader: string;
  signingSecret: string;
  now?: Date;
  toleranceSeconds?: number;
}): Promise<{ valid: boolean; timestamp: number | null }> {
  return verifyTimestampedHmacWebhook(options);
}

export async function verifyTimestampedHmacWebhook(options: {
  rawBody: string;
  signatureHeader: string;
  signingSecret: string;
  now?: Date;
  toleranceSeconds?: number;
}): Promise<{ valid: boolean; timestamp: number | null }> {
  const fields = options.signatureHeader.split(',').map((field) => field.trim());
  const timestampText = fields.find((field) => field.startsWith('t='))?.slice(2);
  const signatures = fields
    .filter((field) => field.startsWith('v1='))
    .map((field) => field.slice(3));
  const timestamp = timestampText ? Number.parseInt(timestampText, 10) : Number.NaN;
  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    return { valid: false, timestamp: null };
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    return { valid: false, timestamp };
  }

  const expected = bytesToHex(
    await hmac('SHA-256', options.signingSecret, `${timestamp}.${options.rawBody}`),
  );
  return {
    valid: signatures.some((signature) => constantTimeEqual(signature, expected)),
    timestamp,
  };
}

export async function verifyTwilioWebhook(options: {
  canonicalUrl: string;
  form: Record<string, string>;
  signature: string;
  authToken: string;
}): Promise<boolean> {
  const payload =
    options.canonicalUrl +
    Object.entries(options.form)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}${value}`)
      .join('');
  const expected = bytesToBase64(await hmac('SHA-1', options.authToken, payload));
  return constantTimeEqual(options.signature, expected);
}

export type WebhookClaim = {
  provider: string;
  providerEventId: string;
  payloadHash: string;
  claimedAt: string;
  status: 'processing' | 'processed' | 'failed';
};

export interface WebhookReceiptStore {
  claim(claim: WebhookClaim): Promise<'claimed' | 'duplicate' | 'conflict'>;
  complete(
    provider: string,
    providerEventId: string,
    status: 'processed' | 'failed',
  ): Promise<void>;
}

export class InMemoryWebhookReceiptStore implements WebhookReceiptStore {
  private readonly claims = new Map<string, WebhookClaim>();

  async claim(claim: WebhookClaim): Promise<'claimed' | 'duplicate' | 'conflict'> {
    const key = `${claim.provider}:${claim.providerEventId}`;
    const existing = this.claims.get(key);
    if (!existing) {
      this.claims.set(key, structuredClone(claim));
      return 'claimed';
    }
    return existing.payloadHash === claim.payloadHash ? 'duplicate' : 'conflict';
  }

  async complete(
    provider: string,
    providerEventId: string,
    status: 'processed' | 'failed',
  ): Promise<void> {
    const key = `${provider}:${providerEventId}`;
    const existing = this.claims.get(key);
    if (!existing) {
      throw new IntegrationError(
        'Webhook receipt was not claimed.',
        provider,
        'WEBHOOK_NOT_CLAIMED',
        false,
      );
    }
    this.claims.set(key, { ...existing, status });
  }
}

export async function claimVerifiedWebhook(options: {
  store: WebhookReceiptStore;
  provider: string;
  providerEventId: string;
  rawBody: string;
  now?: Date;
}): Promise<'claimed' | 'duplicate'> {
  if (!options.providerEventId) {
    throw new IntegrationError(
      'Webhook has no provider event ID.',
      options.provider,
      'MISSING_EVENT_ID',
      false,
    );
  }
  const payloadHash = await sha256TextHex(options.rawBody);
  const result = await options.store.claim({
    provider: options.provider,
    providerEventId: options.providerEventId,
    payloadHash,
    claimedAt: (options.now ?? new Date()).toISOString(),
    status: 'processing',
  });
  if (result === 'conflict') {
    throw new IntegrationError(
      'Provider event ID was reused with a different payload.',
      options.provider,
      'WEBHOOK_REPLAY_CONFLICT',
      false,
    );
  }
  return result;
}

export function parseWebhookJson(rawBody: string, maxBytes = 1_000_000): Record<string, unknown> {
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes) {
    throw new IntegrationError(
      'Webhook payload exceeds the configured limit.',
      'webhook',
      'PAYLOAD_TOO_LARGE',
      false,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    throw new IntegrationError(
      'Webhook payload is not valid JSON.',
      'webhook',
      'INVALID_JSON',
      false,
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IntegrationError(
      'Webhook payload must be a JSON object.',
      'webhook',
      'INVALID_JSON_SHAPE',
      false,
    );
  }
  return parsed as Record<string, unknown>;
}
