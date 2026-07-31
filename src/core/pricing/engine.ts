import { Decimal } from 'decimal.js';
import type {
  AddOnPriceRule,
  AttributeMultiplier,
  Money,
  PricingApprovalRequirement,
  ServicePriceRule,
  TravelZoneRule,
} from '@/domain';
import { asDecimalString } from '@/domain';
import { moneyDecimal, normalizedDecimal, ONE_HUNDRED, roundMoney, usd, ZERO } from './decimal.ts';
import type {
  PricingApprovalFlag,
  PricingIssue,
  PricingLine,
  PackagePricingRequest,
  PackagePricingResult,
  PricingRequest,
  PricingResult,
  RequestedService,
} from './types.ts';

export const PRICING_CALCULATION_VERSION = 'storyops-pricing-v1.1.0';

interface CalculatedScopeLine {
  lines: PricingLine[];
  subtotal: Decimal;
  taxableSubtotal: Decimal;
  cost: Decimal;
  durationMinutes: Decimal;
}

const emptyScopeLine = (): CalculatedScopeLine => ({
  lines: [],
  subtotal: ZERO,
  taxableSubtotal: ZERO,
  cost: ZERO,
  durationMinutes: ZERO,
});

const findMultiplier = (
  multipliers: readonly AttributeMultiplier[],
  attribute: AttributeMultiplier['attribute'],
  value: string,
): AttributeMultiplier | undefined =>
  multipliers.find((candidate) => candidate.attribute === attribute && candidate.value === value);

const addApprovalRequirement = (
  approvalFlags: PricingApprovalFlag[],
  requirement: PricingApprovalRequirement | undefined,
): void => {
  if (
    requirement &&
    !approvalFlags.some(
      (flag) => flag.reason === requirement.reason && flag.summary === requirement.summary,
    )
  ) {
    approvalFlags.push({
      reason: requirement.reason,
      summary: requirement.summary,
      blocking: true,
    });
  }
};

const validateAttributes = (
  requested: RequestedService,
  rule: ServicePriceRule,
  issues: PricingIssue[],
  approvalFlags: PricingApprovalFlag[],
): Decimal | null => {
  let combined = new Decimal(1);
  const entries = Object.entries(rule.allowedAttributeValues);

  for (const [attributeName, allowedValues] of entries) {
    const attribute = attributeName as AttributeMultiplier['attribute'];
    if (!allowedValues) {
      issues.push({
        severity: 'error',
        code: 'MISSING_MULTIPLIER',
        message: `Service "${requested.serviceCode}" has no allowed values for "${attribute}".`,
        serviceCode: requested.serviceCode,
      });
      continue;
    }
    const selected = requested.attributes[attribute];
    if (selected === undefined) {
      issues.push({
        severity: 'error',
        code: 'MISSING_ATTRIBUTE',
        message: `Service "${requested.serviceCode}" requires attribute "${attribute}".`,
        serviceCode: requested.serviceCode,
      });
      continue;
    }
    if (!allowedValues.includes(selected)) {
      issues.push({
        severity: 'error',
        code: 'UNKNOWN_ATTRIBUTE_VALUE',
        message: `Value "${selected}" is not approved for ${attribute}.`,
        serviceCode: requested.serviceCode,
      });
      continue;
    }
    const multiplier = findMultiplier(rule.attributeMultipliers, attribute, selected);
    if (!multiplier) {
      issues.push({
        severity: 'error',
        code: 'MISSING_MULTIPLIER',
        message: `No price-book multiplier exists for ${attribute}="${selected}".`,
        serviceCode: requested.serviceCode,
      });
      continue;
    }
    combined = combined.times(multiplier.multiplier);
    addApprovalRequirement(approvalFlags, multiplier.approval);
  }

  const hasAttributeErrors = issues.some(
    (issue) => issue.severity === 'error' && issue.serviceCode === requested.serviceCode,
  );
  return hasAttributeErrors ? null : combined;
};

