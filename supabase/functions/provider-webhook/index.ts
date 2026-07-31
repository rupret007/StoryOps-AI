import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  intakeReceiptPayload,
  normalizeTwilioLeadIntake,
  type NormalizedLeadIntake,
} from '../../../src/core/intake/index.ts';
import {
  ProviderReconciliationError,
  parseEmailReconciliation,
  parseStripeReconciliation,
  parseTwilioReconciliation,
  type DeliveryReconciliation,
  type StripeReconciliation,
} from '../../../src/core/integrations/providerReconciliation.ts';
import { IntegrationError } from '../../../src/core/integrations/contracts.ts';
import {
  parseWebhookJson,
  sha256TextHex,
  verifyStripeWebhook,
  verifyTimestampedHmacWebhook,
  verifyTwilioWebhook,
} from '../../../src/core/integrations/webhooks.ts';
import { HttpError, errorResponse, jsonResponse, readTextBody } from '../_shared/http.ts';
import { assertProviderInvocation } from '../_shared/provider-authorization.ts';
import { resolveProviderWebhookActivation, type ProviderWebhookKind } from './activation.ts';
import { routeTwilioWebhook } from './routing.ts';
import {
  LeadIntakePersistenceError,
  loadStoryOpsLeadIntakeReceipt,
  persistStoryOpsLeadIntake,
} from '../lead-intake/persistence.ts';
import { enforceLeadIntakeRateLimits } from '../lead-intake/rateLimit.ts';

type JsonObject = Record<string, unknown>;

type WebhookEnvelope = {
  provider: 'stripe' | 'twilio' | 'email';
  providerEventId: string;
  eventType: string;
  companyId: string;
  receipt: JsonObject;
  consentSignal: 'opt_out' | 'opt_in' | 'none';
  stripe?: StripeReconciliation;
  delivery?: DeliveryReconciliation;
  intake?: NormalizedLeadIntake;
};

