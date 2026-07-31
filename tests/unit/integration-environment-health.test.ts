import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSchedulingEvidenceGateHealth,
  checkIntegrationEnvironmentHealth,
  checkIntegrationProviderEnvironmentHealth,
} from '@/core/integrations/environmentHealth';
import type { IntegrationHealth } from '@/core/integrations/contracts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function providerHealth(
  provider: string,
  status: IntegrationHealth['status'] = 'healthy',
  mode: IntegrationHealth['mode'] = 'live',
): IntegrationHealth {
  return {
    provider,
    capability: `${provider}_capability`,
    mode,
    status,
    checkedAt: '2026-07-29T12:00:00.000Z',
    latencyMs: 12,
    message: `${provider} test status`,
    requiredEnvironment: [],
  };
}

describe('independent integration environment health', () => {
  it('still probes a configured live Stripe adapter when email is not configured', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://api.stripe.com/v1/balance') {
        return new Response(JSON.stringify({ available: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected provider probe: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkIntegrationEnvironmentHealth({
      EMAIL_MODE: 'live',
      EMAIL_LIVE_ENABLED: 'true',
      STRIPE_MODE: 'live',
      STRIPE_LIVE_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'stripe-secret-must-not-leak',
      STRIPE_WEBHOOK_SECRET: 'stripe-webhook-must-not-leak',
      STRIPE_CHECKOUT_SUCCESS_URL: 'https://storyops.example/payment/success',
      STRIPE_CHECKOUT_CANCEL_URL: 'https://storyops.example/payment/cancel',
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-must-not-leak',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.providers.find((provider) => provider.provider === 'stripe')).toMatchObject({
      capability: 'payments',
      mode: 'live',
      status: 'healthy',
      probeEvidence: {
        schemaVersion: 'storyops-integration-probe-evidence-v1',
        basis: 'external_read',
        operation: 'stripe.balance.retrieve',
        responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(result.providers.find((provider) => provider.provider === 'email')).toMatchObject({
      capability: 'email',
      mode: 'disabled',
      status: 'not_configured',
    });
    expect(
      result.providers.find((provider) => provider.provider === 'scheduling_evidence_gate'),
    ).toMatchObject({
      mode: 'sandbox',
      status: 'healthy',
    });
    for (const secret of [
      'stripe-secret-must-not-leak',
      'stripe-webhook-must-not-leak',
      'service-role-must-not-leak',
    ]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('does not fetch or emit canary evidence for a configuration-only provider status', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkIntegrationProviderEnvironmentHealth(
      {
        STRIPE_MODE: 'live',
        STRIPE_LIVE_ENABLED: 'true',
      },
      'stripe',
      'payments',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: 'stripe',
      capability: 'payments',
      mode: 'disabled',
      status: 'not_configured',
    });
    expect(result.probeEvidence).toBeUndefined();
  });

  it('targeted canary probes only the reserved provider capability', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url !== 'https://api.stripe.com/v1/balance') {
        throw new Error(`Unexpected provider probe: ${url}`);
      }
      return new Response(JSON.stringify({ available: [{ currency: 'usd' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkIntegrationProviderEnvironmentHealth(
      {
        STRIPE_MODE: 'live',
        STRIPE_LIVE_ENABLED: 'true',
        STRIPE_SECRET_KEY: 'stripe-secret',
        STRIPE_WEBHOOK_SECRET: 'stripe-webhook',
        STRIPE_CHECKOUT_SUCCESS_URL: 'https://storyops.example/payment/success',
        STRIPE_CHECKOUT_CANCEL_URL: 'https://storyops.example/payment/cancel',
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role',
        OPENAI_MODE: 'live',
        OPENAI_LIVE_ENABLED: 'true',
        OPENAI_API_KEY: 'must-not-be-probed',
        OPENAI_MODEL: 'must-not-be-probed',
      },
      'stripe',
      'payments',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.probeEvidence).toMatchObject({
      basis: 'external_read',
      operation: 'stripe.balance.retrieve',
      responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('probes Supabase Auth identity invitations with a read-only admin call and two switches', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe('https://project.supabase.co/auth/v1/admin/users?page=1&per_page=1');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({
        apikey: 'service-role-must-not-leak',
        authorization: 'Bearer service-role-must-not-leak',
      });
      return new Response(JSON.stringify({ users: [], aud: 'authenticated' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const defaultDisabled = await checkIntegrationProviderEnvironmentHealth(
      {},
      'supabase_auth',
      'identity_invitation',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(defaultDisabled).toMatchObject({
      mode: 'disabled',
      status: 'not_configured',
    });

    const disabled = await checkIntegrationProviderEnvironmentHealth(
      {
        STORYOPS_IDENTITY_INVITE_MODE: 'live',
        STORYOPS_IDENTITY_INVITE_LIVE_ENABLED: 'false',
      },
      'supabase_auth',
      'identity_invitation',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(disabled).toMatchObject({ mode: 'disabled', status: 'not_configured' });

    const result = await checkIntegrationProviderEnvironmentHealth(
      {
        STORYOPS_IDENTITY_INVITE_MODE: 'live',
        STORYOPS_IDENTITY_INVITE_LIVE_ENABLED: 'true',
        STORYOPS_IDENTITY_INVITE_REDIRECT_URL: 'https://ops.example.com/access',
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-must-not-leak',
      },
      'supabase_auth',
      'identity_invitation',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      provider: 'supabase_auth',
      capability: 'identity_invitation',
      mode: 'live',
      status: 'healthy',
      probeEvidence: {
        schemaVersion: 'storyops-integration-probe-evidence-v1',
        basis: 'external_read',
        operation: 'supabase_auth.admin_directory.retrieve',
        responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(JSON.stringify(result)).not.toContain('service-role-must-not-leak');
  });

  it('probes the vision model when only photo-analysis live activation is enabled', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://api.openai.com/v1/models/vision-pilot-model') {
        return new Response(JSON.stringify({ id: 'vision-pilot-model' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected provider probe: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkIntegrationEnvironmentHealth({
      OPENAI_MODE: 'live',
      OPENAI_LIVE_ENABLED: 'false',
      OPENAI_VISION_LIVE_ENABLED: 'true',
      OPENAI_API_KEY: 'vision-api-key-must-not-leak',
      OPENAI_VISION_MODEL: 'vision-pilot-model',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      result.providers.find(
        (provider) => provider.provider === 'openai' && provider.capability === 'photo_analysis',
      ),
    ).toMatchObject({
      mode: 'live',
      status: 'healthy',
    });
    expect(
      result.providers.find(
        (provider) => provider.provider === 'openai' && provider.capability === 'structured_ai',
      ),
    ).toMatchObject({
      mode: 'disabled',
      status: 'not_configured',
    });
    expect(JSON.stringify(result)).not.toContain('vision-api-key-must-not-leak');
  });

  it('reports scheduling readiness from the dual gate and all four live components', () => {
    const environment = {
      SCHEDULING_EVIDENCE_MODE: 'live',
      SCHEDULING_EVIDENCE_LIVE_ENABLED: 'true',
    };
    const components = [
      providerHealth('google_calendar'),
      providerHealth('maps'),
      providerHealth('nws'),
      providerHealth('vroom'),
    ];

    expect(buildSchedulingEvidenceGateHealth(environment, components)).toMatchObject({
      provider: 'scheduling_evidence_gate',
      capability: 'calendar_weather_route_booking_evidence',
      mode: 'live',
      status: 'healthy',
    });
    expect(
      buildSchedulingEvidenceGateHealth(environment, [
        ...components.filter((component) => component.provider !== 'nws'),
        providerHealth('nws', 'down'),
      ]),
    ).toMatchObject({
      mode: 'live',
      status: 'down',
      message: expect.stringContaining('nws:down'),
    });
    expect(
      buildSchedulingEvidenceGateHealth(environment, [
        ...components.filter((component) => component.provider !== 'maps'),
        providerHealth('maps', 'healthy', 'sandbox'),
      ]),
    ).toMatchObject({
      mode: 'live',
      status: 'not_configured',
      message: expect.stringContaining('maps'),
    });
  });
});
