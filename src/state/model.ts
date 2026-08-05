import type { PreparedVisitMedia, StoryOpsCommand } from './liveRepository';
import type {
  CompanyConfiguration,
  CompanyConfigurationPublicationMode,
  CompanyConfigurationRecord,
} from '@/domain/companyConfiguration';
import type { CompanyConfigurationReceipt } from './companyConfiguration';
import type { OperatingBaselineReceipt, OperatingBaselineState } from './operatingBaseline';
import type {
  AuthoritativeProvider,
  CompanyLaunchAuthorizationReceipt,
  ProviderActivationMode,
  ProviderActivationReceipt,
  ProviderLaunchState,
} from './providerLaunch';
import type { ExteriorServiceCode } from '@/data/exteriorServiceTemplates';
import type {
  LiveEstimateContext,
  LiveEstimateReceipt,
  LiveEstimateRequest,
} from './liveEstimating';
import type { LiveProfitabilityKpis } from '@/core/finance/profitability';
import type {
  DurableAiOfficeRun,
  LiveAiOfficeRecent,
  LiveAiOfficeRunInput,
} from '@/core/ai/liveOffice';
import type { CompanyControlState, CompanyOperationalStatusCommandInput } from './companyControl';
import type {
  PilotReleaseEvidenceInput,
  PilotReleaseEvidenceReceipt,
  PilotReleaseEvidenceState,
} from '@/core/pilot/releaseEvidence';
import type {
  AttachRecurringDueEstimateInput,
  CreateRecurringDueWorkInput,
  RecurringDueEstimateReceipt,
  RecurringDueWorkReceipt,
  RecurringDueWorkState,
} from '@/core/recurring/dueWork';
import type { SchedulingSuggestionsResponse } from '@/core/scheduling/suggestions';
import type {
  FinalizedSdsRegistrationReceipt,
  MaterialSdsRegistryState,
  RegisterMaterialSdsInput,
} from '@/core/materials/sdsRegistry';
import type { DispatchCurrentOrigin } from '@/core/scheduling/dispatchOrigin';
import type {
  CustomerPropertyCreateReceipt,
  PropertyGeocodeCandidatesReceipt,
  PropertyGeocodeConfirmationReceipt,
} from '@/core/properties/contracts';
import type { IncidentPauseReceipt } from '@/core/incidents/contracts';
import type { DispatchOriginRetentionProjection } from '@/core/integrations/dispatchOriginRetention';
import type { OutboundWorkerHealthProjection } from '@/core/integrations/outboundWorkerHealth';

export type AppRole = 'owner' | 'dispatcher' | 'technician' | 'customer';
export type StoryOpsDataMode = 'sandbox' | 'supabase';
export type LiveAuthStatus =
  'disabled' | 'checking' | 'signed_out' | 'signed_in' | 'link_sent' | 'error';

export type LeadStage = 'new' | 'qualified' | 'estimated' | 'quoted' | 'booked';

export type SandboxServiceCode = ExteriorServiceCode;

export interface SandboxSetupProfile {
  businessName: string;
  ownerName: string;
  homePostalCode: string;
  timezone: 'America/Chicago';
  enabledServiceCodes: SandboxServiceCode[];
  policyAcknowledged: true;
  configuredAt: string;
}

export type SandboxSetupInput = Omit<SandboxSetupProfile, 'configuredAt'>;

export interface DemoLead {
  id: string;
  customerId?: string;
  propertyId?: string;
  name: string;
  initials: string;
  source: 'Web' | 'SMS' | 'Phone' | 'Email' | 'Chat' | 'Referral' | 'Manual';
  service: string;
  address: string;
  city: string;
  stage: LeadStage;
  value: string;
  age: string;
  phone: string;
  email: string;
  priority: 'normal' | 'high';
  consent: boolean;
  note: string;
}

export interface DemoEstimate {
  id: string;
  leadId: string;
  estimateNumber: string;
  status: 'draft' | 'ready' | 'pending_approval' | 'approved' | 'quoted';
  priceBookVersion: string;
  drivewaySqFt: string;
  gutterLinearFt: string;
  downspoutCount: string;
  stories: '1' | '2' | '3';
  surface: 'concrete' | 'pavers' | 'aggregate';
  soil: 'light' | 'moderate' | 'heavy';
  access: 'clear' | 'limited';
  risk: 'standard' | 'elevated';
  travelZone: 'DFW-A' | 'DFW-B' | 'DFW-C';
  discountPercent: string;
  serviceSubtotal: string;
  travelFee: string;
  discount: string;
  tax: string;
  total: string;
  deposit: string;
  estimatedCost: string;
  marginPercent: string;
  durationMinutes: number;
  formulaHash: string;
  photoEvidence: {
    confidence: number;
    observations: string[];
    unknowns: string[];
    humanVerified: boolean;
  };
}

