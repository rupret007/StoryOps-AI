import type { CalendarProvider } from '../../../src/core/integrations/contracts.ts';
import { IntegrationError } from '../../../src/core/integrations/contracts.ts';
import { sha256TextHex } from '../../../src/core/integrations/webhooks.ts';
import { inspectDedicatedWorkerCredential } from '../_shared/private-worker.ts';
import {
  resolveSchedulingReconciliationActivation,
  schedulingReconciliationClaimSchema,
  schedulingReconciliationRequestSchema,
  schedulingReconciliationRunSchema,
  type SchedulingReconciliationClaim,
  type SchedulingReconciliationResult,
} from './contracts.ts';
import {
  processSchedulingReconciliationClaim,
  type SchedulingReconciliationRepository,
} from './worker.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
}

const PROVIDER_IDEMPOTENCY_KEY = 'schedule:job-501:v3:calendar';
const EVENT_ID = `storyops${(await sha256TextHex(PROVIDER_IDEMPOTENCY_KEY)).slice(0, 40)}`;
const CLAIM: SchedulingReconciliationClaim = {
  schemaVersion: 'storyops-scheduling-reconciliation-claim-v1',
  caseId: 'a0000000-0000-4000-8000-000000000001',
  receiptId: 'a0000000-0000-4000-8000-000000000002',
  companyId: '10000000-0000-4000-8000-000000000001',
  jobId: '10000000-0000-4000-8000-000000000501',
  claimToken: 'a0000000-0000-4000-8000-000000000003',
  operation: 'cancel',
  attempt: 1,
  calendarId: 'operations@example.test',
  eventId: EVENT_ID,
  eventEtag: '"calendar-etag-v3"',
  idempotencyKey: PROVIDER_IDEMPOTENCY_KEY,
  window: {
    start: '2026-07-30T14:00:00.000Z',
    end: '2026-07-30T16:00:00.000Z',
  },
  receiptExpiresAt: '2026-07-29T14:10:00.000Z',
  leaseExpiresAt: '2026-07-29T14:12:00.000Z',
};

function result(
  status: SchedulingReconciliationResult['status'],
  errorCode?: string,
): SchedulingReconciliationResult {
  return {
    schemaVersion: 'storyops-scheduling-reconciliation-result-v1',
    caseId: CLAIM.caseId,
    receiptId: CLAIM.receiptId,
    companyId: CLAIM.companyId,
    jobId: CLAIM.jobId,
    status,
    attemptCount: CLAIM.attempt,
    ...(status === 'retry_wait' || status === 'provider_unknown'
      ? { nextAttemptAt: '2026-07-29T14:13:00.000Z' }
      : {}),
    ...(errorCode ? { errorCode } : {}),
    calendarCancellationConfirmed: status === 'cancelled',
    externalStateUnknown: status === 'provider_unknown',
    manualReviewRequired: status === 'manual_required',
  };
}

function repository(records: Array<Record<string, unknown>>): SchedulingReconciliationRepository {
  return {
    complete(caseId, claimToken) {
      records.push({ kind: 'complete', caseId, claimToken });
      return Promise.resolve(result('cancelled'));
    },
    fail(caseId, claimToken, errorCode, disposition, retryAfterSeconds) {
      records.push({
        kind: 'fail',
        caseId,
        claimToken,
        errorCode,
        disposition,
        retryAfterSeconds,
      });
      return Promise.resolve(
        result(
          disposition === 'retry'
            ? 'retry_wait'
            : disposition === 'unknown'
              ? 'provider_unknown'
              : 'manual_required',
          errorCode,
        ),
      );
    },
  };
}

function calendar(options: {
  calls: Array<Record<string, unknown>>;
  error?: Error;
  readStatus?: 'confirmed' | 'cancelled' | 'absent';
  mode?: 'live' | 'sandbox';
  calendarId?: string;
}): CalendarProvider {
  const mode = options.mode ?? 'live';
  return {
    provider: 'google_calendar',
    capability: 'calendar',
    mode,
    allowedCalendarIds: [options.calendarId ?? CLAIM.calendarId],
    health() {
      return Promise.reject(new Error('unused'));
    },
    readAvailability() {
      return Promise.reject(new Error('unused'));
    },
    createHold() {
      return Promise.reject(new Error('unused'));
    },
    createBooking() {
      return Promise.reject(new Error('unused'));
    },
    readBooking(request) {
      options.calls.push({ kind: 'read', request });
      return Promise.resolve({
        provider: 'google_calendar',
        providerId: request.providerId,
        mode,
        status: options.readStatus ?? 'confirmed',
        idempotencyKey: request.idempotencyKey,
        ...(options.readStatus === 'absent' ? {} : { etag: CLAIM.eventEtag }),
        observedAt: '2026-07-29T14:00:00.000Z',
        readBackConfirmed: true,
      });
    },
    cancelBooking(request) {
      options.calls.push({ kind: 'cancel', request });
      return options.error ? Promise.reject(options.error) : Promise.resolve();
    },
  };
}

