import type { CalendarProvider } from '../../../src/core/integrations/contracts.ts';
import { IntegrationError } from '../../../src/core/integrations/contracts.ts';
import { sha256TextHex } from '../../../src/core/integrations/webhooks.ts';
import type { SchedulingReconciliationClaim, SchedulingReconciliationResult } from './contracts.ts';

export interface SchedulingReconciliationRepository {
  complete(caseId: string, claimToken: string): Promise<SchedulingReconciliationResult>;
  fail(
    caseId: string,
    claimToken: string,
    errorCode: string,
    disposition: 'retry' | 'unknown' | 'manual_required',
    retryAfterSeconds: number,
  ): Promise<SchedulingReconciliationResult>;
}

export type ReconciliationBudget = {
  allowed: boolean;
  retryAfterSeconds: number;
};

function safeErrorCode(error: unknown): string {
  if (error instanceof IntegrationError) {
    const code = error.code
      .toUpperCase()
      .replace(/[^A-Z0-9_]/gu, '_')
      .slice(0, 120);
    return code || 'CALENDAR_PROVIDER_ERROR';
  }
  return 'CALENDAR_RECONCILIATION_INTERNAL_ERROR';
}

function providerFailureDisposition(error: unknown): 'unknown' | 'manual_required' {
  if (error instanceof IntegrationError && error.retryable) return 'unknown';
  return 'manual_required';
}

async function exactEventId(idempotencyKey: string): Promise<string> {
  return `storyops${(await sha256TextHex(idempotencyKey)).slice(0, 40)}`;
}

function cancellationRequest(claim: SchedulingReconciliationClaim) {
  if (!claim.eventEtag) {
    throw new IntegrationError(
      'Calendar cancellation requires a reconciled event etag.',
      'google_calendar',
      'RECONCILIATION_CONFLICT',
      false,
    );
  }
  return {
    calendarId: claim.calendarId,
    providerId: claim.eventId,
    etag: claim.eventEtag,
    idempotencyKey: claim.idempotencyKey,
  };
}

async function cancelExpiredReservation(
  calendar: CalendarProvider,
  claim: SchedulingReconciliationClaim,
): Promise<void> {
  await calendar.cancelBooking(cancellationRequest(claim));
}

async function reconcileUnknownCancellation(
  calendar: CalendarProvider,
  claim: SchedulingReconciliationClaim,
): Promise<void> {
  const state = await calendar.readBooking({
    calendarId: claim.calendarId,
    providerId: claim.eventId,
    idempotencyKey: claim.idempotencyKey,
    jobId: claim.jobId,
    window: claim.window,
  });
  if (
    state.provider !== 'google_calendar' ||
    state.mode !== 'live' ||
    state.providerId !== claim.eventId ||
    state.idempotencyKey !== claim.idempotencyKey ||
    !state.readBackConfirmed
  ) {
    throw new IntegrationError(
      'Calendar reconciliation returned an unbound provider state.',
      'google_calendar',
      'RECONCILIATION_CONFLICT',
      false,
    );
  }
  if (state.status === 'absent' || state.status === 'cancelled') return;
  if (!state.etag || (claim.eventEtag && state.etag !== claim.eventEtag)) {
    throw new IntegrationError(
      'Calendar reconciliation etag no longer matches the durable booking attempt.',
      'google_calendar',
      'RECONCILIATION_CONFLICT',
      false,
    );
  }
  await calendar.cancelBooking({
    calendarId: claim.calendarId,
    providerId: claim.eventId,
    etag: state.etag,
    idempotencyKey: claim.idempotencyKey,
  });
}

export async function processSchedulingReconciliationClaim(options: {
  claim: SchedulingReconciliationClaim;
  calendar: CalendarProvider;
  repository: SchedulingReconciliationRepository;
  consumeBudget: (claim: SchedulingReconciliationClaim) => Promise<ReconciliationBudget>;
}): Promise<SchedulingReconciliationResult> {
  const { claim, calendar, repository } = options;

  if (
    calendar.mode !== 'live' ||
    calendar.provider !== 'google_calendar' ||
    calendar.allowedCalendarIds.length !== 1 ||
    calendar.allowedCalendarIds[0] !== claim.calendarId
  ) {
    return repository.fail(
      claim.caseId,
      claim.claimToken,
      'CALENDAR_PROVIDER_CONFIGURATION_MISMATCH',
      'manual_required',
      60,
    );
  }

  if ((await exactEventId(claim.idempotencyKey)) !== claim.eventId) {
    return repository.fail(
      claim.caseId,
      claim.claimToken,
      'CALENDAR_IDENTITY_MISMATCH',
      'manual_required',
      60,
    );
  }

  let budget: ReconciliationBudget;
  try {
    budget = await options.consumeBudget(claim);
  } catch {
    return repository.fail(claim.caseId, claim.claimToken, 'RATE_LIMIT_UNAVAILABLE', 'retry', 60);
  }
  if (!budget.allowed) {
    return repository.fail(
      claim.caseId,
      claim.claimToken,
      'RATE_LIMITED',
      'retry',
      budget.retryAfterSeconds,
    );
  }

  try {
    if (claim.operation === 'reconcile') {
      await reconcileUnknownCancellation(calendar, claim);
    } else {
      await cancelExpiredReservation(calendar, claim);
    }
  } catch (error) {
    return repository.fail(
      claim.caseId,
      claim.claimToken,
      safeErrorCode(error),
      providerFailureDisposition(error),
      60,
    );
  }

  // If this persistence call fails, the durable lease is intentionally left
  // unresolved. Lease expiry converts it to provider_unknown, and the next
  // operation performs exact provider read-back before another conditional
  // cancellation. It must never be translated into a false success here.
  return repository.complete(claim.caseId, claim.claimToken);
}
