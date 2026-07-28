import type {
  OfficeAgentOutput,
  StructuredGenerationRequest,
  StructuredModel,
} from './contracts.ts';

export type SandboxModelResponder = (
  request: StructuredGenerationRequest,
) => OfficeAgentOutput | Promise<OfficeAgentOutput>;

export class SandboxStructuredModel implements StructuredModel {
  readonly provider = 'sandbox-openai';

  constructor(private readonly responder?: SandboxModelResponder) {}

  async generate(request: StructuredGenerationRequest): Promise<unknown> {
    if (this.responder) {
      return this.responder(request);
    }

    return {
      summary: `Sandbox ${request.agent} run completed without external AI or side effects.`,
      confidence: 0.5,
      evidence: [],
      unknowns: [
        'Live AI is disabled. Review source-of-truth records or enable the server-side OpenAI integration.',
      ],
      proposedActions: [],
      ownerAttention: false,
    } satisfies OfficeAgentOutput;
  }
}
