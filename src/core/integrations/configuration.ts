import type { IntegrationHealth } from './contracts.ts';

export type EnvironmentReader = Readonly<Record<string, string | undefined>>;

export type LiveProviderActivation = Readonly<{
  enabled: boolean;
  enableFlagSet: boolean;
  modeIsLive: boolean;
  enableFlagValid: boolean;
  modeValid: boolean;
  configuredMode: 'sandbox' | 'live' | 'disabled' | 'invalid';
  runtimeMode: 'sandbox' | 'live' | 'disabled';
}>;

/**
 * Resolves the two independent switches required before any provider adapter
 * may make a real network call. Credentials are a separate construction-time
 * requirement and never substitute for either switch.
 */
export function resolveLiveProviderActivation(
  environment: EnvironmentReader,
  enableFlag: string,
  modeSetting: string,
): LiveProviderActivation {
  const enableFlagValue = (environment[enableFlag] ?? 'false').trim().toLowerCase();
  const modeValue = (environment[modeSetting] ?? 'sandbox').trim().toLowerCase();
  const enableFlagSet = enableFlagValue === 'true';
  const modeIsLive = modeValue === 'live';
  const enableFlagValid = enableFlagValue === 'true' || enableFlagValue === 'false';
  const modeValid = modeValue === 'sandbox' || modeValue === 'live' || modeValue === 'disabled';
  const configuredMode = modeValid ? modeValue : 'invalid';
  const runtimeMode =
    !enableFlagValid || !modeValid || modeValue === 'disabled' || enableFlagSet !== modeIsLive
      ? 'disabled'
      : enableFlagSet && modeIsLive
        ? 'live'
        : 'sandbox';
  return {
    enabled: enableFlagSet && modeIsLive,
    enableFlagSet,
    modeIsLive,
    enableFlagValid,
    modeValid,
    configuredMode,
    runtimeMode,
  };
}

export function isLiveProviderEnabled(
  environment: EnvironmentReader,
  enableFlag: string,
  modeSetting: string,
): boolean {
  return resolveLiveProviderActivation(environment, enableFlag, modeSetting).enabled;
}

type ProviderRequirement = {
  provider: string;
  capability: string;
  enableFlag: string;
  modeSetting: string;
  required: string[];
  requiredAny?: readonly (readonly string[])[];
  exact?: Readonly<Record<string, string>>;
};

const providerRequirements: readonly ProviderRequirement[] = [
  {
    provider: 'openai',
    capability: 'structured_ai',
    enableFlag: 'OPENAI_LIVE_ENABLED',
    modeSetting: 'OPENAI_MODE',
    required: ['OPENAI_API_KEY', 'OPENAI_MODEL'],
  },
  {
    provider: 'openai',
    capability: 'photo_analysis',
    enableFlag: 'OPENAI_VISION_LIVE_ENABLED',
    modeSetting: 'OPENAI_MODE',
    required: ['OPENAI_API_KEY', 'OPENAI_VISION_MODEL'],
  },
  {
    provider: 'twilio',
    capability: 'sms_voice',
    enableFlag: 'TWILIO_LIVE_ENABLED',
    modeSetting: 'TWILIO_MODE',
    required: [
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_SMS_FROM',
      'TWILIO_VOICE_FROM',
      'TWILIO_WEBHOOK_URL',
      'TWILIO_COMPANY_ID',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ],
  },
  {
    provider: 'email',
    capability: 'email',
    enableFlag: 'EMAIL_LIVE_ENABLED',
    modeSetting: 'EMAIL_MODE',
    required: [
      'EMAIL_PROVIDER',
      'EMAIL_PROVIDER_ENDPOINT',
      'EMAIL_PROVIDER_TOKEN',
      'EMAIL_FROM',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ],
  },
  {
    provider: 'stripe',
    capability: 'payments',
    enableFlag: 'STRIPE_LIVE_ENABLED',
    modeSetting: 'STRIPE_MODE',
    required: [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_CHECKOUT_SUCCESS_URL',
      'STRIPE_CHECKOUT_CANCEL_URL',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ],
  },
  {
    provider: 'google_calendar',
    capability: 'calendar',
    enableFlag: 'GOOGLE_CALENDAR_LIVE_ENABLED',
    modeSetting: 'GOOGLE_CALENDAR_MODE',
    required: ['GOOGLE_CALENDAR_ID'],
    requiredAny: [
      [
        'GOOGLE_CALENDAR_CLIENT_ID',
        'GOOGLE_CALENDAR_CLIENT_SECRET',
        'GOOGLE_CALENDAR_REFRESH_TOKEN',
      ],
      ['GOOGLE_CALENDAR_ACCESS_TOKEN'],
    ],
  },
  {
    provider: 'maps',
    capability: 'geocoding',
    enableFlag: 'MAPS_LIVE_ENABLED',
    modeSetting: 'MAPS_MODE',
    required: ['GOOGLE_MAPS_API_KEY'],
  },
  {
    provider: 'nws',
    capability: 'weather',
    enableFlag: 'NWS_LIVE_ENABLED',
    modeSetting: 'WEATHER_MODE',
    required: ['NWS_USER_AGENT'],
  },
  {
    provider: 'vroom',
    capability: 'routing',
    enableFlag: 'VROOM_LIVE_ENABLED',
    modeSetting: 'ROUTING_MODE',
    required: ['VROOM_URL'],
  },
  {
    provider: 'signed_storage_targets',
    capability: 'server_signed_targets',
    enableFlag: 'SIGNED_STORAGE_TARGETS_LIVE_ENABLED',
    modeSetting: 'SIGNED_STORAGE_TARGETS_MODE',
    required: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STORAGE_BUCKET_JOB_PHOTOS'],
    exact: { STORAGE_BUCKET_JOB_PHOTOS: 'job-media' },
  },
  {
    provider: 'quickbooks_export',
    capability: 'accounting_export',
    enableFlag: 'QUICKBOOKS_EXPORT_ENABLED',
    modeSetting: 'QUICKBOOKS_MODE',
    required: [],
  },
];