Deno.test('reconciliation request and claim contracts are finite and bounded', () => {
  assert(
    schedulingReconciliationRequestSchema.safeParse({
      companyId: CLAIM.companyId,
    }).success,
  );
  assert(!schedulingReconciliationRequestSchema.safeParse({}).success);
  assert(
    !schedulingReconciliationRequestSchema.safeParse({
      companyId: CLAIM.companyId,
      batchSize: 26,
    }).success,
  );
  assert(schedulingReconciliationClaimSchema.safeParse(CLAIM).success);
  assert(
    !schedulingReconciliationClaimSchema.safeParse({
      ...CLAIM,
      customerEmail: 'customer@example.test',
    }).success,
  );
});

Deno.test('disabled or sandbox activation cannot enter the live worker path', () => {
  assert(
    resolveSchedulingReconciliationActivation({
      SCHEDULING_RECONCILIATION_MODE: 'sandbox',
      SCHEDULING_RECONCILIATION_LIVE_ENABLED: 'false',
    }).runtimeMode === 'sandbox',
  );
  assert(
    resolveSchedulingReconciliationActivation({
      SCHEDULING_RECONCILIATION_MODE: 'live',
      SCHEDULING_RECONCILIATION_LIVE_ENABLED: 'false',
    }).runtimeMode === 'disabled',
  );
  assert(
    schedulingReconciliationRunSchema.safeParse({
      schemaVersion: 'storyops-scheduling-reconciliation-run-v1',
      mode: 'sandbox',
      status: 'inactive',
      claimed: 0,
      empty: true,
      counts: {},
      results: [],
      message: 'No provider mutation was attempted.',
      checkedAt: '2026-07-29T14:00:00.000Z',
    }).success,
  );
});

Deno.test('scheduling reconciliation rejects shared privileged credentials', () => {
  const settings = {
    label: 'scheduling reconciliation worker',
    tokenName: 'SCHEDULING_RECONCILIATION_TOKEN',
    modeName: 'SCHEDULING_RECONCILIATION_MODE',
    peerTokenNames: [
      'POST_SERVICE_WORKER_TOKEN',
      'TRANSACTIONAL_OUTBOUND_WORKER_TOKEN',
      'SCOPE_PHOTO_CLEANUP_TOKEN',
    ],
  } as const;
  const serviceRoleKey = 'storyops-service-role-key-with-at-least-32-bytes';
  const peerToken = 'storyops-scope-cleanup-token-with-at-least-32-bytes';
  assert(
    inspectDedicatedWorkerCredential(
      {
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        SCHEDULING_RECONCILIATION_TOKEN: serviceRoleKey,
      },
      settings,
    ) === 'service_role_reuse',
  );
  assert(
    inspectDedicatedWorkerCredential(
      {
        SCHEDULING_RECONCILIATION_TOKEN: peerToken,
        SCOPE_PHOTO_CLEANUP_TOKEN: peerToken,
      },
      settings,
    ) === 'peer_worker_reuse',
  );
});

Deno.test(
  'expired receipt cleanup runs autonomously without a later scheduling request',
  async () => {
    const providerCalls: Array<Record<string, unknown>> = [];
    const records: Array<Record<string, unknown>> = [];
    const outcome = await processSchedulingReconciliationClaim({
      claim: CLAIM,
      calendar: calendar({ calls: providerCalls }),
      repository: repository(records),
      consumeBudget: () => Promise.resolve({ allowed: true, retryAfterSeconds: 60 }),
    });

    assert(outcome.status === 'cancelled');
    assert(outcome.calendarCancellationConfirmed);
    assert(providerCalls.length === 1);
    const providerRequest = providerCalls[0]?.request as Record<string, unknown>;
    assert(providerRequest.calendarId === CLAIM.calendarId);
    assert(providerRequest.providerId === CLAIM.eventId);
    assert(providerRequest.etag === CLAIM.eventEtag);
    assert(providerRequest.idempotencyKey === CLAIM.idempotencyKey);
    assert(records[0]?.kind === 'complete');
  },
);

