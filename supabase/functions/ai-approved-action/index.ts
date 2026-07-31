import { createClient } from '@supabase/supabase-js';
import { agentCanUseTool } from '../../../src/core/ai/agents.ts';
import { withRetry } from '../../../src/core/ai/retry.ts';
import { ToolExecutionError } from '../../../src/core/ai/tools.ts';
import { createServerIntegrationSuite } from '../../../src/core/integrations/liveServer.ts';
import { isLiveProviderEnabled } from '../../../src/core/integrations/configuration.ts';
import { createSandboxIntegrationSuite } from '../../../src/core/integrations/sandbox.ts';
import { createSandboxOfficeToolRegistry } from '../../../src/core/integrations/officeTools.ts';
import { IntegrationError } from '../../../src/core/integrations/contracts.ts';
import { SupabaseStripeBillingValidator } from '../../../src/core/integrations/stripeBillingValidator.ts';
import { registerServerRecordTools } from '../_shared/server-record-tools.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import { assertProviderInvocation } from '../_shared/provider-authorization.ts';
import {
  ApprovedActionContractError,
  approvedActionRequestSchema,
  approvedToolAgent,
  parseApprovedLeadPayload,
  parseAndRevalidatePersistedApproval,
  parseApprovedRefundOutput,
  parseApprovedRefundPayload,
  safeExecutionErrorCode,
  type ApprovedRefundOutput,
  type ApprovedRefundPayload,
  type PersistedApprovedAction,
} from './contracts.ts';
import type { OfficeAgentName } from '../../../src/core/ai/contracts.ts';

