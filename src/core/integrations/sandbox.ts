import { Decimal } from 'decimal.js';
import { sha256Hex } from '../ai/approval.ts';
import { assertContactAllowed, type ConsentStore } from './consent.ts';
import type {
  AccountingExport,
  AccountingProvider,
  CalendarAvailability,
  CalendarAvailabilityRequest,
  CalendarBookingState,
  CalendarEntry,
  CalendarProvider,
  CancelCalendarEntryRequest,
  CheckoutLine,
  CreateCalendarEntryRequest,
  CreateCheckoutRequest,
  CreateInvoiceRequest,
  CreateVoiceCallRequest,
  EmailProvider,
  GeocodeResult,
  IntegrationHealth,
  IntegrationMode,
  IntegrationSuite,
  MapsProvider,
  PaymentDocument,
  PaymentsProvider,
  ProviderMoney,
  ProviderReceipt,
  QuickBooksInvoiceExportRequest,
  ReadCalendarBookingRequest,
  RefundRequest,
  RoutePlan,
  RoutingProvider,
  RoutingRequest,
  SendEmailRequest,
  SendSmsRequest,
  SmsProvider,
  StorageProvider,
  StorageTarget,
  UploadTargetRequest,
  VoiceProvider,
  WeatherForecast,
  WeatherForecastRequest,
  WeatherProvider,
} from './contracts.ts';
import { IntegrationError } from './contracts.ts';
import {
  JOB_MEDIA_UPLOAD_MAX_BYTES,
  SUPABASE_SIGNED_UPLOAD_EXPIRES_SECONDS,
  assertStorageObjectKeyScope,
} from './storageSecurity.ts';
import type { RateLimiter } from './rateLimit.ts';
import { InMemorySlidingWindowRateLimiter } from './rateLimit.ts';
import { csvCell } from './csvSecurity.ts';

type SandboxOptions = {
  consent?: ConsentStore;
  outboundRateLimiter?: RateLimiter;
  now?: () => Date;
};

class SandboxIdempotency {
  private readonly records = new Map<string, { requestHash: string; response: unknown }>();

  async run<T>(
    namespace: string,
    idempotencyKey: string,
    request: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!idempotencyKey) {
      throw new IntegrationError(
        'An idempotency key is required.',
        namespace,
        'MISSING_IDEMPOTENCY_KEY',
        false,
      );
    }
    const key = `${namespace}:${idempotencyKey}`;
    const requestHash = await sha256Hex(request);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new IntegrationError(
          'Idempotency key was reused with a different request.',
          namespace,
          'IDEMPOTENCY_CONFLICT',
          false,
        );
      }
      return structuredClone(existing.response) as T;
    }
    const response = await operation();
    this.records.set(key, {
      requestHash,
      response: structuredClone(response),
    });
    return response;
  }
}

abstract class SandboxProvider {
  readonly mode: IntegrationMode = 'sandbox';
  abstract readonly provider: string;
  abstract readonly capability: string;
  protected readonly idempotency = new SandboxIdempotency();
  protected readonly now: () => Date;

  constructor(options: SandboxOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async health(): Promise<IntegrationHealth> {
    return {
      provider: this.provider,
      capability: this.capability,
      mode: this.mode,
      status: 'healthy',
      checkedAt: this.now().toISOString(),
      latencyMs: 0,
      message: 'Sandbox provider is ready; no external credentials or network calls are used.',
      requiredEnvironment: [],
    };
  }
}

export class SandboxOpenAiHealth extends SandboxProvider {
  readonly provider = 'openai';
  readonly capability = 'structured_ai';
}

export class SandboxSmsProvider extends SandboxProvider implements SmsProvider {
  readonly provider = 'twilio';
  readonly capability = 'sms';
  private readonly deliveries = new Map<string, ProviderReceipt>();
  private readonly consent?: ConsentStore;
  private readonly limiter: RateLimiter;

  constructor(options: SandboxOptions = {}) {
    super(options);
    this.consent = options.consent;
    this.limiter = options.outboundRateLimiter ?? new InMemorySlidingWindowRateLimiter(30, 60_000);
  }

