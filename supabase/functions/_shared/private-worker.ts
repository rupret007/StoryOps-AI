import { constantTimeEqual } from '../../../src/core/integrations/webhooks.ts';

export const PRIVATE_WORKER_TOKEN_MINIMUM_BYTES = 32;

export type PrivateWorkerActivationMode = 'disabled' | 'manual' | 'scheduled';
export type PrivateWorkerTrigger = Exclude<PrivateWorkerActivationMode, 'disabled'>;
export type PrivateWorkerCredentialStatus =
  | 'valid'
  | 'missing'
  | 'too_short'
  | 'surrounding_whitespace'
  | 'service_role_reuse'
  | 'peer_worker_reuse';

export type PrivateWorkerInspection = Readonly<{
  activationMode: PrivateWorkerActivationMode | 'invalid';
  credentialStatus: PrivateWorkerCredentialStatus;
  readiness: 'ready' | 'inactive' | 'blocked';
  acceptedTrigger: PrivateWorkerTrigger | null;
}>;

export type PrivateWorkerSettings = Readonly<{
  label: string;
  tokenName: string;
  modeName: string;
  peerTokenNames?: readonly string[];
}>;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function activationMode(value: string | undefined): PrivateWorkerActivationMode | 'invalid' {
  if (value === undefined || value === '') return 'disabled';
  if (value === 'disabled' || value === 'manual' || value === 'scheduled') {
    return value;
  }
  return 'invalid';
}

export function inspectDedicatedWorkerCredential(
  environment: Readonly<Record<string, string | undefined>>,
  settings: PrivateWorkerSettings,
): PrivateWorkerCredentialStatus {
  const token = environment[settings.tokenName];
  if (!token) return 'missing';
  if (token !== token.trim()) return 'surrounding_whitespace';
  if (byteLength(token) < PRIVATE_WORKER_TOKEN_MINIMUM_BYTES) return 'too_short';

  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceRoleKey && constantTimeEqual(token, serviceRoleKey.trim())) {
    return 'service_role_reuse';
  }
  for (const peerTokenName of settings.peerTokenNames ?? []) {
    const peerToken = environment[peerTokenName];
    if (peerToken && constantTimeEqual(token, peerToken)) return 'peer_worker_reuse';
  }
  return 'valid';
}

export function inspectPrivateWorkerConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  settings: PrivateWorkerSettings,
): PrivateWorkerInspection {
  const mode = activationMode(environment[settings.modeName]);
  const tokenStatus = inspectDedicatedWorkerCredential(environment, settings);
  const acceptedTrigger = mode === 'manual' || mode === 'scheduled' ? mode : null;
  const readiness =
    mode === 'invalid' ||
    tokenStatus === 'service_role_reuse' ||
    tokenStatus === 'peer_worker_reuse' ||
    (mode !== 'disabled' && tokenStatus !== 'valid')
      ? 'blocked'
      : mode === 'disabled'
        ? 'inactive'
        : 'ready';
  return {
    activationMode: mode,
    credentialStatus: tokenStatus,
    readiness,
    acceptedTrigger,
  };
}
