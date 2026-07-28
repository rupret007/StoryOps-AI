import type { UserRole } from './roles.ts';
import type {
  DecimalString,
  DomainId,
  EntityMetadata,
  ISODate,
  ISODateTime,
  Money,
  RetentionMetadata,
} from './primitives.ts';

export interface EstimateLine {
  id: DomainId;
  serviceCode: string;
  description: string;
  quantity: DecimalString;
  unit: string;
  unitPrice: DecimalString;
  multiplier: DecimalString;
  subtotal: Money;
  taxable: boolean;
  estimatedCost: Money;
  sourceMeasurementIds: readonly DomainId[];
  addOnCode?: string;
}

export interface Estimate extends EntityMetadata {
  estimateNumber: string;
  customerId: DomainId;
  propertyId: DomainId;
  leadId?: DomainId;
  priceBookId: DomainId;
  priceBookVersion: string;
  status: 'draft' | 'needs_input' | 'pending_approval' | 'approved' | 'superseded';
  lines: readonly EstimateLine[];
  serviceSubtotal: Money;
  travelFee: Money;
  discount: Money;
  tax: Money;
  total: Money;
  depositRequired: Money;
  estimatedCost: Money;
  estimatedMargin: DecimalString;
  durationMinutes: number;
  approvalRequestIds: readonly DomainId[];
  evidenceAnalysisIds: readonly DomainId[];
  calculatedAt: ISODateTime;
  calculationVersion: string;
}

export interface Quote extends EntityMetadata {
  quoteNumber: string;
  estimateId: DomainId;
  customerId: DomainId;
  propertyId: DomainId;
  status:
    'draft' | 'pending_approval' | 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'void';
  validUntil: ISODate;
  termsVersion: string;
  termsSnapshot: string;
  total: Money;
  depositRequired: Money;
  sentAt?: ISODateTime;
  acceptedAt?: ISODateTime;
  acceptedByName?: string;
  acceptanceIpHash?: string;
}

export interface Crew extends EntityMetadata {
  name: string;
  active: boolean;
  leadTechnicianId?: DomainId;
  memberUserIds: readonly DomainId[];
  skillCodes: readonly string[];
  equipmentIds: readonly DomainId[];
  homeBasePostalCode: string;
}

export interface Equipment extends EntityMetadata {
  assetTag: string;
  name: string;
  equipmentType: string;
  status: 'available' | 'assigned' | 'maintenance' | 'retired';
  assignedCrewId?: DomainId;
  lastInspectionAt?: ISODateTime;
  nextInspectionDue?: ISODate;
  notes?: string;
}

export interface Material extends EntityMetadata {
  sku: string;
  name: string;
  unit: 'oz' | 'gal' | 'lb' | 'each';
  quantityOnHand: DecimalString;
  reorderPoint: DecimalString;
  sdsDocumentId?: DomainId;
  active: boolean;
}

export interface SdsDocument extends EntityMetadata {
  materialId?: DomainId;
  productName: string;
  manufacturer: string;
  revisionDate: ISODate;
  storageObjectPath: string;
  checksumSha256: string;
  reviewedAt?: ISODateTime;
  reviewedBy?: DomainId;
}

export interface ChecklistTemplateItem {
  key: string;
  label: string;
  kind: 'boolean' | 'text' | 'number' | 'photo' | 'signature';
  required: boolean;
  safetyCritical: boolean;
  sortOrder: number;
}

export interface ChecklistTemplate extends EntityMetadata {
  name: string;
  serviceCode?: string;
  versionLabel: string;
  active: boolean;
  items: readonly ChecklistTemplateItem[];
}

export interface VisitChecklistItem {
  templateItemKey: string;
  status: 'pending' | 'complete' | 'not_applicable' | 'blocked';
  value?: string | boolean | DecimalString;
  completedAt?: ISODateTime;
  completedBy?: DomainId;
  evidenceAssetIds: readonly DomainId[];
  note?: string;
}

