import {
  InMemoryConsentStore,
  IntegrationHealthService,
  assessIntegrationEnvironment,
  createSandboxIntegrationSuite,
  listSuiteIntegrations,
  type ConsentSnapshot,
  type IntegrationError,
} from '@/core/integrations';

const consent: ConsentSnapshot = {
  id: 'consent-1',
  contact: '+12145550123',
  channel: 'sms',
  transactional: 'opted_in',
  marketing: 'opted_out',
  source: 'test',
  recordedAt: '2026-07-28T12:00:00.000Z',
};

describe('sandbox integration suite', () => {
  it('enforces consent and exposes delivery state for SMS', async () => {
    const consentStore = new InMemoryConsentStore();
    await consentStore.save(consent);
    const suite = createSandboxIntegrationSuite({ consent: consentStore });
    const request = {
      companyId: '10000000-0000-4000-8000-000000000001',
      to: '(214) 555-0123',
      body: 'Your estimate is ready.',
      category: 'transactional' as const,
      consentSnapshotId: consent.id,
      idempotencyKey: 'sms-message-key',
    };

    const receipt = await suite.sms.sendSms(request);
    expect(receipt.status).toBe('delivered');
    await expect(suite.sms.sendSms(request)).resolves.toEqual(receipt);
    await expect(
      suite.sms.sendSms({
        ...request,
        category: 'marketing',
        idempotencyKey: 'sms-marketing-key',
      }),
    ).rejects.toMatchObject({
      code: 'OPTED_OUT',
    } satisfies Partial<IntegrationError>);
    await expect(suite.sms.getSmsDelivery(receipt.providerId)).resolves.toEqual(receipt);
  });

  it('creates deterministic payment artifacts and detects idempotency conflicts', async () => {
    const suite = createSandboxIntegrationSuite();
    const request = {
      companyId: 'company-1',
      customerId: 'customer-1',
      quoteId: 'quote-1',
      lines: [
        {
          description: 'House soft wash',
          quantity: 1,
          unitAmount: { amount: '325.00', currency: 'USD' as const },
        },
        {
          description: 'Gutter exterior brightening',
          quantity: 2,
          unitAmount: { amount: '25.00', currency: 'USD' as const },
        },
      ],
      successUrl: 'https://example.test/success',
      cancelUrl: 'https://example.test/cancel',
      idempotencyKey: 'checkout-key-1',
    };
    const first = await suite.payments.createCheckout(request);
    const replay = await suite.payments.createCheckout(request);
    expect(first.total).toEqual({ amount: '375.00', currency: 'USD' });
    expect(replay).toEqual(first);
    await expect(
      suite.payments.createCheckout({
        ...request,
        quoteId: 'quote-changed',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('does not fabricate weather in no-key mode', async () => {
    const suite = createSandboxIntegrationSuite();
    const forecast = await suite.weather.forecast({
      coordinates: { latitude: 33.0462, longitude: -96.9942 },
      window: {
        start: '2026-07-29T12:00:00.000Z',
        end: '2026-07-29T18:00:00.000Z',
      },
    });
    expect(forecast.periods[0]).toMatchObject({
      temperatureF: null,
      precipitationProbability: null,
      windMph: null,
    });
    expect(forecast.unknowns[0]).toContain('does not fabricate weather');
  });

  it('bounds tentative calendar holds to a 24-hour expiry contract', async () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const suite = createSandboxIntegrationSuite({ now: () => now });
    const request = {
      calendarId: 'sandbox-primary',
      title: 'Capacity hold',
      window: {
        start: '2026-07-30T14:00:00.000Z',
        end: '2026-07-30T16:00:00.000Z',
      },
      timeZone: 'America/Chicago',
      jobId: 'job-1',
      idempotencyKey: 'calendar-hold-1',
      expiresAt: '2026-07-28T13:00:00.000Z',
    };
    await expect(suite.calendar.createHold(request)).resolves.toMatchObject({
      kind: 'hold',
      status: 'tentative',
      expiresAt: request.expiresAt,
    });
    await expect(
      suite.calendar.createHold({
        ...request,
        idempotencyKey: 'calendar-hold-2',
        expiresAt: '2026-07-29T13:00:00.001Z',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_HOLD_EXPIRY' });
  });

  it('exports a quoted, checksummed QuickBooks CSV', async () => {
    const suite = createSandboxIntegrationSuite();
    const result = await suite.accounting.exportInvoice({
      invoiceNumber: 'INV-1001',
      customerName: 'Acme, LLC',
      customerEmail: 'billing@example.test',
      issuedDate: '2026-07-28',
      dueDate: '2026-08-04',
      lines: [
        {
          description: 'Soft wash "premium"',
          quantity: 1,
          unitAmount: { amount: '250.00', currency: 'USD' },
        },
      ],
      tax: { amount: '20.63', currency: 'USD' },
      idempotencyKey: 'qbo-export-key',
    });
    expect(result.content).toContain('"Acme, LLC"');
    expect(result.content).toContain('"Soft wash ""premium"""');
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reports every sandbox capability healthy without credentials', async () => {
    const suite = createSandboxIntegrationSuite();
    const result = await new IntegrationHealthService(listSuiteIntegrations(suite)).checkAll();
    expect(result.overall).toBe('healthy');
    expect(result.providers).toHaveLength(11);
    expect(result.providers.every((provider) => provider.mode === 'sandbox')).toBe(true);
  });

  it('reports missing live secrets without exposing configured values', () => {
    const result = assessIntegrationEnvironment({
      OPENAI_LIVE_ENABLED: 'true',
      OPENAI_API_KEY: 'should-never-appear',
    });
    const openai = result.find((provider) => provider.provider === 'openai');
    expect(openai).toMatchObject({
      mode: 'disabled',
      status: 'not_configured',
      requiredEnvironment: ['OPENAI_LIVE_ENABLED', 'OPENAI_MODE'],
    });
    expect(JSON.stringify(result)).not.toContain('should-never-appear');
  });

  it('refuses a signed-target bucket that drifts from the core job-media boundary', () => {
    const storage = assessIntegrationEnvironment({
      SIGNED_STORAGE_TARGETS_MODE: 'live',
      SIGNED_STORAGE_TARGETS_LIVE_ENABLED: 'true',
      SUPABASE_URL: 'https://supabase.example',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-redacted',
      STORAGE_BUCKET_JOB_PHOTOS: 'other-bucket',
    }).find((provider) => provider.provider === 'signed_storage_targets');
    expect(storage).toMatchObject({
      mode: 'disabled',
      status: 'not_configured',
      requiredEnvironment: [
        'SIGNED_STORAGE_TARGETS_LIVE_ENABLED',
        'SIGNED_STORAGE_TARGETS_MODE',
        'STORAGE_BUCKET_JOB_PHOTOS',
      ],
    });
    expect(JSON.stringify(storage)).not.toContain('service-role-redacted');
  });

  it.each([
    ['sandbox', 'false', 'sandbox', 'healthy'],
    ['sandbox', 'true', 'disabled', 'not_configured'],
    ['live', 'false', 'disabled', 'not_configured'],
    ['live', 'true', 'live', 'degraded'],
    ['disabled', 'false', 'disabled', 'not_configured'],
    ['disabled', 'true', 'disabled', 'not_configured'],
  ] as const)(
    'assesses Stripe mode=%s and flag=%s as %s/%s',
    (mode, flag, expectedMode, expectedStatus) => {
      const [stripe] = assessIntegrationEnvironment({
        STRIPE_MODE: mode,
        STRIPE_LIVE_ENABLED: flag,
        STRIPE_SECRET_KEY: 'stripe-redacted',
        STRIPE_WEBHOOK_SECRET: 'webhook-redacted',
        STRIPE_CHECKOUT_SUCCESS_URL: 'https://storyops.example/success',
        STRIPE_CHECKOUT_CANCEL_URL: 'https://storyops.example/cancel',
        SUPABASE_URL: 'https://supabase.example',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-redacted',
      }).filter((provider) => provider.provider === 'stripe');
      expect(stripe).toMatchObject({
        mode: expectedMode,
        status: expectedStatus,
      });
      for (const secret of ['stripe-redacted', 'webhook-redacted', 'service-role-redacted']) {
        expect(JSON.stringify(stripe)).not.toContain(secret);
      }
    },
  );
});
