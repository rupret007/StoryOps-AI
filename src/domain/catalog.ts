import type {
  DecimalString,
  DomainId,
  EntityMetadata,
  ISODateTime,
  Money,
  PercentageString,
} from './primitives.ts';

export type ServiceCategory =
  'pressure_washing' | 'soft_washing' | 'gutter_cleaning' | 'downspout_cleaning' | 'add_on';

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
  requiredMeasurementKinds: readonly string[];
  safetySopReference: string;
}

export type PricingUnit = 'flat' | 'sq_ft' | 'linear_ft' | 'each' | 'hour';

export interface AttributeMultiplier {
  attribute: 'stories' | 'surface' | 'soil' | 'access' | 'risk';
  value: string;
  multiplier: DecimalString;
}

export interface AddOnPriceRule {
  code: string;
  name: string;
  unit: PricingUnit;
  unitPrice: DecimalString;
  taxable: boolean;
  estimatedUnitCost?: DecimalString;
  durationMinutesPerUnit: DecimalString;
}

export interface ServicePriceRule {
  serviceCode: string;
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
  allowedAttributeValues: Readonly<Record<string, readonly string[]>>;
  attributeMultipliers: readonly AttributeMultiplier[];
  addOns: readonly AddOnPriceRule[];
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
