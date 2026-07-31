import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { checkIntegrationProviderEnvironmentHealth } from '../../../src/core/integrations/environmentHealth.ts';
import { constantTimeEqual } from '../../../src/core/integrations/webhooks.ts';
import { HttpError, errorResponse, jsonResponse, readTextBody } from '../_shared/http.ts';
import { storyopsDeploymentFingerprint } from '../_shared/deployment-fingerprint.ts';
import {
  canonicalJson,
  signedRestoreProofMaterial,
  trustedVerificationRequestMaterial,
  trustedPilotProofRequestSchema,
  type TrustedPilotProofRequest,
} from './contracts.ts';

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(`Server configuration ${name} is missing.`, 503, 'MISCONFIGURED');
  return value;
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput.buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertCurrentRequest(request: TrustedPilotProofRequest): void {
  const requestedAt = Date.parse(request.requestedAt);
  if (
    !Number.isFinite(requestedAt) ||
    requestedAt < Date.now() - 15 * 60_000 ||
    requestedAt > Date.now() + 60_000
  ) {
    throw new HttpError(
      'Trusted proof requests must use a current, non-future observation time.',
      409,
      'TRUSTED_PROOF_TIME_INVALID',
    );
  }
}

async function assertActorRole(
  client: SupabaseClient,
  companyId: string,
  actorUserId: string,
  allowedRoles: readonly ('owner' | 'technician')[],
): Promise<void> {
  const { data, error } = await client.rpc('load_storyops_edge_actor', {
    p_company_id: companyId,
    p_actor_user_id: actorUserId,
  });
  if (
    error ||
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !allowedRoles.includes((data as Record<string, unknown>).role as 'owner' | 'technician')
  ) {
    throw new HttpError(
      `An active ${allowedRoles.join(' or ')} is required.`,
      403,
      'ROLE_REQUIRED',
    );
  }
}

type VerificationRunReservation = {
  runId: string;
  status: string;
  execute: boolean;
  replayed: boolean;
  proofReceipt?: unknown;
  failureCode?: string;
  visitId?: string;
  jobId?: string;
  propertyId?: string;
  assignedUserId?: string;
  fieldWorkerRole?: 'technician' | 'owner_field_worker';
  mediaAssetId?: string;
  mediaCommandId?: string;
  mediaCapturedAt?: string;
  objectPath?: string;
};

function parseReservation(value: unknown): VerificationRunReservation {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).runId !== 'string' ||
    typeof (value as Record<string, unknown>).status !== 'string' ||
    typeof (value as Record<string, unknown>).execute !== 'boolean' ||
    typeof (value as Record<string, unknown>).replayed !== 'boolean'
  ) {
    throw new HttpError(
      'Trusted verification reservation returned an invalid response.',
      503,
      'TRUSTED_VERIFICATION_RESERVATION_INVALID',
    );
  }
  return value as VerificationRunReservation;
}

async function reserveVerification(
  client: SupabaseClient,
  actorUserId: string,
  request: TrustedPilotProofRequest,
): Promise<VerificationRunReservation> {
  if (request.operation !== 'provider_canary' && request.operation !== 'backup_restore') {
    throw new HttpError(
      'This verification kind uses its dedicated reservation boundary.',
      400,
      'TRUSTED_VERIFICATION_KIND_INVALID',
    );
  }
  const capability =
    request.operation === 'provider_canary' ? request.capability : 'isolated_database_restore';
  const provider = request.operation === 'provider_canary' ? request.provider : null;
  const requestHash = await sha256Hex(trustedVerificationRequestMaterial(request));
  const { data, error } = await client.rpc('reserve_storyops_trusted_pilot_verification', {
    p_company_id: request.companyId,
    p_actor_user_id: actorUserId,
    p_command_id: request.commandId,
    p_kind: request.operation,
    p_provider: provider,
    p_capability: capability,
    p_request_hash: requestHash,
  });
  if (error) {
    throw new HttpError(
      'Trusted verification could not reserve current provider and baseline authority.',
      409,
      'TRUSTED_VERIFICATION_RESERVATION_REJECTED',
    );
  }
  return parseReservation(data);
}

function resumeOrThrow(client: SupabaseClient, reservation: VerificationRunReservation): unknown {
  if (reservation.proofReceipt) return reservation.proofReceipt;
  if (reservation.status === 'verified') {
    return consumeVerifiedRun(client, reservation.runId);
  }
  if (reservation.status === 'failed') {
    throw new HttpError(
      `Trusted verification is failed (${reservation.failureCode ?? 'UNKNOWN'}).`,
      409,
      'TRUSTED_VERIFICATION_FAILED',
    );
  }
  throw new HttpError(
    'Trusted verification is already reserved and will not execute twice.',
    409,
    'TRUSTED_VERIFICATION_IN_PROGRESS',
  );
}

