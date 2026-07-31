import { createClient } from '@supabase/supabase-js';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import {
  sdsRegistrationAttestationRequestSchema,
  sdsUploadAttestationReceiptSchema,
  sdsUploadVerificationSchema,
  verifySdsUploadBytes,
} from './contracts.ts';

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required server environment variable ${name}.`);
  return value;
}

function safeRpcError(message: string): HttpError {
  if (/AUTHENTICATION|ACTOR|OWNER|TRUSTED_BOUNDARY/iu.test(message)) {
    return new HttpError(
      'This account cannot attest the requested SDS upload.',
      403,
      'SDS_ATTESTATION_FORBIDDEN',
    );
  }
  if (/NOT_FOUND/iu.test(message)) {
    return new HttpError('The SDS upload preparation was not found.', 404, 'SDS_NOT_FOUND');
  }
  if (/EXPIRED|MISMATCH|CONFLICT|ALREADY/iu.test(message)) {
    return new HttpError(
      'The SDS upload no longer matches the prepared registration.',
      409,
      'SDS_ATTESTATION_CONFLICT',
    );
  }
  return new HttpError(
    'The trusted SDS verification boundary is unavailable.',
    503,
    'SDS_ATTESTATION_UNAVAILABLE',
  );
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }

  try {
    const serviceClient = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
    }
    const {
      data: { user },
      error: userError,
    } = await serviceClient.auth.getUser(authorization.slice('Bearer '.length));
    if (userError || !user) {
      throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
    }

    const rawBody = await readTextBody(request, 2_048);
    let input: unknown;
    try {
      input = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = sdsRegistrationAttestationRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError('SDS attestation request is invalid.', 400, 'INVALID_REQUEST');
    }

    const { data: verificationData, error: verificationError } = await serviceClient.rpc(
      'load_storyops_sds_upload_for_attestation',
      {
        p_company_id: parsed.data.companyId,
        p_actor_user_id: user.id,
        p_command_id: parsed.data.commandId,
        p_request_hash: parsed.data.requestHash,
      },
    );
    if (verificationError) throw safeRpcError(verificationError.message);
    const verification = sdsUploadVerificationSchema.parse(verificationData);
    if (
      verification.companyId !== parsed.data.companyId ||
      verification.actorUserId !== user.id ||
      verification.commandId !== parsed.data.commandId ||
      verification.requestHash !== parsed.data.requestHash
    ) {
      throw new HttpError(
        'SDS verification identity did not match the request.',
        409,
        'SDS_ATTESTATION_MISMATCH',
      );
    }

    const { data: blob, error: downloadError } = await serviceClient.storage
      .from('sds')
      .download(verification.objectPath);
    if (downloadError || !blob) {
      throw new HttpError(
        'The prepared private SDS object is not durable.',
        409,
        'SDS_OBJECT_NOT_DURABLE',
      );
    }
    let observedChecksum: string;
    try {
      observedChecksum = await verifySdsUploadBytes(blob, verification);
    } catch {
      throw new HttpError(
        'The private SDS bytes do not match the reviewed checksum, size, and PDF type.',
        409,
        'SDS_BYTES_MISMATCH',
      );
    }

    const { data: attestationData, error: attestationError } = await serviceClient.rpc(
      'attest_storyops_sds_upload',
      {
        p_company_id: parsed.data.companyId,
        p_actor_user_id: user.id,
        p_command_id: parsed.data.commandId,
        p_request_hash: parsed.data.requestHash,
        p_observed_checksum_sha256: observedChecksum,
        p_observed_byte_size: blob.size,
        p_observed_content_type: verification.contentType,
      },
    );
    if (attestationError) throw safeRpcError(attestationError.message);
    const receipt = sdsUploadAttestationReceiptSchema.parse(attestationData);
    if (
      receipt.companyId !== parsed.data.companyId ||
      receipt.commandId !== parsed.data.commandId ||
      receipt.requestHash !== parsed.data.requestHash ||
      receipt.registrationRequestId !== verification.registrationRequestId ||
      receipt.objectPath !== verification.objectPath ||
      receipt.checksumSha256 !== verification.checksumSha256
    ) {
      throw new HttpError(
        'SDS attestation receipt did not reconcile with verified bytes.',
        409,
        'SDS_ATTESTATION_MISMATCH',
      );
    }
    return jsonResponse(receipt);
  } catch (error) {
    return errorResponse(error);
  }
});
