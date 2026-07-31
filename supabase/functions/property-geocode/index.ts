import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sha256Hex } from '../../../src/core/ai/approval.ts';
import { resolveLiveProviderActivation } from '../../../src/core/integrations/configuration.ts';
import type { GeocodeResult } from '../../../src/core/integrations/contracts.ts';
import { GoogleMapsProvider } from '../../../src/core/integrations/liveServer.ts';
import { consumeOperationBudget } from '../../../src/core/integrations/operationBudget.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import { assertProviderInvocation } from '../_shared/provider-authorization.ts';
import {
  lookupHashPayload,
  propertyGeocodeCandidatesReceiptSchema,
  propertyGeocodeLookupRequestSchema,
  type PropertyGeocodeCandidatesReceipt,
} from './contracts.ts';

type Row = Record<string, unknown>;

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new HttpError(`Server configuration ${name} is missing.`, 503, 'MISCONFIGURED');
  }
  return value;
}

function row(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(`${label} is invalid.`, 503, 'AUTHORITATIVE_DATA_INVALID');
  }
  return value as Row;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(`${label} is missing.`, 503, 'AUTHORITATIVE_DATA_INVALID');
  }
  return value.trim();
}

function safeRpcError(message: string): HttpError {
  if (/FORBIDDEN|BACK_OFFICE_REQUIRED/iu.test(message)) {
    return new HttpError(
      'Only an active owner or dispatcher may review property coordinates.',
      403,
      'PROPERTY_GEOCODE_FORBIDDEN',
    );
  }
  if (/VERSION_CONFLICT|PROPERTY_CHANGED|ALREADY_CONFIRMED/iu.test(message)) {
    return new HttpError(
      'The property or its address changed. Refresh before requesting coordinates.',
      409,
      'PROPERTY_GEOCODE_CONFLICT',
    );
  }
  if (/IDEMPOTENCY|IN_PROGRESS/iu.test(message)) {
    return new HttpError(
      'The geocode operation conflicts with an earlier request.',
      409,
      'PROPERTY_GEOCODE_IDEMPOTENCY_CONFLICT',
    );
  }
  if (/RATE_LIMITED/iu.test(message)) {
    return new HttpError(
      'Too many property geocode lookups were requested.',
      429,
      'PROPERTY_GEOCODE_RATE_LIMITED',
    );
  }
  if (/INVALID|HASH_MISMATCH/iu.test(message)) {
    return new HttpError(
      'The property geocode request is invalid.',
      400,
      'PROPERTY_GEOCODE_INVALID',
    );
  }
  return new HttpError(
    'Property geocode evidence could not be persisted safely.',
    503,
    'PROPERTY_GEOCODE_UNAVAILABLE',
  );
}

async function authenticatedUserId(
  client: SupabaseClient,
  authorization: string | null,
): Promise<string> {
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
  }
  const {
    data: { user },
    error,
  } = await client.auth.getUser(authorization.slice('Bearer '.length));
  if (error || !user) {
    throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
  }
  return user.id;
}

function addressText(serviceAddress: unknown): string {
  const address = row(serviceAddress, 'Service address');
  const parts = [
    text(address.line1, 'Service address line 1'),
    typeof address.line2 === 'string' ? address.line2.trim() : '',
    text(address.city, 'Service address city'),
    text(address.region, 'Service address region'),
    text(address.postalCode, 'Service address postal code'),
    text(address.country, 'Service address country'),
  ].filter(Boolean);
  const rendered = parts.join(', ');
  if (rendered.length < 12 || rendered.length > 600) {
    throw new HttpError(
      'The exact service address is incomplete or too long.',
      422,
      'PROPERTY_ADDRESS_INCOMPLETE',
    );
  }
  return rendered;
}

function validProviderCandidate(candidate: GeocodeResult, now: number): boolean {
  return (
    candidate.provider === 'google_maps' &&
    candidate.mode === 'live' &&
    candidate.formattedAddress.trim().length >= 5 &&
    candidate.formattedAddress.length <= 500 &&
    Number.isFinite(candidate.coordinates.latitude) &&
    candidate.coordinates.latitude >= -90 &&
    candidate.coordinates.latitude <= 90 &&
    Number.isFinite(candidate.coordinates.longitude) &&
    candidate.coordinates.longitude >= -180 &&
    candidate.coordinates.longitude <= 180 &&
    Number.isFinite(candidate.confidence) &&
    candidate.confidence >= 0 &&
    candidate.confidence <= 1 &&
    Number.isFinite(Date.parse(candidate.observedAt)) &&
    Date.parse(candidate.observedAt) >= now - 10 * 60_000 &&
    Date.parse(candidate.observedAt) <= now + 60_000
  );
}