  async sendSms(request: SendSmsRequest): Promise<ProviderReceipt> {
    if (request.body.length === 0 || request.body.length > 1_600) {
      throw new IntegrationError(
        'SMS body must contain 1–1,600 characters.',
        this.provider,
        'INVALID_MESSAGE',
        false,
      );
    }
    if (this.consent) {
      const consent = await assertContactAllowed({
        store: this.consent,
        contact: request.to,
        channel: 'sms',
        category: request.category,
      });
      if (consent.id !== request.consentSnapshotId) {
        throw new IntegrationError(
          'Consent changed after this message was prepared.',
          this.provider,
          'STALE_CONSENT',
          false,
        );
      }
    }
    const rateLimit = await this.limiter.consume(`sms:${request.to}`, this.now());
    if (!rateLimit.allowed) {
      throw new IntegrationError(
        `SMS rate limit exceeded until ${rateLimit.resetAt}.`,
        this.provider,
        'RATE_LIMITED',
        true,
      );
    }

    return this.idempotency.run('sandbox-twilio-sms', request.idempotencyKey, request, async () => {
      const receipt: ProviderReceipt = {
        provider: this.provider,
        providerId: `SM_SANDBOX_${(await sha256Hex(request)).slice(0, 20)}`,
        mode: this.mode,
        status: 'delivered',
        occurredAt: this.now().toISOString(),
        idempotencyKey: request.idempotencyKey,
      };
      this.deliveries.set(receipt.providerId, receipt);
      return receipt;
    });
  }

  async getSmsDelivery(providerId: string): Promise<ProviderReceipt | undefined> {
    return this.deliveries.get(providerId);
  }
}

export class SandboxVoiceProvider extends SandboxProvider implements VoiceProvider {
  readonly provider = 'twilio';
  readonly capability = 'voice';
  private readonly consent?: ConsentStore;

  constructor(options: SandboxOptions = {}) {
    super(options);
    this.consent = options.consent;
  }

  async createCall(request: CreateVoiceCallRequest): Promise<ProviderReceipt> {
    if (!request.twimlUrl.startsWith('https://')) {
      throw new IntegrationError(
        'Voice instructions must use an HTTPS URL.',
        this.provider,
        'INVALID_TWIML_URL',
        false,
      );
    }
    if (this.consent) {
      const consent = await assertContactAllowed({
        store: this.consent,
        contact: request.to,
        channel: 'voice',
        category: 'transactional',
      });
      if (consent.id !== request.consentSnapshotId) {
        throw new IntegrationError(
          'Consent changed after this call was prepared.',
          this.provider,
          'STALE_CONSENT',
          false,
        );
      }
    }
    return this.idempotency.run(
      'sandbox-twilio-voice',
      request.idempotencyKey,
      request,
      async () => ({
        provider: this.provider,
        providerId: `CA_SANDBOX_${(await sha256Hex(request)).slice(0, 20)}`,
        mode: this.mode,
        status: 'queued',
        occurredAt: this.now().toISOString(),
        idempotencyKey: request.idempotencyKey,
      }),
    );
  }
}

export class SandboxEmailProvider extends SandboxProvider implements EmailProvider {
  readonly provider = 'email';
  readonly capability = 'email';
  private readonly deliveries = new Map<string, ProviderReceipt>();
  private readonly consent?: ConsentStore;
  private readonly limiter: RateLimiter;

  constructor(options: SandboxOptions = {}) {
    super(options);
    this.consent = options.consent;
    this.limiter = options.outboundRateLimiter ?? new InMemorySlidingWindowRateLimiter(100, 60_000);
  }

