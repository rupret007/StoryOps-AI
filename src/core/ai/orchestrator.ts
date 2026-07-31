import {
  assertApprovalPayloadMatch,
  assertExactApproval,
  createApprovalRequest,
  sha256Hex,
  type AiApprovalRequest,
  type ApprovalStore,
} from './approval.ts';
import { agentCanUseTool, getAgentDefinition } from './agents.ts';
import {
  AiOfficeError,
  officeAgentOutputSchema,
  officeRunRequestSchema,
  type ActionDisposition,
  type ActionProposal,
  type OfficeAgentOutput,
  type OfficeRunRequest,
  type OfficeRunResult,
  type StructuredModel,
} from './contracts.ts';
import { groundOfficeAgentOutput } from './grounding.ts';
import { executeIdempotently, type IdempotencyStore } from './idempotency.ts';
import { DefaultOfficePolicyEvaluator, type OfficePolicyEvaluator } from './policy.ts';
import { withRetry } from './retry.ts';
import {
  SCHEDULING_PREREQUISITE_POLICY_RULE,
  evaluateSchedulingPrerequisites,
} from './schedulingPrerequisites.ts';
import { buildGuardedModelInput, validateEvidenceSources } from './security.ts';
import { NoopAiTraceSink, type AiTraceEvent, type AiTraceSink } from './tracing.ts';
import { ToolExecutionError, type OfficeToolRegistry } from './tools.ts';

export type OfficeOrchestratorDependencies = {
  model: StructuredModel;
  tools: OfficeToolRegistry;
  approvals: ApprovalStore;
  idempotency: IdempotencyStore;
  policy?: OfficePolicyEvaluator;
  traces?: AiTraceSink;
  now?: () => Date;
};

export type ApprovedActionResult = {
  approvalId: string;
  actionId: string;
  toolName: string;
  output: unknown;
  replayed: boolean;
  completedAt: string;
};

export class OfficeOrchestrator {
  private readonly policy: OfficePolicyEvaluator;
  private readonly traces: AiTraceSink;
  private readonly now: () => Date;

  constructor(private readonly dependencies: OfficeOrchestratorDependencies) {
    this.policy = dependencies.policy ?? new DefaultOfficePolicyEvaluator();
    this.traces = dependencies.traces ?? new NoopAiTraceSink();
    this.now = dependencies.now ?? (() => new Date());
  }

  async run(unvalidatedRequest: OfficeRunRequest): Promise<OfficeRunResult> {
    const parsedRequest = officeRunRequestSchema.safeParse(unvalidatedRequest);
    if (!parsedRequest.success) {
      throw new AiOfficeError(
        `AI office request is invalid: ${parsedRequest.error.message}`,
        'INVALID_INPUT',
      );
    }
    const request = parsedRequest.data;
    const requestHash = await sha256Hex(request);
    const execution = await executeIdempotently({
      store: this.dependencies.idempotency,
      scope: `ai-run:${request.companyId}`,
      key: request.idempotencyKey,
      requestHash,
      ttlMs: 7 * 24 * 60 * 60 * 1_000,
      execute: () => this.executeRun(request),
    });

    if (execution.replayed) {
      await this.trace({
        type: 'run.replayed',
        traceId: execution.value.traceId,
        runId: execution.value.runId,
        agent: execution.value.agent,
        at: this.now().toISOString(),
      });
    }

    return { ...execution.value, replayed: execution.replayed };
  }