function finiteCandidates(results: GeocodeResult[]): Array<Record<string, unknown>> {
  const now = Date.now();
  const valid = results.filter((candidate) => validProviderCandidate(candidate, now));
  if (results.length > 0 && valid.length === 0) {
    throw new HttpError(
      'Google Maps returned only incomplete or stale coordinate evidence.',
      503,
      'PROPERTY_GEOCODE_PROVIDER_EVIDENCE_INVALID',
    );
  }
  const seen = new Set<string>();
  return valid
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.formattedAddress.localeCompare(right.formattedAddress),
    )
    .filter((candidate) => {
      const key =
        candidate.providerPlaceId ??
        `${candidate.coordinates.latitude}:${candidate.coordinates.longitude}:${candidate.formattedAddress}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5)
    .map((candidate) => ({
      id: crypto.randomUUID(),
      provider: 'google_maps',
      mode: 'live',
      formattedAddress: candidate.formattedAddress.trim(),
      latitude: candidate.coordinates.latitude,
      longitude: candidate.coordinates.longitude,
      precision: candidate.precision,
      confidence: candidate.confidence,
      ...(candidate.providerPlaceId ? { providerPlaceId: candidate.providerPlaceId } : {}),
      observedAt: new Date(candidate.observedAt).toISOString(),
    }));
}

async function loadContext(
  client: SupabaseClient,
  input: ReturnType<typeof propertyGeocodeLookupRequestSchema.parse>,
  actorUserId: string,
  requestHash: string,
): Promise<Row> {
  const { data, error } = await client.rpc('load_storyops_property_geocode_context', {
    p_company_id: input.companyId,
    p_actor_user_id: actorUserId,
    p_property_id: input.propertyId,
    p_expected_property_version: input.expectedPropertyVersion,
    p_operation_id: input.operationId,
    p_request_hash: requestHash,
  });
  if (error) throw safeRpcError(error.message);
  return row(data, 'Property geocode context');
}

function replayedReceipt(context: Row): PropertyGeocodeCandidatesReceipt | undefined {
  if (context.replayed !== true) return undefined;
  return propertyGeocodeCandidatesReceiptSchema.parse({
    ...row(context.receipt, 'Property geocode replay receipt'),
    replayed: true,
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }

  try {
    const rawBody = await readTextBody(request, 8_192);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = propertyGeocodeLookupRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        'Request must contain only the company, property/version, and stable operation identity.',
        400,
        'PROPERTY_GEOCODE_INVALID',
      );
    }
    const input = parsed.data;
    const environment = Deno.env.toObject();
    const client = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const actorUserId = await authenticatedUserId(client, request.headers.get('authorization'));
    const requestHash = await sha256Hex(lookupHashPayload(input));
    const context = await loadContext(client, input, actorUserId, requestHash);
    const replay = replayedReceipt(context);
    if (replay) return jsonResponse(replay);

    if (
      context.companyId !== input.companyId ||
      context.propertyId !== input.propertyId ||
      context.propertyVersion !== input.expectedPropertyVersion ||
      typeof context.addressHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(context.addressHash)
    ) {
      throw new HttpError(
        'Authoritative property facts did not match the request.',
        503,
        'AUTHORITATIVE_DATA_INVALID',
      );
    }

    const mapsActivation = resolveLiveProviderActivation(
      environment,
      'MAPS_LIVE_ENABLED',
      'MAPS_MODE',
    );
    if (mapsActivation.runtimeMode !== 'live' || !mapsActivation.enabled) {
      throw new HttpError(
        'Live Maps is not enabled. The property remains blocked for scheduling until a real provider candidate is reviewed.',
        503,
        'PROPERTY_GEOCODE_LIVE_MAPS_REQUIRED',
      );
    }
    await assertProviderInvocation(client, {
      companyId: input.companyId,
      provider: 'maps',
      capability: 'geocoding',
      operationClass: 'internal',
    });
    const budget = await consumeOperationBudget({
      client,
      companyId: input.companyId,
      scope: 'property-geocode:user:hour',
      subject: actorUserId,
      limit: 20,
      windowSeconds: 3_600,
    });
    if (!budget.allowed) {
      throw new HttpError(
        `Property geocode lookup limit reached; retry after ${budget.reset_at}.`,
        429,
        'PROPERTY_GEOCODE_RATE_LIMITED',
      );
    }

    const provider = new GoogleMapsProvider(requiredEnvironment('GOOGLE_MAPS_API_KEY'));
    const candidates = finiteCandidates(
      await provider.geocode(addressText(context.serviceAddress)),
    );
    if (candidates.length === 0) {
      throw new HttpError(
        'No coordinate candidate matched the exact service address. Correct the address and retry.',
        422,
        'PROPERTY_GEOCODE_NO_RESULTS',
      );
    }

    const recordParameters = {
      p_company_id: input.companyId,
      p_actor_user_id: actorUserId,
      p_property_id: input.propertyId,
      p_expected_property_version: input.expectedPropertyVersion,
      p_operation_id: input.operationId,
      p_address_hash: context.addressHash,
      p_candidates: candidates,
      p_request_hash: requestHash,
    };
    const { data, error } = await client.rpc(
      'record_storyops_property_geocode_candidates',
      recordParameters,
    );
    if (error) {
      // The provider call is an external read. On an ambiguous database response,
      // perform one exact read-back and never claim candidates that are not durable.
      const reconciled = await loadContext(client, input, actorUserId, requestHash);
      const committed = replayedReceipt(reconciled);
      if (committed) return jsonResponse(committed);
      throw safeRpcError(error.message);
    }
    return jsonResponse(propertyGeocodeCandidatesReceiptSchema.parse(data));
  } catch (error) {
    return errorResponse(error);
  }
});
