import type {
  ApprovalReason,
  DecimalString,
  DomainId,
  ISODateTime,
  Money,
  PriceBook,
  PricingUnit,
} from '@/domain';

export interface RequestedAddOn {
  code: string;
  quantity: DecimalString;
}

export interface RequestedService {
  serviceCode: string;
  quantity: DecimalString;
  attributes: Readonly<Partial<Record<'stories' | 'surface' | 'soil' | 'access' | 'risk', string>>>;
  addOns: readonly RequestedAddOn[];
  sourceMeasurementIds: readonly DomainId[];
}

export type DiscountRequest =
  | { kind: 'none'; reason?: string }
  | { kind: 'percent'; value: DecimalString; reason: string }
  | { kind: 'fixed'; value: Money; reason: string };

export interface PricingRequest {
  requestId: string;
  companyId: DomainId;
  propertyId: DomainId;
  priceBook: PriceBook;
  services: readonly RequestedService[];
  travelZoneCode?: string;
  discount: DiscountRequest;
  customerTaxExempt: boolean;
  manualPriceAdjustment?: Money;
  scopeEvidenceDisposition?: 'usable_for_scope' | 'human_review_required' | 'insufficient';
  calculatedAt: ISODateTime;
}

export interface PricingLine {
  kind: 'service' | 'add_on' | 'company_minimum' | 'travel' | 'manual_adjustment';
  serviceCode?: string;
  addOnCode?: string;
  description: string;
  quantity: DecimalString;
  unit: PricingUnit;
  unitPrice: DecimalString;
  multiplier: DecimalString;
  subtotal: Money;
  taxable: boolean;
  estimatedCost: Money;
  sourceMeasurementIds: readonly DomainId[];
}

export interface PricingIssue {
  severity: 'warning' | 'error';
  code:
    | 'EMPTY_SCOPE'
    | 'INVALID_QUANTITY'
    | 'PRICE_BOOK_INACTIVE'
    | 'PRICE_BOOK_NOT_EFFECTIVE'
    | 'UNKNOWN_SERVICE'
    | 'MISSING_ATTRIBUTE'
    | 'UNKNOWN_ATTRIBUTE_VALUE'
    | 'MISSING_MULTIPLIER'
    | 'UNKNOWN_ADD_ON'
    | 'UNKNOWN_TRAVEL_ZONE'
    | 'DISCOUNT_INVALID'
    | 'EVIDENCE_REVIEW_REQUIRED';
  message: string;
  serviceCode?: string;
}

export interface PricingApprovalFlag {
  reason: ApprovalReason;
  summary: string;
  blocking: boolean;
}

export interface PricingResult {
  calculationVersion: string;
  requestId: string;
  quoteable: boolean;
  lines: readonly PricingLine[];
  serviceSubtotal: Money;
  minimumAdjustment: Money;
  travelFee: Money;
  manualAdjustment: Money;
  subtotalBeforeDiscount: Money;
  discount: Money;
  taxableSubtotal: Money;
  tax: Money;
  total: Money;
  depositRequired: Money;
  estimatedCost: Money;
  marginPercent: DecimalString;
  durationMinutes: number;
  issues: readonly PricingIssue[];
  approvalFlags: readonly PricingApprovalFlag[];
  priceBookId: DomainId;
  priceBookVersion: string;
  calculatedAt: ISODateTime;
}
