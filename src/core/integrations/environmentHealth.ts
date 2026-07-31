import { assessIntegrationEnvironment, resolveLiveProviderActivation } from './configuration.ts';
import type {
  HealthCheckedIntegration,
  IntegrationHealth,
  IntegrationStatus,
  IntegrationSuite,
} from './contracts.ts';
import { IntegrationHealthService } from './health.ts';
import { createServerIntegrationSuite, type ServerEnvironment } from './liveServer.ts';
import { SupabaseAuthIdentityInvitationHealth } from './supabaseAuthHealth.ts';

type ActivationPair = Readonly<{
  enableFlag: string;
  modeSetting: string;
}>;

type ProbeTarget = ActivationPair &
  Readonly<{
    provider: string;
    capability: string;
    select?: (suite: IntegrationSuite) => HealthCheckedIntegration;
    build?: (environment: ServerEnvironment) => HealthCheckedIntegration;
    probeEnableFlag?: string;
    probeModeSetting?: string;
    environmentOverrides?: (environment: ServerEnvironment) => ServerEnvironment;
  }>;

const activationPairs: readonly ActivationPair[] = [
  { enableFlag: 'OPENAI_LIVE_ENABLED', modeSetting: 'OPENAI_MODE' },
  { enableFlag: 'OPENAI_VISION_LIVE_ENABLED', modeSetting: 'OPENAI_MODE' },
  { enableFlag: 'TWILIO_LIVE_ENABLED', modeSetting: 'TWILIO_MODE' },
  { enableFlag: 'EMAIL_LIVE_ENABLED', modeSetting: 'EMAIL_MODE' },
  {
    enableFlag: 'STORYOPS_IDENTITY_INVITE_LIVE_ENABLED',
    modeSetting: 'STORYOPS_IDENTITY_INVITE_MODE',
  },
  { enableFlag: 'STRIPE_LIVE_ENABLED', modeSetting: 'STRIPE_MODE' },
  {
    enableFlag: 'GOOGLE_CALENDAR_LIVE_ENABLED',
    modeSetting: 'GOOGLE_CALENDAR_MODE',
  },
  { enableFlag: 'MAPS_LIVE_ENABLED', modeSetting: 'MAPS_MODE' },
  { enableFlag: 'NWS_LIVE_ENABLED', modeSetting: 'WEATHER_MODE' },
  { enableFlag: 'VROOM_LIVE_ENABLED', modeSetting: 'ROUTING_MODE' },
  {
    enableFlag: 'SIGNED_STORAGE_TARGETS_LIVE_ENABLED',
    modeSetting: 'SIGNED_STORAGE_TARGETS_MODE',
  },
  { enableFlag: 'QUICKBOOKS_EXPORT_ENABLED', modeSetting: 'QUICKBOOKS_MODE' },
];

const probeTargets: readonly ProbeTarget[] = [
  {
    provider: 'openai',
    capability: 'structured_ai',
    enableFlag: 'OPENAI_LIVE_ENABLED',
    modeSetting: 'OPENAI_MODE',
    select: (suite) => suite.openai,
  },
  {
    provider: 'openai',
    capability: 'photo_analysis',
    enableFlag: 'OPENAI_VISION_LIVE_ENABLED',
    modeSetting: 'OPENAI_MODE',
    probeEnableFlag: 'OPENAI_LIVE_ENABLED',
    select: (suite) => suite.openai,
    environmentOverrides: (environment) => ({
      ...environment,
      OPENAI_MODEL: environment.OPENAI_VISION_MODEL,
    }),
  },
  {
    provider: 'twilio',
    capability: 'sms_voice',
    enableFlag: 'TWILIO_LIVE_ENABLED',
    modeSetting: 'TWILIO_MODE',
    select: (suite) => suite.sms,
  },
  {
    provider: 'email',
    capability: 'email',
    enableFlag: 'EMAIL_LIVE_ENABLED',
    modeSetting: 'EMAIL_MODE',
    select: (suite) => suite.email,
  },
  {
    provider: 'supabase_auth',
    capability: 'identity_invitation',
    enableFlag: 'STORYOPS_IDENTITY_INVITE_LIVE_ENABLED',
    modeSetting: 'STORYOPS_IDENTITY_INVITE_MODE',
    build: (environment) => new SupabaseAuthIdentityInvitationHealth(environment),
  },
  {
    provider: 'stripe',
    capability: 'payments',
    enableFlag: 'STRIPE_LIVE_ENABLED',
    modeSetting: 'STRIPE_MODE',
    select: (suite) => suite.payments,
  },
  {
    provider: 'google_calendar',
    capability: 'calendar',
    enableFlag: 'GOOGLE_CALENDAR_LIVE_ENABLED',
    modeSetting: 'GOOGLE_CALENDAR_MODE',
    select: (suite) => suite.calendar,
  },
  {
    provider: 'maps',
    capability: 'geocoding',
    enableFlag: 'MAPS_LIVE_ENABLED',
    modeSetting: 'MAPS_MODE',
    select: (suite) => suite.maps,
  },
  {
    provider: 'nws',
    capability: 'weather',
    enableFlag: 'NWS_LIVE_ENABLED',
    modeSetting: 'WEATHER_MODE',
    select: (suite) => suite.weather,
  },
  {
    provider: 'vroom',
    capability: 'routing',
    enableFlag: 'VROOM_LIVE_ENABLED',
    modeSetting: 'ROUTING_MODE',
    select: (suite) => suite.routing,
  },
  {
    provider: 'signed_storage_targets',
    capability: 'server_signed_targets',
    enableFlag: 'SIGNED_STORAGE_TARGETS_LIVE_ENABLED',
    modeSetting: 'SIGNED_STORAGE_TARGETS_MODE',
    select: (suite) => suite.storage,
  },
  {
    provider: 'quickbooks_export',
    capability: 'accounting_export',
    enableFlag: 'QUICKBOOKS_EXPORT_ENABLED',
    modeSetting: 'QUICKBOOKS_MODE',
    select: (suite) => suite.accounting,
  },
];

