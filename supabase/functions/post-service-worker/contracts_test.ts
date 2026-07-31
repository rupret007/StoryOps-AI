import type {
  EmailProvider,
  ProviderReceipt,
  SmsProvider,
} from '../../../src/core/integrations/contracts.ts';
import { IntegrationError } from '../../../src/core/integrations/contracts.ts';
import {
  PRIVATE_WORKER_TOKEN_MINIMUM_BYTES,
  inspectPrivateWorkerConfiguration,
} from '../_shared/private-worker.ts';
import {
  outboundClaimSchema,
  workerRequestSchema,
  workerResultSchema,
  workerResponseSchema,
  type OutboundClaim,
  type WorkerResult,
} from './contracts.ts';
import { processOutboundClaim, type OutboundWorkerRepository } from './worker.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
}

const CLAIM_IDENTITY = {
  schemaVersion: 'storyops-post-service-worker-claim-v1' as const,
  operation: 'send' as const,
  followupId: 'a0000000-0000-4000-8000-000000000001',
  companyId: '10000000-0000-4000-8000-000000000001',
  channel: 'sms' as const,
  claimToken: 'a0000000-0000-4000-8000-000000000002',
  idempotencyKey: 'post-service:a0000000-0000-4000-8000-000000000001',
  recipient: '+12145550100',
  subject: 'How did we do?',
  body: 'Reply with honest feedback. Reply STOP to opt out.',
  consentSnapshotId: '10000000-0000-4000-8000-000000000221',
  attempt: 1,
};

function result(status: WorkerResult['status']): WorkerResult {
  return {
    schemaVersion: 'storyops-post-service-worker-result-v1',
    followupId: CLAIM_IDENTITY.followupId,
    status,
    externalDeliveryClaimed: status === 'completed',
  };
}

