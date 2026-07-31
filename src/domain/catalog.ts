import type {
  DecimalString,
  DomainId,
  EntityMetadata,
  ISODateTime,
  Money,
  PercentageString,
} from './primitives.ts';
import type { ApprovalReason } from './governance.ts';

/**
 * A bounded semantic code owned by a versioned industry pack. Publication
 * validation enforces `^[a-z][a-z0-9_]{1,79}$`; the stable kernel deliberately
 * does not enumerate one trade's categories.
 */
export type ServiceCategory = string;

export const KERNEL_MEASUREMENT_KINDS = [
  'area_sq_ft',
  'length_linear_ft',
  'height_ft',
  'count',
  'stories',
  'duration_hours',
] as const;

export type KernelMeasurementKind = (typeof KERNEL_MEASUREMENT_KINDS)[number];

export interface ServiceCatalogItem extends EntityMetadata {
  code: string;
  name: string;
  description: string;
  category: ServiceCategory;
  active: boolean;
  taxable: boolean;
  defaultChecklistTemplateId?: DomainId;
  requiredSkills: readonly string[];
  requiredEquipmentTypes: readonly string[];
  requiredMeasurementKinds: readonly KernelMeasurementKind[];
  safetySopReference: string;
}

export type PricingUnit = 'flat' | 'sq_ft' | 'linear_ft' | 'each' | 'hour';

export const PRICING_ATTRIBUTES = [
  'stories',
  'surface',
  'soil',
  'access',
  'risk',
  'siding_material',
  'organic_growth',
  'gutter_guards',
  'roof_access',
  'debris',
  'roof_pitch',
  'roof_material',
  'service_side',
  'screens',
  'tracks',
] as const;

/**
 * Industry-pack pricing dimension. `PRICING_ATTRIBUTES` lists the first
 * exterior-services pack's dimensions, while publication accepts any bounded
 * pack-defined code and still requires deterministic values/multipliers.
 */
export type PricingAttribute = string;

export interface PricingApprovalRequirement {
  reason: ApprovalReason;
  summary: string;
}

export interface AttributeMultiplier {
  attribute: PricingAttribute;
  value: string;
  multiplier: DecimalString;
  approval?: PricingApprovalRequirement;
}

export interface AddOnPriceRule {
  code: string;
  name: string;
  unit: PricingUnit;
  unitPrice: DecimalString;
  taxable: boolean;
  estimatedUnitCost?: DecimalString;
  durationMinutesPerUnit: DecimalString;
  approval?: PricingApprovalRequirement;
}

export interface ServicePriceRule {
  serviceCode: string;
  requestAliases?: readonly string[];
  requiredMeasurementKinds?: readonly string[];
  pricingUnit: PricingUnit;
  basePrice: Money;
  unitPrice: DecimalString;
  includedQuantity: DecimalString;
  serviceMinimum?: Money;
  estimatedBaseCost: Money;
  estimatedUnitCost: DecimalString;
  durationBaseMinutes: number;
  durationMinutesPerUnit: DecimalString;
  taxable: boolean;
  allowedAttributeValues: Readonly<Partial<Record<PricingAttribute, readonly string[]>>>;
  attributeMultipliers: readonly AttributeMultiplier[];
  addOns: readonly AddOnPriceRule[];
}

export type ServicePackageTier = 'good' | 'better' | 'best';

export interface ServicePackageComponent {
  serviceCode: string;
  required: boolean;
  requiredAddOnCodes: readonly string[];
  optionalAddOnCodes: readonly string[];
}

export interface ServicePackageDefinition {
  code: string;
  name: string;
  description: string;
  tier: ServicePackageTier;
  components: readonly ServicePackageComponent[];
}

export interface TravelZoneRule {
  zoneCode: string;
  name: string;
  fee: Money;
  taxable: boolean;
  maximumOneWayMiles?: DecimalString;
  postalCodes?: readonly string[];
}

export interface DepositRule {
  kind: 'none' | 'flat' | 'percent';
  value: Money | PercentageString;
}

export interface PriceBook extends EntityMetadata {
  name: string;
  versionLabel: string;
  status: 'draft' | 'active' | 'retired';
  effectiveFrom: ISODateTime;
  effectiveUntil?: ISODateTime;
  currency: 'USD';
  companyMinimum: Money;
  travelZones: readonly TravelZoneRule[];
  defaultTaxRate: PercentageString;
  marginFloor: PercentageString;
  automaticDiscountLimit: PercentageString;
  depositRule: DepositRule;
  serviceRules: readonly ServicePriceRule[];
  publishedBy?: DomainId;
  publishedAt?: ISODateTime;
}