  private async executeRun(request: OfficeRunRequest): Promise<OfficeRunResult> {
    const traceId = globalThis.crypto.randomUUID();
    const definition = getAgentDefinition(request.agent);
    await this.trace({
      type: 'run.started',
      traceId,
      runId: request.runId,
      agent: request.agent,
      at: this.now().toISOString(),
      attributes: { actorRole: request.actor.role },
    });

    const guarded = buildGuardedModelInput(request, {
      provider: this.dependencies.model.provider,
    });
    if (guarded.injectionSignals.length > 0) {
      await this.trace({
        type: 'guardrail.flagged',
        traceId,
        runId: request.runId,
        agent: request.agent,
        at: this.now().toISOString(),
        attributes: { signals: guarded.injectionSignals },
      });
    }

    await this.trace({
      type: 'model.started',
      traceId,
      runId: request.runId,
      agent: request.agent,
      at: this.now().toISOString(),
      attributes: {
        provider: this.dependencies.model.provider,
        dataPolicyId: guarded.dataPolicyId,
        redactionCount: guarded.redactionSignals.length,
      },
    });

    let rawOutput: unknown;
    try {
      const toolPolicyMetadata = this.dependencies.tools
        .list()
        .filter((tool) => definition.allowedTools.has(tool.name))
        .map(
          ({
            name,
            description,
            risk,
            sideEffect,
            reversible,
            supportsIdempotency,
            autoExecute,
          }) => ({
            name,
            description,
            risk,
            sideEffect,
            reversible,
            supportsIdempotency,
            autoExecute,
          }),
        );
      rawOutput = await this.dependencies.model.generate({
        runId: request.runId,
        agent: request.agent,
        systemInstructions: [
          definition.instructions,
          'Authoritative tool policy metadata (use these values in proposed actions):',
          JSON.stringify(toolPolicyMetadata),
        ].join('\n\n'),
        input: guarded.input,
      });
    } catch (error) {
      await this.trace({
        type: 'model.rejected',
        traceId,
        runId: request.runId,
        agent: request.agent,
        at: this.now().toISOString(),
        attributes: {
          error: error instanceof Error ? error.message : 'Unknown model error',
        },
      });
      throw error;
    }

    const parsedOutput = officeAgentOutputSchema.safeParse(rawOutput);
    if (!parsedOutput.success) {
      await this.trace({
        type: 'model.rejected',
        traceId,
        runId: request.runId,
        agent: request.agent,
        at: this.now().toISOString(),
        attributes: { validation: parsedOutput.error.message },
      });
      throw new AiOfficeError(
        `AI model output failed schema validation: ${parsedOutput.error.message}`,
        'INVALID_MODEL_OUTPUT',
      );
    }
    const modelOutput = parsedOutput.data;
    this.validateModelClaims(modelOutput, request);
    const output = groundOfficeAgentOutput(modelOutput, request);

    await this.trace({
      type: 'model.completed',
      traceId,
      runId: request.runId,
      agent: request.agent,
      at: this.now().toISOString(),
      attributes: {
        proposedActionCount: output.proposedActions.length,
        confidence: output.confidence,
        narrativePolicy: output.narrativePolicy.schemaVersion,
        automaticSendAllowed: output.narrativePolicy.automaticSendAllowed,
      },
    });

    const actions: ActionDisposition[] = [];
    for (const proposal of output.proposedActions) {
      actions.push(
        await this.evaluateAndExecute(
          request,
          proposal,
          traceId,
          guarded.injectionSignals.length > 0,
        ),
      );
    }

    const result: OfficeRunResult = {
      traceId,
      runId: request.runId,
      agent: request.agent,
      modelProvider: this.dependencies.model.provider,
      output,
      actions,
      injectionSignals: guarded.injectionSignals,
      completedAt: this.now().toISOString(),
      replayed: false,
    };
    await this.trace({
      type: 'run.completed',
      traceId,
      runId: request.runId,
      agent: request.agent,
      at: result.completedAt,
      attributes: {
        executed: actions.filter((action) => action.status === 'executed').length,
        approvals: actions.filter((action) => action.status === 'approval_required').length,
        denied: actions.filter((action) => action.status === 'denied').length,
        failed: actions.filter((action) => action.status === 'failed').length,
      },
    });
    return result;
  }

  private validateModelClaims(output: OfficeAgentOutput, request: OfficeRunRequest): void {
    const actionIds = new Set<string>();
    for (const evidence of output.evidence) {
      if (!validateEvidenceSources(evidence.sourceFactIds, request)) {
        throw new AiOfficeError(
          'AI evidence cited a fact that was not supplied by a trusted source.',
          'INVALID_MODEL_OUTPUT',
        );
      }
    }
    for (const proposal of output.proposedActions) {
      if (actionIds.has(proposal.actionId)) {
        throw new AiOfficeError(
          `AI returned duplicate action ID "${proposal.actionId}".`,
          'INVALID_MODEL_OUTPUT',
        );
      }
      actionIds.add(proposal.actionId);
      if (!validateEvidenceSources(proposal.sourceFactIds, request)) {
        throw new AiOfficeError(
          `Action "${proposal.actionId}" cited an unknown trusted fact.`,
          'INVALID_MODEL_OUTPUT',
        );
      }
    }
  }

