import { z } from 'zod';
import { scopeEvidenceFlagSchema } from '../scopePhotos/contracts.ts';

const probability = z.number().min(0).max(1);

export const photoAnalysisOutputSchema = z.object({
  observations: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        evidence: z.string().min(1).max(1_000),
        confidence: probability,
      }),
    )
    .max(50),
  measurementCandidates: z
    .array(
      z.object({
        dimension: z.enum(['area_sq_ft', 'length_linear_ft', 'count', 'stories']),
        value: z
          .string()
          .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u)
          .nullable(),
        confidence: probability,
        scaleReference: z.string().min(1).max(500).nullable(),
      }),
    )
    .max(25),
  accessFlags: z.array(scopeEvidenceFlagSchema).max(25).default([]),
  riskFlags: z.array(scopeEvidenceFlagSchema).max(25).default([]),
  unknowns: z.array(z.string().min(1).max(500)).max(50),
  injectionSignals: z.array(z.string().min(1).max(500)).max(20),
  overallConfidence: probability,
});

export type PhotoAnalysisOutput = z.infer<typeof photoAnalysisOutputSchema>;

export type GroundedPhotoAnalysis = PhotoAnalysisOutput & {
  sourceAssetId: string;
  disposition: 'usable_for_scope' | 'human_review_required' | 'insufficient';
  reasons: string[];
  billableMeasurements: [];
};

/**
 * Converts model evidence into a conservative application result. Photo-derived
 * measurement candidates never become billable measurements until a person
 * creates or verifies a separate property_measurements record.
 */
export function groundPhotoAnalysis(
  sourceAssetId: string,
  input: unknown,
  minimumConfidence = 0.85,
): GroundedPhotoAnalysis {
  const output = photoAnalysisOutputSchema.parse(input);
  const reasons: string[] = [];
  const acceptedObservations = output.observations.filter(
    (observation) => observation.confidence >= minimumConfidence,
  );

  if (output.overallConfidence < minimumConfidence) {
    reasons.push('Overall confidence is below the automatic-use threshold.');
  }
  if (output.unknowns.length > 0) {
    reasons.push('The image contains unresolved unknowns.');
  }
  if (output.injectionSignals.length > 0) {
    reasons.push('Text in the image may contain prompt-injection instructions.');
  }
  if (output.measurementCandidates.length > 0) {
    reasons.push('Photo-derived measurements require human verification and a scale reference.');
  }
  if (
    [...output.accessFlags, ...output.riskFlags].some(
      (flag) => flag.status !== 'observed' || flag.confidence < minimumConfidence,
    )
  ) {
    reasons.push('One or more access or risk flags require human review.');
  }
  if (output.riskFlags.some((flag) => flag.status === 'observed')) {
    reasons.push('A visible risk flag requires human review before scope confirmation.');
  }
  if (
    output.measurementCandidates.some(
      (candidate) => candidate.value !== null && candidate.scaleReference === null,
    )
  ) {
    reasons.push('At least one measurement candidate has no scale reference.');
  }

  return {
    ...output,
    sourceAssetId,
    disposition:
      acceptedObservations.length === 0
        ? 'insufficient'
        : reasons.length > 0
          ? 'human_review_required'
          : 'usable_for_scope',
    reasons,
    billableMeasurements: [],
  };
}

export function sandboxPhotoAnalysis(sourceAssetId: string): GroundedPhotoAnalysis {
  return groundPhotoAnalysis(sourceAssetId, {
    observations: [
      {
        label: 'image_received',
        evidence: 'A registered media asset is available for human review.',
        confidence: 0.2,
      },
    ],
    measurementCandidates: [],
    accessFlags: [],
    riskFlags: [],
    unknowns: ['Live vision is disabled; surface, soil, access, risk, and dimensions are unknown.'],
    injectionSignals: [],
    overallConfidence: 0.2,
  });
}
