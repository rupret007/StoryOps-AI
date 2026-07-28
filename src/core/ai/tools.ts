import type { z } from 'zod';
import type { ActionRisk, OfficeActor, OfficeAgentName, OfficeToolName } from './contracts.ts';
import { AiOfficeError } from './contracts.ts';

export type OfficeToolContext = {
  companyId: string;
  runId: string;
  actionId: string;
  agent: OfficeAgentName;
  actor: OfficeActor;
  idempotencyKey: string;
  approvalId?: string;
  signal?: AbortSignal;
};

export type ToolExecutionErrorOptions = {
  retryable?: boolean;
  providerCode?: string;
  cause?: unknown;
};

export class ToolExecutionError extends Error {
  readonly retryable: boolean;
  readonly providerCode?: string;

  constructor(message: string, options: ToolExecutionErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'ToolExecutionError';
    this.retryable = options.retryable ?? false;
    this.providerCode = options.providerCode;
  }
}

export type OfficeToolDefinition<TInput, TOutput> = {
  name: OfficeToolName;
  description: string;
  input: z.ZodType<TInput>;
  output?: z.ZodType<TOutput>;
  risk: ActionRisk;
  sideEffect: 'none' | 'internal_write' | 'external_write' | 'destructive';
  reversible: boolean;
  supportsIdempotency: boolean;
  autoExecute: boolean;
  execute(input: TInput, context: OfficeToolContext): Promise<TOutput>;
};

type ErasedTool = OfficeToolDefinition<unknown, unknown>;
type OfficeToolMetadata = Omit<ErasedTool, 'execute' | 'input' | 'output'>;

function metadataFor(definition: ErasedTool): OfficeToolMetadata {
  return {
    name: definition.name,
    description: definition.description,
    risk: definition.risk,
    sideEffect: definition.sideEffect,
    reversible: definition.reversible,
    supportsIdempotency: definition.supportsIdempotency,
    autoExecute: definition.autoExecute,
  };
}

export class OfficeToolRegistry {
  private readonly definitions = new Map<OfficeToolName, ErasedTool>();

  register<TInput, TOutput>(definition: OfficeToolDefinition<TInput, TOutput>): this {
    if (this.definitions.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered.`);
    }
    this.definitions.set(definition.name, definition);
    return this;
  }

  get(name: OfficeToolName): ErasedTool | undefined {
    return this.definitions.get(name);
  }

  metadata(name: OfficeToolName): OfficeToolMetadata | undefined {
    const definition = this.definitions.get(name);
    if (!definition) return undefined;
    return metadataFor(definition);
  }

  list(): OfficeToolMetadata[] {
    return [...this.definitions.values()].map(metadataFor);
  }

  async execute(
    name: OfficeToolName,
    payload: unknown,
    context: OfficeToolContext,
  ): Promise<unknown> {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new AiOfficeError(`Tool "${name}" is not registered.`, 'TOOL_NOT_FOUND');
    }
    const parsedInput = definition.input.safeParse(payload);
    if (!parsedInput.success) {
      throw new AiOfficeError(
        `Tool "${name}" rejected its payload: ${parsedInput.error.message}`,
        'INVALID_INPUT',
      );
    }

    const result = await definition.execute(parsedInput.data, context);
    if (!definition.output) return result;
    const parsedOutput = definition.output.safeParse(result);
    if (!parsedOutput.success) {
      throw new AiOfficeError(
        `Tool "${name}" returned an invalid result.`,
        'TOOL_EXECUTION_FAILED',
      );
    }
    return parsedOutput.data;
  }
}
