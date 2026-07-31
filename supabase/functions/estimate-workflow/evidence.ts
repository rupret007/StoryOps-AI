export type MeasurementScopeEvidence = Readonly<Record<string, unknown>>;
export type ScopeEvidencePolicy = 'photo_required' | 'photo_optional' | 'not_applicable';
export type ScopePhotoDisposition = 'usable_for_scope' | 'human_review_required' | 'insufficient';
export type ResolvedScopeEvidenceDisposition = ScopePhotoDisposition | 'not_applicable';

const UNIT_EVIDENCE: Readonly<Record<string, { kind: string; unit: string }>> = {
  flat: { kind: 'count', unit: 'each' },
  sq_ft: { kind: 'area_sq_ft', unit: 'sq_ft' },
  linear_ft: { kind: 'length_linear_ft', unit: 'linear_ft' },
  each: { kind: 'count', unit: 'each' },
  hour: { kind: 'duration_hours', unit: 'hour' },
};

const KIND_UNITS: Readonly<Record<string, string>> = {
  area_sq_ft: 'sq_ft',
  length_linear_ft: 'linear_ft',
  height_ft: 'ft',
  count: 'each',
  stories: 'story',
  duration_hours: 'hour',
};

function includesCode(value: unknown, code: string): boolean {
  return Array.isArray(value) && value.some((candidate) => candidate === code);
}

export function measurementSupportsScope(
  measurement: MeasurementScopeEvidence,
  pricingUnit: string,
  serviceCode: string,
  addOnCode?: string,
  requiredMeasurementKinds: readonly string[] = [],
): boolean {
  const required = UNIT_EVIDENCE[pricingUnit];
  const kindMatches =
    requiredMeasurementKinds.length > 0
      ? requiredMeasurementKinds.includes(String(measurement.kind))
      : measurement.kind === required?.kind;
  if (!required || !kindMatches || measurement.unit !== required.unit) {
    return false;
  }
  if (pricingUnit === 'flat' && Number(measurement.value) !== 1) return false;
  return addOnCode
    ? includesCode(measurement.add_on_codes, addOnCode)
    : includesCode(measurement.service_codes, serviceCode);
}

export function measurementSupportsServiceRequirement(
  measurement: MeasurementScopeEvidence,
  requiredKind: string,
  serviceCode: string,
): boolean {
  return (
    measurement.kind === requiredKind &&
    measurement.unit === KIND_UNITS[requiredKind] &&
    includesCode(measurement.service_codes, serviceCode)
  );
}

export function resolveScopeEvidenceDisposition(
  policies: readonly ScopeEvidencePolicy[],
  photoDisposition: ScopePhotoDisposition | null,
  reviewedBundleEligible = false,
): ResolvedScopeEvidenceDisposition {
  if (policies.includes('photo_required')) {
    return reviewedBundleEligible ? 'usable_for_scope' : 'human_review_required';
  }
  if (policies.includes('photo_optional')) {
    if (photoDisposition === null) return 'not_applicable';
    return photoDisposition === 'usable_for_scope' ? 'usable_for_scope' : 'human_review_required';
  }
  return 'not_applicable';
}
