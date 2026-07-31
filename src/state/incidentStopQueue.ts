import {
  incidentPausePayloadSchema,
  incidentPauseReceiptSchema,
  type IncidentPausePayload,
  type IncidentPauseReceipt,
} from '@/core/incidents/contracts';
import type { OfflineMutation } from './model';
import type { StoryOpsCommand } from './liveRepository';
import { isUnresolvedIncidentStatus } from './incidentScope';

export type IncidentStopIntent = Pick<
  IncidentPausePayload,
  | 'actorUserId'
  | 'visitId'
  | 'jobId'
  | 'propertyId'
  | 'severity'
  | 'category'
  | 'summary'
  | 'immediateActions'
  | 'requiresLegalReview'
>;

export interface IncidentStopAuthoritativeReadback {
  companyId: string;
  incident: {
    id: string;
    incidentNumber: string;
    status: string;
    version: number;
  };
  visit: {
    id: string;
    jobId: string;
    propertyId: string;
    status: string;
    version: number;
    activeTimeEntryId?: string;
  };
}

export interface IncidentStopReconcileResult {
  queue: OfflineMutation[];
  outcome: 'confirmed' | 'retryable' | 'rejected' | 'persistence_unavailable';
  receipt?: IncidentPauseReceipt;
  error?: Error;
}

function incidentCommand(mutation: OfflineMutation): StoryOpsCommand {
  const command = mutation.command;
  if (
    mutation.kind !== 'command' ||
    !command ||
    command.commandType !== 'incident.report_pause' ||
    mutation.id !== command.commandId ||
    mutation.idempotencyKey !== command.commandId
  ) {
    throw new Error('Durable incident stop-work requires one exact command queue record.');
  }
  const payload = incidentPausePayloadSchema.parse(command.payload);
  if (
    mutation.scopeVisitId !== payload.visitId ||
    mutation.entityId !== payload.entityId ||
    command.expectedVersion < 1
  ) {
    throw new Error('Durable incident stop-work queue scope does not match its immutable payload.');
  }
  return command;
}

function exactIncidentReceipt(command: StoryOpsCommand, value: unknown): IncidentPauseReceipt {
  const payload = incidentPausePayloadSchema.parse(command.payload);
  const receipt = incidentPauseReceiptSchema.parse(value);
  if (
    receipt.commandId !== command.commandId ||
    receipt.commandType !== command.commandType ||
    receipt.requestHash !== command.requestHash ||
    receipt.actorUserId !== payload.actorUserId ||
    receipt.entityId !== payload.entityId ||
    receipt.incident.id !== payload.entityId ||
    receipt.incident.incidentNumber !== payload.incidentNumber ||
    receipt.visit.id !== payload.visitId ||
    receipt.visit.jobId !== payload.jobId ||
    receipt.visit.propertyId !== payload.propertyId ||
    receipt.visit.submittedExpectedVersion !== command.expectedVersion ||
    receipt.visit.previousVersion < receipt.visit.submittedExpectedVersion ||
    receipt.visit.currentStatus !== 'paused' ||
    receipt.visit.currentVersion < receipt.visit.previousVersion
  ) {
    throw new Error('Incident stop-work receipt does not match the durable command.');
  }
  return receipt;
}

function replaceMutation(
  queue: readonly OfflineMutation[],
  mutationId: string,
  replacement: OfflineMutation,
): OfflineMutation[] {
  return queue.map((mutation) => (mutation.id === mutationId ? replacement : { ...mutation }));
}

function retainedFailure(
  mutation: OfflineMutation,
  error: Error,
  retryable: boolean,
): OfflineMutation {
  return {
    ...mutation,
    status: retryable ? 'queued' : 'failed',
    lastError: error.message,
  };
}

export function durableIncidentStopForVisit(
  queue: readonly OfflineMutation[],
  visitId: string,
): OfflineMutation | undefined {
  return queue.find(
    (mutation) =>
      mutation.scopeVisitId === visitId &&
      mutation.status !== 'synced' &&
      mutation.command?.commandType === 'incident.report_pause',
  );
}

export function hasDurableIncidentStopLock(
  queue: readonly OfflineMutation[],
  visitId: string,
): boolean {
  return durableIncidentStopForVisit(queue, visitId) !== undefined;
}

export function incidentStopMatchesIntent(
  mutation: OfflineMutation,
  intent: IncidentStopIntent,
): boolean {
  try {
    const payload = incidentPausePayloadSchema.parse(incidentCommand(mutation).payload);
    return (
      payload.actorUserId === intent.actorUserId &&
      payload.visitId === intent.visitId &&
      payload.jobId === intent.jobId &&
      payload.propertyId === intent.propertyId &&
      payload.severity === intent.severity &&
      payload.category === intent.category &&
      payload.summary === intent.summary &&
      payload.immediateActions === intent.immediateActions &&
      payload.requiresLegalReview === intent.requiresLegalReview
    );
  } catch {
    return false;
  }
}

