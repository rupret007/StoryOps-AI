import { createClient } from '@supabase/supabase-js';
import { Decimal } from 'decimal.js';
import type { CreateCheckoutRequest } from '../../../src/core/integrations/contracts.ts';
import { createServerIntegrationSuite } from '../../../src/core/integrations/liveServer.ts';
import { resolveLiveProviderActivation } from '../../../src/core/integrations/configuration.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import { assertProviderInvocation } from '../_shared/provider-authorization.ts';
import {
  depositCheckoutClaimSchema,
  depositCheckoutResponseSchema,
  goldenPathRequestSchema,
  invoiceCheckoutClaimSchema,
  invoiceCheckoutResponseSchema,
  safeCheckoutErrorCode,
} from './contracts.ts';

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required server environment variable ${name}.`);
  return value;
}

function checkoutHttpError(message: string): HttpError {
  const mappings: Array<[string, number, string, string]> = [
    [
      'PAYMENT_RECONCILIATION_REQUIRED',
      409,
      'PAYMENT_RECONCILIATION_REQUIRED',
      'A verified payment needs owner reconciliation before another checkout can be opened.',
    ],
    [
      'GOLDEN_PATH_MEMBERSHIP_REQUIRED',
      403,
      'FORBIDDEN',
      'An active company membership is required.',
    ],
    [
      'EDGE_ACTOR_FORBIDDEN',
      403,
      'FORBIDDEN',
      'An active company membership with a permitted checkout role is required.',
    ],
    [
      'GOLDEN_PATH_CUSTOMER_SCOPE_REQUIRED',
      403,
      'FORBIDDEN',
      'The quote is not linked to this portal customer.',
    ],
    [
      'GOLDEN_PATH_CHECKOUT_ROLE_REQUIRED',
      403,
      'FORBIDDEN',
      'This role cannot start a deposit checkout.',
    ],
    [
      'GOLDEN_PATH_QUOTE_VERSION_CONFLICT',
      409,
      'VERSION_CONFLICT',
      'The quote changed; refresh before starting checkout.',
    ],
    [
      'GOLDEN_PATH_IDEMPOTENCY_CONFLICT',
      409,
      'IDEMPOTENCY_CONFLICT',
      'The command ID was reused for a different checkout.',
    ],
    [
      'GOLDEN_PATH_CHECKOUT_IN_PROGRESS',
      409,
      'CHECKOUT_IN_PROGRESS',
      'This checkout is already being prepared.',
    ],
    [
      'GOLDEN_PATH_ACCEPTED_QUOTE_REQUIRED',
      422,
      'QUOTE_NOT_PAYABLE',
      'Checkout requires a valid accepted quote.',
    ],
    [
      'GOLDEN_PATH_DETERMINISTIC_TOTAL_MISMATCH',
      422,
      'PRICE_MISMATCH',
      'The accepted deterministic pricing no longer validates.',
    ],
  ];
  const mapping = mappings.find(([needle]) => message.includes(needle));
  return mapping
    ? new HttpError(mapping[3], mapping[1], mapping[2])
    : new HttpError('Deposit checkout could not be prepared.', 422, 'CHECKOUT_NOT_ALLOWED');
}

function invoiceCheckoutHttpError(message: string): HttpError {
  const mappings: Array<[string, number, string, string]> = [
    [
      'PAYMENT_RECONCILIATION_REQUIRED',
      409,
      'PAYMENT_RECONCILIATION_REQUIRED',
      'A verified payment needs owner reconciliation before another checkout can be opened.',
    ],
    ['EDGE_ACTOR_FORBIDDEN', 403, 'FORBIDDEN', 'An active company membership is required.'],
    [
      'INVOICE_CHECKOUT_CUSTOMER_SCOPE_DENIED',
      403,
      'FORBIDDEN',
      'The invoice is not linked to this portal customer.',
    ],
    [
      'INVOICE_CHECKOUT_VERSION_CONFLICT',
      409,
      'VERSION_CONFLICT',
      'The invoice changed; refresh before starting checkout.',
    ],
    [
      'INVOICE_CHECKOUT_IDEMPOTENCY_CONFLICT',
      409,
      'IDEMPOTENCY_CONFLICT',
      'The command ID was reused for a different invoice checkout.',
    ],
    [
      'INVOICE_CHECKOUT_IN_PROGRESS',
      409,
      'CHECKOUT_IN_PROGRESS',
      'This invoice checkout is already being prepared.',
    ],
    [
      'INVOICE_CHECKOUT_NOT_PAYABLE',
      422,
      'INVOICE_NOT_PAYABLE',
      'Checkout requires an issued invoice with a current nonzero balance.',
    ],
    [
      'INVOICE_CHECKOUT_PAYMENT_CONFLICT',
      409,
      'PAYMENT_CONFLICT',
      'The invoice has an incompatible existing payment reservation.',
    ],
  ];
  const mapping = mappings.find(([needle]) => message.includes(needle));
  return mapping
    ? new HttpError(mapping[3], mapping[1], mapping[2])
    : new HttpError('Invoice checkout could not be prepared.', 422, 'INVOICE_CHECKOUT_NOT_ALLOWED');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }

  const serviceClient = createClient(
    requiredEnvironment('SUPABASE_URL'),
    requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  let companyId: string | undefined;
  let commandId: string | undefined;
  let requestHash: string | undefined;
  let action: 'deposit.checkout' | 'invoice.checkout' | undefined;

  try {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
    }
    const {
      data: { user },
      error: authError,
    } = await serviceClient.auth.getUser(authorization.slice('Bearer '.length));
    if (authError || !user) {
      throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
    }

    const rawBody = await readTextBody(request, 8_192);
    let input: unknown;
    try {
      input = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = goldenPathRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError(
        'Request must contain only a valid companyId, action, commandId, entityId, and expectedVersion.',
        400,
        'INVALID_REQUEST',
      );
    }
    companyId = parsed.data.companyId;
    commandId = parsed.data.commandId;
    action = parsed.data.action;

    const { data, error } =
      action === 'invoice.checkout'
        ? await serviceClient.rpc('prepare_storyops_invoice_checkout', {
            p_company_id: companyId,
            p_actor_user_id: user.id,
            p_command_id: commandId,
            p_invoice_id: parsed.data.entityId,
            p_expected_version: parsed.data.expectedVersion,
          })
        : await serviceClient.rpc('prepare_storyops_deposit_checkout', {
            p_company_id: companyId,
            p_actor_user_id: user.id,
            p_command_id: commandId,
            p_quote_id: parsed.data.entityId,
            p_expected_version: parsed.data.expectedVersion,
          });
    if (error) {
      throw action === 'invoice.checkout'
        ? invoiceCheckoutHttpError(error.message)
        : checkoutHttpError(error.message);
    }
    const claim =
      action === 'invoice.checkout'
        ? invoiceCheckoutClaimSchema.parse(data)
        : depositCheckoutClaimSchema.parse(data);
    if (claim.claimStatus === 'completed') {
      const replay =
        action === 'invoice.checkout'
          ? invoiceCheckoutResponseSchema.parse({
              ...claim.storedResponse,
              replayed: true,
            })
          : depositCheckoutResponseSchema.parse({
              ...claim.storedResponse,
              replayed: true,
            });
      if (replay.mode === 'live') {
        const replayActivation = resolveLiveProviderActivation(
          Deno.env.toObject(),
          'STRIPE_LIVE_ENABLED',
          'STRIPE_MODE',
        );
        if (!replayActivation.enabled) {
          throw new HttpError(
            'The prior live Checkout cannot be reopened while Stripe is deployment-disabled.',
            503,
            'PAYMENTS_REPLAY_DISABLED',
          );
        }
        await assertProviderInvocation(serviceClient, {
          companyId,
          provider: 'stripe',
          capability: 'payments',
          operationClass: 'launch_start',
        });
      }
      return jsonResponse(replay);
    }
    requestHash = claim.requestHash;

    const environment = Deno.env.toObject();
    const stripeActivation = resolveLiveProviderActivation(
      environment,
      'STRIPE_LIVE_ENABLED',
      'STRIPE_MODE',
    );
    const suite = createServerIntegrationSuite(environment);
    if (stripeActivation.runtimeMode === 'disabled' || suite.payments.mode === 'disabled') {
      throw new HttpError(
        'The payments provider is disabled or its two-part activation is incomplete.',
        503,
        'PAYMENTS_NOT_CONFIGURED',
      );
    }
    const providerMode = stripeActivation.runtimeMode;
    if (providerMode === 'live' && suite.payments.mode !== 'live') {
      throw new HttpError(
        'Live Stripe was requested but could not be configured.',
        503,
        'PAYMENTS_NOT_CONFIGURED',
      );
    }
    if (providerMode === 'live') {
      await assertProviderInvocation(serviceClient, {
        companyId,
        provider: 'stripe',
        capability: 'payments',
        operationClass: 'launch_start',
      });
    }

    let invoiceVersion: number | undefined;
    let checkoutRequest: CreateCheckoutRequest;
    if (action === 'invoice.checkout') {
      const exactInvoiceClaim = invoiceCheckoutClaimSchema.parse(data);
      if (exactInvoiceClaim.claimStatus !== 'reserved') {
        throw new HttpError(
          'The invoice checkout reservation omitted its exact invoice version.',
          502,
          'INVALID_CHECKOUT_CLAIM',
        );
      }
      invoiceVersion = exactInvoiceClaim.invoiceVersion;
      checkoutRequest = {
        companyId,
        customerId: exactInvoiceClaim.customerId,
        checkoutPurpose: 'invoice_balance',
        quoteId: exactInvoiceClaim.quoteId,
        invoiceId: exactInvoiceClaim.invoiceId,
        invoiceVersion: exactInvoiceClaim.invoiceVersion,
        checkoutAttempt: exactInvoiceClaim.checkoutAttempt,
        lines: [
          {
            description: exactInvoiceClaim.description,
            quantity: 1,
            unitAmount: { amount: exactInvoiceClaim.amount, currency: 'USD' },
          },
        ],
        idempotencyKey: exactInvoiceClaim.providerIdempotencyKey,
      };
    } else {
      checkoutRequest = {
        companyId,
        customerId: claim.customerId,
        checkoutPurpose: 'quote_deposit',
        quoteId: claim.quoteId,
        checkoutAttempt: claim.checkoutAttempt,
        lines: [
          {
            description: claim.description,
            quantity: 1,
            unitAmount: { amount: claim.amount, currency: 'USD' },
          },
        ],
        idempotencyKey: claim.providerIdempotencyKey,
      };
    }
    const document = await suite.payments.createCheckout(checkoutRequest);
    if (
      document.kind !== 'checkout' ||
      document.status !== 'open' ||
      document.provider !== 'stripe' ||
      document.mode !== providerMode ||
      document.total.currency !== 'USD' ||
      !new Decimal(document.total.amount).eq(claim.amount) ||
      !document.providerId.startsWith('cs_')
    ) {
      throw new HttpError(
        'The payment provider returned an invalid checkout receipt.',
        502,
        'INVALID_PROVIDER_RECEIPT',
      );
    }

    const response =
      action === 'invoice.checkout'
        ? invoiceCheckoutResponseSchema.parse({
            action: 'invoice.checkout',
            status: 'checkout_open',
            mode: providerMode,
            quoteId: claim.quoteId,
            jobId: claim.jobId,
            invoiceId: claim.invoiceId,
            invoiceVersion,
            amount: new Decimal(claim.amount).toFixed(2),
            currency: 'USD',
            paymentVerified: false,
            invoicePaid: false,
            replayed: false,
            checkoutId: document.providerId,
            ...(providerMode === 'live'
              ? { checkoutUrl: document.hostedUrl }
              : {
                  sandboxReceipt:
                    'Sandbox invoice checkout prepared. No funds moved and no payment was recorded; the balance changes only after a signed live provider event.',
                }),
          })
        : depositCheckoutResponseSchema.parse({
            action: 'deposit.checkout',
            status: 'checkout_open',
            mode: providerMode,
            quoteId: claim.quoteId,
            jobId: claim.jobId,
            invoiceId: claim.invoiceId,
            amount: new Decimal(claim.amount).toFixed(2),
            currency: 'USD',
            paymentVerified: false,
            depositReady: false,
            replayed: false,
            checkoutId: document.providerId,
            ...(providerMode === 'live'
              ? { checkoutUrl: document.hostedUrl }
              : {
                  sandboxReceipt:
                    'Sandbox checkout prepared. No payment was recorded; booking remains blocked until a signed live provider event is reconciled.',
                }),
          });

    const { error: completeError } =
      action === 'invoice.checkout'
        ? await serviceClient.rpc('complete_storyops_invoice_checkout', {
            p_company_id: companyId,
            p_command_id: commandId,
            p_request_hash: requestHash,
            p_payment_id: claim.paymentId,
            p_provider_checkout_id: document.providerId,
            p_response: response,
          })
        : await serviceClient.rpc('complete_storyops_deposit_checkout', {
            p_company_id: companyId,
            p_command_id: commandId,
            p_request_hash: requestHash,
            p_payment_id: claim.paymentId,
            p_provider_checkout_id: document.providerId,
            p_response: response,
          });
    if (completeError) {
      throw new HttpError(
        'Checkout opened but its durable receipt could not be committed. Retry with the same command ID.',
        503,
        'CHECKOUT_RECEIPT_COMMIT_FAILED',
      );
    }
    return jsonResponse(response);
  } catch (error) {
    if (companyId && commandId && requestHash) {
      await serviceClient.rpc(
        action === 'invoice.checkout'
          ? 'fail_storyops_invoice_checkout'
          : 'fail_storyops_deposit_checkout',
        {
          p_company_id: companyId,
          p_command_id: commandId,
          p_request_hash: requestHash,
          p_error_code: safeCheckoutErrorCode(error),
        },
      );
    }
    return errorResponse(error);
  }
});