  async sendEmail(request: SendEmailRequest): Promise<ProviderReceipt> {
    if (request.to.length === 0 || !request.subject.trim() || !request.text.trim()) {
      throw new IntegrationError(
        'Email recipients, subject, and text body are required.',
        this.provider,
        'INVALID_MESSAGE',
        false,
      );
    }
    if (this.consent) {
      for (const recipient of request.to) {
        const consent = await assertContactAllowed({
          store: this.consent,
          contact: recipient,
          channel: 'email',
          category: request.category,
        });
        if (consent.id !== request.consentSnapshotIds[recipient]) {
          throw new IntegrationError(
            'Consent changed after this email was prepared.',
            this.provider,
            'STALE_CONSENT',
            false,
          );
        }
      }
    }
    const rateLimit = await this.limiter.consume(`email:${request.to.join(',')}`, this.now());
    if (!rateLimit.allowed) {
      throw new IntegrationError(
        `Email rate limit exceeded until ${rateLimit.resetAt}.`,
        this.provider,
        'RATE_LIMITED',
        true,
      );
    }
    return this.idempotency.run('sandbox-email', request.idempotencyKey, request, async () => {
      const receipt: ProviderReceipt = {
        provider: this.provider,
        providerId: `EM_SANDBOX_${(await sha256Hex(request)).slice(0, 20)}`,
        mode: this.mode,
        status: 'delivered',
        occurredAt: this.now().toISOString(),
        idempotencyKey: request.idempotencyKey,
      };
      this.deliveries.set(receipt.providerId, receipt);
      return receipt;
    });
  }

  async getEmailDelivery(providerId: string): Promise<ProviderReceipt | undefined> {
    return this.deliveries.get(providerId);
  }
}

function totalLines(lines: CheckoutLine[]): ProviderMoney {
  const amount = lines
    .reduce(
      (total, line) => total.plus(new Decimal(line.unitAmount.amount).times(line.quantity)),
      new Decimal(0),
    )
    .toFixed(2);
  return { amount, currency: 'USD' };
}

export class SandboxPaymentsProvider extends SandboxProvider implements PaymentsProvider {
  readonly provider = 'stripe';
  readonly capability = 'payments';
  private readonly documents = new Map<string, PaymentDocument>();

  async createCheckout(request: CreateCheckoutRequest): Promise<PaymentDocument> {
    return this.createDocument('checkout', request, request.lines);
  }

  async createInvoice(request: CreateInvoiceRequest): Promise<PaymentDocument> {
    return this.createDocument('invoice', request, request.lines);
  }

  private async createDocument(
    kind: 'checkout' | 'invoice',
    request: CreateCheckoutRequest | CreateInvoiceRequest,
    lines: CheckoutLine[],
  ): Promise<PaymentDocument> {
    if (lines.length === 0) {
      throw new IntegrationError(
        'At least one payment line is required.',
        this.provider,
        'EMPTY_DOCUMENT',
        false,
      );
    }
    return this.idempotency.run(
      `sandbox-stripe-${kind}`,
      request.idempotencyKey,
      request,
      async () => {
        const providerId = `${kind === 'checkout' ? 'cs' : 'in'}_sandbox_${(
          await sha256Hex(request)
        ).slice(0, 20)}`;
        const document: PaymentDocument = {
          provider: this.provider,
          providerId,
          mode: this.mode,
          kind,
          status: kind === 'checkout' ? 'open' : 'draft',
          hostedUrl: `https://sandbox.storyops.invalid/pay/${encodeURIComponent(providerId)}`,
          total: totalLines(lines),
          idempotencyKey: request.idempotencyKey,
        };
        this.documents.set(providerId, document);
        return document;
      },
    );
  }

  async getPayment(providerId: string): Promise<PaymentDocument | undefined> {
    return this.documents.get(providerId);
  }

  async refund(request: RefundRequest): Promise<PaymentDocument> {
    if (!request.approvalId) {
      throw new IntegrationError(
        'A resolved approval ID is required for refunds.',
        this.provider,
        'APPROVAL_REQUIRED',
        false,
      );
    }
    return this.idempotency.run(
      'sandbox-stripe-refund',
      request.idempotencyKey,
      request,
      async () => {
        const providerId = `re_sandbox_${(await sha256Hex(request)).slice(0, 20)}`;
        const document: PaymentDocument = {
          provider: this.provider,
          providerId,
          mode: this.mode,
          kind: 'refund',
          status: 'refunded',
          total: request.amount,
          idempotencyKey: request.idempotencyKey,
        };
        this.documents.set(providerId, document);
        return document;
      },
    );
  }
}

function overlaps(left: { start: string; end: string }, right: { start: string; end: string }) {
  return (
    new Date(left.start).getTime() < new Date(right.end).getTime() &&
    new Date(right.start).getTime() < new Date(left.end).getTime()
  );
}

export class SandboxCalendarProvider extends SandboxProvider implements CalendarProvider {
  readonly provider = 'google_calendar';
  readonly capability = 'calendar';
  readonly allowedCalendarIds = ['sandbox-primary'] as const;
  private readonly entries = new Map<string, CalendarEntry>();

