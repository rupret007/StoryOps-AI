import type {
  EmailProvider,
  ProviderReceipt,
  SmsProvider,
} from '../../../src/core/integrations/contracts.ts';
import { IntegrationError } from '../../../src/core/integrations/contracts.ts';
import { inspectPrivateWorkerConfiguration } from '../_shared/private-worker.ts';
import {
  transactionalClaimSchema,
  transactionalWorkerRequestSchema,
  transactionalWorkerResultSchema,
  transactionalWorkerResponseSchema,
  type TransactionalClaim,
  type TransactionalWorkerResult,
} from './contracts.ts';
import { processTransactionalClaim, type TransactionalWorkerRepository } from './worker.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
}

const CLAIM = {
  schemaVersion: 'storyops-transactional-worker-claim-v1' as const,
  operation: 'send' as const,
  attemptId: 'a0000000-0000-4000-8000-000000000001',
  companyId: '10000000-0000-4000-8000-000000000001',
  action: 'quote.delivery' as const,
  channel: 'sms' as const,
  claimToken: 'a0000000-0000-4000-8000-000000000002',
  idempotencyKey: 'transactional:a0000000-0000-4000-8000-000000000001',
  attempt: 1,
  recipient: '+12145550100',
  subject: 'Quote Q-1048 is ready',
  body: 'Your quote is ready in the customer portal.',
  consentSnapshotId: '10000000-0000-4000-8000-000000000221',
};

function result(status: TransactionalWorkerResult['status']): TransactionalWorkerResult {
  return {
    schemaVersion: 'storyops-transactional-worker-result-v1',
    attemptId: CLAIM.attemptId,
    status,
    externalDeliveryClaimed: status === 'delivered',
  };
}

Deno.test('manual reconciliation result preserves the provider-read error separately', () => {
  const parsed = transactionalWorkerResultSchema.parse({
    schemaVersion: 'storyops-transactional-worker-result-v1',
    attemptId: CLAIM.attemptId,
    status: 'submitted',
    errorCode: 'RECONCILIATION_EXHAUSTED',
    providerReadErrorCode: 'HTTP_503',
    retryScheduled: false,
    manualReconciliationRequired: true,
    externalDeliveryClaimed: false,
  });
  assert(parsed.manualReconciliationRequired === true);
  assert(parsed.providerReadErrorCode === 'HTTP_503');
});

function repository(records: Array<Record<string, unknown>>): TransactionalWorkerRepository {
  return {
    beginSubmission(attemptId, claimToken, providerName) {
      records.push({
        kind: 'begin-submission',
        attemptId,
        claimToken,
        providerName,
      });
      return Promise.resolve();
    },
    complete(attemptId, claimToken, receipt) {
      records.push({
        kind: 'complete',
        attemptId,
        claimToken,
        receipt,
      });
      const status =
        receipt.mode === 'sandbox'
          ? 'sandboxed'
          : receipt.status === 'delivered'
            ? 'delivered'
            : receipt.status === 'failed'
              ? 'failed'
              : 'submitted';
      return Promise.resolve(result(status));
    },
    fail(attemptId, claimToken, errorCode, retryable) {
      records.push({
        kind: 'fail',
        attemptId,
        claimToken,
        errorCode,
        retryable,
      });
      return Promise.resolve({
        ...result(retryable ? 'queued' : 'failed'),
        errorCode,
        retryScheduled: retryable,
      });
    },
    markSubmissionUnknown(attemptId, claimToken, errorCode, providerName, providerMessageId) {
      records.push({
        kind: 'submission-unknown',
        attemptId,
        claimToken,
        errorCode,
        providerName,
        providerMessageId,
      });
      return Promise.resolve({
        ...result('submitted_unknown'),
        providerMode: 'live',
        providerStatus: 'submission_unknown',
        errorCode,
        manualReconciliationRequired: true,
      });
    },
  };
}

