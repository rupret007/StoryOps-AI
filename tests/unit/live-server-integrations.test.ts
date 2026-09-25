import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleCalendarProvider,
  GoogleMapsProvider,
  HttpEmailProvider,
  QuickBooksCsvProvider,
  StripePaymentsProvider,
  TwilioSmsProvider,
  createServerIntegrationSuite,
} from '@/core/integrations/liveServer';
import type { IntegrationSuite } from '@/core/integrations/contracts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const allowOutbound = {
  authorizeSms: vi.fn(async () => undefined),
  authorizeEmail: vi.fn(async () => undefined),
  authorizeVoice: vi.fn(async () => undefined),
};

const stripeCustomerResolver = {
  resolve: vi.fn(async (companyId: string, customerId: string) => ({
    companyId,
    customerId,
    name: 'Morgan Ellis',
    email: 'morgan@example.com',
    identityFingerprint: 'a'.repeat(64),
    stripeCustomerId: 'cus_123',
  })),
  save: vi.fn(async () => undefined),
};

const stripeBillingValidator = {
  validateCheckout: vi.fn(async () => undefined),
  validateInvoice: vi.fn(async () => undefined),
  validateRefund: vi.fn(async () => undefined),
};

const activationSettings = [
  ['OPENAI_MODE', 'OPENAI_LIVE_ENABLED'],
  ['TWILIO_MODE', 'TWILIO_LIVE_ENABLED'],
  ['EMAIL_MODE', 'EMAIL_LIVE_ENABLED'],
  ['STRIPE_MODE', 'STRIPE_LIVE_ENABLED'],
  ['GOOGLE_CALENDAR_MODE', 'GOOGLE_CALENDAR_LIVE_ENABLED'],
  ['MAPS_MODE', 'MAPS_LIVE_ENABLED'],
  ['WEATHER_MODE', 'NWS_LIVE_ENABLED'],
  ['ROUTING_MODE', 'VROOM_LIVE_ENABLED'],
  ['SIGNED_STORAGE_TARGETS_MODE', 'SIGNED_STORAGE_TARGETS_LIVE_ENABLED'],
  ['QUICKBOOKS_MODE', 'QUICKBOOKS_EXPORT_ENABLED'],
] as const;

const completeProviderCredentials = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-redacted',
  OPENAI_API_KEY: 'openai-redacted',
  OPENAI_MODEL: 'evaluated-model',
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'twilio-redacted',
  TWILIO_SMS_FROM: '+12145550199',
  TWILIO_VOICE_FROM: '+12145550198',
  TWILIO_WEBHOOK_URL: 'https://storyops.example/functions/v1/provider-webhook?provider=twilio',
  TWILIO_COMPANY_ID: '10000000-0000-4000-8000-000000000001',
  EMAIL_PROVIDER: 'transactional_email',
  EMAIL_PROVIDER_ENDPOINT: 'https://email.example/v1/messages',
  EMAIL_PROVIDER_TOKEN: 'email-redacted',
  EMAIL_FROM: 'service@example.com',
  STRIPE_SECRET_KEY: 'stripe-redacted',
  STRIPE_CHECKOUT_SUCCESS_URL: 'https://storyops.example/portal/payment/success',
  STRIPE_CHECKOUT_CANCEL_URL: 'https://storyops.example/portal/payment/cancel',
  GOOGLE_CALENDAR_ID: 'calendar@example.com',
  GOOGLE_CALENDAR_ACCESS_TOKEN: 'google-redacted',
  GOOGLE_MAPS_API_KEY: 'maps-redacted',
  NWS_USER_AGENT: 'WashOps tests operations@example.com',
  VROOM_URL: 'http://127.0.0.1:3000',
  STORAGE_BUCKET_JOB_PHOTOS: 'job-media',
};

function providerEnvironment(mode: string, flag: string): Record<string, string> {
  const environment: Record<string, string> = { ...completeProviderCredentials };
  for (const [modeSetting, enableFlag] of activationSettings) {
    environment[modeSetting] = mode;
    environment[enableFlag] = flag;
  }
  return environment;
}

function suiteModes(suite: IntegrationSuite) {
  return [
    suite.openai.mode,
    suite.sms.mode,
    suite.voice.mode,
    suite.email.mode,
    suite.payments.mode,
    suite.calendar.mode,
    suite.maps.mode,
    suite.weather.mode,
    suite.routing.mode,
    suite.storage.mode,
    suite.accounting.mode,
  ];
}