Deno.test('manual reconciliation result preserves the provider-read error separately', () => {
  const parsed = workerResultSchema.parse({
    schemaVersion: 'storyops-post-service-worker-result-v1',
    followupId: CLAIM_IDENTITY.followupId,
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

function repository(records: Array<Record<string, unknown>>): OutboundWorkerRepository {
  return {
    beginSubmission(followupId, claimToken, providerName) {
      records.push({ kind: 'begin-submission', followupId, claimToken, providerName });
      return Promise.resolve();
    },
    complete(followupId, claimToken, receipt) {
      records.push({ kind: 'complete', followupId, claimToken, receipt });
      return Promise.resolve(result(receipt.mode === 'sandbox' ? 'sandboxed' : 'submitted'));
    },
    fail(followupId, claimToken, errorCode, retryable) {
      records.push({ kind: 'fail', followupId, claimToken, errorCode, retryable });
      return Promise.resolve({
        ...result(retryable ? 'queued' : 'failed'),
        errorCode,
        retryScheduled: retryable,
      });
    },
    markSubmissionUnknown(followupId, claimToken, errorCode, providerName, providerMessageId) {
      records.push({
        kind: 'submission-unknown',
        followupId,
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
        retryScheduled: false,
      });
    },
  };
}

function providers(options: {
  receipt?: ProviderReceipt;
  error?: Error;
  delivery?: ProviderReceipt;
  mode?: 'sandbox' | 'live';
  calls?: { smsSends: number; emailSends: number };
}): { sms: SmsProvider; email: EmailProvider } {
  const mode = options.mode ?? 'sandbox';
  const provider = mode === 'live' ? 'twilio' : 'twilio';
  const sms = {
    provider,
    capability: 'sms',
    mode,
    health() {
      return Promise.reject(new Error('unused'));
    },
    sendSms() {
      if (options.calls) options.calls.smsSends += 1;
      if (options.error) return Promise.reject(options.error);
      if (!options.receipt) return Promise.reject(new Error('missing receipt fixture'));
      return Promise.resolve(options.receipt);
    },
    getSmsDelivery() {
      return Promise.resolve(options.delivery);
    },
  } as SmsProvider;
  const email = {
    provider: mode === 'live' ? 'email-live' : 'email',
    capability: 'email',
    mode,
    health() {
      return Promise.reject(new Error('unused'));
    },
    sendEmail() {
      if (options.calls) options.calls.emailSends += 1;
      if (!options.receipt) return Promise.reject(new Error('missing receipt fixture'));
      return Promise.resolve(options.receipt);
    },
    getEmailDelivery() {
      return Promise.resolve(options.delivery);
    },
  } as EmailProvider;
  return { sms, email };
}

Deno.test('worker claim contract rejects delivery claims and arbitrary message fields', () => {
  assert(outboundClaimSchema.safeParse(CLAIM_IDENTITY).success);
  assert(
    !outboundClaimSchema.safeParse({
      ...CLAIM_IDENTITY,
      delivered: true,
    }).success,
  );
  assert(
    !outboundClaimSchema.safeParse({
      ...CLAIM_IDENTITY,
      body: '',
    }).success,
  );
});

Deno.test('sandbox provider receipt is persisted for explicit sandbox disposition', async () => {
  const records: Array<Record<string, unknown>> = [];
  const receipt: ProviderReceipt = {
    provider: 'twilio',
    providerId: 'SM_SANDBOX_TEST',
    mode: 'sandbox',
    status: 'delivered',
    occurredAt: '2026-07-28T20:00:00Z',
    idempotencyKey: CLAIM_IDENTITY.idempotencyKey,
  };
  const response = await processOutboundClaim({
    claim: CLAIM_IDENTITY,
    providers: providers({ receipt }),
    repository: repository(records),
  });
  assert(response.status === 'sandboxed');
  assert(records.length === 1);
  assert(records[0]?.kind === 'complete');
});

Deno.test('retryable provider failures are recorded without fake completion', async () => {
  const records: Array<Record<string, unknown>> = [];
  const response = await processOutboundClaim({
    claim: CLAIM_IDENTITY,
    providers: providers({
      error: new IntegrationError('Temporary provider outage.', 'twilio', 'NETWORK_ERROR', true),
    }),
    repository: repository(records),
  });
  assert(response.status === 'queued');
  assert(response.retryScheduled === true);
  assert(records[0]?.errorCode === 'NETWORK_ERROR');
});

Deno.test(
  'explicitly disabled providers pause rather than terminally failing the queue',
  async () => {
    const records: Array<Record<string, unknown>> = [];
    const response = await processOutboundClaim({
      claim: CLAIM_IDENTITY,
      providers: providers({
        error: new IntegrationError('Provider disabled.', 'twilio', 'PROVIDER_DISABLED', false),
      }),
      repository: repository(records),
    });
    assert(response.status === 'queued');
    assert(response.retryScheduled === true);
    assert(records[0]?.errorCode === 'PROVIDER_DISABLED');
    assert(records[0]?.retryable === true);
  },
);

Deno.test('live marketing email is refused before the provider adapter is called', async () => {
  const records: Array<Record<string, unknown>> = [];
  const calls = { smsSends: 0, emailSends: 0 };
  const emailClaim: OutboundClaim = {
    ...CLAIM_IDENTITY,
    channel: 'email',
    recipient: 'customer@example.com',
  };
  const receipt: ProviderReceipt = {
    provider: 'email-live',
    providerId: 'em_live_should_not_send',
    mode: 'live',
    status: 'accepted',
    occurredAt: '2026-07-28T20:00:00Z',
    idempotencyKey: CLAIM_IDENTITY.idempotencyKey,
  };
  const response = await processOutboundClaim({
    claim: emailClaim,
    providers: providers({ receipt, mode: 'live', calls }),
    repository: repository(records),
  });
  assert(response.status === 'failed');
  assert(calls.emailSends === 0);
  assert(records[0]?.kind === 'fail');
  assert(records[0]?.errorCode === 'LIVE_EMAIL_MARKETING_UNSUBSCRIBE_REQUIRED');
  assert(records[0]?.retryable === false);
});

Deno.test(
  'accepted-then-timeout live SMS is quarantined and a stale lease cannot send twice',
  async () => {
    const records: Array<Record<string, unknown>> = [];
    const calls = { smsSends: 0, emailSends: 0 };
    let durableState: 'queued' | 'submitted_unknown' = 'queued';
    let claimActive = true;
    const statefulRepository: OutboundWorkerRepository = {
      beginSubmission(followupId, claimToken, providerName) {
        if (!claimActive || durableState !== 'queued') {
          return Promise.reject(new Error('POST_SERVICE_WORKER_SUBMISSION_BOUNDARY_LOST'));
        }
        durableState = 'submitted_unknown';
        records.push({ kind: 'begin-submission', followupId, claimToken, providerName });
        return Promise.resolve();
      },
      complete() {
        return Promise.reject(new Error('unexpected completion'));
      },
      fail() {
        if (!claimActive) {
          return Promise.reject(new Error('POST_SERVICE_WORKER_CLAIM_LOST'));
        }
        return Promise.reject(new Error('ambiguous submissions cannot be retried'));
      },
      markSubmissionUnknown(followupId, claimToken, errorCode, providerName, providerMessageId) {
        if (!claimActive || durableState !== 'submitted_unknown') {
          return Promise.reject(new Error('POST_SERVICE_WORKER_SUBMISSION_BOUNDARY_LOST'));
        }
        claimActive = false;
        records.push({
          kind: 'submission-unknown',
          followupId,
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
          retryScheduled: false,
        });
      },
    };
    const liveProviders = providers({
      error: new IntegrationError(
        'Twilio accepted the request but the response timed out.',
        'twilio',
        'NETWORK_ERROR',
        true,
      ),
      mode: 'live',
      calls,
    });
    const first = await processOutboundClaim({
      claim: CLAIM_IDENTITY,
      providers: liveProviders,
      repository: statefulRepository,
    });
    assert(first.status === 'submitted_unknown');
    assert(first.retryScheduled === false);
    assert(calls.smsSends === 1);
    assert(records[0]?.kind === 'begin-submission');
    assert(records[1]?.kind === 'submission-unknown');
    assert(records[1]?.providerMessageId === undefined);

    let staleLeaseBlocked = false;
    try {
      await processOutboundClaim({
        claim: CLAIM_IDENTITY,
        providers: liveProviders,
        repository: statefulRepository,
      });
    } catch {
      staleLeaseBlocked = true;
    }
    assert(staleLeaseBlocked);
    assert(calls.smsSends === 1);
  },
);

Deno.test('known Twilio SID is preserved when durable completion is uncertain', async () => {
  const records: Array<Record<string, unknown>> = [];
  const receipt: ProviderReceipt = {
    provider: 'twilio',
    providerId: 'SM_KNOWN_AFTER_ACCEPTANCE',
    mode: 'live',
    status: 'queued',
    occurredAt: '2026-07-28T20:00:00Z',
    idempotencyKey: CLAIM_IDENTITY.idempotencyKey,
  };
  const uncertainRepository = repository(records);
  uncertainRepository.complete = () => Promise.reject(new Error('database response timed out'));
  const response = await processOutboundClaim({
    claim: CLAIM_IDENTITY,
    providers: providers({ receipt, mode: 'live' }),
    repository: uncertainRepository,
  });
  assert(response.status === 'submitted_unknown');
  assert(records[0]?.kind === 'begin-submission');
  assert(records[1]?.kind === 'submission-unknown');
  assert(records[1]?.providerMessageId === receipt.providerId);
});

Deno.test('live reconciliation reads provider state and never resends', async () => {
  const records: Array<Record<string, unknown>> = [];
  const reconcileClaim: OutboundClaim = {
    schemaVersion: 'storyops-post-service-worker-claim-v1',
    operation: 'reconcile',
    followupId: CLAIM_IDENTITY.followupId,
    companyId: CLAIM_IDENTITY.companyId,
    channel: 'sms',
    claimToken: CLAIM_IDENTITY.claimToken,
    idempotencyKey: CLAIM_IDENTITY.idempotencyKey,
    providerMessageId: 'SM1234567890',
    providerName: 'twilio',
    attempt: 1,
  };
  const delivery: ProviderReceipt = {
    provider: 'twilio',
    providerId: reconcileClaim.providerMessageId,
    mode: 'live',
    status: 'delivered',
    occurredAt: '2026-07-28T20:05:00Z',
    idempotencyKey: 'provider-read:SM1234567890',
  };
  await processOutboundClaim({
    claim: reconcileClaim,
    providers: providers({ delivery, mode: 'live' }),
    repository: repository(records),
  });
  const persistedReceipt = records[0]?.receipt as ProviderReceipt;
  assert(persistedReceipt.status === 'delivered');
  assert(persistedReceipt.idempotencyKey === reconcileClaim.idempotencyKey);
});

Deno.test('worker response exposes only safe receipt metadata', () => {
  assert(
    workerResponseSchema.safeParse({
      schemaVersion: 'storyops-post-service-worker-run-v2',
      activationMode: 'manual',
      trigger: 'manual',
      status: 'processed',
      workerId: 'a0000000-0000-4000-8000-000000000003',
      claimed: 1,
      empty: false,
      counts: { sandboxed: 1 },
      results: [
        {
          schemaVersion: 'storyops-post-service-worker-result-v1',
          followupId: CLAIM_IDENTITY.followupId,
          status: 'sandboxed',
          providerMode: 'sandbox',
          providerStatus: 'sandbox_recorded',
          externalDeliveryClaimed: false,
        },
      ],
      checkedAt: '2026-07-30T21:30:00.000Z',
    }).success,
  );
});

Deno.test('private worker request requires an explicit bounded trigger', () => {
  assert(
    workerRequestSchema.safeParse({
      companyId: CLAIM_IDENTITY.companyId,
      trigger: 'scheduled',
      batchSize: 25,
      leaseSeconds: 300,
    }).success,
  );
  assert(
    !workerRequestSchema.safeParse({
      trigger: 'scheduled',
      batchSize: 25,
      leaseSeconds: 300,
    }).success,
  );
  assert(!workerRequestSchema.safeParse({ batchSize: 10, leaseSeconds: 90 }).success);
  assert(
    !workerRequestSchema.safeParse({
      companyId: CLAIM_IDENTITY.companyId,
      trigger: 'scheduled',
      batchSize: 26,
      leaseSeconds: 90,
    }).success,
  );
});

Deno.test('private worker credential is dedicated, independent, and at least 32 bytes', () => {
  const serviceRoleKey = 'service-role-key-that-is-longer-than-thirty-two-bytes';
  const validWorkerToken = 'post-service-worker-token-that-is-long-enough';
  const peerWorkerToken = 'transactional-worker-token-that-is-long-enough';
  assert(
    new TextEncoder().encode(validWorkerToken).byteLength >= PRIVATE_WORKER_TOKEN_MINIMUM_BYTES,
  );

  const base = {
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    POST_SERVICE_WORKER_MODE: 'scheduled',
    TRANSACTIONAL_OUTBOUND_WORKER_TOKEN: peerWorkerToken,
  };
  assert(
    inspectPrivateWorkerConfiguration(
      { ...base, POST_SERVICE_WORKER_TOKEN: validWorkerToken },
      {
        label: 'post-service worker',
        tokenName: 'POST_SERVICE_WORKER_TOKEN',
        modeName: 'POST_SERVICE_WORKER_MODE',
        peerTokenNames: ['TRANSACTIONAL_OUTBOUND_WORKER_TOKEN'],
      },
    ).readiness === 'ready',
  );
  for (const [token, expectedStatus] of [
    ['too-short', 'too_short'],
    [` ${validWorkerToken}`, 'surrounding_whitespace'],
    [serviceRoleKey, 'service_role_reuse'],
    [peerWorkerToken, 'peer_worker_reuse'],
  ] as const) {
    const inspection = inspectPrivateWorkerConfiguration(
      { ...base, POST_SERVICE_WORKER_TOKEN: token },
      {
        label: 'post-service worker',
        tokenName: 'POST_SERVICE_WORKER_TOKEN',
        modeName: 'POST_SERVICE_WORKER_MODE',
        peerTokenNames: ['TRANSACTIONAL_OUTBOUND_WORKER_TOKEN'],
      },
    );
    assert(inspection.credentialStatus === expectedStatus);
    assert(inspection.readiness === 'blocked');
  }
});
