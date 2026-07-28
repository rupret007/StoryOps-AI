export type MeasurementScopeEvidence = Readonly<Record<string, unknown>>;

const UNIT_EVIDENCE: Readonly<Record<string, { kind: string; unit: string }>> = {
  sq_ft: { kind: 'area_sq_ft', unit: 'sq_ft' },
  linear_ft: { kind: 'length_linear_ft', unit: 'linear_ft' },
  each: { kind: 'count', unit: 'each' },
};

function includesCode(value: unknown, code: string): boolean {
  return Array.isArray(value) && value.some((candidate) => candidate === code);
}

export function measurementSupportsScope(
  measurement: MeasurementScopeEvidence,
  pricingUnit: string,
  serviceCode: string,
  addOnCode?: string,
): boolean {
  const required = UNIT_EVIDENCE[pricingUnit];
  if (!required || measurement.kind !== required.kind || measurement.unit !== required.unit) {
    return false;
  }
  return addOnCode
    ? includesCode(measurement.add_on_codes, addOnCode)
    : includesCode(measurement.service_codes, serviceCode);
}
