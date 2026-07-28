import type { ActionRisk, OfficeAgentName, OfficeToolName } from './contracts.ts';
import { redactSensitive } from './security.ts';

export type AiTraceEvent =
  | {
      type: 'run.started' | 'run.completed' | 'run.replayed';
      traceId: string;
      runId: string;
      agent: OfficeAgentName;
      at: string;
      attributes?: Record<string, unknown>;
    }
  | {
      type:
        | 'guardrail.flagged'
        | 'model.started'
        | 'model.completed'
        | 'model.rejected'
        | 'policy.evaluated'
        | 'approval.created'
        | 'tool.started'
        | 'tool.completed'
        | 'tool.failed';
      traceId: string;
      runId: string;
      agent: OfficeAgentName;
      at: string;
      toolName?: OfficeToolName;
      actionId?: string;
      risk?: ActionRisk;
      attributes?: Record<string, unknown>;
    };

export interface AiTraceSink {
  append(event: AiTraceEvent): Promise<void>;
}

export class InMemoryAiTraceSink implements AiTraceSink {
  readonly events: AiTraceEvent[] = [];

  async append(event: AiTraceEvent): Promise<void> {
    this.events.push({
      ...event,
      attributes: event.attributes
        ? (redactSensitive(event.attributes) as Record<string, unknown>)
        : undefined,
    });
  }
}

export class CompositeAiTraceSink implements AiTraceSink {
  constructor(private readonly sinks: readonly AiTraceSink[]) {}

  async append(event: AiTraceEvent): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.append(event)));
  }
}

export class NoopAiTraceSink implements AiTraceSink {
  append(): Promise<void> {
    return Promise.resolve();
  }
}
