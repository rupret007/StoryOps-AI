import { sha256Hex } from '../../../src/core/ai/approval.ts';
import { isLiveProviderEnabled } from '../../../src/core/integrations/configuration.ts';
import {
  ApprovedActionContractError,
  approvedActionRequestSchema,
  approvedToolAgent,
  assertExecutableApprovalState,
  parseAndRevalidatePersistedApproval,
  parseApprovedLeadPayload,
  parseApprovedRefundOutput,
  parseApprovedRefundPayload,
  safeExecutionErrorCode,
} from './contracts.ts';

const companyId = '10000000-0000-4000-8000-000000000001';
const approvalId = '10000000-0000-4000-8000-000000000801';
const runId = 'run-refund-1';
const actionId = 'action-refund-1';
const payload = {
  paymentProviderId: 'pi_authoritative_1',
  amount: { amount: '125.00', currency: 'USD' as const },
  reason: 'Customer-approved correction',
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test('approved Stripe refunds require both live activation switches', () => {
  assert(
    !isLiveProviderEnabled(
      { STRIPE_MODE: 'live', STRIPE_LIVE_ENABLED: 'false' },
      'STRIPE_LIVE_ENABLED',
      'STRIPE_MODE',
    ),
    'Mode-only activation must not enable a refund.',
  );
  assert(
    !isLiveProviderEnabled(
      { STRIPE_MODE: 'sandbox', STRIPE_LIVE_ENABLED: 'true' },
      'STRIPE_LIVE_ENABLED',
      'STRIPE_MODE',
    ),
    'Flag-only activation must not enable a refund.',
  );
  assert(
    isLiveProviderEnabled(
      { STRIPE_MODE: 'live', STRIPE_LIVE_ENABLED: 'true' },
      'STRIPE_LIVE_ENABLED',
      'STRIPE_MODE',
    ),
    'Both switches must enable the live refund boundary.',
  );
});

async function approvalRow(overrides: Record<string, unknown> = {}) {
  const payloadHash = await sha256Hex({
    runId,
    actionId,
    toolName: 'payments.refund',
    risk: 'high',
    payload,
  });
  return {
    id: approvalId,
    company_id: companyId,
    reason: 'refund',
    risk_level: 'high',
    status: 'approved',
    expires_at: '2030-01-01T00:00:00.000Z',
    consumed_at: null,
    action_type: 'payments.refund',
    action_payload: {
      exactPayload: payload,
      payloadHash,
      runId,
      actionId,
      toolName: 'payments.refund',
    },
    ...overrides,
  };
}

Deno.test('request contract accepts identities only and rejects a caller payload', () => {
  assert(
    approvedActionRequestSchema.safeParse({
      companyId,
      approvalId,
      idempotencyKey: 'refund-approval-801',
    }).success,
    'Expected the minimal request to be accepted.',
  );
  assert(
    !approvedActionRequestSchema.safeParse({
      companyId,
      approvalId,
      idempotencyKey: 'refund-approval-801',
      payload: { amount: '0.01' },
    }).success,
    'A caller-supplied action payload must be rejected.',
  );
});

Deno.test('persisted exact action is rehashed from server-loaded fields', async () => {
  const parsed = await parseAndRevalidatePersistedApproval(await approvalRow(), {
    companyId,
    approvalId,
  });
  assert(parsed.toolName === 'payments.refund', 'Expected the registered refund tool.');
  assert(parsed.payloadHash.length === 64, 'Expected a SHA-256 payload hash.');

  const changed = await approvalRow();
  changed.action_payload.exactPayload = {
    ...payload,
    amount: { amount: '126.00', currency: 'USD' as const },
  };
  let mismatch = false;
  try {
    await parseAndRevalidatePersistedApproval(changed, { companyId, approvalId });
  } catch (error) {
    mismatch = error instanceof ApprovedActionContractError && error.code === 'APPROVAL_MISMATCH';
  }
  assert(mismatch, 'A changed exact payload must fail hash revalidation.');
});

Deno.test('only tools with authoritative approved-action validators are executable', () => {
  assert(approvedToolAgent('payments.refund') === 'finance', 'Refunds must use finance.');
  assert(
    approvedToolAgent('records.create_lead') === 'intake',
    'Approved lead creation must use intake.',
  );
  assert(
    approvedToolAgent('records.update_lead') === 'intake',
    'Approved qualification must use intake.',
  );
  let denied = false;
  try {
    approvedToolAgent('legal.send_message');
  } catch (error) {
    denied = error instanceof ApprovedActionContractError && error.code === 'UNSUPPORTED_TOOL';
  }
  assert(denied, 'An approved legal message must stay denied without a validator.');
});

Deno.test('approved lead payloads reuse the exact strict server tool contracts', () => {
  const create = parseApprovedLeadPayload('records.create_lead', {
    source: 'web',
    displayName: 'Reviewed lead',
    requestedServices: ['gutter-cleaning'],
    preferredContactChannel: 'email',
  });
  assert('displayName' in create && create.displayName === 'Reviewed lead', 'Create was rejected.');
  const update = parseApprovedLeadPayload('records.update_lead', {
    leadId: '20000000-0000-4000-8000-000000000001',
    expectedVersion: 2,
    status: 'unqualified',
    disqualificationReason: 'Outside the configured service area.',
  });
  assert('status' in update && update.status === 'unqualified', 'Update was rejected.');
  for (const invalid of [
    {
      toolName: 'records.create_lead' as const,
      payload: {
        source: 'web',
        displayName: 'Unsafe lead',
        requestedServices: ['gutter-cleaning'],
        paymentStatus: 'paid',
      },
    },
    {
      toolName: 'records.update_lead' as const,
      payload: {
        leadId: '20000000-0000-4000-8000-000000000001',
        expectedVersion: 2,
        status: 'unqualified',
      },
    },
  ]) {
    let rejected = false;
    try {
      parseApprovedLeadPayload(invalid.toolName, invalid.payload);
    } catch {
      rejected = true;
    }
    assert(rejected, 'Expanded or incomplete approved lead payload was accepted.');
  }
});

Deno.test('refund payload is strict, decimal, positive, and bounded', () => {
  assert(
    parseApprovedRefundPayload(payload).amount.amount === '125.00',
    'Expected an exact decimal refund.',
  );
  for (const invalid of [
    { ...payload, amount: { amount: '125', currency: 'USD' } },
    { ...payload, amount: { amount: '0.00', currency: 'USD' } },
    { ...payload, customerId: 'caller-fact' },
  ]) {
    let rejected = false;
    try {
      parseApprovedRefundPayload(invalid);
    } catch {
      rejected = true;
    }
    assert(rejected, 'Malformed or expanded payload must be rejected.');
  }
});

Deno.test('provider output must echo the server key and approved amount', () => {
  const providerIdempotencyKey = `storyops-approved-${'a'.repeat(64)}`;
  const output = {
    provider: 'stripe',
    providerId: 're_sandbox_authoritative',
    mode: 'sandbox',
    kind: 'refund',
    status: 'refunded',
    total: payload.amount,
    idempotencyKey: providerIdempotencyKey,
  };
  assert(
    parseApprovedRefundOutput(output, {
      payload,
      providerIdempotencyKey,
    }).providerId === output.providerId,
    'Expected a matching provider receipt.',
  );
  let rejected = false;
  try {
    parseApprovedRefundOutput(
      { ...output, idempotencyKey: 'caller-controlled-key-that-is-long-enough' },
      { payload, providerIdempotencyKey },
    );
  } catch {
    rejected = true;
  }
  assert(rejected, 'A provider receipt with another key must be rejected.');
});

Deno.test('state guard rejects pending, rejected, expired, and consumed approvals', async () => {
  const base = await parseAndRevalidatePersistedApproval(await approvalRow(), {
    companyId,
    approvalId,
  });
  assertExecutableApprovalState(base, new Date('2029-01-01T00:00:00.000Z'));
  const cases = [
    { ...base, status: 'pending' as const },
    { ...base, status: 'rejected' as const },
    { ...base, expiresAt: '2028-01-01T00:00:00.000Z' },
    { ...base, consumedAt: '2028-01-01T00:00:00.000Z' },
  ];
  for (const value of cases) {
    let rejected = false;
    try {
      assertExecutableApprovalState(value, new Date('2029-01-01T00:00:00.000Z'));
    } catch {
      rejected = true;
    }
    assert(rejected, 'A non-executable approval state must be rejected.');
  }
  assert(
    safeExecutionErrorCode({ providerCode: 'http 409/payment' }) === 'HTTP_409_PAYMENT',
    'Failure codes must be normalized before persistence.',
  );
});