export function incidentStopReadbackMatches(
  mutation: OfflineMutation,
  readback: IncidentStopAuthoritativeReadback,
): boolean {
  try {
    const command = incidentCommand(mutation);
    const payload = incidentPausePayloadSchema.parse(command.payload);
    const receipt = exactIncidentReceipt(command, mutation.incidentPauseReceipt);
    return (
      readback.companyId === receipt.companyId &&
      readback.incident.id === payload.entityId &&
      readback.incident.incidentNumber === payload.incidentNumber &&
      isUnresolvedIncidentStatus(readback.incident.status) &&
      readback.incident.version >= receipt.incident.version &&
      readback.visit.id === payload.visitId &&
      readback.visit.jobId === payload.jobId &&
      readback.visit.propertyId === payload.propertyId &&
      readback.visit.status === 'paused' &&
      readback.visit.version >= receipt.visit.currentVersion &&
      readback.visit.activeTimeEntryId === undefined
    );
  } catch {
    return false;
  }
}

export async function reconcileDurableIncidentStop(input: {
  queue: readonly OfflineMutation[];
  mutationId: string;
  persistQueue(queue: OfflineMutation[]): Promise<boolean>;
  send(command: StoryOpsCommand): Promise<unknown>;
  loadAuthoritativeReadback(): Promise<IncidentStopAuthoritativeReadback>;
  isAmbiguousFailure(error: unknown): boolean;
}): Promise<IncidentStopReconcileResult> {
  const original = input.queue.map((mutation) => ({ ...mutation }));
  const mutation = original.find((candidate) => candidate.id === input.mutationId);
  if (!mutation) {
    return {
      queue: original,
      outcome: 'rejected',
      error: new Error('The durable incident stop-work command is no longer queued.'),
    };
  }

  let command: StoryOpsCommand;
  try {
    command = incidentCommand(mutation);
  } catch (error) {
    return {
      queue: original,
      outcome: 'rejected',
      error: error instanceof Error ? error : new Error('Incident queue validation failed.'),
    };
  }

  const syncing: OfflineMutation = {
    ...mutation,
    status: 'syncing',
    attemptCount: (mutation.attemptCount ?? 0) + 1,
    lastError: undefined,
  };
  let queue = replaceMutation(original, mutation.id, syncing);
  if (!(await input.persistQueue(queue))) {
    return {
      queue: original,
      outcome: 'persistence_unavailable',
      error: new Error('The exact incident command was not durably marked for replay.'),
    };
  }

  let receipt: IncidentPauseReceipt;
  try {
    receipt = mutation.incidentPauseReceipt
      ? exactIncidentReceipt(command, mutation.incidentPauseReceipt)
      : exactIncidentReceipt(command, await input.send(command));
  } catch (error) {
    const failure =
      error instanceof Error ? error : new Error('Atomic incident stop-work submission failed.');
    const retryable = input.isAmbiguousFailure(error);
    queue = replaceMutation(queue, mutation.id, retainedFailure(syncing, failure, retryable));
    await input.persistQueue(queue);
    return {
      queue,
      outcome: retryable ? 'retryable' : 'rejected',
      error: failure,
    };
  }

  const receiptMutation: OfflineMutation = {
    ...syncing,
    status: 'syncing',
    incidentPauseReceipt: receipt,
  };
  queue = replaceMutation(queue, mutation.id, receiptMutation);
  if (!(await input.persistQueue(queue))) {
    return {
      queue,
      outcome: 'retryable',
      receipt,
      error: new Error(
        'The server receipt could not be durably saved; the original command remains queued.',
      ),
    };
  }

  let readback: IncidentStopAuthoritativeReadback;
  try {
    readback = await input.loadAuthoritativeReadback();
  } catch (error) {
    const failure =
      error instanceof Error
        ? error
        : new Error('Authoritative incident workspace readback failed.');
    queue = replaceMutation(queue, mutation.id, retainedFailure(receiptMutation, failure, true));
    await input.persistQueue(queue);
    return { queue, outcome: 'retryable', receipt, error: failure };
  }
  if (!incidentStopReadbackMatches(receiptMutation, readback)) {
    const failure = new Error(
      'Authoritative workspace does not yet prove the exact unresolved incident, paused visit, and stopped timer.',
    );
    queue = replaceMutation(queue, mutation.id, retainedFailure(receiptMutation, failure, true));
    await input.persistQueue(queue);
    return { queue, outcome: 'retryable', receipt, error: failure };
  }

  const confirmedQueue = queue
    .filter((candidate) => candidate.id !== mutation.id)
    .map((candidate) => ({
      ...candidate,
      dependsOn: (candidate.dependsOn ?? []).filter((dependency) => dependency !== mutation.id),
    }));
  if (!(await input.persistQueue(confirmedQueue))) {
    const failure = new Error(
      'Authoritative stop-work was confirmed, but durable queue cleanup did not complete.',
    );
    return { queue, outcome: 'retryable', receipt, error: failure };
  }
  return { queue: confirmedQueue, outcome: 'confirmed', receipt };
}
