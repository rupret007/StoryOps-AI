import { createClient } from '@supabase/supabase-js';
import { createServerIntegrationSuite } from '../../../src/core/integrations/liveServer.ts';
import { constantTimeEqual } from '../../../src/core/integrations/webhooks.ts';
import { HttpError, errorResponse, jsonResponse, readTextBody } from '../_shared/http.ts';
import {
  outboundClaimSchema,
  workerRequestSchema,
  workerResponseSchema,
  workerResultSchema,
  type OutboundClaim,
  type WorkerResult,
} from './contracts.ts';
import { processOutboundClaim, type OutboundWorkerRepository } from './worker.ts';

type JsonObject = Record<string, unknown>;

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

  try {
    const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
    const suppliedToken = bearerToken(request);
    if (!suppliedToken || !constantTimeEqual(suppliedToken, serviceRoleKey)) {
      throw new HttpError(
        'A trusted worker credential is required.',
        401,
        'WORKER_UNAUTHENTICATED',
      );
    }

    const rawBody = await readTextBody(request, 2_048);
    let input: unknown = {};
    if (rawBody.trim()) {
      try {
        input = JSON.parse(rawBody);
      } catch {
        throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
      }
    }
    const parsed = workerRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError('Worker request contains unsupported fields.', 400, 'INVALID_REQUEST');
    }

    const environment = Deno.env.toObject();
    const providers = createServerIntegrationSuite(environment);
    const serviceClient = createClient(requiredEnvironment('SUPABASE_URL'), serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const repository: OutboundWorkerRepository = {
      async beginSubmission(followupId, claimToken, providerName) {
        const { data, error } = await serviceClient.rpc('begin_storyops_post_service_submission', {
          p_followup_id: followupId,
          p_claim_token: claimToken,
          p_provider_name: providerName,
        });
        if (error) throw new Error('Worker submission boundary could not be persisted.');
        workerResultSchema.parse(data);
      },
      async complete(followupId, claimToken, receipt) {
        const { data, error } = await serviceClient.rpc('complete_storyops_post_service_followup', {
          p_followup_id: followupId,
          p_claim_token: claimToken,
          p_receipt: receipt as unknown as JsonObject,
        });
        if (error) throw new Error('Worker receipt could not be persisted.');
        return workerResultSchema.parse(data);
      },
      async fail(followupId, claimToken, errorCode, retryable) {
        const { data, error } = await serviceClient.rpc('fail_storyops_post_service_followup', {
          p_followup_id: followupId,
          p_claim_token: claimToken,
          p_error_code: errorCode,
          p_retryable: retryable,
        });
        if (error) throw new Error('Worker failure could not be persisted.');
        return workerResultSchema.parse(data);
      },
      async markSubmissionUnknown(
        followupId,
        claimToken,
        errorCode,
        providerName,
        providerMessageId,
      ) {
        const { data, error } = await serviceClient.rpc(
          'mark_storyops_post_service_submission_unknown',
          {
            p_followup_id: followupId,
            p_claim_token: claimToken,
            p_error_code: errorCode,
            p_provider_name: providerName,
            p_provider_message_id: providerMessageId ?? null,
          },
        );
        if (error) throw new Error('Unknown provider submission could not be quarantined.');
        return workerResultSchema.parse(data);
      },
    };

    const workerId = parsed.data.workerId ?? crypto.randomUUID();
    const results: WorkerResult[] = [];
    for (let index = 0; index < parsed.data.batchSize; index += 1) {
      const { data, error } = await serviceClient.rpc('claim_storyops_post_service_followup', {
        p_worker_id: workerId,
        p_lease_seconds: parsed.data.leaseSeconds,
      });
      if (error) throw new Error('Worker claim is unavailable.');
      if (data === null) break;
      const claim: OutboundClaim = outboundClaimSchema.parse(data);
      results.push(
        await processOutboundClaim({
          claim,
          providers,
          repository,
        }),
      );
    }

    const counts = results.reduce<Record<string, number>>((summary, result) => {
      summary[result.status] = (summary[result.status] ?? 0) + 1;
      return summary;
    }, {});
    const response = workerResponseSchema.parse({
      schemaVersion: 'storyops-post-service-worker-run-v1',
      workerId,
      claimed: results.length,
      empty: results.length === 0,
      counts,
      results,
    });
    return jsonResponse(response);
  } catch (error) {
    return errorResponse(error);
  }
});
