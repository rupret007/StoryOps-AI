import type { SupabaseClient } from '@supabase/supabase-js';
import {
  privateWorkerIdSchema,
  requiredPrivateWorkerIds,
  type PrivateWorkerId,
} from '../../../src/core/integrations/outboundWorkerHealth.ts';
import {
  inspectPrivateWorkerConfiguration,
  type PrivateWorkerCredentialStatus,
  type PrivateWorkerInspection,
} from './private-worker.ts';
import { storyopsDeploymentFingerprint } from './deployment-fingerprint.ts';

export type PrivateWorkerConfigurationEvidence = Readonly<{
  worker: PrivateWorkerId;
  activationMode: 'disabled' | 'manual' | 'scheduled' | 'invalid';
  credentialStatus: PrivateWorkerCredentialStatus;
  acceptedTrigger: 'manual' | 'scheduled' | null;
  scheduleIntervalSeconds: number | null;
  configurationHash: string;
  deploymentIdentityStatus: 'valid' | 'missing' | 'invalid';
}>;

type WorkerDefinition = Readonly<{
  label: string;
  tokenName: string;
  modeName: string;
  intervalName: string;
  defaultIntervalSeconds: number;
  minimumIntervalSeconds: number;
  maximumIntervalSeconds: number;
}>;

export const privateWorkerDefinitions: Record<PrivateWorkerId, WorkerDefinition> = {
  post_service: {
    label: 'post-service worker',
    tokenName: 'POST_SERVICE_WORKER_TOKEN',
    modeName: 'POST_SERVICE_WORKER_MODE',
    intervalName: 'POST_SERVICE_WORKER_SCHEDULE_INTERVAL_SECONDS',
    defaultIntervalSeconds: 900,
    minimumIntervalSeconds: 60,
    maximumIntervalSeconds: 3_600,
  },
  transactional_outbound: {
    label: 'transactional outbound worker',
    tokenName: 'TRANSACTIONAL_OUTBOUND_WORKER_TOKEN',
    modeName: 'TRANSACTIONAL_OUTBOUND_WORKER_MODE',
    intervalName: 'TRANSACTIONAL_OUTBOUND_WORKER_SCHEDULE_INTERVAL_SECONDS',
    defaultIntervalSeconds: 60,
    minimumIntervalSeconds: 15,
    maximumIntervalSeconds: 900,
  },
  scheduling_reconciliation: {
    label: 'scheduling reconciliation worker',
    tokenName: 'SCHEDULING_RECONCILIATION_TOKEN',
    modeName: 'SCHEDULING_RECONCILIATION_MODE',
    intervalName: 'SCHEDULING_RECONCILIATION_SCHEDULE_INTERVAL_SECONDS',
    defaultIntervalSeconds: 120,
    minimumIntervalSeconds: 30,
    maximumIntervalSeconds: 900,
  },
  scope_photo_cleanup: {
    label: 'scope-photo cleanup worker',
    tokenName: 'SCOPE_PHOTO_CLEANUP_TOKEN',
    modeName: 'SCOPE_PHOTO_CLEANUP_MODE',
    intervalName: 'SCOPE_PHOTO_CLEANUP_SCHEDULE_INTERVAL_SECONDS',
    defaultIntervalSeconds: 900,
    minimumIntervalSeconds: 60,
    maximumIntervalSeconds: 3_600,
  },
};

function boundedInterval(value: string | undefined, definition: WorkerDefinition): number | null {
  const parsed =
    value === undefined || value === ''
      ? definition.defaultIntervalSeconds
      : Number.parseInt(value, 10);
  return Number.isInteger(parsed) &&
    parsed >= definition.minimumIntervalSeconds &&
    parsed <= definition.maximumIntervalSeconds
    ? parsed
    : null;
}

