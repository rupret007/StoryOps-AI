import { describe, expect, it } from 'vitest';
import { SupabaseStripeCustomerResolver } from '@/core/integrations/stripeCustomerResolver';

const companyId = '10000000-0000-4000-8000-000000000001';
const customerId = '10000000-0000-4000-8000-000000000201';
const identityFingerprint = 'a'.repeat(64);

describe('Stripe customer RPC boundary', () => {
  it('resolves and saves only through bounded service RPC evidence', async () => {
    const calls: Array<{ functionName: string; parameters: Record<string, unknown> }> = [];
    const client = {
      rpc: async (functionName: string, parameters: Record<string, unknown>) => {
        calls.push({ functionName, parameters });
        if (functionName === 'resolve_stripe_billing_identity') {
          return {
            data: [
              {
                eligible: true,
                decision_code: 'ELIGIBLE',
                customer_id: customerId,
                billing_name: 'Morgan Ellis',
                billing_email: 'morgan@example.com',
                provider_customer_id: null,
                identity_fingerprint: identityFingerprint,
              },
            ],
            error: null,
          };
        }
        return {
          data: [
            {
              saved: true,
              decision_code: 'SAVED',
              mapping_id: '10000000-0000-4000-8000-000000000299',
              provider_customer_id: 'cus_storyops123',
            },
          ],
          error: null,
        };
      },
    };
    const resolver = new SupabaseStripeCustomerResolver(client as never);

    const identity = await resolver.resolve(companyId, customerId);
    expect(identity).toEqual({
      companyId,
      customerId,
      name: 'Morgan Ellis',
      email: 'morgan@example.com',
      identityFingerprint,
      stripeCustomerId: undefined,
    });
    await resolver.save({ ...identity, stripeCustomerId: 'cus_storyops123' });

    expect(calls.map((call) => call.functionName)).toEqual([
      'resolve_stripe_billing_identity',
      'save_stripe_customer_mapping',
    ]);
    expect(calls[1]?.parameters).toEqual({
      p_company_id: companyId,
      p_customer_id: customerId,
      p_provider_customer_id: 'cus_storyops123',
      p_identity_fingerprint: identityFingerprint,
    });
    expect(JSON.stringify(calls[1]?.parameters)).not.toContain('Morgan');
    expect(JSON.stringify(calls[1]?.parameters)).not.toContain('@');
  });

  it('fails closed on invalid resolution and stale save decisions', async () => {
    const invalidResolver = new SupabaseStripeCustomerResolver({
      rpc: async () => ({
        data: [
          {
            eligible: false,
            decision_code: 'INVALID_MAPPING',
            customer_id: customerId,
            billing_name: null,
            billing_email: null,
            provider_customer_id: null,
            identity_fingerprint: null,
          },
        ],
        error: null,
      }),
    } as never);
    await expect(invalidResolver.resolve(companyId, customerId)).rejects.toMatchObject({
      code: 'INVALID_CUSTOMER_MAPPING',
      retryable: false,
    });

    const staleResolver = new SupabaseStripeCustomerResolver({
      rpc: async () => ({
        data: [
          {
            saved: false,
            decision_code: 'IDENTITY_STALE',
            mapping_id: null,
            provider_customer_id: null,
          },
        ],
        error: null,
      }),
    } as never);
    await expect(
      staleResolver.save({
        companyId,
        customerId,
        name: 'Morgan Ellis',
        email: 'morgan@example.com',
        identityFingerprint,
        stripeCustomerId: 'cus_storyops123',
      }),
    ).rejects.toMatchObject({
      code: 'STALE_CUSTOMER_IDENTITY',
      retryable: true,
    });
  });
});
