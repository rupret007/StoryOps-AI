import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  LEAD_INTAKE_JSON_MAX_BYTES,
  LEAD_INTAKE_SANDBOX_SECRET,
  LEAD_INTAKE_TWILIO_MAX_BYTES,
  TWILIO_INTAKE_SANDBOX_TOKEN,
  intakeReceiptPayload,
  isLocalSandboxRequest,
  normalizeSignedLeadIntake,
  normalizeTwilioLeadIntake,
  parseSignedLeadIntake,
  verifySignedLeadIntake,
  type NormalizedLeadIntake,
} from '../../../src/core/intake/index.ts';
import { IntegrationError } from '../../../src/core/integrations/contracts.ts';
import { sha256TextHex, verifyTwilioWebhook } from '../../../src/core/integrations/webhooks.ts';
import { HttpError, errorResponse, jsonResponse, readTextBody } from '../_shared/http.ts';
import { assertLaunchStart, assertProviderInvocation } from '../_shared/provider-authorization.ts';
import { resolveLeadIntakeActivation } from './activation.ts';
import {
  LeadIntakePersistenceError,
  loadStoryOpsLeadIntakeReceipt,
  persistStoryOpsLeadIntake,
  type PersistedIntake,
} from './persistence.ts';
import { enforceLeadIntakeRateLimits } from './rateLimit.ts';

const DEMO_COMPANY_ID = '10000000-0000-4000-8000-000000000001';

type WebhookClaim = {
  event_id: string;
  claimed: boolean;
  existing_status: string;
};

type IdempotencyClaim = {
  claim_status: 'reserved' | 'completed' | 'in_progress' | 'conflict';
  stored_response: Record<string, unknown> | null;
};

function optionalEnvironment(name: string): string | undefined {
  return Deno.env.get(name)?.trim() || undefined;
}

function requiredEnvironment(name: string): string {
  const value = optionalEnvironment(name);
  if (!value) throw new HttpError(`Server configuration ${name} is missing.`, 503, 'MISCONFIGURED');
  return value;
}

function configuredMode(): 'sandbox' | 'live' {
  const activation = resolveLeadIntakeActivation(Deno.env.toObject());
  if (activation.runtimeMode === 'disabled') {
    throw new HttpError(
      'Lead intake is disabled or its two-part activation is incomplete.',
      503,
      'INTAKE_DISABLED',
    );
  }
  return activation.runtimeMode;
}

function isLocalSandboxBackend(value: string): boolean {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  return (
    isLocalSandboxRequest(value) ||
    (url.protocol === 'http:' &&
      (hostname === 'kong' ||
        hostname === 'host.docker.internal' ||
        hostname.startsWith('supabase_kong_')))
  );
}

function assertSandboxRequest(request: Request): void {
  const backendUrl = optionalEnvironment('SUPABASE_URL');
  if (
    !isLocalSandboxBackend(request.url) ||
    !backendUrl ||
    !isLocalSandboxBackend(backendUrl) ||
    request.headers.get('x-storyops-sandbox')?.toLowerCase() !== 'true'
  ) {
    throw new HttpError(
      'Sandbox intake is available only from the local stack with an explicit sandbox header.',
      403,
      'SANDBOX_LOCAL_ONLY',
    );
  }
}

function companyIdForRequest(mode: 'sandbox' | 'live', requestCompanyId?: string): string {
  const configured =
    optionalEnvironment('LEAD_INTAKE_COMPANY_ID') ??
    optionalEnvironment('STORYOPS_COMPANY_ID') ??
    optionalEnvironment('TWILIO_COMPANY_ID') ??
    (mode === 'sandbox' ? DEMO_COMPANY_ID : undefined);
  if (!configured) {
    throw new HttpError(
      'Server configuration LEAD_INTAKE_COMPANY_ID is missing.',
      503,
      'MISCONFIGURED',
    );
  }
  if (requestCompanyId && requestCompanyId !== configured) {
    throw new HttpError('Intake company does not match this endpoint.', 403, 'COMPANY_MISMATCH');
  }
  return configured;
}

function mapIntegrationError(error: IntegrationError): HttpError {
  const status =
    error.code === 'INVALID_SIGNATURE'
      ? 401
      : error.code === 'PAYLOAD_TOO_LARGE'
        ? 413
        : error.code === 'NOT_INBOUND'
          ? 422
          : error.code === 'SIGNING_SECRET_MISSING'
            ? 503
            : 400;
  return new HttpError(error.message, status, error.code);
}