  async readAvailability(request: CalendarAvailabilityRequest): Promise<CalendarAvailability> {
    const isOccupied = [...this.entries.values()].some((entry) => {
      const activeHold =
        entry.kind !== 'hold' ||
        !entry.expiresAt ||
        new Date(entry.expiresAt).getTime() > this.now().getTime();
      return entry.status !== 'cancelled' && activeHold && overlaps(entry.window, request.window);
    });
    return {
      provider: this.provider,
      mode: this.mode,
      window: request.window,
      free: isOccupied ? [] : [request.window],
      sourceCalendarIds: request.calendarIds,
      observedAt: this.now().toISOString(),
    };
  }

  async createHold(
    request: CreateCalendarEntryRequest & { expiresAt: string },
  ): Promise<CalendarEntry> {
    const expiresAt = new Date(request.expiresAt).getTime();
    const now = this.now().getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 24 * 60 * 60 * 1_000) {
      throw new IntegrationError(
        'Calendar holds must expire in the future and within 24 hours.',
        this.provider,
        'INVALID_HOLD_EXPIRY',
        false,
      );
    }
    return this.createEntry('hold', request, request.expiresAt);
  }

  async createBooking(request: CreateCalendarEntryRequest): Promise<CalendarEntry> {
    return this.createEntry('booking', request);
  }

  async readBooking(request: ReadCalendarBookingRequest): Promise<CalendarBookingState> {
    const entry = this.entries.get(request.providerId);
    if (!entry) {
      return {
        provider: this.provider,
        providerId: request.providerId,
        mode: this.mode,
        status: 'absent',
        idempotencyKey: request.idempotencyKey,
        observedAt: this.now().toISOString(),
        readBackConfirmed: true,
      };
    }
    if (
      entry.kind !== 'booking' ||
      entry.idempotencyKey !== request.idempotencyKey ||
      Date.parse(entry.window.start) !== Date.parse(request.window.start) ||
      Date.parse(entry.window.end) !== Date.parse(request.window.end)
    ) {
      throw new IntegrationError(
        'Sandbox calendar read-back does not match the exact booking.',
        this.provider,
        'RECONCILIATION_CONFLICT',
        false,
      );
    }
    return {
      provider: this.provider,
      providerId: entry.providerId,
      mode: this.mode,
      status: entry.status === 'cancelled' ? 'cancelled' : 'confirmed',
      idempotencyKey: entry.idempotencyKey,
      etag: entry.etag,
      observedAt: this.now().toISOString(),
      readBackConfirmed: true,
    };
  }

  async cancelBooking(request: CancelCalendarEntryRequest): Promise<void> {
    const entry = this.entries.get(request.providerId);
    if (!entry) return;
    if (
      entry.kind !== 'booking' ||
      entry.etag !== request.etag ||
      entry.idempotencyKey !== request.idempotencyKey
    ) {
      throw new IntegrationError(
        'Sandbox calendar cancellation does not match the exact booking.',
        this.provider,
        'RECONCILIATION_CONFLICT',
        false,
      );
    }
    this.entries.delete(request.providerId);
  }

  private async createEntry(
    kind: 'hold' | 'booking',
    request: CreateCalendarEntryRequest,
    expiresAt?: string,
  ): Promise<CalendarEntry> {
    return this.idempotency.run(
      `sandbox-calendar-${kind}`,
      request.idempotencyKey,
      request,
      async () => {
        const occupied = [...this.entries.values()].some((entry) => {
          const activeHold =
            entry.kind !== 'hold' ||
            !entry.expiresAt ||
            new Date(entry.expiresAt).getTime() > this.now().getTime();
          return (
            entry.status !== 'cancelled' && activeHold && overlaps(entry.window, request.window)
          );
        });
        if (occupied) {
          throw new IntegrationError(
            'The requested sandbox calendar window is no longer available.',
            this.provider,
            'CALENDAR_CONFLICT',
            false,
          );
        }
        const providerId = `cal_sandbox_${(await sha256Hex(request)).slice(0, 20)}`;
        const entry: CalendarEntry = {
          provider: this.provider,
          providerId,
          mode: this.mode,
          kind,
          status: kind === 'hold' ? 'tentative' : 'confirmed',
          window: request.window,
          expiresAt,
          idempotencyKey: request.idempotencyKey,
          etag: `sandbox-${providerId}`,
          reconciledAt: this.now().toISOString(),
          readBackConfirmed: true,
        };
        this.entries.set(providerId, entry);
        return entry;
      },
    );
  }
}

