import { depositCheckoutResponseSchema, goldenPathRequestSchema } from './contracts.ts';
import { resolveLiveProviderActivation } from '../../../src/core/integrations/configuration.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
}

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const QUOTE_ID = '10000000-0000-4000-8000-000000000521';
const JOB_ID = '10000000-0000-4000-8000-000000000551';
const INVOICE_ID = '10000000-0000-4000-8000-000000000651';

Deno.test('Stripe checkout activation requires both switches and preserves disabled mode', () => {
  const cases = [
    { mode: 'sandbox', flag: 'false', runtimeMode: 'sandbox' },
    { mode: 'sandbox', flag: 'true', runtimeMode: 'disabled' },
    { mode: 'live', flag: 'false', runtimeMode: 'disabled' },
    { mode: 'live', flag: 'true', runtimeMode: 'live' },
    { mode: 'disabled', flag: 'false', runtimeMode: 'disabled' },
    { mode: 'disabled', flag: 'true', runtimeMode: 'disabled' },
  ] as const;
  for (const testCase of cases) {
    const activation = resolveLiveProviderActivation(
      {
        STRIPE_MODE: testCase.mode,
        STRIPE_LIVE_ENABLED: testCase.flag,
      },
      'STRIPE_LIVE_ENABLED',
      'STRIPE_MODE',
    );
    assert(
      activation.runtimeMode === testCase.runtimeMode,
      `Expected ${testCase.mode}/${testCase.flag} to resolve as ${testCase.runtimeMode}.`,
    );
  }
});

Deno.test('deposit checkout request accepts identifiers and version only', () => {
  assert(
    goldenPathRequestSchema.safeParse({
      companyId: COMPANY_ID,
      action: 'deposit.checkout',
      commandId: QUOTE_ID,
      entityId: QUOTE_ID,
      expectedVersion: 1,
    }).success,
  );
  assert(
    !goldenPathRequestSchema.safeParse({
      companyId: COMPANY_ID,
      action: 'deposit.checkout',
      commandId: QUOTE_ID,
      entityId: QUOTE_ID,
      expectedVersion: 1,
      amount: '0.01',
    }).success,
  );
});

Deno.test('opening checkout is explicitly unpaid and not deposit ready', () => {
  const sandbox = depositCheckoutResponseSchema.safeParse({
    action: 'deposit.checkout',
    status: 'checkout_open',
    mode: 'sandbox',
    quoteId: QUOTE_ID,
    jobId: JOB_ID,
    invoiceId: INVOICE_ID,
    amount: '132.00',
    currency: 'USD',
    paymentVerified: false,
    depositReady: false,
    replayed: false,
    checkoutId: 'cs_sandbox_storyops',
    sandboxReceipt: 'Sandbox only; no payment was recorded.',
  });
  assert(sandbox.success);
  assert(
    !depositCheckoutResponseSchema.safeParse({
      ...sandbox.data,
      paymentVerified: true,
    }).success,
  );
  assert(
    !depositCheckoutResponseSchema.safeParse({
      ...sandbox.data,
      depositReady: true,
    }).success,
  );
});

Deno.test('zero-deposit readiness never fabricates payment verification', () => {
  assert(
    depositCheckoutResponseSchema.safeParse({
      action: 'deposit.checkout',
      status: 'not_required',
      mode: 'none',
      quoteId: QUOTE_ID,
      jobId: JOB_ID,
      invoiceId: INVOICE_ID,
      amount: '0.00',
      currency: 'USD',
      paymentVerified: false,
      depositReady: true,
      replayed: false,
    }).success,
  );
});
