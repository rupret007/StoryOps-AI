import { resolveProviderWebhookActivation } from './activation.ts';
import { routeTwilioWebhook } from './routing.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test('provider callback ingress obeys each provider exact dual switch', () => {
  const cases = [
    ['twilio', 'TWILIO_MODE', 'TWILIO_LIVE_ENABLED'],
    ['stripe', 'STRIPE_MODE', 'STRIPE_LIVE_ENABLED'],
    ['email', 'EMAIL_MODE', 'EMAIL_LIVE_ENABLED'],
  ] as const;
  for (const [provider, modeName, flagName] of cases) {
    for (const environment of [
      { [modeName]: 'live', [flagName]: 'false' },
      { [modeName]: 'sandbox', [flagName]: 'true' },
      { [modeName]: 'disabled', [flagName]: 'true' },
      { [modeName]: 'invalid', [flagName]: 'true' },
      { [modeName]: 'live', [flagName]: 'invalid' },
    ]) {
      assert(
        resolveProviderWebhookActivation(environment, provider).runtimeMode === 'disabled',
        `${provider} missing, mismatched, disabled, or invalid switches must fail closed`,
      );
    }
    assert(
      resolveProviderWebhookActivation({ [modeName]: 'live', [flagName]: 'true' }, provider)
        .runtimeMode === 'live',
      `${provider} callbacks require both switches`,
    );
  }
});

Deno.test('a signed Twilio message body cannot be diverted into delivery reconciliation', () => {
  const inbound = routeTwilioWebhook({
    MessageSid: 'SMROUTE1001',
    MessageStatus: 'delivered',
    SmsStatus: 'received',
    From: '+12145550123',
    To: '+12145550999',
    Body: 'STOP',
  });
  assert(inbound.inboundMessage, 'message body must select intake routing');
  assert(inbound.inboundIntake, 'message body must select shared intake persistence');
  assert(
    inbound.reconciliationForm.MessageStatus === 'inbound_message',
    'delivery status must not select the legacy reconciliation branch',
  );

  const delivery = routeTwilioWebhook({
    MessageSid: 'SMROUTE1001',
    MessageStatus: 'delivered',
  });
  assert(!delivery.inboundMessage, 'status-only callbacks must remain delivery reconciliation');
  assert(!delivery.inboundIntake, 'outbound delivery callbacks must not select intake');
  assert(
    delivery.reconciliationForm.MessageStatus === 'delivered',
    'status-only callback must preserve provider status',
  );
});

Deno.test(
  'terminal inbound Twilio calls select missed-call intake without routing outbound calls',
  () => {
    for (const status of ['no-answer', 'busy', 'failed', 'canceled']) {
      const missed = routeTwilioWebhook({
        CallSid: 'CA123',
        Direction: 'inbound',
        CallStatus: status,
        From: '+12145550123',
        To: '+12145550999',
      });
      assert(missed.inboundMissedCall, `${status} must select missed-call recovery`);
      assert(missed.inboundIntake, `${status} must use the intake persistence boundary`);
    }

    const outbound = routeTwilioWebhook({
      CallSid: 'CA123',
      Direction: 'outbound-api',
      CallStatus: 'no-answer',
    });
    assert(!outbound.inboundMissedCall, 'outbound failed calls are delivery callbacks, not leads');
    assert(!outbound.inboundIntake, 'outbound callbacks cannot create owner recovery actions');
  },
);
