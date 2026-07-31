import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Decimal } from 'decimal.js';
import type {
  AccountingExport,
  AccountingProvider,
  CalendarAvailability,
  CalendarAvailabilityRequest,
  CalendarBookingState,
  CalendarEntry,
  CalendarProvider,
  CancelCalendarEntryRequest,
  CreateCalendarEntryRequest,
  CreateCheckoutRequest,
  CreateInvoiceRequest,
  CreateVoiceCallRequest,
  EmailProvider,
  GeocodeResult,
  HealthCheckedIntegration,
  IntegrationHealth,
  IntegrationProbeEvidence,
  IntegrationSuite,
  MapsProvider,
  PaymentDocument,
  PaymentsProvider,
  ProviderReceipt,
  QuickBooksInvoiceExportRequest,
  ReadCalendarBookingRequest,
  RefundRequest,
  SendEmailRequest,
  SendSmsRequest,
  SmsProvider,
  StorageProvider,
  StorageTarget,
  UploadTargetRequest,
  VoiceProvider,
} from './contracts.ts';
import { IntegrationError } from './contracts.ts';
import {
  JOB_MEDIA_UPLOAD_MAX_BYTES,
  SUPABASE_SIGNED_UPLOAD_EXPIRES_SECONDS,
  assertStorageObjectKeyScope,
} from './storageSecurity.ts';
import { NwsWeatherProvider, VroomRoutingProvider } from './livePublic.ts';
import { createSandboxIntegrationSuite } from './sandbox.ts';
import { csvCell } from './csvSecurity.ts';
import { SupabaseLiveOutboundPolicy, type LiveOutboundPolicy } from './liveOutboundPolicy.ts';
import { positiveIntegerSetting } from './operationBudget.ts';
import {
  SupabaseStripeCustomerResolver,
  type StripeCustomerResolver,
} from './stripeCustomerResolver.ts';
import {
  SupabaseStripeBillingValidator,
  type StripeBillingValidator,
} from './stripeBillingValidator.ts';
import { resolveLiveProviderActivation } from './configuration.ts';
import { createDisabledIntegrationSuite } from './disabled.ts';
import { createIntegrationProbeEvidence } from './probeEvidence.ts';

export type ServerEnvironment = Readonly<Record<string, string | undefined>>;

type JsonRecord = Record<string, unknown>;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

function boundedSignal(signal?: AbortSignal, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function validateSecretBearingEndpoint(value: string, name: string): string {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new IntegrationError(
      `${name} must use HTTPS outside local development.`,
      'configuration',
      'INSECURE_PROVIDER_ENDPOINT',
      false,
    );
  }
  return url.toString();
}

function asRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntegrationError(
      'Provider returned an invalid object response.',
      'provider',
      'INVALID_RESPONSE',
      false,
    );
  }
  return value as JsonRecord;
}

function stringValue(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberValue(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function required(environment: ServerEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new IntegrationError(
      `Live integration is missing ${name}.`,
      'configuration',
      'NOT_CONFIGURED',
      false,
    );
  }
  return value;
}

async function jsonResponse(provider: string, url: string, init: RequestInit): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: boundedSignal(init.signal ?? undefined) });
  } catch (error) {
    throw new IntegrationError(
      `${provider} network request failed.`,
      provider,
      'NETWORK_ERROR',
      true,
      { cause: error },
    );
  }
  const body = await response.text();
  let parsed: unknown = {};
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { raw: body.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const detail = asRecord(parsed);
    const providerMessage =
      stringValue(detail, 'message') ??
      stringValue(asRecordOrEmpty(detail.error), 'message') ??
      `HTTP ${response.status}`;
    throw new IntegrationError(
      `${provider} rejected the request: ${providerMessage}`,
      provider,
      `HTTP_${response.status}`,
      response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status >= 500,
    );
  }
  return asRecord(parsed);
}

