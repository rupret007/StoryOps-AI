import { z } from 'zod';

export const goldenPathRequestSchema = z
  .object({
    companyId: z.string().uuid(),
    action: z.literal('deposit.checkout'),
    commandId: z.string().uuid(),
    entityId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export type GoldenPathRequest = z.infer<typeof goldenPathRequestSchema>;

export const depositCheckoutClaimSchema = z.discriminatedUnion('claimStatus', [
  z
    .object({
      claimStatus: z.literal('completed'),
      storedResponse: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      claimStatus: z.literal('reserved'),
      requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
      quoteId: z.string().uuid(),
      customerId: z.string().uuid(),
      jobId: z.string().uuid(),
      invoiceId: z.string().uuid(),
      paymentId: z.string().uuid(),
      amount: z.string().regex(/^\d+\.\d{2}$/u),
      currency: z.literal('USD'),
      description: z.string().min(1).max(255),
      providerIdempotencyKey: z.string().min(1).max(255),
    })
    .strict(),
]);

export const depositCheckoutResponseSchema = z
  .object({
    action: z.literal('deposit.checkout'),
    status: z.enum(['checkout_open', 'not_required', 'already_verified']),
    mode: z.enum(['live', 'sandbox', 'none']),
    quoteId: z.string().uuid(),
    jobId: z.string().uuid(),
    invoiceId: z.string().uuid(),
    amount: z.string().regex(/^\d+\.\d{2}$/u),
    currency: z.literal('USD'),
    paymentVerified: z.boolean(),
    depositReady: z.boolean(),
    replayed: z.boolean(),
    checkoutId: z.string().startsWith('cs_').optional(),
    checkoutUrl: z.string().url().optional(),
    sandboxReceipt: z.string().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'checkout_open') {
      if (!value.checkoutId) {
        context.addIssue({
          code: 'custom',
          path: ['checkoutId'],
          message: 'Open checkout requires a provider checkout ID.',
        });
      }
      if (value.mode === 'live' && !value.checkoutUrl) {
        context.addIssue({
          code: 'custom',
          path: ['checkoutUrl'],
          message: 'Live checkout requires a hosted checkout URL.',
        });
      }
      if (value.mode === 'sandbox' && !value.sandboxReceipt) {
        context.addIssue({
          code: 'custom',
          path: ['sandboxReceipt'],
          message: 'Sandbox checkout requires an explicit sandbox receipt.',
        });
      }
      if (value.paymentVerified) {
        context.addIssue({
          code: 'custom',
          path: ['paymentVerified'],
          message: 'Opening checkout never verifies payment.',
        });
      }
      if (value.depositReady) {
        context.addIssue({
          code: 'custom',
          path: ['depositReady'],
          message: 'Opening checkout never makes a deposit ready.',
        });
      }
    }
    if (value.status === 'not_required' && (value.paymentVerified || !value.depositReady)) {
      context.addIssue({
        code: 'custom',
        path: ['paymentVerified'],
        message: 'A zero-deposit quote is ready without asserting payment verification.',
      });
    }
    if (value.status === 'already_verified' && (!value.paymentVerified || !value.depositReady)) {
      context.addIssue({
        code: 'custom',
        path: ['paymentVerified'],
        message: 'An already verified deposit requires provider-backed readiness.',
      });
    }
  });

export type DepositCheckoutResponse = z.infer<typeof depositCheckoutResponseSchema>;

export function safeCheckoutErrorCode(error: unknown): string {
  const source =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.name
        : 'CHECKOUT_FAILED';
  return (
    source
      .toUpperCase()
      .replace(/[^A-Z0-9_]/gu, '_')
      .slice(0, 120) || 'CHECKOUT_FAILED'
  );
}
