import { createClient } from '@supabase/supabase-js';
import { resolveLiveProviderActivation } from '../../../src/core/integrations/configuration.ts';
import {
  positiveIntegerSetting,
  consumeOperationBudget,
} from '../../../src/core/integrations/operationBudget.ts';
import { GoogleCalendarProvider } from '../../../src/core/integrations/liveServer.ts';
import { constantTimeEqual } from '../../../src/core/integrations/webhooks.ts';
import { HttpError, errorResponse, jsonResponse, readTextBody } from '../_shared/http.ts';
import { inspectDedicatedWorkerCredential } from '../_shared/private-worker.ts';
import { recordPrivateWorkerHeartbeat } from '../_shared/private-worker-evidence.ts';
import { assertProviderInvocation } from '../_shared/provider-authorization.ts';
import {
  resolveSchedulingReconciliationActivation,
  schedulingReconciliationClaimSchema,
  schedulingReconciliationRequestSchema,
  schedulingReconciliationResultSchema,
  schedulingReconciliationRunSchema,
  type SchedulingReconciliationResult,
} from './contracts.ts';
import {
  processSchedulingReconciliationClaim,
  type SchedulingReconciliationRepository,
} from './worker.ts';

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new HttpError(`Server configuration ${name} is missing.`, 503, 'MISCONFIGURED');
  }
  return value;
}

function privateWorkerToken(environment: Readonly<Record<string, string | undefined>>): string {
  const inspection = inspectDedicatedWorkerCredential(environment, {
    label: 'scheduling reconciliation worker',
    tokenName: 'SCHEDULING_RECONCILIATION_TOKEN',
    modeName: 'SCHEDULING_RECONCILIATION_MODE',
    peerTokenNames: [
      'POST_SERVICE_WORKER_TOKEN',
      'TRANSACTIONAL_OUTBOUND_WORKER_TOKEN',
      'SCOPE_PHOTO_CLEANUP_TOKEN',
    ],
  });
  if (inspection !== 'valid') {
    throw new HttpError(
      'The scheduling reconciliation credential is invalid.',
      503,
      'MISCONFIGURED',
    );
  }
  return requiredEnvironment('SCHEDULING_RECONCILIATION_TOKEN');
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
}

