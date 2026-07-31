import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  asDecimalString,
  asDomainId,
  asISODateTime,
  asPercentageString,
  money,
  type ApprovalReason,
  type PriceBook,
  type ServicePackageDefinition,
} from '../../../src/domain/index.ts';
import { calculateEstimate } from '../../../src/core/pricing/index.ts';
import type { OfficeToolRegistry } from '../../../src/core/ai/tools.ts';

type Row = Record<string, unknown>;

const UNIT_EVIDENCE: Record<string, { kind: string; unit: string }> = {
  flat: { kind: 'count', unit: 'each' },
  sq_ft: { kind: 'area_sq_ft', unit: 'sq_ft' },
  linear_ft: { kind: 'length_linear_ft', unit: 'linear_ft' },
  each: { kind: 'count', unit: 'each' },
  hour: { kind: 'duration_hours', unit: 'hour' },
};

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  throw new Error(`Server pricing row is missing ${key}.`);
}

function optionalText(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function moneyValue(row: Row, key: string) {
  return money(new Decimal(text(row, key)).toFixed(2));
}

function decimalValue(row: Row, key: string) {
  return asDecimalString(new Decimal(text(row, key)).toFixed());
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function objectValue(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response.`);
  }
  return value as Row;
}

function rowArray(value: unknown, label: string): Row[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object')) {
    throw new Error(`${label} returned an invalid response.`);
  }
  return value as Row[];
}

function supportsPricingUnit(measurement: Row, pricingUnit: string): boolean {
  const required = UNIT_EVIDENCE[pricingUnit];
  return (
    required !== undefined &&
    optionalText(measurement, 'kind') === required.kind &&
    optionalText(measurement, 'unit') === required.unit &&
    (pricingUnit !== 'flat' || new Decimal(text(measurement, 'value')).eq(1))
  );
}

export async function loadActivePriceBook(
  client: SupabaseClient,
  companyId: string,
  priceBookId?: string,
): Promise<PriceBook & { packages: readonly ServicePackageDefinition[] }> {
  const { data, error } = await client.rpc('load_active_price_book_snapshot', {
    p_company_id: companyId,
    p_price_book_id: priceBookId ?? null,
  });
  if (error) throw new Error(`Active price book snapshot failed: ${error.message}`);
  const snapshot = objectValue(data, 'Active price book snapshot');
  const book = objectValue(snapshot.book, 'Active price book');
  const rules = rowArray(snapshot.rules, 'Price-book service rules');
  const multipliers = rowArray(snapshot.multipliers, 'Price-book multipliers');
  const addOns = rowArray(snapshot.add_ons, 'Price-book add-ons');
  const zones = rowArray(snapshot.zones, 'Price-book travel zones');
  const packages = rowArray(snapshot.packages, 'Price-book packages');
  for (const rule of rules) {
    const catalog = rule.service_catalog;
    if (
      !catalog ||
      typeof catalog !== 'object' ||
      Array.isArray(catalog) ||
      (catalog as Row).company_id !== companyId ||
      (catalog as Row).active !== true ||
      typeof (catalog as Row).safety_sop_reference !== 'string' ||
      !(catalog as Row).safety_sop_reference
    ) {
      throw new Error(
        `Price-book service ${text(rule, 'service_code')} lacks an active company-owned catalog entry and safety SOP reference.`,
      );
    }
    const requiredMeasurementKinds = stringArray((catalog as Row).required_measurement_kinds);
    const pricingEvidence = UNIT_EVIDENCE[text(rule, 'pricing_unit')];
    if (
      requiredMeasurementKinds.length === 0 ||
      !pricingEvidence ||
      requiredMeasurementKinds[0] !== pricingEvidence.kind
    ) {
      throw new Error(
        `Price-book service ${text(rule, 'service_code')} has pricing semantics that do not match its primary catalog measurement.`,
      );
    }
  }

  const approval = (row: Row): { reason: ApprovalReason; summary: string } | undefined => {
    const reason = optionalText(row, 'approval_reason');
    const summary = optionalText(row, 'approval_summary');
    if (!reason && !summary) return undefined;
    if (!reason || !summary) {
      throw new Error('Price-book approval metadata is incomplete.');
    }
    return { reason: reason as ApprovalReason, summary };
  };

  return {
    id: asDomainId(text(book, 'id')),
    companyId: asDomainId(companyId),
    createdAt: asISODateTime(text(book, 'created_at')),
    updatedAt: asISODateTime(text(book, 'updated_at')),
    version: Number(text(book, 'version')),
    name: text(book, 'name'),
    versionLabel: text(book, 'version_label'),
    status: 'active',
    effectiveFrom: asISODateTime(text(book, 'effective_from')),
    effectiveUntil: optionalText(book, 'effective_until')
      ? asISODateTime(text(book, 'effective_until'))
      : undefined,
    currency: 'USD',
    companyMinimum: moneyValue(book, 'company_minimum'),
    defaultTaxRate: asPercentageString(text(book, 'default_tax_rate_pct')),
    marginFloor: asPercentageString(text(book, 'margin_floor_pct')),
    automaticDiscountLimit: asPercentageString(text(book, 'automatic_discount_limit_pct')),
    depositRule:
      text(book, 'deposit_kind') === 'percent'
        ? {
            kind: 'percent',
            value: asPercentageString(text(book, 'deposit_value')),
          }
        : text(book, 'deposit_kind') === 'flat'
          ? { kind: 'flat', value: moneyValue(book, 'deposit_value') }
          : { kind: 'none', value: money('0.00') },
    publishedBy: optionalText(book, 'published_by')
      ? asDomainId(text(book, 'published_by'))
      : undefined,
    publishedAt: optionalText(book, 'published_at')
      ? asISODateTime(text(book, 'published_at'))
      : undefined,
    travelZones: zones.map((zone) => ({
      zoneCode: text(zone, 'zone_code'),
      name: text(zone, 'name'),
      fee: moneyValue(zone, 'fee'),
      taxable: zone.taxable === true,
      maximumOneWayMiles: optionalText(zone, 'maximum_one_way_miles')
        ? asDecimalString(text(zone, 'maximum_one_way_miles'))
        : undefined,
      postalCodes: stringArray(zone.postal_codes),
    })),
    serviceRules: rules.map((rule) => {
      const ruleId = text(rule, 'id');
      const catalog = objectValue(
        rule.service_catalog,
        `Catalog entry for ${text(rule, 'service_code')}`,
      );
      return {
        serviceCode: text(rule, 'service_code'),
        requiredMeasurementKinds: stringArray(catalog.required_measurement_kinds),
        pricingUnit: text(rule, 'pricing_unit') as 'flat' | 'sq_ft' | 'linear_ft' | 'each' | 'hour',
        basePrice: moneyValue(rule, 'base_price'),
        unitPrice: decimalValue(rule, 'unit_price'),
        includedQuantity: asDecimalString(text(rule, 'included_quantity')),
        serviceMinimum: optionalText(rule, 'service_minimum')
          ? moneyValue(rule, 'service_minimum')
          : undefined,
        estimatedBaseCost: moneyValue(rule, 'estimated_base_cost'),
        estimatedUnitCost: decimalValue(rule, 'estimated_unit_cost'),
        durationBaseMinutes: Number(text(rule, 'duration_base_minutes')),
        durationMinutesPerUnit: asDecimalString(text(rule, 'duration_minutes_per_unit')),
        taxable: rule.taxable === true,
        allowedAttributeValues:
          rule.allowed_attribute_values &&
          typeof rule.allowed_attribute_values === 'object' &&
          !Array.isArray(rule.allowed_attribute_values)
            ? (rule.allowed_attribute_values as Record<string, string[]>)
            : {},
        attributeMultipliers: multipliers
          .filter((item) => text(item, 'service_rule_id') === ruleId)
          .map((item) => ({
            attribute: text(item, 'attribute') as
              | 'stories'
              | 'surface'
              | 'soil'
              | 'access'
              | 'risk'
              | 'siding_material'
              | 'organic_growth'
              | 'gutter_guards'
              | 'roof_access'
              | 'debris'
              | 'roof_pitch'
              | 'roof_material'
              | 'service_side'
              | 'screens'
              | 'tracks',
            value: text(item, 'attribute_value'),
            multiplier: asDecimalString(text(item, 'multiplier')),
            approval: approval(item),
          })),
        addOns: addOns
          .filter((item) => text(item, 'service_rule_id') === ruleId)
          .map((item) => ({
            code: text(item, 'code'),
            name: text(item, 'name'),
            unit: text(item, 'pricing_unit') as 'flat' | 'sq_ft' | 'linear_ft' | 'each' | 'hour',
            unitPrice: decimalValue(item, 'unit_price'),
            taxable: item.taxable === true,
            estimatedUnitCost: decimalValue(item, 'estimated_unit_cost'),
            durationMinutesPerUnit: asDecimalString(text(item, 'duration_minutes_per_unit')),
            approval: approval(item),
          })),
      };
    }),
    packages: packages.map((servicePackage) => ({
      code: text(servicePackage, 'code'),
      name: text(servicePackage, 'name'),
      description: text(servicePackage, 'description'),
      tier: text(servicePackage, 'tier') as 'good' | 'better' | 'best',
      components: rowArray(
        servicePackage.components,
        `Price-book package ${text(servicePackage, 'code')} components`,
      ).map((component) => ({
        serviceCode: text(component, 'serviceCode'),
        required: component.required === true,
        requiredAddOnCodes: stringArray(component.requiredAddOnCodes),
        optionalAddOnCodes: stringArray(component.optionalAddOnCodes),
      })),
    })),
  };
}

const storedInputSchema = z.object({
  services: z
    .array(
      z.object({
        serviceCode: z.string().min(1),
        measurementId: z.string().uuid().optional(),
        quantity: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u),
        attributes: z
          .record(z.string().regex(/^[a-z][a-z0-9_]{1,79}$/u), z.string().trim().min(1).max(80))
          .refine((attributes) => Object.keys(attributes).length <= 30)
          .default({}),
        addOns: z
          .array(
            z.object({
              code: z.string().min(1),
              measurementId: z.string().uuid().optional(),
              quantity: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u),
            }),
          )
          .default([]),
      }),
    )
    .min(1),
  travelZoneCode: z.string().optional(),
  discount: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none'), reason: z.string().optional() }),
    z.object({
      kind: z.literal('percent'),
      value: z.string(),
      reason: z.string().min(1),
    }),
    z.object({
      kind: z.literal('fixed'),
      value: z.string().optional(),
      amount: z.string().optional(),
      reason: z.string().min(1),
    }),
  ]),
});

export function registerServerPricingTool(
  registry: OfficeToolRegistry,
  client: SupabaseClient,
): OfficeToolRegistry {
  registry.register({
    name: 'pricing.calculate',
    description:
      'Recalculate a stored estimate from server-owned measurements, attributes, customer tax status, and active versioned price book.',
    input: z.object({ estimateId: z.string().uuid() }),
    risk: 'low',
    sideEffect: 'none',
    reversible: true,
    supportsIdempotency: true,
    autoExecute: true,
    async execute({ estimateId }, context) {
      const { data: snapshotData, error: snapshotError } = await client.rpc(
        'load_stored_estimate_pricing_snapshot',
        {
          p_company_id: context.companyId,
          p_estimate_id: estimateId,
        },
      );
      if (snapshotError) {
        throw new Error(`Stored estimate pricing snapshot failed: ${snapshotError.message}`);
      }
      const snapshot = objectValue(snapshotData, 'Stored estimate pricing snapshot');
      const estimate = objectValue(snapshot.estimate, 'Stored estimate');
      const customer = objectValue(snapshot.customer, 'Stored estimate customer');
      const lines = rowArray(snapshot.lines, 'Estimate evidence lines');
      const measurements = rowArray(snapshot.measurements, 'Estimate measurements');
      const photoEvidence =
        snapshot.photo_evidence === null || snapshot.photo_evidence === undefined
          ? null
          : objectValue(snapshot.photo_evidence, 'Estimate photo evidence');
      const stored = storedInputSchema.parse(estimate.calculation_input);
      const priceBook = await loadActivePriceBook(
        client,
        context.companyId,
        text(estimate, 'price_book_id'),
      );
      const measurementById = new Map(measurements.map((item) => [text(item, 'id'), item]));
      const services = stored.services.map((service) => {
        const serviceRule = priceBook.serviceRules.find(
          (candidate) => candidate.serviceCode === service.serviceCode,
        );
        if (!serviceRule) {
          throw new Error(`Service ${service.serviceCode} is not in the active price book.`);
        }
        const sourceIds = lines
          .filter(
            (line) =>
              optionalText(line, 'line_kind') === 'service' &&
              optionalText(line, 'service_code') === service.serviceCode,
          )
          .flatMap((line) => stringArray(line.source_measurement_ids));
        if (sourceIds.length === 0) {
          throw new Error(`Service ${service.serviceCode} has no stored measurement evidence.`);
        }
        const matchingQuantity = sourceIds.some((id) => {
          const measurement = measurementById.get(id);
          return (
            measurement?.verified_by_human === true &&
            measurement.superseded !== true &&
            stringArray(measurement.service_codes).includes(service.serviceCode) &&
            supportsPricingUnit(measurement, serviceRule.pricingUnit) &&
            new Decimal(text(measurement, 'value')).eq(new Decimal(service.quantity))
          );
        });
        if (!matchingQuantity) {
          throw new Error(
            `Service ${service.serviceCode} quantity does not match human-verified property evidence.`,
          );
        }
        const addOns = service.addOns.map((addOn) => {
          const addOnRule = serviceRule.addOns.find((candidate) => candidate.code === addOn.code);
          if (!addOnRule) {
            throw new Error(
              `Add-on ${addOn.code} is not in service ${service.serviceCode}'s active price rule.`,
            );
          }
          const addOnLines = lines.filter(
            (line) =>
              optionalText(line, 'line_kind') === 'add_on' &&
              optionalText(line, 'service_code') === service.serviceCode &&
              optionalText(line, 'add_on_code') === addOn.code,
          );
          const addOnSourceIds = addOnLines.flatMap((line) =>
            stringArray(line.source_measurement_ids),
          );
          const hasEvidence = addOnSourceIds.some((id) => {
            const measurement = measurementById.get(id);
            return (
              measurement?.verified_by_human === true &&
              measurement.superseded !== true &&
              stringArray(measurement.add_on_codes).includes(addOn.code) &&
              supportsPricingUnit(measurement, addOnRule.unit) &&
              new Decimal(text(measurement, 'value')).eq(new Decimal(addOn.quantity))
            );
          });
          if (!hasEvidence) {
            throw new Error(
              `Add-on ${addOn.code} quantity does not match current human-verified property evidence.`,
            );
          }
          return {
            code: addOn.code,
            quantity: asDecimalString(addOn.quantity),
          };
        });
        return {
          ...service,
          quantity: asDecimalString(service.quantity),
          addOns,
          sourceMeasurementIds: [
            ...new Set([
              ...sourceIds,
              ...service.addOns.flatMap((addOn) =>
                lines
                  .filter(
                    (line) =>
                      optionalText(line, 'line_kind') === 'add_on' &&
                      optionalText(line, 'service_code') === service.serviceCode &&
                      optionalText(line, 'add_on_code') === addOn.code,
                  )
                  .flatMap((line) => stringArray(line.source_measurement_ids)),
              ),
            ]),
          ].map(asDomainId),
        };
      });
      const discount =
        stored.discount.kind === 'none'
          ? { kind: 'none' as const, reason: stored.discount.reason }
          : stored.discount.kind === 'percent'
            ? {
                kind: 'percent' as const,
                value: asDecimalString(stored.discount.value),
                reason: stored.discount.reason,
              }
            : {
                kind: 'fixed' as const,
                value: money(stored.discount.value ?? stored.discount.amount ?? '0.00'),
                reason: stored.discount.reason,
              };
      const result = calculateEstimate({
        requestId: `${context.runId}:${context.actionId}:${estimateId}`,
        companyId: asDomainId(context.companyId),
        propertyId: asDomainId(text(estimate, 'property_id')),
        priceBook,
        services,
        travelZoneCode: stored.travelZoneCode,
        discount,
        customerTaxExempt: customer.tax_exempt === true,
        scopeEvidenceDisposition:
          photoEvidence?.disposition === 'usable_for_scope'
            ? 'usable_for_scope'
            : 'human_review_required',
        calculatedAt: asISODateTime(text(estimate, 'calculated_at')),
      });
      if (!new Decimal(result.total.amount).eq(new Decimal(text(estimate, 'total')))) {
        throw new Error(
          'Stored estimate total no longer matches the active deterministic price-book calculation.',
        );
      }
      return result;
    },
  });
  return registry;
}