const calculateAddOn = (
  requested: RequestedService,
  rule: AddOnPriceRule,
  quantity: Decimal,
  approvalFlags: PricingApprovalFlag[],
): CalculatedScopeLine => {
  addApprovalRequirement(approvalFlags, rule.approval);
  const subtotal = roundMoney(new Decimal(rule.unitPrice).times(quantity));
  const cost = roundMoney(new Decimal(rule.estimatedUnitCost ?? '0').times(quantity));
  const duration = new Decimal(rule.durationMinutesPerUnit).times(quantity);
  return {
    lines: [
      {
        kind: 'add_on',
        serviceCode: requested.serviceCode,
        addOnCode: rule.code,
        description: rule.name,
        quantity: normalizedDecimal(quantity),
        unit: rule.unit,
        unitPrice: rule.unitPrice,
        multiplier: asDecimalString('1'),
        subtotal: usd(subtotal),
        taxable: rule.taxable,
        estimatedCost: usd(cost),
        sourceMeasurementIds: requested.sourceMeasurementIds,
      },
    ],
    subtotal,
    taxableSubtotal: rule.taxable ? subtotal : ZERO,
    cost,
    durationMinutes: duration,
  };
};

const calculateService = (
  requested: RequestedService,
  rule: ServicePriceRule,
  issues: PricingIssue[],
  approvalFlags: PricingApprovalFlag[],
): CalculatedScopeLine => {
  const quantity = new Decimal(requested.quantity);
  if (!quantity.isFinite() || quantity.lessThanOrEqualTo(0)) {
    issues.push({
      severity: 'error',
      code: 'INVALID_QUANTITY',
      message: `Service "${requested.serviceCode}" quantity must be greater than zero.`,
      serviceCode: requested.serviceCode,
    });
    return emptyScopeLine();
  }

  const multiplier = validateAttributes(requested, rule, issues, approvalFlags);
  if (multiplier === null) {
    return emptyScopeLine();
  }

  const chargeableQuantity = Decimal.max(quantity.minus(new Decimal(rule.includedQuantity)), ZERO);
  const base = moneyDecimal(rule.basePrice);
  const variable = new Decimal(rule.unitPrice).times(chargeableQuantity);
  const calculated = roundMoney(base.plus(variable).times(multiplier));
  const serviceSubtotal = rule.serviceMinimum
    ? Decimal.max(calculated, moneyDecimal(rule.serviceMinimum))
    : calculated;

  const calculatedCost = roundMoney(
    moneyDecimal(rule.estimatedBaseCost)
      .plus(new Decimal(rule.estimatedUnitCost).times(chargeableQuantity))
      .times(multiplier),
  );
  const duration = new Decimal(rule.durationBaseMinutes)
    .plus(new Decimal(rule.durationMinutesPerUnit).times(chargeableQuantity))
    .times(multiplier);

  const result: CalculatedScopeLine = {
    lines: [
      {
        kind: 'service',
        serviceCode: rule.serviceCode,
        description: rule.serviceCode,
        quantity: requested.quantity,
        unit: rule.pricingUnit,
        unitPrice: rule.unitPrice,
        multiplier: normalizedDecimal(multiplier),
        subtotal: usd(serviceSubtotal),
        taxable: rule.taxable,
        estimatedCost: usd(calculatedCost),
        sourceMeasurementIds: requested.sourceMeasurementIds,
      },
    ],
    subtotal: serviceSubtotal,
    taxableSubtotal: rule.taxable ? serviceSubtotal : ZERO,
    cost: calculatedCost,
    durationMinutes: duration,
  };

  for (const requestedAddOn of requested.addOns) {
    const addOnRule = rule.addOns.find((candidate) => candidate.code === requestedAddOn.code);
    if (!addOnRule) {
      issues.push({
        severity: 'error',
        code: 'UNKNOWN_ADD_ON',
        message: `Add-on "${requestedAddOn.code}" is not in the selected service price rule.`,
        serviceCode: requested.serviceCode,
      });
      continue;
    }
    const addOnQuantity = new Decimal(requestedAddOn.quantity);
    if (!addOnQuantity.isFinite() || addOnQuantity.lessThanOrEqualTo(0)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_QUANTITY',
        message: `Add-on "${requestedAddOn.code}" quantity must be greater than zero.`,
        serviceCode: requested.serviceCode,
      });
      continue;
    }
    const addOn = calculateAddOn(requested, addOnRule, addOnQuantity, approvalFlags);
    result.lines.push(...addOn.lines);
    result.subtotal = result.subtotal.plus(addOn.subtotal);
    result.taxableSubtotal = result.taxableSubtotal.plus(addOn.taxableSubtotal);
    result.cost = result.cost.plus(addOn.cost);
    result.durationMinutes = result.durationMinutes.plus(addOn.durationMinutes);
  }
  return result;
};