export interface DemoApproval {
  id: string;
  reason:
    | 'large_discount'
    | 'negative_review_response'
    | 'refund'
    | 'safety_message'
    | 'campaign_send'
    | 'other';
  title: string;
  summary: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  expiresAt: string;
  entityId: string;
  payloadPreview: string;
  payloadHash?: string;
  blockingFlags?: Array<{
    reason: string;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    summary: string;
  }>;
  policyVersion: string;
  actionType?: string;
  decidedAt?: string;
  consumedAt?: string;
}

export interface DemoVisit {
  id: string;
  jobNumber: string;
  customerName: string;
  address: string;
  service: string;
  date: string;
  startsAt: string;
  endsAt: string;
  crew: string;
  status: 'ready' | 'en_route' | 'on_site' | 'paused' | 'complete' | 'weather_hold';
  weather: {
    temperature?: number;
    precipitation?: number;
    windMph?: number;
    checkedAt?: string;
    disposition?: 'clear' | 'watch' | 'hold';
    provider?: 'nws' | 'mock';
    evidenceMode?: 'live' | 'sandbox';
    freshness?: 'current' | 'stale';
    forecastIssuedAt?: string;
    periodStartsAt?: string;
    periodEndsAt?: string;
    lightningRisk?: 'none' | 'low' | 'elevated' | 'severe' | 'unknown';
    conditionCodes?: string[];
    policyDisposition?: 'eligible' | 'requires_approval' | 'unavailable';
  };
  route: {
    driveMinutes?: number;
    miles?: number;
    checkedAt?: string;
    feasible?: boolean;
    provider?: 'vroom' | 'mock';
    evidenceMode?: 'live' | 'sandbox';
    freshness?: 'current' | 'stale';
    violations?: string[];
  };
  scopeLines?: DemoFieldScopeLine[];
  exclusions?: string[];
  exclusionsStatus?: 'recorded' | 'not_recorded';
  access?: DemoFieldAccessFacts;
  fieldEvidence?: DemoFieldEvidence[];
  changeRequests?: DemoFieldChangeRequest[];
  checklist: DemoChecklistItem[];
  beforePhotos: number;
  afterPhotos: number;
  signature: boolean;
  timerStartedAt?: string;
  elapsedMinutes: number;
  elapsedSeconds: number;
  materials: { name: string; amount: string }[];
  notes: string;
}

export interface DemoFieldScopeLine {
  id: string;
  lineKind: 'service' | 'add_on';
  serviceCode?: string;
  addOnCode?: string;
  description: string;
  quantity: string;
  unit: string;
  sortOrder: number;
}

export interface DemoFieldAccessFacts {
  instructions?: string;
  waterSourceNotes?: string;
  drainageNotes?: string;
  knownHazards: string[];
}

export interface DemoFieldEvidence {
  id: string;
  purpose: 'before' | 'after';
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  byteSize: number;
  checksumSha256: string;
  capturedAt: string;
  syncState: 'pending' | 'synced' | 'failed';
  customerVisible: boolean;
}

export type FieldChangeReasonCode =
  'scope_mismatch' | 'access_blocked' | 'customer_request' | 'site_condition' | 'other';

export interface DemoFieldChangeRequest {
  id: string;
  reasonCode: FieldChangeReasonCode;
  summary: string;
  status: 'submitted' | 'reviewing' | 'resolved' | 'cancelled';
  createdAt: string;
  version: number;
}

export interface DemoIncident {
  id: string;
  visitId: string;
  jobId?: string;
  propertyId?: string;
  jobNumber: string;
  kind: 'near_miss' | 'property_damage' | 'injury_or_exposure' | 'other';
  summary: string;
  status: 'open' | 'closed';
  reportedAt: string;
  reportedBy: AppRole | 'system';
  automationsPaused: true;
}

