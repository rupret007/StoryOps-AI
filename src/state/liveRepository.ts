import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js';
import { z } from 'zod';
import {
  companyConfigurationRecordSchema,
  type CompanyConfiguration,
  type CompanyConfigurationPublicationMode,
  type CompanyConfigurationRecord,
} from '@/domain/companyConfiguration';
import type {
  AppRole,
  CustomerCompletedWork,
  CustomerCommercialPortal,
  CustomerCommunicationPreferences,
  CustomerCommunicationPreferencesInput,
  CustomerPortalRequest,
  CustomerPortalRequestInput,
  CustomerPortalServiceOption,
  LiveAuditFeed,
  SandboxSetupInput,
} from './model';
import {
  buildCompanyConfigurationCommand,
  companyConfigurationReceiptSchema,
  type CompanyConfigurationReceipt,
} from './companyConfiguration';
import {
  buildOperatingBaselineCommand,
  operatingBaselineReceiptSchema,
  operatingBaselineStateSchema,
  type OperatingBaselineReceipt,
  type OperatingBaselineState,
} from './operatingBaseline';
import {
  buildCompanyLaunchAuthorizationCommand,
  buildProviderActivationCommand,
  companyLaunchAuthorizationReceiptSchema,
  providerActivationReceiptSchema,
  providerLaunchStateSchema,
  type CompanyLaunchAuthorizationInput,
  type CompanyLaunchAuthorizationReceipt,
  type ProviderActivationInput,
  type ProviderActivationReceipt,
  type ProviderLaunchState,
} from './providerLaunch';
import {
  liveEstimateContextSchema,
  liveEstimateReceiptSchema,
  type LiveEstimateContext,
  type LiveEstimateReceipt,
  type LiveEstimateRequest,
} from './liveEstimating';
import {
  assertScopePhotoFile,
  confirmedScopeMeasurementSchema,
  finalizedScopePhotoUploadSchema,
  preparedScopePhotoUploadSchema,
  reviewedScopePhotoRequestSchema,
  scopePhotoContextSchema,
  scopePhotoRequestReceiptSchema,
  sha256File,
  type ScopePhotoContext,
} from '@/core/scopePhotos/contracts';
import {
  canonicalLiveSetupPayload,
  liveSetupReceiptSchema,
  liveSetupStateSchema,
  stableLiveSetupCommandId,
  type LiveSetupReceipt,
  type LiveSetupState,
} from './liveSetup';
import {
  liveProfitabilityKpisSchema,
  type LiveProfitabilityKpis,
} from '@/core/finance/profitability';
import {
  dispatchOriginRetentionProjectionSchema,
  type DispatchOriginRetentionProjection,
} from '@/core/integrations/dispatchOriginRetention';
import {
  outboundWorkerHealthProjectionSchema,
  type OutboundWorkerHealthProjection,
} from '@/core/integrations/outboundWorkerHealth';
import {
  buildLiveAiOfficeRequest,
  liveAiOfficeRecentSchema,
  liveAiOfficeRunResponseSchema,
  type DurableAiOfficeRun,
  type LiveAiOfficeRecent,
  type LiveAiOfficeRunInput,
} from '@/core/ai/liveOffice';
import {
  buildCompanyOperationalStatusCommand,
  companyControlReceiptSchema,
  companyControlStateSchema,
  type CompanyControlReceipt,
  type CompanyControlState,
  type CompanyOperationalStatusCommandInput,
} from './companyControl';
import {
  buildPilotReleaseEvidenceCommand,
  pilotReleaseEvidenceReceiptSchema,
  pilotReleaseEvidenceStateSchema,
  type PilotReleaseEvidenceInput,
  type PilotReleaseEvidenceReceipt,
  type PilotReleaseEvidenceState,
} from '@/core/pilot/releaseEvidence';
import {
  buildRecurringDueEstimateCommand,
  buildRecurringDueWorkCommand,
  recurringDueEstimateReceiptSchema,
  recurringDueWorkReceiptSchema,
  recurringDueWorkStateSchema,
  type AttachRecurringDueEstimateInput,
  type CreateRecurringDueWorkInput,
  type RecurringDueEstimateReceipt,
  type RecurringDueWorkReceipt,
  type RecurringDueWorkState,
} from '@/core/recurring/dueWork';
import {
  finalizedSdsRegistrationReceiptSchema,
  materialSdsRegistryStateSchema,
  normalizeSdsRegistrationMetadata,
  preparedSdsRegistrationReceiptSchema,
  reviewedSdsPdfChecksum,
  sdsRegistrationRequestHashMaterial,
  sdsUploadAttestationReceiptSchema,
  type FinalizedSdsRegistrationReceipt,
  type MaterialSdsRegistryState,
  type RegisterMaterialSdsInput,
} from '@/core/materials/sdsRegistry';
import {
  buildDispatchClearanceConsumption,
  dispatchClearanceConsumptionSchema,
  dispatchClearanceIdempotencyKey,
  dispatchClearanceResponseSchema,
  type DispatchClearanceConsumption,
  type DispatchClearanceResult,
} from '@/core/scheduling/dispatchClearance';
import {
  assertDispatchCurrentOriginFresh,
  type DispatchCurrentOrigin,
} from '@/core/scheduling/dispatchOrigin';
import {
  schedulingSuggestionsResponseSchema,
  type SchedulingSuggestionsResponse,
} from '@/core/scheduling/suggestions';
import type {
  IdentityProvisioningInput,
  IdentityProvisioningReceipt,
  IdentityProvisioningState,
} from '@/core/identity/provisioning';
import {
  buildCustomerPropertyCreateRequest,
  customerPropertyCreateReceiptSchema,
  propertyGeocodeCandidatesReceiptSchema,
  propertyGeocodeConfirmationHashPayload,
  propertyGeocodeConfirmationReceiptSchema,
  propertyGeocodeLookupRequestSchema,
  type CreateCustomerPropertyInput,
  type CustomerPropertyCreateReceipt,
  type PropertyGeocodeCandidatesReceipt,
  type PropertyGeocodeConfirmationReceipt,
} from '@/core/properties/contracts';
import { sha256Hex as canonicalSha256Hex } from '@/core/ai/approval';
import {
  incidentPausePayloadSchema,
  incidentPauseReceiptSchema,
  type IncidentPauseReceipt,
} from '@/core/incidents/contracts';
import { TrustedIdentityProvisioningClient } from './identityProvisioningClient';

export const LIVE_WORKSPACE_SCHEMA_VERSION = 'storyops-workspace-v1';

const appRoleSchema = z.enum(['owner', 'dispatcher', 'technician', 'customer']);

const paymentAllocationConflictSchema = z
  .object({
    id: z.string().uuid(),
    paymentId: z.string().uuid(),
    invoiceId: z.string().uuid(),
    invoiceNumber: z.string().min(1).max(120),
    customerId: z.string().uuid(),
    providerEventId: z.string().uuid(),
    conflictCode: z.enum([
      'stale_invoice_version',
      'invoice_not_payable',
      'provider_overpayment',
      'provider_underpayment',
      'local_payment_amount_mismatch',
      'retired_checkout_succeeded',
    ]),
    intendedAmount: z.string().regex(/^[0-9]+\.[0-9]{2}$/u),
    verifiedAmount: z.string().regex(/^[0-9]+\.[0-9]{2}$/u),
    invoiceBalanceAtEvent: z.string().regex(/^[0-9]+\.[0-9]{2}$/u),
    providerCheckoutId: z
      .string()
      .regex(/^cs_[A-Za-z0-9_]+$/u)
      .nullable(),
    providerPaymentId: z.string().regex(/^pi_[A-Za-z0-9_]+$/u),
    providerOccurredAt: z.string().datetime({ offset: true }),
    approvalRequestId: z.string().uuid().nullable(),
    status: z.literal('open'),
    createdAt: z.string().datetime({ offset: true }),
    version: z.number().int().positive(),
    resolutionAction: z.enum([
      'payment.allocation.apply_exact_current_balance',
      'payment.allocation.review_manual',
    ]),
    canApplyExactCurrentBalance: z.boolean(),
    nextAction: z.string().min(1).max(1000),
  })
  .strict()
  .transform((conflict) => ({
    ...conflict,
    providerCheckoutId: conflict.providerCheckoutId ?? undefined,
    approvalRequestId: conflict.approvalRequestId ?? undefined,
  }));

const workspaceSchema = z
  .object({
    schemaVersion: z.literal(LIVE_WORKSPACE_SCHEMA_VERSION),
    serverTime: z.string(),
    session: z.object({
      userId: z.string().uuid(),
      companyId: z.string().uuid(),
      role: appRoleSchema,
    }),
    company: z.object({
      id: z.string().uuid(),
      name: z.string(),
      timezone: z.string(),
      currency: z.string(),
      status: z.string(),
      settings: z.record(z.string(), z.unknown()),
      version: z.number().int().nonnegative(),
    }),
    paymentAllocationConflicts: z.array(paymentAllocationConflictSchema).optional(),
    depositEvidence: z
      .array(
        z
          .object({
            quoteId: z.string().uuid(),
            jobId: z.string().uuid().nullable(),
            invoiceId: z.string().uuid().nullable(),
            paymentId: z.string().uuid().nullable(),
            required: z.string().regex(/^\d+\.\d{2}$/u),
            verified: z.string().regex(/^\d+\.\d{2}$/u),
            providerProof: z.boolean(),
            ready: z.boolean(),
          })
          .strict(),
      )
      .optional(),
  })
  .passthrough();

const transactionalDeliveryCommandReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-transactional-delivery-command-v1'),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    attemptId: z.string().uuid(),
    action: z.enum(['quote.delivery', 'visit.on_my_way']),
    entityId: z.string().uuid(),
    entityVersion: z.number().int().positive(),
    channel: z.enum(['sms', 'email']),
    status: z.literal('queued'),
    portalPublicationAsserted: z.boolean(),
    providerSubmissionAsserted: z.literal(false),
    externalDeliveryClaimed: z.literal(false),
    replayed: z.boolean(),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export type TransactionalDeliveryCommandReceipt = z.infer<
  typeof transactionalDeliveryCommandReceiptSchema
>;

const customerPortalRequestSchema = z
  .object({
    id: z.string().uuid(),
    customerId: z.string().uuid(),
    propertyId: z.string().uuid(),
    requestType: z.enum(['reschedule', 'additional_service']),
    status: z.enum(['submitted', 'reviewing', 'resolved', 'cancelled']),
    visitId: z.string().uuid().nullable(),
    normalizedLeadId: z.string().uuid().nullable(),
    preferredStartDate: z.string().nullable(),
    preferredEndDate: z.string().nullable(),
    requestedServiceCodes: z.array(z.string().min(1)),
    requestNotes: z.string(),
    resolutionNote: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    version: z.number().int().positive(),
  })
  .strict()
  .transform((request): CustomerPortalRequest => ({
    ...request,
    visitId: request.visitId ?? undefined,
    normalizedLeadId: request.normalizedLeadId ?? undefined,
    preferredStartDate: request.preferredStartDate ?? undefined,
    preferredEndDate: request.preferredEndDate ?? undefined,
    resolutionNote: request.resolutionNote ?? undefined,
  }));

const customerCommunicationPreferencesSchema = z
  .object({
    customerId: z.string().uuid(),
    transactionalSms: z.boolean(),
    transactionalEmail: z.boolean(),
    marketingSms: z.boolean(),
    marketingEmail: z.boolean(),
    globalOptOut: z.boolean(),
    disclosureVersion: z.string().min(1),
    updatedAt: z.string().nullable(),
    version: z.number().int().nonnegative(),
  })
  .strict()
  .transform((preferences): CustomerCommunicationPreferences => ({
    ...preferences,
    updatedAt: preferences.updatedAt ?? undefined,
  }));

const customerPortalServiceOptionSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
  })
  .strict()
  .transform((option): CustomerPortalServiceOption => option);

const customerCommercialQuoteSchema = z
  .object({
    id: z.string().uuid(),
    quoteNumber: z.string().min(1),
    estimateId: z.string().uuid(),
    propertyId: z.string().uuid(),
    status: z.enum(['sent', 'viewed', 'accepted', 'declined', 'change_requested', 'expired']),
    validUntil: z.string(),
    termsVersion: z.string().min(1),
    termsSnapshot: z.string(),
    total: z.string().regex(/^\d+\.\d{2}$/u),
    depositRequired: z.string().regex(/^\d+\.\d{2}$/u),
    portalPublishedAt: z.string(),
    deliveryStatus: z.literal('not_asserted'),
    acceptedAt: z.string().nullable(),
    version: z.number().int().positive(),
    lines: z.array(
      z
        .object({
          lineKind: z.string().min(1),
          serviceCode: z.string().nullable(),
          addOnCode: z.string().nullable(),
          description: z.string().min(1),
          quantity: z.string(),
          unit: z.string().min(1),
          subtotal: z.string().regex(/^\d+\.\d{2}$/u),
          sortOrder: z.number().int().nonnegative(),
        })
        .strict()
        .transform((line) => ({
          ...line,
          serviceCode: line.serviceCode ?? undefined,
          addOnCode: line.addOnCode ?? undefined,
        })),
    ),
  })
  .strict()
  .transform((quote) => ({
    ...quote,
    acceptedAt: quote.acceptedAt ?? undefined,
  }));

