import { describe, expect, it } from 'vitest';
import {
  buildPilotReleaseEvidenceCommand,
  pilotReleaseEvidenceInputSchema,
  pilotReleaseEvidenceRecordSchema,
} from '@/core/pilot/releaseEvidence';

const providerEvidence = {
  kind: 'provider_canary' as const,
  provider: 'stripe' as const,
  outcome: 'passed' as const,
  source: 'external_provider_receipt' as const,
  evidenceReference: 'stripe-staging-canary-receipt-2026-07-29',
  artifactSha256: 'a'.repeat(64),
  observedAt: '2026-07-29T12:00:00-05:00',
  expiresAt: '2026-08-05T12:00:00-05:00',
  reviewNote: 'owner-review-attestation-001',
};

describe('pilot release evidence contract', () => {
  it('normalizes timestamps and builds deterministic exact-payload commands', async () => {
    const input = {
      companyId: '10000000-0000-4000-8000-000000000001',
      userId: '10000000-0000-4000-8000-000000000101',
      evidence: providerEvidence,
    };
    const first = await buildPilotReleaseEvidenceCommand(input);
    const replay = await buildPilotReleaseEvidenceCommand(structuredClone(input));

    expect(replay).toEqual(first);
    expect(first.commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(first.requestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.evidence.observedAt).toBe('2026-07-29T17:00:00.000Z');
    expect(first.evidence.expiresAt).toBe('2026-08-05T17:00:00.000Z');
  });

  it('binds provider/source shape and bounded freshness without accepting assertions', () => {
    expect(
      pilotReleaseEvidenceInputSchema.safeParse({
        ...providerEvidence,
        provider: undefined,
      }).success,
    ).toBe(false);
    expect(
      pilotReleaseEvidenceInputSchema.safeParse({
        ...providerEvidence,
        kind: 'backup_restore',
        provider: undefined,
      }).success,
    ).toBe(false);
    expect(
      pilotReleaseEvidenceInputSchema.safeParse({
        ...providerEvidence,
        expiresAt: '2026-08-06T12:00:01-05:00',
      }).success,
    ).toBe(false);
    expect(
      pilotReleaseEvidenceInputSchema.safeParse({
        ...providerEvidence,
        evidenceReference: 'sk-proj-must-not-be-stored',
      }).success,
    ).toBe(false);
  });

  it('distinguishes owner attestations from immutable trusted-system proof', () => {
    const record = {
      ...providerEvidence,
      id: '70000000-0000-4000-8000-000000000001',
      companyId: '10000000-0000-4000-8000-000000000001',
      reviewedByUserId: '10000000-0000-4000-8000-000000000101',
      verificationBasis: 'owner_attestation' as const,
      recordedAt: '2026-07-29T17:01:00.000Z',
    };
    expect(pilotReleaseEvidenceRecordSchema.safeParse(record).success).toBe(true);
    expect(
      pilotReleaseEvidenceRecordSchema.safeParse({
        ...record,
        verificationBasis: 'trusted_system_proof',
      }).success,
    ).toBe(false);
    expect(
      pilotReleaseEvidenceRecordSchema.safeParse({
        ...record,
        verificationBasis: 'trusted_system_proof',
        source: 'external_provider_read_canary',
        binding: {
          configurationRevision: 4,
          configurationHash: 'b'.repeat(64),
          baselineId: '30000000-0000-4000-8000-000000000001',
          baselineHash: 'c'.repeat(64),
          capability: 'payments',
          integrationProvider: 'stripe',
          integrationVersion: 3,
          verificationRunId: '70000000-0000-4000-8000-000000000002',
        },
      }).success,
    ).toBe(true);
  });

  it('requires field-media proof to bind its assigned visit and media fixture', () => {
    const fieldProof = {
      id: '70000000-0000-4000-8000-000000000010',
      companyId: '10000000-0000-4000-8000-000000000001',
      kind: 'field_media_canary' as const,
      provider: 'signed_storage_targets' as const,
      outcome: 'passed' as const,
      source: 'authenticated_field_media_roundtrip' as const,
      evidenceReference: 'verify-70000000-0000-4000-8000-000000000010',
      artifactSha256: 'd'.repeat(64),
      observedAt: '2026-07-29T17:00:00.000Z',
      expiresAt: '2026-08-28T17:00:00.000Z',
      reviewNote: 'trusted-verifier-run',
      reviewedByUserId: '10000000-0000-4000-8000-000000000101',
      verificationBasis: 'trusted_system_proof' as const,
      recordedAt: '2026-07-29T17:01:00.000Z',
      binding: {
        configurationRevision: 4,
        configurationHash: 'b'.repeat(64),
        baselineId: '30000000-0000-4000-8000-000000000001',
        baselineHash: 'c'.repeat(64),
        capability: 'private_media_roundtrip',
        integrationProvider: 'signed_storage_targets' as const,
        integrationVersion: 4,
        verificationRunId: '70000000-0000-4000-8000-000000000010',
        visitId: '70000000-0000-4000-8000-000000000011',
        mediaAssetId: '70000000-0000-4000-8000-000000000012',
        fieldWorkerRole: 'owner_field_worker' as const,
      },
    };

    expect(pilotReleaseEvidenceRecordSchema.safeParse(fieldProof).success).toBe(true);
    expect(
      pilotReleaseEvidenceRecordSchema.safeParse({
        ...fieldProof,
        binding: { ...fieldProof.binding, mediaAssetId: undefined },
      }).success,
    ).toBe(false);
    expect(
      pilotReleaseEvidenceRecordSchema.safeParse({
        ...fieldProof,
        provider: 'stripe',
      }).success,
    ).toBe(false);
  });
});