export interface DemoChecklistItem {
  id: string;
  label: string;
  detail: string;
  required: boolean;
  safetyCritical: boolean;
  complete: boolean;
}

export interface DemoInvoice {
  id: string;
  number: string;
  customerName: string;
  jobNumber: string;
  issueDate: string;
  dueDate: string;
  total: string;
  paid: string;
  balance: string;
  status: 'draft' | 'open' | 'paid' | 'past_due';
}

export interface DemoTrace {
  id: string;
  time: string;
  agent: string;
  action: string;
  result: 'succeeded' | 'approval_required' | 'blocked';
  detail: string;
  traceId: string;
  promptVersion: string;
}

export interface DemoShowcaseCheckpoint {
  id:
    | 'owner-dashboard'
    | 'lead-qualification'
    | 'photo-assist'
    | 'quote-and-terms'
    | 'dispatch-and-route'
    | 'field-closeout';
  title: string;
  role: AppRole[];
  status: 'complete' | 'current' | 'blocked';
  summary: string;
  detail: string;
  actions: string[];
  actionLabel?: string;
  href: string;
  requiresApproval: boolean;
  evidenceSources: string[];
}

export interface DemoShowcaseState {
  id: 'showcase-v1.2';
  source: 'deterministic_local_fixture';
  enabled: boolean;
  badge: 'DEMO';
  route: 'showcase';
  generatedAt: string;
  checkpoints: DemoShowcaseCheckpoint[];
  completeCount: number;
  uncertainty: string[];
  whatIsNext: DemoShowcaseCheckpoint | undefined;
}

export interface DemoShowcaseBadge {
  label: 'DEMO DATA';
  environment: 'local';
  state: 'sandbox';
  scope: 'DFW Exterior Services pilot';
  policyBoundaries: string[];
  ownerNotice: string;
}

export interface DemoAuditEvent {
  id: string;
  time: string;
  actor: string;
  action: string;
  entity: string;
  outcome: string;
  requestId: string;
  immutable: true;
}

export interface LiveAuditEvent {
  id: string;
  occurredAt: string;
  actorType: string;
  actorRef: string;
  action: string;
  entityType: string;
  entityId?: string;
  requestId?: string;
  traceId?: string;
  hasBefore: boolean;
  hasAfter: boolean;
  retentionClass: string;
  retainUntil?: string;
  legalHold: boolean;
}

export interface LiveAuditFeed {
  schemaVersion: 'storyops-audit-feed-v1';
  companyId: string;
  events: LiveAuditEvent[];
  hasMore: boolean;
  nextCursor?: {
    occurredAt: string;
    id: string;
  };
  pageLimit: number;
  redacted: true;
  serverTime: string;
}

export interface QuoteAcceptanceInput {
  signerName: string;
  acknowledged: boolean;
}

export interface DemoAutomation {
  id: string;
  name: string;
  trigger: string;
  status: 'succeeded' | 'waiting_approval' | 'scheduled' | 'failed';
  lastRun: string;
  nextRun: string;
  reversibility: 'reversible' | 'compensating_action' | 'irreversible';
}

export interface DemoNotification {
  id: string;
  title: string;
  body: string;
  href: string;
  read: boolean;
}

export interface DemoToast {
  id: string;
  title: string;
  detail: string;
}

export interface OfflineMutation {
  id: string;
  idempotencyKey: string;
  action: string;
  entityId: string;
  /** Exact role-visible visit selected when this field mutation was created. */
  scopeVisitId?: string;
  createdAt: string;
  status: 'queued' | 'syncing' | 'synced' | 'failed';
  kind?: 'command' | 'media_upload';
  dependsOn?: string[];
  attemptCount?: number;
  lastError?: string;
  command?: StoryOpsCommand;
  mediaUpload?: PreparedVisitMedia;
  /** Durable server receipt retained until authoritative incident and visit readback agrees. */
  incidentPauseReceipt?: IncidentPauseReceipt;
}

export interface DemoIntegration {
  id: string;
  name: string;
  provider: string;
  mode: 'Sandbox' | 'Live' | 'Disabled';
  status: 'Healthy' | 'Degraded' | 'Needs setup';
  capabilities: string[];
  lastCheck: string;
  /** Authoritative integration_connections version when projected by the server. */
  version?: number;
}

export interface LiveEntityReference {
  id: string;
  version: number;
}