function providers(options: {
  mode?: 'sandbox' | 'live';
  receipt?: ProviderReceipt;
  delivery?: ProviderReceipt;
  error?: Error;
  calls?: { sms: number; email: number };
}): { sms: SmsProvider; email: EmailProvider } {
  const mode = options.mode ?? 'sandbox';
  return {
    sms: {
      provider: 'twilio',
      capability: 'sms',
      mode,
      health: () => Promise.reject(new Error('unused')),
      sendSms: () => {
        if (options.calls) options.calls.sms += 1;
        if (options.error) return Promise.reject(options.error);
        if (!options.receipt) {
          return Promise.reject(new Error('missing receipt fixture'));
        }
        return Promise.resolve(options.receipt);
      },
      getSmsDelivery: () => Promise.resolve(options.delivery),
    } as SmsProvider,
    email: {
      provider: 'email',
      capability: 'email',
      mode,
      health: () => Promise.reject(new Error('unused')),
      sendEmail: () => {
        if (options.calls) options.calls.email += 1;
        if (options.error) return Promise.reject(options.error);
        if (!options.receipt) {
          return Promise.reject(new Error('missing receipt fixture'));
        }
        return Promise.resolve(options.receipt);
      },
      getEmailDelivery: () => Promise.resolve(options.delivery),
    } as EmailProvider,
  };
}

Deno.test('transactional claim rejects caller-supplied delivery and arbitrary fields', () => {
  assert(transactionalClaimSchema.safeParse(CLAIM).success);
  assert(
    !transactionalClaimSchema.safeParse({
      ...CLAIM,
      delivered: true,
    }).success,
  );
  assert(
    !transactionalClaimSchema.safeParse({
      ...CLAIM,
      consentSnapshotId: undefined,
    }).success,
  );
});

Deno.test('sandbox records a sandbox disposition without external delivery evidence', async () => {
  const records: Array<Record<string, unknown>> = [];
  const receipt: ProviderReceipt = {
    provider: 'twilio',
    providerId: 'SM_SANDBOX_TRANSACTIONAL',
    mode: 'sandbox',
    status: 'delivered',
    occurredAt: '2026-07-29T14:00:00Z',
    idempotencyKey: CLAIM.idempotencyKey,
  };
  const response = await processTransactionalClaim({
    claim: CLAIM,
    providers: providers({ receipt }),
    repository: repository(records),
  });
  assert(response.status === 'sandboxed');
  assert(response.externalDeliveryClaimed === false);
  assert(records.length === 1);
  assert(records[0]?.kind === 'complete');
});

Deno.test('live accepted or queued provider receipt is submitted, never delivered', async () => {
  const records: Array<Record<string, unknown>> = [];
  const receipt: ProviderReceipt = {
    provider: 'twilio',
    providerId: 'SM_LIVE_QUEUED',
    mode: 'live',
    status: 'queued',
    occurredAt: '2026-07-29T14:00:00Z',
    idempotencyKey: CLAIM.idempotencyKey,
  };
  const response = await processTransactionalClaim({
    claim: CLAIM,
    providers: providers({ mode: 'live', receipt }),
    repository: repository(records),
  });
  assert(response.status === 'submitted');
  assert(response.externalDeliveryClaimed === false);
  assert(records[0]?.kind === 'begin-submission');
  assert(records[1]?.kind === 'complete');
});

Deno.test(
  'provider failure before a live receipt is quarantined after submission boundary',
  async () => {
    const records: Array<Record<string, unknown>> = [];
    const response = await processTransactionalClaim({
      claim: CLAIM,
      providers: providers({
        mode: 'live',
        error: new IntegrationError(
          'Provider timed out after request submission.',
          'twilio',
          'NETWORK_ERROR',
          true,
        ),
      }),
      repository: repository(records),
    });
    assert(response.status === 'submitted_unknown');
    assert(response.externalDeliveryClaimed === false);
    assert(records[0]?.kind === 'begin-submission');
    assert(records[1]?.kind === 'submission-unknown');
  },
);

Deno.test('authoritative consent denial does not cross the provider-unknown boundary', async () => {
  const records: Array<Record<string, unknown>> = [];
  const response = await processTransactionalClaim({
    claim: CLAIM,
    providers: providers({
      mode: 'live',
      error: new IntegrationError('Consent changed.', 'consent', 'STALE_CONSENT', false),
    }),
    repository: repository(records),
  });
  assert(response.status === 'failed');
  assert(records[0]?.kind === 'begin-submission');
  assert(records[1]?.kind === 'fail');
  assert(records[1]?.retryable === false);
});

