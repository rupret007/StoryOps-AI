export type IntegrationMode = 'sandbox' | 'live' | 'disabled';
export type IntegrationStatus = 'healthy' | 'degraded' | 'down' | 'not_configured';

export type IntegrationProbeEvidence = {
  schemaVersion: 'storyops-integration-probe-evidence-v1';
  basis: 'external_read' | 'deterministic_local';
  operation: string;
  responseDigest: string;
};

export type IntegrationHealth = {
  provider: string;
  capability: string;
  mode: IntegrationMode;
  status: IntegrationStatus;
  checkedAt: string;
  latencyMs: number;
  message: string;
  requiredEnvironment: string[];
  probeEvidence?: IntegrationProbeEvidence;
};

export interface HealthCheckedIntegration {
  readonly provider: string;
  readonly capability: string;
  readonly mode: IntegrationMode;
  health(signal?: AbortSignal): Promise<IntegrationHealth>;
}

export type ProviderReceipt = {
  provider: string;
  providerId: string;
  mode: IntegrationMode;
  status: 'accepted' | 'queued' | 'sent' | 'delivered' | 'failed';
  occurredAt: string;
  idempotencyKey: string;
};

export type MessageCategory = 'transactional' | 'marketing';

export type SendSmsRequest = {
  companyId: string;
  to: string;
  from?: string;
  body: string;
  category: MessageCategory;
  consentSnapshotId: string;
  idempotencyKey: string;
};

export interface SmsProvider extends HealthCheckedIntegration {
  sendSms(request: SendSmsRequest, signal?: AbortSignal): Promise<ProviderReceipt>;
  getSmsDelivery(providerId: string, signal?: AbortSignal): Promise<ProviderReceipt | undefined>;
}

export type CreateVoiceCallRequest = {
  companyId: string;
  to: string;
  from?: string;
  twimlUrl: string;
  consentSnapshotId: string;
  idempotencyKey: string;
};

export interface VoiceProvider extends HealthCheckedIntegration {
  createCall(request: CreateVoiceCallRequest, signal?: AbortSignal): Promise<ProviderReceipt>;
}

export type SendEmailRequest = {
  companyId: string;
  to: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  category: MessageCategory;
  consentSnapshotIds: Record<string, string>;
  idempotencyKey: string;
};

export interface EmailProvider extends HealthCheckedIntegration {
  sendEmail(request: SendEmailRequest, signal?: AbortSignal): Promise<ProviderReceipt>;
  getEmailDelivery(providerId: string, signal?: AbortSignal): Promise<ProviderReceipt | undefined>;
}

export type ProviderMoney = {
  amount: string;
  currency: 'USD';
};

export type CheckoutLine = {
  description: string;
  quantity: number;
  unitAmount: ProviderMoney;
};

type CheckoutRequestBase = {
  companyId: string;
  customerId: string;
  checkoutAttempt?: number;
  lines: CheckoutLine[];
  successUrl?: string;
  cancelUrl?: string;
  idempotencyKey: string;
};

export type CreateCheckoutRequest = CheckoutRequestBase &
  (
    | {
        checkoutPurpose?: 'quote_deposit';
        quoteId: string;
        invoiceId?: never;
        invoiceVersion?: never;
      }
    | {
        checkoutPurpose: 'invoice_balance';
        quoteId: string;
        invoiceId: string;
        invoiceVersion: number;
      }
  );

export type CreateInvoiceRequest = {
  companyId: string;
  customerId: string;
  jobId: string;
  lines: CheckoutLine[];
  dueDate: string;
  idempotencyKey: string;
};

export type PaymentDocument = {
  provider: string;
  providerId: string;
  mode: IntegrationMode;
  kind: 'checkout' | 'invoice' | 'refund';
  status: 'draft' | 'open' | 'paid' | 'void' | 'failed' | 'refunded';
  hostedUrl?: string;
  total: ProviderMoney;
  idempotencyKey: string;
};

export type RefundRequest = {
  companyId: string;
  paymentProviderId: string;
  amount: ProviderMoney;
  reason: string;
  approvalId: string;
  idempotencyKey: string;
};

export interface PaymentsProvider extends HealthCheckedIntegration {
  createCheckout(request: CreateCheckoutRequest, signal?: AbortSignal): Promise<PaymentDocument>;
  createInvoice(request: CreateInvoiceRequest, signal?: AbortSignal): Promise<PaymentDocument>;
  getPayment(providerId: string, signal?: AbortSignal): Promise<PaymentDocument | undefined>;
  refund(request: RefundRequest, signal?: AbortSignal): Promise<PaymentDocument>;
}

export type TimeWindow = {
  start: string;
  end: string;
};

export type CalendarAvailabilityRequest = {
  calendarIds: string[];
  window: TimeWindow;
  durationMinutes: number;
  timeZone: string;
};

export type CalendarAvailability = {
  provider: string;
  mode: IntegrationMode;
  window: TimeWindow;
  free: TimeWindow[];
  sourceCalendarIds: string[];
  observedAt: string;
};

export type CreateCalendarEntryRequest = {
  calendarId: string;
  title: string;
  window: TimeWindow;
  timeZone: string;
  customerEmail?: string;
  jobId: string;
  idempotencyKey: string;
};

export type CalendarEntry = {
  provider: string;
  providerId: string;
  mode: IntegrationMode;
  kind: 'hold' | 'booking';
  status: 'tentative' | 'confirmed' | 'cancelled';
  window: TimeWindow;
  expiresAt?: string;
  idempotencyKey: string;
  etag: string;
  reconciledAt: string;
  readBackConfirmed: boolean;
};