export interface LiveDispatchJobReference extends LiveEntityReference {
  jobNumber: string;
  customerName: string;
  propertyAddress: string;
  estimatedDurationMinutes: number;
  assignedCrewId?: string;
}

export interface LiveFieldVisitReference {
  visit: LiveEntityReference;
  visitStatus: string;
  visitStartsAt?: string;
  visitEndsAt?: string;
  job: LiveEntityReference;
  jobId: string;
  jobStatus?: string;
  jobEstimatedDurationMinutes?: number;
  jobAssignedCrewId?: string;
  customerId?: string;
  propertyId: string;
  activeTimeEntry?: LiveEntityReference;
  checklistItems: Record<string, LiveChecklistReference>;
  onMyWayDelivery?: LiveTransactionalDelivery;
}

export interface LiveChecklistReference extends LiveEntityReference {
  visitId: string;
  templateItemId: string;
  status: 'pending' | 'complete' | 'not_applicable' | 'blocked';
}

export interface LiveChecklistDefinition {
  id: string;
  templateId: string;
  label: string;
  itemKind: 'boolean' | 'text' | 'number' | 'photo' | 'signature';
  required: boolean;
  safetyCritical: boolean;
  sortOrder: number;
}

export interface LiveSdsDocumentMetadata extends LiveEntityReference {
  documentVersion?: number;
  productName: string;
  manufacturer: string;
  revisionDate: string;
  reviewedAt?: string;
  checksumSha256: string;
  storageObjectPath: string;
  contentType?: 'application/pdf';
  byteSize?: number;
  configurationRevision?: number;
  configurationHash?: string;
  baselineId?: string;
  baselineHash?: string;
  cachedFile?: Blob;
  cachedAt?: string;
  offlineStatus?: 'not_cached' | 'available' | 'failed';
}

export interface LiveMaterialReference extends LiveEntityReference {
  name: string;
  unit: string;
  requiresSds: boolean;
  sdsDocument?: LiveSdsDocumentMetadata;
}

export interface LiveCustomerSummary {
  id: string;
  name: string;
  email: string;
  phone: string;
  properties: number;
  address: string;
  lifetime: string;
  lastService: string;
  nextDue: string;
  status: 'Active' | 'Lead' | 'Attention';
}

export interface LivePropertySummary {
  id: string;
  customerId: string;
  name: string;
  address: string;
  version: number;
  geocodeReviewStatus: 'review_required' | 'confirmed';
  geocodeProvider?: 'google_maps';
  geocodePrecision?: 'rooftop' | 'parcel' | 'street';
  geocodeConfidence?: number;
  geocodedAt?: string;
}

