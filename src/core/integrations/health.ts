import type {
  HealthCheckedIntegration,
  IntegrationHealth,
  IntegrationStatus,
  IntegrationSuite,
} from './contracts.ts';

export type IntegrationHealthSummary = {
  overall: IntegrationStatus;
  checkedAt: string;
  providers: IntegrationHealth[];
};

function statusRank(status: IntegrationStatus): number {
  return {
    healthy: 0,
    not_configured: 1,
    degraded: 2,
    down: 3,
  }[status];
}

export function listSuiteIntegrations(suite: IntegrationSuite): HealthCheckedIntegration[] {
  return [
    suite.openai,
    suite.sms,
    suite.voice,
    suite.email,
    suite.payments,
    suite.calendar,
    suite.maps,
    suite.weather,
    suite.routing,
    suite.storage,
    suite.accounting,
  ];
}

export class IntegrationHealthService {
  constructor(
    private readonly integrations: readonly HealthCheckedIntegration[],
    private readonly timeoutMs = 5_000,
  ) {}

  async checkAll(): Promise<IntegrationHealthSummary> {
    const checkedAt = new Date().toISOString();
    const providers = await Promise.all(
      this.integrations.map(async (integration) => {
        const controller = new AbortController();
        const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);
        const started = performance.now();
        try {
          return await integration.health(controller.signal);
        } catch (error) {
          return {
            provider: integration.provider,
            capability: integration.capability,
            mode: integration.mode,
            status: 'down' as const,
            checkedAt: new Date().toISOString(),
            latencyMs: Math.round(performance.now() - started),
            message: error instanceof Error ? error.message : 'Health check failed unexpectedly.',
            requiredEnvironment: [],
          };
        } finally {
          globalThis.clearTimeout(timeout);
        }
      }),
    );
    const worst = providers.reduce<IntegrationStatus>(
      (current, provider) =>
        statusRank(provider.status) > statusRank(current) ? provider.status : current,
      'healthy',
    );
    return { overall: worst, checkedAt, providers };
  }
}

export class StaticIntegrationHealth implements HealthCheckedIntegration {
  constructor(
    readonly provider: string,
    readonly capability: string,
    readonly mode: 'sandbox' | 'live' | 'disabled',
    private readonly status: IntegrationStatus,
    private readonly message: string,
    private readonly requiredEnvironment: string[] = [],
  ) {}

  async health(): Promise<IntegrationHealth> {
    return {
      provider: this.provider,
      capability: this.capability,
      mode: this.mode,
      status: this.status,
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      message: this.message,
      requiredEnvironment: this.requiredEnvironment,
    };
  }
}
