import type { JsonValue } from './idempotency.ts';
import type {
  DecimalString,
  DomainId,
  IdempotencyContext,
  ISODateTime,
  Money,
  PostalAddress,
} from './primitives.ts';

export type IntegrationProvider =
  | 'openai'
  | 'twilio'
  | 'email'
  | 'stripe'
  | 'google_calendar'
  | 'maps'
  | 'nws'
  | 'vroom'
  | 'signed_storage_targets'
  | 'quickbooks_export';

export type IntegrationMode = 'disabled' | 'sandbox' | 'live';

export interface IntegrationHealth {
  provider: IntegrationProvider;
  mode: IntegrationMode;
  status: 'healthy' | 'degraded' | 'misconfigured' | 'disabled';
  checkedAt: ISODateTime;
  message: string;
  capabilities: readonly string[];
}

export interface ProviderRequestContext {
  companyId: DomainId;
  actorId: DomainId | string;
  traceId: string;
  idempotency: IdempotencyContext;
}

export interface MessageDeliveryResult {
  providerMessageId: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  acceptedAt: ISODateTime;
}

export interface MessagingProvider {
  health(): Promise<IntegrationHealth>;
  sendSms(
    context: ProviderRequestContext,
    input: { to: string; from: string; body: string; consentProof: string },
  ): Promise<MessageDeliveryResult>;
  placeCall(
    context: ProviderRequestContext,
    input: { to: string; from: string; scriptVersion: string; callbackUrl: string },
  ): Promise<{ providerCallId: string; status: string }>;
}

export interface EmailProvider {
  health(): Promise<IntegrationHealth>;
  send(
    context: ProviderRequestContext,
    input: {
      to: readonly string[];
      replyTo?: string;
      subject: string;
      textBody: string;
      htmlBody?: string;
      consentProof?: string;
    },
  ): Promise<MessageDeliveryResult>;
}

export interface PaymentProvider {
  health(): Promise<IntegrationHealth>;
  createCheckout(
    context: ProviderRequestContext,
    input: {
      customerId: DomainId;
      invoiceId?: DomainId;
      description: string;
      amount: Money;
      successUrl: string;
      cancelUrl: string;
    },
  ): Promise<{ checkoutId: string; url: string; expiresAt: ISODateTime }>;
  refund(
    context: ProviderRequestContext,
    input: { providerPaymentId: string; amount: Money; approvalRequestId: DomainId },
  ): Promise<{ providerRefundId: string; status: string }>;
}

export interface CalendarProvider {
  health(): Promise<IntegrationHealth>;
  upsertVisit(
    context: ProviderRequestContext,
    input: {
      visitId: DomainId;
      title: string;
      startsAt: ISODateTime;
      endsAt: ISODateTime;
      address: PostalAddress;
      existingEventId?: string;
    },
  ): Promise<{ eventId: string; etag: string }>;
}

export interface GeocodingProvider {
  health(): Promise<IntegrationHealth>;
  geocode(
    context: ProviderRequestContext,
    address: PostalAddress,
  ): Promise<{
    latitude: DecimalString;
    longitude: DecimalString;
    confidence: DecimalString;
    normalizedAddress: PostalAddress;
  }>;
}

export interface WeatherProvider {
  health(): Promise<IntegrationHealth>;
  forecast(
    context: ProviderRequestContext,
    input: { latitude: DecimalString; longitude: DecimalString; startsAt: ISODateTime },
  ): Promise<JsonValue>;
}

export interface RoutingProvider {
  health(): Promise<IntegrationHealth>;
  optimize(
    context: ProviderRequestContext,
    input: {
      vehicles: readonly JsonValue[];
      jobs: readonly JsonValue[];
      options: JsonValue;
    },
  ): Promise<JsonValue>;
}

export interface ObjectStorageProvider {
  health(): Promise<IntegrationHealth>;
  createUpload(
    context: ProviderRequestContext,
    input: { bucket: string; objectPath: string; contentType: string; checksumSha256: string },
  ): Promise<{ uploadUrl: string; expiresAt: ISODateTime }>;
}

export interface AccountingExportProvider {
  health(): Promise<IntegrationHealth>;
  exportInvoices(
    context: ProviderRequestContext,
    input: { invoiceIds: readonly DomainId[]; format: 'quickbooks_iif' | 'csv' },
  ): Promise<{ objectPath: string; checksumSha256: string; exportedCount: number }>;
}

export interface AiModelProvider {
  health(): Promise<IntegrationHealth>;
  runStructured<TOutput extends JsonValue>(
    context: ProviderRequestContext,
    input: {
      agent: string;
      promptVersion: string;
      payload: JsonValue;
      outputSchemaName: string;
    },
  ): Promise<{ output: TOutput; model: string; providerTraceId?: string }>;
}