const customerCommercialPortalSchema = z
  .object({
    quote: customerCommercialQuoteSchema.nullable(),
    addOnOptions: z.array(
      z
        .object({
          selectionCode: z.string().min(3),
          serviceCode: z.string().min(1),
          code: z.string().min(1),
          name: z.string().min(1),
        })
        .strict(),
    ),
    changeRequests: z.array(
      z
        .object({
          id: z.string().uuid(),
          quoteId: z.string().uuid(),
          quoteVersion: z.number().int().positive(),
          requestedServiceCodes: z.array(z.string().min(1)),
          requestedAddOnCodes: z.array(z.string().min(1)),
          requestNotes: z.string(),
          status: z.enum(['submitted', 'reviewing', 'resolved', 'cancelled']),
          createdAt: z.string(),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
    invoices: z.array(
      z
        .object({
          id: z.string().uuid(),
          invoiceNumber: z.string().min(1),
          jobId: z.string().uuid(),
          status: z.enum(['open', 'past_due', 'paid']),
          issueDate: z.string(),
          dueDate: z.string(),
          total: z.string().regex(/^\d+\.\d{2}$/u),
          amountPaid: z.string().regex(/^\d+\.\d{2}$/u),
          balanceDue: z.string().regex(/^\d+\.\d{2}$/u),
          version: z.number().int().positive(),
          paymentReconciliationRequired: z.boolean(),
          paymentReconciliationMessage: z.string().min(1).max(500).nullable(),
        })
        .strict()
        .transform((invoice) => ({
          ...invoice,
          paymentReconciliationMessage: invoice.paymentReconciliationMessage ?? undefined,
        })),
    ),
    paymentReconciliationRequired: z.boolean(),
    paymentReconciliationMessage: z.string().min(1).max(500).nullable(),
    depositEvidence: z
      .object({
        quoteId: z.string().uuid(),
        required: z.string().regex(/^\d+\.\d{2}$/u),
        verified: z.string().regex(/^\d+\.\d{2}$/u),
        ready: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .transform((portal): CustomerCommercialPortal => ({
    ...portal,
    quote: portal.quote ?? undefined,
    depositEvidence: portal.depositEvidence ?? undefined,
    paymentReconciliationMessage: portal.paymentReconciliationMessage ?? undefined,
  }));

const customerCompletedWorkSchema = z
  .object({
    visitId: z.string().uuid(),
    jobId: z.string().uuid(),
    jobNumber: z.string().min(1).max(120),
    propertyId: z.string().uuid(),
    serviceCodes: z.array(z.string().min(1).max(80)),
    completedAt: z.string().datetime({ offset: true }),
    media: z.array(
      z
        .object({
          id: z.string().uuid(),
          purpose: z.enum(['before', 'after']),
          objectPath: z.string().min(1).max(1_024),
          contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
          byteSize: z
            .number()
            .int()
            .min(1)
            .max(15 * 1024 * 1024),
          checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          capturedAt: z.string().datetime({ offset: true }),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict()
  .transform((work): CustomerCompletedWork => ({
    ...work,
    media: work.media.map((media) => ({
      ...media,
      visitId: work.visitId,
      jobId: work.jobId,
    })),
  }));

const customerPortalStateSchema = z
  .object({
    schemaVersion: z.literal('storyops-customer-portal-state-v2'),
    companyId: z.string().uuid(),
    serverTime: z.string(),
    customers: z.array(
      z
        .object({
          customerId: z.string().uuid(),
          requests: z.array(customerPortalRequestSchema),
          preferences: customerCommunicationPreferencesSchema,
          serviceOptions: z.array(customerPortalServiceOptionSchema),
          commercial: customerCommercialPortalSchema,
          completedWork: z.array(customerCompletedWorkSchema).optional().default([]),
        })
        .strict(),
    ),
  })
  .strict();

export type CustomerPortalState = z.infer<typeof customerPortalStateSchema>;

const customerPortalRequestReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-customer-portal-request-v1'),
    companyId: z.string().uuid(),
    customerId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    requestId: z.string().uuid(),
    requestType: z.enum(['reschedule', 'additional_service']),
    status: z.literal('submitted'),
    normalizedLeadId: z.string().uuid().nullable(),
    visitChanged: z.literal(false),
    replayed: z.boolean(),
    serverTime: z.string(),
  })
  .strict();

export type CustomerPortalRequestReceipt = z.infer<typeof customerPortalRequestReceiptSchema>;

const customerCommunicationPreferencesReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-customer-communication-preferences-v1'),
    companyId: z.string().uuid(),
    customerId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    preferencesVersion: z.number().int().positive(),
    consentRecordIds: z.array(z.string().uuid()).length(4),
    globalOptOut: z.boolean(),
    replayed: z.boolean(),
    serverTime: z.string(),
  })
  .strict();

export type CustomerCommunicationPreferencesReceipt = z.infer<
  typeof customerCommunicationPreferencesReceiptSchema
>;

const customerQuoteActionReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-customer-quote-action-v1'),
    companyId: z.string().uuid(),
    customerId: z.string().uuid(),
    commandId: z.string().uuid(),
    action: z.enum(['quote.view', 'quote.decline', 'quote.change_request']),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    quoteId: z.string().uuid(),
    quoteVersion: z.number().int().positive(),
    quoteStatus: z.enum(['viewed', 'declined', 'change_requested']),
    priceChanged: z.literal(false),
    termsChanged: z.literal(false),
    accepted: z.literal(false),
    deliveryAsserted: z.literal(false),
    replayed: z.boolean(),
    serverTime: z.string(),
    changeRequestId: z.string().uuid().optional(),
  })
  .strict();

export type CustomerQuoteActionReceipt = z.infer<typeof customerQuoteActionReceiptSchema>;

const customerQuoteAcceptanceReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-customer-quote-acceptance-v1'),
    companyId: z.string().uuid(),
    customerId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    quoteId: z.string().uuid(),
    expectedQuoteVersion: z.number().int().positive(),
    quoteVersion: z.number().int().positive(),
    termsVersion: z.string().min(1).max(160),
    total: z.string().regex(/^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/u),
    signerName: z.string().min(2).max(120),
    acknowledged: z.literal(true),
    acceptedAt: z.string().datetime({ offset: true }),
    acceptanceContextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    replayed: z.boolean(),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export type CustomerQuoteAcceptanceReceipt = z.infer<typeof customerQuoteAcceptanceReceiptSchema>;

const liveAuditFeedSchema = z
  .object({
    schemaVersion: z.literal('storyops-audit-feed-v1'),
    companyId: z.string().uuid(),
    events: z.array(
      z
        .object({
          id: z.string().uuid(),
          occurredAt: z.string().datetime({ offset: true }),
          actorType: z.string().min(1).max(80),
          actorRef: z.string().min(3).max(120),
          action: z.string().min(1).max(160),
          entityType: z.string().min(1).max(160),
          entityId: z.string().uuid().nullable(),
          requestId: z.string().max(160).nullable(),
          traceId: z.string().max(160).nullable(),
          hasBefore: z.boolean(),
          hasAfter: z.boolean(),
          retentionClass: z.string().min(1).max(80),
          retainUntil: z.string().datetime({ offset: true }).nullable(),
          legalHold: z.boolean(),
        })
        .strict()
        .transform((event) => ({
          ...event,
          entityId: event.entityId ?? undefined,
          requestId: event.requestId ?? undefined,
          traceId: event.traceId ?? undefined,
          retainUntil: event.retainUntil ?? undefined,
        })),
    ),
    hasMore: z.boolean(),
    nextCursor: z
      .object({
        occurredAt: z.string().datetime({ offset: true }),
        id: z.string().uuid(),
      })
      .strict()
      .nullable(),
    pageLimit: z.number().int().min(1).max(100),
    redacted: z.literal(true),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict()
  .transform((feed): LiveAuditFeed => ({
    ...feed,
    nextCursor: feed.nextCursor ?? undefined,
  }));

const quoteChangeResolutionReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-quote-change-resolution-v1'),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestId: z.string().uuid(),
    requestVersion: z.number().int().positive(),
    disposition: z.enum(['replacement_published', 'cancelled']),
    replacementQuoteId: z.string().uuid().nullable(),
    replacementQuoteVersion: z.number().int().positive().nullable(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    replayed: z.boolean(),
    serverTime: z.string(),
  })
  .strict();

const paymentAllocationResolutionReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-payment-allocation-resolution-v1'),
    status: z.literal('applied'),
    companyId: z.string().uuid(),
    conflictId: z.string().uuid(),
    conflictVersion: z.number().int().positive(),
    paymentId: z.string().uuid(),
    paymentVersion: z.number().int().positive(),
    invoiceId: z.string().uuid(),
    invoiceVersion: z.number().int().positive(),
    approvalRequestId: z.string().uuid(),
    amount: z.string().regex(/^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/u),
    serverTime: z.string().datetime({ offset: true }),
  })
  .strict();

export type PaymentAllocationResolutionReceipt = z.infer<
  typeof paymentAllocationResolutionReceiptSchema
>;

const fieldReferenceSchema = z
  .object({
    materials: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string().min(1),
          unit: z.string().min(1),
          requiresSds: z.boolean(),
          version: z.number().int().positive(),
          sdsDocument: z
            .object({
              id: z.string().uuid(),
              productName: z.string().min(1),
              manufacturer: z.string().min(1),
              revisionDate: z.string().min(1),
              reviewedAt: z.string().nullable(),
              checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
              storageObjectPath: z.string().min(1),
              version: z.number().int().positive(),
              documentVersion: z.number().int().positive().optional(),
              contentType: z.literal('application/pdf').optional(),
              byteSize: z
                .number()
                .int()
                .min(1)
                .max(10 * 1024 * 1024)
                .optional(),
              configurationRevision: z.number().int().positive().optional(),
              configurationHash: z
                .string()
                .regex(/^[a-f0-9]{64}$/u)
                .optional(),
              baselineId: z.string().uuid().nullable().optional(),
              baselineHash: z
                .string()
                .regex(/^[a-f0-9]{64}$/u)
                .nullable()
                .optional(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    checklistDefinitions: z.array(
      z
        .object({
          id: z.string().uuid(),
          templateId: z.string().uuid(),
          label: z.string().min(1),
          itemKind: z.enum(['boolean', 'text', 'number', 'photo', 'signature']),
          required: z.boolean(),
          safetyCritical: z.boolean(),
          sortOrder: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    fieldIncidents: z.array(
      z
        .object({
          id: z.string().uuid(),
          visitId: z.string().uuid().nullable(),
          jobId: z.string().uuid().nullable(),
          incidentNumber: z.string().min(1),
          severity: z.enum(['near_miss', 'minor', 'serious', 'critical']),
          status: z.enum(['open', 'investigating', 'corrective_action', 'closed']),
          category: z.enum([
            'injury',
            'property_damage',
            'chemical',
            'vehicle',
            'environmental',
            'other',
          ]),
          reportedAt: z.string().min(1),
          summary: z.string().min(1),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
    fieldPackets: z
      .array(
        z
          .object({
            visitId: z.string().uuid(),
            visitVersion: z.number().int().positive(),
            jobId: z.string().uuid(),
            jobNumber: z.string().min(1).max(120),
            quoteId: z.string().uuid(),
            propertyId: z.string().uuid(),
            scopeLines: z.array(
              z
                .object({
                  id: z.string().uuid(),
                  lineKind: z.enum(['service', 'add_on']),
                  serviceCode: z.string().nullable(),
                  addOnCode: z.string().nullable(),
                  description: z.string().min(1).max(500),
                  quantity: z.string().min(1),
                  unit: z.string().min(1).max(80),
                  sortOrder: z.number().int().nonnegative(),
                })
                .strict(),
            ),
            exclusions: z.array(z.string().min(1).max(500)),
            exclusionsStatus: z.enum(['recorded', 'not_recorded']),
            access: z
              .object({
                instructions: z.string().nullable(),
                waterSourceNotes: z.string().nullable(),
                drainageNotes: z.string().nullable(),
                knownHazards: z.array(z.string().min(1).max(500)),
              })
              .strict(),
            routeEvidence: z
              .object({
                id: z.string().uuid(),
                provider: z.enum(['vroom', 'mock']),
                evidenceMode: z.enum(['live', 'sandbox']),
                checkedAt: z.string().datetime({ offset: true }),
                driveMinutes: z.number().int().nonnegative(),
                distanceMiles: z.string().regex(/^\d+\.\d{2}$/u),
                routeFeasible: z.boolean(),
                violations: z.array(z.string().max(500)),
                freshness: z.enum(['current', 'stale']),
              })
              .strict()
              .nullable(),
            weatherEvidence: z
              .object({
                id: z.string().uuid(),
                provider: z.enum(['nws', 'mock']),
                evidenceMode: z.enum(['live', 'sandbox']),
                forecastIssuedAt: z.string().datetime({ offset: true }),
                checkedAt: z.string().datetime({ offset: true }),
                periodStartsAt: z.string().datetime({ offset: true }),
                periodEndsAt: z.string().datetime({ offset: true }),
                temperatureF: z.string().regex(/^-?\d+\.\d{2}$/u),
                precipitationProbability: z.string().regex(/^\d+\.\d{4}$/u),
                windSpeedMph: z.string().regex(/^\d+\.\d{2}$/u),
                lightningRisk: z.enum(['none', 'low', 'elevated', 'severe', 'unknown']),
                conditionCodes: z.array(z.string().max(120)),
                policyDisposition: z.enum(['eligible', 'requires_approval', 'unavailable']),
                freshness: z.enum(['current', 'stale']),
              })
              .strict()
              .nullable(),
            evidence: z.array(
              z
                .object({
                  id: z.string().uuid(),
                  purpose: z.enum(['before', 'after']),
                  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
                  byteSize: z
                    .number()
                    .int()
                    .min(1)
                    .max(15 * 1024 * 1024),
                  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
                  capturedAt: z.string().datetime({ offset: true }),
                  syncState: z.enum(['pending', 'synced', 'failed']),
                  customerVisible: z.boolean(),
                })
                .strict(),
            ),
            changeRequests: z.array(
              z
                .object({
                  id: z.string().uuid(),
                  reasonCode: z.enum([
                    'scope_mismatch',
                    'access_blocked',
                    'customer_request',
                    'site_condition',
                    'other',
                  ]),
                  summary: z.string().min(10).max(2_000),
                  status: z.enum(['submitted', 'reviewing', 'resolved', 'cancelled']),
                  createdAt: z.string().datetime({ offset: true }),
                  version: z.number().int().positive(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional()
      .default([]),
  })
  .strict();

export type LiveWorkspace = z.infer<typeof workspaceSchema> & {
  companyConfiguration?: CompanyConfigurationRecord;
  operatingBaseline?: OperatingBaselineState;
  providerLaunch?: ProviderLaunchState;
  pilotReleaseEvidence?: PilotReleaseEvidenceState;
  recurringDueWork?: RecurringDueWorkState;
  materialSdsRegistry?: MaterialSdsRegistryState;
  customerPortal?: CustomerPortalState;
  profitabilityKpis?: LiveProfitabilityKpis;
  aiOfficeRecent?: LiveAiOfficeRecent;
  auditFeed?: LiveAuditFeed;
};

export interface LiveAiOfficeInvocation {
  run: DurableAiOfficeRun;
  recent: LiveAiOfficeRecent;
  recoveredFromReadback: boolean;
}

export type StoryOpsCommandType =
  | 'lead.create'
  | 'lead.qualify'
  | 'lead.link_scope'
  | 'customer.create'
  | 'property.create'
  | 'quote.send'
  | 'quote.accept'
  | 'visit.transition'
  | 'visit.notes.update'
  | 'checklist.record'
  | 'time.start'
  | 'time.stop'
  | 'material.record'
  | 'field.change_request'
  | 'media.register'
  | 'signature.capture'
  | 'incident.report'
  | 'incident.report_pause'
  | 'incident.close'
  | 'notification.read'
  | 'approval.decide';

export type StoryOpsGoldenPathCommandType = 'job.book' | 'invoice.issue';

export interface StoryOpsCommand {
  commandId: string;
  commandType: StoryOpsCommandType;
  expectedVersion: number;
  payload: Record<string, unknown>;
  requestHash: string;
}

export interface StoryOpsGoldenPathCommand {
  commandId: string;
  commandType: StoryOpsGoldenPathCommandType;
  expectedVersion: number;
  payload: Record<string, unknown>;
  requestHash: string;
}

export type CustomerPortalCommandType =
  | 'portal.reschedule.request'
  | 'portal.additional_service.request'
  | 'portal.communication_preferences.update';

export interface CustomerPortalCommand {
  commandId: string;
  commandType: CustomerPortalCommandType;
  payload: Record<string, unknown>;
  canonicalRequest: string;
  requestHash: string;
}

export interface StoryOpsCommandResult {
  commandId: string;
  commandType: StoryOpsCommandType | StoryOpsGoldenPathCommandType;
  status: 'applied';
  replayed: boolean;
  entityId: string;
  version: number;
  requestHash: string;
  serverTime: string;
}

export interface PreparedVisitMedia {
  assetId: string;
  visitId: string;
  incidentId?: string;
  purpose: 'before' | 'after' | 'signature' | 'incident' | 'safety' | 'damage';
  blob: Blob;
  filename: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  objectPath: string;
  checksumSha256: string;
  byteSize: number;
  capturedAt: string;
}

export interface LiveRepositoryConfig {
  requested: boolean;
  mode: 'sandbox' | 'supabase';
  url?: string;
  anonKey?: string;
  companyId?: string;
  configurationError?: string;
}

export interface IntegrationHealthResult {
  overall: 'healthy' | 'not_configured' | 'degraded' | 'down';
  checkedAt: string;
  dispatchOriginRetention: DispatchOriginRetentionProjection;
  outboundWorkers: OutboundWorkerHealthProjection;
  providers: Array<{
    id?: string;
    provider: string;
    capability: string;
    mode: string;
    status: 'healthy' | 'not_configured' | 'degraded' | 'down';
    checkedAt?: string;
    message?: string;
  }>;
}

export interface ApprovedActionExecutionResult {
  approvalId: string;
  actionId: string;
  toolName: string;
  status: 'succeeded';
  completedAt: string;
  replayed: boolean;
}

export interface DepositCheckoutResult {
  action: 'deposit.checkout';
  status: 'checkout_open' | 'not_required' | 'already_verified';
  mode: 'live' | 'sandbox' | 'none';
  quoteId: string;
  jobId: string;
  invoiceId: string;
  amount: string;
  currency: 'USD';
  paymentVerified: boolean;
  depositReady: boolean;
  replayed: boolean;
  checkoutId?: string;
  checkoutUrl?: string;
  sandboxReceipt?: string;
}

export interface InvoiceCheckoutResult {
  action: 'invoice.checkout';
  status: 'checkout_open';
  mode: 'live' | 'sandbox';
  quoteId: string;
  jobId: string;
  invoiceId: string;
  invoiceVersion: number;
  amount: string;
  currency: 'USD';
  paymentVerified: false;
  invoicePaid: false;
  replayed: boolean;
  checkoutId: string;
  checkoutUrl?: string;
  sandboxReceipt?: string;
}

const schedulingEvidenceReceiptSchema = z
  .object({
    schemaVersion: z.literal('storyops-scheduling-evidence-v1'),
    receiptId: z.string().uuid(),
    companyId: z.string().uuid(),
    jobId: z.string().uuid(),
    jobVersion: z.number().int().positive(),
    propertyId: z.string().uuid(),
    crewId: z.string().uuid(),
    crewVersion: z.number().int().positive(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    evidenceMode: z.literal('live'),
    configurationRevision: z.number().int().positive(),
    operatingBaselinePublicationId: z.string().uuid(),
    capacityDisposition: z.literal('eligible'),
    routeDisposition: z.literal('eligible'),
    weatherDisposition: z.literal('eligible'),
    calendarEventId: z.string().min(1).max(500),
    routeCheckId: z.string().uuid(),
    weatherCheckId: z.string().uuid(),
    unknowns: z.array(z.string()).max(20),
    conflicts: z.array(z.unknown()).max(20),
    expiresAt: z.string().datetime({ offset: true }),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.string().datetime({ offset: true }),
    replayed: z.boolean(),
  })
  .strict();

const schedulingEvidenceResponseSchema = z
  .object({
    operation: z.literal('scheduling.evidence'),
    mode: z.enum(['live', 'sandbox', 'disabled']),
    status: z.enum(['ready_to_book', 'not_bookable']),
    bookable: z.boolean(),
    reasonCode: z.string().regex(/^[A-Z0-9_]{3,100}$/u),
    message: z.string().min(1).max(500),
    companyId: z.string().uuid(),
    jobId: z.string().uuid(),
    jobVersion: z.number().int().positive(),
    window: z
      .object({
        start: z.string().datetime({ offset: true }),
        end: z.string().datetime({ offset: true }),
      })
      .strict(),
    crewId: z.string().uuid().optional(),
    receipt: schedulingEvidenceReceiptSchema.optional(),
  })
  .strict();

export type SchedulingEvidenceResult = z.infer<typeof schedulingEvidenceResponseSchema>;

const postServiceStatusSchema = z
  .object({
    schemaVersion: z.literal('storyops-post-service-status-v1'),
    companyId: z.string().uuid(),
    serverTime: z.string(),
    followups: z.array(
      z
        .object({
          id: z.string().uuid(),
          invoiceId: z.string().uuid(),
          jobId: z.string().uuid(),
          customerId: z.string().uuid(),
          propertyId: z.string().uuid(),
          action: z.enum(['review.request', 'referral.invite', 'maintenance.reminder']),
          domainRecordId: z.string().uuid(),
          channel: z.enum(['sms', 'email']),
          status: z.enum([
            'queued',
            'submitted',
            'reconciliation_required',
            'submitted_unknown',
            'completed',
            'sandboxed',
            'failed',
            'cancelled',
          ]),
          scheduledAt: z.string(),
          providerMode: z.enum(['sandbox', 'live']).nullable().optional(),
          providerStatus: z
            .enum([
              'accepted',
              'queued',
              'sent',
              'delivered',
              'failed',
              'submission_unknown',
              'sandbox_recorded',
            ])
            .nullable()
            .optional(),
          manualReconciliationRequired: z.boolean(),
          externalDeliveryClaimed: z.boolean().optional(),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
    maintenancePlans: z.array(
      z
        .object({
          id: z.string().uuid(),
          invoiceId: z.string().uuid(),
          jobId: z.string().uuid(),
          customerId: z.string().uuid(),
          propertyId: z.string().uuid(),
          status: z.literal('active'),
          cadence: z.enum([
            'weekly',
            'biweekly',
            'every_four_weeks',
            'monthly',
            'quarterly',
            'semiannual',
            'annual',
            'custom',
          ]),
          nextDueDate: z.string(),
          serviceCodes: z.array(z.string().min(1)),
          requiresFreshEstimate: z.literal(true),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export type PostServiceActionInput =
  | {
      action: 'review.request' | 'referral.invite';
      invoiceId: string;
      expectedVersion: number;
      channel: 'sms' | 'email';
      commandId?: string;
    }
  | {
      action: 'maintenance.activate';
      invoiceId: string;
      expectedVersion: number;
      cadence:
        | 'weekly'
        | 'biweekly'
        | 'every_four_weeks'
        | 'monthly'
        | 'quarterly'
        | 'semiannual'
        | 'annual'
        | 'custom';
      intervalDays?: number;
      nextDueDate: string;
      commandId?: string;
    };

export interface PostServiceActionResult {
  schemaVersion: 'storyops-post-service-v1';
  companyId: string;
  action: 'review.request' | 'referral.invite' | 'maintenance.activate';
  commandId: string;
  invoiceId: string;
  invoiceVersion: number;
  jobId: string;
  recordId: string;
  domainRecordId: string;
  status: 'queued' | 'completed' | 'failed' | 'cancelled' | 'active';
  replayed: boolean;
  alreadyExisted: boolean;
  requestHash: string;
  serverTime: string;
  channel?: 'sms' | 'email';
  scheduledAt?: string;
  cadence?:
    | 'weekly'
    | 'biweekly'
    | 'every_four_weeks'
    | 'monthly'
    | 'quarterly'
    | 'semiannual'
    | 'annual'
    | 'custom';
  nextDueDate?: string;
  requiresFreshEstimate?: true;
}

type RepositoryError = {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
  status?: number;
};

export interface StoryOpsSupabaseAdapter {
  auth: {
    getSession(): Promise<{ data: { session: Session | null }; error: RepositoryError | null }>;
    signInWithOtp(input: {
      email: string;
      options: { emailRedirectTo: string };
    }): Promise<{ error: RepositoryError | null }>;
    signOut(): Promise<{ error: RepositoryError | null }>;
    onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
  };
  rpc(
    functionName: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RepositoryError | null }>;
  functions: {
    invoke(
      functionName: string,
      input: { body: Record<string, unknown> },
    ): Promise<{ data: unknown; error: RepositoryError | null }>;
  };
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Blob,
        options: { contentType: string; upsert: boolean },
      ): PromiseLike<{ data: { path: string } | null; error: RepositoryError | null }>;
      uploadToSignedUrl?(
        path: string,
        token: string,
        body: Blob,
        options: { contentType: string },
      ): PromiseLike<{ data: { path: string } | null; error: RepositoryError | null }>;
      download(path: string): PromiseLike<{ data: Blob | null; error: RepositoryError | null }>;
      remove(paths: string[]): PromiseLike<{ error: RepositoryError | null }>;
    };
  };
}

function normalizeMode(value: string | undefined): 'sandbox' | 'supabase' {
  return value === 'supabase' || value === 'live' ? 'supabase' : 'sandbox';
}

function isClearlyPrivilegedKey(value: string): boolean {
  if (value.startsWith('sb_secret_')) return true;
  const payload = value.split('.')[1];
  if (!payload) return false;
  try {
    const normalized = payload.replaceAll('-', '+').replaceAll('_', '/');
    const decoded = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')),
    ) as UnknownRecord;
    return decoded.role === 'service_role';
  } catch {
    return false;
  }
}

type UnknownRecord = Record<string, unknown>;

export function readLiveRepositoryConfig(
  environment: Partial<ImportMetaEnv> = import.meta.env,
): LiveRepositoryConfig {
  const mode = normalizeMode(environment.VITE_STORYOPS_DATA_MODE);
  if (mode === 'sandbox') return { requested: false, mode };

  const url = environment.VITE_SUPABASE_URL?.trim();
  const anonKey = environment.VITE_SUPABASE_ANON_KEY?.trim();
  const companyId = environment.VITE_STORYOPS_COMPANY_ID?.trim();
  const missing = [
    !url && 'VITE_SUPABASE_URL',
    !anonKey && 'VITE_SUPABASE_ANON_KEY',
    !companyId && 'VITE_STORYOPS_COMPANY_ID',
  ].filter(Boolean);
  const invalid = [
    url && !z.string().url().safeParse(url).success && 'VITE_SUPABASE_URL must be an absolute URL',
    companyId &&
      !z.string().uuid().safeParse(companyId).success &&
      'VITE_STORYOPS_COMPANY_ID must be a UUID',
    anonKey &&
      isClearlyPrivilegedKey(anonKey) &&
      'VITE_SUPABASE_ANON_KEY appears to be a privileged secret/service-role key',
  ].filter(Boolean);

  return {
    requested: true,
    mode,
    url,
    anonKey,
    companyId,
    configurationError:
      missing.length > 0
        ? `Live mode requires ${missing.join(', ')}. Browser variables must use the public anon key, never a service-role key.`
        : invalid.length > 0
          ? `${invalid.join('. ')}. Browser variables must use the public anon key only.`
          : undefined,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Command payload cannot contain a non-finite number.');
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function hasUnsafeTextControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 8 ||
      (codePoint >= 11 && codePoint <= 12) ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    );
  });
}

export function canonicalCommandBody(
  commandType: StoryOpsCommandType | StoryOpsGoldenPathCommandType,
  expectedVersion: number,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify(canonicalize({ commandType, expectedVersion, payload }));
}

export async function sha256Hex(contents: string | ArrayBuffer): Promise<string> {
  const bytes =
    typeof contents === 'string' ? new TextEncoder().encode(contents) : new Uint8Array(contents);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function blobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const direct = (blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
  if (typeof direct === 'function') return direct.call(blob);
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('Blob reader did not return binary data.'));
    });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Blob read failed.')));
    reader.readAsArrayBuffer(blob);
  });
}

export async function buildStoryOpsCommand(input: {
  commandType: StoryOpsCommandType;
  expectedVersion: number;
  payload: Record<string, unknown>;
  commandId?: string;
}): Promise<StoryOpsCommand> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('Expected version must be a non-negative integer.');
  }
  const commandId = input.commandId ?? crypto.randomUUID();
  const payload = canonicalize(input.payload) as Record<string, unknown>;
  const requestHash = await sha256Hex(
    canonicalCommandBody(input.commandType, input.expectedVersion, payload),
  );
  return {
    commandId,
    commandType: input.commandType,
    expectedVersion: input.expectedVersion,
    payload,
    requestHash,
  };
}

export async function buildStoryOpsGoldenPathCommand(input: {
  commandType: StoryOpsGoldenPathCommandType;
  expectedVersion: number;
  payload: Record<string, unknown>;
  commandId?: string;
}): Promise<StoryOpsGoldenPathCommand> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error('Golden-path expected version must be a positive integer.');
  }
  const commandId = input.commandId ?? crypto.randomUUID();
  const payload = canonicalize(input.payload) as Record<string, unknown>;
  const requestHash = await sha256Hex(
    canonicalCommandBody(input.commandType, input.expectedVersion, payload),
  );
  return {
    commandId,
    commandType: input.commandType,
    expectedVersion: input.expectedVersion,
    payload,
    requestHash,
  };
}

export async function buildCustomerPortalCommand(input: {
  commandType: CustomerPortalCommandType;
  payload: Record<string, unknown>;
  commandId?: string;
}): Promise<CustomerPortalCommand> {
  const commandId = input.commandId ?? crypto.randomUUID();
  if (!z.string().uuid().safeParse(commandId).success) {
    throw new Error('Customer-portal commands require a UUID idempotency key.');
  }
  const payload = canonicalize(input.payload) as Record<string, unknown>;
  const canonicalRequest = JSON.stringify(
    canonicalize({ commandType: input.commandType, payload }),
  );
  return {
    commandId,
    commandType: input.commandType,
    payload,
    canonicalRequest,
    requestHash: await sha256Hex(canonicalRequest),
  };
}

export type LiveRepositoryFailureKind =
  'authorization_revoked' | 'connectivity_unavailable' | 'other';

export class LiveRepositoryError extends Error {
  readonly name = 'LiveRepositoryError';

  constructor(
    readonly operation: string,
    readonly providerCode: string | undefined,
    readonly providerStatus: number | undefined,
    readonly providerMessage: string,
  ) {
    super(`${operation} failed: ${providerMessage}`);
  }
}

export function classifyLiveRepositoryFailure(error: unknown): LiveRepositoryFailureKind {
  const message =
    error instanceof LiveRepositoryError
      ? error.providerMessage
      : error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : '';
  const providerCode = error instanceof LiveRepositoryError ? (error.providerCode ?? '') : '';
  const providerStatus = error instanceof LiveRepositoryError ? error.providerStatus : undefined;
  if (
    providerStatus === 401 ||
    providerStatus === 403 ||
    ['401', '403', '42501', 'PGRST301', 'PGRST302', 'JWT_EXPIRED', 'INVALID_JWT'].includes(
      providerCode.toUpperCase(),
    ) ||
    /(?:no active company membership|not an active company member|active company membership is required|invalid jwt|jwt expired|permission denied|row-level security|\bunauthorized\b|\bforbidden\b)/iu.test(
      message,
    )
  ) {
    return 'authorization_revoked';
  }
  if (
    /(?:failed to fetch|fetch failed|network request failed|networkerror|load failed|err_network|connection (?:reset|refused|closed)|offline)/iu.test(
      message,
    )
  ) {
    return 'connectivity_unavailable';
  }
  return 'other';
}

export function mutationOutcomeRequiresReconciliation(error: unknown): boolean {
  if (!(error instanceof LiveRepositoryError)) return true;
  if (classifyLiveRepositoryFailure(error) === 'connectivity_unavailable') return true;
  const status = error.providerStatus;
  return status !== undefined && (status >= 500 || [408, 425, 429].includes(status));
}

export function mayUsePersistedLiveWorkspace(error: unknown): boolean {
  return classifyLiveRepositoryFailure(error) === 'connectivity_unavailable';
}

function repositoryError(operation: string, error: RepositoryError): Error {
  return new LiveRepositoryError(operation, error.code, error.status, error.message);
}

function parseBoundAiOfficeRecent(
  value: unknown,
  companyId: string,
  actorUserId: string,
): LiveAiOfficeRecent {
  const recent = liveAiOfficeRecentSchema.parse(value);
  if (
    recent.companyId !== companyId ||
    recent.actorUserId !== actorUserId ||
    recent.runs.some((run) => run.companyId !== companyId || run.actorUserId !== actorUserId)
  ) {
    throw new Error('AI Office readback identity escaped the authenticated workspace.');
  }
  return recent;
}

function commandResult(value: unknown): StoryOpsCommandResult {
  return z
    .object({
      commandId: z.string().uuid(),
      commandType: z.string(),
      status: z.literal('applied'),
      replayed: z.boolean(),
      entityId: z.string().uuid(),
      version: z.number().int().positive(),
      requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
      serverTime: z.string(),
    })
    .transform((result) => result as StoryOpsCommandResult)
    .parse(value);
}

export class LiveStoryOpsRepository {
  constructor(
    private readonly client: StoryOpsSupabaseAdapter,
    readonly companyId: string,
  ) {}

  async getSession(): Promise<Session | null> {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw repositoryError('Session lookup', error);
    return data.session;
  }

  onAuthStateChange(
    callback: (event: AuthChangeEvent, session: Session | null) => void,
  ): () => void {
    const {
      data: { subscription },
    } = this.client.auth.onAuthStateChange((event, session) => callback(event, session));
    return () => subscription.unsubscribe();
  }

  async requestMagicLink(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    if (!z.string().email().safeParse(normalized).success) {
      throw new Error('Enter a valid email address.');
    }
    const { error } = await this.client.auth.signInWithOtp({
      email: normalized,
      options: {
        emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
      },
    });
    if (error) throw repositoryError('Magic-link request', error);
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) throw repositoryError('Sign out', error);
  }

  async loadSetupState(): Promise<LiveSetupState> {
    const { data, error } = await this.client.rpc('get_storyops_setup_state', {
      p_company_id: this.companyId,
    });
    if (error) throw repositoryError('Setup-state load', error);
    const setupState = liveSetupStateSchema.parse(data);
    if (
      (setupState.companyId !== null && setupState.companyId !== this.companyId) ||
      (setupState.requestedCompanyId !== null && setupState.requestedCompanyId !== this.companyId)
    ) {
      throw new Error('Setup-state company identity did not match the configured company.');
    }
    return setupState;
  }

  async loadCompanyControlState(): Promise<CompanyControlState> {
    const session = await this.getSession();
    if (!session) throw new Error('Company control requires a current authenticated session.');
    const { data, error } = await this.client.rpc('get_storyops_company_control_state', {
      p_company_id: this.companyId,
    });
    if (error) throw repositoryError('Company control-state load', error);
    const controlState = companyControlStateSchema.parse(data);
    if (
      controlState.companyId !== this.companyId ||
      controlState.userId !== session.user.id ||
      controlState.recentEvents.some(
        (event) => event.previousStatus === event.status || !event.requestHash,
      )
    ) {
      throw new Error('Company control-state identity did not match the authenticated owner.');
    }
    return controlState;
  }

  async setCompanyOperationalStatus(
    input: CompanyOperationalStatusCommandInput,
  ): Promise<CompanyControlReceipt> {
    const session = await this.getSession();
    if (!session) {
      throw new Error('Company operational changes require a current authenticated session.');
    }
    const command = await buildCompanyOperationalStatusCommand(input);
    const { data, error } = await this.client.rpc('set_storyops_company_operational_status', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_expected_status: command.expectedStatus,
      p_target_status: command.targetStatus,
      p_reason: command.reason,
      p_canonical_request: command.canonicalRequest,
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError('Company operational-status change', error);
    const receipt = companyControlReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== command.commandId ||
      receipt.previousStatus !== command.expectedStatus ||
      receipt.status !== command.targetStatus ||
      receipt.reason !== command.reason ||
      receipt.requestHash !== command.requestHash
    ) {
      throw new Error('Company control receipt did not match the exact submitted request.');
    }
    return receipt;
  }

  async loadProviderLaunchState(): Promise<ProviderLaunchState> {
    const { data, error } = await this.client.rpc('get_storyops_provider_launch_state', {
      p_company_id: this.companyId,
    });
    if (error) throw repositoryError('Provider and launch authority load', error);
    const state = providerLaunchStateSchema.parse(data);
    if (state.companyId !== this.companyId) {
      throw new Error('Provider and launch authority escaped the authenticated company scope.');
    }
    return state;
  }

  async setProviderActivation(input: ProviderActivationInput): Promise<ProviderActivationReceipt> {
    const session = await this.getSession();
    if (!session) {
      throw new Error('Provider activation requires a current authenticated owner session.');
    }
    const command = await buildProviderActivationCommand(input);
    const { data, error } = await this.client.rpc('set_storyops_provider_activation', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_provider: command.provider,
      p_expected_version: command.expectedVersion,
      p_target_mode: command.targetMode,
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError('Provider activation change', error);
    const receipt = providerActivationReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== command.commandId ||
      receipt.provider !== command.provider ||
      receipt.mode !== command.targetMode ||
      receipt.ownerEnabled !== (command.targetMode !== 'disabled') ||
      receipt.version !== command.expectedVersion + 1 ||
      receipt.requestHash !== command.requestHash
    ) {
      throw new Error('Provider activation receipt did not match the exact submitted command.');
    }
    return receipt;
  }

  async setCompanyLaunchAuthorization(
    input: CompanyLaunchAuthorizationInput,
  ): Promise<CompanyLaunchAuthorizationReceipt> {
    const session = await this.getSession();
    if (!session) {
      throw new Error('Launch authorization requires a current authenticated owner session.');
    }
    const command = await buildCompanyLaunchAuthorizationCommand(input);
    const { data, error } = await this.client.rpc('set_storyops_company_launch_authorization', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_expected_version: command.expectedVersion,
      p_action: command.action,
      p_review_reference: command.reviewReference,
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError('Controlled-launch authorization change', error);
    const receipt = companyLaunchAuthorizationReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== command.commandId ||
      receipt.version !== command.expectedVersion + 1 ||
      receipt.status !== (command.action === 'authorize' ? 'authorized' : 'revoked') ||
      receipt.launchAuthorized !== (command.action === 'authorize') ||
      receipt.reviewReference !== command.reviewReference ||
      receipt.requestHash !== command.requestHash
    ) {
      throw new Error('Launch authorization receipt did not match the exact submitted command.');
    }
    return receipt;
  }

  async recordPilotReleaseEvidence(
    input: PilotReleaseEvidenceInput,
  ): Promise<PilotReleaseEvidenceReceipt> {
    const session = await this.getSession();
    if (!session) {
      throw new Error('Pilot evidence recording requires a current authenticated session.');
    }
    const command = await buildPilotReleaseEvidenceCommand({
      companyId: this.companyId,
      userId: session.user.id,
      evidence: input,
    });
    const { data, error } = await this.client.rpc('record_storyops_pilot_release_evidence', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_request_hash: command.requestHash,
      p_kind: command.evidence.kind,
      p_provider: command.evidence.provider ?? null,
      p_outcome: command.evidence.outcome,
      p_source: command.evidence.source,
      p_evidence_reference: command.evidence.evidenceReference,
      p_artifact_sha256: command.evidence.artifactSha256,
      p_observed_at: command.evidence.observedAt,
      p_expires_at: command.evidence.expiresAt,
      p_review_note: command.evidence.reviewNote,
    });
    if (error) throw repositoryError('Pilot release evidence record', error);
    const receipt = pilotReleaseEvidenceReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== command.commandId ||
      receipt.requestHash !== command.requestHash ||
      receipt.record.companyId !== this.companyId ||
      receipt.record.reviewedByUserId !== session.user.id
    ) {
      throw new Error('Pilot evidence receipt did not match the exact submitted review.');
    }
    return receipt;
  }

  async createRecurringDueWork(
    input: CreateRecurringDueWorkInput,
  ): Promise<RecurringDueWorkReceipt> {
    const session = await this.getSession();
    if (!session) {
      throw new Error('Recurring due work requires a current authenticated session.');
    }
    const command = await buildRecurringDueWorkCommand({
      companyId: this.companyId,
      work: input,
    });
    const { data, error } = await this.client.rpc('create_storyops_recurring_due_work', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_plan_id: command.planId,
      p_expected_plan_version: command.planVersion,
      p_due_date: command.dueDate,
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError('Recurring due-work creation', error);
    const receipt = recurringDueWorkReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== command.commandId ||
      receipt.recurringPlanId !== command.planId ||
      receipt.sourcePlanVersion !== command.planVersion ||
      receipt.planDueDate !== command.dueDate ||
      receipt.requestHash !== command.requestHash ||
      receipt.historicalPriceCopied ||
      receipt.estimateCreated ||
      receipt.quoteAccepted ||
      receipt.depositVerified ||
      receipt.schedulingEvidenceVerified ||
      receipt.visitCreated ||
      receipt.customerContacted ||
      receipt.bookingBoundary !== 'job.book'
    ) {
      throw new Error('Recurring due-work receipt did not match the exact guarded request.');
    }
    return receipt;
  }

  async attachRecurringDueEstimate(
    input: AttachRecurringDueEstimateInput,
  ): Promise<RecurringDueEstimateReceipt> {
    const session = await this.getSession();
    if (!session) {
      throw new Error('Recurring estimate association requires a current authenticated session.');
    }
    const command = await buildRecurringDueEstimateCommand({
      companyId: this.companyId,
      association: input,
    });
    const { data, error } = await this.client.rpc('attach_storyops_recurring_due_estimate', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_work_item_id: command.workItemId,
      p_expected_work_item_version: command.workItemVersion,
      p_estimate_id: command.estimateId,
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError('Recurring estimate association', error);
    const receipt = recurringDueEstimateReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== command.commandId ||
      receipt.workItemId !== command.workItemId ||
      receipt.workItemVersion !== command.workItemVersion + 1 ||
      receipt.estimateId !== command.estimateId ||
      receipt.requestHash !== command.requestHash ||
      receipt.historicalPriceCopied ||
      receipt.quoteAccepted ||
      receipt.depositVerified ||
      receipt.schedulingEvidenceVerified ||
      receipt.visitCreated ||
      receipt.customerContacted ||
      receipt.bookingBoundary !== 'job.book'
    ) {
      throw new Error('Recurring estimate receipt did not match the exact guarded association.');
    }
    return receipt;
  }

  async completeSetup(input: SandboxSetupInput): Promise<LiveSetupReceipt> {
    const normalized = canonicalLiveSetupPayload(input);
    const session = await this.getSession();
    if (!session) throw new Error('Authenticated setup requires a current session.');
    const commandId = await stableLiveSetupCommandId(session.user.id, this.companyId);
    const requestHash = await sha256Hex(
      JSON.stringify(
        canonicalize({
          schemaVersion: 'storyops-live-setup-request-v1',
          companyId: this.companyId,
          commandId,
          input: normalized,
        }),
      ),
    );
    const { data, error } = await this.client.rpc('complete_storyops_setup', {
      p_company_id: this.companyId,
      p_command_id: commandId,
      p_request_hash: requestHash,
      p_business_name: normalized.businessName,
      p_owner_name: normalized.ownerName,
      p_home_postal_code: normalized.homePostalCode,
      p_timezone: normalized.timezone,
      p_enabled_service_codes: normalized.enabledServiceCodes,
      p_policy_acknowledged: normalized.policyAcknowledged,
    });
    if (error) throw repositoryError('Company setup', error);
    const receipt = liveSetupReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== commandId ||
      receipt.requestHash !== requestHash
    ) {
      throw new Error('Setup receipt identity did not match the submitted request.');
    }
    return receipt;
  }

  async saveCompanyConfigurationDraft(input: {
    expectedRevision: number;
    configuration: CompanyConfiguration;
  }): Promise<CompanyConfigurationReceipt> {
    const session = await this.getSession();
    if (!session) throw new Error('Configuration changes require a current authenticated session.');
    const command = await buildCompanyConfigurationCommand({
      companyId: this.companyId,
      userId: session.user.id,
      action: 'save',
      expectedRevision: input.expectedRevision,
      configuration: input.configuration,
    });
    const { data, error } = await this.client.rpc('save_company_configuration_draft', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_expected_revision: input.expectedRevision,
      p_configuration: input.configuration,
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError('Company configuration draft', error);
    const receipt = companyConfigurationReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== command.commandId ||
      receipt.commandType !== 'company.configuration.save'
    ) {
      throw new Error('Configuration receipt identity did not match the submitted draft.');
    }
    return receipt;
  }

  async publishCompanyConfiguration(input: {
    expectedRevision: number;
    publicationMode: CompanyConfigurationPublicationMode;
    reviewReference: string;
  }): Promise<CompanyConfigurationReceipt> {
    const session = await this.getSession();
    if (!session) {
      throw new Error('Configuration publication requires a current authenticated session.');
    }
    const command = await buildCompanyConfigurationCommand({
      companyId: this.companyId,
      userId: session.user.id,
      action: 'publish',
      expectedRevision: input.expectedRevision,
      publicationMode: input.publicationMode,
      reviewReference: input.reviewReference,
    });
    const { data, error } = await this.client.rpc('publish_company_configuration', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_expected_revision: input.expectedRevision,
      p_publication_mode: input.publicationMode,
      p_review_reference: input.reviewReference.trim(),
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError('Company configuration publication', error);
    const receipt = companyConfigurationReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== command.commandId ||
      receipt.commandType !== 'company.configuration.publish'
    ) {
      throw new Error('Configuration publication receipt did not match the submitted command.');
    }
    return receipt;
  }

  async publishOperatingBaseline(input: {
    configurationRevision: number;
    reviewReference: string;
  }): Promise<OperatingBaselineReceipt> {
    const session = await this.getSession();
    if (!session) {
      throw new Error('Operating-baseline publication requires a current authenticated session.');
    }
    const command = await buildOperatingBaselineCommand({
      companyId: this.companyId,
      userId: session.user.id,
      configurationRevision: input.configurationRevision,
      reviewReference: input.reviewReference,
    });
    const { data, error } = await this.client.rpc('publish_company_operating_baseline', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_configuration_revision: input.configurationRevision,
      p_review_reference: input.reviewReference.trim(),
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError('Operating-baseline publication', error);
    const receipt = operatingBaselineReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== command.commandId ||
      receipt.configurationRevision !== input.configurationRevision
    ) {
      throw new Error('Operating-baseline receipt identity did not match the submitted command.');
    }
    return receipt;
  }

  async registerMaterialSds(
    input: RegisterMaterialSdsInput,
  ): Promise<FinalizedSdsRegistrationReceipt> {
    const session = await this.getSession();
    if (!session) {
      throw new Error('SDS registration requires a current authenticated owner session.');
    }
    const commandId = z
      .string()
      .uuid()
      .parse(input.commandId ?? crypto.randomUUID());
    const checksumSha256 = await reviewedSdsPdfChecksum(input.file);
    const metadata = normalizeSdsRegistrationMetadata({
      materialConfigurationKey: input.materialConfigurationKey,
      productName: input.productName,
      manufacturer: input.manufacturer,
      revisionDate: input.revisionDate,
      reviewReference: input.reviewReference,
      contentType: input.file.type,
      byteSize: input.file.size,
      checksumSha256,
    });
    const requestHash = await sha256Hex(
      sdsRegistrationRequestHashMaterial(this.companyId, metadata),
    );
    const { data: prepareData, error: prepareError } = await this.client.rpc(
      'prepare_storyops_material_sds_registration',
      {
        p_company_id: this.companyId,
        p_command_id: commandId,
        p_material_configuration_key: metadata.materialConfigurationKey,
        p_product_name: metadata.productName,
        p_manufacturer: metadata.manufacturer,
        p_revision_date: metadata.revisionDate,
        p_content_type: metadata.contentType,
        p_byte_size: metadata.byteSize,
        p_checksum_sha256: metadata.checksumSha256,
        p_review_reference: metadata.reviewReference,
        p_request_hash: requestHash,
      },
    );
    if (prepareError) throw repositoryError('SDS registration preparation', prepareError);
    const prepared = preparedSdsRegistrationReceiptSchema.parse(prepareData);
    if (
      prepared.companyId !== this.companyId ||
      prepared.commandId !== commandId ||
      prepared.requestHash !== requestHash ||
      prepared.materialConfigurationKey !== metadata.materialConfigurationKey ||
      prepared.contentType !== metadata.contentType ||
      prepared.byteSize !== metadata.byteSize ||
      prepared.checksumSha256 !== metadata.checksumSha256 ||
      !prepared.objectPath.startsWith(
        `${this.companyId}/materials/${metadata.materialConfigurationKey}/sds/`,
      ) ||
      !prepared.objectPath.endsWith(`-${metadata.checksumSha256}.pdf`)
    ) {
      throw new Error('SDS preparation receipt did not match the exact private upload request.');
    }
    if (prepared.status === 'registered') {
      return finalizedSdsRegistrationReceiptSchema.parse(prepared);
    }

    const bucket = this.client.storage.from('sds');
    const { error: uploadError } = await bucket.upload(prepared.objectPath, input.file, {
      contentType: metadata.contentType,
      upsert: false,
    });
    const { data: durableFile, error: downloadError } = await bucket.download(prepared.objectPath);
    if (downloadError || !durableFile) {
      throw repositoryError(
        'SDS private upload readback',
        downloadError ??
          uploadError ?? { message: 'The private SDS object could not be read back.' },
      );
    }
    const durableChecksum = await sha256Hex(await blobArrayBuffer(durableFile));
    if (
      durableFile.size !== metadata.byteSize ||
      (durableFile.type !== '' && durableFile.type !== metadata.contentType) ||
      durableChecksum !== metadata.checksumSha256
    ) {
      throw new Error(
        'The durable private SDS object did not match the reviewed PDF size, type, and checksum.',
      );
    }

    const { data: attestationData, error: attestationError } = await this.client.functions.invoke(
      'sds-registration',
      {
        body: {
          companyId: this.companyId,
          commandId,
          requestHash,
        },
      },
    );
    if (attestationError) throw repositoryError('Trusted SDS byte attestation', attestationError);
    const attestation = sdsUploadAttestationReceiptSchema.parse(attestationData);
    if (
      attestation.companyId !== this.companyId ||
      attestation.commandId !== commandId ||
      attestation.requestHash !== requestHash ||
      attestation.registrationRequestId !== prepared.registrationRequestId ||
      attestation.objectPath !== prepared.objectPath ||
      attestation.contentType !== prepared.contentType ||
      attestation.byteSize !== prepared.byteSize ||
      attestation.checksumSha256 !== prepared.checksumSha256
    ) {
      throw new Error('Trusted SDS byte attestation did not match the prepared private upload.');
    }

    const { data: finalizeData, error: finalizeError } = await this.client.rpc(
      'finalize_storyops_material_sds_registration',
      {
        p_company_id: this.companyId,
        p_command_id: commandId,
        p_request_hash: requestHash,
      },
    );
    if (finalizeError) throw repositoryError('SDS registration finalization', finalizeError);
    const finalized = finalizedSdsRegistrationReceiptSchema.parse(finalizeData);
    if (
      finalized.companyId !== this.companyId ||
      finalized.commandId !== commandId ||
      finalized.requestHash !== requestHash ||
      finalized.registrationRequestId !== prepared.registrationRequestId ||
      finalized.materialConfigurationKey !== prepared.materialConfigurationKey ||
      finalized.configurationRevision !== prepared.configurationRevision ||
      finalized.configurationHash !== prepared.configurationHash ||
      finalized.documentVersion !== prepared.documentVersion ||
      finalized.objectPath !== prepared.objectPath ||
      finalized.checksumSha256 !== prepared.checksumSha256
    ) {
      throw new Error('SDS finalization receipt did not reconcile with the prepared upload.');
    }
    return finalized;
  }

  async loadAiOfficeRecent(limit = 10): Promise<LiveAiOfficeRecent> {
    const session = await this.getSession();
    if (!session) throw new Error('AI Office readback requires a current authenticated session.');
    const { data, error } = await this.client.rpc('get_storyops_ai_office_recent', {
      p_company_id: this.companyId,
      p_limit: z.number().int().min(1).max(20).parse(limit),
    });
    if (error) throw repositoryError('AI Office readback', error);
    return parseBoundAiOfficeRecent(data, this.companyId, session.user.id);
  }

  async loadAuditFeed(input?: {
    cursor?: { occurredAt: string; id: string };
    limit?: number;
  }): Promise<LiveAuditFeed> {
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(input?.limit ?? 50);
    const cursor = input?.cursor;
    if (
      cursor &&
      (!z.string().datetime({ offset: true }).safeParse(cursor.occurredAt).success ||
        !z.string().uuid().safeParse(cursor.id).success)
    ) {
      throw new Error('Audit pagination requires the exact server cursor.');
    }
    const { data, error } = await this.client.rpc('get_storyops_audit_feed', {
      p_company_id: this.companyId,
      p_before_occurred_at: cursor?.occurredAt ?? null,
      p_before_id: cursor?.id ?? null,
      p_limit: limit,
    });
    if (error) throw repositoryError('Audit feed readback', error);
    const feed = liveAuditFeedSchema.parse(data);
    if (feed.companyId !== this.companyId || feed.pageLimit !== limit || !feed.redacted) {
      throw new Error('Audit feed identity or disclosure contract did not match the request.');
    }
    return feed;
  }

  async runAiOffice(input: {
    actorRole: 'owner' | 'dispatcher';
    run: LiveAiOfficeRunInput;
  }): Promise<LiveAiOfficeInvocation> {
    const session = await this.getSession();
    if (!session) throw new Error('AI Office runs require a current authenticated session.');
    const request = buildLiveAiOfficeRequest({
      companyId: this.companyId,
      actor: { id: session.user.id, role: input.actorRole },
      run: input.run,
    });
    const { data, error } = await this.client.functions.invoke('ai-office', {
      body: { ...request },
    });
    if (error) {
      const recent = await this.loadAiOfficeRecent();
      const reconciled = recent.runs.find(
        (run) =>
          run.automationRunId === request.runId &&
          run.agent === request.agent &&
          run.companyId === request.companyId &&
          run.actorUserId === session.user.id &&
          run.durableStatus !== 'running' &&
          run.durableStatus !== 'queued',
      );
      if (reconciled) {
        return { run: reconciled, recent, recoveredFromReadback: true };
      }
      throw repositoryError('AI Office run', error);
    }
    const response = liveAiOfficeRunResponseSchema.parse(data);
    if (
      response.companyId !== this.companyId ||
      response.actorUserId !== session.user.id ||
      response.run.companyId !== this.companyId ||
      response.run.actorUserId !== session.user.id ||
      response.run.automationRunId !== request.runId ||
      response.run.agent !== request.agent
    ) {
      throw new Error('AI Office response identity did not match the submitted run.');
    }
    const recent = await this.loadAiOfficeRecent();
    const reconciled = recent.runs.find(
      (run) => run.automationRunId === response.run.automationRunId,
    );
    if (
      !reconciled ||
      reconciled.agent !== response.run.agent ||
      reconciled.durableStatus !== response.run.durableStatus ||
      reconciled.ownerBriefingId !== response.run.ownerBriefingId ||
      reconciled.result?.traceId !== response.run.result?.traceId ||
      JSON.stringify(canonicalize(reconciled.result)) !==
        JSON.stringify(canonicalize(response.run.result))
    ) {
      throw new Error('AI Office durable readback did not reconcile with the Edge response.');
    }
    return { run: reconciled, recent, recoveredFromReadback: false };
  }

  async loadWorkspace(): Promise<LiveWorkspace> {
    const { data, error } = await this.client.rpc('get_storyops_workspace', {
      p_company_id: this.companyId,
    });
    if (error) throw repositoryError('Workspace load', error);
    const workspace = workspaceSchema.parse(data);
    if (workspace.session.companyId !== this.companyId || workspace.company.id !== this.companyId) {
      throw new Error('Workspace company identity did not match the requested company.');
    }
    let fieldReference: z.infer<typeof fieldReferenceSchema> = {
      materials: [],
      checklistDefinitions: [],
      fieldIncidents: [],
      fieldPackets: [],
    };
    if (workspace.session.role !== 'customer') {
      const { data: fieldReferenceData, error: fieldReferenceError } = await this.client.rpc(
        'get_storyops_field_reference',
        { p_company_id: this.companyId },
      );
      if (fieldReferenceError) {
        throw repositoryError('Field safety reference load', fieldReferenceError);
      }
      fieldReference = fieldReferenceSchema.parse(fieldReferenceData);
    }
    let postService = { followups: [], maintenancePlans: [] } as Pick<
      z.infer<typeof postServiceStatusSchema>,
      'followups' | 'maintenancePlans'
    >;
    if (['owner', 'dispatcher', 'customer'].includes(workspace.session.role)) {
      const { data: postServiceData, error: postServiceError } = await this.client.rpc(
        'get_storyops_post_service_status',
        { p_company_id: this.companyId },
      );
      if (postServiceError) {
        throw repositoryError('Post-service status load', postServiceError);
      }
      const projection = postServiceStatusSchema.parse(postServiceData);
      if (projection.companyId !== this.companyId) {
        throw new Error('Post-service status company identity did not match the workspace.');
      }
      postService = projection;
    }
    let customerPortal: CustomerPortalState | undefined;
    if (workspace.session.role === 'customer') {
      const { data: customerPortalData, error: customerPortalError } = await this.client.rpc(
        'get_customer_portal_state',
        { p_company_id: this.companyId },
      );
      if (customerPortalError) {
        throw repositoryError('Customer-portal state load', customerPortalError);
      }
      const projection = customerPortalStateSchema.parse(customerPortalData);
      const projectedCustomers = Array.isArray(workspace.customers)
        ? workspace.customers
            .map((customer) =>
              customer !== null &&
              typeof customer === 'object' &&
              'id' in customer &&
              typeof customer.id === 'string'
                ? customer.id
                : undefined,
            )
            .filter((id): id is string => Boolean(id))
        : [];
      const projectedCustomerIds = new Set(projectedCustomers);
      if (
        projection.companyId !== this.companyId ||
        projection.customers.some((customer) => !projectedCustomerIds.has(customer.customerId))
      ) {
        throw new Error('Customer-portal projection escaped the authenticated workspace scope.');
      }
      customerPortal = projection;
    }
    let recurringDueWork: RecurringDueWorkState | undefined;
    if (['owner', 'dispatcher', 'customer'].includes(workspace.session.role)) {
      const { data: dueWorkData, error: dueWorkError } = await this.client.rpc(
        'get_storyops_recurring_due_work',
        { p_company_id: this.companyId },
      );
      if (dueWorkError) {
        throw repositoryError('Recurring due-work load', dueWorkError);
      }
      recurringDueWork = recurringDueWorkStateSchema.parse(dueWorkData);
      if (
        recurringDueWork.companyId !== this.companyId ||
        recurringDueWork.role !== workspace.session.role
      ) {
        throw new Error('Recurring due-work projection escaped the authenticated workspace scope.');
      }
    }
    let companyConfiguration: CompanyConfigurationRecord | undefined;
    let operatingBaseline: OperatingBaselineState | undefined;
    let providerLaunch: ProviderLaunchState | undefined;
    let materialSdsRegistry: MaterialSdsRegistryState | undefined;
    let pilotReleaseEvidence: PilotReleaseEvidenceState | undefined;
    let profitabilityKpis: LiveProfitabilityKpis | undefined;
    let aiOfficeRecent: LiveAiOfficeRecent | undefined;
    let auditFeed: LiveAuditFeed | undefined;
    if (workspace.session.role === 'owner' || workspace.session.role === 'dispatcher') {
      providerLaunch = await this.loadProviderLaunchState();
      if (providerLaunch.role !== workspace.session.role) {
        throw new Error('Provider and launch authority role did not match the workspace.');
      }
      const { data: profitabilityData, error: profitabilityError } = await this.client.rpc(
        'get_storyops_profitability_kpis',
        { p_company_id: this.companyId },
      );
      if (profitabilityError) {
        throw repositoryError('Profitability KPI load', profitabilityError);
      }
      profitabilityKpis = liveProfitabilityKpisSchema.parse(profitabilityData);
      if (profitabilityKpis.companyId !== this.companyId) {
        throw new Error('Profitability KPI company identity did not match the workspace.');
      }
      const { data: aiOfficeData, error: aiOfficeError } = await this.client.rpc(
        'get_storyops_ai_office_recent',
        { p_company_id: this.companyId, p_limit: 10 },
      );
      if (aiOfficeError) throw repositoryError('AI Office readback', aiOfficeError);
      aiOfficeRecent = parseBoundAiOfficeRecent(
        aiOfficeData,
        this.companyId,
        workspace.session.userId,
      );
    }
    if (workspace.session.role === 'owner') {
      auditFeed = await this.loadAuditFeed({ limit: 50 });
      const { data: configurationData, error: configurationError } = await this.client.rpc(
        'get_company_configuration_state',
        { p_company_id: this.companyId },
      );
      if (configurationError) {
        throw repositoryError('Company configuration load', configurationError);
      }
      companyConfiguration =
        configurationData === null
          ? undefined
          : companyConfigurationRecordSchema.parse(configurationData);
      if (companyConfiguration) {
        const { data: materialRegistryData, error: materialRegistryError } = await this.client.rpc(
          'get_storyops_material_sds_registry',
          { p_company_id: this.companyId },
        );
        if (materialRegistryError) {
          throw repositoryError('Material/SDS registry load', materialRegistryError);
        }
        materialSdsRegistry = materialSdsRegistryStateSchema.parse(materialRegistryData);
        if (materialSdsRegistry.companyId !== this.companyId) {
          throw new Error('Material/SDS registry identity did not match the workspace.');
        }
      }
      const { data: baselineData, error: baselineError } = await this.client.rpc(
        'get_company_operating_baseline_state',
        { p_company_id: this.companyId },
      );
      if (baselineError) {
        throw repositoryError('Operating-baseline state load', baselineError);
      }
      operatingBaseline =
        baselineData === null ? undefined : operatingBaselineStateSchema.parse(baselineData);
      const { data: pilotEvidenceData, error: pilotEvidenceError } = await this.client.rpc(
        'get_storyops_pilot_release_evidence',
        { p_company_id: this.companyId },
      );
      if (pilotEvidenceError) {
        throw repositoryError('Pilot release evidence load', pilotEvidenceError);
      }
      pilotReleaseEvidence = pilotReleaseEvidenceStateSchema.parse(pilotEvidenceData);
      if (pilotReleaseEvidence.companyId !== this.companyId) {
        throw new Error('Pilot release evidence identity did not match the workspace.');
      }
    }
    return {
      ...workspace,
      ...fieldReference,
      postServiceFollowups: postService.followups,
      postServiceMaintenancePlans: postService.maintenancePlans,
      companyConfiguration,
      operatingBaseline,
      providerLaunch,
      materialSdsRegistry,
      pilotReleaseEvidence,
      recurringDueWork,
      customerPortal,
      profitabilityKpis,
      aiOfficeRecent,
      auditFeed,
    };
  }

  async submitCustomerPortalRequest(
    input: CustomerPortalRequestInput,
  ): Promise<CustomerPortalRequestReceipt> {
    const note = input.requestNotes.trim();
    if (
      !z.string().uuid().safeParse(input.customerId).success ||
      !z.string().uuid().safeParse(input.propertyId).success ||
      note.length > 2000
    ) {
      throw new Error('Customer request identity or notes are invalid.');
    }
    const payload =
      input.requestType === 'reschedule'
        ? {
            customerId: input.customerId,
            preferredEndDate: input.preferredEndDate,
            preferredStartDate: input.preferredStartDate,
            propertyId: input.propertyId,
            requestNotes: note,
            requestType: input.requestType,
            requestedServiceCodes: [],
            visitId: input.visitId,
          }
        : {
            customerId: input.customerId,
            preferredEndDate: null,
            preferredStartDate: null,
            propertyId: input.propertyId,
            requestNotes: note,
            requestType: input.requestType,
            requestedServiceCodes: [...new Set(input.requestedServiceCodes)].sort(),
            visitId: null,
          };
    if (input.requestType === 'reschedule') {
      if (
        !z.string().uuid().safeParse(input.visitId).success ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(input.preferredStartDate) ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(input.preferredEndDate)
      ) {
        throw new Error('A reschedule request needs a versioned visit and valid date range.');
      }
    } else if (
      payload.requestedServiceCodes.length < 1 ||
      payload.requestedServiceCodes.length > 12 ||
      payload.requestedServiceCodes.some((code) => !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(code))
    ) {
      throw new Error('Select one or more valid services for the additional-service request.');
    }
    const command = await buildCustomerPortalCommand({
      commandType:
        input.requestType === 'reschedule'
          ? 'portal.reschedule.request'
          : 'portal.additional_service.request',
      commandId: input.commandId,
      payload,
    });
    const { data, error } = await this.client.rpc('submit_customer_portal_request', {
      p_company_id: this.companyId,
      p_customer_id: input.customerId,
      p_command_id: command.commandId,
      p_command_type: command.commandType,
      p_canonical_request: command.canonicalRequest,
      p_request_hash: command.requestHash,
      p_request_type: input.requestType,
      p_visit_id: input.requestType === 'reschedule' ? input.visitId : null,
      p_property_id: input.propertyId,
      p_preferred_start_date: input.requestType === 'reschedule' ? input.preferredStartDate : null,
      p_preferred_end_date: input.requestType === 'reschedule' ? input.preferredEndDate : null,
      p_requested_service_codes:
        input.requestType === 'additional_service' ? payload.requestedServiceCodes : [],
      p_request_notes: note,
    });
    if (error) throw repositoryError('Customer request submission', error);
    const receipt = customerPortalRequestReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.customerId !== input.customerId ||
      receipt.commandId !== command.commandId ||
      receipt.requestHash !== command.requestHash ||
      receipt.requestType !== input.requestType
    ) {
      throw new Error('Customer request receipt identity did not match the submitted command.');
    }
    return receipt;
  }

  async updateCustomerCommunicationPreferences(
    input: CustomerCommunicationPreferencesInput,
  ): Promise<CustomerCommunicationPreferencesReceipt> {
    if (
      !z.string().uuid().safeParse(input.customerId).success ||
      !/^customer-portal-consent-v[0-9]+$/u.test(input.disclosureVersion)
    ) {
      throw new Error('Communication preferences need an authenticated customer and disclosure.');
    }
    const payload = {
      customerId: input.customerId,
      disclosureVersion: input.disclosureVersion,
      globalOptOut: input.globalOptOut,
      marketingEmail: input.globalOptOut ? false : input.marketingEmail,
      marketingSms: input.globalOptOut ? false : input.marketingSms,
      transactionalEmail: input.globalOptOut ? false : input.transactionalEmail,
      transactionalSms: input.globalOptOut ? false : input.transactionalSms,
    };
    const command = await buildCustomerPortalCommand({
      commandType: 'portal.communication_preferences.update',
      commandId: input.commandId,
      payload,
    });
    const { data, error } = await this.client.rpc('update_customer_communication_preferences', {
      p_company_id: this.companyId,
      p_customer_id: input.customerId,
      p_command_id: command.commandId,
      p_canonical_request: command.canonicalRequest,
      p_request_hash: command.requestHash,
      p_transactional_sms: payload.transactionalSms,
      p_transactional_email: payload.transactionalEmail,
      p_marketing_sms: payload.marketingSms,
      p_marketing_email: payload.marketingEmail,
      p_global_opt_out: payload.globalOptOut,
      p_disclosure_version: payload.disclosureVersion,
    });
    if (error) throw repositoryError('Communication-preference update', error);
    const receipt = customerCommunicationPreferencesReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.customerId !== input.customerId ||
      receipt.commandId !== command.commandId ||
      receipt.requestHash !== command.requestHash
    ) {
      throw new Error('Communication-preference receipt identity did not match the command.');
    }
    return receipt;
  }

  async executeCustomerQuoteAction(input: {
    customerId: string;
    quoteId: string;
    quoteVersion: number;
    action: 'quote.view' | 'quote.decline' | 'quote.change_request';
    requestedServiceCodes?: string[];
    requestedAddOnCodes?: string[];
    notes?: string;
    commandId?: string;
  }): Promise<CustomerQuoteActionReceipt> {
    const commandId = input.commandId ?? crypto.randomUUID();
    const serviceCodes = [...new Set(input.requestedServiceCodes ?? [])].sort();
    const addOnCodes = [...new Set(input.requestedAddOnCodes ?? [])].sort();
    const notes = input.notes?.trim() ?? '';
    if (
      !z.string().uuid().safeParse(commandId).success ||
      !z.string().uuid().safeParse(input.customerId).success ||
      !z.string().uuid().safeParse(input.quoteId).success ||
      !Number.isInteger(input.quoteVersion) ||
      input.quoteVersion < 1 ||
      notes.length > 2000
    ) {
      throw new Error('Quote action requires exact customer, quote, version, and command IDs.');
    }
    const payload = {
      addOnCodes,
      customerId: input.customerId,
      notes,
      quoteId: input.quoteId,
      quoteVersion: input.quoteVersion,
      serviceCodes,
    };
    const canonicalRequest = JSON.stringify(canonicalize({ action: input.action, payload }));
    const requestHash = await sha256Hex(canonicalRequest);
    const { data, error } = await this.client.rpc('execute_customer_quote_action', {
      p_company_id: this.companyId,
      p_customer_id: input.customerId,
      p_command_id: commandId,
      p_action: input.action,
      p_quote_id: input.quoteId,
      p_expected_quote_version: input.quoteVersion,
      p_requested_service_codes: serviceCodes,
      p_requested_add_on_codes: addOnCodes,
      p_request_notes: notes,
      p_canonical_request: canonicalRequest,
      p_request_hash: requestHash,
    });
    if (error) throw repositoryError(input.action, error);
    const receipt = customerQuoteActionReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.customerId !== input.customerId ||
      receipt.commandId !== commandId ||
      receipt.quoteId !== input.quoteId ||
      receipt.action !== input.action ||
      receipt.requestHash !== requestHash
    ) {
      throw new Error('Quote action receipt identity did not match the submitted command.');
    }
    return receipt;
  }

  async acceptCustomerQuote(input: {
    customerId: string;
    quoteId: string;
    quoteVersion: number;
    signerName: string;
    acknowledged: boolean;
    termsVersion: string;
    total: string;
    commandId?: string;
  }): Promise<CustomerQuoteAcceptanceReceipt> {
    const commandId = input.commandId ?? crypto.randomUUID();
    const signerName = input.signerName.trim();
    if (
      !z.string().uuid().safeParse(commandId).success ||
      !z.string().uuid().safeParse(input.customerId).success ||
      !z.string().uuid().safeParse(input.quoteId).success ||
      !Number.isInteger(input.quoteVersion) ||
      input.quoteVersion < 1 ||
      signerName.length < 2 ||
      signerName.length > 120 ||
      hasControlCharacters(signerName) ||
      input.acknowledged !== true ||
      input.termsVersion.trim().length < 1 ||
      input.termsVersion.length > 160 ||
      !/^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/u.test(input.total)
    ) {
      throw new Error(
        'Quote acceptance requires a typed signer, affirmative acknowledgment, and the exact published quote context.',
      );
    }
    const payload = {
      acknowledged: true,
      customerId: input.customerId,
      quoteId: input.quoteId,
      quoteVersion: input.quoteVersion,
      signerName,
      termsVersion: input.termsVersion,
      total: input.total,
    };
    const canonicalRequest = JSON.stringify(canonicalize({ action: 'quote.accept', payload }));
    const requestHash = await sha256Hex(canonicalRequest);
    const { data, error } = await this.client.rpc('accept_customer_quote', {
      p_company_id: this.companyId,
      p_customer_id: input.customerId,
      p_command_id: commandId,
      p_quote_id: input.quoteId,
      p_expected_quote_version: input.quoteVersion,
      p_signer_name: signerName,
      p_acknowledged: true,
      p_terms_version: input.termsVersion,
      p_total: input.total,
      p_canonical_request: canonicalRequest,
      p_request_hash: requestHash,
    });
    if (error) throw repositoryError('Quote acceptance', error);
    const receipt = customerQuoteAcceptanceReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.customerId !== input.customerId ||
      receipt.commandId !== commandId ||
      receipt.quoteId !== input.quoteId ||
      receipt.expectedQuoteVersion !== input.quoteVersion ||
      receipt.quoteVersion !== input.quoteVersion + 1 ||
      receipt.termsVersion !== input.termsVersion ||
      receipt.total !== input.total ||
      receipt.signerName !== signerName ||
      receipt.requestHash !== requestHash ||
      !receipt.acknowledged
    ) {
      throw new Error('Quote acceptance receipt did not match the submitted context.');
    }
    return receipt;
  }

  async resolveCustomerQuoteChangeRequest(input: {
    requestId: string;
    requestVersion: number;
    disposition: 'replacement_published' | 'cancelled';
    replacementQuoteId?: string;
    replacementQuoteVersion?: number;
    resolutionNote: string;
    commandId?: string;
  }): Promise<z.infer<typeof quoteChangeResolutionReceiptSchema>> {
    const commandId = input.commandId ?? crypto.randomUUID();
    const resolutionNote = input.resolutionNote.trim();
    const payload = {
      disposition: input.disposition,
      expectedRequestVersion: input.requestVersion,
      replacementQuoteId: input.replacementQuoteId ?? null,
      replacementQuoteVersion: input.replacementQuoteVersion ?? null,
      requestId: input.requestId,
      resolutionNote,
    };
    const canonicalRequest = JSON.stringify(
      canonicalize({ action: 'quote.change_request.resolve', payload }),
    );
    const requestHash = await sha256Hex(canonicalRequest);
    const { data, error } = await this.client.rpc('resolve_customer_quote_change_request', {
      p_company_id: this.companyId,
      p_command_id: commandId,
      p_request_id: input.requestId,
      p_expected_request_version: input.requestVersion,
      p_disposition: input.disposition,
      p_replacement_quote_id: input.replacementQuoteId ?? null,
      p_replacement_quote_version: input.replacementQuoteVersion ?? null,
      p_resolution_note: resolutionNote,
      p_canonical_request: canonicalRequest,
      p_request_hash: requestHash,
    });
    if (error) throw repositoryError('Quote change resolution', error);
    const receipt = quoteChangeResolutionReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== commandId ||
      receipt.requestId !== input.requestId ||
      receipt.disposition !== input.disposition ||
      receipt.requestHash !== requestHash
    ) {
      throw new Error('Quote change resolution receipt did not match the command.');
    }
    return receipt;
  }

  async resolvePaymentAllocation(input: {
    conflictId: string;
    conflictVersion: number;
    invoiceId: string;
    invoiceVersion: number;
    approvalRequestId: string;
    resolutionNote: string;
  }): Promise<PaymentAllocationResolutionReceipt> {
    const conflictId = z.string().uuid().parse(input.conflictId);
    const conflictVersion = z.number().int().positive().parse(input.conflictVersion);
    const invoiceId = z.string().uuid().parse(input.invoiceId);
    const invoiceVersion = z.number().int().positive().parse(input.invoiceVersion);
    const approvalRequestId = z.string().uuid().parse(input.approvalRequestId);
    const resolutionNote = input.resolutionNote.trim();
    if (
      resolutionNote.length < 5 ||
      resolutionNote.length > 2_000 ||
      hasUnsafeTextControlCharacters(resolutionNote)
    ) {
      throw new Error('Resolution note must be 5–2,000 printable characters.');
    }
    const { data, error } = await this.client.rpc('resolve_storyops_payment_allocation', {
      p_company_id: this.companyId,
      p_conflict_id: conflictId,
      p_approval_request_id: approvalRequestId,
      p_expected_conflict_version: conflictVersion,
      p_expected_invoice_version: invoiceVersion,
      p_resolution_note: resolutionNote,
    });
    if (error) throw repositoryError('Payment allocation resolution', error);
    const receipt = paymentAllocationResolutionReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.conflictId !== conflictId ||
      receipt.invoiceId !== invoiceId ||
      receipt.approvalRequestId !== approvalRequestId ||
      receipt.conflictVersion !== conflictVersion + 1 ||
      receipt.invoiceVersion !== invoiceVersion + 1
    ) {
      throw new Error('Payment allocation receipt did not match the submitted context.');
    }
    return receipt;
  }

  async executeCommand(command: StoryOpsCommand): Promise<StoryOpsCommandResult> {
    if (command.commandType === 'media.register') {
      throw new Error(
        'Media registration requires trusted Storage byte verification through finalizeVisitMedia.',
      );
    }
    if (command.commandType === 'quote.accept') {
      throw new Error(
        'Quote acceptance requires the dedicated affirmative customer acceptance contract.',
      );
    }
    if (command.commandType === 'field.change_request') {
      const { data, error } = await this.client.rpc('submit_storyops_field_change_request', {
        p_company_id: this.companyId,
        p_command_id: command.commandId,
        p_expected_version: command.expectedVersion,
        p_payload: command.payload,
        p_request_hash: command.requestHash,
      });
      if (error) throw repositoryError(command.commandType, error);
      const result = commandResult(data);
      if (
        result.commandId !== command.commandId ||
        result.commandType !== command.commandType ||
        result.requestHash !== command.requestHash
      ) {
        throw new Error('Field change-request receipt did not match the submitted command.');
      }
      return result;
    }
    if (command.commandType === 'incident.report_pause') {
      return this.reportIncidentAndPause(command);
    }
    const { data, error } = await this.client.rpc('execute_storyops_command', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_command_type: command.commandType,
      p_expected_version: command.expectedVersion,
      p_payload: command.payload,
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError(command.commandType, error);
    const result = commandResult(data);
    if (result.commandId !== command.commandId || result.commandType !== command.commandType) {
      throw new Error('Command receipt identity did not match the submitted command.');
    }
    return result;
  }

  async reportIncidentAndPause(command: StoryOpsCommand): Promise<IncidentPauseReceipt> {
    if (command.commandType !== 'incident.report_pause') {
      throw new Error('Atomic incident reporting requires incident.report_pause.');
    }
    const payload = incidentPausePayloadSchema.parse(command.payload);
    if (payload.entityId === payload.visitId) {
      throw new Error('Incident and visit identities must be distinct.');
    }
    const { data, error } = await this.client.rpc('report_storyops_incident_and_pause', {
      p_company_id: this.companyId,
      p_command_id: command.commandId,
      p_expected_visit_version: command.expectedVersion,
      p_payload: payload,
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError(command.commandType, error);
    const receipt = incidentPauseReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== command.commandId ||
      receipt.commandType !== command.commandType ||
      receipt.requestHash !== command.requestHash ||
      receipt.actorUserId !== payload.actorUserId ||
      receipt.entityId !== payload.entityId ||
      receipt.incident.id !== payload.entityId ||
      receipt.incident.incidentNumber !== payload.incidentNumber ||
      receipt.visit.id !== payload.visitId ||
      receipt.visit.jobId !== payload.jobId ||
      receipt.visit.propertyId !== payload.propertyId ||
      receipt.visit.submittedExpectedVersion !== command.expectedVersion ||
      receipt.visit.previousVersion < receipt.visit.submittedExpectedVersion ||
      receipt.visit.currentStatus !== 'paused' ||
      receipt.visit.currentVersion !==
        (receipt.visit.previousStatus === 'paused'
          ? receipt.visit.previousVersion
          : receipt.visit.previousVersion + 1) ||
      receipt.stoppedTimeEntries.some((entry) => entry.currentVersion !== entry.previousVersion + 1)
    ) {
      throw new Error(
        'Atomic incident receipt did not match the exact submitted stop-work request.',
      );
    }
    return receipt;
  }

  async queueTransactionalDelivery(input: {
    action: 'quote.delivery' | 'visit.on_my_way';
    entityId: string;
    entityVersion: number;
    channel: 'sms' | 'email';
    commandId?: string;
  }): Promise<TransactionalDeliveryCommandReceipt> {
    const commandId = input.commandId ?? crypto.randomUUID();
    if (
      !z.string().uuid().safeParse(commandId).success ||
      !z.string().uuid().safeParse(input.entityId).success ||
      !Number.isInteger(input.entityVersion) ||
      input.entityVersion < 1
    ) {
      throw new Error(
        'Transactional delivery requires an exact entity, version, channel, and command ID.',
      );
    }
    const requestHash = await sha256Hex(
      `${input.action}|${input.entityId}|${input.entityVersion}|${input.channel}`,
    );
    const { data, error } = await this.client.rpc('queue_storyops_transactional_delivery', {
      p_company_id: this.companyId,
      p_command_id: commandId,
      p_action_type: input.action,
      p_entity_id: input.entityId,
      p_expected_version: input.entityVersion,
      p_channel: input.channel,
      p_request_hash: requestHash,
    });
    if (error) throw repositoryError(input.action, error);
    const receipt = transactionalDeliveryCommandReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== commandId ||
      receipt.requestHash !== requestHash ||
      receipt.action !== input.action ||
      receipt.entityId !== input.entityId ||
      receipt.entityVersion !== input.entityVersion ||
      receipt.channel !== input.channel ||
      receipt.providerSubmissionAsserted ||
      receipt.externalDeliveryClaimed
    ) {
      throw new Error('Transactional delivery receipt did not match the exact queued command.');
    }
    return receipt;
  }

  async finalizeVisitMedia(command: StoryOpsCommand): Promise<StoryOpsCommandResult> {
    if (command.commandType !== 'media.register' || command.expectedVersion !== 0) {
      throw new Error('Media finalization requires an exact create-only media.register command.');
    }
    const { data, error } = await this.client.functions.invoke('field-media-finalize', {
      body: {
        companyId: this.companyId,
        command,
      },
    });
    if (error) throw repositoryError('Media finalization', error);
    const result = commandResult(data);
    if (
      result.commandId !== command.commandId ||
      result.commandType !== command.commandType ||
      result.requestHash !== command.requestHash
    ) {
      throw new Error('Media finalization receipt identity did not match the submitted command.');
    }
    return result;
  }

  async executeGoldenPathCommand(
    command: StoryOpsGoldenPathCommand,
  ): Promise<StoryOpsCommandResult> {
    let effectiveCommand = command;
    if (
      command.commandType === 'job.book' &&
      command.payload.schedulingEvidenceReceiptId === undefined
    ) {
      const jobId = z.string().uuid().parse(command.payload.entityId);
      const { data: candidateData, error: candidateError } = await this.client.rpc(
        'get_storyops_booking_candidate',
        {
          p_company_id: this.companyId,
          p_job_id: jobId,
          p_job_version: command.expectedVersion,
        },
      );
      if (candidateError) throw repositoryError('Live scheduling evidence', candidateError);
      const candidate = z
        .object({
          companyId: z.literal(this.companyId),
          jobId: z.literal(jobId),
          jobVersion: z.literal(command.expectedVersion),
          schedulingEvidenceReceiptId: z.string().uuid(),
          expiresAt: z.string().datetime({ offset: true }),
          evidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict()
        .parse(candidateData);
      if (Date.parse(candidate.expiresAt) <= Date.now()) {
        throw new Error('Live scheduling evidence expired before booking.');
      }
      effectiveCommand = await buildStoryOpsGoldenPathCommand({
        commandId: command.commandId,
        commandType: command.commandType,
        expectedVersion: command.expectedVersion,
        payload: {
          entityId: jobId,
          schedulingEvidenceReceiptId: candidate.schedulingEvidenceReceiptId,
        },
      });
    }
    const { data, error } = await this.client.rpc('execute_storyops_golden_path_command', {
      p_company_id: this.companyId,
      p_command_id: effectiveCommand.commandId,
      p_command_type: effectiveCommand.commandType,
      p_expected_version: effectiveCommand.expectedVersion,
      p_payload: effectiveCommand.payload,
      p_request_hash: effectiveCommand.requestHash,
    });
    if (error) throw repositoryError(effectiveCommand.commandType, error);
    const result = commandResult(data);
    if (
      result.commandId !== effectiveCommand.commandId ||
      result.commandType !== effectiveCommand.commandType ||
      result.requestHash !== effectiveCommand.requestHash
    ) {
      throw new Error('Golden-path receipt identity did not match the submitted command.');
    }
    return result;
  }

  async refreshSchedulingEvidence(input: {
    jobId: string;
    expectedJobVersion: number;
    startsAt: string;
    endsAt: string;
    crewId?: string;
  }): Promise<SchedulingEvidenceResult> {
    const jobId = z.string().uuid().parse(input.jobId);
    const expectedJobVersion = z.number().int().positive().parse(input.expectedJobVersion);
    const startsAt = z.string().datetime({ offset: true }).parse(input.startsAt);
    const endsAt = z.string().datetime({ offset: true }).parse(input.endsAt);
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new Error('Scheduling evidence requires an end after the proposed start.');
    }
    const crewId = input.crewId ? z.string().uuid().parse(input.crewId) : undefined;
    const idempotencyKey = [
      'schedule',
      jobId,
      `v${expectedJobVersion}`,
      String(Date.parse(startsAt)),
      ...(crewId ? [crewId] : []),
    ].join(':');
    const { data, error } = await this.client.functions.invoke('scheduling-evidence', {
      body: {
        companyId: this.companyId,
        jobId,
        expectedJobVersion,
        ...(crewId ? { crewId } : {}),
        window: { start: startsAt, end: endsAt },
        idempotencyKey,
      },
    });
    if (error) throw repositoryError('Scheduling evidence refresh', error);
    const result = schedulingEvidenceResponseSchema.parse(data);
    if (
      result.companyId !== this.companyId ||
      result.jobId !== jobId ||
      result.jobVersion !== expectedJobVersion ||
      Date.parse(result.window.start) !== Date.parse(startsAt) ||
      Date.parse(result.window.end) !== Date.parse(endsAt)
    ) {
      throw new Error('Scheduling evidence response did not match the proposed job and window.');
    }
    if (
      result.bookable &&
      (!result.receipt ||
        result.mode !== 'live' ||
        result.status !== 'ready_to_book' ||
        result.receipt.jobId !== jobId ||
        result.receipt.jobVersion !== expectedJobVersion ||
        result.receipt.companyId !== this.companyId ||
        Date.parse(result.receipt.startsAt) !== Date.parse(startsAt) ||
        Date.parse(result.receipt.endsAt) !== Date.parse(endsAt))
    ) {
      throw new Error('Bookable scheduling evidence was incomplete or bound to another request.');
    }
    return result;
  }

  async loadSchedulingSuggestions(input: {
    jobId: string;
    expectedJobVersion: number;
    crewId?: string;
  }): Promise<SchedulingSuggestionsResponse> {
    const jobId = z.string().uuid().parse(input.jobId);
    const expectedJobVersion = z.number().int().positive().parse(input.expectedJobVersion);
    const crewId = input.crewId ? z.string().uuid().parse(input.crewId) : undefined;
    const { data, error } = await this.client.functions.invoke('scheduling-suggestions', {
      body: {
        companyId: this.companyId,
        jobId,
        expectedJobVersion,
        ...(crewId ? { crewId } : {}),
      },
    });
    if (error) throw repositoryError('Scheduling suggestions', error);
    const result = schedulingSuggestionsResponseSchema.parse(data);
    if (
      result.companyId !== this.companyId ||
      result.jobId !== jobId ||
      result.jobVersion !== expectedJobVersion
    ) {
      throw new Error('Scheduling suggestions did not match the selected job version.');
    }
    if (
      result.candidates.some(
        (candidate) =>
          candidate.liveValidation.providerCalendar !== 'unknown' ||
          candidate.liveValidation.route !== 'unknown' ||
          candidate.liveValidation.weather !== 'unknown',
      )
    ) {
      throw new Error('A scheduling suggestion asserted unverified live provider evidence.');
    }
    return result;
  }

  async refreshDispatchClearance(input: {
    visitId: string;
    expectedVisitVersion: number;
    currentOrigin: DispatchCurrentOrigin;
  }): Promise<DispatchClearanceResult> {
    const visitId = z.string().uuid().parse(input.visitId);
    const expectedVisitVersion = z.number().int().positive().parse(input.expectedVisitVersion);
    const currentOrigin = assertDispatchCurrentOriginFresh(input.currentOrigin);
    const idempotencyKey = dispatchClearanceIdempotencyKey({
      visitId,
      visitVersion: expectedVisitVersion,
      currentOrigin,
    });
    const { data, error } = await this.client.functions.invoke('dispatch-clearance', {
      body: {
        companyId: this.companyId,
        visitId,
        expectedVisitVersion,
        currentOrigin,
        idempotencyKey,
      },
    });
    if (error) throw repositoryError('Dispatch clearance refresh', error);
    const result = dispatchClearanceResponseSchema.parse(data);
    if (
      result.companyId !== this.companyId ||
      result.visitId !== visitId ||
      result.visitVersion !== expectedVisitVersion
    ) {
      throw new Error('Dispatch clearance response did not match the selected visit version.');
    }
    if (
      result.cleared &&
      (!result.receipt ||
        result.receipt.companyId !== this.companyId ||
        result.receipt.visitId !== visitId ||
        result.receipt.visitVersion !== expectedVisitVersion ||
        result.receipt.currentOrigin.readingId !== currentOrigin.readingId ||
        result.receipt.currentOrigin.observedAt !== currentOrigin.observedAt ||
        result.receipt.evidenceMode !== 'live' ||
        result.receipt.routeDisposition !== 'eligible' ||
        result.receipt.weatherDisposition !== 'eligible' ||
        result.receipt.unknowns.length > 0 ||
        result.receipt.conflicts.length > 0 ||
        Date.parse(result.receipt.expiresAt) <= Date.now())
    ) {
      throw new Error('Dispatch clearance did not contain fresh exact live evidence.');
    }
    return result;
  }

  async consumeDispatchClearance(input: {
    visitId: string;
    expectedVisitVersion: number;
    clearanceReceiptId: string;
    commandId: string;
  }): Promise<DispatchClearanceConsumption> {
    const command = await buildDispatchClearanceConsumption({
      companyId: this.companyId,
      visitId: input.visitId,
      expectedVisitVersion: input.expectedVisitVersion,
      clearanceReceiptId: input.clearanceReceiptId,
      commandId: input.commandId,
    });
    const { data, error } = await this.client.rpc('consume_storyops_dispatch_clearance', {
      p_company_id: command.companyId,
      p_command_id: command.commandId,
      p_expected_visit_version: command.expectedVisitVersion,
      p_clearance_receipt_id: command.clearanceReceiptId,
      p_request_hash: command.requestHash,
    });
    if (error) throw repositoryError('Dispatch clearance consume', error);
    const receipt = dispatchClearanceConsumptionSchema.parse(data);
    if (
      receipt.companyId !== command.companyId ||
      receipt.visitId !== command.visitId ||
      receipt.clearanceReceiptId !== command.clearanceReceiptId ||
      receipt.commandId !== command.commandId ||
      receipt.previousVersion !== command.expectedVisitVersion ||
      receipt.requestHash !== command.requestHash
    ) {
      throw new Error('Dispatch consumption receipt did not match the exact selected visit.');
    }
    return receipt;
  }

  async startDepositCheckout(input: {
    quoteId: string;
    quoteVersion: number;
    commandId?: string;
  }): Promise<DepositCheckoutResult> {
    const commandId = input.commandId ?? input.quoteId;
    if (
      !z.string().uuid().safeParse(input.quoteId).success ||
      !z.string().uuid().safeParse(commandId).success ||
      !Number.isInteger(input.quoteVersion) ||
      input.quoteVersion < 1
    ) {
      throw new Error('Deposit checkout requires a versioned quote and stable command ID.');
    }
    const { data, error } = await this.client.functions.invoke('golden-path', {
      body: {
        companyId: this.companyId,
        action: 'deposit.checkout',
        commandId,
        entityId: input.quoteId,
        expectedVersion: input.quoteVersion,
      },
    });
    if (error) throw repositoryError('Deposit checkout', error);
    return z
      .object({
        action: z.literal('deposit.checkout'),
        status: z.enum(['checkout_open', 'not_required', 'already_verified']),
        mode: z.enum(['live', 'sandbox', 'none']),
        quoteId: z.string().uuid(),
        jobId: z.string().uuid(),
        invoiceId: z.string().uuid(),
        amount: z.string().regex(/^\d+\.\d{2}$/u),
        currency: z.literal('USD'),
        paymentVerified: z.boolean(),
        depositReady: z.boolean(),
        replayed: z.boolean(),
        checkoutId: z.string().startsWith('cs_').optional(),
        checkoutUrl: z.string().url().optional(),
        sandboxReceipt: z.string().optional(),
      })
      .strict()
      .refine((result) => result.quoteId === input.quoteId, {
        message: 'Deposit checkout receipt quote did not match the request.',
      })
      .parse(data);
  }

  async startInvoiceCheckout(input: {
    invoiceId: string;
    invoiceVersion: number;
    commandId?: string;
  }): Promise<InvoiceCheckoutResult> {
    const commandId = input.commandId ?? crypto.randomUUID();
    if (
      !z.string().uuid().safeParse(input.invoiceId).success ||
      !z.string().uuid().safeParse(commandId).success ||
      !Number.isInteger(input.invoiceVersion) ||
      input.invoiceVersion < 1
    ) {
      throw new Error('Invoice checkout requires an exact invoice version and command UUID.');
    }
    const { data, error } = await this.client.functions.invoke('golden-path', {
      body: {
        companyId: this.companyId,
        action: 'invoice.checkout',
        commandId,
        entityId: input.invoiceId,
        expectedVersion: input.invoiceVersion,
      },
    });
    if (error) throw repositoryError('Invoice checkout', error);
    return z
      .object({
        action: z.literal('invoice.checkout'),
        status: z.literal('checkout_open'),
        mode: z.enum(['live', 'sandbox']),
        quoteId: z.string().uuid(),
        jobId: z.string().uuid(),
        invoiceId: z.literal(input.invoiceId),
        invoiceVersion: z.literal(input.invoiceVersion),
        amount: z.string().regex(/^\d+\.\d{2}$/u),
        currency: z.literal('USD'),
        paymentVerified: z.literal(false),
        invoicePaid: z.literal(false),
        replayed: z.boolean(),
        checkoutId: z.string().startsWith('cs_'),
        checkoutUrl: z.string().url().optional(),
        sandboxReceipt: z.string().optional(),
      })
      .strict()
      .parse(data);
  }

  async executePostServiceAction(input: PostServiceActionInput): Promise<PostServiceActionResult> {
    const commandId = input.commandId ?? crypto.randomUUID();
    if (
      !z.string().uuid().safeParse(input.invoiceId).success ||
      !z.string().uuid().safeParse(commandId).success ||
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      throw new Error(
        'Post-service action requires a versioned paid invoice and stable command ID.',
      );
    }
    const { data, error } = await this.client.functions.invoke('post-service', {
      body: {
        companyId: this.companyId,
        ...input,
        commandId,
      },
    });
    if (error) throw repositoryError(input.action, error);
    const result = z
      .object({
        schemaVersion: z.literal('storyops-post-service-v1'),
        companyId: z.string().uuid(),
        action: z.enum(['review.request', 'referral.invite', 'maintenance.activate']),
        commandId: z.string().uuid(),
        invoiceId: z.string().uuid(),
        invoiceVersion: z.number().int().positive(),
        jobId: z.string().uuid(),
        recordId: z.string().uuid(),
        domainRecordId: z.string().uuid(),
        status: z.enum(['queued', 'completed', 'failed', 'cancelled', 'active']),
        replayed: z.boolean(),
        alreadyExisted: z.boolean(),
        requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
        serverTime: z.string(),
        channel: z.enum(['sms', 'email']).optional(),
        scheduledAt: z.string().optional(),
        cadence: z
          .enum([
            'weekly',
            'biweekly',
            'every_four_weeks',
            'monthly',
            'quarterly',
            'semiannual',
            'annual',
            'custom',
          ])
          .optional(),
        nextDueDate: z.string().optional(),
        requiresFreshEstimate: z.literal(true).optional(),
      })
      .strict()
      .parse(data) as PostServiceActionResult;
    if (
      result.companyId !== this.companyId ||
      result.commandId !== commandId ||
      result.action !== input.action ||
      result.invoiceId !== input.invoiceId ||
      result.invoiceVersion !== input.expectedVersion
    ) {
      throw new Error('Post-service receipt identity did not match the submitted action.');
    }
    return result;
  }

  async checkIntegrationHealth(): Promise<IntegrationHealthResult> {
    const { data, error } = await this.client.functions.invoke('integration-health', {
      body: { companyId: this.companyId },
    });
    if (error) throw repositoryError('Integration health check', error);
    return z
      .object({
        overall: z.enum(['healthy', 'not_configured', 'degraded', 'down']),
        checkedAt: z.string(),
        dispatchOriginRetention: dispatchOriginRetentionProjectionSchema,
        outboundWorkers: outboundWorkerHealthProjectionSchema,
        providers: z.array(
          z
            .object({
              id: z.string().optional(),
              provider: z.string(),
              capability: z.string(),
              mode: z.string(),
              status: z.enum(['healthy', 'not_configured', 'degraded', 'down']),
              checkedAt: z.string().optional(),
              message: z.string().optional(),
            })
            .passthrough(),
        ),
      })
      .parse(data);
  }

  async loadIdentityProvisioningState(): Promise<IdentityProvisioningState> {
    return new TrustedIdentityProvisioningClient(this.client, this.companyId).loadState();
  }

  async provisionIdentity(input: IdentityProvisioningInput): Promise<IdentityProvisioningReceipt> {
    return new TrustedIdentityProvisioningClient(this.client, this.companyId).execute(input);
  }

  async createCustomerProperty(
    input: CreateCustomerPropertyInput,
    identifiers: {
      operationId: string;
      customerId: string;
      propertyId: string;
    },
  ): Promise<CustomerPropertyCreateReceipt> {
    const request = await buildCustomerPropertyCreateRequest(input, identifiers);
    const { data, error } = await this.client.rpc('create_storyops_customer_property', {
      p_company_id: this.companyId,
      p_operation_id: request.operationId,
      p_payload: request.payload,
      p_request_hash: request.requestHash,
    });
    if (error) throw repositoryError('Atomic customer/property creation', error);
    const receipt = customerPropertyCreateReceiptSchema.parse(data);
    if (
      receipt.operationId !== request.operationId ||
      receipt.customerId !== request.customerId ||
      receipt.propertyId !== request.propertyId ||
      receipt.requestHash !== request.requestHash
    ) {
      throw new Error('Customer/property receipt did not match the complete submitted request.');
    }
    return receipt;
  }

  async requestPropertyGeocode(input: {
    propertyId: string;
    expectedPropertyVersion: number;
    operationId: string;
  }): Promise<PropertyGeocodeCandidatesReceipt> {
    const request = propertyGeocodeLookupRequestSchema.parse({
      schemaVersion: 'storyops-property-geocode-lookup-v1',
      companyId: this.companyId,
      propertyId: input.propertyId,
      expectedPropertyVersion: input.expectedPropertyVersion,
      operationId: input.operationId,
    });
    const { data, error } = await this.client.functions.invoke('property-geocode', {
      body: request,
    });
    if (error) throw repositoryError('Property geocode lookup', error);
    const receipt = propertyGeocodeCandidatesReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.operationId !== request.operationId ||
      receipt.propertyId !== request.propertyId ||
      receipt.propertyVersion !== request.expectedPropertyVersion ||
      !receipt.requiresHumanConfirmation ||
      receipt.candidates.some(
        (candidate) =>
          candidate.propertyId !== request.propertyId ||
          candidate.propertyVersion !== request.expectedPropertyVersion,
      )
    ) {
      throw new Error('Property geocode candidates escaped the exact submitted property version.');
    }
    return receipt;
  }

  async confirmPropertyGeocode(input: {
    propertyId: string;
    expectedPropertyVersion: number;
    candidateId: string;
    commandId: string;
  }): Promise<PropertyGeocodeConfirmationReceipt> {
    const hashPayload = propertyGeocodeConfirmationHashPayload({
      propertyId: input.propertyId,
      propertyVersion: input.expectedPropertyVersion,
      candidateId: input.candidateId,
    });
    const commandId = z.string().uuid().parse(input.commandId);
    const requestHash = await canonicalSha256Hex(hashPayload);
    const { data, error } = await this.client.rpc('confirm_storyops_property_geocode_candidate', {
      p_company_id: this.companyId,
      p_command_id: commandId,
      p_property_id: hashPayload.propertyId,
      p_expected_property_version: hashPayload.propertyVersion,
      p_candidate_id: hashPayload.candidateId,
      p_request_hash: requestHash,
    });
    if (error) throw repositoryError('Property geocode confirmation', error);
    const receipt = propertyGeocodeConfirmationReceiptSchema.parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== commandId ||
      receipt.propertyId !== hashPayload.propertyId ||
      receipt.candidateId !== hashPayload.candidateId ||
      receipt.propertyVersion <= hashPayload.propertyVersion ||
      receipt.requestHash !== requestHash
    ) {
      throw new Error('Property geocode confirmation did not match the exact reviewed candidate.');
    }
    return receipt;
  }

  async loadEstimateContext(propertyId?: string): Promise<LiveEstimateContext> {
    if (propertyId && !z.string().uuid().safeParse(propertyId).success) {
      throw new Error('Estimate context requires a valid property ID.');
    }
    const { data, error } = await this.client.functions.invoke('estimate-workflow', {
      body: {
        operation: 'context',
        companyId: this.companyId,
        propertyId,
      },
    });
    if (error) throw repositoryError('Estimate context', error);
    const context = liveEstimateContextSchema.parse(data);
    if (context.companyId !== this.companyId) {
      throw new Error('Estimate context company identity did not match the workspace.');
    }
    return context;
  }

  async loadScopePhotoContext(propertyId: string): Promise<ScopePhotoContext> {
    if (!z.string().uuid().safeParse(propertyId).success) {
      throw new Error('Scope-photo context requires a valid property ID.');
    }
    const { data, error } = await this.client.functions.invoke('scope-photo-workflow', {
      body: {
        operation: 'context',
        companyId: this.companyId,
        propertyId,
      },
    });
    if (error) throw repositoryError('Scope-photo context', error);
    const context = scopePhotoContextSchema.parse(data);
    if (context.companyId !== this.companyId || context.propertyId !== propertyId) {
      throw new Error('Scope-photo context identity did not match the requested property.');
    }
    return context;
  }

  async createScopePhotoRequest(input: {
    customerId: string;
    propertyId: string;
    note: string;
    idempotencyKey: string;
  }): Promise<{ requestId: string; replayed: boolean }> {
    const { data, error } = await this.client.functions.invoke('scope-photo-workflow', {
      body: {
        operation: 'create_request',
        companyId: this.companyId,
        customerId: input.customerId,
        propertyId: input.propertyId,
        note: input.note,
        expiresInDays: 7,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (error) throw repositoryError('Scope-photo request', error);
    const receipt = scopePhotoRequestReceiptSchema.parse(data);
    if (receipt.customerId !== input.customerId || receipt.propertyId !== input.propertyId) {
      throw new Error('Scope-photo request receipt did not match the requested property.');
    }
    return { requestId: receipt.requestId, replayed: receipt.replayed };
  }

  async uploadScopePhoto(input: {
    requestId: string;
    checklistItemCode: string;
    file: File;
    commandId: string;
  }): Promise<{ assetId: string; replayed: boolean }> {
    const contentType = assertScopePhotoFile(input.file);
    const checksumSha256 = await sha256File(input.file);
    const assetId = input.commandId;
    const capturedDate = new Date(input.file.lastModified || Date.now());
    const capturedAt = Number.isNaN(capturedDate.valueOf())
      ? new Date().toISOString()
      : capturedDate.toISOString();
    const { data: preparedData, error: prepareError } = await this.client.functions.invoke(
      'scope-photo-workflow',
      {
        body: {
          operation: 'prepare_upload',
          companyId: this.companyId,
          requestId: input.requestId,
          checklistItemCode: input.checklistItemCode,
          assetId,
          contentType,
          byteSize: input.file.size,
          checksumSha256,
          capturedAt,
          idempotencyKey: input.commandId,
        },
      },
    );
    if (prepareError) throw repositoryError('Scope-photo upload preparation', prepareError);
    const prepared = preparedScopePhotoUploadSchema.parse(preparedData);
    const storage = this.client.storage.from('job-media');
    if (!storage.uploadToSignedUrl) {
      throw new Error('The configured Storage client cannot use private signed upload targets.');
    }
    const { error: uploadError } = await storage.uploadToSignedUrl(
      prepared.objectPath,
      prepared.token,
      input.file,
      { contentType },
    );
    const { data: finalizedData, error: finalizeError } = await this.client.functions.invoke(
      'scope-photo-workflow',
      {
        body: {
          operation: 'finalize_upload',
          companyId: this.companyId,
          requestId: input.requestId,
          idempotencyKey: input.commandId,
        },
      },
    );
    if (finalizeError) {
      throw repositoryError(
        uploadError ? 'Scope-photo upload and finalization' : 'Scope-photo finalization',
        finalizeError,
      );
    }
    const finalized = finalizedScopePhotoUploadSchema.parse(finalizedData);
    if (
      finalized.commandId !== prepared.commandId ||
      finalized.assetId !== prepared.assetId ||
      finalized.requestId !== prepared.requestId
    ) {
      throw new Error('Scope-photo finalization receipt did not match the private upload target.');
    }
    return { assetId: finalized.assetId, replayed: finalized.replayed };
  }

  async analyzeScopePhoto(input: {
    propertyId: string;
    assetId: string;
    idempotencyKey: string;
  }): Promise<string> {
    const { data, error } = await this.client.functions.invoke('photo-analyze', {
      body: {
        companyId: this.companyId,
        propertyId: input.propertyId,
        assetId: input.assetId,
        purpose: 'scope',
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (error) throw repositoryError('Scope-photo analysis', error);
    return z.object({ analysisId: z.string().uuid() }).passthrough().parse(data).analysisId;
  }

  async confirmScopePhotoMeasurement(input: {
    requestId: string;
    analysisId: string | null;
    sourceAssetIds: string[];
    kind: 'area_sq_ft' | 'length_linear_ft' | 'height_ft' | 'count' | 'stories' | 'duration_hours';
    label: string;
    value: string;
    unit: 'sq_ft' | 'linear_ft' | 'ft' | 'each' | 'story' | 'hour';
    serviceCodes: string[];
    addOnCodes: string[];
    confirmationNote: string;
    idempotencyKey: string;
  }): Promise<{ measurementId: string; replayed: boolean }> {
    const { data, error } = await this.client.functions.invoke('scope-photo-workflow', {
      body: {
        operation: 'confirm_measurement',
        companyId: this.companyId,
        ...input,
      },
    });
    if (error) throw repositoryError('Scope-photo measurement confirmation', error);
    const receipt = confirmedScopeMeasurementSchema.parse(data);
    if (receipt.requestId !== input.requestId) {
      throw new Error('Confirmed measurement receipt did not match the scope request.');
    }
    return { measurementId: receipt.measurementId, replayed: receipt.replayed };
  }

  async reviewScopePhotoRequest(input: {
    requestId: string;
    disposition: 'confirmed_for_estimate' | 'site_verification_required' | 'more_photos_required';
    accessDecision: string;
    riskDecision: string;
    unresolvedUnknowns: string[];
    idempotencyKey: string;
  }): Promise<{ reviewId: string; replayed: boolean }> {
    const { data, error } = await this.client.functions.invoke('scope-photo-workflow', {
      body: {
        operation: 'review_scope',
        companyId: this.companyId,
        ...input,
      },
    });
    if (error) throw repositoryError('Scope-photo review', error);
    const receipt = reviewedScopePhotoRequestSchema.parse(data);
    if (receipt.requestId !== input.requestId) {
      throw new Error('Scope-photo review receipt did not match the requested checklist.');
    }
    return { reviewId: receipt.reviewId, replayed: receipt.replayed };
  }

  async calculateLiveEstimate(input: LiveEstimateRequest): Promise<LiveEstimateReceipt> {
    const { data, error } = await this.client.functions.invoke('estimate-workflow', {
      body: {
        operation: 'calculate',
        companyId: this.companyId,
        ...input,
      },
    });
    if (error) throw repositoryError('Estimate calculation', error);
    return liveEstimateReceiptSchema.parse(data);
  }

  async executeApprovedAction(approvalId: string): Promise<ApprovedActionExecutionResult> {
    if (!z.string().uuid().safeParse(approvalId).success) {
      throw new Error('Approved-action execution requires a valid approval ID.');
    }
    const { data, error } = await this.client.functions.invoke('ai-approved-action', {
      body: {
        companyId: this.companyId,
        approvalId,
        idempotencyKey: `approved:${approvalId}`,
      },
    });
    if (error) throw repositoryError('Approved-action execution', error);
    return z
      .object({
        approvalId: z.string().uuid(),
        actionId: z.string().min(1),
        toolName: z.string().min(1),
        status: z.literal('succeeded'),
        completedAt: z.string(),
        replayed: z.boolean().optional().default(false),
      })
      .refine((result) => result.approvalId === approvalId, {
        message: 'Approved-action receipt identity did not match the request.',
      })
      .parse(data);
  }

  async uploadVisitMedia(input: {
    visitId: string;
    assetId: string;
    blob: Blob;
    filename: string;
    contentType: string;
  }): Promise<{ objectPath: string; checksumSha256: string; byteSize: number }> {
    const prepared = await this.prepareVisitMedia(input);
    await this.uploadPreparedVisitMedia(prepared);
    return {
      objectPath: prepared.objectPath,
      checksumSha256: prepared.checksumSha256,
      byteSize: prepared.byteSize,
    };
  }

  async downloadSdsDocument(input: {
    id: string;
    storageObjectPath: string;
    checksumSha256: string;
  }): Promise<Blob> {
    if (
      !z.string().uuid().safeParse(input.id).success ||
      !input.storageObjectPath.startsWith(`${this.companyId}/`) ||
      !/^[a-f0-9]{64}$/u.test(input.checksumSha256)
    ) {
      throw new Error('SDS download metadata is outside the authenticated company scope.');
    }
    const { data, error } = await this.client.storage.from('sds').download(input.storageObjectPath);
    if (error || !data) {
      throw repositoryError(
        'SDS download',
        error ?? { message: 'The SDS object was not returned by private Storage.' },
      );
    }
    if (data.size < 1 || data.size > 10 * 1024 * 1024) {
      throw new Error('SDS files must be between 1 byte and 10 MB.');
    }
    if (data.type && data.type !== 'application/pdf') {
      throw new Error('SDS Storage returned a non-PDF object.');
    }
    const checksum = await sha256Hex(await blobArrayBuffer(data));
    if (checksum !== input.checksumSha256) {
      throw new Error('SDS Storage bytes did not match the approved SHA-256 metadata.');
    }
    return data.slice(0, data.size, 'application/pdf');
  }

  async downloadCustomerEvidence(input: {
    id: string;
    visitId: string;
    jobId: string;
    objectPath: string;
    contentType: 'image/jpeg' | 'image/png' | 'image/webp';
    byteSize: number;
    checksumSha256: string;
  }): Promise<Blob> {
    if (
      !z.string().uuid().safeParse(input.id).success ||
      !z.string().uuid().safeParse(input.visitId).success ||
      !z.string().uuid().safeParse(input.jobId).success ||
      !input.objectPath.startsWith(`${this.companyId}/visits/${input.visitId}/`) ||
      !Number.isInteger(input.byteSize) ||
      input.byteSize < 1 ||
      input.byteSize > 15 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/u.test(input.checksumSha256)
    ) {
      throw new Error('Completed-work evidence metadata is outside the portal scope.');
    }
    const { data, error } = await this.client.storage.from('job-media').download(input.objectPath);
    if (error || !data) {
      throw repositoryError(
        'Completed-work evidence download',
        error ?? { message: 'The private evidence object was not returned by Storage.' },
      );
    }
    if (
      data.size !== input.byteSize ||
      (data.type !== '' && data.type !== input.contentType) ||
      (await sha256Hex(await blobArrayBuffer(data))) !== input.checksumSha256
    ) {
      throw new Error('Completed-work evidence failed size, type, or checksum reconciliation.');
    }
    return data.slice(0, data.size, input.contentType);
  }

  async publishCompletedWorkEvidence(input: {
    visitId: string;
    assetIds: string[];
    commandId?: string;
  }): Promise<{ replayed: boolean; publishedCount: number; serverTime: string }> {
    const visitId = z.string().uuid().parse(input.visitId);
    const assetIds = [...new Set(input.assetIds.map((id) => z.string().uuid().parse(id)))].sort();
    if (assetIds.length < 1 || assetIds.length > 50 || assetIds.length !== input.assetIds.length) {
      throw new Error('Select 1–50 unique completed-work evidence assets.');
    }
    const commandId = z
      .string()
      .uuid()
      .parse(input.commandId ?? crypto.randomUUID());
    const requestHash = await sha256Hex(
      JSON.stringify(
        canonicalize({
          assetIds,
          commandType: 'completed_work.publish',
          visitId,
        }),
      ),
    );
    const { data, error } = await this.client.rpc('publish_storyops_completed_work_evidence', {
      p_company_id: this.companyId,
      p_command_id: commandId,
      p_visit_id: visitId,
      p_asset_ids: assetIds,
      p_request_hash: requestHash,
    });
    if (error) throw repositoryError('Completed-work evidence publication', error);
    const receipt = z
      .object({
        schemaVersion: z.literal('storyops-completed-work-publication-v1'),
        companyId: z.string().uuid(),
        commandId: z.string().uuid(),
        visitId: z.string().uuid(),
        assetIds: z.array(z.string().uuid()),
        publishedCount: z.number().int().min(1).max(50),
        requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
        replayed: z.boolean(),
        serverTime: z.string().datetime({ offset: true }),
      })
      .strict()
      .parse(data);
    if (
      receipt.companyId !== this.companyId ||
      receipt.commandId !== commandId ||
      receipt.visitId !== visitId ||
      receipt.requestHash !== requestHash ||
      receipt.publishedCount !== assetIds.length ||
      receipt.assetIds.join(',') !== assetIds.join(',')
    ) {
      throw new Error('Completed-work publication receipt did not match the exact selection.');
    }
    return {
      replayed: receipt.replayed,
      publishedCount: receipt.publishedCount,
      serverTime: receipt.serverTime,
    };
  }

  async prepareVisitMedia(input: {
    visitId: string;
    assetId: string;
    incidentId?: string;
    purpose?: PreparedVisitMedia['purpose'];
    blob: Blob;
    filename: string;
    contentType: string;
    capturedAt?: string;
  }): Promise<PreparedVisitMedia> {
    if (
      !z.string().uuid().safeParse(input.visitId).success ||
      !z.string().uuid().safeParse(input.assetId).success
    ) {
      throw new Error('Visit media requires stable visit and asset UUIDs.');
    }
    const purpose = z
      .enum(['before', 'after', 'signature', 'incident', 'safety', 'damage'])
      .parse(input.purpose ?? 'before');
    const incidentEvidence = ['incident', 'safety', 'damage'].includes(purpose);
    if (
      incidentEvidence !== Boolean(input.incidentId) ||
      (input.incidentId !== undefined && !z.string().uuid().safeParse(input.incidentId).success)
    ) {
      throw new Error(
        'Incident, safety, and damage media require one exact incident UUID; ordinary visit media forbids it.',
      );
    }
    const contentType = z.enum(['image/jpeg', 'image/png', 'image/webp']).parse(input.contentType);
    if (input.blob.size < 1 || input.blob.size > 15 * 1024 * 1024) {
      throw new Error('Evidence files must be between 1 byte and 15 MB.');
    }
    const safeFilename =
      input.filename
        .normalize('NFKD')
        .replaceAll(/[^a-zA-Z0-9._-]/gu, '-')
        .replaceAll(/-+/gu, '-')
        .slice(-96) || 'evidence.bin';
    const checksumSha256 = await sha256Hex(await blobArrayBuffer(input.blob));
    const objectPath = incidentEvidence
      ? `${this.companyId}/incidents/${input.incidentId}/visits/${input.visitId}/${input.assetId}-${checksumSha256.slice(0, 16)}-${safeFilename}`
      : `${this.companyId}/visits/${input.visitId}/${input.assetId}-${checksumSha256.slice(0, 16)}-${safeFilename}`;
    return {
      assetId: input.assetId,
      visitId: input.visitId,
      incidentId: input.incidentId,
      purpose,
      blob: input.blob.slice(0, input.blob.size, contentType),
      filename: safeFilename,
      contentType,
      objectPath,
      checksumSha256,
      byteSize: input.blob.size,
      capturedAt: input.capturedAt ?? new Date().toISOString(),
    };
  }

  async uploadPreparedVisitMedia(input: PreparedVisitMedia): Promise<void> {
    const incidentEvidence = ['incident', 'safety', 'damage'].includes(input.purpose);
    if (
      incidentEvidence !== Boolean(input.incidentId) ||
      (input.incidentId !== undefined && !z.string().uuid().safeParse(input.incidentId).success)
    ) {
      throw new Error('Prepared incident media lost its exact incident association.');
    }
    const expectedPrefix = incidentEvidence
      ? `${this.companyId}/incidents/${input.incidentId}/visits/${input.visitId}/${input.assetId}-`
      : `${this.companyId}/visits/${input.visitId}/${input.assetId}-`;
    if (
      !input.objectPath.startsWith(expectedPrefix) ||
      !input.objectPath.includes(input.checksumSha256.slice(0, 16))
    ) {
      throw new Error('Prepared media object identity does not match its company and visit scope.');
    }
    const localChecksum = await sha256Hex(await blobArrayBuffer(input.blob));
    if (
      localChecksum !== input.checksumSha256 ||
      input.blob.size !== input.byteSize ||
      input.blob.type !== input.contentType
    ) {
      throw new Error('Prepared media bytes no longer match their captured checksum metadata.');
    }
    const bucket = this.client.storage.from('job-media');
    const { error: uploadError } = await bucket.upload(input.objectPath, input.blob, {
      contentType: input.contentType,
      upsert: false,
    });
    const { data: durableBlob, error: downloadError } = await bucket.download(input.objectPath);
    if (downloadError || !durableBlob) {
      if (uploadError) throw repositoryError('Media upload', uploadError);
      throw repositoryError(
        'Media reconciliation',
        downloadError ?? { message: 'The uploaded object could not be read back.' },
      );
    }
    const durableChecksum = await sha256Hex(await blobArrayBuffer(durableBlob));
    if (durableBlob.size !== input.byteSize || durableChecksum !== input.checksumSha256) {
      throw new Error(
        'Durable media reconciliation failed because stored bytes do not match the local SHA-256 packet.',
      );
    }
  }

  async removeUploadedMedia(objectPath: string): Promise<void> {
    const { error } = await this.client.storage.from('job-media').remove([objectPath]);
    if (error) throw repositoryError('Media cleanup', error);
  }
}

let liveRepositorySingleton: LiveStoryOpsRepository | undefined;

export function getLiveStoryOpsRepository(
  config = readLiveRepositoryConfig(),
): LiveStoryOpsRepository | undefined {
  if (!config.requested || config.configurationError) return undefined;
  if (!config.url || !config.anonKey || !config.companyId) return undefined;
  if (!liveRepositorySingleton) {
    const client: SupabaseClient = createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    liveRepositorySingleton = new LiveStoryOpsRepository(
      client as unknown as StoryOpsSupabaseAdapter,
      config.companyId,
    );
  }
  return liveRepositorySingleton;
}

export function liveRole(workspace: LiveWorkspace): AppRole {
  return workspace.session.role;
}