const resolveTravel = (
  travelZoneCode: string | undefined,
  zones: readonly TravelZoneRule[],
  issues: PricingIssue[],
): TravelZoneRule | undefined => {
  if (!travelZoneCode) {
    return undefined;
  }
  const zone = zones.find((candidate) => candidate.zoneCode === travelZoneCode);
  if (!zone) {
    issues.push({
      severity: 'error',
      code: 'UNKNOWN_TRAVEL_ZONE',
      message: `Travel zone "${travelZoneCode}" does not exist in the price book.`,
    });
  }
  return zone;
};

const calculateDiscount = (
  request: PricingRequest,
  subtotal: Decimal,
  issues: PricingIssue[],
): { amount: Decimal; equivalentPercent: Decimal } => {
  if (request.discount.kind === 'none') {
    return { amount: ZERO, equivalentPercent: ZERO };
  }

  let amount: Decimal;
  if (request.discount.kind === 'percent') {
    const percent = new Decimal(request.discount.value);
    if (percent.lessThan(0) || percent.greaterThan(100)) {
      issues.push({
        severity: 'error',
        code: 'DISCOUNT_INVALID',
        message: 'Percentage discount must be between 0 and 100.',
      });
      return { amount: ZERO, equivalentPercent: ZERO };
    }
    amount = roundMoney(subtotal.times(percent).dividedBy(ONE_HUNDRED));
  } else {
    amount = moneyDecimal(request.discount.value);
    if (amount.lessThan(0)) {
      issues.push({
        severity: 'error',
        code: 'DISCOUNT_INVALID',
        message: 'Fixed discount cannot be negative.',
      });
      return { amount: ZERO, equivalentPercent: ZERO };
    }
  }

  const bounded = Decimal.min(amount, subtotal);
  const equivalentPercent = subtotal.isZero()
    ? ZERO
    : bounded.times(ONE_HUNDRED).dividedBy(subtotal);
  return { amount: bounded, equivalentPercent };
};

const depositAmount = (request: PricingRequest, total: Decimal): Decimal => {
  const { depositRule } = request.priceBook;
  if (depositRule.kind === 'none') {
    return ZERO;
  }
  const raw =
    depositRule.kind === 'flat'
      ? moneyDecimal(depositRule.value as Money)
      : total.times(new Decimal(depositRule.value as string)).dividedBy(ONE_HUNDRED);
  return roundMoney(Decimal.min(Decimal.max(raw, ZERO), total));
};

const validatePriceBook = (request: PricingRequest, issues: PricingIssue[]): void => {
  if (request.priceBook.status !== 'active') {
    issues.push({
      severity: 'error',
      code: 'PRICE_BOOK_INACTIVE',
      message: 'Only an active, published price book can produce a quote.',
    });
  }
  const calculatedAt = Date.parse(request.calculatedAt);
  if (
    calculatedAt < Date.parse(request.priceBook.effectiveFrom) ||
    (request.priceBook.effectiveUntil &&
      calculatedAt >= Date.parse(request.priceBook.effectiveUntil))
  ) {
    issues.push({
      severity: 'error',
      code: 'PRICE_BOOK_NOT_EFFECTIVE',
      message: 'The selected price-book version is not effective at calculation time.',
    });
  }
};

