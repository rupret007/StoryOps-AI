import { Decimal } from 'decimal.js';
import type { DecimalString, DomainId, ISODateTime, RetentionMetadata } from './primitives.ts';

export type PhotoPurpose =
  'scope' | 'before' | 'after' | 'damage' | 'safety' | 'incident' | 'signature';

export interface BoundingBox {
  x: DecimalString;
  y: DecimalString;
  width: DecimalString;
  height: DecimalString;
}

export interface PhotoObservation {
  label: string;
  evidence: string;
  confidence: DecimalString;
  boundingBox?: BoundingBox;
  sourcePhotoId: DomainId;
}

export interface MeasurementCandidate {
  dimension: 'area_sq_ft' | 'length_linear_ft' | 'count' | 'stories';
  value: DecimalString | null;
  method: 'photo_model' | 'map' | 'customer_reported' | 'field_measured';
  confidence: DecimalString;
  scaleReference?: string;
  humanVerified: boolean;
  sourcePhotoIds: readonly DomainId[];
}

export interface PhotoAnalysis {
  id: DomainId;
  companyId: DomainId;
  propertyId: DomainId;
  model: string;
  modelVersion: string;
  promptVersion: string;
  analyzedAt: ISODateTime;
  purpose: PhotoPurpose;
  observations: readonly PhotoObservation[];
  measurementCandidates: readonly MeasurementCandidate[];
  unknowns: readonly string[];
  injectionSignals: readonly string[];
  overallConfidence: DecimalString;
  retention: RetentionMetadata;
}

export interface EvidencePolicy {
  minimumObservationConfidence: DecimalString;
  minimumOverallConfidence: DecimalString;
  requireHumanVerificationForBillingMeasurements: boolean;
  requireScaleReferenceForPhotoMeasurements: boolean;
  requiredObservationLabels: readonly string[];
}

export interface EvidenceAssessment {
  disposition: 'usable_for_scope' | 'human_review_required' | 'insufficient';
  reasons: readonly string[];
  acceptedObservationLabels: readonly string[];
  rejectedObservationLabels: readonly string[];
  billableMeasurements: readonly MeasurementCandidate[];
}

const isProbability = (value: DecimalString): boolean => {
  const decimal = new Decimal(value);
  return decimal.greaterThanOrEqualTo(0) && decimal.lessThanOrEqualTo(1);
};

export const assessPhotoEvidence = (
  analysis: PhotoAnalysis,
  policy: EvidencePolicy,
): EvidenceAssessment => {
  const reasons: string[] = [];
  const acceptedObservationLabels: string[] = [];
  const rejectedObservationLabels: string[] = [];
  const observationMinimum = new Decimal(policy.minimumObservationConfidence);

  if (!isProbability(analysis.overallConfidence)) {
    reasons.push('Overall confidence is outside the valid 0–1 range.');
  } else if (new Decimal(analysis.overallConfidence).lessThan(policy.minimumOverallConfidence)) {
    reasons.push('Overall confidence is below policy minimum.');
  }

  for (const observation of analysis.observations) {
    if (
      !isProbability(observation.confidence) ||
      new Decimal(observation.confidence).lessThan(observationMinimum)
    ) {
      rejectedObservationLabels.push(observation.label);
    } else {
      acceptedObservationLabels.push(observation.label);
    }
  }

  for (const requiredLabel of policy.requiredObservationLabels) {
    if (!acceptedObservationLabels.includes(requiredLabel)) {
      reasons.push(`Required observation "${requiredLabel}" is missing or low-confidence.`);
    }
  }

  if (analysis.unknowns.length > 0) {
    reasons.push(`Analysis contains unresolved unknowns: ${analysis.unknowns.join('; ')}`);
  }
  if (analysis.injectionSignals.length > 0) {
    reasons.push('Potential prompt-injection content was detected in media.');
  }

  const billableMeasurements = analysis.measurementCandidates.filter((candidate) => {
    if (candidate.value === null || !isProbability(candidate.confidence)) {
      return false;
    }
    if (
      policy.requireHumanVerificationForBillingMeasurements &&
      candidate.method !== 'field_measured' &&
      !candidate.humanVerified
    ) {
      return false;
    }
    if (
      policy.requireScaleReferenceForPhotoMeasurements &&
      candidate.method === 'photo_model' &&
      !candidate.scaleReference
    ) {
      return false;
    }
    return true;
  });

  if (billableMeasurements.length !== analysis.measurementCandidates.length) {
    reasons.push('One or more measurement candidates are not eligible for billing.');
  }

  const hasNoUsefulEvidence =
    acceptedObservationLabels.length === 0 && billableMeasurements.length === 0;

  return {
    disposition: hasNoUsefulEvidence
      ? 'insufficient'
      : reasons.length > 0
        ? 'human_review_required'
        : 'usable_for_scope',
    reasons,
    acceptedObservationLabels,
    rejectedObservationLabels,
    billableMeasurements,
  };
};