  private async evaluateAndExecute(
    request: OfficeRunRequest,
    proposal: ActionProposal,
    traceId: string,
    injectionDetected: boolean,
  ): Promise<ActionDisposition> {
    if (!agentCanUseTool(request.agent, proposal.toolName)) {
      return {
        actionId: proposal.actionId,
        status: 'denied',
        reason: `${request.agent} does not have the ${proposal.toolName} capability.`,
        policyRule: 'AI-001-least-privilege',
      };
    }

    const schedulingPrerequisites = evaluateSchedulingPrerequisites({
      request,
      proposal,
      now: this.now(),
    });
    if (schedulingPrerequisites.required && !schedulingPrerequisites.eligible) {
      await this.trace({
        type: 'policy.evaluated',
        traceId,
        runId: request.runId,
        agent: request.agent,
        actionId: proposal.actionId,
        toolName: proposal.toolName,
        risk: proposal.risk,
        at: this.now().toISOString(),
        attributes: {
          outcome: 'deny',
          rule: SCHEDULING_PREREQUISITE_POLICY_RULE,
          reason: schedulingPrerequisites.reason,
        },
      });
      return {
        actionId: proposal.actionId,
        status: 'denied',
        reason: schedulingPrerequisites.reason,
        policyRule: SCHEDULING_PREREQUISITE_POLICY_RULE,
      };
    }

    const decision = await this.policy.evaluate({
      agent: request.agent,
      proposal,
      registry: this.dependencies.tools,
      injectionDetected,
      sourceFactsVerified: validateEvidenceSources(proposal.sourceFactIds, request),
    });
    await this.trace({
      type: 'policy.evaluated',
      traceId,
      runId: request.runId,
      agent: request.agent,
      actionId: proposal.actionId,
      toolName: proposal.toolName,
      risk: proposal.risk,
      at: this.now().toISOString(),
      attributes: { outcome: decision.outcome, rule: decision.rule },
    });

    if (decision.outcome === 'deny') {
      return {
        actionId: proposal.actionId,
        status: 'denied',
        reason: decision.reason,
        policyRule: decision.rule,
      };
    }

    if (decision.outcome === 'require_approval') {
      const approval = await createApprovalRequest({
        companyId: request.companyId,
        runId: request.runId,
        proposal,
        reason: decision.reason,
        policyRule: decision.rule,
        requestedBy: request.actor,
        now: this.now(),
      });
      await this.dependencies.approvals.save(approval);
      await this.trace({
        type: 'approval.created',
        traceId,
        runId: request.runId,
        agent: request.agent,
        actionId: proposal.actionId,
        toolName: proposal.toolName,
        risk: proposal.risk,
        at: this.now().toISOString(),
        attributes: {
          approvalId: approval.approvalId,
          payloadHash: approval.payloadHash,
        },
      });
      return {
        actionId: proposal.actionId,
        status: 'approval_required',
        approvalId: approval.approvalId,
        payloadHash: approval.payloadHash,
        policyRule: decision.rule,
      };
    }

    return this.executeProposal(request, proposal, decision.rule, traceId);
  }

  private async executeProposal(
    request: OfficeRunRequest,
    proposal: ActionProposal,
    policyRule: string,
    traceId: string,
    approvalId?: string,
  ): Promise<ActionDisposition> {
    const tool = this.dependencies.tools.metadata(proposal.toolName);
    if (!tool) {
      return {
        actionId: proposal.actionId,
        status: 'denied',
        reason: `Tool "${proposal.toolName}" is not registered.`,
        policyRule: 'AI-010-unregistered-tool',
      };
    }

    await this.trace({
      type: 'tool.started',
      traceId,
      runId: request.runId,
      agent: request.agent,
      actionId: proposal.actionId,
      toolName: proposal.toolName,
      risk: proposal.risk,
      at: this.now().toISOString(),
    });

    try {
      const output = await withRetry(
        () =>
          this.dependencies.tools.execute(proposal.toolName, proposal.payload, {
            companyId: request.companyId,
            runId: request.runId,
            actionId: proposal.actionId,
            agent: request.agent,
            actor: request.actor,
            idempotencyKey: `${request.idempotencyKey}:${proposal.actionId}`,
            approvalId,
          }),
        {
          maxAttempts: tool.sideEffect === 'none' || tool.supportsIdempotency ? 3 : 1,
          baseDelayMs: 100,
          maxDelayMs: 1_000,
          jitterRatio: 0.2,
          shouldRetry: (error) => error instanceof ToolExecutionError && error.retryable,
        },
      );
      await this.trace({
        type: 'tool.completed',
        traceId,
        runId: request.runId,
        agent: request.agent,
        actionId: proposal.actionId,
        toolName: proposal.toolName,
        risk: proposal.risk,
        at: this.now().toISOString(),
      });
      return {
        actionId: proposal.actionId,
        status: 'executed',
        output,
        policyRule,
      };
    } catch (error) {
      const retryable = error instanceof ToolExecutionError && error.retryable;
      const reason = error instanceof Error ? error.message : 'Unknown tool failure';
      await this.trace({
        type: 'tool.failed',
        traceId,
        runId: request.runId,
        agent: request.agent,
        actionId: proposal.actionId,
        toolName: proposal.toolName,
        risk: proposal.risk,
        at: this.now().toISOString(),
        attributes: { reason, retryable },
      });
      return {
        actionId: proposal.actionId,
        status: 'failed',
        reason,
        retryable,
        policyRule,
      };
    }
  }