type WebhookClaim = {
  eventId: string;
  claimed: boolean;
  status: string;
};

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required server environment variable ${name}.`);
  return value;
}

function providerKind(value: string): ProviderWebhookKind {
  if (value === 'stripe' || value === 'twilio' || value === 'email') return value;
  throw new HttpError('Provider must be stripe, twilio, or email.', 400, 'INVALID_PROVIDER');
}

function assertSandboxRequest(request: Request): void {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (
    !['localhost', '127.0.0.1', '::1'].includes(hostname) ||
    request.headers.get('x-storyops-sandbox')?.toLowerCase() !== 'true'
  ) {
    throw new HttpError(
      'Sandbox provider callbacks are local-only and require the explicit sandbox header.',
      403,
      'SANDBOX_LOCAL_ONLY',
    );
  }
}

function objectRows(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is JsonObject =>
          entry !== null && typeof entry === 'object' && !Array.isArray(entry),
      )
    : [];
}

function stringField(row: JsonObject, field: string): string {
  if (typeof row[field] !== 'string') {
    throw new ProviderReconciliationError(
      `Trusted RPC returned an invalid ${field}.`,
      'INVALID_DATABASE_RESULT',
    );
  }
  return row[field];
}

function parseClaim(value: unknown): WebhookClaim {
  const rows = objectRows(value);
  if (rows.length !== 1 || typeof rows[0]?.claimed !== 'boolean') {
    throw new ProviderReconciliationError(
      'Webhook claim RPC returned an invalid result.',
      'INVALID_DATABASE_RESULT',
    );
  }
  return {
    eventId: stringField(rows[0], 'event_id'),
    claimed: rows[0].claimed,
    status: stringField(rows[0], 'existing_status'),
  };
}

function parseDisposition(value: unknown): 'processed' | 'ignored' {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderReconciliationError(
      'Provider reconciliation RPC returned an invalid result.',
      'INVALID_DATABASE_RESULT',
    );
  }
  const disposition = (value as JsonObject).disposition;
  if (disposition !== 'processed' && disposition !== 'ignored') {
    throw new ProviderReconciliationError(
      'Provider reconciliation RPC returned an invalid disposition.',
      'INVALID_DATABASE_RESULT',
    );
  }
  return disposition;
}

function parseProviderJson(rawBody: string): JsonObject {
  try {
    return parseWebhookJson(rawBody);
  } catch (error) {
    if (error instanceof IntegrationError) {
      throw new HttpError(
        error.message,
        error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400,
        error.code,
      );
    }
    throw error;
  }
}

async function parseEnvelope(
  request: Request,
  provider: string,
  rawBody: string,
): Promise<WebhookEnvelope> {
  if (provider === 'stripe') {
    const verification = await verifyStripeWebhook({
      rawBody,
      signatureHeader: request.headers.get('stripe-signature') ?? '',
      signingSecret: requiredEnvironment('STRIPE_WEBHOOK_SECRET'),
    });
    if (!verification.valid) {
      throw new HttpError(
        'Stripe webhook signature is invalid or stale.',
        401,
        'INVALID_SIGNATURE',
      );
    }
    let stripe: StripeReconciliation;
    try {
      stripe = parseStripeReconciliation(parseProviderJson(rawBody));
    } catch (error) {
      if (error instanceof ProviderReconciliationError) {
        throw new HttpError(error.message, 400, error.code);
      }
      throw error;
    }
    return {
      provider: 'stripe',
      providerEventId: stripe.providerEventId,
      eventType: stripe.eventType,
      companyId: stripe.companyId,
      receipt: stripe.receipt,
      consentSignal: 'none',
      stripe,
    };
  }

  if (provider === 'twilio') {
    const form = Object.fromEntries(new URLSearchParams(rawBody));
    const valid = await verifyTwilioWebhook({
      canonicalUrl: requiredEnvironment('TWILIO_WEBHOOK_URL'),
      form,
      signature: request.headers.get('x-twilio-signature') ?? '',
      authToken: requiredEnvironment('TWILIO_AUTH_TOKEN'),
    });
    if (!valid) {
      throw new HttpError('Twilio webhook signature is invalid.', 401, 'INVALID_SIGNATURE');
    }
    const companyId = requiredEnvironment('TWILIO_COMPANY_ID');
    const routing = routeTwilioWebhook(form);
    const delivery = await parseTwilioReconciliation(routing.reconciliationForm, companyId);
    const intake = routing.inboundIntake
      ? normalizeTwilioLeadIntake(form, companyId, new Date(delivery.occurredAt))
      : undefined;
    return {
      provider: 'twilio',
      providerEventId: intake?.providerEventId ?? delivery.providerEventId,
      eventType: intake?.eventType ?? delivery.eventType,
      companyId: delivery.companyId,
      receipt: intake ? intakeReceiptPayload(intake) : delivery.receipt,
      consentSignal: delivery.consentSignal,
      delivery,
      ...(intake ? { intake } : {}),
    };
  }

  if (provider === 'email') {
    const verification = await verifyTimestampedHmacWebhook({
      rawBody,
      signatureHeader: request.headers.get('x-storyops-signature') ?? '',
      signingSecret: requiredEnvironment('EMAIL_WEBHOOK_SECRET'),
    });
    if (!verification.valid) {
      throw new HttpError('Email webhook signature is invalid or stale.', 401, 'INVALID_SIGNATURE');
    }
    let delivery: DeliveryReconciliation;
    try {
      delivery = parseEmailReconciliation(parseProviderJson(rawBody));
    } catch (error) {
      if (error instanceof ProviderReconciliationError) {
        throw new HttpError(error.message, 400, error.code);
      }
      throw error;
    }
    return {
      provider: 'email',
      providerEventId: delivery.providerEventId,
      eventType: delivery.eventType,
      companyId: delivery.companyId,
      receipt: delivery.receipt,
      consentSignal: 'none',
      delivery,
    };
  }

  throw new HttpError('Provider must be stripe, twilio, or email.', 400, 'INVALID_PROVIDER');
}

async function markFailed(
  client: SupabaseClient,
  claim: WebhookClaim,
  payloadHash: string,
  processingLeaseId: string,
  errorCode: string,
): Promise<void> {
  const { error } = await client.rpc('fail_storyops_intake_webhook', {
    p_event_id: claim.eventId,
    p_payload_hash: payloadHash,
    p_processing_lease_id: processingLeaseId,
    p_error: errorCode,
  });
  if (error) {
    throw new ProviderReconciliationError(
      'Provider reconciliation and durable failure recording both failed.',
      'WEBHOOK_FAILURE_RECORD_FAILED',
    );
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }

  try {
    const provider = providerKind(new URL(request.url).searchParams.get('provider') ?? '');
    const activation = resolveProviderWebhookActivation(Deno.env.toObject(), provider);
    if (activation.runtimeMode === 'disabled') {
      throw new HttpError(
        `${provider} callback ingress is disabled or its two-part activation is incomplete.`,
        503,
        'PROVIDER_WEBHOOK_DISABLED',
      );
    }
    if (activation.runtimeMode === 'sandbox') assertSandboxRequest(request);
    const rawBody = await readTextBody(request, 1_000_000);
    const envelope = await parseEnvelope(request, provider, rawBody);
    const serviceClient = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const payloadHash = await sha256TextHex(rawBody);
    const { data, error } = await serviceClient.rpc('claim_webhook_event', {
      p_provider: envelope.provider,
      p_provider_event_id: envelope.providerEventId,
      p_event_type: envelope.eventType,
      p_payload_hash: payloadHash,
      p_payload: envelope.receipt,
      p_company_id: envelope.companyId,
    });
    if (error) {
      if (/provider event id reused/iu.test(error.message)) {
        throw new HttpError(
          'Provider event ID was reused with a different scope or payload.',
          409,
          'WEBHOOK_REPLAY_CONFLICT',
        );
      }
      throw new ProviderReconciliationError(
        'Durable provider-event claim failed.',
        'WEBHOOK_CLAIM_FAILED',
      );
    }
    const claim = parseClaim(data);

    if (!claim.claimed && ['processed', 'ignored'].includes(claim.status)) {
      const intakeReceipt =
        envelope.intake && claim.status === 'processed'
          ? await loadStoryOpsLeadIntakeReceipt(
              serviceClient,
              envelope.intake,
              claim.eventId,
              payloadHash,
            )
          : undefined;
      return jsonResponse({
        accepted: true,
        duplicate: true,
        eventId: claim.eventId,
        status: claim.status,
        consentSignal: envelope.consentSignal,
        ...(intakeReceipt
          ? {
              subjectType: intakeReceipt.subjectType,
              leadId: intakeReceipt.leadId,
              customerId: intakeReceipt.customerId,
            }
          : {}),
      });
    }

    if (
      activation.runtimeMode === 'live' &&
      envelope.intake &&
      envelope.intake.consentSignal !== 'opt_out'
    ) {
      await assertProviderInvocation(serviceClient, {
        companyId: envelope.companyId,
        provider: 'twilio',
        capability: 'sms_voice',
        operationClass: 'launch_start',
      });
    }

    const { data: processingLeaseId, error: startError } = await serviceClient.rpc(
      'start_storyops_intake_processing',
      {
        p_event_id: claim.eventId,
        p_payload_hash: payloadHash,
      },
    );
    if (startError) {
      throw new ProviderReconciliationError(
        'Durable provider-event processing lease failed.',
        'WEBHOOK_START_FAILED',
      );
    }
    if (typeof processingLeaseId !== 'string') {
      return jsonResponse(
        {
          accepted: false,
          duplicate: true,
          eventId: claim.eventId,
          status: 'processing',
          code: 'WEBHOOK_PROCESSING_BUSY',
        },
        503,
        { 'retry-after': '5' },
      );
    }

    let disposition: 'processed' | 'ignored';
    let intakeReceipt: Awaited<ReturnType<typeof persistStoryOpsLeadIntake>> | undefined;
    if (envelope.intake) {
      try {
        if (envelope.intake.consentSignal === 'none') {
          await enforceLeadIntakeRateLimits(serviceClient, envelope.intake, Deno.env.toObject());
        }
        intakeReceipt = await persistStoryOpsLeadIntake(
          serviceClient,
          envelope.intake,
          claim.eventId,
          payloadHash,
          processingLeaseId,
        );
        disposition = 'processed';
      } catch (error) {
        const errorCode =
          error instanceof HttpError || error instanceof LeadIntakePersistenceError
            ? error.code
            : 'DATABASE_INTAKE_PERSISTENCE_FAILED';
        await markFailed(serviceClient, claim, payloadHash, processingLeaseId, errorCode);
        if (error instanceof LeadIntakePersistenceError) {
          throw new HttpError(error.message, error.status, error.code);
        }
        throw error;
      }
    } else {
      const { data: reconciliation, error: reconciliationError } = await serviceClient.rpc(
        'reconcile_provider_webhook',
        {
          p_event_id: claim.eventId,
          p_payload_hash: payloadHash,
          p_company_id: envelope.companyId,
          p_provider: envelope.provider,
          p_reconciliation: envelope.receipt,
        },
      );
      if (reconciliationError) {
        await markFailed(
          serviceClient,
          claim,
          payloadHash,
          processingLeaseId,
          'DATABASE_RECONCILIATION_FAILED',
        );
        throw new HttpError(
          'Verified provider event could not be reconciled.',
          500,
          'DATABASE_RECONCILIATION_FAILED',
        );
      }

      try {
        disposition = parseDisposition(reconciliation);
      } catch {
        await markFailed(
          serviceClient,
          claim,
          payloadHash,
          processingLeaseId,
          'INVALID_DATABASE_RESULT',
        );
        throw new HttpError(
          'Verified provider event could not be reconciled.',
          500,
          'INVALID_DATABASE_RESULT',
        );
      }
    }

    const { error: completeError } = await serviceClient.rpc('complete_storyops_intake_webhook', {
      p_event_id: claim.eventId,
      p_payload_hash: payloadHash,
      p_processing_lease_id: processingLeaseId,
      p_disposition: disposition,
    });
    if (completeError) {
      await markFailed(
        serviceClient,
        claim,
        payloadHash,
        processingLeaseId,
        'WEBHOOK_COMPLETE_FAILED',
      );
      throw new HttpError(
        'Verified provider event reconciliation could not be completed.',
        500,
        'WEBHOOK_COMPLETE_FAILED',
      );
    }

    return jsonResponse({
      accepted: true,
      duplicate: false,
      eventId: claim.eventId,
      status: disposition,
      consentSignal: envelope.consentSignal,
      ...(intakeReceipt
        ? {
            subjectType: intakeReceipt.subjectType,
            leadId: intakeReceipt.leadId,
            customerId: intakeReceipt.customerId,
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof LeadIntakePersistenceError) {
      return jsonResponse({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof ProviderReconciliationError) {
      return jsonResponse(
        {
          error: 'Verified provider event could not be processed.',
          code: error.code,
        },
        500,
      );
    }
    return errorResponse(error);
  }
});
