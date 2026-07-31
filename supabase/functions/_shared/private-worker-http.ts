import { constantTimeEqual } from '../../../src/core/integrations/webhooks.ts';
import { HttpError } from './http.ts';
import {
  inspectPrivateWorkerConfiguration,
  type PrivateWorkerInspection,
  type PrivateWorkerSettings,
  type PrivateWorkerTrigger,
} from './private-worker.ts';

export function authorizePrivateWorkerCredential(
  environment: Readonly<Record<string, string | undefined>>,
  settings: PrivateWorkerSettings,
  suppliedToken: string | undefined,
): PrivateWorkerInspection {
  const inspection = inspectPrivateWorkerConfiguration(environment, settings);
  if (inspection.credentialStatus !== 'valid') {
    throw new HttpError(
      `${settings.label} has an invalid dedicated credential configuration.`,
      503,
      'WORKER_MISCONFIGURED',
    );
  }
  const expectedToken = environment[settings.tokenName];
  if (!expectedToken || !suppliedToken || !constantTimeEqual(suppliedToken, expectedToken)) {
    throw new HttpError(
      `A dedicated ${settings.label} credential is required.`,
      401,
      'WORKER_UNAUTHENTICATED',
    );
  }
  return inspection;
}

export function authorizePrivateWorkerTrigger(
  inspection: PrivateWorkerInspection,
  trigger: PrivateWorkerTrigger,
  label: string,
): asserts inspection is PrivateWorkerInspection & {
  activationMode: PrivateWorkerTrigger;
  readiness: 'ready';
  acceptedTrigger: PrivateWorkerTrigger;
} {
  if (inspection.activationMode === 'invalid') {
    throw new HttpError(`${label} has an invalid activation mode.`, 503, 'WORKER_MISCONFIGURED');
  }
  if (inspection.activationMode === 'disabled') {
    throw new HttpError(
      `${label} is disabled; no durable work was claimed.`,
      409,
      'WORKER_INACTIVE',
    );
  }
  if (inspection.readiness !== 'ready') {
    throw new HttpError(`${label} is not ready to claim work.`, 503, 'WORKER_MISCONFIGURED');
  }
  if (inspection.activationMode !== trigger) {
    throw new HttpError(
      `${label} does not permit the requested trigger.`,
      403,
      'WORKER_TRIGGER_NOT_ALLOWED',
    );
  }
}
