import type { PreparedVisitMedia, StoryOpsCommand } from './liveRepository';
import type {
  LiveEstimateContext,
  LiveEstimateReceipt,
  LiveEstimateRequest,
} from './liveEstimating';

export type AppRole = 'owner' | 'dispatcher' | 'technician' | 'customer';
export type StoryOpsDataMode = 'sandbox' | 'supabase';
export type LiveAuthStatus =
  'disabled' | 'checking' | 'signed_out' | 'signed_in' | 'link_sent' | 'error';

export type LeadStage = 'new' | 'qualified' | 'estimated' | 'quoted' | 'booked';

export type SandboxServiceCode = 'pressure-wash-flatwork' | 'soft-wash-house' | 'gutter-cleaning';

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
  risk: 'medium' | 'high';
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  expiresAt: string;
  entityId: string;
  payloadPreview: string;
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
    temperature: number;
    precipitation: number;
    windMph: number;
    checkedAt: string;
    disposition: 'clear' | 'watch' | 'hold';
  };
  route: {
    driveMinutes: number;
    miles: number;
    checkedAt: string;
    feasible: boolean;
  };
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

export interface DemoIncident {
  id: string;
  visitId: string;
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
  createdAt: string;
  status: 'queued' | 'syncing' | 'synced' | 'failed';
  kind?: 'command' | 'media_upload';
  dependsOn?: string[];
  attemptCount?: number;
  lastError?: string;
  command?: StoryOpsCommand;
  mediaUpload?: PreparedVisitMedia;
}

export interface DemoIntegration {
  id: string;
  name: string;
  provider: string;
  mode: 'Sandbox' | 'Live' | 'Disabled';
  status: 'Healthy' | 'Degraded' | 'Needs setup';
  capabilities: string[];
  lastCheck: string;
}

export interface LiveEntityReference {
  id: string;
  version: number;
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
  productName: string;
  manufacturer: string;
  revisionDate: string;
  reviewedAt?: string;
  checksumSha256: string;
  storageObjectPath: string;
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
}

export interface LiveWorkspaceMetadata {
  userId: string;
  companyId: string;
  companyName: string;
  companyTimezone: string;
  customerName?: string;
  serverTime: string;
  quote?: LiveEntityReference;
  quoteStatus?: string;
  quoteTermsSnapshot?: string;
  visit?: LiveEntityReference;
  visitStatus?: string;
  visitStartsAt?: string;
  visitEndsAt?: string;
  job?: LiveEntityReference;
  jobStatus?: string;
  jobId?: string;
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
}

export interface DemoState {
  schemaVersion: 1;
  hydrated: boolean;
  dataMode: StoryOpsDataMode;
  authStatus: LiveAuthStatus;
  authEmail?: string;
  liveError?: string;
  live?: LiveWorkspaceMetadata;
  setupComplete: boolean;
  setupProfile?: SandboxSetupProfile;
  role: AppRole;
  online: boolean;
  syncRevision: number;
  selectedLeadId: string;
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
  customerQuoteAccepted: boolean;
  depositPaid: boolean;
  reviewRequested: boolean;
  referralInvited: boolean;
  recurringPlanActive: boolean;
}

export interface StoryOpsActions {
  setRole(role: AppRole): void;
  setOnline(online: boolean): void;
  completeSetup(input: SandboxSetupInput): Promise<boolean>;
  resetDemo(): void;
  requestMagicLink(email: string): Promise<void>;
  signOut(): Promise<void>;
  reloadLiveWorkspace(): Promise<void>;
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
  }): void;
  qualifyLead(id: string): void;
  linkLeadScope(leadId: string, customerId: string, propertyId: string): void;
  updateEstimate(
    field:
      | 'drivewaySqFt'
      | 'gutterLinearFt'
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
  acceptQuote(): void;
  startDepositCheckout(): void;
  bookJob(): void;
  optimizeRoutes(): void;
  updateVisitStatus(status: DemoVisit['status']): void;
  toggleChecklist(id: string): void;
  addPhoto(kind: 'before' | 'after', file?: File): void;
  recordMaterial(name: string, amount: string): void;
  updateVisitNotes(notes: string): void;
  captureSignature(signerName?: string): void;
  reportIncident(input: {
    kind: DemoIncident['kind'];
    summary: string;
    severity?: 'near_miss' | 'minor' | 'serious' | 'critical';
    immediateActions?: string;
  }): void;
  closeIncident(id: string, closureNote: string): void;
  completeVisit(): void;
  issueInvoice(): void;
  recordSandboxPayment(): void;
  sendInvoiceReminder(id: string): void;
  requestReview(): void;
  inviteReferral(): void;
  activateRecurringPlan(): void;
  runOwnerBriefing(): void;
  checkIntegrations(): void;
  markNotificationsRead(): void;
  dismissToast(id: string): void;
  syncOfflineQueue(): Promise<void>;
}
