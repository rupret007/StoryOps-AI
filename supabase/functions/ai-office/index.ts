import { createClient } from '@supabase/supabase-js';
import {
  sha256Hex,
  type AiApprovalRequest,
  type ApprovalStore,
} from '../../../src/core/ai/approval.ts';
import { InMemoryIdempotencyStore } from '../../../src/core/ai/idempotency.ts';
import { OfficeOrchestrator } from '../../../src/core/ai/orchestrator.ts';
import { SandboxStructuredModel } from '../../../src/core/ai/sandboxModel.ts';
import { officeRunRequestSchema, type StructuredModel } from '../../../src/core/ai/contracts.ts';
import { redactSensitive } from '../../../src/core/ai/security.ts';
import type { AiTraceEvent, AiTraceSink } from '../../../src/core/ai/tracing.ts';
import { createServerIntegrationSuite } from '../../../src/core/integrations/liveServer.ts';
import {
  resolveLiveProviderActivation,
  type EnvironmentReader,
} from '../../../src/core/integrations/configuration.ts';
import { createSandboxOfficeToolRegistry } from '../../../src/core/integrations/officeTools.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import { EdgeOpenAiAgentsModel } from '../_shared/openai-agents.ts';
import { resolveAuthoritativeFacts } from '../_shared/authoritative-facts.ts';
import { registerServerPricingTool } from '../_shared/server-pricing-tool.ts';
import {
  consumeOperationBudget,
  positiveIntegerSetting,
} from '../../../src/core/integrations/operationBudget.ts';

type ClaimResult = {
  claim_status: 'reserved' | 'completed' | 'in_progress' | 'conflict';
  stored_response: unknown;
};

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
    const parsed = officeRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        `AI-office request is invalid: ${parsed.error.message}`,
        400,
        'INVALID_REQUEST',
      );
    }

    const { data: membership, error: membershipError } = await serviceClient
      .from('company_memberships')
      .select('role')
      .eq('company_id', parsed.data.companyId)
      .eq('user_id', user.id)
      .eq('active', true)
      .maybeSingle();
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

    const authoritativeFacts = await resolveAuthoritativeFacts(
      serviceClient,
      parsed.data.companyId,
    );
    const officeRequest = {
      ...parsed.data,
      trustedFacts: authoritativeFacts,
    };
    const requestHash = await sha256Hex({
      ...parsed.data,
      trustedFacts: [],
    });
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
      return jsonResponse(claim.stored_response, 200, { 'x-idempotent-replay': 'true' });
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

    try {
      const maxOutputTokens = positiveIntegerSetting(
        Deno.env.get('AI_OFFICE_MAX_OUTPUT_TOKENS'),
        2_000,
        'AI_OFFICE_MAX_OUTPUT_TOKENS',
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
          units: new TextEncoder().encode(rawBody).byteLength + maxOutputTokens,
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
      const environment = Deno.env.toObject();
      const suite = createServerIntegrationSuite(environment);
      const selectedModel = selectModel(environment, maxOutputTokens);
      const approvalStore: ApprovalStore = {
        async get(approvalId) {
          const { data, error } = await serviceClient
            .from('approval_requests')
            .select('*')
            .eq('id', approvalId)
            .maybeSingle();
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
          const persistedStatus = approval.status === 'consumed' ? 'approved' : approval.status;
          const { error } = await serviceClient.from('approval_requests').upsert({
            id: approval.approvalId,
            company_id: approval.companyId,
            reason: approvalReason(approval.toolName),
            risk_level: approval.risk,
            status: persistedStatus,
            requested_by_type: approval.requestedBy.role === 'system' ? 'system' : 'user',
            requested_by_id: approval.requestedBy.id,
            requested_at: approval.createdAt,
            expires_at: approval.expiresAt,
            entity_type: 'ai_action',
            action_type: approval.toolName,
            action_payload: {
              exactPayload: approval.exactPayload,
              payloadHash: approval.payloadHash,
              runId: approval.runId,
              actionId: approval.actionId,
              toolName: approval.toolName,
            },
            summary: approval.reason,
            policy_version: approval.policyRule,
            decided_by: approval.decidedBy?.id ?? null,
            decided_at: approval.decidedAt ?? null,
            decision_note: approval.decisionNote ?? null,
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
          const { error } = await serviceClient.from('ai_traces').insert({
            company_id: parsed.data.companyId,
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
          });
          if (error) throw error;
        },
      };
      const tools = createSandboxOfficeToolRegistry(suite);
      registerServerPricingTool(tools, serviceClient);
      const orchestrator = new OfficeOrchestrator({
        model: selectedModel,
        tools,
        approvals: approvalStore,
        idempotency: new InMemoryIdempotencyStore(),
        traces: traceSink,
      });
      const result = await orchestrator.run(officeRequest);
      const { error: completeError } = await serviceClient.rpc('complete_idempotency_key', {
        p_company_id: parsed.data.companyId,
        p_scope: 'edge:ai-office',
        p_key: parsed.data.idempotencyKey,
        p_request_hash: requestHash,
        p_response: result,
      });
      if (completeError) throw completeError;
      return jsonResponse(result);
    } catch (error) {
      await serviceClient
        .from('idempotency_keys')
        .update({
          status: 'failed',
          error_code: error instanceof Error ? error.name : 'UnknownError',
          completed_at: new Date().toISOString(),
        })
        .eq('company_id', parsed.data.companyId)
        .eq('scope', 'edge:ai-office')
        .eq('key', parsed.data.idempotencyKey)
        .eq('request_hash', requestHash)
        .eq('status', 'in_progress');
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
});
