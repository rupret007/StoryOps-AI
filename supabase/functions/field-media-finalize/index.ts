import { createClient } from '@supabase/supabase-js';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import {
  fieldMediaFinalizeRequestSchema,
  verifyDurableMediaBytes,
  verifyMediaCommandRequestHash,
} from './contracts.ts';

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required server environment variable ${name}.`);
  return value;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }

  try {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
    }
    const client = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_ANON_KEY'),
      {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const {
      data: { user },
      error: authError,
    } = await client.auth.getUser(authorization.slice('Bearer '.length));
    if (authError || !user) {
      throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
    }

    const rawBody = await readTextBody(request, 20_000);
    let input: unknown;
    try {
      input = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = fieldMediaFinalizeRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError(
        'A strict content-addressed media command is required.',
        400,
        'INVALID_REQUEST',
      );
    }
    const { command, companyId } = parsed.data;
    try {
      await verifyMediaCommandRequestHash(command);
    } catch (error) {
      throw new HttpError(
        error instanceof Error ? error.message : 'Media command hash is invalid.',
        409,
        'MEDIA_COMMAND_HASH_MISMATCH',
      );
    }
    const { data: blob, error: downloadError } = await client.storage
      .from('job-media')
      .download(command.payload.objectPath);
    if (downloadError || !blob) {
      throw new HttpError(
        'The authenticated user cannot reconcile the staged media object.',
        409,
        'MEDIA_NOT_DURABLE',
      );
    }
    try {
      await verifyDurableMediaBytes(blob, command.payload);
    } catch (error) {
      throw new HttpError(
        error instanceof Error ? error.message : 'Stored media verification failed.',
        409,
        'MEDIA_CHECKSUM_MISMATCH',
      );
    }
    const serviceClient = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error: finalizationError } = await serviceClient.rpc(
      'finalize_storyops_media_upload_from_edge',
      {
        p_company_id: companyId,
        p_command_id: command.commandId,
        p_actor_user_id: user.id,
        p_payload: command.payload,
        p_request_hash: command.requestHash,
      },
    );
    if (finalizationError) {
      throw new HttpError(finalizationError.message, 409, 'MEDIA_FINALIZATION_FAILED');
    }
    return jsonResponse(data);
  } catch (error) {
    return errorResponse(error);
  }
});