/**
 * Produces a secret-safe configuration view for an integration-health screen.
 * "degraded" means configuration is complete but an active adapter probe still
 * has to establish "healthy".
 */
export function assessIntegrationEnvironment(
  environment: EnvironmentReader,
  now = new Date(),
): IntegrationHealth[] {
  return providerRequirements.map((requirement) => {
    const acceptedAlternativeNames = requirement.requiredAny?.flat() ?? [];
    const allEnvironmentNames = [...requirement.required, ...acceptedAlternativeNames];
    const activation = resolveLiveProviderActivation(
      environment,
      requirement.enableFlag,
      requirement.modeSetting,
    );
    if (!activation.enableFlagValid || !activation.modeValid) {
      return {
        provider: requirement.provider,
        capability: requirement.capability,
        mode: 'disabled',
        status: 'not_configured',
        checkedAt: now.toISOString(),
        latencyMs: 0,
        message: `Provider activation settings are invalid; ${requirement.enableFlag} must be true or false and ${requirement.modeSetting} must be sandbox, live, or disabled.`,
        requiredEnvironment: [requirement.enableFlag, requirement.modeSetting],
      };
    }
    if (activation.configuredMode === 'disabled') {
      return {
        provider: requirement.provider,
        capability: requirement.capability,
        mode: 'disabled',
        status: 'not_configured',
        checkedAt: now.toISOString(),
        latencyMs: 0,
        message: `Provider is explicitly disabled by ${requirement.modeSetting}=disabled; no live or sandbox operation is available.`,
        requiredEnvironment: [requirement.enableFlag, requirement.modeSetting],
      };
    }
    if (activation.enableFlagSet !== activation.modeIsLive) {
      return {
        provider: requirement.provider,
        capability: requirement.capability,
        mode: 'disabled',
        status: 'not_configured',
        checkedAt: now.toISOString(),
        latencyMs: 0,
        message: `Live activation is incomplete; real calls require both ${requirement.modeSetting}=live and ${requirement.enableFlag}=true.`,
        requiredEnvironment: [requirement.enableFlag, requirement.modeSetting],
      };
    }
    if (!activation.enabled) {
      return {
        provider: requirement.provider,
        capability: requirement.capability,
        mode: 'sandbox',
        status: 'healthy',
        checkedAt: now.toISOString(),
        latencyMs: 0,
        message: `Sandbox mode; real calls require both ${requirement.modeSetting}=live and ${requirement.enableFlag}=true.`,
        requiredEnvironment: [
          requirement.enableFlag,
          requirement.modeSetting,
          ...allEnvironmentNames,
        ],
      };
    }
    const missing = requirement.required.filter((name) => !environment[name]?.trim());
    const hasAcceptedAlternative =
      !requirement.requiredAny ||
      requirement.requiredAny.some((group) => group.every((name) => environment[name]?.trim()));
    if (!hasAcceptedAlternative && requirement.requiredAny) {
      missing.push(...(requirement.requiredAny[0] ?? []));
    }
    if (missing.length > 0) {
      return {
        provider: requirement.provider,
        capability: requirement.capability,
        mode: 'disabled',
        status: 'not_configured',
        checkedAt: now.toISOString(),
        latencyMs: 0,
        message: `Live mode requested but ${missing.length} required server setting(s) are missing.`,
        requiredEnvironment: [requirement.enableFlag, requirement.modeSetting, ...missing],
      };
    }
    const mismatched = Object.entries(requirement.exact ?? {})
      .filter(([name, expected]) => environment[name]?.trim() !== expected)
      .map(([name]) => name);
    if (mismatched.length > 0) {
      return {
        provider: requirement.provider,
        capability: requirement.capability,
        mode: 'disabled',
        status: 'not_configured',
        checkedAt: now.toISOString(),
        latencyMs: 0,
        message:
          'Live configuration disagrees with the V1 fixed Storage boundary; field and signed-target workflows must use the same private job-media bucket.',
        requiredEnvironment: [requirement.enableFlag, requirement.modeSetting, ...mismatched],
      };
    }
    return {
      provider: requirement.provider,
      capability: requirement.capability,
      mode: 'live',
      status: 'degraded',
      checkedAt: now.toISOString(),
      latencyMs: 0,
      message: 'Live configuration is present; run the provider health probe.',
      requiredEnvironment: [
        requirement.enableFlag,
        requirement.modeSetting,
        ...allEnvironmentNames,
      ],
    };
  });
}