function asRecordOrEmpty(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function healthResult(
  provider: string,
  capability: string,
  started: number,
  status: IntegrationHealth['status'],
  message: string,
  requiredEnvironment: string[],
  probeEvidence?: IntegrationProbeEvidence,
): IntegrationHealth {
  return {
    provider,
    capability,
    mode: 'live',
    status,
    checkedAt: new Date().toISOString(),
    latencyMs: Math.round(performance.now() - started),
    message,
    requiredEnvironment,
    ...(probeEvidence ? { probeEvidence } : {}),
  };
}

class OpenAiHealthProvider implements HealthCheckedIntegration {
  readonly provider = 'openai';
  readonly capability = 'structured_ai';
  readonly mode = 'live' as const;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async health(signal?: AbortSignal): Promise<IntegrationHealth> {
    const started = performance.now();
    try {
      const response = await jsonResponse(
        this.provider,
        `https://api.openai.com/v1/models/${encodeURIComponent(this.model)}`,
        {
          headers: { authorization: `Bearer ${this.apiKey}` },
          signal,
        },
      );
      return healthResult(
        this.provider,
        this.capability,
        started,
        'healthy',
        `OpenAI model ${this.model} is reachable.`,
        ['OPENAI_API_KEY', 'OPENAI_MODEL'],
        await createIntegrationProbeEvidence('external_read', 'openai.model.retrieve', response),
      );
    } catch (error) {
      return healthResult(
        this.provider,
        this.capability,
        started,
        'down',
        error instanceof Error ? error.message : 'OpenAI health check failed.',
        ['OPENAI_API_KEY', 'OPENAI_MODEL'],
      );
    }
  }
}

type TwilioConfig = {
  accountSid: string;
  authToken: string;
  smsFrom: string;
  voiceFrom: string;
};

abstract class TwilioProvider {
  readonly mode = 'live' as const;
  protected readonly baseUrl: string;

  constructor(
    protected readonly config: TwilioConfig,
    protected readonly outboundPolicy: LiveOutboundPolicy,
  ) {
    this.baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}`;
  }

  protected headers(): HeadersInit {
    return {
      authorization: `Basic ${btoa(`${this.config.accountSid}:${this.config.authToken}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    };
  }

  protected receipt(record: JsonRecord, idempotencyKey: string): ProviderReceipt {
    const status = stringValue(record, 'status');
    const providerId = stringValue(record, 'sid');
    if (!providerId || !status) {
      throw new IntegrationError(
        'Twilio response omitted its authoritative SID or delivery status.',
        'twilio',
        'INVALID_RESPONSE',
        false,
      );
    }
    const knownStatuses = new Set([
      'accepted',
      'scheduled',
      'queued',
      'sending',
      'receiving',
      'initiated',
      'ringing',
      'in-progress',
      'sent',
      'delivered',
      'completed',
      'failed',
      'undelivered',
      'canceled',
      'busy',
      'no-answer',
    ]);
    if (!knownStatuses.has(status)) {
      throw new IntegrationError(
        `Twilio returned an unknown status "${status}".`,
        'twilio',
        'INVALID_RESPONSE',
        false,
      );
    }
    const mapped =
      status === 'delivered'
        ? 'delivered'
        : ['failed', 'undelivered', 'canceled', 'busy', 'no-answer'].includes(status)
          ? 'failed'
          : status === 'sent' || status === 'completed'
            ? 'sent'
            : 'queued';
    return {
      provider: 'twilio',
      providerId,
      mode: this.mode,
      status: mapped,
      occurredAt: stringValue(record, 'date_updated') ?? new Date().toISOString(),
      idempotencyKey,
    };
  }

  protected async check(capability: string, signal?: AbortSignal): Promise<IntegrationHealth> {
    const started = performance.now();
    try {
      const response = await jsonResponse('twilio', `${this.baseUrl}.json`, {
        headers: this.headers(),
        signal,
      });
      return healthResult(
        'twilio',
        capability,
        started,
        'healthy',
        'Twilio account API is reachable.',
        ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
        await createIntegrationProbeEvidence('external_read', 'twilio.account.retrieve', response),
      );
    } catch (error) {
      return healthResult(
        'twilio',
        capability,
        started,
        'down',
        error instanceof Error ? error.message : 'Twilio health check failed.',
        ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
      );
    }
  }
}

export class TwilioSmsProvider extends TwilioProvider implements SmsProvider {
  readonly provider = 'twilio';
  readonly capability = 'sms';

  health(signal?: AbortSignal) {
    return this.check(this.capability, signal);
  }

  async sendSms(request: SendSmsRequest, signal?: AbortSignal): Promise<ProviderReceipt> {
    await this.outboundPolicy.authorizeSms(request);
    const form = new URLSearchParams({
      To: request.to,
      From: this.config.smsFrom,
      Body: request.body,
      StatusCallback: '',
    });
    form.delete('StatusCallback');
    const result = await jsonResponse(this.provider, `${this.baseUrl}/Messages.json`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
      signal,
    });
    return this.receipt(result, request.idempotencyKey);
  }

  async getSmsDelivery(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<ProviderReceipt | undefined> {
    try {
      const result = await jsonResponse(
        this.provider,
        `${this.baseUrl}/Messages/${encodeURIComponent(providerId)}.json`,
        { headers: this.headers(), signal },
      );
      return this.receipt(result, `provider-read:${providerId}`);
    } catch (error) {
      if (error instanceof IntegrationError && error.code === 'HTTP_404') return undefined;
      throw error;
    }
  }
}

export class TwilioVoiceProvider extends TwilioProvider implements VoiceProvider {
  readonly provider = 'twilio';
  readonly capability = 'voice';

  health(signal?: AbortSignal) {
    return this.check(this.capability, signal);
  }

  async createCall(
    request: CreateVoiceCallRequest,
    signal?: AbortSignal,
  ): Promise<ProviderReceipt> {
    await this.outboundPolicy.authorizeVoice(request);
    const result = await jsonResponse(this.provider, `${this.baseUrl}/Calls.json`, {
      method: 'POST',
      headers: this.headers(),
      body: new URLSearchParams({
        To: request.to,
        From: this.config.voiceFrom,
        Url: request.twimlUrl,
      }),
      signal,
    });
    return this.receipt(result, request.idempotencyKey);
  }
}

export class HttpEmailProvider implements EmailProvider {
  readonly provider: string;
  readonly capability = 'email';
  readonly mode = 'live' as const;

  constructor(
    provider: string,
    private readonly endpoint: string,
    private readonly token: string,
    private readonly from: string,
    private readonly outboundPolicy: LiveOutboundPolicy,
    private readonly healthUrl?: string,
  ) {
    this.provider = provider;
    validateSecretBearingEndpoint(endpoint, 'EMAIL_PROVIDER_ENDPOINT');
    if (healthUrl) validateSecretBearingEndpoint(healthUrl, 'EMAIL_PROVIDER_HEALTH_URL');
  }

  private headers(idempotencyKey?: string): HeadersInit {
    return {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    };
  }

  async health(signal?: AbortSignal): Promise<IntegrationHealth> {
    const started = performance.now();
    if (!this.healthUrl) {
      return healthResult(
        this.provider,
        this.capability,
        started,
        'degraded',
        'Live email endpoint is configured; add EMAIL_PROVIDER_HEALTH_URL for an active probe.',
        ['EMAIL_PROVIDER_ENDPOINT', 'EMAIL_PROVIDER_TOKEN', 'EMAIL_FROM'],
      );
    }
    try {
      const response = await fetch(this.healthUrl, {
        headers: this.headers(),
        signal: boundedSignal(signal),
      });
      if (!response.ok) throw new Error(`Email health endpoint returned HTTP ${response.status}.`);
      return healthResult(
        this.provider,
        this.capability,
        started,
        'healthy',
        'Email provider health endpoint is reachable.',
        ['EMAIL_PROVIDER_ENDPOINT', 'EMAIL_PROVIDER_TOKEN', 'EMAIL_FROM'],
        await createIntegrationProbeEvidence('external_read', 'email.health.retrieve', {
          status: response.status,
        }),
      );
    } catch (error) {
      return healthResult(
        this.provider,
        this.capability,
        started,
        'down',
        error instanceof Error ? error.message : 'Email health check failed.',
        ['EMAIL_PROVIDER_ENDPOINT', 'EMAIL_PROVIDER_TOKEN', 'EMAIL_FROM'],
      );
    }
  }

  async sendEmail(request: SendEmailRequest, signal?: AbortSignal): Promise<ProviderReceipt> {
    await this.outboundPolicy.authorizeEmail(request);
    const result = await jsonResponse(this.provider, this.endpoint, {
      method: 'POST',
      headers: this.headers(request.idempotencyKey),
      body: JSON.stringify({
        from: this.from,
        to: request.to,
        replyTo: request.replyTo,
        subject: request.subject,
        text: request.text,
        html: request.html,
        category: request.category,
        consentSnapshotIds: request.consentSnapshotIds,
      }),
      signal,
    });
    const status = stringValue(result, 'status');
    const providerId = stringValue(result, 'id') ?? stringValue(result, 'messageId');
    if (!providerId || !status) {
      throw new IntegrationError(
        'Email provider response omitted its authoritative message ID or status.',
        this.provider,
        'INVALID_RESPONSE',
        false,
      );
    }
    if (!['accepted', 'queued', 'sent', 'delivered', 'failed'].includes(status)) {
      throw new IntegrationError(
        `Email provider returned an unknown status "${status}".`,
        this.provider,
        'INVALID_RESPONSE',
        false,
      );
    }
    return {
      provider: this.provider,
      providerId,
      mode: this.mode,
      status: status === 'delivered' ? 'delivered' : status === 'failed' ? 'failed' : 'accepted',
      occurredAt: new Date().toISOString(),
      idempotencyKey: request.idempotencyKey,
    };
  }

  async getEmailDelivery(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<ProviderReceipt | undefined> {
    try {
      const result = await jsonResponse(
        this.provider,
        `${this.endpoint.replace(/\/$/u, '')}/${encodeURIComponent(providerId)}`,
        { headers: this.headers(), signal },
      );
      const status = stringValue(result, 'status');
      if (!status || !['accepted', 'queued', 'sent', 'delivered', 'failed'].includes(status)) {
        throw new IntegrationError(
          'Email delivery lookup returned an unknown or missing status.',
          this.provider,
          'INVALID_RESPONSE',
          false,
        );
      }
      return {
        provider: this.provider,
        providerId,
        mode: this.mode,
        status:
          status === 'delivered'
            ? 'delivered'
            : status === 'failed'
              ? 'failed'
              : status === 'sent'
                ? 'sent'
                : 'accepted',
        occurredAt: stringValue(result, 'updatedAt') ?? new Date().toISOString(),
        idempotencyKey: `provider-read:${providerId}`,
      };
    } catch (error) {
      if (error instanceof IntegrationError && error.code === 'HTTP_404') return undefined;
      throw error;
    }
  }
}

type StripeConfig = {
  secretKey: string;
  checkoutSuccessUrl: string;
  checkoutCancelUrl: string;
  customerResolver: StripeCustomerResolver;
  billingValidator: StripeBillingValidator;
};

function validateProviderCallbackUrl(value: string, name: string): string {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new IntegrationError(
      `${name} must use HTTPS outside local development.`,
      'stripe',
      'INSECURE_CALLBACK_URL',
      false,
    );
  }
  return url.toString();
}

function stripeLineTotalCents(lines: CreateCheckoutRequest['lines']): number {
  return lines.reduce(
    (total, line) =>
      total +
      new Decimal(line.unitAmount.amount).mul(line.quantity).mul(100).toDecimalPlaces(0).toNumber(),
    0,
  );
}

export class StripePaymentsProvider implements PaymentsProvider {
  readonly provider = 'stripe';
  readonly capability = 'payments';
  readonly mode = 'live' as const;
  private readonly baseUrl = 'https://api.stripe.com/v1';

  constructor(private readonly config: StripeConfig) {
    validateProviderCallbackUrl(config.checkoutSuccessUrl, 'Stripe checkout success URL');
    validateProviderCallbackUrl(config.checkoutCancelUrl, 'Stripe checkout cancel URL');
  }

  private async request(
    path: string,
    params: URLSearchParams | undefined,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<JsonRecord> {
    return jsonResponse(this.provider, `${this.baseUrl}${path}`, {
      method: params ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${this.config.secretKey}`,
        ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: params,
      signal,
    });
  }

  private async resolveStripeCustomer(
    request: Pick<CreateCheckoutRequest, 'companyId' | 'customerId' | 'idempotencyKey'>,
    signal?: AbortSignal,
  ): Promise<string> {
    const identity = await this.config.customerResolver.resolve(
      request.companyId,
      request.customerId,
    );
    if (identity.stripeCustomerId) return identity.stripeCustomerId;
    const created = await this.request(
      '/customers',
      new URLSearchParams({
        email: identity.email,
        name: identity.name,
        'metadata[company_id]': identity.companyId,
        'metadata[storyops_customer_id]': identity.customerId,
      }),
      signal,
      `${request.idempotencyKey}:stripe-customer`,
    );
    const stripeCustomerId = stringValue(created, 'id');
    if (!stripeCustomerId?.startsWith('cus_')) {
      throw new IntegrationError(
        'Stripe customer creation omitted an authoritative customer ID.',
        this.provider,
        'INVALID_RESPONSE',
        false,
      );
    }
    await this.config.customerResolver.save({ ...identity, stripeCustomerId });
    return stripeCustomerId;
  }

  async health(signal?: AbortSignal): Promise<IntegrationHealth> {
    const started = performance.now();
    try {
      const response = await this.request('/balance', undefined, signal);
      return healthResult(
        this.provider,
        this.capability,
        started,
        'healthy',
        'Stripe balance endpoint is reachable.',
        ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
        await createIntegrationProbeEvidence('external_read', 'stripe.balance.retrieve', response),
      );
    } catch (error) {
      return healthResult(
        this.provider,
        this.capability,
        started,
        'down',
        error instanceof Error ? error.message : 'Stripe health check failed.',
        ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
      );
    }
  }

  async createCheckout(
    request: CreateCheckoutRequest,
    signal?: AbortSignal,
  ): Promise<PaymentDocument> {
    await this.config.billingValidator.validateCheckout(request);
    const stripeCustomerId = await this.resolveStripeCustomer(request, signal);
    const checkoutPurpose =
      request.checkoutPurpose === 'invoice_balance' ? 'invoice_balance' : 'quote_deposit';
    const params = new URLSearchParams({
      mode: 'payment',
      success_url: this.config.checkoutSuccessUrl,
      cancel_url: this.config.checkoutCancelUrl,
      client_reference_id: request.customerId,
      customer: stripeCustomerId,
      'metadata[company_id]': request.companyId,
      'metadata[quote_id]': request.quoteId,
      'metadata[checkout_purpose]': checkoutPurpose,
      'payment_intent_data[metadata][company_id]': request.companyId,
      'payment_intent_data[metadata][quote_id]': request.quoteId,
      'payment_intent_data[metadata][checkout_purpose]': checkoutPurpose,
    });
    if (request.checkoutAttempt !== undefined) {
      params.set('metadata[checkout_attempt]', String(request.checkoutAttempt));
      params.set(
        'payment_intent_data[metadata][checkout_attempt]',
        String(request.checkoutAttempt),
      );
    }
    if (request.checkoutPurpose === 'invoice_balance') {
      params.set('metadata[invoice_id]', request.invoiceId);
      params.set('metadata[invoice_version]', String(request.invoiceVersion));
      params.set('payment_intent_data[metadata][invoice_id]', request.invoiceId);
      params.set('payment_intent_data[metadata][invoice_version]', String(request.invoiceVersion));
    }
    request.lines.forEach((line, index) => {
      params.set(`line_items[${index}][quantity]`, String(line.quantity));
      params.set(`line_items[${index}][price_data][currency]`, 'usd');
      params.set(
        `line_items[${index}][price_data][unit_amount]`,
        new Decimal(line.unitAmount.amount).mul(100).toDecimalPlaces(0).toFixed(0),
      );
      params.set(`line_items[${index}][price_data][product_data][name]`, line.description);
    });
    const result = await this.request('/checkout/sessions', params, signal, request.idempotencyKey);
    const document = this.stripeDocument(
      result,
      'checkout',
      request.idempotencyKey,
      stripeLineTotalCents(request.lines),
    );
    if (!document.hostedUrl) {
      throw new IntegrationError(
        'Stripe checkout response omitted its hosted URL.',
        this.provider,
        'INVALID_RESPONSE',
        false,
      );
    }
    return document;
  }

  async createInvoice(
    request: CreateInvoiceRequest,
    signal?: AbortSignal,
  ): Promise<PaymentDocument> {
    await this.config.billingValidator.validateInvoice(request);
    const stripeCustomerId = await this.resolveStripeCustomer(request, signal);
    for (const [index, line] of request.lines.entries()) {
      await this.request(
        '/invoiceitems',
        new URLSearchParams({
          customer: stripeCustomerId,
          currency: 'usd',
          amount: new Decimal(line.unitAmount.amount)
            .mul(line.quantity)
            .mul(100)
            .toDecimalPlaces(0)
            .toFixed(0),
          description: line.description,
          'metadata[company_id]': request.companyId,
          'metadata[job_id]': request.jobId,
        }),
        signal,
        `${request.idempotencyKey}:line:${index}`,
      );
    }
    const daysUntilDue = Math.max(
      1,
      Math.ceil((new Date(request.dueDate).getTime() - Date.now()) / 86_400_000),
    );
    const result = await this.request(
      '/invoices',
      new URLSearchParams({
        customer: stripeCustomerId,
        collection_method: 'send_invoice',
        days_until_due: String(daysUntilDue),
        auto_advance: 'false',
        'metadata[company_id]': request.companyId,
        'metadata[job_id]': request.jobId,
      }),
      signal,
      request.idempotencyKey,
    );
    return this.stripeDocument(
      result,
      'invoice',
      request.idempotencyKey,
      stripeLineTotalCents(request.lines),
    );
  }

  async getPayment(providerId: string, signal?: AbortSignal): Promise<PaymentDocument | undefined> {
    const path = providerId.startsWith('cs_')
      ? `/checkout/sessions/${encodeURIComponent(providerId)}`
      : providerId.startsWith('in_')
        ? `/invoices/${encodeURIComponent(providerId)}`
        : providerId.startsWith('re_')
          ? `/refunds/${encodeURIComponent(providerId)}`
          : undefined;
    if (!path) {
      throw new IntegrationError(
        'Stripe provider ID has an unsupported prefix.',
        this.provider,
        'INVALID_PROVIDER_ID',
        false,
      );
    }
    try {
      const result = await this.request(path, undefined, signal);
      return this.stripeDocument(
        result,
        providerId.startsWith('cs_')
          ? 'checkout'
          : providerId.startsWith('in_')
            ? 'invoice'
            : 'refund',
        `provider-read:${providerId}`,
      );
    } catch (error) {
      if (error instanceof IntegrationError && error.code === 'HTTP_404') return undefined;
      throw error;
    }
  }

  async refund(request: RefundRequest, signal?: AbortSignal): Promise<PaymentDocument> {
    await this.config.billingValidator.validateRefund(request);
    const result = await this.request(
      '/refunds',
      new URLSearchParams({
        payment_intent: request.paymentProviderId,
        amount: new Decimal(request.amount.amount).mul(100).toDecimalPlaces(0).toFixed(0),
        reason: 'requested_by_customer',
        'metadata[company_id]': request.companyId,
        'metadata[approval_id]': request.approvalId,
        'metadata[storyops_reason]': request.reason,
      }),
      signal,
      request.idempotencyKey,
    );
    return this.stripeDocument(
      result,
      'refund',
      request.idempotencyKey,
      new Decimal(request.amount.amount).mul(100).toDecimalPlaces(0).toNumber(),
    );
  }

  private stripeDocument(
    result: JsonRecord,
    kind: PaymentDocument['kind'],
    idempotencyKey: string,
    expectedAmountCents?: number,
  ): PaymentDocument {
    const rawStatus = stringValue(result, 'status');
    const paymentStatus = stringValue(result, 'payment_status');
    const providerId = stringValue(result, 'id');
    const paid = paymentStatus === 'paid' || rawStatus === 'paid' || rawStatus === 'succeeded';
    const amount =
      numberValue(result, 'amount_total') ??
      numberValue(result, 'amount_due') ??
      numberValue(result, 'amount');
    if (!providerId || !rawStatus || amount === undefined || amount < 0) {
      throw new IntegrationError(
        'Stripe response omitted its authoritative ID, status, or amount.',
        this.provider,
        'INVALID_RESPONSE',
        false,
      );
    }
    if (
      expectedAmountCents !== undefined &&
      new Decimal(amount).toDecimalPlaces(0).toNumber() !== expectedAmountCents
    ) {
      throw new IntegrationError(
        'Stripe returned an amount that does not match the deterministic request total.',
        this.provider,
        'AMOUNT_MISMATCH',
        false,
      );
    }
    const recognizedStatuses = new Set([
      'open',
      'complete',
      'expired',
      'draft',
      'paid',
      'void',
      'uncollectible',
      'succeeded',
      'pending',
      'requires_action',
      'failed',
      'canceled',
    ]);
    if (!recognizedStatuses.has(rawStatus)) {
      throw new IntegrationError(
        `Stripe returned an unknown status "${rawStatus}".`,
        this.provider,
        'INVALID_RESPONSE',
        false,
      );
    }
    return {
      provider: this.provider,
      providerId,
      mode: this.mode,
      kind,
      status:
        kind === 'refund' && (rawStatus === 'succeeded' || rawStatus === 'paid')
          ? 'refunded'
          : paid
            ? 'paid'
            : rawStatus === 'void'
              ? 'void'
              : rawStatus === 'failed'
                ? 'failed'
                : rawStatus === 'draft'
                  ? 'draft'
                  : 'open',
      hostedUrl:
        stringValue(result, 'url') ?? stringValue(result, 'hosted_invoice_url') ?? undefined,
      total: {
        amount: new Decimal(amount).div(100).toFixed(2),
        currency: 'USD',
      },
      idempotencyKey,
    };
  }
}