Deno.test(
  'accepted-or-not timeout is quarantined as provider unknown and never reports success',
  async () => {
    const providerCalls: Array<Record<string, unknown>> = [];
    const records: Array<Record<string, unknown>> = [];
    const outcome = await processSchedulingReconciliationClaim({
      claim: CLAIM,
      calendar: calendar({
        calls: providerCalls,
        error: new IntegrationError(
          'Calendar cancellation timed out.',
          'google_calendar',
          'NETWORK_ERROR',
          true,
        ),
      }),
      repository: repository(records),
      consumeBudget: () => Promise.resolve({ allowed: true, retryAfterSeconds: 60 }),
    });

    assert(providerCalls.length === 1);
    assert(outcome.status === 'provider_unknown');
    assert(outcome.externalStateUnknown);
    assert(!outcome.calendarCancellationConfirmed);
    assert(records[0]?.kind === 'fail');
    assert(records[0]?.disposition === 'unknown');
    assert(records[0]?.errorCode === 'NETWORK_ERROR');
  },
);

Deno.test('identity mismatch fails closed before provider mutation', async () => {
  const providerCalls: Array<Record<string, unknown>> = [];
  const records: Array<Record<string, unknown>> = [];
  const outcome = await processSchedulingReconciliationClaim({
    claim: {
      ...CLAIM,
      eventId: `storyops${'f'.repeat(40)}`,
    },
    calendar: calendar({ calls: providerCalls }),
    repository: repository(records),
    consumeBudget: () => Promise.resolve({ allowed: true, retryAfterSeconds: 60 }),
  });
  assert(providerCalls.length === 0);
  assert(outcome.status === 'manual_required');
  assert(outcome.manualReviewRequired);
  assert(records[0]?.errorCode === 'CALENDAR_IDENTITY_MISMATCH');
});

Deno.test('rate limiting schedules a retry without provider mutation', async () => {
  const providerCalls: Array<Record<string, unknown>> = [];
  const records: Array<Record<string, unknown>> = [];
  const outcome = await processSchedulingReconciliationClaim({
    claim: CLAIM,
    calendar: calendar({ calls: providerCalls }),
    repository: repository(records),
    consumeBudget: () => Promise.resolve({ allowed: false, retryAfterSeconds: 300 }),
  });
  assert(providerCalls.length === 0);
  assert(outcome.status === 'retry_wait');
  assert(records[0]?.errorCode === 'RATE_LIMITED');
  assert(records[0]?.retryAfterSeconds === 300);
});

Deno.test('changed etag or provider identity requires manual reconciliation', async () => {
  const providerCalls: Array<Record<string, unknown>> = [];
  const records: Array<Record<string, unknown>> = [];
  const outcome = await processSchedulingReconciliationClaim({
    claim: {
      ...CLAIM,
      operation: 'reconcile',
      attempt: 2,
    },
    calendar: calendar({
      calls: providerCalls,
      error: new IntegrationError(
        'Event etag changed.',
        'google_calendar',
        'RECONCILIATION_CONFLICT',
        false,
      ),
    }),
    repository: repository(records),
    consumeBudget: () => Promise.resolve({ allowed: true, retryAfterSeconds: 60 }),
  });
  assert(providerCalls.length === 2);
  assert(outcome.status === 'manual_required');
  assert(records[0]?.disposition === 'manual_required');
  assert(records[0]?.errorCode === 'RECONCILIATION_CONFLICT');
});

Deno.test(
  'provider-unknown claim explicitly re-enters exact cancellation reconciliation',
  async () => {
    const providerCalls: Array<Record<string, unknown>> = [];
    const records: Array<Record<string, unknown>> = [];
    const outcome = await processSchedulingReconciliationClaim({
      claim: {
        ...CLAIM,
        operation: 'reconcile',
        attempt: 2,
      },
      calendar: calendar({ calls: providerCalls }),
      repository: repository(records),
      consumeBudget: () => Promise.resolve({ allowed: true, retryAfterSeconds: 60 }),
    });
    assert(providerCalls.length === 2);
    assert(outcome.status === 'cancelled');
    assert(outcome.calendarCancellationConfirmed);
    assert(records[0]?.kind === 'complete');
  },
);

Deno.test(
  'authoritative absence after an unknown provider call completes without another delete',
  async () => {
    const providerCalls: Array<Record<string, unknown>> = [];
    const records: Array<Record<string, unknown>> = [];
    const outcome = await processSchedulingReconciliationClaim({
      claim: {
        ...CLAIM,
        operation: 'reconcile',
        attempt: 2,
      },
      calendar: calendar({
        calls: providerCalls,
        readStatus: 'absent',
      }),
      repository: repository(records),
      consumeBudget: () => Promise.resolve({ allowed: true, retryAfterSeconds: 60 }),
    });
    assert(providerCalls.length === 1);
    assert(providerCalls[0]?.kind === 'read');
    assert(outcome.status === 'cancelled');
    assert(records[0]?.kind === 'complete');
  },
);
