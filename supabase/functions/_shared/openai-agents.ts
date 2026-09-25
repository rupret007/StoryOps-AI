import { Agent, OpenAIProvider, Runner } from '@openai/agents';
import type {
  StructuredGenerationRequest,
  StructuredModel,
} from '../../../src/core/ai/contracts.ts';
import {
  decodeOpenAiOfficeAgentOutput,
  openAiOfficeAgentOutputSchema,
} from '../../../src/core/ai/contracts.ts';

export class EdgeOpenAiAgentsModel implements StructuredModel {
  readonly provider = 'openai';
  private readonly runner: Runner;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly maxOutputTokens = 2_000,
  ) {
    this.runner = new Runner({
      modelProvider: new OpenAIProvider({ apiKey }),
      tracingDisabled: false,
      traceIncludeSensitiveData: false,
      workflowName: 'WashOps Office Edge',
    });
  }

  async generate(request: StructuredGenerationRequest): Promise<unknown> {
    const specialist = new Agent({
      name: `WashOps ${request.agent}`,
      instructions: request.systemInstructions,
      model: this.model,
      modelSettings: {
        maxTokens: this.maxOutputTokens,
        store: false,
      },
      outputType: openAiOfficeAgentOutputSchema,
      tools: [],
      handoffs: [],
    });
    const result = await this.runner.run(specialist, request.input, {
      maxTurns: 1,
    });
    if (!result.finalOutput) {
      throw new Error('OpenAI returned no structured output.');
    }
    return decodeOpenAiOfficeAgentOutput(result.finalOutput);
  }
}