function assertContentType(request: Request, expected: 'json' | 'form'): void {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  const valid =
    expected === 'json'
      ? contentType.startsWith('application/json')
      : contentType.startsWith('application/x-www-form-urlencoded');
  if (!valid) {
    throw new HttpError(
      expected === 'json'
        ? 'Content-Type must be application/json.'
        : 'Content-Type must be application/x-www-form-urlencoded.',
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  }
}

async function normalizeRequest(
  request: Request,
  mode: 'sandbox' | 'live',
  now: Date,
): Promise<{ event: NormalizedLeadIntake; rawBody: string }> {
  const url = new URL(request.url);
  const source = url.searchParams.get('source');

  if (source === 'twilio') {
    assertContentType(request, 'form');
    const rawBody = await readTextBody(request, LEAD_INTAKE_TWILIO_MAX_BYTES);
    const form = Object.fromEntries(new URLSearchParams(rawBody));
    const signature = request.headers.get('x-twilio-signature') ?? '';
    const canonicalUrl =
      mode === 'live' ? requiredEnvironment('TWILIO_LEAD_INTAKE_WEBHOOK_URL') : request.url;
    if (mode === 'live') {
      const callbackUrl = requiredEnvironment('TWILIO_WEBHOOK_URL');
      if (new URL(canonicalUrl).toString() === new URL(callbackUrl).toString()) {
        throw new HttpError(
          'Twilio inbound intake and provider callback URLs must be distinct.',
          503,
          'MISCONFIGURED',
        );
      }
    }
    const authToken =
      mode === 'live' ? requiredEnvironment('TWILIO_AUTH_TOKEN') : TWILIO_INTAKE_SANDBOX_TOKEN;
    const valid = await verifyTwilioWebhook({
      canonicalUrl,
      form,
      signature,
      authToken,
    });
    if (!valid) {
      throw new HttpError('Twilio intake signature is invalid.', 401, 'INVALID_SIGNATURE');
    }
    const companyId = companyIdForRequest(mode);
    try {
      return {
        event: normalizeTwilioLeadIntake(form, companyId, now),
        rawBody,
      };
    } catch (error) {
      if (error instanceof IntegrationError) throw mapIntegrationError(error);
      throw error;
    }
  }

  if (source !== null && source !== 'signed-json') {
    throw new HttpError(
      'source must be signed-json or twilio when supplied.',
      400,
      'INVALID_SOURCE',
    );
  }
  assertContentType(request, 'json');
  const rawBody = await readTextBody(request, LEAD_INTAKE_JSON_MAX_BYTES);
  const signingSecret =
    mode === 'live'
      ? requiredEnvironment('LEAD_INTAKE_SIGNING_SECRET')
      : LEAD_INTAKE_SANDBOX_SECRET;
  try {
    await verifySignedLeadIntake({
      rawBody,
      signatureHeader: request.headers.get('x-storyops-signature') ?? '',
      signingSecret,
      now,
      toleranceSeconds: 300,
    });
    const signed = parseSignedLeadIntake(rawBody);
    const headerEventId = request.headers.get('x-storyops-event-id');
    if (headerEventId && headerEventId !== signed.eventId) {
      throw new HttpError(
        'Event ID header does not match the signed payload.',
        409,
        'EVENT_ID_MISMATCH',
      );
    }
    companyIdForRequest(mode, signed.companyId);
    return {
      event: normalizeSignedLeadIntake(signed, now),
      rawBody,
    };
  } catch (error) {
    if (error instanceof IntegrationError) throw mapIntegrationError(error);
    throw error;
  }
}

async function claimWebhook(
  client: SupabaseClient,
  event: NormalizedLeadIntake,
  rawBody: string,
): Promise<{ claim: WebhookClaim; payloadHash: string }> {
  const payloadHash = await sha256TextHex(rawBody);
  const { data, error } = await client.rpc('claim_webhook_event', {
    p_provider: event.provider,
    p_provider_event_id: event.providerEventId,
    p_event_type: event.eventType,
    p_payload_hash: payloadHash,
    p_payload: intakeReceiptPayload(event),
    p_company_id: event.companyId,
  });
  if (error) {
    if (error.message.toLowerCase().includes('reused')) {
      throw new HttpError(
        'Provider event ID was replayed with a different payload.',
        409,
        'WEBHOOK_REPLAY_CONFLICT',
      );
    }
    throw error;
  }
  const claim = (data as WebhookClaim[] | null)?.[0];
  if (!claim) throw new Error('Webhook claim RPC returned no result.');
  return { claim, payloadHash };
}

async function claimIntakeIdempotency(
  client: SupabaseClient,
  event: NormalizedLeadIntake,
  payloadHash: string,
  now: Date,
): Promise<IdempotencyClaim> {
  const { data, error } = await client.rpc('claim_idempotency_key', {
    p_company_id: event.companyId,
    p_scope: 'lead_intake',
    p_key: `${event.provider}:${event.providerEventId}`,
    p_request_hash: payloadHash,
    p_expires_at: new Date(now.getTime() + 48 * 60 * 60_000).toISOString(),
  });
  if (error) throw error;
  const claim = (data as IdempotencyClaim[] | null)?.[0];
  if (!claim) throw new Error('Idempotency claim RPC returned no result.');
  if (claim.claim_status === 'conflict') {
    throw new HttpError(
      'Idempotency key was reused with a different payload.',
      409,
      'IDEMPOTENCY_CONFLICT',
    );
  }
  return claim;
}

async function completeIntakeIdempotency(
  client: SupabaseClient,
  event: NormalizedLeadIntake,
  payloadHash: string,
  response: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.rpc('complete_idempotency_key', {
    p_company_id: event.companyId,
    p_scope: 'lead_intake',
    p_key: `${event.provider}:${event.providerEventId}`,
    p_request_hash: payloadHash,
    p_response: response,
  });
  if (error) throw error;
}

async function failIntakeIdempotency(
  client: SupabaseClient,
  event: NormalizedLeadIntake,
  payloadHash: string,
  error: unknown,
): Promise<void> {
  const errorCode =
    error instanceof HttpError
      ? error.code
      : error instanceof LeadIntakePersistenceError
        ? error.code
        : error instanceof IntegrationError
          ? error.code
          : 'PROCESSING_FAILED';
  const { error: rpcError } = await client.rpc('fail_idempotency_key', {
    p_company_id: event.companyId,
    p_scope: 'lead_intake',
    p_key: `${event.provider}:${event.providerEventId}`,
    p_request_hash: payloadHash,
    p_error_code: errorCode,
  });
  if (rpcError) throw rpcError;
}

async function startWebhookProcessing(
  client: SupabaseClient,
  eventId: string,
  payloadHash: string,
): Promise<string | null> {
  const { data, error } = await client.rpc('start_storyops_intake_processing', {
    p_event_id: eventId,
    p_payload_hash: payloadHash,
  });
  if (error) throw error;
  if (data === null) return null;
  if (typeof data !== 'string') {
    throw new Error('Intake processing lease RPC returned an invalid result.');
  }
  return data;
}

async function completeWebhook(
  client: SupabaseClient,
  eventId: string,
  payloadHash: string,
  processingLeaseId: string,
): Promise<void> {
  const { error } = await client.rpc('complete_storyops_intake_webhook', {
    p_event_id: eventId,
    p_payload_hash: payloadHash,
    p_processing_lease_id: processingLeaseId,
    p_disposition: 'processed',
  });
  if (error) throw error;
}

async function failWebhook(
  client: SupabaseClient,
  eventId: string,
  payloadHash: string,
  processingLeaseId: string,
  error: unknown,
): Promise<void> {
  const errorCode =
    error instanceof HttpError
      ? error.code
      : error instanceof LeadIntakePersistenceError
        ? error.code
        : error instanceof IntegrationError
          ? error.code
          : 'PROCESSING_FAILED';
  const { error: rpcError } = await client.rpc('fail_storyops_intake_webhook', {
    p_event_id: eventId,
    p_payload_hash: payloadHash,
    p_processing_lease_id: processingLeaseId,
    p_error: errorCode,
  });
  if (rpcError) throw rpcError;
}

function intakeResponse(eventId: string, persisted: PersistedIntake): Record<string, unknown> {
  return {
    accepted: true,
    duplicate: false,
    eventId,
    status: 'processed',
    leadId: persisted.leadId,
    customerId: persisted.customerId,
    subjectType: persisted.subjectType,
    threadId: persisted.threadId,
    messageId: persisted.messageId,
    consentRecordIds: persisted.consentRecordIds,
    existingSubject: persisted.existingSubject,
    existingLead: persisted.existingLead,
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, 405, {
      allow: 'POST, OPTIONS',
    });
  }

  let client: SupabaseClient | undefined;
  let processing:
    | {
        webhookEventId: string;
        payloadHash: string;
        processingLeaseId: string;
        event: NormalizedLeadIntake;
      }
    | undefined;
  try {
    const mode = configuredMode();
    if (mode === 'sandbox') assertSandboxRequest(request);
    const now = new Date();
    const { event, rawBody } = await normalizeRequest(request, mode, now);

    client = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { claim, payloadHash } = await claimWebhook(client, event, rawBody);
    if (!claim.claimed && claim.existing_status === 'ignored') {
      const idempotency = await claimIntakeIdempotency(client, event, payloadHash, now);
      const response = {
        accepted: true,
        duplicate: true,
        eventId: claim.event_id,
        status: 'ignored',
      };
      if (idempotency.claim_status !== 'completed') {
        await completeIntakeIdempotency(client, event, payloadHash, response);
      }
      return jsonResponse(response);
    }
    if (!claim.claimed && claim.existing_status === 'processed') {
      const idempotency = await claimIntakeIdempotency(client, event, payloadHash, now);
      if (idempotency.claim_status === 'completed' && idempotency.stored_response) {
        return jsonResponse({
          ...idempotency.stored_response,
          duplicate: true,
        });
      }
      const persisted = await loadStoryOpsLeadIntakeReceipt(
        client,
        event,
        claim.event_id,
        payloadHash,
      );
      const response = intakeResponse(claim.event_id, persisted);
      await completeIntakeIdempotency(client, event, payloadHash, response);
      return jsonResponse({ ...response, duplicate: true });
    }
    // Opt-out traffic remains available as a recovery/compliance path even
    // when launch is revoked. Every other new live inbound event starts
    // customer operations and must pass launch before durable processing.
    if (mode === 'live' && event.consentSignal !== 'opt_out') {
      if (event.provider === 'twilio') {
        await assertProviderInvocation(client, {
          companyId: event.companyId,
          provider: 'twilio',
          capability: 'sms_voice',
          operationClass: 'launch_start',
        });
      } else if (event.provider === 'storyops_email') {
        await assertProviderInvocation(client, {
          companyId: event.companyId,
          provider: 'email',
          capability: 'email',
          operationClass: 'launch_start',
        });
      } else {
        await assertLaunchStart(client, {
          companyId: event.companyId,
          capability: 'inbound_lead_intake',
        });
      }
    }
    const processingLeaseId = await startWebhookProcessing(client, claim.event_id, payloadHash);
    if (!processingLeaseId) {
      throw new HttpError(
        'Lead intake is already processing under a current durable lease.',
        503,
        'WEBHOOK_PROCESSING_BUSY',
      );
    }
    processing = {
      webhookEventId: claim.event_id,
      payloadHash,
      processingLeaseId,
      event,
    };
    let idempotency = await claimIntakeIdempotency(client, event, payloadHash, now);
    if (idempotency.claim_status === 'completed' && idempotency.stored_response) {
      await completeWebhook(client, claim.event_id, payloadHash, processingLeaseId);
      processing = undefined;
      return jsonResponse({ ...idempotency.stored_response, duplicate: true });
    }
    if (idempotency.claim_status === 'in_progress') {
      await failIntakeIdempotency(
        client,
        event,
        payloadHash,
        new HttpError(
          'Recovering an orphaned intake idempotency reservation.',
          409,
          'ORPHANED_IDEMPOTENCY_RECOVERED',
        ),
      );
      idempotency = await claimIntakeIdempotency(client, event, payloadHash, now);
      if (idempotency.claim_status !== 'reserved') {
        throw new HttpError(
          'Lead-intake idempotency recovery did not reserve the original request.',
          409,
          'IDEMPOTENCY_RECOVERY_FAILED',
        );
      }
    }

    if (event.consentSignal === 'none') {
      await enforceLeadIntakeRateLimits(client, event, Deno.env.toObject());
    }
    const persisted = await persistStoryOpsLeadIntake(
      client,
      event,
      claim.event_id,
      payloadHash,
      processingLeaseId,
    );
    const response = intakeResponse(claim.event_id, persisted);
    await completeWebhook(client, claim.event_id, payloadHash, processingLeaseId);
    await completeIntakeIdempotency(client, event, payloadHash, response);
    processing = undefined;

    return jsonResponse(response, 201);
  } catch (error) {
    if (client && processing) {
      try {
        await failWebhook(
          client,
          processing.webhookEventId,
          processing.payloadHash,
          processing.processingLeaseId,
          error,
        );
      } catch {
        // Preserve the original failure. The processing lease will remain visible for operations.
      }
      try {
        await failIntakeIdempotency(client, processing.event, processing.payloadHash, error);
      } catch {
        // Preserve the original failure; the idempotency lease remains inspectable.
      }
    }
    if (error instanceof LeadIntakePersistenceError) {
      return jsonResponse({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof IntegrationError) return errorResponse(mapIntegrationError(error));
    if (error instanceof HttpError) {
      const headers: HeadersInit =
        error.status === 429
          ? { 'retry-after': '60' }
          : error.code === 'WEBHOOK_PROCESSING_BUSY'
            ? { 'retry-after': '5' }
            : {};
      return jsonResponse({ error: error.message, code: error.code }, error.status, headers);
    }
    return errorResponse(error);
  }
});
