import { classifyConsentKeyword, contactFingerprint } from './consent.ts';

type JsonObject = Record<string, unknown>;

export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'received';
export type ReconciledPaymentStatus =
  'pending' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded';

export type StripeReconciliation = {
  providerEventId: string;
  eventType: string;
  companyId: string;
  objectId: string;
  objectKind: 'checkout' | 'payment_intent' | 'invoice' | 'refund' | 'unsupported';
  action:
    | 'payment_pending'
    | 'payment_succeeded'
    | 'payment_failed'
    | 'invoice_open'
    | 'invoice_paid'
    | 'invoice_void'
    | 'invoice_uncollectible'
    | 'refund_pending'
    | 'refund_succeeded'
    | 'refund_failed'
    | 'ignore';
  quoteId?: string;
  jobId?: string;
  approvalId?: string;
  paymentIntentId?: string;
  amountCents?: number;
  amountPaidCents?: number;
  amountRemainingCents?: number;
  currency?: string;
  failureCode?: string;
  occurredAt: string;
  receipt: JsonObject;
};

export type DeliveryReconciliation = {
  provider: 'twilio' | 'email';
  providerEventId: string;
  eventType: string;
  companyId: string;
  providerMessageId: string;
  channel: 'sms' | 'voice' | 'email';
  deliveryStatus?: DeliveryStatus;
  consentSignal: 'opt_out' | 'opt_in' | 'none';
  contactFingerprint?: string;
  occurredAt: string;
  receipt: JsonObject;
};

export class ProviderReconciliationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ProviderReconciliationError';
    this.code = code;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function nestedObject(value: unknown, key: string): JsonObject | undefined {
  return asObject(asObject(value)?.[key]);
}

function requiredString(value: unknown, field: string, maxLength = 255): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new ProviderReconciliationError(
      `Verified provider event omitted a valid ${field}.`,
      'INVALID_PROVIDER_EVENT',
    );
  }
  return value;
}

function optionalString(value: unknown, maxLength = 255): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requiredUuid(value: unknown, field: string): string {
  const candidate = requiredString(value, field, 36);
  if (!uuidPattern.test(candidate)) {
    throw new ProviderReconciliationError(
      `Verified provider event has an invalid ${field}.`,
      'INVALID_COMPANY_SCOPE',
    );
  }
  return candidate;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const candidate = requiredString(value, field, 36);
  if (!uuidPattern.test(candidate)) {
    throw new ProviderReconciliationError(
      `Verified provider event has an invalid ${field}.`,
      'INVALID_REFERENCE',
    );
  }
  return candidate;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProviderReconciliationError(
      `Verified provider event has an invalid ${field}.`,
      'INVALID_AMOUNT',
    );
  }
  return value as number;
}

function providerTimestamp(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return new Date().toISOString();
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    const timestamp = new Date(value * 1_000);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const timestamp = new Date(value);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
  }
  throw new ProviderReconciliationError(
    'Verified provider event has an invalid timestamp.',
    'INVALID_TIMESTAMP',
  );
}

function stripeObjectKind(eventType: string): StripeReconciliation['objectKind'] {
  if (eventType.startsWith('checkout.session.')) return 'checkout';
  if (eventType.startsWith('payment_intent.')) return 'payment_intent';
  if (eventType.startsWith('invoice.')) return 'invoice';
  if (eventType.startsWith('refund.')) return 'refund';
  return 'unsupported';
}

function stripeAction(eventType: string, object: JsonObject): StripeReconciliation['action'] {
  switch (eventType) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return object.payment_status === 'paid' ? 'payment_succeeded' : 'payment_pending';
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled':
      return 'payment_failed';
    case 'payment_intent.processing':
      return 'payment_pending';
    case 'payment_intent.succeeded':
      return 'payment_succeeded';
    case 'invoice.finalized':
    case 'invoice.sent':
      return 'invoice_open';
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return 'invoice_paid';
    case 'invoice.payment_failed':
      return 'invoice_open';
    case 'invoice.voided':
      return 'invoice_void';
    case 'invoice.marked_uncollectible':
      return 'invoice_uncollectible';
    case 'refund.created':
      return object.status === 'succeeded' ? 'refund_succeeded' : 'refund_pending';
    case 'refund.updated':
      return object.status === 'succeeded'
        ? 'refund_succeeded'
        : object.status === 'failed' || object.status === 'canceled'
          ? 'refund_failed'
          : 'refund_pending';
    case 'refund.failed':
      return 'refund_failed';
    default:
      return 'ignore';
  }
}