export const calculateEstimate = (request: PricingRequest): PricingResult => {
  const issues: PricingIssue[] = [];
  const approvalFlags: PricingApprovalFlag[] = [];
  const lines: PricingLine[] = [];
  validatePriceBook(request, issues);

  if (request.services.length === 0) {
    issues.push({
      severity: 'error',
      code: 'EMPTY_SCOPE',
      message: 'At least one priced service is required.',
    });
  }

  let serviceSubtotal = new Decimal(0);
  let taxableSubtotal = new Decimal(0);
  let estimatedCost = new Decimal(0);
  let durationMinutes = new Decimal(0);

  for (const requested of request.services) {
    const rule = request.priceBook.serviceRules.find(
      (candidate) =>
        candidate.serviceCode === requested.serviceCode ||
        candidate.requestAliases?.includes(requested.serviceCode),
    );
    if (!rule) {
      issues.push({
        severity: 'error',
        code: 'UNKNOWN_SERVICE',
        message: `Service "${requested.serviceCode}" is not present in this price book.`,
        serviceCode: requested.serviceCode,
      });
      continue;
    }
    const calculated = calculateService(requested, rule, issues, approvalFlags);
    lines.push(...calculated.lines);
    serviceSubtotal = serviceSubtotal.plus(calculated.subtotal);
    taxableSubtotal = taxableSubtotal.plus(calculated.taxableSubtotal);
    estimatedCost = estimatedCost.plus(calculated.cost);
    durationMinutes = durationMinutes.plus(calculated.durationMinutes);
  }

  const minimum = moneyDecimal(request.priceBook.companyMinimum);
  const minimumAdjustment = serviceSubtotal.greaterThan(0)
    ? roundMoney(Decimal.max(minimum.minus(serviceSubtotal), ZERO))
    : ZERO;
  if (minimumAdjustment.greaterThan(0) && serviceSubtotal.greaterThan(0)) {
    const minimumTaxable = taxableSubtotal.greaterThan(0);
    lines.push({
      kind: 'company_minimum',
      description: 'Company minimum adjustment',
      quantity: asDecimalString('1'),
      unit: 'flat',
      unitPrice: normalizedDecimal(minimumAdjustment),
      multiplier: asDecimalString('1'),
      subtotal: usd(minimumAdjustment),
      taxable: minimumTaxable,
      estimatedCost: usd(0),
      sourceMeasurementIds: [],
    });
    if (minimumTaxable) {
      taxableSubtotal = taxableSubtotal.plus(minimumAdjustment);
    }
  }

  const travelZone = resolveTravel(request.travelZoneCode, request.priceBook.travelZones, issues);
  const travelFee = travelZone ? moneyDecimal(travelZone.fee) : ZERO;
  if (travelZone && travelFee.greaterThan(0)) {
    lines.push({
      kind: 'travel',
      description: `Travel — ${travelZone.name}`,
      quantity: asDecimalString('1'),
      unit: 'flat',
      unitPrice: asDecimalString(travelZone.fee.amount),
      multiplier: asDecimalString('1'),
      subtotal: travelZone.fee,
      taxable: travelZone.taxable ?? false,
      estimatedCost: usd(0),
      sourceMeasurementIds: [],
    });
    if (travelZone.taxable === true) {
      taxableSubtotal = taxableSubtotal.plus(travelFee);
    }
  }

  const manualAdjustment = request.manualPriceAdjustment
    ? moneyDecimal(request.manualPriceAdjustment)
    : ZERO;
  if (!manualAdjustment.isZero()) {
    lines.push({
      kind: 'manual_adjustment',
      description: 'Manual price adjustment',
      quantity: asDecimalString('1'),
      unit: 'flat',
      unitPrice: normalizedDecimal(manualAdjustment),
      multiplier: asDecimalString('1'),
      subtotal: usd(manualAdjustment),
      taxable: false,
      estimatedCost: usd(0),
      sourceMeasurementIds: [],
    });
    approvalFlags.push({
      reason: 'price_exception',
      summary: 'A manual price adjustment requires owner approval.',
      blocking: true,
    });
  }

  const subtotalBeforeDiscount = roundMoney(
    serviceSubtotal.plus(minimumAdjustment).plus(travelFee).plus(manualAdjustment),
  );
  const nonNegativeSubtotal = Decimal.max(subtotalBeforeDiscount, ZERO);
  const discount = calculateDiscount(request, nonNegativeSubtotal, issues);
  const netSubtotal = roundMoney(nonNegativeSubtotal.minus(discount.amount));

  if (discount.equivalentPercent.greaterThan(request.priceBook.automaticDiscountLimit)) {
    approvalFlags.push({
      reason: 'large_discount',
      summary: `Discount ${discount.equivalentPercent.toFixed(2)}% exceeds automatic limit ${request.priceBook.automaticDiscountLimit}%.`,
      blocking: true,
    });
  }

  const taxableRatio = nonNegativeSubtotal.isZero()
    ? ZERO
    : Decimal.min(taxableSubtotal.dividedBy(nonNegativeSubtotal), new Decimal(1));
  const taxableDiscount = discount.amount.times(taxableRatio);
  const netTaxableSubtotal = request.customerTaxExempt
    ? ZERO
    : roundMoney(Decimal.max(taxableSubtotal.minus(taxableDiscount), ZERO));
  const tax = request.customerTaxExempt
    ? ZERO
    : roundMoney(netTaxableSubtotal.times(request.priceBook.defaultTaxRate).dividedBy(ONE_HUNDRED));
  const total = roundMoney(netSubtotal.plus(tax));
  const margin = netSubtotal.isZero()
    ? new Decimal(-100)
    : netSubtotal.minus(estimatedCost).times(ONE_HUNDRED).dividedBy(netSubtotal);

  if (margin.lessThan(request.priceBook.marginFloor)) {
    approvalFlags.push({
      reason: 'margin_below_floor',
      summary: `Estimated margin ${margin.toFixed(2)}% is below floor ${request.priceBook.marginFloor}%.`,
      blocking: true,
    });
  }

  if (
    request.scopeEvidenceDisposition === 'human_review_required' ||
    request.scopeEvidenceDisposition === 'insufficient'
  ) {
    issues.push({
      severity: 'warning',
      code: 'EVIDENCE_REVIEW_REQUIRED',
      message: 'Scope evidence requires human review before this estimate can become a quote.',
    });
    approvalFlags.push({
      reason: 'uncertain_scope',
      summary: 'Photo-assisted scope contains uncertainty or unsupported measurements.',
      blocking: true,
    });
  }

  if (
    issues.some((issue) =>
      ['UNKNOWN_SERVICE', 'UNKNOWN_ADD_ON', 'MISSING_MULTIPLIER'].includes(issue.code),
    )
  ) {
    approvalFlags.push({
      reason: 'outside_price_book',
      summary: 'Requested work is not fully represented by the approved price book.',
      blocking: true,
    });
  }

  const hasErrors = issues.some((issue) => issue.severity === 'error');
  return {
    calculationVersion: PRICING_CALCULATION_VERSION,
    requestId: request.requestId,
    quoteable: !hasErrors && !approvalFlags.some((flag) => flag.blocking),
    lines,
    serviceSubtotal: usd(serviceSubtotal),
    minimumAdjustment: usd(minimumAdjustment),
    travelFee: usd(travelFee),
    manualAdjustment: usd(manualAdjustment),
    subtotalBeforeDiscount: usd(nonNegativeSubtotal),
    discount: usd(discount.amount),
    taxableSubtotal: usd(netTaxableSubtotal),
    tax: usd(tax),
    total: usd(total),
    depositRequired: usd(depositAmount(request, total)),
    estimatedCost: usd(estimatedCost),
    marginPercent: normalizedDecimal(margin.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)),
    durationMinutes: Math.ceil(durationMinutes.toNumber()),
    issues,
    approvalFlags,
    priceBookId: request.priceBook.id,
    priceBookVersion: request.priceBook.versionLabel,
    calculatedAt: request.calculatedAt,
  };
};

