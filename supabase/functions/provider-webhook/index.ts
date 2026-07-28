import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  ProviderReconciliationError,
  parseEmailReconciliation,
  parseStripeReconciliation,
  parseTwilioReconciliation,
  type DeliveryReconciliation,
  type StripeReconciliation,
} from '../../../src/core/integrations/providerReconciliation.ts';
import {
  parseWebhookJson,
  sha256TextHex,
  verifyStripeWebhook,
  verifyTimestampedHmacWebhook,
  verifyTwilioWebhook,
} from '../../../src/core/integrations/webhooks.ts';
import { HttpError, errorResponse, jsonResponse, readTextBody } from '../_shared/http.ts';

type JsonObject = Record<string, unknown>;

type StoryOpsDatabase = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: {
      claim_webhook_event: {
        Args: {
          p_provider: string;
          p_provider_event_id: string;
          p_event_type: string;
          p_payload_hash: string;
          p_payload: JsonObject;
          p_company_id: string;
        };
        Returns: Array<{
          event_id: string;
          claimed: boolean;
          existing_status: string;
        }>;
      };
      start_webhook_processing: {
        Args: { p_event_id: string; p_payload_hash: string };
        Returns: boolean;
      };
      reconcile_provider_webhook: {
        Args: {
          p_event_id: string;
          p_payload_hash: string;
          p_company_id: string;
          p_provider: string;
          p_reconciliation: JsonObject;
        };
        Returns: JsonObject;
      };
      complete_webhook_event: {
        Args: {
          p_event_id: string;
          p_payload_hash: string;
          p_disposition: string;
        };
        Returns: undefined;
      };
      fail_webhook_event: {
        Args: {
          p_event_id: string;
          p_payload_hash: string;
          p_error: string;
        };
        Returns: undefined;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type WebhookEnvelope = {
  provider: 'stripe' | 'twilio' | 'email';
  providerEventId: string;
  eventType: string;
  companyId: string;
  receipt: JsonObject;
  consentSignal: 'opt_out' | 'opt_in' | 'none';
  stripe?: StripeReconciliation;
  delivery?: DeliveryReconciliation;
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
    const stripe = parseStripeReconciliation(parseWebhookJson(rawBody));
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
    const delivery = await parseTwilioReconciliation(
      form,
      requiredEnvironment('TWILIO_COMPANY_ID'),
    );
    return {
      provider: 'twilio',
      providerEventId: delivery.providerEventId,
      eventType: delivery.eventType,
      companyId: delivery.companyId,
      receipt: delivery.receipt,
      consentSignal: delivery.consentSignal,
      delivery,
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
    const delivery = parseEmailReconciliation(parseWebhookJson(rawBody));
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
  client: SupabaseClient<StoryOpsDatabase>,
  claim: WebhookClaim,
  payloadHash: string,
  errorCode: string,
): Promise<void> {
  const { error } = await client.rpc('fail_webhook_event', {
    p_event_id: claim.eventId,
    p_payload_hash: payloadHash,
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
    const rawBody = await readTextBody(request, 1_000_000);
    const envelope = await parseEnvelope(
      request,
      new URL(request.url).searchParams.get('provider') ?? '',
      rawBody,
    );
    const serviceClient = createClient<StoryOpsDatabase>(
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
      throw new ProviderReconciliationError(
        'Durable provider-event claim failed.',
        'WEBHOOK_CLAIM_FAILED',
      );
    }
    const claim = parseClaim(data);

    if (!claim.claimed && ['processed', 'ignored', 'processing'].includes(claim.status)) {
      return jsonResponse({
        accepted: true,
        duplicate: true,
        eventId: claim.eventId,
        status: claim.status,
        consentSignal: envelope.consentSignal,
      });
    }

    const { data: started, error: startError } = await serviceClient.rpc(
      'start_webhook_processing',
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
    if (started !== true) {
      return jsonResponse({
        accepted: true,
        duplicate: true,
        eventId: claim.eventId,
        status: claim.status,
        consentSignal: envelope.consentSignal,
      });
    }

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
      await markFailed(serviceClient, claim, payloadHash, 'DATABASE_RECONCILIATION_FAILED');
      throw new HttpError(
        'Verified provider event could not be reconciled.',
        500,
        'DATABASE_RECONCILIATION_FAILED',
      );
    }

    let disposition: 'processed' | 'ignored';
    try {
      disposition = parseDisposition(reconciliation);
    } catch {
      await markFailed(serviceClient, claim, payloadHash, 'INVALID_DATABASE_RESULT');
      throw new HttpError(
        'Verified provider event could not be reconciled.',
        500,
        'INVALID_DATABASE_RESULT',
      );
    }

    const { error: completeError } = await serviceClient.rpc('complete_webhook_event', {
      p_event_id: claim.eventId,
      p_payload_hash: payloadHash,
      p_disposition: disposition,
    });
    if (completeError) {
      await markFailed(serviceClient, claim, payloadHash, 'WEBHOOK_COMPLETE_FAILED');
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
    });
  } catch (error) {
    return errorResponse(error);
  }
});