type GoogleCalendarConfig = {
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  calendarId: string;
};

export class GoogleCalendarProvider implements CalendarProvider {
  readonly provider = 'google_calendar';
  readonly capability = 'calendar';
  readonly mode = 'live' as const;
  private readonly baseUrl = 'https://www.googleapis.com/calendar/v3';
  readonly allowedCalendarIds: readonly string[];
  private cachedAccessToken?: string;
  private cachedAccessTokenExpiresAt = 0;

  constructor(private readonly config: GoogleCalendarConfig) {
    if (!config.calendarId.trim()) {
      throw new IntegrationError(
        'Google Calendar requires an explicit allowed calendar ID.',
        this.provider,
        'NOT_CONFIGURED',
        false,
      );
    }
    const hasRefreshCredentials = Boolean(
      config.clientId?.trim() && config.clientSecret?.trim() && config.refreshToken?.trim(),
    );
    if (!config.accessToken?.trim() && !hasRefreshCredentials) {
      throw new IntegrationError(
        'Google Calendar requires either a refresh-token credential set or an access token.',
        this.provider,
        'NOT_CONFIGURED',
        false,
      );
    }
    this.allowedCalendarIds = [config.calendarId];
  }

  private hasRefreshCredentials(): boolean {
    return Boolean(
      this.config.clientId?.trim() &&
      this.config.clientSecret?.trim() &&
      this.config.refreshToken?.trim(),
    );
  }