function retryAfterSeconds(resetAt: string): number {
  const seconds = Math.ceil((Date.parse(resetAt) - Date.now()) / 1_000);
  return Math.min(3_600, Math.max(30, Number.isFinite(seconds) ? seconds : 60));
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, {
      allow: 'POST',
    });
  }

  let recordFailureHeartbeat: (() => Promise<void>) | undefined;
  try {
    const environment = Deno.env.toObject();
    const expectedToken = privateWorkerToken(environment);
    const suppliedToken = bearerToken(request);
    if (!suppliedToken || !constantTimeEqual(suppliedToken, expectedToken)) {
      throw new HttpError(
        'A private scheduling reconciliation credential is required.',
        401,
        'WORKER_UNAUTHENTICATED',
      );
    }

    const rawBody = await readTextBody(request, 2_048);
    let body: unknown = {};
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
      }
    }
    const parsed = schedulingReconciliationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError('Worker request contains unsupported fields.', 400, 'INVALID_REQUEST');
    }

    const activation = resolveSchedulingReconciliationActivation(environment);
    if (!activation.enabled) {
      return jsonResponse(
        schedulingReconciliationRunSchema.parse({
          schemaVersion: 'storyops-scheduling-reconciliation-run-v1',
          mode: activation.runtimeMode,
          status: 'inactive',
          claimed: 0,
          empty: true,
          counts: {},
          results: [],
          message:
            'Scheduling reconciliation is not live-enabled. No durable claim or provider mutation was attempted.',
          checkedAt: new Date().toISOString(),
        }),
      );
    }
    if (!parsed.data.companyId) {
      throw new HttpError(
        'Live scheduled reconciliation requires an exact companyId heartbeat scope.',
        400,
        'WORKER_COMPANY_SCOPE_REQUIRED',
      );
    }

    const calendarActivation = resolveLiveProviderActivation(
      environment,
      'GOOGLE_CALENDAR_LIVE_ENABLED',
      'GOOGLE_CALENDAR_MODE',
    );
    if (!calendarActivation.enabled) {
      throw new HttpError(
        'Live Google Calendar must be independently enabled before reconciliation can claim work.',
        503,
        'LIVE_CALENDAR_NOT_ENABLED',
      );
    }

    const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
    if (constantTimeEqual(expectedToken, serviceRoleKey)) {
      throw new HttpError(
        'The reconciliation credential must be separate from the database service credential.',
        503,
        'MISCONFIGURED',
      );
    }
    const serviceClient = createClient(requiredEnvironment('SUPABASE_URL'), serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const calendar = new GoogleCalendarProvider({
      accessToken: environment.GOOGLE_CALENDAR_ACCESS_TOKEN,
      clientId: environment.GOOGLE_CALENDAR_CLIENT_ID,
      clientSecret: environment.GOOGLE_CALENDAR_CLIENT_SECRET,
      refreshToken: environment.GOOGLE_CALENDAR_REFRESH_TOKEN,
      calendarId: requiredEnvironment('GOOGLE_CALENDAR_ID'),
    });
    const callsPerHour = positiveIntegerSetting(
      environment.SCHEDULING_RECONCILIATION_PROVIDER_CALLS_PER_HOUR,
      60,
      'SCHEDULING_RECONCILIATION_PROVIDER_CALLS_PER_HOUR',
    );
    if (callsPerHour > 1_000) {
      throw new HttpError(
        'Scheduling reconciliation provider-call limit must not exceed 1000 per company per hour.',
        503,
        'MISCONFIGURED',
      );
    }

    const repository: SchedulingReconciliationRepository = {
      async complete(caseId, claimToken) {
        const { data, error } = await serviceClient.rpc(
          'complete_storyops_scheduling_reconciliation',
          {
            p_case_id: caseId,
            p_claim_token: claimToken,
          },
        );
        if (error) {
          throw new Error('Calendar cancellation completion could not be persisted.');
        }
        return schedulingReconciliationResultSchema.parse(data);
      },
      async fail(caseId, claimToken, errorCode, disposition, retrySeconds) {
        const { data, error } = await serviceClient.rpc('fail_storyops_scheduling_reconciliation', {
          p_case_id: caseId,
          p_claim_token: claimToken,
          p_error_code: errorCode,
          p_disposition: disposition,
          p_retry_after_seconds: retrySeconds,
        });
        if (error) {
          throw new Error('Calendar reconciliation failure could not be persisted.');
        }
        return schedulingReconciliationResultSchema.parse(data);
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
        worker: 'scheduling_reconciliation',
        companyIds: [...heartbeatCompanies],
        trigger: 'scheduled',
        status: 'failed',
      });
    const results: SchedulingReconciliationResult[] = [];
    for (let index = 0; index < parsed.data.batchSize; index += 1) {
      const { data, error } = await serviceClient.rpc('claim_storyops_scheduling_reconciliation', {
        p_company_id: parsed.data.companyId,
        p_worker_id: workerId,
        p_lease_seconds: parsed.data.leaseSeconds,
      });
      if (error) {
        throw new Error('Scheduling reconciliation claim is unavailable.');
      }
      if (data === null) break;
      const claim = schedulingReconciliationClaimSchema.parse(data);
      if (claim.companyId !== parsed.data.companyId) {
        throw new Error('Reconciliation claim crossed the requested company scope.');
      }
      heartbeatCompanies.add(claim.companyId);
      await assertProviderInvocation(serviceClient, {
        companyId: claim.companyId,
        provider: 'google_calendar',
        capability: 'calendar',
        operationClass: 'recovery',
      });
      results.push(
        await processSchedulingReconciliationClaim({
          claim,
          calendar,
          repository,
          async consumeBudget() {
            const budget = await consumeOperationBudget({
              client: serviceClient,
              companyId: claim.companyId,
              scope: 'scheduling-reconciliation:company:hour',
              subject: 'google-calendar-expired-reservation-cleanup',
              limit: callsPerHour,
              windowSeconds: 3_600,
            });
            return {
              allowed: budget.allowed,
              retryAfterSeconds: retryAfterSeconds(budget.reset_at),
            };
          },
        }),
      );
    }
    await recordPrivateWorkerHeartbeat({
      client: serviceClient,
      environment,
      serviceRoleKey,
      worker: 'scheduling_reconciliation',
      companyIds: [...heartbeatCompanies],
      trigger: 'scheduled',
      status: 'succeeded',
    });
    recordFailureHeartbeat = undefined;

    const counts = results.reduce<Record<string, number>>((summary, result) => {
      summary[result.status] = (summary[result.status] ?? 0) + 1;
      return summary;
    }, {});
    return jsonResponse(
      schedulingReconciliationRunSchema.parse({
        schemaVersion: 'storyops-scheduling-reconciliation-run-v1',
        mode: 'live',
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
      // Do not mask the worker/provider error that caused the failed run.
    }
    return errorResponse(error);
  }
});