type ClaimRow = {
  claim_status: 'reserved' | 'completed' | 'in_progress' | 'failed';
  execution_id: string;
  execution_token: string | null;
  provider_idempotency_key: string | null;
  stored_response: unknown;
  attempt_count: number;
};

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required server environment variable ${name}.`);
  return value;
}

function contractHttpError(error: ApprovedActionContractError): HttpError {
  const status =
    error.code === 'UNSUPPORTED_TOOL' || error.code === 'APPROVAL_MALFORMED' ? 422 : 409;
  return new HttpError(error.message, status, error.code);
}

function claimHttpError(message: string): HttpError {
  const mappings: Array<[string, number, string, string]> = [
    [
      'APPROVED_ACTION_OWNER_REQUIRED',
      403,
      'OWNER_REQUIRED',
      'Only an active owner may execute an approved action.',
    ],
    ['APPROVED_ACTION_NOT_FOUND', 404, 'APPROVAL_NOT_FOUND', 'The approval request was not found.'],
    [
      'APPROVED_ACTION_PENDING',
      409,
      'APPROVAL_PENDING',
      'The action is still waiting for owner approval.',
    ],
    ['APPROVED_ACTION_REJECTED', 409, 'APPROVAL_REJECTED', 'The owner rejected this action.'],
    ['APPROVED_ACTION_EXPIRED', 409, 'APPROVAL_EXPIRED', 'The approval has expired.'],
    ['APPROVED_ACTION_CONSUMED', 409, 'APPROVAL_CONSUMED', 'The approval was already consumed.'],
    [
      'APPROVED_ACTION_NOT_APPROVED',
      409,
      'APPROVAL_NOT_APPROVED',
      'The action has not been approved.',
    ],
    [
      'APPROVED_ACTION_IDEMPOTENCY_CONFLICT',
      409,
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key conflicts with another action.',
    ],
    [
      'APPROVED_ACTION_PAYLOAD_MISMATCH',
      409,
      'APPROVAL_MISMATCH',
      'The persisted action no longer matches the approved payload.',
    ],
    [
      'APPROVED_ACTION_UNSUPPORTED_TOOL',
      422,
      'UNSUPPORTED_TOOL',
      'This approved action has no authoritative server validator.',
    ],
    [
      'APPROVED_ACTION_REFUND_NOT_ALLOWED',
      422,
      'REFUND_NOT_ALLOWED',
      'Current authoritative payment state does not allow this refund.',
    ],
    [
      'APPROVED_ACTION_AUTHORITATIVE_STATE_AMBIGUOUS',
      422,
      'AUTHORITATIVE_STATE_AMBIGUOUS',
      'Authoritative payment state is ambiguous; owner review is required.',
    ],
    [
      'APPROVED_ACTION_AUTHORITATIVE_STATE_MISMATCH',
      409,
      'AUTHORITATIVE_STATE_MISMATCH',
      'The reserved action no longer matches authoritative state.',
    ],
    [
      'APPROVED_ACTION_ATTEMPT_LIMIT',
      409,
      'ATTEMPT_LIMIT',
      'The approved action reached its retry limit.',
    ],
    [
      'APPROVED_ACTION_INVALID_IDEMPOTENCY_KEY',
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'The idempotency key is invalid.',
    ],
    [
      'APPROVED_LEAD_OWNER_REQUIRED',
      403,
      'OWNER_REQUIRED',
      'Only an active owner may execute an approved lead action.',
    ],
    [
      'APPROVED_LEAD_NOT_FOUND',
      404,
      'APPROVAL_NOT_FOUND',
      'The approved lead action was not found.',
    ],
    [
      'APPROVED_LEAD_NOT_EXECUTABLE',
      409,
      'APPROVAL_NOT_APPROVED',
      'The approved lead action is no longer executable.',
    ],
    [
      'APPROVED_LEAD_PAYLOAD_MISMATCH',
      409,
      'APPROVAL_MISMATCH',
      'The approved lead payload no longer matches the owner decision.',
    ],
    [
      'APPROVED_LEAD_SERVICE_NOT_ACTIVE',
      422,
      'SERVICE_CODE_NOT_APPROVED',
      'A requested service is no longer active in the company catalog.',
    ],
    [
      'APPROVED_LEAD_TRANSITION_CONFLICT',
      409,
      'AUTHORITATIVE_STATE_MISMATCH',
      'The lead changed after approval and the transition was not applied.',
    ],
  ];
  const mapping = mappings.find(([needle]) => message.includes(needle));
  return mapping
    ? new HttpError(mapping[3], mapping[1], mapping[2])
    : new HttpError('Approved-action claim failed.', 500, 'CLAIM_FAILED');
}

function parseClaim(data: unknown): ClaimRow {
  const row = Array.isArray(data) ? data[0] : undefined;
  if (
    !row ||
    typeof row !== 'object' ||
    !['reserved', 'completed', 'in_progress', 'failed'].includes(
      String((row as Record<string, unknown>).claim_status),
    )
  ) {
    throw new HttpError(
      'Approved-action claim returned an invalid contract.',
      500,
      'INVALID_CLAIM_RESPONSE',
    );
  }
  return row as ClaimRow;
}

function riskRank(value: string): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[value] ?? -1;
}

function replayResponse(value: unknown, replayed: boolean): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(
      'Stored approved-action response is invalid.',
      500,
      'INVALID_STORED_RESPONSE',
    );
  }
  return { ...(value as Record<string, unknown>), replayed };
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

  let companyId: string | undefined;
  let approvalId: string | undefined;
  let executionToken: string | undefined;
  let providerMayHaveCompleted = false;

  try {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
    }
    const {
      data: { user },
      error: authError,
    } = await serviceClient.auth.getUser(authorization.slice('Bearer '.length));
    if (authError || !user) {
      throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
    }
    const rawBody = await readTextBody(request, 16_384);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsedRequest = approvedActionRequestSchema.safeParse(body);
    if (!parsedRequest.success) {
      throw new HttpError(
        'Request must contain only companyId, approvalId, and idempotencyKey.',
        400,
        'INVALID_REQUEST',
      );
    }
    companyId = parsedRequest.data.companyId;
    approvalId = parsedRequest.data.approvalId;

    const { data: membership, error: membershipError } = await serviceClient.rpc(
      'load_storyops_edge_actor',
      {
        p_company_id: companyId,
        p_actor_user_id: user.id,
      },
    );
    if (membershipError) {
      throw new HttpError(
        'Company membership could not be verified.',
        503,
        'MEMBERSHIP_UNAVAILABLE',
      );
    }
    if (!membership || membership.role !== 'owner') {
      throw new HttpError(
        'Only an active owner may execute an approved action.',
        403,
        'OWNER_REQUIRED',
      );
    }

    const { data: approvalData, error: approvalError } = await serviceClient.rpc(
      'load_storyops_ai_approval',
      {
        p_company_id: companyId,
        p_actor_user_id: user.id,
        p_approval_id: approvalId,
      },
    );
    if (approvalError) {
      throw new HttpError('Approval state could not be loaded.', 503, 'APPROVAL_UNAVAILABLE');
    }
    if (!approvalData) {
      throw new HttpError('The approval request was not found.', 404, 'APPROVAL_NOT_FOUND');
    }

    let approval: PersistedApprovedAction;
    try {
      approval = await parseAndRevalidatePersistedApproval(approvalData, {
        companyId,
        approvalId,
      });
    } catch (error) {
      if (error instanceof ApprovedActionContractError) throw contractHttpError(error);
      throw error;
    }

    let agent: OfficeAgentName;
    try {
      agent = approvedToolAgent(approval.toolName);
    } catch (error) {
      if (error instanceof ApprovedActionContractError) throw contractHttpError(error);
      throw error;
    }

    // Build a no-network registry for metadata verification before claiming.
    // The actual provider suite is constructed only after the atomic claim.
    const metadataRegistry = createSandboxOfficeToolRegistry(createSandboxIntegrationSuite());
    registerServerRecordTools(metadataRegistry, {
      readClient: serviceClient,
      commandClient: serviceClient,
    });
    const metadata = metadataRegistry.metadata(approval.toolName);
    const approvedLeadToolName =
      approval.toolName === 'records.create_lead' || approval.toolName === 'records.update_lead'
        ? approval.toolName
        : undefined;
    if (
      !metadata ||
      !metadata.supportsIdempotency ||
      riskRank(approval.risk) < riskRank(metadata.risk) ||
      !agentCanUseTool(agent, approval.toolName) ||
      (approvedLeadToolName
        ? metadata.sideEffect !== 'internal_write' || metadata.reversible || metadata.autoExecute
        : metadata.sideEffect !== 'external_write')
    ) {
      throw new HttpError(
        'The approved action is not a registered idempotent tool for this specialist.',
        422,
        'UNSUPPORTED_TOOL',
      );
    }

    if (approvedLeadToolName) {
      try {
        parseApprovedLeadPayload(approvedLeadToolName, approval.exactPayload);
      } catch (error) {
        if (error instanceof ApprovedActionContractError) throw contractHttpError(error);
        throw error;
      }
      const { data: internalResult, error: internalError } = await serviceClient.rpc(
        'execute_ai_approved_lead_action',
        {
          p_company_id: approval.companyId,
          p_approval_request_id: approval.approvalId,
          p_actor_user_id: user.id,
          p_payload_hash: approval.payloadHash,
        },
      );
      if (internalError) throw claimHttpError(internalError.message);
      return jsonResponse(internalResult);
    }

    let refundPayload: ApprovedRefundPayload;
    try {
      refundPayload = parseApprovedRefundPayload(approval.exactPayload);
    } catch (error) {
      if (error instanceof ApprovedActionContractError) throw contractHttpError(error);
      throw error;
    }
    const environment = Deno.env.toObject();
    if (!isLiveProviderEnabled(environment, 'STRIPE_LIVE_ENABLED', 'STRIPE_MODE')) {
      throw new HttpError(
        'Approved refunds require a live Stripe adapter; sandbox mode never mutates authoritative payment records.',
        503,
        'LIVE_PROVIDER_REQUIRED',
      );
    }
    await assertProviderInvocation(serviceClient, {
      companyId: approval.companyId,
      provider: 'stripe',
      capability: 'payments',
      operationClass: 'recovery',
    });

    const { data: claimData, error: claimError } = await serviceClient.rpc(
      'claim_ai_approved_action',
      {
        p_company_id: companyId,
        p_approval_request_id: approvalId,
        p_actor_user_id: user.id,
        p_request_key: parsedRequest.data.idempotencyKey,
        p_payload_hash: approval.payloadHash,
      },
    );
    if (claimError) throw claimHttpError(claimError.message);
    const claim = parseClaim(claimData);
    if (claim.claim_status === 'completed') {
      return jsonResponse(replayResponse(claim.stored_response, true), 200, {
        'x-idempotent-replay': 'true',
      });
    }
    if (claim.claim_status === 'failed') {
      return jsonResponse(replayResponse(claim.stored_response, true), 422, {
        'x-idempotent-replay': 'true',
      });
    }
    if (claim.claim_status === 'in_progress') {
      return jsonResponse(
        {
          error: 'The identical approved action is still in progress.',
          code: 'IDEMPOTENCY_IN_PROGRESS',
        },
        409,
        { 'retry-after': '5' },
      );
    }
    if (!claim.execution_token || !claim.provider_idempotency_key) {
      throw new HttpError(
        'Approved-action reservation omitted its execution lease.',
        500,
        'INVALID_CLAIM_RESPONSE',
      );
    }
    executionToken = claim.execution_token;

    const providerRequest = {
      ...refundPayload,
      companyId: approval.companyId,
      approvalId: approval.approvalId,
      idempotencyKey: claim.provider_idempotency_key,
    };

    // This validation also runs inside the live Stripe adapter. Calling it
    // explicitly keeps sandbox execution grounded in the same database facts.
    await new SupabaseStripeBillingValidator(serviceClient).validateRefund(providerRequest);

    const providerSuite = createServerIntegrationSuite(environment);
    const output = await withRetry(
      () => providerSuite.payments.refund(providerRequest, request.signal),
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        jitterRatio: 0.2,
        shouldRetry: (error) =>
          (error instanceof ToolExecutionError && error.retryable) ||
          (error instanceof IntegrationError && error.retryable),
      },
    );
    providerMayHaveCompleted = true;

    let providerOutput: ApprovedRefundOutput;
    try {
      providerOutput = parseApprovedRefundOutput(output, {
        payload: refundPayload,
        providerIdempotencyKey: claim.provider_idempotency_key,
      });
    } catch (error) {
      if (error instanceof ApprovedActionContractError) throw contractHttpError(error);
      throw error;
    }

    const { data: completionData, error: completionError } = await serviceClient.rpc(
      'complete_ai_approved_action',
      {
        p_company_id: approval.companyId,
        p_approval_request_id: approval.approvalId,
        p_actor_user_id: user.id,
        p_execution_token: executionToken,
        p_provider: providerOutput.provider,
        p_provider_reference: providerOutput.providerId,
        p_provider_mode: providerOutput.mode,
        p_provider_status: providerOutput.status,
        p_amount: providerOutput.total.amount,
        p_currency: providerOutput.total.currency,
      },
    );
    if (completionError) {
      throw new HttpError(
        'Provider accepted the action, but durable completion is pending reconciliation.',
        503,
        'COMPLETION_PENDING',
      );
    }
    return jsonResponse(replayResponse(completionData, false));
  } catch (error) {
    if (companyId && approvalId && executionToken) {
      const retryable =
        providerMayHaveCompleted ||
        (error instanceof ToolExecutionError && error.retryable) ||
        (error instanceof IntegrationError &&
          (error.retryable || error.provider === 'configuration')) ||
        (error instanceof HttpError && error.code === 'COMPLETION_PENDING');
      await serviceClient.rpc('fail_ai_approved_action', {
        p_company_id: companyId,
        p_approval_request_id: approvalId,
        p_execution_token: executionToken,
        p_error_code: safeExecutionErrorCode(error),
        p_retryable: retryable,
      });
      if (retryable && !(error instanceof HttpError && error.code === 'COMPLETION_PENDING')) {
        return errorResponse(
          new HttpError(
            'The provider result is ambiguous; retry with the same idempotency key.',
            503,
            'PROVIDER_RESULT_AMBIGUOUS',
          ),
        );
      }
      if (!(error instanceof HttpError)) {
        return errorResponse(
          new HttpError(
            retryable
              ? 'The provider result is ambiguous; retry with the same idempotency key.'
              : 'The provider rejected the approved action.',
            retryable ? 503 : 422,
            retryable ? 'PROVIDER_RESULT_AMBIGUOUS' : safeExecutionErrorCode(error),
          ),
        );
      }
    }
    return errorResponse(error);
  }
});
