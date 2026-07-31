import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { HttpError, errorResponse, jsonResponse, readTextBody } from '../_shared/http.ts';
import {
  authorizePrivateWorkerCredential,
  authorizePrivateWorkerTrigger,
} from '../_shared/private-worker-http.ts';
import { recordPrivateWorkerHeartbeat } from '../_shared/private-worker-evidence.ts';
import {
  scopePhotoCleanupClaimSchema,
  scopePhotoCleanupRequestSchema,
  scopePhotoCleanupResponseSchema,
} from './contracts.ts';

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required server environment variable ${name}.`);
  return value;
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }
  let recordFailureHeartbeat: (() => Promise<void>) | undefined;
  try {
    const environment = Deno.env.toObject();
    const activation = authorizePrivateWorkerCredential(
      environment,
      {
        label: 'scope-photo cleanup worker',
        tokenName: 'SCOPE_PHOTO_CLEANUP_TOKEN',
        modeName: 'SCOPE_PHOTO_CLEANUP_MODE',
        peerTokenNames: [
          'POST_SERVICE_WORKER_TOKEN',
          'TRANSACTIONAL_OUTBOUND_WORKER_TOKEN',
          'SCHEDULING_RECONCILIATION_TOKEN',
        ],
      },
      bearerToken(request),
    );
    const rawBody = await readTextBody(request, 2_000);
    let input: unknown;
    try {
      input = rawBody.length > 0 ? JSON.parse(rawBody) : {};
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = scopePhotoCleanupRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError('Cleanup request is invalid.', 400, 'INVALID_REQUEST');
    }
    authorizePrivateWorkerTrigger(activation, parsed.data.trigger, 'Scope-photo cleanup worker');

    const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
    const client = createClient(requiredEnvironment('SUPABASE_URL'), serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    recordFailureHeartbeat = () =>
      recordPrivateWorkerHeartbeat({
        client,
        environment,
        serviceRoleKey,
        worker: 'scope_photo_cleanup',
        companyIds: parsed.data.companyId ? [parsed.data.companyId] : [],
        trigger: parsed.data.trigger,
        status: 'failed',
      });
    const { data, error } = await client.rpc('claim_scope_photo_orphans', {
      p_company_id: parsed.data.companyId,
      p_limit: parsed.data.limit,
    });
    if (error) throw error;
    const claims = z.array(scopePhotoCleanupClaimSchema).parse(data);
    let cleaned = 0;
    let failed = 0;
    for (const claim of claims) {
      if (claim.companyId !== parsed.data.companyId) {
        throw new Error('Cleanup claim crossed the requested company scope.');
      }
      const { error: removalError } = await client.storage
        .from('job-media')
        .remove([claim.objectPath]);
      const succeeded = !removalError;
      const { error: completionError } = await client.rpc('complete_scope_photo_orphan_cleanup', {
        p_command_id: claim.commandId,
        p_succeeded: succeeded,
        p_error: removalError?.message ?? null,
      });
      if (completionError) throw completionError;
      if (succeeded) cleaned += 1;
      else failed += 1;
    }
    await recordPrivateWorkerHeartbeat({
      client,
      environment,
      serviceRoleKey,
      worker: 'scope_photo_cleanup',
      companyIds: parsed.data.companyId ? [parsed.data.companyId] : [],
      trigger: parsed.data.trigger,
      status: failed > 0 ? 'failed' : 'succeeded',
    });
    recordFailureHeartbeat = undefined;
    return jsonResponse(
      scopePhotoCleanupResponseSchema.parse({
        schemaVersion: 'storyops-scope-photo-cleanup-run-v2',
        activationMode: activation.activationMode,
        trigger: parsed.data.trigger,
        status: 'processed',
        claimed: claims.length,
        cleaned,
        failed,
        empty: claims.length === 0,
        checkedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    try {
      await recordFailureHeartbeat?.();
    } catch {
      // Preserve the cleanup failure that caused the failed heartbeat.
    }
    return errorResponse(error);
  }
});