async function hmacSha256Hex(signingKey: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function resolveWorkerInspection(
  worker: PrivateWorkerId,
  environment: Readonly<Record<string, string | undefined>>,
): PrivateWorkerInspection {
  const definition = privateWorkerDefinitions[worker];
  const inspection = inspectPrivateWorkerConfiguration(environment, {
    label: definition.label,
    tokenName: definition.tokenName,
    modeName: definition.modeName,
    peerTokenNames: requiredPrivateWorkerIds
      .filter((peer) => peer !== worker)
      .map((peer) => privateWorkerDefinitions[peer].tokenName),
  });
  if (worker !== 'scheduling_reconciliation') return inspection;

  const configuredMode = environment.SCHEDULING_RECONCILIATION_MODE;
  const liveEnabled = environment.SCHEDULING_RECONCILIATION_LIVE_ENABLED;
  const activationMode: PrivateWorkerInspection['activationMode'] =
    configuredMode === undefined ||
    configuredMode === '' ||
    configuredMode === 'disabled' ||
    configuredMode === 'sandbox'
      ? 'disabled'
      : configuredMode === 'live' && liveEnabled === 'true'
        ? 'scheduled'
        : 'invalid';
  const credentialStatus = inspection.credentialStatus;
  return {
    activationMode,
    credentialStatus,
    acceptedTrigger: activationMode === 'scheduled' ? ('scheduled' as const) : null,
    readiness:
      activationMode === 'invalid' ||
      (activationMode !== 'disabled' && credentialStatus !== 'valid')
        ? ('blocked' as const)
        : activationMode === 'disabled'
          ? ('inactive' as const)
          : ('ready' as const),
  };
}

export function inspectRequiredPrivateWorkers(
  environment: Readonly<Record<string, string | undefined>>,
  signingKey: string,
): Promise<PrivateWorkerConfigurationEvidence[]> {
  const releaseId = environment.STORYOPS_RELEASE_ID;
  const deploymentIdentityStatus =
    !releaseId || releaseId.trim() === ''
      ? ('missing' as const)
      : /^[A-Za-z0-9][A-Za-z0-9._-]{7,119}$/u.test(releaseId)
        ? ('valid' as const)
        : ('invalid' as const);
  return Promise.all(
    requiredPrivateWorkerIds.map(async (worker) => {
      const definition = privateWorkerDefinitions[worker];
      const inspection = resolveWorkerInspection(worker, environment);
      const interval =
        inspection.activationMode === 'scheduled'
          ? boundedInterval(environment[definition.intervalName], definition)
          : null;
      const activationMode =
        inspection.activationMode === 'scheduled' && interval === null
          ? ('invalid' as const)
          : inspection.activationMode;
      const acceptedTrigger =
        activationMode === 'manual' || activationMode === 'scheduled' ? activationMode : null;
      const canonical = [
        'storyops-private-worker-configuration-v1',
        worker,
        activationMode,
        inspection.credentialStatus,
        acceptedTrigger ?? '<none>',
        interval?.toString() ?? '<none>',
        environment[definition.tokenName] ?? '<missing>',
        worker === 'scheduling_reconciliation'
          ? (environment.SCHEDULING_RECONCILIATION_LIVE_ENABLED ?? '<missing>')
          : '<not-applicable>',
      ].join('\u001f');
      return {
        worker,
        activationMode,
        credentialStatus: inspection.credentialStatus,
        acceptedTrigger,
        scheduleIntervalSeconds: interval,
        configurationHash: await hmacSha256Hex(signingKey, canonical),
        deploymentIdentityStatus,
      };
    }),
  );
}

export async function recordPrivateWorkerHeartbeat(input: {
  client: SupabaseClient;
  environment: Record<string, string | undefined>;
  serviceRoleKey: string;
  worker: PrivateWorkerId;
  companyIds: readonly string[];
  trigger: 'manual' | 'scheduled';
  status: 'succeeded' | 'failed';
}): Promise<void> {
  const worker = privateWorkerIdSchema.parse(input.worker);
  const [configuration] = (
    await inspectRequiredPrivateWorkers(input.environment, input.serviceRoleKey)
  ).filter((candidate) => candidate.worker === worker);
  if (!configuration) throw new Error('Private-worker configuration evidence is unavailable.');
  const deploymentFingerprint = await storyopsDeploymentFingerprint(
    input.environment,
    input.serviceRoleKey,
  );
  const companyIds = [...new Set(input.companyIds)].sort();
  for (const companyId of companyIds) {
    const { error } = await input.client.rpc('record_storyops_private_worker_heartbeat', {
      p_company_id: companyId,
      p_worker: worker,
      p_deployment_fingerprint: deploymentFingerprint,
      p_configuration_hash: configuration.configurationHash,
      p_trigger: input.trigger,
      p_status: input.status,
    });
    if (error) {
      throw new Error(`Private-worker heartbeat could not be persisted for ${worker}.`);
    }
  }
}
