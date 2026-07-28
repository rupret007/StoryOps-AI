import { z } from 'zod';
import { OfficeToolRegistry, ToolExecutionError } from '../ai/tools.ts';
import type { IntegrationSuite } from './contracts.ts';
import { IntegrationError } from './contracts.ts';
import {
  JOB_MEDIA_UPLOAD_MAX_BYTES,
  SUPABASE_SIGNED_UPLOAD_EXPIRES_SECONDS,
  scopeStorageObjectKey,
} from './storageSecurity.ts';

const timeWindowSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
});
const moneySchema = z.object({
  amount: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/),
  currency: z.literal('USD'),
});
const checkoutLineSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().int().positive(),
  unitAmount: moneySchema,
});
const coordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

async function callProvider<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IntegrationError) {
      throw new ToolExecutionError(error.message, {
        retryable: error.retryable,
        providerCode: error.code,
        cause: error,
      });
    }
    throw error;
  }
}

export function registerIntegrationOfficeTools(
  registry: OfficeToolRegistry,
  suite: IntegrationSuite,
): OfficeToolRegistry {
  registry.register({
    name: 'maps.geocode',
    description: 'Geocode a supplied address; never infer or fabricate coordinates.',
    input: z.object({ address: z.string().min(3).max(1_000) }),
    risk: 'low',
    sideEffect: 'none',
    reversible: true,
    supportsIdempotency: true,
    autoExecute: true,
    execute: ({ address }, context) =>
      callProvider(() => suite.maps.geocode(address, context.signal)),
  });

  registry.register({
    name: 'calendar.read_availability',
    description: 'Read free/busy windows from configured calendars.',
    input: z.object({
      window: timeWindowSchema,
      durationMinutes: z.number().int().min(15).max(720),
      timeZone: z.string().min(1).max(100),
    }),
    risk: 'low',
    sideEffect: 'none',
    reversible: true,
    supportsIdempotency: true,
    autoExecute: true,
    execute: (input, context) =>
      callProvider(() =>
        suite.calendar.readAvailability(
          { ...input, calendarIds: [...suite.calendar.allowedCalendarIds] },
          context.signal,
        ),
      ),
  });

  const calendarWriteSchema = z.object({
    title: z.string().min(1).max(500),
    window: timeWindowSchema,
    timeZone: z.string().min(1).max(100),
    customerEmail: z.string().email().optional(),
    jobId: z.string().min(1),
  });

  registry.register({
    name: 'calendar.create_hold',
    description: 'Create an expiring tentative capacity hold.',
    input: calendarWriteSchema.extend({
      expiresAt: z.string().datetime({ offset: true }),
    }),
    risk: 'low',
    sideEffect: 'external_write',
    reversible: false,
    supportsIdempotency: true,
    autoExecute: false,
    execute: (input, context) => {
      const expiresAt = new Date(input.expiresAt).getTime();
      const now = Date.now();
      if (expiresAt <= now || expiresAt > now + 24 * 60 * 60 * 1_000) {
        throw new IntegrationError(
          'Calendar holds must expire in the future and within 24 hours.',
          'google_calendar',
          'INVALID_HOLD_EXPIRY',
          false,
        );
      }
      return callProvider(() =>
        suite.calendar.createHold(
          {
            ...input,
            calendarId: suite.calendar.allowedCalendarIds[0] ?? '',
            idempotencyKey: context.idempotencyKey,
          },
          context.signal,
        ),
      );
    },
  });

  registry.register({
    name: 'calendar.create_booking',
    description: 'Create a confirmed calendar booking after capacity checks.',
    input: calendarWriteSchema,
    risk: 'low',
    sideEffect: 'external_write',
    reversible: false,
    supportsIdempotency: true,
    autoExecute: false,
    execute: (input, context) =>
      callProvider(() =>
        suite.calendar.createBooking(
          {
            ...input,
            calendarId: suite.calendar.allowedCalendarIds[0] ?? '',
            idempotencyKey: context.idempotencyKey,
          },
          context.signal,
        ),
      ),
  });

  registry.register({
    name: 'weather.read_forecast',
    description: 'Read a provider-grounded forecast and alerts for a job window.',
    input: z.object({
      coordinates: coordinatesSchema,
      window: timeWindowSchema,
    }),
    risk: 'low',
    sideEffect: 'none',
    reversible: true,
    supportsIdempotency: true,
    autoExecute: true,
    execute: (input, context) => callProvider(() => suite.weather.forecast(input, context.signal)),
  });

  registry.register({
    name: 'routing.optimize',
    description: 'Optimize known jobs and vehicles with the configured routing provider.',
    input: z.object({
      jobs: z
        .array(
          z.object({
            id: z.string().min(1),
            location: coordinatesSchema,
            serviceSeconds: z.number().int().nonnegative(),
            timeWindows: z.array(timeWindowSchema),
          }),
        )
        .max(200),
      vehicles: z
        .array(
          z.object({
            id: z.string().min(1),
            start: coordinatesSchema,
            end: coordinatesSchema.optional(),
            capacity: z.array(z.number().int().nonnegative()).optional(),
            availability: timeWindowSchema,
          }),
        )
        .max(50),
    }),
    risk: 'low',
    sideEffect: 'none',
    reversible: true,
    supportsIdempotency: true,
    autoExecute: true,
    execute: (input, context) =>
      callProvider(() =>
        suite.routing.optimize(
          { ...input, idempotencyKey: context.idempotencyKey },
          context.signal,
        ),
      ),
  });

  registry.register({
    name: 'communications.send_sms',
    description: 'Send a consent-checked SMS and return its provider delivery receipt.',
    input: z.object({
      to: z.string().min(8).max(32),
      body: z.string().min(1).max(1_600),
      category: z.enum(['transactional', 'marketing']),
      consentSnapshotId: z.string().min(1),
    }),
    risk: 'medium',
    sideEffect: 'external_write',
    reversible: false,
    supportsIdempotency: true,
    autoExecute: false,
    execute: (input, context) =>
      callProvider(() =>
        suite.sms.sendSms(
          {
            ...input,
            companyId: context.companyId,
            idempotencyKey: context.idempotencyKey,
          },
          context.signal,
        ),
      ),
  });

  registry.register({
    name: 'communications.send_email',
    description: 'Send a consent-checked email and return its provider delivery receipt.',
    input: z.object({
      to: z.array(z.string().email()).min(1).max(20),
      replyTo: z.string().email().optional(),
      subject: z.string().min(1).max(998),
      text: z.string().min(1).max(100_000),
      html: z.string().max(200_000).optional(),
      category: z.enum(['transactional', 'marketing']),
      consentSnapshotIds: z.record(z.string(), z.string().min(1)),
    }),
    risk: 'medium',
    sideEffect: 'external_write',
    reversible: false,
    supportsIdempotency: true,
    autoExecute: false,
    execute: (input, context) =>
      callProvider(() =>
        suite.email.sendEmail(
          {
            ...input,
            companyId: context.companyId,
            idempotencyKey: context.idempotencyKey,
          },
          context.signal,
        ),
      ),
  });

  registry.register({
    name: 'payments.read_status',
    description: 'Read authoritative provider payment state.',
    input: z.object({ providerId: z.string().min(1) }),
    risk: 'low',
    sideEffect: 'none',
    reversible: true,
    supportsIdempotency: true,
    autoExecute: true,
    execute: ({ providerId }, context) =>
      callProvider(() => suite.payments.getPayment(providerId, context.signal)),
  });

  registry.register({
    name: 'payments.create_checkout',
    description: 'Create an idempotent hosted checkout for deterministic quote lines.',
    input: z.object({
      customerId: z.string().uuid(),
      quoteId: z.string().uuid(),
      lines: z.array(checkoutLineSchema).min(1).max(100),
    }),
    risk: 'low',
    sideEffect: 'external_write',
    reversible: false,
    supportsIdempotency: true,
    autoExecute: false,
    execute: (input, context) =>
      callProvider(() =>
        suite.payments.createCheckout(
          {
            ...input,
            companyId: context.companyId,
            idempotencyKey: context.idempotencyKey,
          },
          context.signal,
        ),
      ),
  });

  registry.register({
    name: 'payments.create_invoice',
    description: 'Create an idempotent draft invoice from deterministic job lines.',
    input: z.object({
      customerId: z.string().uuid(),
      jobId: z.string().uuid(),
      lines: z.array(checkoutLineSchema).min(1).max(100),
      dueDate: z.string().min(1),
    }),
    risk: 'low',
    sideEffect: 'external_write',
    reversible: false,
    supportsIdempotency: true,
    autoExecute: false,
    execute: (input, context) =>
      callProvider(() =>
        suite.payments.createInvoice(
          {
            ...input,
            companyId: context.companyId,
            idempotencyKey: context.idempotencyKey,
          },
          context.signal,
        ),
      ),
  });

  registry.register({
    name: 'payments.refund',
    description: 'Issue a previously approved exact-amount refund.',
    input: z.object({
      paymentProviderId: z.string().min(1),
      amount: moneySchema,
      reason: z.string().min(1).max(1_000),
    }),
    risk: 'high',
    sideEffect: 'external_write',
    reversible: false,
    supportsIdempotency: true,
    autoExecute: false,
    execute: (input, context) => {
      const approvalId = context.approvalId;
      if (!approvalId) {
        throw new ToolExecutionError('Refund execution requires an approval context.', {
          retryable: false,
          providerCode: 'APPROVAL_REQUIRED',
        });
      }
      return callProvider(() =>
        suite.payments.refund(
          {
            ...input,
            approvalId,
            companyId: context.companyId,
            idempotencyKey: context.idempotencyKey,
          },
          context.signal,
        ),
      );
    },
  });

  registry.register({
    name: 'storage.create_upload',
    description: 'Create a short-lived, bounded upload target.',
    input: z.object({
      objectKey: z.string().min(1).max(1_024),
      contentType: z.string().min(1).max(255),
    }),
    risk: 'low',
    sideEffect: 'internal_write',
    reversible: true,
    supportsIdempotency: true,
    autoExecute: false,
    execute: (input, context) =>
      callProvider(() =>
        suite.storage.createUploadTarget(
          {
            ...input,
            companyId: context.companyId,
            objectKey: scopeStorageObjectKey(context.companyId, input.objectKey),
            maxBytes: JOB_MEDIA_UPLOAD_MAX_BYTES,
            expiresInSeconds: SUPABASE_SIGNED_UPLOAD_EXPIRES_SECONDS,
            idempotencyKey: context.idempotencyKey,
          },
          context.signal,
        ),
      ),
  });

  registry.register({
    name: 'storage.read_asset',
    description: 'Create a short-lived download target for an authorized object.',
    input: z.object({
      objectKey: z.string().min(1).max(1_024),
      expiresInSeconds: z.number().int().min(60).max(3_600),
    }),
    risk: 'low',
    sideEffect: 'none',
    reversible: true,
    supportsIdempotency: true,
    autoExecute: true,
    execute: ({ objectKey, expiresInSeconds }, context) =>
      callProvider(() =>
        suite.storage.createDownloadTarget(
          context.companyId,
          scopeStorageObjectKey(context.companyId, objectKey),
          expiresInSeconds,
          context.signal,
        ),
      ),
  });

  registry.register({
    name: 'accounting.export_invoice',
    description: 'Generate a QuickBooks-ready CSV without mutating QuickBooks.',
    input: z.object({
      invoiceNumber: z.string().min(1).max(100),
      customerName: z.string().min(1).max(500),
      customerEmail: z.string().email().optional(),
      issuedDate: z.string().min(1),
      dueDate: z.string().min(1),
      lines: z.array(checkoutLineSchema).min(1).max(100),
      tax: moneySchema,
    }),
    risk: 'low',
    sideEffect: 'none',
    reversible: true,
    supportsIdempotency: true,
    autoExecute: true,
    execute: (input, context) =>
      callProvider(() =>
        suite.accounting.exportInvoice(
          { ...input, idempotencyKey: context.idempotencyKey },
          context.signal,
        ),
      ),
  });

  return registry;
}

export function createSandboxOfficeToolRegistry(suite: IntegrationSuite): OfficeToolRegistry {
  return registerIntegrationOfficeTools(new OfficeToolRegistry(), suite);
}