  private requiredEnvironment(): string[] {
    return this.hasRefreshCredentials()
      ? [
          'GOOGLE_CALENDAR_CLIENT_ID',
          'GOOGLE_CALENDAR_CLIENT_SECRET',
          'GOOGLE_CALENDAR_REFRESH_TOKEN',
          'GOOGLE_CALENDAR_ID',
        ]
      : ['GOOGLE_CALENDAR_ACCESS_TOKEN', 'GOOGLE_CALENDAR_ID'];
  }

  private async token(forceRefresh = false): Promise<string> {
    if (!this.hasRefreshCredentials()) {
      return this.config.accessToken!.trim();
    }
    if (!forceRefresh && this.cachedAccessToken && Date.now() < this.cachedAccessTokenExpiresAt) {
      return this.cachedAccessToken;
    }
    const result = await jsonResponse(this.provider, 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId!.trim(),
        client_secret: this.config.clientSecret!.trim(),
        refresh_token: this.config.refreshToken!.trim(),
        grant_type: 'refresh_token',
      }).toString(),
    });
    const accessToken = stringValue(result, 'access_token');
    const expiresIn = numberValue(result, 'expires_in');
    if (!accessToken || !expiresIn || expiresIn <= 0) {
      throw new IntegrationError(
        'Google OAuth omitted a valid access token or expiry.',
        this.provider,
        'INVALID_RESPONSE',
        false,
      );
    }
    this.cachedAccessToken = accessToken;
    this.cachedAccessTokenExpiresAt = Date.now() + Math.max(30, expiresIn - 60) * 1_000;
    return accessToken;
  }

  private async request(
    url: string,
    init: RequestInit,
    retryAfterRefresh = true,
  ): Promise<JsonRecord> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await this.token()}`);
    headers.set('content-type', 'application/json');
    try {
      return await jsonResponse(this.provider, url, { ...init, headers });
    } catch (error) {
      if (
        retryAfterRefresh &&
        this.hasRefreshCredentials() &&
        error instanceof IntegrationError &&
        error.code === 'HTTP_401'
      ) {
        const retryHeaders = new Headers(init.headers);
        retryHeaders.set('authorization', `Bearer ${await this.token(true)}`);
        retryHeaders.set('content-type', 'application/json');
        return this.request(url, { ...init, headers: retryHeaders }, false);
      }
      throw error;
    }
  }

  async health(signal?: AbortSignal): Promise<IntegrationHealth> {
    const started = performance.now();
    try {
      const response = await this.request(`${this.baseUrl}/users/me/calendarList?maxResults=1`, {
        signal,
      });
      return healthResult(
        this.provider,
        this.capability,
        started,
        'healthy',
        'Google Calendar API is reachable.',
        this.requiredEnvironment(),
        await createIntegrationProbeEvidence(
          'external_read',
          'google_calendar.list.retrieve',
          response,
        ),
      );
    } catch (error) {
      return healthResult(
        this.provider,
        this.capability,
        started,
        'down',
        error instanceof Error ? error.message : 'Google Calendar health check failed.',
        this.requiredEnvironment(),
      );
    }
  }

  async readAvailability(
    request: CalendarAvailabilityRequest,
    signal?: AbortSignal,
  ): Promise<CalendarAvailability> {
    if (
      request.calendarIds.length !== this.allowedCalendarIds.length ||
      request.calendarIds.some((id) => !this.allowedCalendarIds.includes(id))
    ) {
      throw new IntegrationError(
        'Calendar availability is restricted to the configured StoryOps calendar.',
        this.provider,
        'CALENDAR_NOT_ALLOWED',
        false,
      );
    }
    const result = await this.request(`${this.baseUrl}/freeBusy`, {
      method: 'POST',
      body: JSON.stringify({
        timeMin: request.window.start,
        timeMax: request.window.end,
        timeZone: request.timeZone,
        items: request.calendarIds.map((id) => ({ id })),
      }),
      signal,
    });
    const calendars = asRecordOrEmpty(result.calendars);
    for (const calendarId of request.calendarIds) {
      const calendar = asRecordOrEmpty(calendars[calendarId]);
      if (Object.keys(calendar).length === 0 || Array.isArray(calendar.errors)) {
        throw new IntegrationError(
          `Google Calendar did not return authoritative availability for ${calendarId}.`,
          this.provider,
          'INCOMPLETE_RESPONSE',
          false,
        );
      }
    }
    const busy = Object.values(calendars)
      .flatMap((calendar) => {
        const items = asRecordOrEmpty(calendar).busy;
        return Array.isArray(items) ? items.map(asRecordOrEmpty) : [];
      })
      .map((item) => ({ start: stringValue(item, 'start'), end: stringValue(item, 'end') }))
      .filter(
        (item): item is { start: string; end: string } =>
          item.start !== undefined && item.end !== undefined,
      )
      .sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime());
    const free: CalendarAvailability['free'] = [];
    let cursor = new Date(request.window.start).getTime();
    const end = new Date(request.window.end).getTime();
    for (const interval of busy) {
      const busyStart = Math.max(cursor, new Date(interval.start).getTime());
      if (busyStart - cursor >= request.durationMinutes * 60_000) {
        free.push({
          start: new Date(cursor).toISOString(),
          end: new Date(busyStart).toISOString(),
        });
      }
      cursor = Math.max(cursor, new Date(interval.end).getTime());
    }
    if (end - cursor >= request.durationMinutes * 60_000) {
      free.push({ start: new Date(cursor).toISOString(), end: new Date(end).toISOString() });
    }
    return {
      provider: this.provider,
      mode: this.mode,
      window: request.window,
      free,
      sourceCalendarIds: request.calendarIds,
      observedAt: new Date().toISOString(),
    };
  }

  createHold(
    request: CreateCalendarEntryRequest & { expiresAt: string },
    signal?: AbortSignal,
  ): Promise<CalendarEntry> {
    const expiresAt = new Date(request.expiresAt).getTime();
    const now = Date.now();
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 24 * 60 * 60 * 1_000) {
      throw new IntegrationError(
        'Calendar holds must expire in the future and within 24 hours.',
        this.provider,
        'INVALID_HOLD_EXPIRY',
        false,
      );
    }
    return this.createEvent(request, 'hold', signal);
  }

  createBooking(request: CreateCalendarEntryRequest, signal?: AbortSignal): Promise<CalendarEntry> {
    return this.createEvent(request, 'booking', signal);
  }

  async readBooking(
    request: ReadCalendarBookingRequest,
    signal?: AbortSignal,
  ): Promise<CalendarBookingState> {
    if (!this.allowedCalendarIds.includes(request.calendarId)) {
      throw new IntegrationError(
        'Calendar reads are restricted to the configured StoryOps calendar.',
        this.provider,
        'CALENDAR_NOT_ALLOWED',
        false,
      );
    }
    const expectedEventId = `storyops${(await sha256(request.idempotencyKey)).slice(0, 40)}`;
    if (request.providerId !== expectedEventId) {
      throw new IntegrationError(
        'Calendar reconciliation requires the exact deterministic event identity.',
        this.provider,
        'INVALID_REQUEST',
        false,
      );
    }
    const url = `${this.baseUrl}/calendars/${encodeURIComponent(request.calendarId)}/events/${encodeURIComponent(request.providerId)}`;
    let existing: JsonRecord;
    try {
      existing = await this.request(url, { signal });
    } catch (error) {
      if (
        error instanceof IntegrationError &&
        (error.code === 'HTTP_404' || error.code === 'HTTP_410')
      ) {
        return {
          provider: this.provider,
          providerId: request.providerId,
          mode: this.mode,
          status: 'absent',
          idempotencyKey: request.idempotencyKey,
          observedAt: new Date().toISOString(),
          readBackConfirmed: true,
        };
      }
      throw error;
    }
    const privateProperties = asRecordOrEmpty(asRecordOrEmpty(existing.extendedProperties).private);
    const start = stringValue(asRecordOrEmpty(existing.start), 'dateTime');
    const end = stringValue(asRecordOrEmpty(existing.end), 'dateTime');
    const status = stringValue(existing, 'status');
    const etag = stringValue(existing, 'etag');
    if (
      stringValue(existing, 'id') !== request.providerId ||
      stringValue(privateProperties, 'storyops_idempotency_key') !== request.idempotencyKey ||
      stringValue(privateProperties, 'storyops_job_id') !== request.jobId ||
      stringValue(privateProperties, 'storyops_kind') !== 'booking' ||
      !start ||
      !end ||
      Date.parse(start) !== Date.parse(request.window.start) ||
      Date.parse(end) !== Date.parse(request.window.end) ||
      !etag ||
      (status !== 'confirmed' && status !== 'cancelled')
    ) {
      throw new IntegrationError(
        'Google Calendar booking read-back no longer matches the exact StoryOps event.',
        this.provider,
        'RECONCILIATION_CONFLICT',
        false,
      );
    }
    return {
      provider: this.provider,
      providerId: request.providerId,
      mode: this.mode,
      status,
      idempotencyKey: request.idempotencyKey,
      etag,
      observedAt: new Date().toISOString(),
      readBackConfirmed: true,
    };
  }

  async cancelBooking(request: CancelCalendarEntryRequest, signal?: AbortSignal): Promise<void> {
    if (!this.allowedCalendarIds.includes(request.calendarId)) {
      throw new IntegrationError(
        'Calendar writes are restricted to the configured StoryOps calendar.',
        this.provider,
        'CALENDAR_NOT_ALLOWED',
        false,
      );
    }
    const expectedEventId = `storyops${(await sha256(request.idempotencyKey)).slice(0, 40)}`;
    if (request.providerId !== expectedEventId || !request.etag.trim()) {
      throw new IntegrationError(
        'Calendar cancellation requires the exact deterministic event identity and etag.',
        this.provider,
        'INVALID_REQUEST',
        false,
      );
    }
    const url = `${this.baseUrl}/calendars/${encodeURIComponent(request.calendarId)}/events/${encodeURIComponent(request.providerId)}`;
    let existing: JsonRecord;
    try {
      existing = await this.request(url, { signal });
    } catch (error) {
      if (
        error instanceof IntegrationError &&
        (error.code === 'HTTP_404' || error.code === 'HTTP_410')
      ) {
        return;
      }
      throw error;
    }
    const privateProperties = asRecordOrEmpty(asRecordOrEmpty(existing.extendedProperties).private);
    if (
      stringValue(existing, 'id') !== request.providerId ||
      stringValue(privateProperties, 'storyops_idempotency_key') !== request.idempotencyKey
    ) {
      throw new IntegrationError(
        'Google Calendar cancellation read-back no longer matches the StoryOps event.',
        this.provider,
        'RECONCILIATION_CONFLICT',
        false,
      );
    }
    if (stringValue(existing, 'status') === 'cancelled') return;
    if (stringValue(existing, 'etag') !== request.etag) {
      throw new IntegrationError(
        'Google Calendar cancellation etag changed and requires reconciliation.',
        this.provider,
        'RECONCILIATION_CONFLICT',
        false,
      );
    }
    await this.request(url, {
      method: 'DELETE',
      headers: { 'if-match': request.etag },
      signal,
    });
  }

  private async createEvent(
    request: CreateCalendarEntryRequest & { expiresAt?: string },
    kind: CalendarEntry['kind'],
    signal?: AbortSignal,
  ): Promise<CalendarEntry> {
    if (!this.allowedCalendarIds.includes(request.calendarId)) {
      throw new IntegrationError(
        'Calendar writes are restricted to the configured StoryOps calendar.',
        this.provider,
        'CALENDAR_NOT_ALLOWED',
        false,
      );
    }
    const eventId = `storyops${(await sha256(request.idempotencyKey)).slice(0, 40)}`;
    const url = `${this.baseUrl}/calendars/${encodeURIComponent(request.calendarId)}/events`;
    try {
      await this.request(url, {
        method: 'POST',
        body: JSON.stringify({
          id: eventId,
          summary: request.title,
          status: 'confirmed',
          transparency: 'opaque',
          start: { dateTime: request.window.start, timeZone: request.timeZone },
          end: { dateTime: request.window.end, timeZone: request.timeZone },
          attendees: request.customerEmail ? [{ email: request.customerEmail }] : undefined,
          extendedProperties: {
            private: {
              storyops_job_id: request.jobId,
              storyops_idempotency_key: request.idempotencyKey,
              storyops_kind: kind,
              storyops_expires_at: request.expiresAt ?? '',
            },
          },
        }),
        signal,
      });
    } catch (error) {
      if (!(error instanceof IntegrationError) || error.code !== 'HTTP_409') throw error;
    }
    const result = await this.request(`${url}/${encodeURIComponent(eventId)}`, { signal });
    const returnedEventId = stringValue(result, 'id');
    const etag = stringValue(result, 'etag');
    const status = stringValue(result, 'status');
    const start = stringValue(asRecordOrEmpty(result.start), 'dateTime');
    const end = stringValue(asRecordOrEmpty(result.end), 'dateTime');
    const privateProperties = asRecordOrEmpty(asRecordOrEmpty(result.extendedProperties).private);
    const exactWindow =
      start !== undefined &&
      end !== undefined &&
      Date.parse(start) === Date.parse(request.window.start) &&
      Date.parse(end) === Date.parse(request.window.end);
    if (
      !returnedEventId ||
      returnedEventId !== eventId ||
      !etag ||
      status !== 'confirmed' ||
      !exactWindow ||
      stringValue(privateProperties, 'storyops_job_id') !== request.jobId ||
      stringValue(privateProperties, 'storyops_idempotency_key') !== request.idempotencyKey ||
      stringValue(privateProperties, 'storyops_kind') !== kind
    ) {
      throw new IntegrationError(
        'Google Calendar read-back did not reconcile the exact StoryOps event.',
        this.provider,
        'INVALID_RESPONSE',
        false,
      );
    }
    return {
      provider: this.provider,
      providerId: returnedEventId,
      mode: this.mode,
      kind,
      status: kind === 'hold' ? 'tentative' : 'confirmed',
      window: request.window,
      expiresAt: request.expiresAt,
      idempotencyKey: request.idempotencyKey,
      etag,
      reconciledAt: new Date().toISOString(),
      readBackConfirmed: true,
    };
  }
}

export class GoogleMapsProvider implements MapsProvider {
  readonly provider = 'google_maps';
  readonly capability = 'geocoding';
  readonly mode = 'live' as const;

  constructor(private readonly apiKey: string) {}

  async health(signal?: AbortSignal): Promise<IntegrationHealth> {
    const started = performance.now();
    try {
      const response = await this.geocode('Dallas, TX', signal);
      return healthResult(
        this.provider,
        this.capability,
        started,
        'healthy',
        'Google Geocoding API is reachable.',
        ['GOOGLE_MAPS_API_KEY'],
        await createIntegrationProbeEvidence(
          'external_read',
          'google_maps.geocode.retrieve',
          response,
        ),
      );
    } catch (error) {
      return healthResult(
        this.provider,
        this.capability,
        started,
        'down',
        error instanceof Error ? error.message : 'Maps health check failed.',
        ['GOOGLE_MAPS_API_KEY'],
      );
    }
  }

  async geocode(address: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
    const result = await jsonResponse(
      this.provider,
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${encodeURIComponent(this.apiKey)}`,
      { signal },
    );
    const status = stringValue(result, 'status');
    if (status !== 'OK' && status !== 'ZERO_RESULTS') {
      throw new IntegrationError(
        `Google Geocoding returned ${status ?? 'an unknown status'}.`,
        this.provider,
        status ?? 'INVALID_RESPONSE',
        status === 'OVER_QUERY_LIMIT' || status === 'UNKNOWN_ERROR',
      );
    }
    if (!Array.isArray(result.results)) {
      if (status === 'ZERO_RESULTS') return [];
      throw new IntegrationError(
        'Google Geocoding response omitted its results array.',
        this.provider,
        'INVALID_RESPONSE',
        false,
      );
    }
    const items = result.results.map(asRecordOrEmpty);
    return items.map((item) => {
      const geometry = asRecordOrEmpty(item.geometry);
      const location = asRecordOrEmpty(geometry.location);
      const locationType = stringValue(geometry, 'location_type');
      const formattedAddress = stringValue(item, 'formatted_address');
      const latitude = numberValue(location, 'lat');
      const longitude = numberValue(location, 'lng');
      if (
        !formattedAddress ||
        latitude === undefined ||
        longitude === undefined ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180 ||
        !locationType
      ) {
        throw new IntegrationError(
          'Google Geocoding returned an incomplete or invalid location result.',
          this.provider,
          'INVALID_RESPONSE',
          false,
        );
      }
      return {
        provider: this.provider,
        mode: this.mode,
        formattedAddress,
        coordinates: {
          latitude,
          longitude,
        },
        precision:
          locationType === 'ROOFTOP'
            ? 'rooftop'
            : locationType === 'RANGE_INTERPOLATED'
              ? 'street'
              : locationType === 'GEOMETRIC_CENTER'
                ? 'parcel'
                : 'unknown',
        confidence:
          locationType === 'ROOFTOP' ? 0.99 : locationType === 'RANGE_INTERPOLATED' ? 0.8 : 0.6,
        providerPlaceId: stringValue(item, 'place_id'),
        observedAt: new Date().toISOString(),
      };
    });
  }
}