export class SandboxMapsProvider extends SandboxProvider implements MapsProvider {
  readonly provider = 'maps';
  readonly capability = 'geocoding';

  async geocode(address: string): Promise<GeocodeResult[]> {
    if (!address.trim()) return [];
    const hash = await sha256Hex(address.trim().toLowerCase());
    const latitudeOffset = Number.parseInt(hash.slice(0, 6), 16) / 0xffffff;
    const longitudeOffset = Number.parseInt(hash.slice(6, 12), 16) / 0xffffff;
    return [
      {
        provider: this.provider,
        mode: this.mode,
        formattedAddress: address.trim(),
        coordinates: {
          latitude: 32.6 + latitudeOffset * 0.6,
          longitude: -97.5 + longitudeOffset * 1.2,
        },
        precision: 'unknown',
        confidence: 0.1,
        providerPlaceId: `sandbox_${hash.slice(0, 16)}`,
        observedAt: this.now().toISOString(),
      },
    ];
  }
}

export class SandboxWeatherProvider extends SandboxProvider implements WeatherProvider {
  readonly provider = 'nws';
  readonly capability = 'weather';

  async forecast(request: WeatherForecastRequest): Promise<WeatherForecast> {
    return {
      provider: this.provider,
      mode: this.mode,
      office: null,
      periods: [
        {
          start: request.window.start,
          end: request.window.end,
          temperatureF: null,
          precipitationProbability: null,
          windMph: null,
          shortForecast: 'Sandbox weather unavailable',
        },
      ],
      alerts: [],
      issuedAt: this.now().toISOString(),
      observedAt: this.now().toISOString(),
      unknowns: ['Sandbox mode does not fabricate weather. Recheck NWS before dispatch.'],
    };
  }
}

