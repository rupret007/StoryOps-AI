import { createClient } from '@supabase/supabase-js';
import { Decimal } from 'decimal.js';
import { createServerIntegrationSuite } from '../../../src/core/integrations/liveServer.ts';
import { resolveLiveProviderActivation } from '../../../src/core/integrations/configuration.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import {
  depositCheckoutClaimSchema,
  depositCheckoutResponseSchema,
  goldenPathRequestSchema,
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
      'GOLDEN_PATH_MEMBERSHIP_REQUIRED',
      403,
      'FORBIDDEN',
      'An active company membership is required.',
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

    const { data, error } = await serviceClient.rpc('prepare_storyops_deposit_checkout', {
      p_company_id: companyId,
      p_actor_user_id: user.id,
      p_command_id: commandId,
      p_quote_id: parsed.data.entityId,
      p_expected_version: parsed.data.expectedVersion,
    });
    if (error) throw checkoutHttpError(error.message);
    const claim = depositCheckoutClaimSchema.parse(data);
    if (claim.claimStatus === 'completed') {
      const replay = depositCheckoutResponseSchema.parse({
        ...claim.storedResponse,
        replayed: true,
      });
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

    const document = await suite.payments.createCheckout({
      companyId,
      customerId: claim.customerId,
      quoteId: claim.quoteId,
      lines: [
        {
          description: claim.description,
          quantity: 1,
          unitAmount: { amount: claim.amount, currency: 'USD' },
        },
      ],
      idempotencyKey: claim.providerIdempotencyKey,
    });
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

    const response = depositCheckoutResponseSchema.parse({
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

    const { error: completeError } = await serviceClient.rpc('complete_storyops_deposit_checkout', {
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
      await serviceClient.rpc('fail_storyops_deposit_checkout', {
        p_company_id: companyId,
        p_command_id: commandId,
        p_request_hash: requestHash,
        p_error_code: safeCheckoutErrorCode(error),
      });
    }
    return errorResponse(error);
  }
});
