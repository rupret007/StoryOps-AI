import type {
  DecimalString,
  DomainId,
  EntityMetadata,
  ISODate,
  ISODateTime,
  PostalAddress,
} from './primitives.ts';

export type LeadSource = 'web' | 'chat' | 'sms' | 'phone' | 'email' | 'referral' | 'manual';
export type LeadStatus = 'new' | 'qualifying' | 'qualified' | 'unqualified' | 'converted' | 'lost';

export interface Lead extends EntityMetadata {
  source: LeadSource;
  status: LeadStatus;
  displayName: string;
  email?: string;
  phone?: string;
  requestedServices: readonly string[];
  preferredContactChannel?: 'email' | 'sms' | 'phone';
  qualificationSummary?: string;
  disqualificationReason?: string;
  ownerUserId?: DomainId;
  customerId?: DomainId;
  propertyId?: DomainId;
  consentIds: readonly DomainId[];
}

export interface Customer extends EntityMetadata {
  kind: 'individual' | 'business';
  displayName: string;
  givenName?: string;
  familyName?: string;
  businessName?: string;
  email?: string;
  phone?: string;
  billingAddress?: PostalAddress;
  lifecycle: 'lead' | 'active' | 'inactive' | 'blocked';
  tags: readonly string[];
  acquisitionSource?: LeadSource;
  doNotContact: boolean;
  taxExempt: boolean;
  taxExemptionReference?: string;
  notes?: string;
}

export type PropertyType = 'single_family' | 'multi_family' | 'commercial' | 'other';

export interface Property extends EntityMetadata {
  customerId: DomainId;
  name: string;
  propertyType: PropertyType;
  serviceAddress: PostalAddress;
  accessInstructions?: string;
  gateCodeCiphertext?: string;
  waterSourceNotes?: string;
  drainageNotes?: string;
  knownHazards: readonly string[];
  stories?: number;
  yearBuilt?: number;
  lastServicedAt?: ISODateTime;
}

export type MeasurementKind =
  'area_sq_ft' | 'length_linear_ft' | 'height_ft' | 'count' | 'stories' | 'duration_hours';

export interface PropertyMeasurement extends EntityMetadata {
  propertyId: DomainId;
  kind: MeasurementKind;
  label: string;
  value: DecimalString;
  unit: 'sq_ft' | 'linear_ft' | 'ft' | 'each' | 'story' | 'hour';
  source: 'field_measured' | 'map' | 'customer_reported' | 'photo_assisted' | 'imported';
  measuredAt: ISODateTime;
  measuredBy?: DomainId;
  sourceAssetIds: readonly DomainId[];
  confidence?: DecimalString;
  verifiedByHuman: boolean;
  supersedesMeasurementId?: DomainId;
}

export interface ConsentRecord extends EntityMetadata {
  customerId?: DomainId;
  leadId?: DomainId;
  channel: 'sms' | 'email' | 'voice';
  purpose: 'transactional' | 'marketing';
  status: 'granted' | 'withdrawn' | 'unknown';
  capturedAt: ISODateTime;
  captureMethod: 'web_form' | 'keyword' | 'written' | 'verbal' | 'imported';
  disclosureVersion: string;
  proof: string;
  withdrawnAt?: ISODateTime;
}

export interface RecurringMaintenancePlan extends EntityMetadata {
  customerId: DomainId;
  propertyId: DomainId;
  serviceCodes: readonly string[];
  cadence: 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'custom';
  intervalDays?: number;
  nextDueDate: ISODate;
  status: 'proposed' | 'active' | 'paused' | 'ended';
  priceBookId: DomainId;
  requiresFreshEstimate: boolean;
}