function distanceMeters(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left.latitude)) *
      Math.cos(radians(right.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export class SandboxRoutingProvider extends SandboxProvider implements RoutingProvider {
  readonly provider = 'vroom';
  readonly capability = 'routing';

  async optimize(request: RoutingRequest): Promise<RoutePlan> {
    if (request.vehicles.length === 0) {
      return {
        provider: this.provider,
        mode: this.mode,
        routes: [],
        unassignedJobIds: request.jobs.map((job) => job.id),
        summary: { travelSeconds: 0, serviceSeconds: 0, distanceMeters: 0 },
      };
    }
    const unvisited = [...request.jobs];
    const routes: RoutePlan['routes'] = [];
    for (const vehicle of request.vehicles) {
      const jobIds: string[] = [];
      let location = vehicle.start;
      let routeDistance = 0;
      let serviceSeconds = 0;
      while (unvisited.length > 0) {
        const nearest = unvisited
          .map((job, index) => ({
            index,
            job,
            distance: distanceMeters(location, job.location),
          }))
          .sort((left, right) => left.distance - right.distance)[0];
        if (!nearest) break;
        unvisited.splice(nearest.index, 1);
        jobIds.push(nearest.job.id);
        routeDistance += nearest.distance;
        serviceSeconds += nearest.job.serviceSeconds;
        location = nearest.job.location;
      }
      if (vehicle.end) routeDistance += distanceMeters(location, vehicle.end);
      routes.push({
        vehicleId: vehicle.id,
        jobIds,
        distanceMeters: Math.round(routeDistance),
        travelSeconds: Math.round(routeDistance / 11.2),
        serviceSeconds,
      });
    }
    return {
      provider: this.provider,
      mode: this.mode,
      routes,
      unassignedJobIds: unvisited.map((job) => job.id),
      summary: routes.reduce(
        (summary, route) => ({
          travelSeconds: summary.travelSeconds + route.travelSeconds,
          serviceSeconds: summary.serviceSeconds + route.serviceSeconds,
          distanceMeters: summary.distanceMeters + route.distanceMeters,
        }),
        { travelSeconds: 0, serviceSeconds: 0, distanceMeters: 0 },
      ),
    };
  }
}

export class SandboxStorageProvider extends SandboxProvider implements StorageProvider {
  readonly provider = 'signed_storage_targets';
  readonly capability = 'server_signed_targets';

  async createUploadTarget(request: UploadTargetRequest): Promise<StorageTarget> {
    assertStorageObjectKeyScope(request.companyId, request.objectKey);
    if (
      request.maxBytes !== JOB_MEDIA_UPLOAD_MAX_BYTES ||
      request.expiresInSeconds !== SUPABASE_SIGNED_UPLOAD_EXPIRES_SECONDS
    ) {
      throw new IntegrationError(
        'Storage uploads must use the enforced job-media size and expiry limits.',
        this.provider,
        'INVALID_UPLOAD_TARGET',
        false,
      );
    }
    return this.idempotency.run(
      'sandbox-storage-upload',
      request.idempotencyKey,
      request,
      async () => ({
        provider: this.provider,
        mode: this.mode,
        objectKey: request.objectKey,
        signedUrl: `sandbox://storage/upload/${encodeURIComponent(request.objectKey)}`,
        expiresAt: new Date(this.now().getTime() + request.expiresInSeconds * 1_000).toISOString(),
        method: 'PUT',
        requiredHeaders: {
          'content-type': request.contentType,
        },
        maximumBytes: JOB_MEDIA_UPLOAD_MAX_BYTES,
        idempotencyKey: request.idempotencyKey,
      }),
    );
  }

  async createDownloadTarget(
    companyId: string,
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<StorageTarget> {
    assertStorageObjectKeyScope(companyId, objectKey);
    return {
      provider: this.provider,
      mode: this.mode,
      objectKey,
      signedUrl: `sandbox://storage/download/${encodeURIComponent(objectKey)}`,
      expiresAt: new Date(this.now().getTime() + expiresInSeconds * 1_000).toISOString(),
      method: 'GET',
      requiredHeaders: {},
      idempotencyKey: `download:${objectKey}:${expiresInSeconds}`,
    };
  }
}

export class SandboxAccountingProvider extends SandboxProvider implements AccountingProvider {
  readonly provider = 'quickbooks_export' as const;
  readonly capability = 'accounting_export';

  async exportInvoice(request: QuickBooksInvoiceExportRequest): Promise<AccountingExport> {
    return this.idempotency.run(
      'sandbox-quickbooks-export',
      request.idempotencyKey,
      request,
      async () => {
        const headers = [
          'InvoiceNo',
          'Customer',
          'Email',
          'InvoiceDate',
          'DueDate',
          'Description',
          'Quantity',
          'Rate',
          'TaxAmount',
        ];
        const rows = request.lines.map((line, index) => [
          request.invoiceNumber,
          request.customerName,
          request.customerEmail ?? '',
          request.issuedDate,
          request.dueDate,
          line.description,
          line.quantity,
          line.unitAmount.amount,
          index === 0 ? request.tax.amount : '0.00',
        ]);
        const content = [
          headers.map((value) => csvCell(value)).join(','),
          ...rows.map((row) => row.map((value) => csvCell(value)).join(',')),
        ].join('\r\n');
        return {
          provider: this.provider,
          mode: this.mode,
          fileName: `quickbooks-invoice-${request.invoiceNumber}.csv`,
          mimeType: 'text/csv',
          content,
          sha256: await sha256Hex(content),
          idempotencyKey: request.idempotencyKey,
        };
      },
    );
  }
}

export function createSandboxIntegrationSuite(options: SandboxOptions = {}): IntegrationSuite {
  return {
    openai: new SandboxOpenAiHealth(options),
    sms: new SandboxSmsProvider(options),
    voice: new SandboxVoiceProvider(options),
    email: new SandboxEmailProvider(options),
    payments: new SandboxPaymentsProvider(options),
    calendar: new SandboxCalendarProvider(options),
    maps: new SandboxMapsProvider(options),
    weather: new SandboxWeatherProvider(options),
    routing: new SandboxRoutingProvider(options),
    storage: new SandboxStorageProvider(options),
    accounting: new SandboxAccountingProvider(options),
  };
}
