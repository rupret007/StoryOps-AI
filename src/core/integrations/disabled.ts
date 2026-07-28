import type {
  AccountingExport,
  AccountingProvider,
  CalendarAvailability,
  CalendarAvailabilityRequest,
  CalendarEntry,
  CalendarProvider,
  CreateCalendarEntryRequest,
  CreateCheckoutRequest,
  CreateInvoiceRequest,
  CreateVoiceCallRequest,
  EmailProvider,
  GeocodeResult,
  IntegrationHealth,
  IntegrationSuite,
  MapsProvider,
  PaymentDocument,
  PaymentsProvider,
  ProviderReceipt,
  QuickBooksInvoiceExportRequest,
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

abstract class DisabledProvider {
  readonly mode = 'disabled' as const;

  constructor(
    readonly provider: string,
    readonly capability: string,
  ) {}

  health(): Promise<IntegrationHealth> {
    return Promise.resolve({
      provider: this.provider,
      capability: this.capability,
      mode: this.mode,
      status: 'not_configured',
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      message: 'Provider is explicitly disabled; no live or sandbox operation is available.',
      requiredEnvironment: [],
    });
  }

  protected unavailable<T>(): Promise<T> {
    return Promise.reject(
      new IntegrationError(
        `${this.provider} ${this.capability} is explicitly disabled.`,
        this.provider,
        'PROVIDER_DISABLED',
        false,
      ),
    );
  }
}

class DisabledSmsProvider extends DisabledProvider implements SmsProvider {
  sendSms(_request: SendSmsRequest): Promise<ProviderReceipt> {
    return this.unavailable();
  }

  getSmsDelivery(_providerId: string): Promise<ProviderReceipt | undefined> {
    return this.unavailable();
  }
}

class DisabledVoiceProvider extends DisabledProvider implements VoiceProvider {
  createCall(_request: CreateVoiceCallRequest): Promise<ProviderReceipt> {
    return this.unavailable();
  }
}

class DisabledEmailProvider extends DisabledProvider implements EmailProvider {
  sendEmail(_request: SendEmailRequest): Promise<ProviderReceipt> {
    return this.unavailable();
  }

  getEmailDelivery(_providerId: string): Promise<ProviderReceipt | undefined> {
    return this.unavailable();
  }
}

class DisabledPaymentsProvider extends DisabledProvider implements PaymentsProvider {
  createCheckout(_request: CreateCheckoutRequest): Promise<PaymentDocument> {
    return this.unavailable();
  }

  createInvoice(_request: CreateInvoiceRequest): Promise<PaymentDocument> {
    return this.unavailable();
  }

  getPayment(_providerId: string): Promise<PaymentDocument | undefined> {
    return this.unavailable();
  }

  refund(_request: RefundRequest): Promise<PaymentDocument> {
    return this.unavailable();
  }
}

class DisabledCalendarProvider extends DisabledProvider implements CalendarProvider {
  readonly allowedCalendarIds: readonly string[] = [];

  readAvailability(_request: CalendarAvailabilityRequest): Promise<CalendarAvailability> {
    return this.unavailable();
  }

  createHold(_request: CreateCalendarEntryRequest & { expiresAt: string }): Promise<CalendarEntry> {
    return this.unavailable();
  }

  createBooking(_request: CreateCalendarEntryRequest): Promise<CalendarEntry> {
    return this.unavailable();
  }
}

class DisabledMapsProvider extends DisabledProvider implements MapsProvider {
  geocode(_address: string): Promise<GeocodeResult[]> {
    return this.unavailable();
  }
}

class DisabledWeatherProvider extends DisabledProvider implements WeatherProvider {
  forecast(_request: WeatherForecastRequest): Promise<WeatherForecast> {
    return this.unavailable();
  }
}

class DisabledRoutingProvider extends DisabledProvider implements RoutingProvider {
  optimize(_request: RoutingRequest): Promise<RoutePlan> {
    return this.unavailable();
  }
}

class DisabledStorageProvider extends DisabledProvider implements StorageProvider {
  createUploadTarget(_request: UploadTargetRequest): Promise<StorageTarget> {
    return this.unavailable();
  }

  createDownloadTarget(
    _companyId: string,
    _objectKey: string,
    _expiresInSeconds: number,
  ): Promise<StorageTarget> {
    return this.unavailable();
  }
}

class DisabledAccountingProvider extends DisabledProvider implements AccountingProvider {
  exportInvoice(_request: QuickBooksInvoiceExportRequest): Promise<AccountingExport> {
    return this.unavailable();
  }
}

export function createDisabledIntegrationSuite(): IntegrationSuite {
  return {
    openai: new (class extends DisabledProvider {})('openai', 'structured_ai'),
    sms: new DisabledSmsProvider('twilio', 'sms'),
    voice: new DisabledVoiceProvider('twilio', 'voice'),
    email: new DisabledEmailProvider('email', 'email'),
    payments: new DisabledPaymentsProvider('stripe', 'payments'),
    calendar: new DisabledCalendarProvider('google_calendar', 'calendar'),
    maps: new DisabledMapsProvider('maps', 'geocoding'),
    weather: new DisabledWeatherProvider('nws', 'weather'),
    routing: new DisabledRoutingProvider('vroom', 'routing'),
    storage: new DisabledStorageProvider('signed_storage_targets', 'server_signed_targets'),
    accounting: new DisabledAccountingProvider('quickbooks_export', 'accounting_export'),
  };
}
