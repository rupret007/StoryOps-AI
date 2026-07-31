import {
  resolveLiveProviderActivation,
  type EnvironmentReader,
  type LiveProviderActivation,
} from '../../../src/core/integrations/configuration.ts';

export const LEAD_INTAKE_ENABLE_FLAG = 'LEAD_INTAKE_LIVE_ENABLED';
export const LEAD_INTAKE_MODE_SETTING = 'LEAD_INTAKE_MODE';

/**
 * Signed inbound traffic is still an externally reachable live boundary. It
 * therefore requires the same two independent switches as an outbound
 * provider adapter; credentials never substitute for either switch.
 */
export function resolveLeadIntakeActivation(
  environment: EnvironmentReader,
): LiveProviderActivation {
  return resolveLiveProviderActivation(
    environment,
    LEAD_INTAKE_ENABLE_FLAG,
    LEAD_INTAKE_MODE_SETTING,
  );
}
