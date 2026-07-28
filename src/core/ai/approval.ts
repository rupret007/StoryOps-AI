import type { ActionProposal, OfficeActor } from './contracts.ts';
import { AiOfficeError } from './contracts.ts';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';

export type AiApprovalRequest = {
  approvalId: string;
  companyId: string;
  runId: string;
  actionId: string;
  toolName: string;
  risk: ActionProposal['risk'];
  exactPayload: ActionProposal['payload'];
  payloadHash: string;
  reason: string;
  policyRule: string;
  requestedBy: OfficeActor;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: OfficeActor;
  decisionNote?: string;
};

export interface ApprovalStore {
  get(approvalId: string): Promise<AiApprovalRequest | undefined>;
  save(request: AiApprovalRequest): Promise<void>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly requests = new Map<string, AiApprovalRequest>();

  async get(approvalId: string): Promise<AiApprovalRequest | undefined> {
    return this.requests.get(approvalId);
  }

  async save(request: AiApprovalRequest): Promise<void> {
    this.requests.set(request.approvalId, structuredClone(request));
  }

  list(): AiApprovalRequest[] {
    return [...this.requests.values()].map((request) => structuredClone(request));
  }
}

function canonicalize(value: unknown): string {
  if (value === undefined) return '"[UNDEFINED]"';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'object') {
    throw new TypeError('Canonical approval hashes accept JSON-compatible values only.');
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(',')}}`;
}

export async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createApprovalRequest(options: {
  companyId: string;
  runId: string;
  proposal: ActionProposal;
  reason: string;
  policyRule: string;
  requestedBy: OfficeActor;
  now?: Date;
  ttlMs?: number;
}): Promise<AiApprovalRequest> {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1_000;
  const payloadHash = await sha256Hex({
    runId: options.runId,
    actionId: options.proposal.actionId,
    toolName: options.proposal.toolName,
    risk: options.proposal.risk,
    payload: options.proposal.payload,
  });

  return {
    approvalId: globalThis.crypto.randomUUID(),
    companyId: options.companyId,
    runId: options.runId,
    actionId: options.proposal.actionId,
    toolName: options.proposal.toolName,
    risk: options.proposal.risk,
    exactPayload: structuredClone(options.proposal.payload),
    payloadHash,
    reason: options.reason,
    policyRule: options.policyRule,
    requestedBy: options.requestedBy,
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

export async function decideApproval(options: {
  store: ApprovalStore;
  approvalId: string;
  decision: 'approved' | 'rejected';
  actor: OfficeActor;
  note?: string;
  now?: Date;
}): Promise<AiApprovalRequest> {
  const approval = await options.store.get(options.approvalId);
  if (!approval) {
    throw new AiOfficeError('Approval request was not found.', 'APPROVAL_MISMATCH');
  }
  if (approval.status !== 'pending') {
    throw new AiOfficeError(`Approval is already ${approval.status}.`, 'APPROVAL_MISMATCH');
  }
  if (options.actor.role !== 'owner' && options.actor.role !== 'dispatcher') {
    throw new AiOfficeError(
      'Only an owner or dispatcher may decide an approval.',
      'APPROVAL_MISMATCH',
    );
  }

  const now = options.now ?? new Date();
  const decided: AiApprovalRequest = {
    ...approval,
    status: new Date(approval.expiresAt).getTime() <= now.getTime() ? 'expired' : options.decision,
    decidedAt: now.toISOString(),
    decidedBy: options.actor,
    decisionNote: options.note,
  };
  await options.store.save(decided);
  return decided;
}

export async function assertExactApproval(options: {
  approval: AiApprovalRequest;
  companyId: string;
  runId: string;
  proposal: ActionProposal;
  now?: Date;
}): Promise<void> {
  if (options.approval.status !== 'approved') {
    throw new AiOfficeError('Action has not been approved.', 'APPROVAL_REQUIRED');
  }
  await assertApprovalPayloadMatch(options);
}

export async function assertApprovalPayloadMatch(options: {
  approval: AiApprovalRequest;
  companyId: string;
  runId: string;
  proposal: ActionProposal;
  now?: Date;
}): Promise<void> {
  const { approval, companyId, runId, proposal } = options;
  if (approval.companyId !== companyId || approval.runId !== runId) {
    throw new AiOfficeError('Approval belongs to a different company or run.', 'APPROVAL_MISMATCH');
  }
  if (approval.actionId !== proposal.actionId || approval.toolName !== proposal.toolName) {
    throw new AiOfficeError(
      'Approval action identity does not match the proposal.',
      'APPROVAL_MISMATCH',
    );
  }
  const now = options.now ?? new Date();
  if (new Date(approval.expiresAt).getTime() <= now.getTime()) {
    throw new AiOfficeError('Approval has expired.', 'APPROVAL_EXPIRED');
  }

  const currentHash = await sha256Hex({
    runId,
    actionId: proposal.actionId,
    toolName: proposal.toolName,
    risk: proposal.risk,
    payload: proposal.payload,
  });
  if (currentHash !== approval.payloadHash) {
    throw new AiOfficeError(
      'The action payload changed after approval was requested.',
      'APPROVAL_MISMATCH',
    );
  }
}
