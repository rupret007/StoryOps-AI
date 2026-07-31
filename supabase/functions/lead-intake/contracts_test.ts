import { resolveLeadIntakeActivation } from './activation.ts';
import { LeadIntakePersistenceError, persistStoryOpsLeadIntake } from './persistence.ts';
import { normalizeTwilioLeadIntake } from '../../../src/core/intake/index.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test('lead intake requires the exact mode and independent live flag', () => {
  assert(
    resolveLeadIntakeActivation({}).runtimeMode === 'sandbox',
    'safe defaults should retain local sandbox intake',
  );
  for (const environment of [
    { LEAD_INTAKE_MODE: 'live', LEAD_INTAKE_LIVE_ENABLED: 'false' },
    { LEAD_INTAKE_MODE: 'sandbox', LEAD_INTAKE_LIVE_ENABLED: 'true' },
    { LEAD_INTAKE_MODE: 'disabled', LEAD_INTAKE_LIVE_ENABLED: 'true' },
    { LEAD_INTAKE_MODE: 'live', LEAD_INTAKE_LIVE_ENABLED: 'invalid' },
  ]) {
    assert(
      resolveLeadIntakeActivation(environment).runtimeMode === 'disabled',
      'a missing, mismatched, disabled, or invalid switch must fail closed',
    );
  }
  assert(
    resolveLeadIntakeActivation({
      LEAD_INTAKE_MODE: 'live',
      LEAD_INTAKE_LIVE_ENABLED: 'true',
    }).runtimeMode === 'live',
    'both switches should be required for live intake',
  );
});

Deno.test('trusted intake RPC receives START as unknown and one stable inbound event', async () => {
  const event = normalizeTwilioLeadIntake(
    {
      MessageSid: 'SMEDGE1001',
      SmsStatus: 'received',
      From: '+12145550123',
      To: '+12145550999',
      Body: 'START',
    },
    '10000000-0000-4000-8000-000000000001',
    new Date('2026-07-28T18:00:00.000Z'),
  );
  let captured: Record<string, unknown> | undefined;
  const receipt = await persistStoryOpsLeadIntake(
    {
      rpc(functionName, parameters) {
        assert(
          functionName === 'persist_storyops_lead_intake',
          'intake must use only the trusted transactional RPC',
        );
        captured = parameters;
        return Promise.resolve({
          data: {
            subjectType: 'customer',
            customerId: '10000000-0000-4000-8000-000000000101',
            leadId: null,
            threadId: '10000000-0000-4000-8000-000000000701',
            messageId: '10000000-0000-4000-8000-000000000702',
            consentRecordIds: [
              '10000000-0000-4000-8000-000000000703',
              '10000000-0000-4000-8000-000000000704',
            ],
            existingSubject: true,
            existingLead: false,
          },
          error: null,
        });
      },
    },
    event,
    '10000000-0000-4000-8000-000000000799',
    'a'.repeat(64),
    '10000000-0000-4000-8000-000000000798',
  );

  const intake = captured?.p_intake as Record<string, unknown> | undefined;
  const consent = intake?.consent as Array<Record<string, unknown>> | undefined;
  assert(
    event.providerEventId === 'SMEDGE1001:inbound_message',
    'event key must align with fan-out',
  );
  assert(event.consentSignal === 'opt_in', 'START must retain its review signal');
  assert(
    consent?.length === 2 && consent.every((record) => record.status === 'unknown'),
    'START must never reach persistence as granted',
  );
  assert(receipt.subjectType === 'customer', 'trusted receipt should retain customer resolution');
});

Deno.test('unresolved STOP is reported as failure after durable contact suppression', async () => {
  const event = normalizeTwilioLeadIntake(
    {
      MessageSid: 'SMEDGE1002',
      SmsStatus: 'received',
      From: '+12145550124',
      To: '+12145550999',
      Body: 'STOP',
    },
    '10000000-0000-4000-8000-000000000001',
    new Date('2026-07-28T18:00:00.000Z'),
  );
  let caught: unknown;
  try {
    await persistStoryOpsLeadIntake(
      {
        rpc() {
          return Promise.resolve({
            data: {
              subjectType: 'contact',
              customerId: null,
              leadId: null,
              threadId: null,
              messageId: null,
              consentRecordIds: [],
              existingSubject: true,
              existingLead: false,
              consentSignal: 'opt_out',
              contactSuppressed: true,
              resolutionStatus: 'ambiguous',
            },
            error: null,
          });
        },
      },
      event,
      '10000000-0000-4000-8000-000000000797',
      'b'.repeat(64),
      '10000000-0000-4000-8000-000000000796',
    );
  } catch (error) {
    caught = error;
  }
  assert(
    caught instanceof LeadIntakePersistenceError &&
      caught.code === 'INTAKE_SUBJECT_AMBIGUOUS' &&
      caught.status === 409,
    'Edge must fail the event while retaining the RPC-committed suppression',
  );
});

Deno.test('terminal Twilio voice statuses retain distinct retry-safe recovery keys', () => {
  const keys = ['no-answer', 'busy', 'failed', 'canceled'].map(
    (CallStatus) =>
      normalizeTwilioLeadIntake(
        {
          CallSid: 'CAEDGE1003',
          Direction: 'inbound',
          CallStatus,
          From: '+12145550125',
          To: '+12145550999',
        },
        '10000000-0000-4000-8000-000000000001',
        new Date('2026-07-28T18:00:00.000Z'),
      ).providerEventId,
  );
  assert(new Set(keys).size === 4, 'terminal statuses must not reuse the same provider event key');
  assert(
    keys.every((key) => /^CA[A-Za-z0-9]+$/u.test(key)),
    'missed-call event keys must remain inside the trusted intake RPC contract',
  );
});