function failureCode(object: JsonObject): string | undefined {
  const lastPaymentError = asObject(object.last_payment_error);
  const candidate =
    optionalString(lastPaymentError?.code, 120) ??
    optionalString(object.failure_reason, 120) ??
    optionalString(object.failure_code, 120);
  return candidate?.replace(/[^a-zA-Z0-9_.:-]/gu, '_').slice(0, 120);
}

/**
 * Parses only identifiers, statuses, integer provider amounts, and StoryOps
 * metadata. The returned receipt intentionally excludes customer, card,
 * address, body, email, and phone fields before durable storage.
 */
export function parseStripeReconciliation(payload: unknown): StripeReconciliation {
  const event = asObject(payload);
  if (!event) {
    throw new ProviderReconciliationError(
      'Stripe webhook payload must be an object.',
      'INVALID_PROVIDER_EVENT',
    );
  }
  const providerEventId = requiredString(event.id, 'event id');
  const eventType = requiredString(event.type, 'event type');
  const object = nestedObject(nestedObject(event, 'data'), 'object');
  if (!object) {
    throw new ProviderReconciliationError(
      'Stripe webhook payload omitted data.object.',
      'INVALID_PROVIDER_EVENT',
    );
  }
  const objectId = requiredString(object.id, 'object id');
  const metadata = asObject(object.metadata) ?? {};
  const companyId = requiredUuid(metadata.company_id, 'company_id');
  const quoteId = optionalUuid(metadata.quote_id, 'quote_id');
  const jobId = optionalUuid(metadata.job_id, 'job_id');
  const approvalId = optionalUuid(metadata.approval_id, 'approval_id');
  const objectKind = stripeObjectKind(eventType);
  const action = stripeAction(eventType, object);
  const paymentIntentId =
    optionalString(object.payment_intent) ?? optionalString(asObject(object.payment_intent)?.id);
  const amountCents = optionalNonNegativeInteger(
    object.amount_total ?? object.amount ?? object.amount_received ?? object.amount_due,
    'amount',
  );
  const amountPaidCents = optionalNonNegativeInteger(object.amount_paid, 'amount_paid');
  const amountRemainingCents = optionalNonNegativeInteger(
    object.amount_remaining,
    'amount_remaining',
  );
  const currency = optionalString(object.currency, 3)?.toLowerCase();
  const safeFailureCode = failureCode(object);
  if (currency && currency !== 'usd') {
    throw new ProviderReconciliationError(
      'StoryOps V1 accepts only USD Stripe reconciliation.',
      'UNSUPPORTED_CURRENCY',
    );
  }
  if (action !== 'ignore' && !currency) {
    throw new ProviderReconciliationError(
      'Stripe event omitted its authoritative currency.',
      'MISSING_CURRENCY',
    );
  }
  if (
    [
      'payment_pending',
      'payment_succeeded',
      'payment_failed',
      'refund_pending',
      'refund_succeeded',
      'refund_failed',
      'invoice_open',
      'invoice_paid',
      'invoice_void',
      'invoice_uncollectible',
    ].includes(action) &&
    amountCents === undefined
  ) {
    throw new ProviderReconciliationError(
      'Stripe payment event omitted its authoritative amount.',
      'MISSING_AMOUNT',
    );
  }

  if (action !== 'ignore' && objectKind === 'checkout' && !quoteId) {
    throw new ProviderReconciliationError(
      'StoryOps checkout event omitted quote_id metadata.',
      'MISSING_REFERENCE',
    );
  }
  if (action !== 'ignore' && objectKind === 'payment_intent' && !quoteId) {
    throw new ProviderReconciliationError(
      'StoryOps payment intent omitted quote_id metadata.',
      'MISSING_REFERENCE',
    );
  }
  if (action !== 'ignore' && objectKind === 'invoice' && !jobId) {
    throw new ProviderReconciliationError(
      'StoryOps invoice event omitted job_id metadata.',
      'MISSING_REFERENCE',
    );
  }
  if (action !== 'ignore' && objectKind === 'refund' && !approvalId) {
    throw new ProviderReconciliationError(
      'StoryOps refund event omitted approval_id metadata.',
      'MISSING_REFERENCE',
    );
  }

  const occurredAt = providerTimestamp(event.created);
  const receipt: JsonObject = {
    schemaVersion: 'storyops-provider-receipt-v1',
    provider: 'stripe',
    eventId: providerEventId,
    eventType,
    objectId,
    objectKind,
    action,
    companyId,
    occurredAt,
    ...(quoteId ? { quoteId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(approvalId ? { approvalId } : {}),
    ...(paymentIntentId ? { paymentIntentId } : {}),
    ...(amountCents !== undefined ? { amountCents } : {}),
    ...(amountPaidCents !== undefined ? { amountPaidCents } : {}),
    ...(amountRemainingCents !== undefined ? { amountRemainingCents } : {}),
    ...(currency ? { currency } : {}),
    ...(safeFailureCode ? { failureCode: safeFailureCode } : {}),
  };

  return {
    providerEventId,
    eventType,
    companyId,
    objectId,
    objectKind,
    action,
    quoteId,
    jobId,
    approvalId,
    paymentIntentId,
    amountCents,
    amountPaidCents,
    amountRemainingCents,
    currency,
    failureCode: safeFailureCode,
    occurredAt,
    receipt,
  };
}

function twilioDeliveryStatus(status: string): DeliveryStatus | undefined {
  const normalized = status.toLowerCase();
  if (
    ['accepted', 'scheduled', 'queued', 'sending', 'receiving', 'initiated', 'ringing'].includes(
      normalized,
    )
  ) {
    return 'queued';
  }
  if (['sent', 'in-progress'].includes(normalized)) return 'sent';
  if (['delivered', 'completed'].includes(normalized)) return 'delivered';
  if (['failed', 'undelivered', 'canceled', 'busy', 'no-answer'].includes(normalized)) {
    return 'failed';
  }
  return undefined;
}

export async function smsContactFingerprint(contact: string): Promise<string> {
  return contactFingerprint(contact, 'sms');
}

export async function parseTwilioReconciliation(
  form: Record<string, string>,
  configuredCompanyId: string,
): Promise<DeliveryReconciliation> {
  const companyId = requiredUuid(configuredCompanyId, 'company_id');
  const providerMessageId = requiredString(form.MessageSid ?? form.CallSid, 'message or call SID');
  const rawStatus =
    form.MessageStatus ?? form.CallStatus ?? (form.Body ? 'inbound_message' : undefined);
  const eventType = requiredString(rawStatus, 'delivery status');
  const channel = form.CallSid ? 'voice' : 'sms';
  const deliveryStatus = twilioDeliveryStatus(eventType);
  const consentSignal = form.Body ? classifyConsentKeyword(form.Body) : 'none';
  const contactFingerprint = form.Body
    ? await smsContactFingerprint(requiredString(form.From, 'inbound sender', 80))
    : undefined;
  const providerEventId = `${providerMessageId}:${eventType.toLowerCase()}`;
  const occurredAt = providerTimestamp(form.Timestamp ?? form.DateUpdated);
  const safeErrorCode = optionalString(form.ErrorCode, 40)?.replace(/[^0-9A-Za-z_.:-]/gu, '_');

  return {
    provider: 'twilio',
    providerEventId,
    eventType,
    companyId,
    providerMessageId,
    channel,
    deliveryStatus,
    consentSignal,
    contactFingerprint,
    occurredAt,
    receipt: {
      schemaVersion: 'storyops-provider-receipt-v1',
      provider: 'twilio',
      eventId: providerEventId,
      eventType,
      companyId,
      providerMessageId,
      channel,
      disposition: deliveryStatus ? 'delivery_update' : 'ignored',
      ...(deliveryStatus ? { deliveryStatus } : {}),
      ...(safeErrorCode ? { errorCode: safeErrorCode } : {}),
      consentSignal,
      ...(contactFingerprint ? { contactFingerprint } : {}),
      occurredAt,
    },
  };
}

export function parseEmailReconciliation(payload: unknown): DeliveryReconciliation {
  const event = asObject(payload);
  if (!event) {
    throw new ProviderReconciliationError(
      'Email webhook payload must be an object.',
      'INVALID_PROVIDER_EVENT',
    );
  }
  const metadata = asObject(event.metadata) ?? {};
  const providerEventId = requiredString(event.id ?? event.event_id, 'event id');
  const eventType = requiredString(event.type ?? event.event_type ?? event.status, 'event type');
  const companyId = requiredUuid(event.company_id ?? metadata.company_id, 'company_id');
  const providerMessageId = requiredString(
    event.message_id ?? event.provider_message_id,
    'message id',
  );
  const normalizedStatus = requiredString(
    event.status ?? eventType,
    'delivery status',
  ).toLowerCase();
  const deliveryStatus =
    normalizedStatus === 'delivered'
      ? 'delivered'
      : ['failed', 'bounced', 'rejected', 'complained'].includes(normalizedStatus)
        ? 'failed'
        : normalizedStatus === 'sent'
          ? 'sent'
          : ['accepted', 'queued', 'deferred'].includes(normalizedStatus)
            ? 'queued'
            : undefined;
  const occurredAt = providerTimestamp(event.occurred_at ?? event.timestamp);

  return {
    provider: 'email',
    providerEventId,
    eventType,
    companyId,
    providerMessageId,
    channel: 'email',
    deliveryStatus,
    consentSignal: 'none',
    occurredAt,
    receipt: {
      schemaVersion: 'storyops-provider-receipt-v1',
      provider: 'email',
      eventId: providerEventId,
      eventType,
      companyId,
      providerMessageId,
      channel: 'email',
      disposition: deliveryStatus ? 'delivery_update' : 'ignored',
      ...(deliveryStatus ? { deliveryStatus } : {}),
      occurredAt,
    },
  };
}

/**
 * Delivery callbacks can arrive out of order. Never downgrade a delivered
 * message, never resurrect a failed message with a queued/sent callback, and
 * allow a later authoritative delivery to recover a prior transient failure.
 */
export function nextDeliveryStatus(
  current: DeliveryStatus,
  incoming: DeliveryStatus,
): DeliveryStatus {
  if (current === 'received') return current;
  if (current === 'delivered') return current;
  if (incoming === 'delivered') return incoming;
  if (current === 'failed') return current;
  if (incoming === 'failed') return incoming;
  const rank: Record<'queued' | 'sent', number> = { queued: 0, sent: 1 };
  if (current in rank && incoming in rank) {
    return rank[incoming as 'queued' | 'sent'] > rank[current as 'queued' | 'sent']
      ? incoming
      : current;
  }
  return incoming;
}

/**
 * Provider status events also arrive out of order. Success is not downgraded by
 * a late pending/failure callback, while a later success can recover a prior
 * failure. Refund terminal states cannot be undone by a payment callback.
 */
export function nextPaymentStatus(
  current: ReconciledPaymentStatus,
  incoming: ReconciledPaymentStatus,
): ReconciledPaymentStatus {
  if (current === 'refunded' || current === 'partially_refunded') return current;
  if (incoming === 'refunded' || incoming === 'partially_refunded') return incoming;
  if (current === 'succeeded') return current;
  if (incoming === 'succeeded') return incoming;
  if (current === 'failed' && incoming === 'pending') return current;
  return incoming;
}

export function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new ProviderReconciliationError(
      'Provider cents must be a non-negative safe integer.',
      'INVALID_AMOUNT',
    );
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function decimalToCents(value: unknown): number {
  const candidate = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  if (!/^\d+(?:\.\d{1,2})?$/u.test(candidate)) {
    throw new ProviderReconciliationError(
      'Stored money value is not a non-negative two-decimal amount.',
      'INVALID_STORED_AMOUNT',
    );
  }
  const parts = candidate.split('.');
  const whole = parts[0] ?? '';
  const fraction = parts[1] ?? '';
  const cents = Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction.padEnd(2, '0'), 10);
  if (!Number.isSafeInteger(cents)) {
    throw new ProviderReconciliationError(
      'Stored money value exceeds the safe reconciliation range.',
      'INVALID_STORED_AMOUNT',
    );
  }
  return cents;
}
