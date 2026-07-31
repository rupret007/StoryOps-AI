import { createClient } from '@supabase/supabase-js';
import {
  sha256Hex,
  type AiApprovalRequest,
  type ApprovalStore,
} from '../../../src/core/ai/approval.ts';
import { InMemoryIdempotencyStore } from '../../../src/core/ai/idempotency.ts';
import { OfficeOrchestrator } from '../../../src/core/ai/orchestrator.ts';
import { SandboxStructuredModel } from '../../../src/core/ai/sandboxModel.ts';
import type { StructuredModel } from '../../../src/core/ai/contracts.ts';
import {
  durableAiOfficeRunSchema,
  liveAiOfficeEdgeRequestSchema,
  liveAiOfficeRunResponseSchema,
  strictOfficeRunResultSchema,
  type LiveAiOfficeEdgeRequest,
  type LiveAiOfficeRunResponse,
} from '../../../src/core/ai/liveOffice.ts';
import {
  DEFAULT_MAX_GUARDED_MODEL_INPUT_BYTES,
  DEFAULT_MAX_GUARDED_MODEL_INPUT_TOKENS,
  buildGuardedModelInput,
  calculateGuardedModelTokenReservation,
  redactSensitive,
} from '../../../src/core/ai/security.ts';
import type { AiTraceEvent, AiTraceSink } from '../../../src/core/ai/tracing.ts';
import {
  resolveLiveProviderActivation,
  type EnvironmentReader,
} from '../../../src/core/integrations/configuration.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import { assertProviderInvocation } from '../_shared/provider-authorization.ts';
import { EdgeOpenAiAgentsModel } from '../_shared/openai-agents.ts';
import {
  AuthoritativeFactScopeError,
  resolveAuthoritativeFacts,
} from '../_shared/authoritative-facts.ts';
import { createServerAiOfficeToolRegistry } from '../_shared/server-ai-office-tools.ts';
import {
  consumeOperationBudget,
  positiveIntegerSetting,
} from '../../../src/core/integrations/operationBudget.ts';

type ClaimResult = {
  claim_status: 'reserved' | 'completed' | 'in_progress' | 'conflict';
  stored_response: unknown;
};

function assertBoundResponse(
  value: unknown,
  request: LiveAiOfficeEdgeRequest,
  actorUserId: string,
): LiveAiOfficeRunResponse {
  const response = liveAiOfficeRunResponseSchema.parse(value);
  if (
    response.companyId !== request.companyId ||
    response.actorUserId !== actorUserId ||
    response.run.companyId !== request.companyId ||
    response.run.actorUserId !== actorUserId ||
    response.run.automationRunId !== request.runId ||
    response.run.agent !== request.agent
  ) {
    throw new HttpError(
      'AI Office response identity did not match the authenticated run.',
      502,
      'AI_OFFICE_RESPONSE_IDENTITY_MISMATCH',
    );
  }
  return response;
}

function rootSelector(request: LiveAiOfficeEdgeRequest): Record<string, string> {
  const selector = request.trustedFacts[0];
  return selector
    ? {
        type: selector.name.slice(0, -'_id'.length),
        id: selector.value,
      }
    : {};
}

