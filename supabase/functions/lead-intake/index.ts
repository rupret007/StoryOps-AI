import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  LEAD_INTAKE_JSON_MAX_BYTES,
  LEAD_INTAKE_SANDBOX_SECRET,
  LEAD_INTAKE_TWILIO_MAX_BYTES,
  TWILIO_INTAKE_SANDBOX_TOKEN,
  deterministicIntakeUuid,
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

const DEMO_COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const DEFAULT_COMPANY_RATE_LIMIT_PER_MINUTE = 120;
const DEFAULT_CONTACT_RATE_LIMIT_PER_HOUR = 30;

type WebhookClaim = {
  event_id: string;
  claimed: boolean;
  existing_status: string;
};

type PersistedIntake = {
  leadId: string;
  threadId: string;
  messageId: string;
  consentRecordIds: string[];
  existingLead: boolean;
};

type IdempotencyClaim = {
  claim_status: 'reserved' | 'completed' | 'in_progress' | 'conflict';
  stored_response: Record<string, unknown> | null;
};

type ExistingLead = {
  id: string;
  email: string | null;
  phone: string | null;
  requested_services: string[];
};

function optionalEnvironment(name: string): string | undefined {
  return Deno.env.get(name)?.trim() || undefined;
}

function requiredEnvironment(name: string): string {
  const value = optionalEnvironment(name);
  if (!value) throw new HttpError(`Server configuration ${name} is missing.`, 503, 'MISCONFIGURED');
  return value;
}

function configuredLimit(name: string, fallback: number, maximum: number): number {
  const raw = optionalEnvironment(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new HttpError(`Server configuration ${name} is invalid.`, 503, 'MISCONFIGURED');
  }
  return parsed;
}

function configuredMode(): 'sandbox' | 'live' | 'disabled' {
  const mode = optionalEnvironment('LEAD_INTAKE_MODE') ?? 'sandbox';
  if (mode === 'sandbox' || mode === 'live' || mode === 'disabled') return mode;
  throw new HttpError('Server configuration LEAD_INTAKE_MODE is invalid.', 503, 'MISCONFIGURED');
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
      mode === 'live'
        ? (optionalEnvironment('TWILIO_LEAD_INTAKE_WEBHOOK_URL') ??
          requiredEnvironment('TWILIO_WEBHOOK_URL'))
        : request.url;
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
): Promise<boolean> {
  const { data, error } = await client.rpc('start_webhook_processing', {
    p_event_id: eventId,
    p_payload_hash: payloadHash,
  });
  if (error) throw error;
  return data === true;
}

async function completeWebhook(
  client: SupabaseClient,
  eventId: string,
  payloadHash: string,
): Promise<void> {
  const { error } = await client.rpc('complete_webhook_event', {
    p_event_id: eventId,
    p_payload_hash: payloadHash,
    p_disposition: 'processed',
  });
  if (error) throw error;
}

async function failWebhook(
  client: SupabaseClient,
  eventId: string,
  payloadHash: string,
  error: unknown,
): Promise<void> {
  const errorCode =
    error instanceof HttpError
      ? error.code
      : error instanceof IntegrationError
        ? error.code
        : 'PROCESSING_FAILED';
  const { error: rpcError } = await client.rpc('fail_webhook_event', {
    p_event_id: eventId,
    p_payload_hash: payloadHash,
    p_error: errorCode,
  });
  if (rpcError) throw rpcError;
}

async function enforceRateLimits(
  client: SupabaseClient,
  event: NormalizedLeadIntake,
  now: Date,
): Promise<void> {
  const companyLimit = configuredLimit(
    'LEAD_INTAKE_COMPANY_RATE_LIMIT_PER_MINUTE',
    DEFAULT_COMPANY_RATE_LIMIT_PER_MINUTE,
    2_000,
  );
  const minuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const { count: companyCount, error: companyError } = await client
    .from('webhook_events')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', event.companyId)
    .eq('provider', event.provider)
    .gte('received_at', minuteAgo);
  if (companyError) throw companyError;
  if ((companyCount ?? 0) > companyLimit) {
    throw new HttpError('Lead intake rate limit exceeded.', 429, 'RATE_LIMITED');
  }

  const contactLimit = configuredLimit(
    'LEAD_INTAKE_CONTACT_RATE_LIMIT_PER_HOUR',
    DEFAULT_CONTACT_RATE_LIMIT_PER_HOUR,
    500,
  );
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const { count: contactCount, error: contactError } = await client
    .from('communication_messages')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', event.companyId)
    .eq('direction', 'inbound')
    .eq('sender', event.communication.sender)
    .gte('created_at', hourAgo);
  if (contactError) throw contactError;
  if ((contactCount ?? 0) >= contactLimit) {
    throw new HttpError('Contact intake rate limit exceeded.', 429, 'RATE_LIMITED');
  }
}