const schedulingComponentProviders = ['google_calendar', 'maps', 'nws', 'vroom'] as const;

const schedulingRequiredEnvironment = [
  'SCHEDULING_EVIDENCE_LIVE_ENABLED',
  'SCHEDULING_EVIDENCE_MODE',
  'GOOGLE_CALENDAR_LIVE_ENABLED',
  'GOOGLE_CALENDAR_MODE',
  'MAPS_LIVE_ENABLED',
  'MAPS_MODE',
  'NWS_LIVE_ENABLED',
  'WEATHER_MODE',
  'VROOM_LIVE_ENABLED',
  'ROUTING_MODE',
];

export function integrationDeploymentRequiredSettings(environment: ServerEnvironment): string[] {
  return [
    ...new Set([
      ...assessIntegrationEnvironment(environment).flatMap(
        (provider) => provider.requiredEnvironment,
      ),
      ...schedulingRequiredEnvironment,
    ]),
  ].sort();
}

function statusRank(status: IntegrationStatus): number {
  return {
    healthy: 0,
    not_configured: 1,
    degraded: 2,
    down: 3,
  }[status];
}

function targetKey(provider: string, capability: string): string {
  return `${provider}:${capability}`;
}

const probeTargetByKey = new Map(
  probeTargets.map((target) => [targetKey(target.provider, target.capability), target]),
);

function isolatedEnvironment(
  environment: ServerEnvironment,
  target: ProbeTarget,
): ServerEnvironment {
  const isolated: Record<string, string | undefined> = { ...environment };
  for (const pair of activationPairs) {
    isolated[pair.enableFlag] = 'false';
    isolated[pair.modeSetting] = 'disabled';
  }
  isolated[target.probeEnableFlag ?? target.enableFlag] = 'true';
  isolated[target.probeModeSetting ?? target.modeSetting] = 'live';
  return target.environmentOverrides?.(isolated) ?? isolated;
}

function constructionFailure(configured: IntegrationHealth): IntegrationHealth {
  return {
    ...configured,
    mode: 'live',
    status: 'down',
    checkedAt: new Date().toISOString(),
    latencyMs: 0,
    message:
      'The live provider probe could not start because its configuration was rejected; review the named server settings.',
  };
}

async function probeConfiguredProvider(
  environment: ServerEnvironment,
  configured: IntegrationHealth,
  timeoutMs: number,
): Promise<IntegrationHealth> {
  if (configured.mode !== 'live' || configured.status !== 'degraded') return configured;
  const target = probeTargetByKey.get(targetKey(configured.provider, configured.capability));
  if (!target) return constructionFailure(configured);
  try {
    const isolated = isolatedEnvironment(environment, target);
    const integration = target.build
      ? target.build(isolated)
      : target.select?.(createServerIntegrationSuite(isolated));
    if (!integration) return constructionFailure(configured);
    const result = await new IntegrationHealthService([integration], timeoutMs).checkAll();
    const [provider] = result.providers;
    if (!provider) return constructionFailure(configured);
    return {
      ...provider,
      provider: configured.provider,
      capability: configured.capability,
      requiredEnvironment: configured.requiredEnvironment,
    };
  } catch {
    return constructionFailure(configured);
  }
}