describe('live server integration boundaries', () => {
  it('stays entirely in sandbox mode without activation flags', () => {
    const suite = createServerIntegrationSuite({});
    expect(suite.sms.mode).toBe('sandbox');
    expect(suite.payments.mode).toBe('sandbox');
    expect(suite.calendar.mode).toBe('sandbox');
    expect(suite.storage.mode).toBe('sandbox');
  });

  it('fails closed when both live switches are enabled without credentials', () => {
    expect(() =>
      createServerIntegrationSuite({
        STRIPE_MODE: 'live',
        STRIPE_LIVE_ENABLED: 'true',
      }),
    ).toThrow(/missing (SUPABASE_URL|STRIPE_SECRET_KEY)/u);
  });

  it('refuses a live signed-target bucket that differs from job-media', () => {
    expect(() =>
      createServerIntegrationSuite({
        ...providerEnvironment('live', 'true'),
        STORAGE_BUCKET_JOB_PHOTOS: 'other-bucket',
      }),
    ).toThrow(/requires the private job-media bucket/u);
  });

  it.each([
    ['sandbox', 'false', 'sandbox'],
    ['sandbox', 'true', 'disabled'],
    ['live', 'false', 'disabled'],
    ['live', 'true', 'live'],
    ['disabled', 'false', 'disabled'],
    ['disabled', 'true', 'disabled'],
  ] as const)(
    'maps every provider mode=%s and flag=%s to %s',
    (mode, flag, expectedRuntimeMode) => {
      const suite = createServerIntegrationSuite(providerEnvironment(mode, flag));
      expect(new Set(suiteModes(suite))).toEqual(new Set([expectedRuntimeMode]));
    },
  );

  it('rejects disabled provider operations without returning a synthetic receipt or calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const suite = createServerIntegrationSuite(providerEnvironment('disabled', 'false'));
    const window = {
      start: '2026-07-28T14:00:00.000Z',
      end: '2026-07-28T16:00:00.000Z',
    };
    const operations: Array<[string, () => Promise<unknown>]> = [
      [
        'twilio',
        () =>
          suite.sms.sendSms({
            companyId: '10000000-0000-4000-8000-000000000001',
            to: '+12145550100',
            body: 'Disabled provider check',
            category: 'transactional',
            consentSnapshotId: 'consent-1',
            idempotencyKey: 'disabled-sms-v1',
          }),
      ],
      [
        'twilio',
        () =>
          suite.voice.createCall({
            companyId: '10000000-0000-4000-8000-000000000001',
            to: '+12145550100',
            twimlUrl: 'https://storyops.example/twiml',
            consentSnapshotId: 'consent-1',
            idempotencyKey: 'disabled-voice-v1',
          }),
      ],
      [
        'email',
        () =>
          suite.email.sendEmail({
            companyId: '10000000-0000-4000-8000-000000000001',
            to: ['customer@example.com'],
            subject: 'Disabled provider check',
            text: 'No external message should be sent.',
            category: 'transactional',
            consentSnapshotIds: { 'customer@example.com': 'consent-1' },
            idempotencyKey: 'disabled-email-v1',
          }),
      ],
      [
        'stripe',
        () =>
          suite.payments.createCheckout({
            companyId: '10000000-0000-4000-8000-000000000001',
            customerId: '10000000-0000-4000-8000-000000000101',
            quoteId: '10000000-0000-4000-8000-000000000501',
            lines: [
              {
                description: 'Exterior service',
                quantity: 1,
                unitAmount: { amount: '100.00', currency: 'USD' },
              },
            ],
            idempotencyKey: 'disabled-checkout-v1',
          }),
      ],
      [
        'google_calendar',
        () =>
          suite.calendar.readAvailability({
            calendarIds: [],
            window,
            durationMinutes: 60,
            timeZone: 'America/Chicago',
          }),
      ],
      ['maps', () => suite.maps.geocode('100 Main St, Dallas, TX')],
      [
        'nws',
        () =>
          suite.weather.forecast({
            coordinates: { latitude: 32.7767, longitude: -96.797 },
            window,
          }),
      ],
      [
        'vroom',
        () =>
          suite.routing.optimize({
            jobs: [],
            vehicles: [],
            idempotencyKey: 'disabled-route-v1',
          }),
      ],
      [
        'signed_storage_targets',
        () =>
          suite.storage.createUploadTarget({
            companyId: '10000000-0000-4000-8000-000000000001',
            objectKey: 'companies/example/jobs/example/before/photo.png',
            contentType: 'image/png',
            maxBytes: 1024,
            expiresInSeconds: 60,
            idempotencyKey: 'disabled-storage-v1',
          }),
      ],
      [
        'quickbooks_export',
        () =>
          suite.accounting.exportInvoice({
            invoiceNumber: 'INV-disabled',
            customerName: 'Example Customer',
            issuedDate: '2026-07-28',
            dueDate: '2026-08-04',
            lines: [],
            tax: { amount: '0.00', currency: 'USD' },
            idempotencyKey: 'disabled-accounting-v1',
          }),
      ],
    ];

    for (const [provider, operation] of operations) {
      await expect(operation()).rejects.toMatchObject({
        provider,
        code: 'PROVIDER_DISABLED',
        retryable: false,
      });
    }
    await expect(suite.payments.health()).resolves.toMatchObject({
      mode: 'disabled',
      status: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends Twilio SMS without claiming unsupported create idempotency', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        sid: 'SM123',
        status: 'queued',
        date_updated: '2026-07-28T17:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new TwilioSmsProvider(
      {
        accountSid: 'AC123',
        authToken: 'secret',
        smsFrom: '+12145550199',
        voiceFrom: '+12145550198',
      },
      allowOutbound,
    );

    const receipt = await provider.sendSms({
      companyId: '10000000-0000-4000-8000-000000000001',
      to: '+12145550100',
      body: 'Your policy-approved quote is ready.',
      category: 'transactional',
      consentSnapshotId: 'consent-1',
      idempotencyKey: 'quote:1048:sms:v1',
    });

    expect(receipt).toMatchObject({
      provider: 'twilio',
      providerId: 'SM123',
      mode: 'live',
      status: 'queued',
      idempotencyKey: 'quote:1048:sms:v1',
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('i-twilio-idempotency-token')).toBeNull();
    expect(String(init.body)).toContain('To=%2B12145550100');
  });

  it('converts deterministic decimal Stripe lines to integer cents', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        id: 'cs_test_123',
        status: 'open',
        payment_status: 'unpaid',
        amount_total: 61356,
        url: 'https://checkout.stripe.test/cs_test_123',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new StripePaymentsProvider({
      secretKey: 'sk_test_redacted',
      checkoutSuccessUrl: 'https://storyops.example/portal/payment/success',
      checkoutCancelUrl: 'https://storyops.example/portal/payment/cancel',
      customerResolver: stripeCustomerResolver,
      billingValidator: stripeBillingValidator,
    });

    const checkout = await provider.createCheckout({
      companyId: '10000000-0000-4000-8000-000000000001',
      customerId: 'cus_123',
      quoteId: 'quote-1048',
      checkoutAttempt: 1,
      lines: [
        {
          description: 'Exterior service',
          quantity: 1,
          unitAmount: { amount: '613.56', currency: 'USD' },
        },
      ],
      successUrl: 'https://storyops.example/portal/payment/success',
      cancelUrl: 'https://storyops.example/portal/payment/cancel',
      idempotencyKey: 'checkout:quote-1048:v1',
    });

    expect(checkout.total.amount).toBe('613.56');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('idempotency-key')).toBe('checkout:quote-1048:v1');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('61356');
    expect(body.get('metadata[checkout_purpose]')).toBe('quote_deposit');
    expect(body.get('metadata[checkout_attempt]')).toBe('1');
    expect(body.get('payment_intent_data[metadata][checkout_purpose]')).toBe('quote_deposit');
    expect(body.get('payment_intent_data[metadata][checkout_attempt]')).toBe('1');
  });

  it('binds Stripe invoice-balance metadata to both Checkout and PaymentIntent', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        id: 'cs_test_invoice',
        status: 'open',
        payment_status: 'unpaid',
        amount_total: 48124,
        url: 'https://checkout.stripe.test/cs_test_invoice',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new StripePaymentsProvider({
      secretKey: 'sk_test_redacted',
      checkoutSuccessUrl: 'https://storyops.example/portal/payment/success',
      checkoutCancelUrl: 'https://storyops.example/portal/payment/cancel',
      customerResolver: stripeCustomerResolver,
      billingValidator: stripeBillingValidator,
    });

    await provider.createCheckout({
      companyId: '10000000-0000-4000-8000-000000000001',
      customerId: '10000000-0000-4000-8000-000000000101',
      quoteId: '10000000-0000-4000-8000-000000000501',
      checkoutPurpose: 'invoice_balance',
      invoiceId: '10000000-0000-4000-8000-000000000701',
      invoiceVersion: 7,
      checkoutAttempt: 2,
      lines: [
        {
          description: 'Invoice balance',
          quantity: 1,
          unitAmount: { amount: '481.24', currency: 'USD' },
        },
      ],
      idempotencyKey: 'storyops:invoice-balance:invoice:v7:48124',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get('metadata[checkout_purpose]')).toBe('invoice_balance');
    expect(body.get('metadata[checkout_attempt]')).toBe('2');
    expect(body.get('metadata[invoice_version]')).toBe('7');
    expect(body.get('payment_intent_data[metadata][checkout_purpose]')).toBe('invoice_balance');
    expect(body.get('payment_intent_data[metadata][checkout_attempt]')).toBe('2');
    expect(body.get('payment_intent_data[metadata][invoice_version]')).toBe('7');
  });

  it('maps Google geocode evidence without inventing precision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          status: 'OK',
          results: [
            {
              formatted_address: '100 Main St, Grapevine, TX 76051, USA',
              place_id: 'place-1',
              geometry: {
                location_type: 'ROOFTOP',
                location: { lat: 32.934, lng: -97.078 },
              },
            },
          ],
        }),
      ),
    );
    const provider = new GoogleMapsProvider('maps-key-redacted');
    const [result] = await provider.geocode('100 Main St, Grapevine, TX');
    expect(result).toMatchObject({
      precision: 'rooftop',
      confidence: 0.99,
      coordinates: { latitude: 32.934, longitude: -97.078 },
    });
  });

  it('refreshes Google Calendar OAuth credentials server-side', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ access_token: 'access-1', expires_in: 3600 }))
      .mockResolvedValueOnce(json({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GoogleCalendarProvider({
      clientId: 'google-client',
      clientSecret: 'google-secret',
      refreshToken: 'google-refresh',
      calendarId: 'calendar@example.com',
    });

    await expect(provider.health()).resolves.toMatchObject({ status: 'healthy' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://oauth2.googleapis.com/token');
    const [, calendarInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(calendarInit.headers).get('authorization')).toBe('Bearer access-1');
  });

  it('reads back and verifies the deterministic Google Calendar booking', async () => {
    const window = {
      start: '2026-07-30T14:00:00.000Z',
      end: '2026-07-30T16:00:00.000Z',
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST') return json({ id: 'accepted' });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const eventId = decodeURIComponent(url.split('/').at(-1) ?? '');
      return json({
        id: eventId,
        etag: '"calendar-etag-v3"',
        status: 'confirmed',
        start: { dateTime: window.start },
        end: { dateTime: window.end },
        extendedProperties: {
          private: {
            storyops_job_id: '10000000-0000-4000-8000-000000000501',
            storyops_idempotency_key: 'schedule:job-501:v3',
            storyops_kind: 'booking',
            storyops_expires_at: '',
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GoogleCalendarProvider({
      accessToken: 'google-redacted',
      calendarId: 'calendar@example.com',
    });

    const request = {
      calendarId: 'calendar@example.com',
      title: 'WashOps job',
      window,
      timeZone: 'America/Chicago',
      jobId: '10000000-0000-4000-8000-000000000501',
      idempotencyKey: 'schedule:job-501:v3',
    };
    const entry = await provider.createBooking(request);
    expect(entry).toMatchObject({
      status: 'confirmed',
      etag: '"calendar-etag-v3"',
      readBackConfirmed: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/events/storyops');

    await expect(
      provider.cancelBooking({
        calendarId: 'calendar@example.com',
        providerId: entry.providerId,
        etag: entry.etag,
        idempotencyKey: request.idempotencyKey,
      }),
    ).resolves.toBeUndefined();
    const [, deleteInit] = fetchMock.mock.calls[3] as unknown as [string, RequestInit];
    expect(deleteInit.method).toBe('DELETE');
    expect(new Headers(deleteInit.headers).get('if-match')).toBe('"calendar-etag-v3"');
  });

  it('uses a documented HTTP email gateway contract and preserves idempotency', async () => {
    const fetchMock = vi.fn(async () => json({ id: 'email-123', status: 'accepted' }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HttpEmailProvider(
      'transactional_email',
      'https://email.example/v1/messages',
      'token-redacted',
      'service@example.com',
      allowOutbound,
    );
    const receipt = await provider.sendEmail({
      companyId: '10000000-0000-4000-8000-000000000001',
      to: ['customer@example.com'],
      subject: 'Quote EST-1048',
      text: 'Your quote is ready.',
      category: 'transactional',
      consentSnapshotIds: { 'customer@example.com': 'consent-1' },
      idempotencyKey: 'quote:1048:email:v1',
    });
    expect(receipt.providerId).toBe('email-123');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('idempotency-key')).toBe('quote:1048:email:v1');
  });

  it('creates a deterministic QuickBooks-ready export without network access', async () => {
    const provider = new QuickBooksCsvProvider();
    const exportFile = await provider.exportInvoice({
      invoiceNumber: 'INV-1048',
      customerName: 'Morgan Ellis',
      customerEmail: 'morgan@example.com',
      issuedDate: '2026-07-28',
      dueDate: '2026-07-28',
      lines: [
        {
          description: 'Pressure washing',
          quantity: 1,
          unitAmount: { amount: '613.56', currency: 'USD' },
        },
      ],
      tax: { amount: '38.56', currency: 'USD' },
      idempotencyKey: 'qb:invoice-1048:v1',
    });
    expect(exportFile.mode).toBe('live');
    expect(exportFile.content).toContain('"INV-1048"');
    expect(exportFile.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