export interface TimeEntry {
  userId: DomainId;
  startedAt: ISODateTime;
  endedAt?: ISODateTime;
  breakMinutes: number;
  source: 'field_app' | 'manual_adjustment';
  approvedBy?: DomainId;
}

export interface MaterialUsage {
  materialId: DomainId;
  quantity: DecimalString;
  unit: Material['unit'];
  recordedAt: ISODateTime;
  recordedBy: DomainId;
}

export interface MediaAsset extends EntityMetadata {
  propertyId?: DomainId;
  jobId?: DomainId;
  visitId?: DomainId;
  incidentId?: DomainId;
  purpose: 'scope' | 'before' | 'after' | 'damage' | 'safety' | 'incident' | 'signature';
  objectPath: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
  capturedAt: ISODateTime;
  capturedBy?: DomainId;
  customerVisible: boolean;
  offlineClientId?: string;
  syncState: 'pending' | 'synced' | 'failed';
  retention: RetentionMetadata;
}

export interface CompletionSignature {
  signerName: string;
  signerRole: 'customer' | 'technician';
  signedAt: ISODateTime;
  signatureAssetId: DomainId;
  disclosureVersion: string;
}

export interface Job extends EntityMetadata {
  jobNumber: string;
  quoteId: DomainId;
  customerId: DomainId;
  propertyId: DomainId;
  status:
    | 'pending_deposit'
    | 'ready_to_schedule'
    | 'scheduled'
    | 'in_progress'
    | 'completed'
    | 'invoiced'
    | 'cancelled';
  priority: 'routine' | 'high' | 'urgent';
  serviceCodes: readonly string[];
  estimatedDurationMinutes: number;
  estimatedRevenue: Money;
  estimatedCost: Money;
  assignedCrewId?: DomainId;
  visitIds: readonly DomainId[];
  incidentIds: readonly DomainId[];
}

export interface Visit extends EntityMetadata {
  jobId: DomainId;
  sequence: number;
  status:
    | 'planned'
    | 'confirmed'
    | 'en_route'
    | 'on_site'
    | 'paused'
    | 'completed'
    | 'cancelled'
    | 'weather_hold';
  startsAt: ISODateTime;
  endsAt: ISODateTime;
  crewId: DomainId;
  technicianUserIds: readonly DomainId[];
  routeCheckId?: DomainId;
  weatherCheckId?: DomainId;
  checklistTemplateId: DomainId;
  checklistItems: readonly VisitChecklistItem[];
  timeEntries: readonly TimeEntry[];
  materialsUsed: readonly MaterialUsage[];
  mediaAssetIds: readonly DomainId[];
  internalNotes?: string;
  customerNotes?: string;
  completionSignature?: CompletionSignature;
  offlineRevision: number;
  lastSyncedAt?: ISODateTime;
}

export interface Incident extends EntityMetadata {
  incidentNumber: string;
  jobId?: DomainId;
  visitId?: DomainId;
  propertyId?: DomainId;
  severity: 'near_miss' | 'minor' | 'serious' | 'critical';
  status: 'open' | 'investigating' | 'corrective_action' | 'closed';
  category: 'injury' | 'property_damage' | 'chemical' | 'vehicle' | 'environmental' | 'other';
  occurredAt: ISODateTime;
  reportedAt: ISODateTime;
  reportedBy: DomainId;
  summary: string;
  immediateActions: string;
  mediaAssetIds: readonly DomainId[];
  ownerNotifiedAt?: ISODateTime;
  requiresLegalReview: boolean;
  closedAt?: ISODateTime;
  closedBy?: DomainId;
}

export interface DispatchAssignment extends EntityMetadata {
  visitId: DomainId;
  crewId: DomainId;
  assignedBy: DomainId;
  assignedByRole: UserRole;
  startsAt: ISODateTime;
  endsAt: ISODateTime;
  routePosition?: number;
  status: 'proposed' | 'confirmed' | 'changed' | 'cancelled';
}
