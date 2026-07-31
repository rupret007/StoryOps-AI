import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { checkIntegrationEnvironmentHealth } from '../../../src/core/integrations/environmentHealth.ts';
import {
  integrationOverallWithDispatchRetention,
  projectDispatchOriginRetention,
} from '../../../src/core/integrations/dispatchOriginRetention.ts';
import {
  integrationOverallWithOutboundWorkers,
  outboundWorkerHealthProjectionSchema,
  outboundWorkerQueueProjectionSchema,
} from '../../../src/core/integrations/outboundWorkerHealth.ts';
import {
  consumeOperationBudget,
  positiveIntegerSetting,
} from '../../../src/core/integrations/operationBudget.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import { storyopsDeploymentFingerprint } from '../_shared/deployment-fingerprint.ts';
import { inspectRequiredPrivateWorkers } from '../_shared/private-worker-evidence.ts';

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required server environment variable ${name}.`);
  return value;
}

const requestSchema = z.object({
  companyId: z.string().uuid(),
});

function boundedIntegerSetting(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = positiveIntegerSetting(value, fallback, name);
  if (resolved < minimum || resolved > maximum) {
    throw new HttpError(
      `${name} must be between ${minimum} and ${maximum}.`,
      503,
      'WORKER_HEALTH_MISCONFIGURED',
    );
  }
  return resolved;
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
    const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
    const client = createClient(requiredEnvironment('SUPABASE_URL'), serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const {
      data: { user },
      error: authError,
    } = await client.auth.getUser(authorization.slice('Bearer '.length));
    if (authError || !user) {
      throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
    }
    const rawBody = await readTextBody(request, 10_000);
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = requestSchema.safeParse(json);
    if (!parsed.success) {
      throw new HttpError('A valid companyId is required.', 400, 'INVALID_REQUEST');
    }
    const { data: membership, error: membershipError } = await client.rpc(
      'load_storyops_edge_actor',
      {
        p_company_id: parsed.data.companyId,
        p_actor_user_id: user.id,
      },
    );
    if (membershipError || !membership) {
      throw new HttpError('Company membership is required.', 403, 'FORBIDDEN');
    }
    if (!['owner', 'dispatcher'].includes(membership.role)) {
      throw new HttpError(
        'Only owners and dispatchers may run active integration probes.',
        403,
        'FORBIDDEN',
      );
    }
    const healthBudget = await consumeOperationBudget({
      client,
      companyId: parsed.data.companyId,
      scope: 'integration_health:user:hour',
      subject: user.id,
      limit: positiveIntegerSetting(
        Deno.env.get('INTEGRATION_HEALTH_RATE_LIMIT_PER_HOUR'),
        12,
        'INTEGRATION_HEALTH_RATE_LIMIT_PER_HOUR',
      ),
      windowSeconds: 3_600,
    });
    if (!healthBudget.allowed) {
      throw new HttpError(
        `Integration health probe limit reached; retry after ${healthBudget.reset_at}.`,
        429,
        'RATE_LIMITED',
      );
    }

    const environment = Deno.env.toObject();
    const [health, dispatchRetentionResult, auxiliaryQueuesResult] = await Promise.all([
      checkIntegrationEnvironmentHealth(environment),
      client.rpc('get_storyops_dispatch_origin_retention_health'),
      client.rpc('load_storyops_private_worker_queue_evidence', {
        p_company_id: parsed.data.companyId,
        p_actor_user_id: user.id,
      }),
    ]);
    const auxiliaryQueues = z
      .object({
        postService: outboundWorkerQueueProjectionSchema,
        transactionalOutbound: outboundWorkerQueueProjectionSchema,
        schedulingReconciliation: outboundWorkerQueueProjectionSchema,
        scopePhotoCleanup: outboundWorkerQueueProjectionSchema,
      })
      .strict()
      .safeParse(auxiliaryQueuesResult.error ? undefined : auxiliaryQueuesResult.data);
    const dispatchOriginRetention = projectDispatchOriginRetention(
      dispatchRetentionResult.error ? undefined : dispatchRetentionResult.data,
      health.checkedAt,
    );
    const alertAfterSeconds = boundedIntegerSetting(
      environment.OUTBOUND_WORKER_QUEUE_ALERT_AFTER_SECONDS,
      900,
      60,
      86_400,
      'OUTBOUND_WORKER_QUEUE_ALERT_AFTER_SECONDS',
    );
    const fingerprint = await storyopsDeploymentFingerprint(environment, serviceRoleKey);
    const workerConfigurations = await inspectRequiredPrivateWorkers(environment, serviceRoleKey);
    const probeRunId = crypto.randomUUID();
    const queues = {
      post_service: auxiliaryQueues.success
        ? auxiliaryQueues.data.postService
        : {
            availability: 'unavailable' as const,
            reasonCode: 'POST_SERVICE_QUEUE_PROJECTION_UNAVAILABLE' as const,
          },
      transactional_outbound: auxiliaryQueues.success
        ? auxiliaryQueues.data.transactionalOutbound
        : {
            availability: 'unavailable' as const,
            reasonCode: 'TRANSACTIONAL_QUEUE_PROJECTION_UNAVAILABLE' as const,
          },
      scheduling_reconciliation: auxiliaryQueues.success
        ? auxiliaryQueues.data.schedulingReconciliation
        : {
            availability: 'unavailable' as const,
            reasonCode: 'SCHEDULING_RECONCILIATION_QUEUE_PROJECTION_UNAVAILABLE' as const,
          },
      scope_photo_cleanup: auxiliaryQueues.success
        ? auxiliaryQueues.data.scopePhotoCleanup
        : {
            availability: 'unavailable' as const,
            reasonCode: 'SCOPE_PHOTO_CLEANUP_QUEUE_PROJECTION_UNAVAILABLE' as const,
          },
    } as const;
    const { data: workerPersistence, error: workerPersistenceError } = await client.rpc(
      'record_storyops_private_worker_readiness',
      {
        p_company_id: parsed.data.companyId,
        p_actor_user_id: user.id,
        p_probe_run_id: probeRunId,
        p_deployment_fingerprint: fingerprint,
        p_checked_at: health.checkedAt,
        p_alert_after_seconds: alertAfterSeconds,
        p_workers: workerConfigurations.map((configuration) => ({
          ...configuration,
          queue: queues[configuration.worker],
        })),
      },
    );
    if (workerPersistenceError) {
      throw new HttpError(
        'Private-worker health was checked but its company/deployment-bound evidence could not be persisted.',
        503,
        'PRIVATE_WORKER_EVIDENCE_PERSISTENCE_FAILED',
      );
    }
    const outboundWorkers = outboundWorkerHealthProjectionSchema.parse(workerPersistence);
    const results = health.providers.map((provider) => ({
      provider: provider.provider,
      capability: provider.capability,
      mode: provider.mode,
      status: provider.status,
      checkedAt: provider.checkedAt ?? health.checkedAt,
      latencyMs: Math.max(0, Math.round(provider.latencyMs)),
      requiredEnvironment: [...(provider.requiredEnvironment ?? [])].sort(),
    }));
    const identityInvitationResult = results.find(
      (provider) =>
        provider.provider === 'supabase_auth' && provider.capability === 'identity_invitation',
    );
    if (!identityInvitationResult) {
      throw new HttpError(
        'The identity invitation capability was not included in the trusted probe.',
        503,
        'IDENTITY_INVITATION_PROBE_MISSING',
      );
    }
    const { data: persisted, error: persistenceError } = await client.rpc(
      'record_storyops_integration_environment_probe',
      {
        p_company_id: parsed.data.companyId,
        p_actor_user_id: user.id,
        p_probe_run_id: probeRunId,
        p_deployment_fingerprint: fingerprint,
        p_results: results.filter((provider) => provider.provider !== 'supabase_auth'),
      },
    );
    if (persistenceError) {
      throw new HttpError(
        'Provider health was checked but its authoritative secret-safe proof could not be persisted.',
        503,
        'PROVIDER_PROBE_PERSISTENCE_FAILED',
      );
    }
    const { data: identityInvitationPersistence, error: identityPersistenceError } =
      await client.rpc('record_storyops_identity_invitation_environment_probe', {
        p_company_id: parsed.data.companyId,
        p_actor_user_id: user.id,
        p_probe_run_id: probeRunId,
        p_deployment_fingerprint: fingerprint,
        p_result: identityInvitationResult,
      });
    if (identityPersistenceError) {
      throw new HttpError(
        'Identity invitation health was checked but its authoritative proof could not be persisted.',
        503,
        'IDENTITY_INVITATION_PROBE_PERSISTENCE_FAILED',
      );
    }
    return jsonResponse({
      ...health,
      overall: integrationOverallWithOutboundWorkers(
        integrationOverallWithDispatchRetention(health.overall, dispatchOriginRetention),
        outboundWorkers,
      ),
      dispatchOriginRetention,
      outboundWorkers,
      probeRunId,
      persistence: persisted,
      identityInvitationPersistence,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