interface ResolvedPackageScope {
  services: RequestedService[];
  issues: PricingIssue[];
}

const duplicateValues = (values: readonly string[]): Set<string> => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return duplicates;
};

const resolvePackageScope = (request: PackagePricingRequest): ResolvedPackageScope => {
  const issues: PricingIssue[] = [];
  const components = request.packageDefinition.components;
  const componentCodes = components.map((component) => component.serviceCode);
  const duplicateComponentCodes = duplicateValues(componentCodes);
  for (const serviceCode of duplicateComponentCodes) {
    issues.push({
      severity: 'error',
      code: 'PACKAGE_SCOPE_INVALID',
      message: `Package "${request.packageDefinition.code}" defines service "${serviceCode}" more than once.`,
      serviceCode,
    });
  }

  const selectedOptionalServiceCodes = new Set(request.selectedOptionalServiceCodes);
  for (const serviceCode of duplicateValues(request.selectedOptionalServiceCodes)) {
    issues.push({
      severity: 'error',
      code: 'PACKAGE_SCOPE_INVALID',
      message: `Optional package service "${serviceCode}" was selected more than once.`,
      serviceCode,
    });
  }

  for (const serviceCode of selectedOptionalServiceCodes) {
    const component = components.find((candidate) => candidate.serviceCode === serviceCode);
    if (!component || component.required) {
      issues.push({
        severity: 'error',
        code: 'PACKAGE_SCOPE_INVALID',
        message: `Service "${serviceCode}" is not an optional service in package "${request.packageDefinition.code}".`,
        serviceCode,
      });
    }
  }

  const measuredServiceCodes = request.measuredServices.map((service) => service.serviceCode);
  for (const serviceCode of duplicateValues(measuredServiceCodes)) {
    issues.push({
      severity: 'error',
      code: 'PACKAGE_SCOPE_INVALID',
      message: `Measured package scope contains service "${serviceCode}" more than once.`,
      serviceCode,
    });
  }

  const selectedAddOnKeys = request.selectedOptionalAddOns.map(
    (selection) => `${selection.serviceCode}\u0000${selection.addOnCode}`,
  );
  for (const duplicateKey of duplicateValues(selectedAddOnKeys)) {
    const [serviceCode, addOnCode] = duplicateKey.split('\u0000');
    issues.push({
      severity: 'error',
      code: 'PACKAGE_SCOPE_INVALID',
      message: `Optional add-on "${addOnCode ?? ''}" for service "${serviceCode ?? ''}" was selected more than once.`,
      serviceCode,
    });
  }

  const services: RequestedService[] = [];
  for (const component of components) {
    const selected = component.required || selectedOptionalServiceCodes.has(component.serviceCode);
    const measured = request.measuredServices.find(
      (service) => service.serviceCode === component.serviceCode,
    );

    if (!selected) {
      if (measured) {
        issues.push({
          severity: 'error',
          code: 'PACKAGE_SCOPE_INVALID',
          message: `Measured service "${component.serviceCode}" must be explicitly selected as a package option.`,
          serviceCode: component.serviceCode,
        });
      }
      continue;
    }

    if (!measured) {
      issues.push({
        severity: 'error',
        code: 'PACKAGE_SCOPE_INVALID',
        message: `Package "${request.packageDefinition.code}" requires an explicit measured scope for service "${component.serviceCode}".`,
        serviceCode: component.serviceCode,
      });
      continue;
    }

    const selectedOptionalAddOnCodes = request.selectedOptionalAddOns
      .filter((selection) => selection.serviceCode === component.serviceCode)
      .map((selection) => selection.addOnCode);
    for (const addOnCode of selectedOptionalAddOnCodes) {
      if (!component.optionalAddOnCodes.includes(addOnCode)) {
        issues.push({
          severity: 'error',
          code: 'PACKAGE_SCOPE_INVALID',
          message: `Add-on "${addOnCode}" is not an optional add-on for service "${component.serviceCode}" in this package.`,
          serviceCode: component.serviceCode,
        });
      }
    }

    const pricedAddOnCodes = new Set([
      ...component.requiredAddOnCodes,
      ...selectedOptionalAddOnCodes.filter((addOnCode) =>
        component.optionalAddOnCodes.includes(addOnCode),
      ),
    ]);
    const measuredAddOnCodes = measured.addOns.map((addOn) => addOn.code);
    for (const addOnCode of duplicateValues(measuredAddOnCodes)) {
      issues.push({
        severity: 'error',
        code: 'PACKAGE_SCOPE_INVALID',
        message: `Measured add-on "${addOnCode}" appears more than once for service "${component.serviceCode}".`,
        serviceCode: component.serviceCode,
      });
    }
    for (const addOnCode of pricedAddOnCodes) {
      if (!measuredAddOnCodes.includes(addOnCode)) {
        issues.push({
          severity: 'error',
          code: 'PACKAGE_SCOPE_INVALID',
          message: `Package add-on "${addOnCode}" requires an explicit measured quantity for service "${component.serviceCode}".`,
          serviceCode: component.serviceCode,
        });
      }
    }
    for (const addOn of measured.addOns) {
      if (!pricedAddOnCodes.has(addOn.code)) {
        issues.push({
          severity: 'error',
          code: 'PACKAGE_SCOPE_INVALID',
          message: `Measured add-on "${addOn.code}" is not selected in package "${request.packageDefinition.code}".`,
          serviceCode: component.serviceCode,
        });
      }
    }

    services.push({
      ...measured,
      addOns: measured.addOns.filter((addOn) => pricedAddOnCodes.has(addOn.code)),
    });
  }

  for (const measured of request.measuredServices) {
    if (!componentCodes.includes(measured.serviceCode)) {
      issues.push({
        severity: 'error',
        code: 'PACKAGE_SCOPE_INVALID',
        message: `Service "${measured.serviceCode}" is not available in package "${request.packageDefinition.code}".`,
        serviceCode: measured.serviceCode,
      });
    }
  }

  for (const selection of request.selectedOptionalAddOns) {
    const component = components.find(
      (candidate) => candidate.serviceCode === selection.serviceCode,
    );
    const serviceSelected =
      component?.required === true || selectedOptionalServiceCodes.has(selection.serviceCode);
    if (!component || !serviceSelected) {
      issues.push({
        severity: 'error',
        code: 'PACKAGE_SCOPE_INVALID',
        message: `Optional add-on "${selection.addOnCode}" belongs to an unselected package service "${selection.serviceCode}".`,
        serviceCode: selection.serviceCode,
      });
    }
  }

  return { services, issues };
};

export const calculatePackageEstimate = (request: PackagePricingRequest): PackagePricingResult => {
  const packageScope = resolvePackageScope(request);
  const result = calculateEstimate({
    requestId: request.requestId,
    companyId: request.companyId,
    propertyId: request.propertyId,
    priceBook: request.priceBook,
    services: packageScope.services,
    travelZoneCode: request.travelZoneCode,
    discount: request.discount,
    customerTaxExempt: request.customerTaxExempt,
    manualPriceAdjustment: request.manualPriceAdjustment,
    scopeEvidenceDisposition: request.scopeEvidenceDisposition,
    calculatedAt: request.calculatedAt,
  });

  return {
    ...result,
    quoteable: result.quoteable && packageScope.issues.length === 0,
    issues: [...packageScope.issues, ...result.issues],
    packageCode: request.packageDefinition.code,
    packageTier: request.packageDefinition.tier,
    pricedServiceCodes: packageScope.services.map((service) => service.serviceCode),
    selectedOptionalServiceCodes: [...request.selectedOptionalServiceCodes],
    selectedOptionalAddOns: request.selectedOptionalAddOns.map((selection) => ({ ...selection })),
  };
};