export class SupabaseStorageProvider implements StorageProvider {
  readonly provider = 'supabase_signed_storage_targets';
  readonly capability = 'server_signed_targets';
  readonly mode = 'live' as const;
  private readonly client: SupabaseClient;

  constructor(
    url: string,
    serviceRoleKey: string,
    private readonly bucket: string,
  ) {
    if (bucket !== 'job-media') {
      throw new IntegrationError(
        'StoryOps V1 requires the private job-media bucket for both field evidence and signed targets.',
        'supabase_signed_storage_targets',
        'STORAGE_BUCKET_MISMATCH',
        false,
      );
    }
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async health(): Promise<IntegrationHealth> {
    const started = performance.now();
    const { data, error } = await this.client.storage.getBucket(this.bucket);
    return healthResult(
      this.provider,
      this.capability,
      started,
      error ? 'down' : 'healthy',
      error
        ? `Optional signed-target bucket check failed: ${error.message}`
        : `Optional signed-target bucket ${this.bucket} is reachable.`,
      ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STORAGE_BUCKET_JOB_PHOTOS'],
      error
        ? undefined
        : await createIntegrationProbeEvidence(
            'external_read',
            'supabase_storage.bucket.retrieve',
            data,
          ),
    );
  }

  async createUploadTarget(request: UploadTargetRequest): Promise<StorageTarget> {
    assertStorageObjectKeyScope(request.companyId, request.objectKey);
    if (
      request.maxBytes !== JOB_MEDIA_UPLOAD_MAX_BYTES ||
      request.expiresInSeconds !== SUPABASE_SIGNED_UPLOAD_EXPIRES_SECONDS
    ) {
      throw new IntegrationError(
        'Live job-media uploads must use the bucket-enforced 25 MiB limit and Supabase two-hour signed-upload lifetime.',
        this.provider,
        'UNENFORCEABLE_UPLOAD_CONSTRAINT',
        false,
      );
    }
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUploadUrl(request.objectKey, { upsert: false });
    if (error) {
      throw new IntegrationError(error.message, this.provider, 'SIGNED_UPLOAD_FAILED', true, {
        cause: error,
      });
    }
    return {
      provider: this.provider,
      mode: this.mode,
      objectKey: request.objectKey,
      signedUrl: data.signedUrl,
      expiresAt: new Date(Date.now() + request.expiresInSeconds * 1_000).toISOString(),
      method: 'PUT',
      requiredHeaders: { 'content-type': request.contentType },
      maximumBytes: JOB_MEDIA_UPLOAD_MAX_BYTES,
      idempotencyKey: request.idempotencyKey,
    };
  }

  async createDownloadTarget(
    companyId: string,
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<StorageTarget> {
    assertStorageObjectKeyScope(companyId, objectKey);
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(objectKey, expiresInSeconds, { download: false });
    if (error) {
      throw new IntegrationError(error.message, this.provider, 'SIGNED_DOWNLOAD_FAILED', true, {
        cause: error,
      });
    }
    return {
      provider: this.provider,
      mode: this.mode,
      objectKey,
      signedUrl: data.signedUrl,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1_000).toISOString(),
      method: 'GET',
      requiredHeaders: {},
      idempotencyKey: `download:${objectKey}:${expiresInSeconds}`,
    };
  }
}

export class QuickBooksCsvProvider implements AccountingProvider {
  readonly provider = 'quickbooks_export' as const;
  readonly capability = 'accounting_export';
  readonly mode = 'live' as const;

