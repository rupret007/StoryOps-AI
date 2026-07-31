import {
  resolveLiveProviderActivation,
  type EnvironmentReader,
  type LiveProviderActivation,
} from '../../../src/core/integrations/configuration.ts';

export type ProviderWebhookKind = 'stripe' | 'twilio' | 'email';

const activationSettings: Readonly<
  Record<ProviderWebhookKind, Readonly<{ enableFlag: string; modeSetting: string }>>
> = {
  stripe: {
    enableFlag: 'STRIPE_LIVE_ENABLED',
    modeSetting: 'STRIPE_MODE',
  },
  twilio: {
    enableFlag: 'TWILIO_LIVE_ENABLED',
    modeSetting: 'TWILIO_MODE',
  },
  email: {
    enableFlag: 'EMAIL_LIVE_ENABLED',
    modeSetting: 'EMAIL_MODE',
  },
};

/**
 * Callback ingress is part of its provider adapter. It must obey the exact
 * provider mode and enable flag before signature parsing or durable claims.
 */
export function resolveProviderWebhookActivation(
  environment: EnvironmentReader,
  provider: ProviderWebhookKind,
): LiveProviderActivation {
  const settings = activationSettings[provider];
  return resolveLiveProviderActivation(environment, settings.enableFlag, settings.modeSetting);
}