async function findExistingLead(
  client: SupabaseClient,
  event: NormalizedLeadIntake,
): Promise<ExistingLead | undefined> {
  if (!event.phone && !event.email) return undefined;
  let query = client
    .from('leads')
    .select('id,email,phone,requested_services')
    .eq('company_id', event.companyId)
    .in('status', ['new', 'qualifying', 'qualified']);
  query = event.phone ? query.eq('phone', event.phone) : query.eq('email', event.email!);
  const { data, error } = await query.order('updated_at', { ascending: false }).limit(1);
  if (error) throw error;
  return (data as ExistingLead[] | null)?.[0];
}

async function findExistingThread(
  client: SupabaseClient,
  event: NormalizedLeadIntake,
  leadId: string,
): Promise<string | undefined> {
  const { data, error } = await client
    .from('communication_threads')
    .select('id')
    .eq('company_id', event.companyId)
    .eq('lead_id', leadId)
    .eq('status', 'open')
    .order('last_message_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data as Array<{ id: string }> | null)?.[0]?.id;
}

async function upsertOrThrow(
  client: SupabaseClient,
  table: string,
  row: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  const { error } = await client.from(table).upsert(row, {
    onConflict: 'id',
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

function providerMessageId(event: NormalizedLeadIntake): string {
  return `${event.provider}:${event.providerEventId}`;
}

async function persistIntake(
  client: SupabaseClient,
  event: NormalizedLeadIntake,
): Promise<PersistedIntake> {
  const existingLead = await findExistingLead(client, event);
  const leadId =
    existingLead?.id ??
    (await deterministicIntakeUuid(event.companyId, event.provider, event.providerEventId, 'lead'));
  if (!existingLead) {
    await upsertOrThrow(client, 'leads', {
      id: leadId,
      company_id: event.companyId,
      source: event.source,
      status: 'new',
      display_name: event.displayName,
      email: event.email ?? null,
      phone: event.phone ?? null,
      requested_services: event.requestedServices,
      preferred_contact_channel: event.preferredContactChannel ?? null,
    });
  } else {
    const requestedServices = [
      ...new Set([...existingLead.requested_services, ...event.requestedServices]),
    ];
    const { error } = await client
      .from('leads')
      .update({
        email: existingLead.email ?? event.email ?? null,
        phone: existingLead.phone ?? event.phone ?? null,
        requested_services: requestedServices,
      })
      .eq('company_id', event.companyId)
      .eq('id', leadId);
    if (error) throw error;
  }

  const consentRows = await Promise.all(
    event.consent.map(async (record) => ({
      id: await deterministicIntakeUuid(
        event.companyId,
        event.provider,
        event.providerEventId,
        `consent:${record.channel}:${record.purpose}`,
      ),
      company_id: event.companyId,
      lead_id: leadId,
      customer_id: null,
      channel: record.channel,
      purpose: record.purpose,
      status: record.status,
      captured_at: event.occurredAt,
      capture_method: record.captureMethod,
      disclosure_version: record.disclosureVersion,
      proof: record.proof,
      withdrawn_at: record.status === 'withdrawn' ? event.occurredAt : null,
    })),
  );
  if (consentRows.length > 0) {
    await upsertOrThrow(client, 'consent_records', consentRows);
  }

  const existingThreadId = await findExistingThread(client, event, leadId);
  const threadId =
    existingThreadId ??
    (await deterministicIntakeUuid(
      event.companyId,
      event.provider,
      event.providerEventId,
      'communication_thread',
    ));
  if (!existingThreadId) {
    await upsertOrThrow(client, 'communication_threads', {
      id: threadId,
      company_id: event.companyId,
      lead_id: leadId,
      subject: event.communication.subject ?? null,
      status: 'open',
      last_message_at: event.occurredAt,
    });
  }

  const messageId = await deterministicIntakeUuid(
    event.companyId,
    event.provider,
    event.providerEventId,
    'communication_message',
  );
  const messageConsent = consentRows.find(
    (record) =>
      record.channel === event.communication.channel && record.purpose === 'transactional',
  );
  await upsertOrThrow(client, 'communication_messages', {
    id: messageId,
    company_id: event.companyId,
    thread_id: threadId,
    channel: event.communication.channel,
    direction: 'inbound',
    sender: event.communication.sender,
    recipients: event.communication.recipients,
    body: event.communication.body,
    risk_class: 'routine',
    provider_message_id: providerMessageId(event),
    delivery_status: 'received',
    consent_record_id: messageConsent?.id ?? null,
    received_at: event.occurredAt,
    retention_class: 'communication',
  });

  if (existingThreadId) {
    const { error } = await client
      .from('communication_threads')
      .update({ last_message_at: event.occurredAt })
      .eq('company_id', event.companyId)
      .eq('id', threadId)
      .lt('last_message_at', event.occurredAt);
    if (error) throw error;
  }

  return {
    leadId,
    threadId,
    messageId,
    consentRecordIds: consentRows.map((record) => record.id),
    existingLead: Boolean(existingLead),
  };
}

async function loadPersistedIntake(
  client: SupabaseClient,
  event: NormalizedLeadIntake,
): Promise<PersistedIntake> {
  const { data: messages, error: messageError } = await client
    .from('communication_messages')
    .select('id,thread_id')
    .eq('company_id', event.companyId)
    .eq('channel', event.communication.channel)
    .eq('provider_message_id', providerMessageId(event))
    .limit(1);
  if (messageError) throw messageError;
  const message = (messages as Array<{ id: string; thread_id: string }> | null)?.[0];
  if (!message) {
    throw new Error('Processed intake has no persisted communication message.');
  }

  const { data: threads, error: threadError } = await client
    .from('communication_threads')
    .select('lead_id')
    .eq('company_id', event.companyId)
    .eq('id', message.thread_id)
    .limit(1);
  if (threadError) throw threadError;
  const leadId = (threads as Array<{ lead_id: string }> | null)?.[0]?.lead_id;
  if (!leadId) throw new Error('Processed intake communication has no lead.');

  const consentRecordIds = await Promise.all(
    event.consent.map((record) =>
      deterministicIntakeUuid(
        event.companyId,
        event.provider,
        event.providerEventId,
        `consent:${record.channel}:${record.purpose}`,
      ),
    ),
  );
  return {
    leadId,
    threadId: message.thread_id,
    messageId: message.id,
    consentRecordIds,
    existingLead: true,
  };
}

function intakeResponse(eventId: string, persisted: PersistedIntake): Record<string, unknown> {
  return {
    accepted: true,
    duplicate: false,
    eventId,
    status: 'processed',
    leadId: persisted.leadId,
    threadId: persisted.threadId,
    messageId: persisted.messageId,
    consentRecordIds: persisted.consentRecordIds,
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
        event: NormalizedLeadIntake;
      }
    | undefined;
  try {
    const mode = configuredMode();
    if (mode === 'disabled') {
      throw new HttpError('Lead intake is disabled.', 503, 'INTAKE_DISABLED');
    }
    if (mode === 'sandbox') assertSandboxRequest(request);
    const now = new Date();
    const { event, rawBody } = await normalizeRequest(request, mode, now);

    client = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { claim, payloadHash } = await claimWebhook(client, event, rawBody);
    const idempotency = await claimIntakeIdempotency(client, event, payloadHash, now);
    if (idempotency.claim_status === 'completed' && idempotency.stored_response) {
      return jsonResponse({
        ...idempotency.stored_response,
        duplicate: true,
      });
    }
    if (!claim.claimed && claim.existing_status === 'ignored') {
      const response = {
        accepted: true,
        duplicate: true,
        eventId: claim.event_id,
        status: 'ignored',
      };
      await completeIntakeIdempotency(client, event, payloadHash, response);
      return jsonResponse(response);
    }
    if (!claim.claimed && claim.existing_status === 'processed') {
      const persisted = await loadPersistedIntake(client, event);
      const response = intakeResponse(claim.event_id, persisted);
      await completeIntakeIdempotency(client, event, payloadHash, response);
      return jsonResponse({ ...response, duplicate: true });
    }
    if (idempotency.claim_status === 'in_progress') {
      return jsonResponse(
        {
          accepted: true,
          duplicate: true,
          eventId: claim.event_id,
          status: 'processing',
        },
        202,
        { 'retry-after': '2' },
      );
    }
    const acquired = await startWebhookProcessing(client, claim.event_id, payloadHash);
    if (!acquired) {
      return jsonResponse(
        {
          accepted: true,
          duplicate: true,
          eventId: claim.event_id,
          status: 'processing',
        },
        202,
        { 'retry-after': '2' },
      );
    }
    processing = {
      webhookEventId: claim.event_id,
      payloadHash,
      event,
    };

    await enforceRateLimits(client, event, now);
    const persisted = await persistIntake(client, event);
    const response = intakeResponse(claim.event_id, persisted);
    await completeWebhook(client, claim.event_id, payloadHash);
    await completeIntakeIdempotency(client, event, payloadHash, response);
    processing = undefined;

    return jsonResponse(response, 201);
  } catch (error) {
    if (client && processing) {
      try {
        await failWebhook(client, processing.webhookEventId, processing.payloadHash, error);
      } catch {
        // Preserve the original failure. The processing lease will remain visible for operations.
      }
      try {
        await failIntakeIdempotency(client, processing.event, processing.payloadHash, error);
      } catch {
        // Preserve the original failure; the idempotency lease remains inspectable.
      }
    }
    if (error instanceof IntegrationError) return errorResponse(mapIntegrationError(error));
    if (error instanceof HttpError) {
      const headers: HeadersInit = error.status === 429 ? { 'retry-after': '60' } : {};
      return jsonResponse({ error: error.message, code: error.code }, error.status, headers);
    }
    return errorResponse(error);
  }
});