async function failVerification(
  client: SupabaseClient,
  runId: string,
  failureCode: string,
): Promise<void> {
  const { error } = await client.rpc('fail_storyops_trusted_pilot_verification', {
    p_run_id: runId,
    p_failure_code: failureCode,
  });
  if (error) {
    throw new HttpError(
      'Trusted verification failure state could not be persisted.',
      503,
      'TRUSTED_VERIFICATION_FAILURE_PERSISTENCE_FAILED',
    );
  }
}

async function consumeVerifiedRun(client: SupabaseClient, runId: string): Promise<unknown> {
  const { data, error } = await client.rpc('record_storyops_trusted_pilot_proof', {
    p_verification_run_id: runId,
  });
  if (error) {
    throw new HttpError(
      'Verified run could not be consumed as a launch proof.',
      409,
      'TRUSTED_PROOF_RECORD_REJECTED',
    );
  }
  return data;
}

async function runProviderCanary(
  client: SupabaseClient,
  actorUserId: string,
  request: Extract<TrustedPilotProofRequest, { operation: 'provider_canary' }>,
): Promise<unknown> {
  const environment = Deno.env.toObject();
  const deploymentFingerprint = await storyopsDeploymentFingerprint(
    environment,
    requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
  );
  const reservation = await reserveVerification(client, actorUserId, request);
  if (!reservation.execute) return resumeOrThrow(client, reservation);
  try {
    const health = await checkIntegrationProviderEnvironmentHealth(
      environment,
      request.provider,
      request.capability,
    );
    if (health.mode !== 'live' || health.status !== 'healthy' || !health.probeEvidence) {
      await failVerification(client, reservation.runId, 'EXTERNAL_READ_CANARY_FAILED');
      throw new HttpError(
        'The requested provider did not return an authorization-grade external read.',
        503,
        'PROVIDER_CANARY_FAILED',
      );
    }
    const { error } = await client.rpc('complete_storyops_provider_canary_verification', {
      p_run_id: reservation.runId,
      p_probe_evidence: health.probeEvidence,
      p_deployment_fingerprint: deploymentFingerprint,
    });
    if (error) {
      await failVerification(client, reservation.runId, 'PROBE_EVIDENCE_REJECTED');
      throw new HttpError(
        'Provider canary evidence was rejected by the trusted verifier.',
        409,
        'PROVIDER_CANARY_EVIDENCE_REJECTED',
      );
    }
    return consumeVerifiedRun(client, reservation.runId);
  } catch (error) {
    if (!(error instanceof HttpError)) {
      await failVerification(client, reservation.runId, 'EXTERNAL_READ_CANARY_FAILED');
    }
    throw error;
  }
}

const fieldCanaryPng = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  ),
  (character) => character.charCodeAt(0),
);
const fieldCanarySha256 = '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460';

async function startFieldMediaCanary(
  client: SupabaseClient,
  actorUserId: string,
  request: Extract<TrustedPilotProofRequest, { operation: 'field_media_canary_start' }>,
): Promise<unknown> {
  const { data, error } = await client.rpc('reserve_storyops_field_media_verification', {
    p_company_id: request.companyId,
    p_actor_user_id: actorUserId,
    p_command_id: request.commandId,
    p_field_worker_user_id: request.fieldWorkerUserId,
    p_request_hash: await sha256Hex(trustedVerificationRequestMaterial(request)),
  });
  if (error) {
    throw new HttpError(
      'The controlled field-media rehearsal could not be reserved.',
      409,
      'FIELD_MEDIA_CANARY_RESERVATION_REJECTED',
    );
  }
  return parseReservation(data);
}

function requireFieldReservation(
  reservation: VerificationRunReservation,
): Required<
  Pick<
    VerificationRunReservation,
    | 'visitId'
    | 'jobId'
    | 'propertyId'
    | 'assignedUserId'
    | 'mediaAssetId'
    | 'mediaCommandId'
    | 'mediaCapturedAt'
    | 'objectPath'
  >
