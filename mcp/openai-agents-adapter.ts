import { Agent, OpenAIProvider, Runner } from '@openai/agents';
import process from 'node:process';
import type { StructuredGenerationRequest, StructuredModel } from '../src/core/ai/contracts.ts';
import { officeAgentOutputSchema } from '../src/core/ai/contracts.ts';
import type {
  HealthCheckedIntegration,
  IntegrationHealth,
} from '../src/core/integrations/contracts.ts';
import { isLiveProviderEnabled } from '../src/core/integrations/configuration.ts';

export type OpenAiAgentsServerConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  organization?: string;
  project?: string;
  maxOutputTokens?: number;
};

/**
 * Server-only OpenAI Agents SDK boundary.
 *
 * The browser bundle imports only StructuredModel. Tools are executed later by
 * OfficeOrchestrator after application policy, not by the model runner.
 */
export class OpenAiAgentsServerModel implements StructuredModel, HealthCheckedIntegration {
  readonly provider = 'openai';
  readonly capability = 'structured_ai';
  readonly mode = 'live' as const;
  private readonly runner: Runner;

  constructor(private readonly config: OpenAiAgentsServerConfig) {
    if (!config.apiKey || !config.model) {
      throw new Error('OpenAI live mode requires both an API key and explicit model.');
    }
    this.runner = new Runner({
      modelProvider: new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        organization: config.organization,
        project: config.project,
      }),
      tracingDisabled: false,
      traceIncludeSensitiveData: false,
      workflowName: 'StoryOps AI Office',
    });
  }

  async generate(request: StructuredGenerationRequest): Promise<unknown> {
    const agent = new Agent({
      name: `StoryOps ${request.agent}`,
      instructions: request.systemInstructions,
      model: this.config.model,
      modelSettings: {
        maxTokens: this.config.maxOutputTokens ?? 2_000,
        store: false,
      },
      outputType: officeAgentOutputSchema,
      tools: [],
      handoffs: [],
    });
    const result = await this.runner.run(agent, request.input, {
      maxTurns: 1,
    });
    if (!result.finalOutput) {
      throw new Error('OpenAI Agents SDK returned no structured final output.');
    }
    return result.finalOutput;
  }

  async health(signal?: AbortSignal): Promise<IntegrationHealth> {
    const started = performance.now();
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1';
    try {
      const response = await fetch(
        `${baseUrl.replace(/\/$/u, '')}/models/${encodeURIComponent(this.config.model)}`,
        {
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            ...(this.config.organization
              ? { 'openai-organization': this.config.organization }
              : {}),
            ...(this.config.project ? { 'openai-project': this.config.project } : {}),
          },
          signal,
        },
      );
      if (!response.ok) {
        throw new Error(`OpenAI model probe returned HTTP ${response.status}.`);
      }
      return {
        provider: this.provider,
        capability: this.capability,
        mode: this.mode,
        status: 'healthy',
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        message: `Configured model "${this.config.model}" is reachable.`,
        requiredEnvironment: [
          'OPENAI_MODE',
          'OPENAI_LIVE_ENABLED',
          'OPENAI_API_KEY',
          'OPENAI_MODEL',
        ],
      };
    } catch (error) {
      return {
        provider: this.provider,
        capability: this.capability,
        mode: this.mode,
        status: 'down',
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        message: error instanceof Error ? error.message : 'OpenAI health check failed.',
        requiredEnvironment: [
          'OPENAI_MODE',
          'OPENAI_LIVE_ENABLED',
          'OPENAI_API_KEY',
          'OPENAI_MODEL',
        ],
      };
    }
  }
}

export function openAiAgentsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): OpenAiAgentsServerModel | undefined {
  if (!isLiveProviderEnabled(environment, 'OPENAI_LIVE_ENABLED', 'OPENAI_MODE')) return undefined;
  const apiKey = environment.OPENAI_API_KEY;
  const model = environment.OPENAI_MODEL;
  if (!apiKey || !model) {
    throw new Error(
      'OPENAI_MODE=live and OPENAI_LIVE_ENABLED=true require OPENAI_API_KEY and OPENAI_MODEL.',
    );
  }
  return new OpenAiAgentsServerModel({
    apiKey,
    model,
    baseUrl: environment.OPENAI_BASE_URL,
    organization: environment.OPENAI_ORGANIZATION,
    project: environment.OPENAI_PROJECT_ID,
  });
}
