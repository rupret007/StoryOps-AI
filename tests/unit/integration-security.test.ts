import {
  InMemoryWebhookReceiptStore,
  claimVerifiedWebhook,
  classifyConsentKeyword,
  constantTimeEqual,
  isWithinQuietHours,
  verifyStripeWebhook,
  verifyTwilioWebhook,
} from '@/core/integrations';

async function hmac(
  algorithm: 'SHA-1' | 'SHA-256',
  secret: string,
  value: string,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('integration security utilities', () => {
  it('validates Stripe signatures and rejects stale events', async () => {
    const secret = 'whsec_unit_test';
    const body = '{"id":"evt_123","type":"checkout.session.completed"}';
    const timestamp = 1_785_240_000;
    const signature = hex(await hmac('SHA-256', secret, `${timestamp}.${body}`));
    const header = `t=${timestamp},v1=${signature}`;

    await expect(
      verifyStripeWebhook({
        rawBody: body,
        signatureHeader: header,
        signingSecret: secret,
        now: new Date(timestamp * 1_000 + 60_000),
      }),
    ).resolves.toEqual({ valid: true, timestamp });
    await expect(
      verifyStripeWebhook({
        rawBody: body,
        signatureHeader: header,
        signingSecret: secret,
        now: new Date(timestamp * 1_000 + 600_000),
      }),
    ).resolves.toEqual({ valid: false, timestamp });
  });

  it('validates the canonical Twilio URL and sorted form payload', async () => {
    const canonicalUrl = 'https://api.example.test/functions/v1/provider-webhook?provider=twilio';
    const form = { Body: 'STOP', From: '+12145550123', MessageSid: 'SM123' };
    const payload =
      canonicalUrl +
      Object.entries(form)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}${value}`)
        .join('');
    const signature = base64(await hmac('SHA-1', 'twilio-token', payload));
    await expect(
      verifyTwilioWebhook({
        canonicalUrl,
        form,
        signature,
        authToken: 'twilio-token',
      }),
    ).resolves.toBe(true);
  });

  it('claims duplicate webhook IDs once and detects conflicting replay payloads', async () => {
    const store = new InMemoryWebhookReceiptStore();
    const claim = {
      store,
      provider: 'stripe',
      providerEventId: 'evt_1',
      rawBody: '{"id":"evt_1"}',
    };
    await expect(claimVerifiedWebhook(claim)).resolves.toBe('claimed');
    await expect(claimVerifiedWebhook(claim)).resolves.toBe('duplicate');
    await expect(
      claimVerifiedWebhook({ ...claim, rawBody: '{"id":"evt_1","changed":true}' }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_REPLAY_CONFLICT' });
  });

  it('recognizes opt-out keywords and DFW quiet hours', () => {
    expect(classifyConsentKeyword(' STOP! ')).toBe('opt_out');
    expect(classifyConsentKeyword('start')).toBe('opt_in');
    expect(
      isWithinQuietHours({
        at: new Date('2026-07-29T02:30:00.000Z'),
        timeZone: 'America/Chicago',
      }),
    ).toBe(true);
    expect(
      isWithinQuietHours({
        at: new Date('2026-07-28T17:00:00.000Z'),
        timeZone: 'America/Chicago',
      }),
    ).toBe(false);
  });

  it('uses constant-time comparison semantics for different lengths', () => {
    expect(constantTimeEqual('same', 'same')).toBe(true);
    expect(constantTimeEqual('same', 'different')).toBe(false);
  });
});
