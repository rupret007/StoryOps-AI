import { createClient } from '@supabase/supabase-js';
import { IntegrationError } from '../../../src/core/integrations/contracts.ts';
import { createServerIntegrationSuite } from '../../../src/core/integrations/liveServer.ts';
import { HttpError, errorResponse, jsonResponse, readTextBody } from '../_shared/http.ts';
import {
  authorizePrivateWorkerCredential,
  authorizePrivateWorkerTrigger,
} from '../_shared/private-worker-http.ts';
import { recordPrivateWorkerHeartbeat } from '../_shared/private-worker-evidence.ts';
import { assertProviderInvocation } from '../_shared/provider-authorization.ts';
import {
  transactionalClaimSchema,
  transactionalWorkerRequestSchema,
  transactionalWorkerResponseSchema,
  transactionalWorkerResultSchema,
  type TransactionalClaim,
  type TransactionalWorkerResult,
} from './contracts.ts';
import { processTransactionalClaim, type TransactionalWorkerRepository } from './worker.ts';

type JsonObject = Record<string, unknown>;

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new Error(`Missing required server environment variable ${name}.`);
  }
  return value;
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

function submissionBoundaryError(error: { message?: string; code?: string }): IntegrationError {
  if (error.message?.includes('STORYOPS_COMPANY_NOT_ACTIVE')) {
    return new IntegrationError(
      'The company was paused before provider submission.',
      'storyops',
      'STORYOPS_COMPANY_NOT_ACTIVE',
      false,
    );
  }
  if (error.message?.includes('TRANSACTIONAL_DELIVERY_ENTITY_CHANGED_BEFORE_SUBMISSION')) {
    return new IntegrationError(
      'The quote or visit changed before provider submission.',
      'storyops',
      'TRANSACTIONAL_ENTITY_CHANGED',
      false,
    );
  }
  return new IntegrationError(
    'The durable provider submission boundary is unavailable.',
    'storyops',
    'SUBMISSION_BOUNDARY_UNAVAILABLE',
    true,
  );
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }

  let recordFailureHeartbeat: (() => Promise<void>) | undefined;
  try {
    const environment = Deno.env.toObject();
    const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
    const activation = authorizePrivateWorkerCredential(
      environment,
      {
        label: 'transactional outbound worker',
        tokenName: 'TRANSACTIONAL_OUTBOUND_WORKER_TOKEN',
        modeName: 'TRANSACTIONAL_OUTBOUND_WORKER_MODE',
        peerTokenNames: [
          'POST_SERVICE_WORKER_TOKEN',
          'SCHEDULING_RECONCILIATION_TOKEN',
          'SCOPE_PHOTO_CLEANUP_TOKEN',
        ],
      },
      bearerToken(request),
    );
    const rawBody = await readTextBody(request, 2_048);
    let input: unknown = {};
    if (rawBody.trim()) {
      try {
        input = JSON.parse(rawBody);
      } catch {
        throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
      }
    }
    const parsed = transactionalWorkerRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError('Worker request contains unsupported fields.', 400, 'INVALID_REQUEST');
    }
    authorizePrivateWorkerTrigger(activation, parsed.data.trigger, 'Transactional outbound worker');

    const providers = createServerIntegrationSuite(environment);
    const serviceClient = createClient(requiredEnvironment('SUPABASE_URL'), serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const repository: TransactionalWorkerRepository = {
      async authorizeLiveSend(claim) {
        try {
          await assertProviderInvocation(serviceClient, {
            companyId: claim.companyId,
            provider: claim.channel === 'sms' ? 'twilio' : 'email',
            capability: claim.channel === 'sms' ? 'sms_voice' : 'email',
            operationClass: 'launch_start',
          });
        } catch {
          throw new IntegrationError(
            'Customer contact is blocked by authoritative provider or launch controls.',
            claim.channel === 'sms' ? 'twilio' : 'email',
            'PROVIDER_AUTHORIZATION_REQUIRED',
            true,
          );
        }
      },
      async beginSubmission(attemptId, claimToken, providerName) {
        const { error } = await serviceClient.rpc('begin_storyops_transactional_submission', {
          p_attempt_id: attemptId,
          p_claim_token: claimToken,
          p_provider_name: providerName,
        });
        if (error) throw submissionBoundaryError(error);
      },
      async complete(attemptId, claimToken, receipt) {
        const { data, error } = await serviceClient.rpc(
          'complete_storyops_transactional_delivery',
          {
            p_attempt_id: attemptId,
            p_claim_token: claimToken,
            p_receipt: receipt as unknown as JsonObject,
          },
        );
        if (error) {
          throw new Error('Worker receipt could not be persisted.');
        }
        return transactionalWorkerResultSchema.parse(data);
      },
      async fail(attemptId, claimToken, errorCode, retryable) {
        const { data, error } = await serviceClient.rpc('fail_storyops_transactional_delivery', {
          p_attempt_id: attemptId,
          p_claim_token: claimToken,
          p_error_code: errorCode,
          p_retryable: retryable,
        });
        if (error) {
          throw new Error('Worker failure could not be persisted.');
        }
        return transactionalWorkerResultSchema.parse(data);
      },
      async markSubmissionUnknown(
        attemptId,
        claimToken,
        errorCode,
        providerName,
        providerMessageId,
      ) {
        const { data, error } = await serviceClient.rpc(
          'mark_storyops_transactional_submission_unknown',
          {
            p_attempt_id: attemptId,
            p_claim_token: claimToken,
            p_error_code: errorCode,
            p_provider_name: providerName,
            p_provider_message_id: providerMessageId ?? null,
          },
        );
        if (error) {
          throw new Error('Unknown provider submission could not be quarantined.');
        }
        return transactionalWorkerResultSchema.parse(data);
      },
    };

    const workerId = parsed.data.workerId ?? crypto.randomUUID();
    const heartbeatCompanies = new Set<string>();
    if (parsed.data.companyId) heartbeatCompanies.add(parsed.data.companyId);
    recordFailureHeartbeat = () =>
      recordPrivateWorkerHeartbeat({
        client: serviceClient,
        environment,
        serviceRoleKey,
        worker: 'transactional_outbound',
        companyIds: [...heartbeatCompanies],
        trigger: parsed.data.trigger,
        status: 'failed',
      });
    const results: TransactionalWorkerResult[] = [];
    for (let index = 0; index < parsed.data.batchSize; index += 1) {
      const { data, error } = await serviceClient.rpc('claim_storyops_transactional_delivery', {
        p_company_id: parsed.data.companyId,
        p_worker_id: workerId,
        p_lease_seconds: parsed.data.leaseSeconds,
      });
      if (error) throw new Error('Worker claim is unavailable.');
      if (data === null) break;
      const claim: TransactionalClaim = transactionalClaimSchema.parse(data);
      if (claim.companyId !== parsed.data.companyId) {
        throw new Error('Worker claim crossed the requested company scope.');
      }
      heartbeatCompanies.add(claim.companyId);
      results.push(
        await processTransactionalClaim({
          claim,
          providers,
          repository,
        }),
      );
    }
    await recordPrivateWorkerHeartbeat({
      client: serviceClient,
      environment,
      serviceRoleKey,
      worker: 'transactional_outbound',
      companyIds: [...heartbeatCompanies],
      trigger: parsed.data.trigger,
      status: 'succeeded',
    });
    recordFailureHeartbeat = undefined;

    const counts = results.reduce<Record<string, number>>((summary, result) => {
      summary[result.status] = (summary[result.status] ?? 0) + 1;
      return summary;
    }, {});
    return jsonResponse(
      transactionalWorkerResponseSchema.parse({
        schemaVersion: 'storyops-transactional-worker-run-v2',
        activationMode: activation.activationMode,
        trigger: parsed.data.trigger,
        status: 'processed',
        workerId,
        claimed: results.length,
        empty: results.length === 0,
        counts,
        results,
        checkedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    try {
      await recordFailureHeartbeat?.();
    } catch {
      // The original processing error remains authoritative.
    }
    return errorResponse(error);
  }
});