> {
  const fields = [
    'visitId',
    'jobId',
    'propertyId',
    'assignedUserId',
    'mediaAssetId',
    'mediaCommandId',
    'mediaCapturedAt',
    'objectPath',
  ] as const;
  for (const field of fields) {
    if (typeof reservation[field] !== 'string' || reservation[field].length === 0) {
      throw new HttpError(
        'Field-media rehearsal reservation is incomplete.',
        503,
        'FIELD_MEDIA_CANARY_RESERVATION_INVALID',
      );
    }
  }
  return reservation as Required<Pick<VerificationRunReservation, (typeof fields)[number]>>;
}

async function verifyFieldCanaryBytes(blob: Blob): Promise<void> {
  if (blob.size !== fieldCanaryPng.byteLength) {
    throw new HttpError(
      'Field-media canary read-back size did not match.',
      409,
      'FIELD_MEDIA_CANARY_READBACK_MISMATCH',
    );
  }
  const observedSha = await sha256Hex(new Uint8Array(await blob.arrayBuffer()));
  if (observedSha !== fieldCanarySha256) {
    throw new HttpError(
      'Field-media canary read-back checksum did not match.',
      409,
      'FIELD_MEDIA_CANARY_READBACK_MISMATCH',
    );
  }
}

async function completeFieldMediaCanary(
  serviceClient: SupabaseClient,
  actorUserId: string,
  authorization: string,
  request: Extract<TrustedPilotProofRequest, { operation: 'field_media_canary_complete' }>,
): Promise<unknown> {
  const { data, error } = await serviceClient.rpc('claim_storyops_field_media_verification', {
    p_company_id: request.companyId,
    p_actor_user_id: actorUserId,
    p_verification_run_id: request.verificationRunId,
    p_command_id: request.commandId,
    p_request_hash: await sha256Hex(trustedVerificationRequestMaterial(request)),
  });
  if (error) {
    throw new HttpError(
      'The assigned field worker could not claim this canary session.',
      409,
      'FIELD_MEDIA_CANARY_CLAIM_REJECTED',
    );
  }
  const reservation = parseReservation(data);
  if (reservation.proofReceipt || reservation.status === 'verified') {
    return resumeOrThrow(serviceClient, reservation);
  }
  if (reservation.status === 'failed') return resumeOrThrow(serviceClient, reservation);
  if (reservation.status !== 'executing') {
    throw new HttpError(
      'Field-media canary is not executable.',
      409,
      'FIELD_MEDIA_CANARY_NOT_EXECUTABLE',
    );
  }
  const field = requireFieldReservation(reservation);
  const anonKey = requiredEnvironment('SUPABASE_ANON_KEY');
  const supabaseUrl = requiredEnvironment('SUPABASE_URL');
  const authenticatedClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let verificationCompleted = false;
  try {
    const bucket = authenticatedClient.storage.from('job-media');
    if (reservation.execute) {
      const { error: uploadError } = await bucket.upload(field.objectPath, fieldCanaryPng, {
        contentType: 'image/png',
        upsert: false,
      });
      if (uploadError) {
        throw new HttpError(
          'Assigned field-worker private Storage upload was denied.',
          409,
          'FIELD_MEDIA_CANARY_UPLOAD_FAILED',
        );
      }
    }
    const { data: stagedBlob, error: stagedError } = await bucket.download(field.objectPath);
    if (stagedError || !stagedBlob) {
      throw new HttpError(
        'Assigned field worker could not read back the staged private object.',
        409,
        'FIELD_MEDIA_CANARY_STAGED_READBACK_FAILED',
      );
    }
    await verifyFieldCanaryBytes(stagedBlob);

    const payload = {
      entityId: field.mediaAssetId,
      visitId: field.visitId,
      jobId: field.jobId,
      propertyId: field.propertyId,
      purpose: 'before' as const,
      objectPath: field.objectPath,
      contentType: 'image/png' as const,
      byteSize: fieldCanaryPng.byteLength,
      checksumSha256: fieldCanarySha256,
      capturedAt: field.mediaCapturedAt,
      customerVisible: false as const,
    };
    const mediaCommand = {
      commandId: field.mediaCommandId,
      commandType: 'media.register' as const,
      expectedVersion: 0 as const,
      payload,
      requestHash: await sha256Hex(
        canonicalJson({
          commandType: 'media.register',
          expectedVersion: 0,
          payload,
        }),
      ),
    };
    const finalizerResponse = await fetch(
      `${supabaseUrl.replace(/\/$/u, '')}/functions/v1/field-media-finalize`,
      {
        method: 'POST',
        headers: {
          authorization,
          apikey: anonKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          companyId: request.companyId,
          command: mediaCommand,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!finalizerResponse.ok) {
      await finalizerResponse.body?.cancel();
      throw new HttpError(
        'The exact field-media finalizer rejected the controlled rehearsal.',
        409,
        'FIELD_MEDIA_CANARY_FINALIZER_FAILED',
      );
    }
    await finalizerResponse.body?.cancel();
    const { data: durableBlob, error: durableError } = await bucket.download(field.objectPath);
    if (durableError || !durableBlob) {
      throw new HttpError(
        'Assigned field worker could not read back finalized private media.',
        409,
        'FIELD_MEDIA_CANARY_FINAL_READBACK_FAILED',
      );
    }
    await verifyFieldCanaryBytes(durableBlob);

    const deploymentFingerprint = await storyopsDeploymentFingerprint(
      Deno.env.toObject(),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
    );
    const { error: completionError } = await serviceClient.rpc(
      'complete_storyops_field_media_verification',
      {
        p_run_id: reservation.runId,
        p_deployment_fingerprint: deploymentFingerprint,
      },
    );
    if (completionError) {
      throw new HttpError(
        'Field-media evidence did not satisfy the trusted verifier.',
        409,
        'FIELD_MEDIA_CANARY_EVIDENCE_REJECTED',
      );
    }
    verificationCompleted = true;
    return await consumeVerifiedRun(serviceClient, reservation.runId);
  } catch (error) {
    if (!verificationCompleted) {
      await failVerification(serviceClient, reservation.runId, 'FIELD_MEDIA_ROUNDTRIP_FAILED');
    }
    throw error;
  }
}

async function runRestoreProof(
  client: SupabaseClient,
  actorUserId: string,
  request: Extract<TrustedPilotProofRequest, { operation: 'backup_restore' }>,
  suppliedSignature: string | null,
): Promise<unknown> {
  const secret = requiredEnvironment('PILOT_RESTORE_PROOF_HMAC_SECRET');
  if (secret.length < 32 || secret === requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY')) {
    throw new HttpError('Restore proof signing is misconfigured.', 503, 'MISCONFIGURED');
  }
  const signedMaterial = signedRestoreProofMaterial(request);
  const expectedSignature = await hmacHex(secret, signedMaterial);
  if (
    !suppliedSignature ||
    !/^[a-f0-9]{64}$/u.test(suppliedSignature) ||
    !constantTimeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new HttpError(
      'A valid isolated-restore evidence signature is required.',
      401,
      'RESTORE_PROOF_SIGNATURE_INVALID',
    );
  }
  const reservation = await reserveVerification(client, actorUserId, request);
  if (!reservation.execute) return resumeOrThrow(client, reservation);
  const { error } = await client.rpc('complete_storyops_restore_verification', {
    p_run_id: reservation.runId,
    p_signed_request_sha256: await sha256Hex(signedMaterial),
  });
  if (error) {
    await failVerification(client, reservation.runId, 'RESTORE_EVIDENCE_REJECTED');
    throw new HttpError(
      'Signed restore evidence was rejected by the trusted verifier.',
      409,
      'RESTORE_PROOF_RECORD_REJECTED',
    );
  }
  return consumeVerifiedRun(client, reservation.runId);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }
  try {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
    }
    const serviceClient = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await serviceClient.auth.getUser(authorization.slice('Bearer '.length));
    if (error || !data.user) {
      throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
    }
    const rawBody = await readTextBody(request, 20_000);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = trustedPilotProofRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError('Trusted proof request is invalid.', 400, 'INVALID_REQUEST');
    }
    assertCurrentRequest(parsed.data);
    const result = await (async () => {
      if (parsed.data.operation === 'field_media_canary_complete') {
        await assertActorRole(serviceClient, parsed.data.companyId, data.user.id, [
          'owner',
          'technician',
        ]);
        return completeFieldMediaCanary(serviceClient, data.user.id, authorization, parsed.data);
      }
      await assertActorRole(serviceClient, parsed.data.companyId, data.user.id, ['owner']);
      if (parsed.data.operation === 'field_media_canary_start') {
        return startFieldMediaCanary(serviceClient, data.user.id, parsed.data);
      }
      if (parsed.data.operation === 'provider_canary') {
        return runProviderCanary(serviceClient, data.user.id, parsed.data);
      }
      return runRestoreProof(
        serviceClient,
        data.user.id,
        parsed.data,
        request.headers.get('x-storyops-restore-proof'),
      );
    })();
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
});