  async executeApprovedAction(options: {
    approvalId: string;
    request: OfficeRunRequest;
    proposal: ActionProposal;
  }): Promise<ApprovedActionResult> {
    const parsedRequest = officeRunRequestSchema.parse(options.request);
    const approval = await this.dependencies.approvals.get(options.approvalId);
    if (!approval) {
      throw new AiOfficeError('Approval request was not found.', 'APPROVAL_MISMATCH');
    }
    if (!agentCanUseTool(parsedRequest.agent, options.proposal.toolName)) {
      throw new AiOfficeError('The specialist does not have this capability.', 'CAPABILITY_DENIED');
    }
    const guarded = buildGuardedModelInput(parsedRequest);
    const currentPolicy = await this.policy.evaluate({
      agent: parsedRequest.agent,
      proposal: options.proposal,
      registry: this.dependencies.tools,
      injectionDetected: guarded.injectionSignals.length > 0,
      sourceFactsVerified: validateEvidenceSources(options.proposal.sourceFactIds, parsedRequest),
    });
    if (currentPolicy.outcome === 'deny') {
      throw new AiOfficeError(currentPolicy.reason, 'POLICY_DENIED');
    }
    await assertApprovalPayloadMatch({
      approval,
      companyId: parsedRequest.companyId,
      runId: parsedRequest.runId,
      proposal: options.proposal,
      now: this.now(),
    });

    const requestHash = await sha256Hex({
      approvalId: approval.approvalId,
      payloadHash: approval.payloadHash,
    });
    const execution = await executeIdempotently({
      store: this.dependencies.idempotency,
      scope: `approved-action:${parsedRequest.companyId}`,
      key: approval.approvalId,
      requestHash,
      ttlMs: 30 * 24 * 60 * 60 * 1_000,
      execute: async () => {
        await assertExactApproval({
          approval,
          companyId: parsedRequest.companyId,
          runId: parsedRequest.runId,
          proposal: options.proposal,
          now: this.now(),
        });
        const schedulingPrerequisites = evaluateSchedulingPrerequisites({
          request: parsedRequest,
          proposal: options.proposal,
          now: this.now(),
        });
        if (schedulingPrerequisites.required && !schedulingPrerequisites.eligible) {
          throw new AiOfficeError(schedulingPrerequisites.reason, 'POLICY_DENIED');
        }
        const disposition = await this.executeProposal(
          parsedRequest,
          options.proposal,
          approval.policyRule,
          approval.approvalId,
          approval.approvalId,
        );
        if (disposition.status !== 'executed') {
          throw new AiOfficeError(
            disposition.status === 'failed'
              ? disposition.reason
              : 'Approved action did not execute.',
            'TOOL_EXECUTION_FAILED',
            disposition.status === 'failed' && disposition.retryable,
          );
        }
        const consumed: AiApprovalRequest = {
          ...approval,
          status: 'consumed',
        };
        await this.dependencies.approvals.save(consumed);
        return {
          approvalId: approval.approvalId,
          actionId: options.proposal.actionId,
          toolName: options.proposal.toolName,
          output: disposition.output,
          completedAt: this.now().toISOString(),
        };
      },
    });

    return { ...execution.value, replayed: execution.replayed };
  }

  private async trace(event: AiTraceEvent): Promise<void> {
    await this.traces.append(event);
  }
}