export type CancelCalendarEntryRequest = {
  calendarId: string;
  providerId: string;
  etag: string;
  idempotencyKey: string;
};

export type ReadCalendarBookingRequest = {
  calendarId: string;
  providerId: string;
  idempotencyKey: string;
  jobId: string;
  window: TimeWindow;
};

export type CalendarBookingState = {
  provider: string;
  providerId: string;
  mode: IntegrationMode;
  status: 'confirmed' | 'cancelled' | 'absent';
  idempotencyKey: string;
  etag?: string;
  observedAt: string;
  readBackConfirmed: true;
};

export interface CalendarProvider extends HealthCheckedIntegration {
  readonly allowedCalendarIds: readonly string[];
  readAvailability(
    request: CalendarAvailabilityRequest,
    signal?: AbortSignal,
  ): Promise<CalendarAvailability>;
  createHold(
    request: CreateCalendarEntryRequest & { expiresAt: string },
    signal?: AbortSignal,
  ): Promise<CalendarEntry>;
  createBooking(request: CreateCalendarEntryRequest, signal?: AbortSignal): Promise<CalendarEntry>;
  readBooking(
    request: ReadCalendarBookingRequest,
    signal?: AbortSignal,
  ): Promise<CalendarBookingState>;
  cancelBooking(request: CancelCalendarEntryRequest, signal?: AbortSignal): Promise<void>;
}

export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type GeocodeResult = {
  provider: string;
  mode: IntegrationMode;
  formattedAddress: string;
  coordinates: Coordinates;
  precision: 'rooftop' | 'parcel' | 'street' | 'city' | 'unknown';
  confidence: number;
  providerPlaceId?: string;
  observedAt: string;
};

export interface MapsProvider extends HealthCheckedIntegration {
  geocode(address: string, signal?: AbortSignal): Promise<GeocodeResult[]>;
}

export type WeatherForecastRequest = {
  coordinates: Coordinates;
  window: TimeWindow;
};

export type WeatherPeriod = {
  start: string;
  end: string;
  temperatureF: number | null;
  precipitationProbability: number | null;
  windMph: number | null;
  shortForecast: string;
};

export type WeatherForecast = {
  provider: string;
  mode: IntegrationMode;
  office: string | null;
  periods: WeatherPeriod[];
  alerts: Array<{ severity: string; event: string; headline: string }>;
  issuedAt: string;
  observedAt: string;
  unknowns: string[];
};

export interface WeatherProvider extends HealthCheckedIntegration {
  forecast(request: WeatherForecastRequest, signal?: AbortSignal): Promise<WeatherForecast>;
}

export type RoutingJob = {
  id: string;
  location: Coordinates;
  serviceSeconds: number;
  timeWindows: TimeWindow[];
};

export type RoutingVehicle = {
  id: string;
  start: Coordinates;
  end?: Coordinates;
  capacity?: number[];
  availability: TimeWindow;
};

export type RoutingRequest = {
  jobs: RoutingJob[];
  vehicles: RoutingVehicle[];
  idempotencyKey: string;
};

export type RoutePlan = {
  provider: string;
  mode: IntegrationMode;
  routes: Array<{
    vehicleId: string;
    jobIds: string[];
    travelSeconds: number;
    serviceSeconds: number;
    distanceMeters: number;
  }>;
  unassignedJobIds: string[];
  summary: {
    travelSeconds: number;
    serviceSeconds: number;
    distanceMeters: number;
  };
};

export interface RoutingProvider extends HealthCheckedIntegration {
  optimize(request: RoutingRequest, signal?: AbortSignal): Promise<RoutePlan>;
}

export type UploadTargetRequest = {
  companyId: string;
  objectKey: string;
  contentType: string;
  maxBytes: number;
  expiresInSeconds: number;
  idempotencyKey: string;
};

export type StorageTarget = {
  provider: string;
  mode: IntegrationMode;
  objectKey: string;
  signedUrl: string;
  expiresAt: string;
  method: 'PUT' | 'GET';
  requiredHeaders: Record<string, string>;
  maximumBytes?: number;
  idempotencyKey: string;
};

export interface StorageProvider extends HealthCheckedIntegration {
  createUploadTarget(request: UploadTargetRequest, signal?: AbortSignal): Promise<StorageTarget>;
  createDownloadTarget(
    companyId: string,
    objectKey: string,
    expiresInSeconds: number,
    signal?: AbortSignal,
  ): Promise<StorageTarget>;
}

export type QuickBooksInvoiceExportRequest = {
  invoiceNumber: string;
  customerName: string;
  customerEmail?: string;
  issuedDate: string;
  dueDate: string;
  lines: CheckoutLine[];
  tax: ProviderMoney;
  idempotencyKey: string;
};

export type AccountingExport = {
  provider: 'quickbooks_export';
  mode: IntegrationMode;
  fileName: string;
  mimeType: 'text/csv';
  content: string;
  sha256: string;
  idempotencyKey: string;
};

export interface AccountingProvider extends HealthCheckedIntegration {
  exportInvoice(
    request: QuickBooksInvoiceExportRequest,
    signal?: AbortSignal,
  ): Promise<AccountingExport>;
}

export type IntegrationSuite = {
  openai: HealthCheckedIntegration;
  sms: SmsProvider;
  voice: VoiceProvider;
  email: EmailProvider;
  payments: PaymentsProvider;
  calendar: CalendarProvider;
  maps: MapsProvider;
  weather: WeatherProvider;
  routing: RoutingProvider;
  storage: StorageProvider;
  accounting: AccountingProvider;
};

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly code: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'IntegrationError';
  }
}