function safeDurableError(error: unknown): { code: string; message: string } {
  if (error instanceof HttpError) {
    return {
      code: /^[A-Z0-9_]{1,120}$/u.test(error.code) ? error.code : 'AI_OFFICE_RUN_FAILED',
      message:
        error.status >= 500
          ? 'AI Office run failed before completion.'
          : error.message.slice(0, 500),
    };
  }
  return {
    code: 'AI_OFFICE_RUN_FAILED',
    message: 'AI Office run failed before completion.',
  };
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required server environment variable ${name}.`);
  return value;
}

function selectModel(environment: EnvironmentReader, maxOutputTokens: number): StructuredModel {
  const activation = resolveLiveProviderActivation(
    environment,
    'OPENAI_LIVE_ENABLED',
    'OPENAI_MODE',
  );
  if (activation.runtimeMode === 'disabled') {
    throw new HttpError(
      'OpenAI is disabled or its two-part activation is incomplete; AI Office cannot run.',
      503,
      'AI_PROVIDER_DISABLED',
    );
  }
  if (!activation.enabled) {
    return new SandboxStructuredModel();
  }
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const model = environment.OPENAI_MODEL?.trim();
  if (!apiKey || !model) {
    throw new HttpError(
      'Live OpenAI requires OPENAI_MODE=live, OPENAI_LIVE_ENABLED=true, OPENAI_API_KEY, and OPENAI_MODEL.',
      503,
      'AI_PROVIDER_MISCONFIGURED',
    );
  }
  return new EdgeOpenAiAgentsModel(apiKey, model, maxOutputTokens);
}

function approvalReason(toolName: string): string {
  return (
    {
      'pricing.override': 'price_exception',
      'pricebook.publish': 'outside_price_book',
      'payments.refund': 'refund',
      'legal.send_message': 'legal_message',
      'safety.send_message': 'safety_message',
      'communications.reply_negative_review': 'negative_review_response',
      'vendor.change': 'vendor_action',
      'bank.transfer': 'bank_action',
      'records.merge': 'destructive_change',
    }[toolName] ?? 'other'
  );
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }

  const serviceClient = createClient(
    requiredEnvironment('SUPABASE_URL'),
    requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  try {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
    }
    const token = authorization.slice('Bearer '.length);
    const {
      data: { user },
      error: authError,
    } = await serviceClient.auth.getUser(token);
    if (authError || !user) {
      throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
    }

    const rawBody = await readTextBody(request, 250_000);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = liveAiOfficeEdgeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        `AI-office request is invalid: ${parsed.error.message}`,
        400,
        'INVALID_REQUEST',
      );
    }

    const { data: membership, error: membershipError } = await serviceClient.rpc(
      'load_storyops_edge_actor',
      {
        p_company_id: parsed.data.companyId,
        p_actor_user_id: user.id,
      },
    );
    if (membershipError || !membership) {
      throw new HttpError(
        'The authenticated user is not an active company member.',
        403,
        'FORBIDDEN',
      );
    }
    if (membership.role !== 'owner' && membership.role !== 'dispatcher') {
      throw new HttpError('AI-office runs require an owner or dispatcher role.', 403, 'FORBIDDEN');
    }
    if (parsed.data.actor.id !== user.id || parsed.data.actor.role !== membership.role) {
      throw new HttpError(
        'The request actor must match the authenticated company membership.',
        403,
        'ACTOR_MISMATCH',
      );
    }

    const requestHash = await sha256Hex(parsed.data);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    const { data: claims, error: claimError } = await serviceClient.rpc('claim_idempotency_key', {
      p_company_id: parsed.data.companyId,
      p_scope: 'edge:ai-office',
      p_key: parsed.data.idempotencyKey,
      p_request_hash: requestHash,
      p_expires_at: expiresAt,
    });
    if (claimError) throw claimError;
    const claim = (claims as ClaimResult[] | null)?.[0];
    if (!claim) throw new Error('Idempotency RPC returned no claim.');
    if (claim.claim_status === 'completed') {
      const storedResponse = assertBoundResponse(claim.stored_response, parsed.data, user.id);
      return jsonResponse(storedResponse, 200, { 'x-idempotent-replay': 'true' });
    }
    if (claim.claim_status === 'in_progress') {
      throw new HttpError(
        'An identical AI-office run is still in progress.',
        409,
        'IDEMPOTENCY_IN_PROGRESS',
      );
    }
    if (claim.claim_status === 'conflict') {
      throw new HttpError(
        'Idempotency key was used with a different payload.',
        409,
        'IDEMPOTENCY_CONFLICT',
      );
    }

    let durableRunStarted = false;
    try {
      const { data: startedData, error: startedError } = await serviceClient.rpc(
        'begin_storyops_ai_office_run',
        {
          p_company_id: parsed.data.companyId,
          p_actor_user_id: user.id,
          p_run_id: parsed.data.runId,
          p_agent: parsed.data.agent,
          p_idempotency_key: parsed.data.idempotencyKey,
          p_root_selector: rootSelector(parsed.data),
          p_manual_input_present: parsed.data.untrustedContent.length > 0,
          p_requested_at: parsed.data.requestedAt,
        },
      );
      if (startedError) throw startedError;
      const startedRun = durableAiOfficeRunSchema.parse(startedData);
      if (
        startedRun.companyId !== parsed.data.companyId ||
        startedRun.actorUserId !== user.id ||
        startedRun.automationRunId !== parsed.data.runId ||
        startedRun.agent !== parsed.data.agent
      ) {
        throw new HttpError(
          'Durable AI Office start receipt identity did not match the request.',
          502,
          'AI_OFFICE_START_IDENTITY_MISMATCH',
        );
      }
      durableRunStarted = true;
      if (
        startedRun.durableStatus === 'succeeded' ||
        startedRun.durableStatus === 'waiting_approval'
      ) {
        const recoveredResponse = assertBoundResponse(
          {
            schemaVersion: 'storyops-ai-office-response-v1',
            companyId: parsed.data.companyId,
            actorUserId: user.id,
            manualTriggered: true,
            schedulerConfigured: false,
            run: startedRun,
          },
          parsed.data,
          user.id,
        );
        const { error: recoveredCompleteError } = await serviceClient.rpc(
          'complete_idempotency_key',
          {
            p_company_id: parsed.data.companyId,
            p_scope: 'edge:ai-office',
            p_key: parsed.data.idempotencyKey,
            p_request_hash: requestHash,
            p_response: recoveredResponse,
          },
        );
        if (recoveredCompleteError) throw recoveredCompleteError;
        return jsonResponse(recoveredResponse, 200, { 'x-idempotent-replay': 'true' });
      }
      if (startedRun.durableStatus !== 'running') {
        throw new HttpError(
          'Durable AI Office run is not in an executable state.',
          409,
          'AI_OFFICE_RUN_NOT_EXECUTABLE',
        );
      }

      let authoritativeFacts: Awaited<ReturnType<typeof resolveAuthoritativeFacts>>;
      try {
        authoritativeFacts = await resolveAuthoritativeFacts(
          serviceClient,
          parsed.data.companyId,
          parsed.data,
          user.id,
        );
      } catch (error) {
        if (error instanceof AuthoritativeFactScopeError) {
          throw new HttpError(error.message, 400, error.code);
        }
        throw error;
      }
      const officeRequest = {
        ...parsed.data,
        trustedFacts: authoritativeFacts,
      };
      const maxOutputTokens = positiveIntegerSetting(
        Deno.env.get('AI_OFFICE_MAX_OUTPUT_TOKENS'),
        2_000,
        'AI_OFFICE_MAX_OUTPUT_TOKENS',
      );
      const maxInputBytes = positiveIntegerSetting(
        Deno.env.get('AI_OFFICE_MAX_INPUT_BYTES'),
        DEFAULT_MAX_GUARDED_MODEL_INPUT_BYTES,
        'AI_OFFICE_MAX_INPUT_BYTES',
      );
      const maxInputTokens = positiveIntegerSetting(
        Deno.env.get('AI_OFFICE_MAX_INPUT_TOKENS'),
        DEFAULT_MAX_GUARDED_MODEL_INPUT_TOKENS,
        'AI_OFFICE_MAX_INPUT_TOKENS',
      );
      const hourlyUserRuns = positiveIntegerSetting(
        Deno.env.get('AI_OFFICE_RUNS_PER_USER_PER_HOUR'),
        30,
        'AI_OFFICE_RUNS_PER_USER_PER_HOUR',
      );
      const dailyCompanyRuns = positiveIntegerSetting(
        Deno.env.get('AI_OFFICE_RUNS_PER_COMPANY_PER_DAY'),
        250,
        'AI_OFFICE_RUNS_PER_COMPANY_PER_DAY',
      );
      const dailyTokenBudget = positiveIntegerSetting(
        Deno.env.get('AI_OFFICE_DAILY_TOKEN_BUDGET'),
        1_000_000,
        'AI_OFFICE_DAILY_TOKEN_BUDGET',
      );
      const environment = Deno.env.toObject();
      if (
        resolveLiveProviderActivation(environment, 'OPENAI_LIVE_ENABLED', 'OPENAI_MODE').enabled
      ) {
        await assertProviderInvocation(serviceClient, {
          companyId: parsed.data.companyId,
          provider: 'openai',
          capability: 'structured_ai',
          operationClass: 'internal',
        });
      }
      const selectedModel = selectModel(environment, maxOutputTokens);
      const guardedModelInput = buildGuardedModelInput(officeRequest, {
        provider: selectedModel.provider,
        maxInputBytes,
        maxInputTokens,
      });
      const tokenReservation = calculateGuardedModelTokenReservation(
        guardedModelInput,
        maxOutputTokens,
      );
      const budgets = await Promise.all([
        consumeOperationBudget({
          client: serviceClient,
          companyId: officeRequest.companyId,
          scope: 'edge:ai-office:user-runs',
          subject: user.id,
          limit: hourlyUserRuns,
          windowSeconds: 3_600,
        }),
        consumeOperationBudget({
          client: serviceClient,
          companyId: officeRequest.companyId,
          scope: 'edge:ai-office:company-runs',
          subject: officeRequest.companyId,
          limit: dailyCompanyRuns,
          windowSeconds: 86_400,
        }),
        consumeOperationBudget({
          client: serviceClient,
          companyId: officeRequest.companyId,
          scope: 'edge:ai-office:token-reservations',
          subject: officeRequest.companyId,
          limit: dailyTokenBudget,
          windowSeconds: 86_400,
          units: tokenReservation,
        }),
      ]);
      if (budgets.some((budget) => !budget.allowed)) {
        const resetAt = budgets
          .filter((budget) => !budget.allowed)
          .map((budget) => budget.reset_at)
          .sort()[0];
        throw new HttpError(
          `AI-office operation budget exceeded until ${resetAt}.`,
          429,
          'RATE_LIMITED',
        );
      }
      const approvalStore: ApprovalStore = {
        async get(approvalId) {
          const { data, error } = await serviceClient.rpc('load_storyops_ai_approval', {
            p_company_id: parsed.data.companyId,
            p_actor_user_id: user.id,
            p_approval_id: approvalId,
          });
          if (error) throw error;
          if (!data) return undefined;
          const actionPayload = data.action_payload as {
            exactPayload: AiApprovalRequest['exactPayload'];
            payloadHash: string;
            runId: string;
            actionId: string;
            toolName: string;
          };
          return {
            approvalId: data.id,
            companyId: data.company_id,
            runId: actionPayload.runId,
            actionId: actionPayload.actionId,
            toolName: actionPayload.toolName,
            risk: data.risk_level,
            exactPayload: actionPayload.exactPayload,
            payloadHash: actionPayload.payloadHash,
            reason: data.summary,
            policyRule: data.policy_version,
            requestedBy: {
              id: data.requested_by_id,
              role: 'owner',
            },
            status: data.status,
            createdAt: data.created_at,
            expiresAt: data.expires_at,
            decidedAt: data.decided_at ?? undefined,
            decisionNote: data.decision_note ?? undefined,
          } as AiApprovalRequest;
        },
        async save(approval) {
          const { error } = await serviceClient.rpc('create_storyops_ai_approval', {
            p_company_id: approval.companyId,
            p_actor_user_id: user.id,
            p_approval_id: approval.approvalId,
            p_reason: approvalReason(approval.toolName),
            p_risk_level: approval.risk,
            p_requested_by_type: approval.requestedBy.role === 'system' ? 'system' : 'user',
            p_requested_by_id: approval.requestedBy.id,
            p_requested_at: approval.createdAt,
            p_expires_at: approval.expiresAt,
            p_action_type: approval.toolName,
            p_action_payload: {
              exactPayload: approval.exactPayload,
              payloadHash: approval.payloadHash,
              runId: approval.runId,
              actionId: approval.actionId,
              toolName: approval.toolName,
            },
            p_summary: approval.reason,
            p_policy_version: approval.policyRule,
          });
          if (error) throw error;
        },
      };
      const traceSink: AiTraceSink = {
        async append(event: AiTraceEvent) {
          const status = (() => {
            if (event.type === 'guardrail.flagged') return 'guardrail_blocked';
            if (event.type === 'approval.created') return 'approval_required';
            if (event.type === 'tool.failed' || event.type === 'model.rejected') {
              return 'failed';
            }
            if (
              event.type === 'run.completed' ||
              event.type === 'run.replayed' ||
              event.type === 'model.completed' ||
              event.type === 'policy.evaluated' ||
              event.type === 'tool.completed'
            ) {
              return 'succeeded';
            }
            return 'started';
          })();
          const { error } = await serviceClient.rpc('append_storyops_ai_trace', {
            p_company_id: parsed.data.companyId,
            p_actor_user_id: user.id,
            p_trace: {
              trace_id: event.traceId,
              span_id: globalThis.crypto.randomUUID(),
              agent: event.agent === 'owner_briefing' ? 'briefing' : event.agent,
              operation: event.type,
              status,
              model: event.type.startsWith('model.') ? selectedModel.provider : null,
              prompt_version: 'storyops-ai-office-v1',
              tool_name: 'toolName' in event ? (event.toolName ?? null) : null,
              started_at: event.at,
              ended_at: status === 'started' ? null : event.at,
              input_redacted: {},
              output_redacted: redactSensitive(event.attributes ?? {}),
              guardrail_results:
                event.type === 'guardrail.flagged' ? redactSensitive(event.attributes ?? {}) : {},
              retain_until: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
            },
          });
          if (error) throw error;
        },
      };
      const actorClient = createClient(
        requiredEnvironment('SUPABASE_URL'),
        requiredEnvironment('SUPABASE_ANON_KEY'),
        {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            headers: {
              Authorization: authorization,
              'x-request-id': parsed.data.runId,
            },
          },
        },
      );
      const tools = createServerAiOfficeToolRegistry({
        readClient: serviceClient,
        commandClient: actorClient,
      });
      const orchestrator = new OfficeOrchestrator({
        model: selectedModel,
        tools,
        approvals: approvalStore,
        idempotency: new InMemoryIdempotencyStore(),
        traces: traceSink,
      });
      const result = strictOfficeRunResultSchema.parse(await orchestrator.run(officeRequest));
      if (
        result.runId !== parsed.data.runId ||
        result.agent !== parsed.data.agent ||
        result.replayed
      ) {
        throw new HttpError(
          'AI Office result identity did not match the requested run.',
          502,
          'AI_OFFICE_RESULT_IDENTITY_MISMATCH',
        );
      }
      const modelMode = selectedModel.provider === 'sandbox-openai' ? 'sandbox' : 'live';
      const { data: completedData, error: completedError } = await serviceClient.rpc(
        'complete_storyops_ai_office_run',
        {
          p_company_id: parsed.data.companyId,
          p_actor_user_id: user.id,
          p_run_id: parsed.data.runId,
          p_agent: parsed.data.agent,
          p_model_mode: modelMode,
          p_result: result,
        },
      );
      if (completedError) throw completedError;
      const durableRun = durableAiOfficeRunSchema.parse(completedData);
      const response = assertBoundResponse(
        {
          schemaVersion: 'storyops-ai-office-response-v1',
          companyId: parsed.data.companyId,
          actorUserId: user.id,
          manualTriggered: true,
          schedulerConfigured: false,
          run: durableRun,
        },
        parsed.data,
        user.id,
      );
      const { error: completeError } = await serviceClient.rpc('complete_idempotency_key', {
        p_company_id: parsed.data.companyId,
        p_scope: 'edge:ai-office',
        p_key: parsed.data.idempotencyKey,
        p_request_hash: requestHash,
        p_response: response,
      });
      if (completeError) throw completeError;
      return jsonResponse(response);
    } catch (error) {
      const durableError = safeDurableError(error);
      const failureWrites: PromiseLike<unknown>[] = [];
      if (durableRunStarted) {
        failureWrites.push(
          serviceClient.rpc('fail_storyops_ai_office_run', {
            p_company_id: parsed.data.companyId,
            p_actor_user_id: user.id,
            p_run_id: parsed.data.runId,
            p_agent: parsed.data.agent,
            p_error_code: durableError.code,
            p_error_message: durableError.message,
          }),
        );
      }
      failureWrites.push(
        serviceClient.rpc('fail_idempotency_key', {
          p_company_id: parsed.data.companyId,
          p_scope: 'edge:ai-office',
          p_key: parsed.data.idempotencyKey,
          p_request_hash: requestHash,
          p_error_code: durableError.code,
        }),
      );
      await Promise.allSettled(failureWrites);
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
});