export interface CustomerPortalRequest {
  id: string;
  customerId: string;
  propertyId: string;
  requestType: 'reschedule' | 'additional_service';
  status: 'submitted' | 'reviewing' | 'resolved' | 'cancelled';
  visitId?: string;
  normalizedLeadId?: string;
  preferredStartDate?: string;
  preferredEndDate?: string;
  requestedServiceCodes: string[];
  requestNotes: string;
  resolutionNote?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CustomerCommunicationPreferences {
  customerId?: string;
  transactionalSms: boolean;
  transactionalEmail: boolean;
  marketingSms: boolean;
  marketingEmail: boolean;
  globalOptOut: boolean;
  disclosureVersion: string;
  updatedAt?: string;
  version: number;
}

export interface CustomerPortalServiceOption {
  code: string;
  name: string;
}

export interface CustomerPortalAddOnOption {
  selectionCode: string;
  serviceCode: string;
  code: string;
  name: string;
}

export interface CustomerCommercialQuote {
  id: string;
  quoteNumber: string;
  estimateId: string;
  propertyId: string;
  status: 'sent' | 'viewed' | 'accepted' | 'declined' | 'change_requested' | 'expired';
  validUntil: string;
  termsVersion: string;
  termsSnapshot: string;
  total: string;
  depositRequired: string;
  portalPublishedAt: string;
  deliveryStatus: 'not_asserted';
  acceptedAt?: string;
  version: number;
  lines: Array<{
    lineKind: string;
    serviceCode?: string;
    addOnCode?: string;
    description: string;
    quantity: string;
    unit: string;
    subtotal: string;
    sortOrder: number;
  }>;
}

export interface CustomerQuoteChangeRequest {
  id: string;
  quoteId: string;
  quoteVersion: number;
  requestedServiceCodes: string[];
  requestedAddOnCodes: string[];
  requestNotes: string;
  status: 'submitted' | 'reviewing' | 'resolved' | 'cancelled';
  createdAt: string;
  version: number;
}

export interface CustomerCommercialInvoice {
  id: string;
  invoiceNumber: string;
  jobId: string;
  status: 'open' | 'past_due' | 'paid';
  issueDate: string;
  dueDate: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  version: number;
  paymentReconciliationRequired: boolean;
  paymentReconciliationMessage?: string;
}

export interface CustomerCommercialPortal {
  quote?: CustomerCommercialQuote;
  addOnOptions: CustomerPortalAddOnOption[];
  changeRequests: CustomerQuoteChangeRequest[];
  invoices: CustomerCommercialInvoice[];
  paymentReconciliationRequired: boolean;
  paymentReconciliationMessage?: string;
  depositEvidence?: {
    quoteId: string;
    required: string;
    verified: string;
    ready: boolean;
  };
}

export interface CustomerCompletedWorkMedia {
  id: string;
  visitId: string;
  jobId: string;
  purpose: 'before' | 'after';
  objectPath: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  byteSize: number;
  checksumSha256: string;
  capturedAt: string;
  version: number;
}

export interface CustomerCompletedWork {
  visitId: string;
  jobId: string;
  jobNumber: string;
  propertyId: string;
  serviceCodes: string[];
  completedAt: string;
  media: CustomerCompletedWorkMedia[];
}

export interface PaymentAllocationConflict {
  id: string;
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  providerEventId: string;
  conflictCode:
    | 'stale_invoice_version'
    | 'invoice_not_payable'
    | 'provider_overpayment'
    | 'provider_underpayment'
    | 'local_payment_amount_mismatch'
    | 'retired_checkout_succeeded';
  intendedAmount: string;
  verifiedAmount: string;
  invoiceBalanceAtEvent: string;
  providerCheckoutId?: string;
  providerPaymentId: string;
  providerOccurredAt: string;
  approvalRequestId?: string;
  status: 'open';
  createdAt: string;
  version: number;
  resolutionAction:
    'payment.allocation.apply_exact_current_balance' | 'payment.allocation.review_manual';
  canApplyExactCurrentBalance: boolean;
  nextAction: string;
}

export interface BackOfficeQuoteChangeRequest {
  id: string;
  customerId: string;
  propertyId: string;
  quoteId: string;
  quoteNumber: string;
  quoteVersion: number;
  requestedServiceCodes: string[];
  requestedAddOnCodes: string[];
  requestNotes: string;
  status: 'submitted' | 'reviewing';
  createdAt: string;
  version: number;
  nextAction: string;
}

export type CustomerPortalRequestInput =
  | {
      requestType: 'reschedule';
      customerId: string;
      propertyId: string;
      visitId: string;
      preferredStartDate: string;
      preferredEndDate: string;
      requestNotes: string;
      commandId?: string;
    }
  | {
      requestType: 'additional_service';
      customerId: string;
      propertyId: string;
      requestedServiceCodes: string[];
      requestNotes: string;
      commandId?: string;
    };

export interface CustomerCommunicationPreferencesInput {
  customerId: string;
  transactionalSms: boolean;
  transactionalEmail: boolean;
  marketingSms: boolean;
  marketingEmail: boolean;
  globalOptOut: boolean;
  disclosureVersion: string;
  commandId?: string;
}

export interface LiveWorkspaceMetadata {
  userId: string;
  companyId: string;
  companyName: string;
  companyTimezone: string;
  customerName?: string;
  portalAccounts?: Array<{
    customerId: string;
    displayName: string;
  }>;
  selectedPortalCustomerId?: string;
  serverTime: string;
  profitabilityKpis?: LiveProfitabilityKpis;
  quote?: LiveEntityReference;
  quoteStatus?: string;
  quoteTermsSnapshot?: string;
  quoteDelivery?: LiveTransactionalDelivery;
  visit?: LiveEntityReference;
  fieldPacketVisitId?: string;
  visitStatus?: string;
  visitStartsAt?: string;
  visitEndsAt?: string;
  onMyWayDelivery?: LiveTransactionalDelivery;
  fieldVisitReferences?: Record<string, LiveFieldVisitReference>;
  readyToScheduleJobs?: LiveDispatchJobReference[];
  dispatchJob?: LiveDispatchJobReference;
  job?: LiveEntityReference;
  jobStatus?: string;
  jobId?: string;
  jobEstimatedDurationMinutes?: number;
  jobAssignedCrewId?: string;
  invoice?: LiveEntityReference;
  postServiceInvoice?: LiveEntityReference;
  postServiceReviewStatus?:
    | 'queued'
    | 'submitted'
    | 'reconciliation_required'
    | 'submitted_unknown'
    | 'completed'
    | 'sandboxed'
    | 'failed'
    | 'cancelled';
  postServiceReferralStatus?:
    | 'queued'
    | 'submitted'
    | 'reconciliation_required'
    | 'submitted_unknown'
    | 'completed'
    | 'sandboxed'
    | 'failed'
    | 'cancelled';
  postServiceMaintenanceStatus?: 'active';
  invoiceVersions: Record<string, number>;
  customerId?: string;
  propertyId?: string;
  activeTimeEntry?: LiveEntityReference;
  leadVersions: Record<string, number>;
  checklistItems: Record<string, LiveChecklistReference>;
  checklistDefinitions: Record<string, LiveChecklistDefinition>;
  incidentVersions: Record<string, number>;
  notificationVersions: Record<string, number>;
  approvalVersions: Record<string, number>;
  materials: LiveMaterialReference[];
  customers: LiveCustomerSummary[];
  properties: LivePropertySummary[];
  customerCommercialPortal?: CustomerCommercialPortal;
  customerCompletedWork?: CustomerCompletedWork[];
  customerQuoteChangeRequests?: BackOfficeQuoteChangeRequest[];
  paymentAllocationConflicts?: PaymentAllocationConflict[];
}

export interface LiveTransactionalDelivery {
  id: string;
  action: 'quote.delivery' | 'visit.on_my_way';
  entityId: string;
  entityVersion: number;
  channel: 'sms' | 'email';
  status:
    | 'queued'
    | 'submitting'
    | 'submitted'
    | 'submitted_unknown'
    | 'delivered'
    | 'sandboxed'
    | 'failed'
    | 'cancelled';
  providerMode?: 'sandbox' | 'live';
  providerStatus?:
    | 'accepted'
    | 'queued'
    | 'sent'
    | 'delivered'
    | 'failed'
    | 'submission_unknown'
    | 'sandbox_recorded';
  lastErrorCode?: string;
  manualReconciliationRequired: boolean;
  providerSubmissionAsserted: boolean;
  externalDeliveryClaimed: boolean;
  requestedAt: string;
  completedAt?: string;
  version: number;
}

export interface LiveSchedulingEvidenceResult {
  mode: 'live' | 'sandbox' | 'disabled';
  status: 'ready_to_book' | 'not_bookable';
  bookable: boolean;
  reasonCode: string;
  message: string;
  companyId: string;
  jobId: string;
  jobVersion: number;
  window: {
    start: string;
    end: string;
  };
  crewId?: string;
  receipt?: {
    receiptId: string;
    crewId: string;
    startsAt: string;
    endsAt: string;
    calendarEventId: string;
    expiresAt: string;
    evidenceHash: string;
    replayed: boolean;
  };
}

export interface DemoState {
  schemaVersion: 1;
  hydrated: boolean;
  dataMode: StoryOpsDataMode;
  authStatus: LiveAuthStatus;
  authEmail?: string;
  liveError?: string;
  /** Last authoritative workspace/setup read confirmed by the server. */
  serverVerifiedAt?: string;
  live?: LiveWorkspaceMetadata;
  setupComplete: boolean;
  setupProfile?: SandboxSetupProfile;
  companyConfiguration?: CompanyConfigurationRecord;
  operatingBaseline?: OperatingBaselineState;
  providerLaunch?: ProviderLaunchState;
  dispatchOriginRetention?: DispatchOriginRetentionProjection;
  outboundWorkers?: OutboundWorkerHealthProjection;
  companyControlState?: CompanyControlState;
  companyControlRecovery?: boolean;
  aiOfficeRecent?: LiveAiOfficeRecent;
  liveAuditFeed?: LiveAuditFeed;
  pilotReleaseEvidence?: PilotReleaseEvidenceState;
  recurringDueWork?: RecurringDueWorkState;
  materialSdsRegistry?: MaterialSdsRegistryState;
  role: AppRole;
  online: boolean;
  syncRevision: number;
  selectedLeadId: string;
  selectedVisitId?: string;
  selectedDispatchJobId?: string;
  leads: DemoLead[];
  estimate: DemoEstimate;
  approvals: DemoApproval[];
  visits: DemoVisit[];
  incidents: DemoIncident[];
  invoices: DemoInvoice[];
  remindedInvoiceIds: string[];
  traces: DemoTrace[];
  auditEvents: DemoAuditEvent[];
  automations: DemoAutomation[];
  notifications: DemoNotification[];
  toasts: DemoToast[];
  offlineQueue: OfflineMutation[];
  integrations: DemoIntegration[];
  customerPortalRequests: CustomerPortalRequest[];
  customerCommunicationPreferences: CustomerCommunicationPreferences;
  customerPortalServiceOptions: CustomerPortalServiceOption[];
  customerQuoteAccepted: boolean;
  depositPaid: boolean;
  reviewRequested: boolean;
  referralInvited: boolean;
  recurringPlanActive: boolean;
  showcase?: DemoShowcaseState;
}

export interface StoryOpsActions {
  setRole(role: AppRole): void;
  setOnline(online: boolean): void;
  completeSetup(input: SandboxSetupInput): Promise<boolean>;
  saveCompanyConfigurationDraft(
    configuration: CompanyConfiguration,
  ): Promise<CompanyConfigurationReceipt | undefined>;
  publishCompanyConfiguration(input: {
    publicationMode: CompanyConfigurationPublicationMode;
    reviewReference: string;
  }): Promise<CompanyConfigurationReceipt | undefined>;
  publishOperatingBaseline(input: {
    reviewReference: string;
  }): Promise<OperatingBaselineReceipt | undefined>;
  setProviderActivation(input: {
    provider: AuthoritativeProvider;
    targetMode: ProviderActivationMode;
  }): Promise<ProviderActivationReceipt | undefined>;
  setCompanyLaunchAuthorization(input: {
    action: 'authorize' | 'revoke';
    reviewReference: string;
  }): Promise<CompanyLaunchAuthorizationReceipt | undefined>;
  resetDemo(): void;
  resetShowcaseData(): void;
  getShowcaseTourState(): DemoShowcaseState;
  getShowcaseBadge(): DemoShowcaseBadge;
  requestMagicLink(email: string): Promise<void>;
  signOut(): Promise<void>;
  clearThisDevice(): Promise<void>;
  reloadLiveWorkspace(): Promise<void>;
  selectCustomerPortalAccount(customerId: string): Promise<boolean>;
  selectVisit(visitId: string): Promise<boolean>;
  selectDispatchJob(jobId: string): void;
  setCompanyOperationalStatus(input: CompanyOperationalStatusCommandInput): Promise<boolean>;
  recordPilotReleaseEvidence(
    input: PilotReleaseEvidenceInput,
  ): Promise<PilotReleaseEvidenceReceipt | undefined>;
  createRecurringDueWork(
    input: CreateRecurringDueWorkInput,
  ): Promise<RecurringDueWorkReceipt | undefined>;
  attachRecurringDueEstimate(
    input: AttachRecurringDueEstimateInput,
  ): Promise<RecurringDueEstimateReceipt | undefined>;
  registerMaterialSds(
    input: RegisterMaterialSdsInput,
  ): Promise<FinalizedSdsRegistrationReceipt | undefined>;
  loadMoreAuditEvents(): Promise<void>;
  submitCustomerPortalRequest(input: CustomerPortalRequestInput): Promise<boolean>;
  updateCustomerCommunicationPreferences(
    input: CustomerCommunicationPreferencesInput,
  ): Promise<boolean>;
  selectLead(id: string): void;
  addLead(input: {
    name: string;
    source: DemoLead['source'];
    service: string;
    address: string;
    city: string;
    phone: string;
    email: string;
    consent: boolean;
  }): void;
  createCustomerProperty(input: {
    displayName: string;
    email: string;
    phone: string;
    acquisitionSource: string;
    propertyName: string;
    serviceAddress: {
      line1: string;
      city: string;
      region: string;
      postalCode: string;
      country: string;
    };
  }): Promise<CustomerPropertyCreateReceipt | undefined>;
  requestPropertyGeocode(input: {
    propertyId: string;
    expectedPropertyVersion: number;
  }): Promise<PropertyGeocodeCandidatesReceipt | undefined>;
  confirmPropertyGeocode(input: {
    propertyId: string;
    expectedPropertyVersion: number;
    candidateId: string;
  }): Promise<PropertyGeocodeConfirmationReceipt | undefined>;
  qualifyLead(id: string): void;
  linkLeadScope(leadId: string, customerId: string, propertyId: string): void;
  updateEstimate(
    field:
      | 'drivewaySqFt'
      | 'gutterLinearFt'
      | 'downspoutCount'
      | 'stories'
      | 'surface'
      | 'soil'
      | 'access'
      | 'risk'
      | 'travelZone'
      | 'discountPercent',
    value: string,
  ): void;
  loadLiveEstimateContext(propertyId?: string): Promise<LiveEstimateContext>;
  calculateLiveEstimate(input: LiveEstimateRequest): Promise<LiveEstimateReceipt>;
  runPolicyCheck(): void;
  decideApproval(id: string, decision: 'approved' | 'rejected'): void;
  executeApprovedAction(id: string): void;
  sendQuote(expectedQuoteId?: string): void;
  queueTransactionalDelivery(input: {
    action: 'quote.delivery' | 'visit.on_my_way';
    channel: 'sms' | 'email';
  }): Promise<boolean>;
  acceptQuote(input: QuoteAcceptanceInput): Promise<boolean>;
  markQuoteViewed(): void;
  submitQuoteDecision(input: {
    action: 'quote.decline' | 'quote.change_request';
    requestedServiceCodes?: string[];
    requestedAddOnCodes?: string[];
    notes: string;
  }): Promise<boolean>;
  resolveQuoteChangeRequest(input: {
    requestId: string;
    requestVersion: number;
    disposition: 'replacement_published' | 'cancelled';
    replacementQuoteId?: string;
    replacementQuoteVersion?: number;
    resolutionNote: string;
  }): Promise<boolean>;
  resolvePaymentAllocation(input: { conflictId: string; resolutionNote: string }): Promise<boolean>;
  startDepositCheckout(): void;
  startInvoiceCheckout(invoiceId: string): void;
  loadSchedulingSuggestions(): Promise<SchedulingSuggestionsResponse | undefined>;
  refreshSchedulingEvidence(input: {
    startsAt: string;
    endsAt: string;
    crewId?: string;
  }): Promise<LiveSchedulingEvidenceResult | undefined>;
  bookJob(schedulingEvidenceReceiptId?: string): void;
  optimizeRoutes(): void;
  startRouteWithDispatchClearance(currentOrigin: DispatchCurrentOrigin): Promise<boolean>;
  updateVisitStatus(status: DemoVisit['status']): void;
  toggleChecklist(id: string): void;
  addPhoto(kind: 'before' | 'after', file?: File): void;
  addIncidentEvidence(kind: 'incident' | 'safety' | 'damage', file?: File): void;
  recordMaterial(name: string, amount: string): void;
  cacheSdsDocument(documentId: string): Promise<boolean>;
  submitFieldChangeRequest(input: {
    reasonCode: FieldChangeReasonCode;
    summary: string;
  }): Promise<boolean>;
  loadCustomerEvidence(assetId: string): Promise<Blob | undefined>;
  publishCompletedWorkEvidence(visitId: string, assetIds: string[]): Promise<boolean>;
  updateVisitNotes(notes: string): void;
  captureSignature(signerName?: string): void;
  reportIncident(input: {
    kind: DemoIncident['kind'];
    summary: string;
    severity?: 'near_miss' | 'minor' | 'serious' | 'critical';
    immediateActions?: string;
  }): Promise<boolean>;
  closeIncident(id: string, closureNote: string): void;
  completeVisit(): void;
  issueInvoice(): void;
  recordSandboxPayment(): void;
  sendInvoiceReminder(id: string): void;
  requestReview(): void;
  inviteReferral(): void;
  activateRecurringPlan(): void;
  runAiOffice(input: LiveAiOfficeRunInput): Promise<DurableAiOfficeRun | undefined>;
  runOwnerBriefing(): void;
  checkIntegrations(): void;
  markNotificationsRead(): void;
  dismissToast(id: string): void;
  syncOfflineQueue(): Promise<void>;
}