  async health(): Promise<IntegrationHealth> {
    return healthResult(
      this.provider,
      this.capability,
      performance.now(),
      'healthy',
      'QuickBooks CSV export is local, deterministic, and ready.',
      [],
      await createIntegrationProbeEvidence(
        'deterministic_local',
        'quickbooks_export.adapter.validate',
        { adapterVersion: 'storyops-quickbooks-csv-v1' },
      ),
    );
  }

  async exportInvoice(request: QuickBooksInvoiceExportRequest): Promise<AccountingExport> {
    const rows = [
      [
        'InvoiceNo',
        'Customer',
        'CustomerEmail',
        'InvoiceDate',
        'DueDate',
        'Description',
        'Quantity',
        'UnitAmount',
        'Tax',
      ],
      ...request.lines.map((line, index) => [
        request.invoiceNumber,
        request.customerName,
        request.customerEmail ?? '',
        request.issuedDate,
        request.dueDate,
        line.description,
        String(line.quantity),
        line.unitAmount.amount,
        index === 0 ? request.tax.amount : '0.00',
      ]),
    ];
    const content = `${rows.map((row) => row.map((value) => csvCell(value, true)).join(',')).join('\r\n')}\r\n`;
    return {
      provider: this.provider,
      mode: this.mode,
      fileName: `${request.invoiceNumber.replace(/[^a-z0-9_-]/giu, '_')}-quickbooks.csv`,
      mimeType: 'text/csv',
      content,
      sha256: await sha256(content),
      idempotencyKey: request.idempotencyKey,
    };
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Builds the server-only provider suite. Every live adapter is opt-in; missing
 * credentials fail during construction instead of silently falling back.
 */
export function createServerIntegrationSuite(environment: ServerEnvironment): IntegrationSuite {
  const suite = createSandboxIntegrationSuite();
  const disabled = createDisabledIntegrationSuite();
  let outboundPolicy: LiveOutboundPolicy | undefined;
  const getOutboundPolicy = () => {
    outboundPolicy ??= new SupabaseLiveOutboundPolicy(
      createClient(
        required(environment, 'SUPABASE_URL'),
        required(environment, 'SUPABASE_SERVICE_ROLE_KEY'),
        { auth: { persistSession: false, autoRefreshToken: false } },
      ),
      {
        companyPerMinute: positiveIntegerSetting(
          environment.OUTBOUND_MESSAGES_PER_COMPANY_PER_MINUTE,
          60,
          'OUTBOUND_MESSAGES_PER_COMPANY_PER_MINUTE',
        ),
        smsPerContactPerHour: positiveIntegerSetting(
          environment.OUTBOUND_SMS_PER_CONTACT_PER_HOUR,
          30,
          'OUTBOUND_SMS_PER_CONTACT_PER_HOUR',
        ),
        emailPerContactPerHour: positiveIntegerSetting(
          environment.OUTBOUND_EMAIL_PER_CONTACT_PER_HOUR,
          20,
          'OUTBOUND_EMAIL_PER_CONTACT_PER_HOUR',
        ),
        voicePerContactPerHour: positiveIntegerSetting(
          environment.OUTBOUND_VOICE_PER_CONTACT_PER_HOUR,
          5,
          'OUTBOUND_VOICE_PER_CONTACT_PER_HOUR',
        ),
      },
    );
    return outboundPolicy;
  };

  const openAiActivation = resolveLiveProviderActivation(
    environment,
    'OPENAI_LIVE_ENABLED',
    'OPENAI_MODE',
  );
  if (openAiActivation.runtimeMode === 'disabled') {
    suite.openai = disabled.openai;
  } else if (openAiActivation.enabled) {
    suite.openai = new OpenAiHealthProvider(
      required(environment, 'OPENAI_API_KEY'),
      required(environment, 'OPENAI_MODEL'),
    );
  }

  const twilioActivation = resolveLiveProviderActivation(
    environment,
    'TWILIO_LIVE_ENABLED',
    'TWILIO_MODE',
  );
  if (twilioActivation.runtimeMode === 'disabled') {
    suite.sms = disabled.sms;
    suite.voice = disabled.voice;
  } else if (twilioActivation.enabled) {
    required(environment, 'TWILIO_WEBHOOK_URL');
    required(environment, 'TWILIO_COMPANY_ID');
    const config: TwilioConfig = {
      accountSid: required(environment, 'TWILIO_ACCOUNT_SID'),
      authToken: required(environment, 'TWILIO_AUTH_TOKEN'),
      smsFrom: required(environment, 'TWILIO_SMS_FROM'),
      voiceFrom: required(environment, 'TWILIO_VOICE_FROM'),
    };
    suite.sms = new TwilioSmsProvider(config, getOutboundPolicy());
    suite.voice = new TwilioVoiceProvider(config, getOutboundPolicy());
  }

  const emailActivation = resolveLiveProviderActivation(
    environment,
    'EMAIL_LIVE_ENABLED',
    'EMAIL_MODE',
  );
  if (emailActivation.runtimeMode === 'disabled') {
    suite.email = disabled.email;
  } else if (emailActivation.enabled) {
    suite.email = new HttpEmailProvider(
      required(environment, 'EMAIL_PROVIDER'),
      required(environment, 'EMAIL_PROVIDER_ENDPOINT'),
      required(environment, 'EMAIL_PROVIDER_TOKEN'),
      required(environment, 'EMAIL_FROM'),
      getOutboundPolicy(),
      environment.EMAIL_PROVIDER_HEALTH_URL,
    );
  }

  const stripeActivation = resolveLiveProviderActivation(
    environment,
    'STRIPE_LIVE_ENABLED',
    'STRIPE_MODE',
  );
  if (stripeActivation.runtimeMode === 'disabled') {
    suite.payments = disabled.payments;
  } else if (stripeActivation.enabled) {
    const stripeServiceClient = createClient(
      required(environment, 'SUPABASE_URL'),
      required(environment, 'SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    suite.payments = new StripePaymentsProvider({
      secretKey: required(environment, 'STRIPE_SECRET_KEY'),
      checkoutSuccessUrl: required(environment, 'STRIPE_CHECKOUT_SUCCESS_URL'),
      checkoutCancelUrl: required(environment, 'STRIPE_CHECKOUT_CANCEL_URL'),
      customerResolver: new SupabaseStripeCustomerResolver(stripeServiceClient),
      billingValidator: new SupabaseStripeBillingValidator(stripeServiceClient),
    });
  }

  const calendarActivation = resolveLiveProviderActivation(
    environment,
    'GOOGLE_CALENDAR_LIVE_ENABLED',
    'GOOGLE_CALENDAR_MODE',
  );
  if (calendarActivation.runtimeMode === 'disabled') {
    suite.calendar = disabled.calendar;
  } else if (calendarActivation.enabled) {
    suite.calendar = new GoogleCalendarProvider({
      accessToken: environment.GOOGLE_CALENDAR_ACCESS_TOKEN,
      clientId: environment.GOOGLE_CALENDAR_CLIENT_ID,
      clientSecret: environment.GOOGLE_CALENDAR_CLIENT_SECRET,
      refreshToken: environment.GOOGLE_CALENDAR_REFRESH_TOKEN,
      calendarId: required(environment, 'GOOGLE_CALENDAR_ID'),
    });
  }

  const mapsActivation = resolveLiveProviderActivation(
    environment,
    'MAPS_LIVE_ENABLED',
    'MAPS_MODE',
  );
  if (mapsActivation.runtimeMode === 'disabled') {
    suite.maps = disabled.maps;
  } else if (mapsActivation.enabled) {
    suite.maps = new GoogleMapsProvider(required(environment, 'GOOGLE_MAPS_API_KEY'));
  }

  const weatherActivation = resolveLiveProviderActivation(
    environment,
    'NWS_LIVE_ENABLED',
    'WEATHER_MODE',
  );
  if (weatherActivation.runtimeMode === 'disabled') {
    suite.weather = disabled.weather;
  } else if (weatherActivation.enabled) {
    suite.weather = new NwsWeatherProvider(
      required(environment, 'NWS_USER_AGENT'),
      environment.NWS_API_BASE_URL,
    );
  }

  const routingActivation = resolveLiveProviderActivation(
    environment,
    'VROOM_LIVE_ENABLED',
    'ROUTING_MODE',
  );
  if (routingActivation.runtimeMode === 'disabled') {
    suite.routing = disabled.routing;
  } else if (routingActivation.enabled) {
    suite.routing = new VroomRoutingProvider({
      url: required(environment, 'VROOM_URL'),
      healthUrl: environment.VROOM_HEALTH_URL,
      authorization: environment.VROOM_AUTHORIZATION,
      requestTimeoutMs: positiveIntegerSetting(
        environment.VROOM_REQUEST_TIMEOUT_MS,
        10_000,
        'VROOM_REQUEST_TIMEOUT_MS',
      ),
    });
  }

  const storageActivation = resolveLiveProviderActivation(
    environment,
    'SIGNED_STORAGE_TARGETS_LIVE_ENABLED',
    'SIGNED_STORAGE_TARGETS_MODE',
  );
  if (storageActivation.runtimeMode === 'disabled') {
    suite.storage = disabled.storage;
  } else if (storageActivation.enabled) {
    suite.storage = new SupabaseStorageProvider(
      required(environment, 'SUPABASE_URL'),
      required(environment, 'SUPABASE_SERVICE_ROLE_KEY'),
      required(environment, 'STORAGE_BUCKET_JOB_PHOTOS'),
    );
  }

  const accountingActivation = resolveLiveProviderActivation(
    environment,
    'QUICKBOOKS_EXPORT_ENABLED',
    'QUICKBOOKS_MODE',
  );
  if (accountingActivation.runtimeMode === 'disabled') {
    suite.accounting = disabled.accounting;
  } else if (accountingActivation.enabled) {
    suite.accounting = new QuickBooksCsvProvider();
  }

  return suite;
}