Deno.test('live reconciliation reads provider state without resending', async () => {
  const records: Array<Record<string, unknown>> = [];
  const calls = { sms: 0, email: 0 };
  const claim: TransactionalClaim = {
    schemaVersion: 'storyops-transactional-worker-claim-v1',
    operation: 'reconcile',
    attemptId: CLAIM.attemptId,
    companyId: CLAIM.companyId,
    action: 'visit.on_my_way',
    channel: 'sms',
    claimToken: CLAIM.claimToken,
    idempotencyKey: CLAIM.idempotencyKey,
    attempt: 1,
    providerMessageId: 'SM_LIVE_QUEUED',
    providerName: 'twilio',
  };
  const delivery: ProviderReceipt = {
    provider: 'twilio',
    providerId: claim.providerMessageId,
    mode: 'live',
    status: 'delivered',
    occurredAt: '2026-07-29T14:02:00Z',
    idempotencyKey: 'provider-read',
  };
  const response = await processTransactionalClaim({
    claim,
    providers: providers({ mode: 'live', delivery, calls }),
    repository: repository(records),
  });
  assert(response.status === 'delivered');
  assert(calls.sms === 0);
  assert(calls.email === 0);
  const receipt = records[0]?.receipt as ProviderReceipt;
  assert(receipt.idempotencyKey === claim.idempotencyKey);
});

Deno.test('transactional worker response exposes only finite status evidence', () => {
  assert(
    transactionalWorkerResponseSchema.safeParse({
      schemaVersion: 'storyops-transactional-worker-run-v2',
      activationMode: 'scheduled',
      trigger: 'scheduled',
      status: 'processed',
      workerId: 'a0000000-0000-4000-8000-000000000003',
      claimed: 1,
      empty: false,
      counts: { submitted: 1 },
      results: [
        {
          schemaVersion: 'storyops-transactional-worker-result-v1',
          attemptId: CLAIM.attemptId,
          status: 'submitted',
          providerMode: 'live',
          providerStatus: 'queued',
          externalDeliveryClaimed: false,
        },
      ],
      checkedAt: '2026-07-30T21:30:00.000Z',
    }).success,
  );
});

Deno.test('transactional worker requires an explicit matching invocation class', () => {
  assert(
    transactionalWorkerRequestSchema.safeParse({
      companyId: CLAIM.companyId,
      trigger: 'manual',
      batchSize: 1,
      leaseSeconds: 30,
    }).success,
  );
  assert(
    transactionalWorkerRequestSchema.safeParse({
      companyId: CLAIM.companyId,
      trigger: 'scheduled',
      batchSize: 1,
      leaseSeconds: 30,
    }).success,
  );
  assert(
    !transactionalWorkerRequestSchema.safeParse({
      trigger: 'scheduled',
      batchSize: 1,
      leaseSeconds: 30,
    }).success,
  );
  assert(!transactionalWorkerRequestSchema.safeParse({}).success);

  const sharedToken = 'shared-worker-token-that-must-never-be-accepted';
  const inspection = inspectPrivateWorkerConfiguration(
    {
      SUPABASE_SERVICE_ROLE_KEY: 'different-service-role-key-that-is-long-enough',
      POST_SERVICE_WORKER_TOKEN: sharedToken,
      TRANSACTIONAL_OUTBOUND_WORKER_TOKEN: sharedToken,
      TRANSACTIONAL_OUTBOUND_WORKER_MODE: 'manual',
    },
    {
      label: 'transactional outbound worker',
      tokenName: 'TRANSACTIONAL_OUTBOUND_WORKER_TOKEN',
      modeName: 'TRANSACTIONAL_OUTBOUND_WORKER_MODE',
      peerTokenNames: ['POST_SERVICE_WORKER_TOKEN'],
    },
  );
  assert(inspection.credentialStatus === 'peer_worker_reuse');
  assert(inspection.readiness === 'blocked');
});
