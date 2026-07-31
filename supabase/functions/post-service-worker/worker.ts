import type {
  EmailProvider,
  ProviderReceipt,
  SmsProvider,
} from '../../../src/core/integrations/contracts.ts';
import { IntegrationError } from '../../../src/core/integrations/contracts.ts';
import type { OutboundClaim, WorkerResult } from './contracts.ts';

export type OutboundProviders = {
  sms: SmsProvider;
  email: EmailProvider;
};

export interface OutboundWorkerRepository {
  authorizeLiveSend?(claim: Extract<OutboundClaim, { operation: 'send' }>): Promise<void>;
  beginSubmission(followupId: string, claimToken: string, providerName: string): Promise<void>;
  complete(followupId: string, claimToken: string, receipt: ProviderReceipt): Promise<WorkerResult>;
  fail(
    followupId: string,
    claimToken: string,
    errorCode: string,
    retryable: boolean,
  ): Promise<WorkerResult>;
  markSubmissionUnknown(
    followupId: string,
    claimToken: string,
    errorCode: string,
    providerName: string,
    providerMessageId?: string,
  ): Promise<WorkerResult>;
}

function providerFor(claim: OutboundClaim, providers: OutboundProviders) {
  return claim.channel === 'sms' ? providers.sms : providers.email;
}

function safeErrorCode(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof IntegrationError) {
    const code = error.code
      .toUpperCase()
      .replace(/[^A-Z0-9_.:-]/gu, '_')
      .slice(0, 120);
    return {
      code: code || 'PROVIDER_ERROR',
      retryable: code === 'PROVIDER_DISABLED' ? true : error.retryable,
    };
  }
  return { code: 'WORKER_INTERNAL_ERROR', retryable: true };
}

const SAFE_BEFORE_PROVIDER_SUBMISSION_ERRORS = new Set([
  'CONSENT_NOT_GRANTED',
  'STALE_CONSENT',
  'OPTED_OUT',
  'CONSENT_CONTACT_MISMATCH',
  'CONSENT_UNKNOWN',
  'CONSENT_UNAVAILABLE',
  'RATE_LIMITED',
]);

function failedBeforeProviderSubmission(error: unknown): boolean {
  return (
    error instanceof IntegrationError && SAFE_BEFORE_PROVIDER_SUBMISSION_ERRORS.has(error.code)
  );
}

function send(
  claim: Extract<OutboundClaim, { operation: 'send' }>,
  providers: OutboundProviders,
): Promise<ProviderReceipt> {
  if (claim.channel === 'sms') {
    return providers.sms.sendSms({
      companyId: claim.companyId,
      to: claim.recipient,
      body: claim.body,
      category: 'marketing',
      consentSnapshotId: claim.consentSnapshotId,
      idempotencyKey: claim.idempotencyKey,
    });
  }
  if (providers.email.mode === 'live') {
    throw new IntegrationError(
      'Live marketing email is disabled until a signed unsubscribe and suppression path is configured.',
      providers.email.provider,
      'LIVE_EMAIL_MARKETING_UNSUBSCRIBE_REQUIRED',
      false,
    );
  }
  return providers.email.sendEmail({
    companyId: claim.companyId,
    to: [claim.recipient],
    subject: claim.subject,
    text: claim.body,
    category: 'marketing',
    consentSnapshotIds: { [claim.recipient]: claim.consentSnapshotId },
    idempotencyKey: claim.idempotencyKey,
  });
}

async function reconcile(
  claim: Extract<OutboundClaim, { operation: 'reconcile' }>,
  providers: OutboundProviders,
): Promise<ProviderReceipt> {
  const provider = providerFor(claim, providers);
  if (provider.mode !== 'live') {
    throw new IntegrationError(
      'A live provider is required to reconcile a live receipt.',
      provider.provider,
      'LIVE_PROVIDER_REQUIRED_FOR_RECONCILIATION',
      true,
    );
  }
  if (provider.provider !== claim.providerName) {
    throw new IntegrationError(
      'The configured provider does not match the durable submission receipt.',
      provider.provider,
      'PROVIDER_CONFIGURATION_CHANGED',
      true,
    );
  }
  const receipt =
    claim.channel === 'sms'
      ? await providers.sms.getSmsDelivery(claim.providerMessageId)
      : await providers.email.getEmailDelivery(claim.providerMessageId);
  if (!receipt) {
    throw new IntegrationError(
      'The provider has not returned a delivery receipt yet.',
      provider.provider,
      'PROVIDER_RECEIPT_NOT_FOUND',
      true,
    );
  }
  return { ...receipt, idempotencyKey: claim.idempotencyKey };
}

export async function processOutboundClaim(options: {
  claim: OutboundClaim;
  providers: OutboundProviders;
  repository: OutboundWorkerRepository;
}): Promise<WorkerResult> {
  const sendClaim = options.claim.operation === 'send' ? options.claim : undefined;
  const liveSmsSubmission =
    sendClaim !== undefined && sendClaim.channel === 'sms' && options.providers.sms.mode === 'live';
  let submissionBoundaryPersisted = false;
  let receipt: ProviderReceipt | undefined;
  try {
    if (liveSmsSubmission) {
      await options.repository.authorizeLiveSend?.(sendClaim);
      await options.repository.beginSubmission(
        options.claim.followupId,
        options.claim.claimToken,
        options.providers.sms.provider,
      );
      submissionBoundaryPersisted = true;
    }
    receipt =
      options.claim.operation === 'send'
        ? await send(options.claim, options.providers)
        : await reconcile(options.claim, options.providers);
    if (receipt.idempotencyKey !== options.claim.idempotencyKey) {
      throw new IntegrationError(
        'The provider receipt did not preserve the durable idempotency key.',
        receipt.provider,
        'PROVIDER_RECEIPT_IDEMPOTENCY_MISMATCH',
        false,
      );
    }
    return await options.repository.complete(
      options.claim.followupId,
      options.claim.claimToken,
      receipt,
    );
  } catch (error) {
    const failure = safeErrorCode(error);
    if (submissionBoundaryPersisted && !failedBeforeProviderSubmission(error)) {
      return options.repository.markSubmissionUnknown(
        options.claim.followupId,
        options.claim.claimToken,
        failure.code,
        options.providers.sms.provider,
        receipt?.providerId,
      );
    }
    return options.repository.fail(
      options.claim.followupId,
      options.claim.claimToken,
      failure.code,
      failure.retryable,
    );
  }
}
