import { createClient } from '@supabase/supabase-js';
import { sha256Hex } from '../../../src/core/ai/approval.ts';
import { preparedScopePhotoUploadSchema } from '../../../src/core/scopePhotos/contracts.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import {
  scopePhotoReservationSchema,
  scopePhotoWorkflowRequestSchema,
  verifyScopePhotoBytes,
} from './contracts.ts';

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required server environment variable ${name}.`);
  return value;
}

function rpcFailure(message: string): HttpError {
  if (/ROLE_REQUIRED|STAFF_REQUIRED|UPLOADER_MISMATCH/iu.test(message)) {
    return new HttpError(
      'This account cannot perform that scope-photo action.',
      403,
      'SCOPE_PHOTO_FORBIDDEN',
    );
  }
  if (/NOT_FOUND/iu.test(message)) {
    return new HttpError('The scope-photo record was not found.', 404, 'SCOPE_PHOTO_NOT_FOUND');
  }
  if (/IDEMPOTENCY|LIMIT_REACHED|EXPIRED|INCOMPLETE|MISMATCH/iu.test(message)) {
    return new HttpError(
      'The scope-photo action conflicted with current evidence or a prior command.',
      409,
      'SCOPE_PHOTO_CONFLICT',
    );
  }
  if (/INVALID/iu.test(message)) {
    return new HttpError('The scope-photo action is invalid.', 400, 'SCOPE_PHOTO_INVALID');
  }
  return new HttpError(
    'The scope-photo workflow could not complete safely.',
    503,
    'SCOPE_PHOTO_UNAVAILABLE',
  );
}

async function authenticatedUser(
  serviceClient: {
    auth: {
      getUser(token: string): Promise<{
        data: { user: { id: string } | null };
        error: unknown;
      }>;
    };
  },
  request: Request,
) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
  }
  const {
    data: { user },
    error,
  } = await serviceClient.auth.getUser(authorization.slice('Bearer '.length));
  if (error || !user) {
    throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
  }
  return user;
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
    const user = await authenticatedUser(serviceClient, request);
    const rawBody = await readTextBody(request, 30_000);
    let input: unknown;
    try {
      input = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = scopePhotoWorkflowRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError(
        `Scope-photo request is invalid: ${parsed.error.message}`,
        400,
        'INVALID_REQUEST',
      );
    }
    const command = parsed.data;
    const requestHash = await sha256Hex(command);

    if (command.operation === 'context') {
      const { data, error } = await serviceClient.rpc('load_scope_photo_context', {
        p_company_id: command.companyId,
        p_actor_user_id: user.id,
        p_property_id: command.propertyId,
      });
      if (error) throw rpcFailure(error.message);
      return jsonResponse(data);
    }

    if (command.operation === 'create_request') {
      const { data, error } = await serviceClient.rpc('create_scope_photo_request', {
        p_company_id: command.companyId,
        p_actor_user_id: user.id,
        p_customer_id: command.customerId,
        p_property_id: command.propertyId,
        p_note: command.note,
        p_expires_in_days: command.expiresInDays,
        p_idempotency_key: command.idempotencyKey,
        p_request_hash: requestHash,
      });
      if (error) throw rpcFailure(error.message);
      return jsonResponse(data);
    }

    if (command.operation === 'prepare_upload') {
      const { data: reservation, error } = await serviceClient.rpc('prepare_scope_photo_upload', {
        p_company_id: command.companyId,
        p_actor_user_id: user.id,
        p_request_id: command.requestId,
        p_checklist_item_code: command.checklistItemCode,
        p_asset_id: command.assetId,
        p_content_type: command.contentType,
        p_byte_size: command.byteSize,
        p_checksum_sha256: command.checksumSha256,
        p_captured_at: command.capturedAt,
        p_command_id: command.idempotencyKey,
        p_request_hash: requestHash,
      });
      if (error) throw rpcFailure(error.message);
      const reserved = scopePhotoReservationSchema.parse(reservation);
      if (reserved.asset_id !== command.assetId || reserved.byte_size !== command.byteSize) {
        throw new HttpError(
          'The upload reservation did not match the requested object.',
          409,
          'SCOPE_PHOTO_RESERVATION_MISMATCH',
        );
      }
      const { data: signed, error: signedError } = await serviceClient.storage
        .from('job-media')
        .createSignedUploadUrl(reserved.object_path, { upsert: false });
      if (signedError || !signed?.token) {
        throw new HttpError(
          'A private upload target could not be created.',
          503,
          'SCOPE_PHOTO_UPLOAD_TARGET_UNAVAILABLE',
        );
      }
      return jsonResponse(
        preparedScopePhotoUploadSchema.parse({
          schemaVersion: 'storyops-scope-photo-upload-v1',
          commandId: reserved.command_id,
          requestId: reserved.request_id,
          assetId: reserved.asset_id,
          objectPath: reserved.object_path,
          token: signed.token,
          expiresAt: reserved.expires_at,
          replayed: reserved.replayed === true,
        }),
      );
    }

    if (command.operation === 'finalize_upload') {
      const { data: reservation, error: reservationError } = await serviceClient.rpc(
        'load_scope_photo_upload_reservation',
        {
          p_company_id: command.companyId,
          p_actor_user_id: user.id,
          p_request_id: command.requestId,
          p_command_id: command.idempotencyKey,
        },
      );
      if (reservationError) throw rpcFailure(reservationError.message);
      const reserved = scopePhotoReservationSchema.parse(reservation);
      if (reserved.status !== 'finalized') {
        const { data: blob, error: downloadError } = await serviceClient.storage
          .from('job-media')
          .download(reserved.object_path);
        if (downloadError || !blob) {
          throw new HttpError(
            'The private upload has not reached durable storage.',
            409,
            'SCOPE_PHOTO_NOT_DURABLE',
          );
        }
        try {
          await verifyScopePhotoBytes(blob, reserved);
        } catch (error) {
          throw new HttpError(
            error instanceof Error ? error.message : 'Scope-photo verification failed.',
            409,
            'SCOPE_PHOTO_BYTES_MISMATCH',
          );
        }
      }
      const { data, error } = await serviceClient.rpc('finalize_scope_photo_upload', {
        p_company_id: command.companyId,
        p_actor_user_id: user.id,
        p_request_id: command.requestId,
        p_command_id: command.idempotencyKey,
      });
      if (error) throw rpcFailure(error.message);
      return jsonResponse(data);
    }

    if (command.operation === 'confirm_measurement') {
      const { data, error } = await serviceClient.rpc('confirm_scope_photo_measurement', {
        p_company_id: command.companyId,
        p_actor_user_id: user.id,
        p_request_id: command.requestId,
        p_analysis_id: command.analysisId,
        p_source_asset_ids: command.sourceAssetIds,
        p_kind: command.kind,
        p_label: command.label,
        p_value: command.value,
        p_unit: command.unit,
        p_service_codes: command.serviceCodes,
        p_add_on_codes: command.addOnCodes,
        p_confirmation_note: command.confirmationNote,
        p_idempotency_key: command.idempotencyKey,
        p_request_hash: requestHash,
      });
      if (error) throw rpcFailure(error.message);
      return jsonResponse(data);
    }

    const { data, error } = await serviceClient.rpc('review_scope_photo_request', {
      p_company_id: command.companyId,
      p_actor_user_id: user.id,
      p_request_id: command.requestId,
      p_disposition: command.disposition,
      p_access_decision: command.accessDecision,
      p_risk_decision: command.riskDecision,
      p_unresolved_unknowns: command.unresolvedUnknowns,
      p_idempotency_key: command.idempotencyKey,
      p_request_hash: requestHash,
    });
    if (error) throw rpcFailure(error.message);
    return jsonResponse(data);
  } catch (error) {
    return errorResponse(error);
  }
});
