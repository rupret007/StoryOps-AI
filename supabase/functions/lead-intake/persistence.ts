import {
  deterministicIntakeUuid,
  type NormalizedLeadIntake,
} from '../../../src/core/intake/index.ts';
import { sha256TextHex } from '../../../src/core/integrations/webhooks.ts';

type RpcClient = {
  rpc(
    functionName: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type PersistedIntake = {
  leadId: string | null;
  customerId: string | null;
  subjectType: 'lead' | 'customer';
  threadId: string;
  messageId: string;
  consentRecordIds: string[];
  existingSubject: boolean;
  existingLead: boolean;
};

export class LeadIntakePersistenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LeadIntakePersistenceError';
  }
}

async function providerMessageId(event: NormalizedLeadIntake): Promise<string> {
  const candidate = `${event.provider}:${event.providerEventId}`;
  if (candidate.length <= 255) return candidate;
  return `${event.provider}:sha256:${await sha256TextHex(event.providerEventId)}`;
}

function persistedIntakeResult(value: unknown): PersistedIntake {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Trusted lead-intake RPC returned no receipt.');
  }
  const record = candidate as Record<string, unknown>;
  if (
    record.contactSuppressed === true &&
    (record.resolutionStatus === 'ambiguous' || record.resolutionStatus === 'not_found')
  ) {
    throw new LeadIntakePersistenceError(
      record.resolutionStatus === 'ambiguous'
        ? 'Inbound contact matches multiple company subjects; the contact was suppressed and subject mutation was quarantined for review.'
        : 'SMS STOP did not resolve a company subject; the contact was suppressed and subject mutation was quarantined for review.',
      409,
      record.resolutionStatus === 'ambiguous'
        ? 'INTAKE_SUBJECT_AMBIGUOUS'
        : 'INTAKE_CONSENT_SUBJECT_NOT_FOUND',
    );
  }
  const subjectType = record.subjectType;
  const leadId = record.leadId;
  const customerId = record.customerId;
  if (
    (subjectType !== 'lead' && subjectType !== 'customer') ||
    (leadId !== null && typeof leadId !== 'string') ||
    (customerId !== null && typeof customerId !== 'string') ||
    typeof record.threadId !== 'string' ||
    typeof record.messageId !== 'string' ||
    !Array.isArray(record.consentRecordIds) ||
    !record.consentRecordIds.every((id) => typeof id === 'string') ||
    typeof record.existingSubject !== 'boolean' ||
    typeof record.existingLead !== 'boolean'
  ) {
    throw new Error('Trusted lead-intake RPC returned an invalid receipt.');
  }
  if (
    (subjectType === 'lead' && (typeof leadId !== 'string' || customerId !== null)) ||
    (subjectType === 'customer' && (typeof customerId !== 'string' || leadId !== null))
  ) {
    throw new Error('Trusted lead-intake RPC returned an inconsistent subject.');
  }
  return {
    subjectType,
    leadId,
    customerId,
    threadId: record.threadId as string,
    messageId: record.messageId as string,
    consentRecordIds: record.consentRecordIds as string[],
    existingSubject: record.existingSubject,
    existingLead: record.existingLead,
  };
}

function persistenceError(error: { message: string }): Error {
  if (error.message.includes('INTAKE_SUBJECT_AMBIGUOUS')) {
    return new LeadIntakePersistenceError(
      'Inbound contact matches multiple company subjects; no consent or lead mutation was applied.',
      409,
      'INTAKE_SUBJECT_AMBIGUOUS',
    );
  }
  if (error.message.includes('INTAKE_CONSENT_SUBJECT_NOT_FOUND')) {
    return new LeadIntakePersistenceError(
      'SMS consent keyword did not resolve to an existing company subject.',
      409,
      'INTAKE_CONSENT_SUBJECT_NOT_FOUND',
    );
  }
  if (error.message.includes('INTAKE_PROCESSING_LEASE_REQUIRED')) {
    return new LeadIntakePersistenceError(
      'Lead intake does not own the durable processing lease.',
      409,
      'INTAKE_PROCESSING_LEASE_REQUIRED',
    );
  }
  if (error.message.includes('INTAKE_RECEIPT_NOT_FOUND')) {
    return new LeadIntakePersistenceError(
      'Processed lead intake is missing its durable receipt.',
      409,
      'INTAKE_RECEIPT_NOT_FOUND',
    );
  }
  if (error.message.includes('INTAKE_INVALID_')) {
    return new LeadIntakePersistenceError(
      'Trusted lead-intake payload was rejected.',
      400,
      'INVALID_INTAKE',
    );
  }
  return new Error(`Trusted lead-intake persistence failed: ${error.message}`);
}

export async function intakeRpcPayload(
  event: NormalizedLeadIntake,
): Promise<Record<string, unknown>> {
  const consent = await Promise.all(
    event.consent.map(async (record) => ({
      ...record,
      id: await deterministicIntakeUuid(
        event.companyId,
        event.provider,
        event.providerEventId,
        `consent:${record.channel}:${record.purpose}`,
      ),
    })),
  );
  return {
    schemaVersion: 'storyops-lead-intake-v2',
    provider: event.provider,
    providerEventId: event.providerEventId,
    eventType: event.eventType,
    source: event.source,
    occurredAt: event.occurredAt,
    displayName: event.displayName,
    email: event.email ?? null,
    phone: event.phone ?? null,
    requestedServices: event.requestedServices,
    preferredContactChannel: event.preferredContactChannel ?? null,
    consentSignal: event.consentSignal,
    communication: {
      channel: event.communication.channel,
      sender: event.communication.sender,
      recipients: event.communication.recipients,
      body: event.communication.body,
      subject: event.communication.subject ?? null,
      providerMessageId: await providerMessageId(event),
    },
    consent,
    ids: {
      leadId: await deterministicIntakeUuid(
        event.companyId,
        event.provider,
        event.providerEventId,
        'lead',
      ),
      threadId: await deterministicIntakeUuid(
        event.companyId,
        event.provider,
        event.providerEventId,
        'communication_thread',
      ),
      messageId: await deterministicIntakeUuid(
        event.companyId,
        event.provider,
        event.providerEventId,
        'communication_message',
      ),
    },
  };
}

export async function persistStoryOpsLeadIntake(
  client: RpcClient,
  event: NormalizedLeadIntake,
  webhookEventId: string,
  payloadHash: string,
  processingLeaseId: string,
): Promise<PersistedIntake> {
  const { data, error } = await client.rpc('persist_storyops_lead_intake', {
    p_event_id: webhookEventId,
    p_payload_hash: payloadHash,
    p_company_id: event.companyId,
    p_processing_lease_id: processingLeaseId,
    p_intake: await intakeRpcPayload(event),
  });
  if (error) throw persistenceError(error);
  return persistedIntakeResult(data);
}

export async function loadStoryOpsLeadIntakeReceipt(
  client: RpcClient,
  event: NormalizedLeadIntake,
  webhookEventId: string,
  payloadHash: string,
): Promise<PersistedIntake> {
  const { data, error } = await client.rpc('load_storyops_lead_intake_receipt', {
    p_event_id: webhookEventId,
    p_payload_hash: payloadHash,
    p_company_id: event.companyId,
  });
  if (error) throw persistenceError(error);
  return persistedIntakeResult(data);
}