export function buildSchedulingEvidenceGateHealth(
  environment: ServerEnvironment,
  providers: readonly IntegrationHealth[],
  now = new Date(),
): IntegrationHealth {
  const checkedAt = now.toISOString();
  const activation = resolveLiveProviderActivation(
    environment,
    'SCHEDULING_EVIDENCE_LIVE_ENABLED',
    'SCHEDULING_EVIDENCE_MODE',
  );
  const base = {
    provider: 'scheduling_evidence_gate',
    capability: 'calendar_weather_route_booking_evidence',
    checkedAt,
    latencyMs: 0,
    requiredEnvironment: [...schedulingRequiredEnvironment],
  };

  if (!activation.enableFlagValid || !activation.modeValid) {
    return {
      ...base,
      mode: 'disabled',
      status: 'not_configured',
      message:
        'Scheduling evidence activation settings are invalid; use a supported mode and a true or false live-enable flag.',
    };
  }
  if (activation.configuredMode === 'disabled') {
    return {
      ...base,
      mode: 'disabled',
      status: 'not_configured',
      message: 'Scheduling evidence is explicitly disabled; no booking evidence can be issued.',
    };
  }
  if (activation.enableFlagSet !== activation.modeIsLive) {
    return {
      ...base,
      mode: 'disabled',
      status: 'not_configured',
      message:
        'Scheduling evidence live activation is incomplete; both scheduling switches must agree.',
    };
  }
  if (!activation.enabled) {
    return {
      ...base,
      mode: 'sandbox',
      status: 'healthy',
      message:
        'Scheduling evidence is in sandbox mode; no provider-backed booking evidence or calendar reservation is issued.',
    };
  }

  const components = schedulingComponentProviders.map((provider) =>
    providers.find((candidate) => candidate.provider === provider),
  );
  const nonLiveComponents = components.filter(
    (component) => !component || component.mode !== 'live',
  );
  if (nonLiveComponents.length > 0) {
    const names = schedulingComponentProviders.filter(
      (_provider, index) => !components[index] || components[index]?.mode !== 'live',
    );
    return {
      ...base,
      mode: 'live',
      status: 'not_configured',
      message: `Scheduling evidence is blocked until every component is live: ${names.join(', ')}.`,
    };
  }

  const liveComponents = components.filter(
    (component): component is IntegrationHealth => component !== undefined,
  );
  const worstStatus = liveComponents.reduce<IntegrationStatus>(
    (current, component) =>
      statusRank(component.status) > statusRank(current) ? component.status : current,
    'healthy',
  );
  const latencyMs = liveComponents.reduce(
    (current, component) => Math.max(current, component.latencyMs),
    0,
  );
  const unhealthy = liveComponents
    .filter((component) => component.status !== 'healthy')
    .map((component) => `${component.provider}:${component.status}`);

  return {
    ...base,
    mode: 'live',
    status: worstStatus,
    latencyMs,
    message:
      unhealthy.length === 0
        ? 'Scheduling evidence live gate is ready: calendar, maps, NWS, and VROOM probes are healthy.'
        : `Scheduling evidence live gate is not ready: ${unhealthy.join(', ')}.`,
  };
}

export async function checkIntegrationEnvironmentHealth(
  environment: ServerEnvironment,
  timeoutMs = 5_000,
): Promise<{
  overall: IntegrationStatus;
  checkedAt: string;
  providers: IntegrationHealth[];
}> {
  const checkedAt = new Date().toISOString();
  const configured = assessIntegrationEnvironment(environment);
  const providerResults = await Promise.all(
    configured.map((provider) => probeConfiguredProvider(environment, provider, timeoutMs)),
  );
  const providers = [
    ...providerResults,
    buildSchedulingEvidenceGateHealth(environment, providerResults),
  ];
  const overall = providers.reduce<IntegrationStatus>(
    (current, provider) =>
      statusRank(provider.status) > statusRank(current) ? provider.status : current,
    'healthy',
  );
  return { overall, checkedAt, providers };
}

export async function checkIntegrationProviderEnvironmentHealth(
  environment: ServerEnvironment,
  provider: string,
  capability: string,
  timeoutMs = 5_000,
): Promise<IntegrationHealth> {
  const configured = assessIntegrationEnvironment(environment).find(
    (candidate) => candidate.provider === provider && candidate.capability === capability,
  );
  if (!configured) {
    return {
      provider,
      capability,
      mode: 'disabled',
      status: 'not_configured',
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      message: 'The requested provider capability is not registered for environment probing.',
      requiredEnvironment: [],
    };
  }
  return probeConfiguredProvider(environment, configured, timeoutMs);
}
