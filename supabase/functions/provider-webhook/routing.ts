export type TwilioWebhookRouting = Readonly<{
  inboundMessage: boolean;
  inboundMissedCall: boolean;
  inboundIntake: boolean;
  reconciliationForm: Record<string, string>;
}>;

const missedCallStatuses = new Set(['no-answer', 'busy', 'failed', 'canceled']);

/**
 * A signed Twilio message body is intake, never a delivery callback. Force the
 * reconciliation event key to the shared inbound key so an incidental status
 * field cannot route STOP/START through the legacy reconciliation branch.
 */
export function routeTwilioWebhook(form: Record<string, string>): TwilioWebhookRouting {
  const inboundMessage = Boolean(form.MessageSid?.trim() && form.Body?.trim());
  const inboundMissedCall = Boolean(
    form.CallSid?.trim() &&
    form.Direction?.trim().toLowerCase().startsWith('inbound') &&
    missedCallStatuses.has(form.CallStatus?.trim().toLowerCase() ?? ''),
  );
  return {
    inboundMessage,
    inboundMissedCall,
    inboundIntake: inboundMessage || inboundMissedCall,
    reconciliationForm: inboundMessage ? { ...form, MessageStatus: 'inbound_message' } : form,
  };
}
