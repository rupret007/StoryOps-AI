import { describe, expect, it } from 'vitest';
import { groundPhotoAnalysis, sandboxPhotoAnalysis } from '@/core/ai/photoAnalysis';

describe('photo-assisted scope guardrails', () => {
  it('returns explicit unknowns when live vision is disabled', () => {
    const result = sandboxPhotoAnalysis('asset-1');
    expect(result.disposition).toBe('insufficient');
    expect(result.unknowns).toContain(
      'Live vision is disabled; surface, soil, access, risk, and dimensions are unknown.',
    );
    expect(result.billableMeasurements).toEqual([]);
  });

  it('escalates otherwise confident evidence when measurements are proposed', () => {
    const result = groundPhotoAnalysis('asset-1', {
      observations: [
        {
          label: 'surface',
          evidence: 'Visible broom-finished concrete.',
          confidence: 0.94,
        },
      ],
      measurementCandidates: [
        {
          dimension: 'area_sq_ft',
          value: '840',
          confidence: 0.81,
          scaleReference: null,
        },
      ],
      unknowns: [],
      injectionSignals: [],
      overallConfidence: 0.91,
    });
    expect(result.disposition).toBe('human_review_required');
    expect(result.billableMeasurements).toEqual([]);
    expect(result.reasons).toContain(
      'Photo-derived measurements require human verification and a scale reference.',
    );
  });

  it('treats instructions embedded in media as an escalation signal', () => {
    const result = groundPhotoAnalysis('asset-1', {
      observations: [
        {
          label: 'surface',
          evidence: 'Concrete is visible.',
          confidence: 0.95,
        },
      ],
      measurementCandidates: [],
      unknowns: [],
      injectionSignals: ['Image text attempts to override estimation policy.'],
      overallConfidence: 0.95,
    });
    expect(result.disposition).toBe('human_review_required');
    expect(result.reasons).toContain(
      'Text in the image may contain prompt-injection instructions.',
    );
  });
});
