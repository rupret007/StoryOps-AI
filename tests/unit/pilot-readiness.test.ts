import { describe, expect, it } from 'vitest';
import { derivePilotReadiness } from '@/core/pilot/readiness';
import {
  createExteriorConfigurationPricing,
  type ExteriorServiceCode,
} from '@/data/exteriorServiceTemplates';
import { createExteriorServicesConfiguration } from '@/domain/companyConfiguration';
import { getExteriorConfigurationRequirements } from '@/domain/exteriorServiceRequirements';
import { createDemoState } from '@/state/demoSeed';
import type { PilotReleaseEvidenceRecord } from '@/core/pilot/releaseEvidence';
import {
  outboundWorkerHealthProjectionSchema,
  requiredPrivateWorkerIds,
} from '@/core/integrations/outboundWorkerHealth';

const NOW = '2026-07-29T12:30:00.000Z';
const COMPANY_ID = '22222222-2222-4222-8222-222222222222';

function reviewedConfiguration() {
  const enabled: ExteriorServiceCode[] = ['pressure-wash-flatwork', 'gutter-cleaning'];
  const configuration = createExteriorServicesConfiguration({
    legalName: 'Pilot Exterior Care LLC',
    ownerName: 'Pilot Owner',
    publicEmail: 'pilot@example.test',
    publicPhone: '+18175550123',
    addressLine1: '100 Pilot Road',
    city: 'Grapevine',
    postalCode: '76051',
    enabledServiceCodes: enabled,
    ...createExteriorConfigurationPricing(enabled),
  });
  const requirements = getExteriorConfigurationRequirements(enabled);
  const owner = configuration.people.crewMembers.find(
    (member) => member.active && member.role === 'owner',
  )!;
  owner.skills = [...new Set([...owner.skills, ...requirements.requiredSkills])];
  for (const equipmentType of requirements.requiredEquipmentTypes) {
    const existing = configuration.resources.equipment.find(
      (equipment) => equipment.equipmentType === equipmentType,
    );
    if (existing) {
      existing.active = true;
      existing.inspectionStatus = 'current';
    } else {
      configuration.resources.equipment.push({
        id: `pilot-${equipmentType}`,
        name: `Pilot ${equipmentType}`,
        equipmentType,
        quantity: 1,
        inspectionStatus: 'current',
        active: true,
      });
    }
  }
  const reviewedAt = '2026-07-29T12:00:00.000Z';
  configuration.territory.travelZoneMappingReview = {
    status: 'approved',
    reviewer: 'Owner territory reviewer',
    reviewedAt,
    evidenceReference: 'territory-mapping-review-1',
  };
  configuration.pricing.taxReview = {
    status: 'approved',
    reviewer: 'Tax reviewer',
    reviewedAt,
    evidenceReference: 'tax-review-1',
  };
  for (const review of [
    configuration.policies.legalReview,
    configuration.policies.privacyReview,
    configuration.policies.safetyReview,
    configuration.policies.insuranceReview,
    configuration.policies.environmentalReview,
  ]) {
    review.status = 'approved';
    review.reviewer = 'Qualified reviewer';
    review.reviewedAt = reviewedAt;
    review.evidenceReference = 'qualified-review-1';
  }
  return configuration;
}

function releaseEvidence(
  input: Pick<
    PilotReleaseEvidenceRecord,
    'id' | 'kind' | 'source' | 'evidenceReference' | 'observedAt' | 'expiresAt'
  > &
    Partial<PilotReleaseEvidenceRecord>,
): PilotReleaseEvidenceRecord {
  return {
    companyId: COMPANY_ID,
    outcome: 'passed',
    artifactSha256: 'c'.repeat(64),
    reviewedByUserId: '10000000-0000-4000-8000-000000000101',
    verificationBasis: 'owner_attestation',
    reviewNote: 'owner-review-attestation-001',
    recordedAt: '2026-07-29T12:01:00.000Z',
    ...input,
  };
}

function privateWorkerProjection(blockedWorker?: (typeof requiredPrivateWorkerIds)[number]) {
  const blocked = blockedWorker !== undefined;
  return outboundWorkerHealthProjectionSchema.parse({
    schemaVersion: 'storyops-private-worker-readiness-v2',
    companyId: COMPANY_ID,
    checkedAt: NOW,
    expiresAt: '2026-07-29T12:35:00.000Z',
    evidenceVersion: 8,
    evidenceHash: 'd'.repeat(64),
    deploymentFingerprint: 'e'.repeat(64),
    alertAfterSeconds: 900,
    status: blocked ? 'blocked' : 'healthy',
    liveReady: !blocked,
    safeDisabled: false,
    workers: requiredPrivateWorkerIds.map((worker) => {
      const workerBlocked = worker === blockedWorker;
      return {
        worker,
        configurationEnabled: true,
        activationMode: 'scheduled',
        credentialStatus: 'valid',
        acceptedTrigger: 'scheduled',
        scheduleIntervalSeconds: 120,
        configurationHash: 'f'.repeat(64),
        deploymentIdentityStatus: 'valid',
        deploymentFingerprint: 'e'.repeat(64),
        heartbeat: {
          status: workerBlocked ? 'missing' : 'verified',
          observedAt: workerBlocked ? null : '2026-07-29T12:29:30.000Z',
          trigger: workerBlocked ? null : 'scheduled',
        },
        schedulerEvidence: workerBlocked ? 'missing' : 'verified',
        status: workerBlocked ? 'blocked' : 'healthy',
        liveReady: !workerBlocked,
        blockers: workerBlocked ? ['WORKER_HEARTBEAT_MISSING'] : [],
        queue: {
          availability: 'verified',
          backlogCount: 0,
          dueCount: 0,
          submissionUnknownCount: 0,
          oldestQueuedAt: null,
          oldestQueuedAgeSeconds: null,
          actionCounts: {
            postService: 0,
            quoteDelivery: 0,
            onMyWay: 0,
            schedulingReconciliation: 0,
            scopePhotoCleanup: 0,
          },
        },
      };
    }),
  });
}

describe('pilot readiness projection', () => {
  it('fails closed on a missing private worker and surfaces its exact blocker', () => {
    const state = createDemoState();
    state.dataMode = 'supabase';
    state.online = true;
    state.serverVerifiedAt = NOW;
    state.live = {
      userId: '10000000-0000-4000-8000-000000000101',
      companyId: COMPANY_ID,
      companyName: 'Pilot Exterior Care',
      companyTimezone: 'America/Chicago',
      serverTime: NOW,
      invoiceVersions: {},
      leadVersions: {},
      checklistItems: {},
      checklistDefinitions: {},
      incidentVersions: {},
      notificationVersions: {},
      approvalVersions: {},
      materials: [],
      customers: [],
      properties: [],
    };
    state.pilotReleaseEvidence = {
      schemaVersion: 'storyops-pilot-evidence-state-v1',
      companyId: COMPANY_ID,
      serverTime: NOW,
      records: [],
    };
    state.providerLaunch = {
      schemaVersion: 'storyops-provider-launch-state-v1',
      companyId: COMPANY_ID,
      role: 'owner',
      connections: [],
      schedulingGate: null,
      privateWorkers: privateWorkerProjection('scope_photo_cleanup'),
      launch: {
        version: 0,
        status: 'not_authorized',
        launchAuthorized: false,
      },
      serverTime: NOW,
    };
    let check = derivePilotReadiness(state, { now: NOW }).checks.find(
      (candidate) => candidate.id === 'private-workers',
    );
    expect(check).toMatchObject({
      status: 'blocked',
      evidence: expect.stringContaining('scope photo cleanup: WORKER_HEARTBEAT_MISSING'),
    });

    state.providerLaunch.privateWorkers = privateWorkerProjection();
    check = derivePilotReadiness(state, { now: NOW }).checks.find(
      (candidate) => candidate.id === 'private-workers',
    );
    expect(check).toMatchObject({ status: 'ready' });
  });

  it('labels local operation only as a sandbox rehearsal and retains blocked/manual gates', () => {
    const projection = derivePilotReadiness(createDemoState());

    expect(projection.verdict).toBe('SANDBOX_REHEARSAL');
    expect(projection.verdictReason).toMatch(/proves no provider/iu);
    expect(projection.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'configuration', status: 'blocked' }),
        expect.objectContaining({ id: 'backup', status: 'manual_gate' }),
      ]),
    );
    expect(projection.providers.some((provider) => provider.canary === 'passed')).toBe(false);
  });

  it('requires the active baseline and external canaries even after every owner review is approved', () => {
    const state = createDemoState();
    const configuration = reviewedConfiguration();
    state.dataMode = 'supabase';
    state.companyConfiguration = {
      schemaVersion: 'storyops-company-config-record-v1',
      status: 'published',
      revision: 4,
      draft: configuration,
      published: configuration,
      updatedAt: '2026-07-29T12:00:00.000Z',
      publishedAt: '2026-07-29T12:00:00.000Z',
      publicationMode: 'live',
      publicationReceipt: {
        commandId: '11111111-1111-4111-8111-111111111111',
        configurationHash: 'a'.repeat(64),
        reviewReference: 'owner-config-review',
        replayed: false,
      },
    };

    const beforeBaseline = derivePilotReadiness(state);
    expect(beforeBaseline.verdict).toBe('HOLD_LIVE_PILOT');
    expect(beforeBaseline.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'operating-baseline', status: 'blocked' }),
      ]),
    );

    state.operatingBaseline = {
      schemaVersion: 'storyops-operating-baseline-state-v1',
      status: 'active',
      companyId: '22222222-2222-4222-8222-222222222222',
      configurationRevision: 4,
      configurationHash: 'a'.repeat(64),
      baselineId: '33333333-3333-4333-8333-333333333333',
      baselineHash: 'b'.repeat(64),
      priceBookId: '44444444-4444-4444-8444-444444444444',
      serviceTermsId: '55555555-5555-4555-8555-555555555555',
      retentionPolicyId: '66666666-6666-4666-8666-666666666666',
      reviewReference: 'owner-operating-review',
      activatedAt: '2026-07-29T12:05:00.000Z',
      providersActivated: false,
      outboundEnabled: false,
      launchAuthorized: false,
      launchVersion: 0,
      launchStatus: 'not_authorized',
      launchProviderSnapshotHash: null,
      launchProofSnapshotHash: null,
    };
    const afterBaseline = derivePilotReadiness(state);
    expect(afterBaseline.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'operating-baseline', status: 'ready' }),
        expect.objectContaining({ id: 'backup', status: 'blocked' }),
      ]),
    );
    expect(afterBaseline.verdict).toBe('HOLD_LIVE_PILOT');
  });

  it('counts only exact active-owner skills and active/current required equipment', () => {
    const state = createDemoState();
    const configuration = reviewedConfiguration();
    state.setupComplete = true;
    state.companyConfiguration = {
      schemaVersion: 'storyops-company-config-record-v1',
      status: 'published',
      revision: 2,
      draft: configuration,
      published: configuration,
      updatedAt: '2026-07-29T12:00:00.000Z',
      publishedAt: '2026-07-29T12:00:00.000Z',
      publicationMode: 'sandbox',
      publicationReceipt: {
        commandId: '11111111-1111-4111-8111-111111111112',
        configurationHash: 'a'.repeat(64),
        reviewReference: 'sandbox-owner-review',
        replayed: false,
      },
    };

    expect(
      derivePilotReadiness(state).checks.find((check) => check.id === 'crew-resources'),
    ).toMatchObject({ status: 'ready' });

    const owner = configuration.people.crewMembers.find((member) => member.role === 'owner')!;
    owner.skills = owner.skills.filter((skill) => skill !== 'ladder-safety');
    configuration.people.crewMembers.push({
      id: 'planning-ladder-technician',
      name: 'Planning Ladder Technician',
      role: 'technician',
      skills: ['ladder-safety'],
      active: true,
    });
    expect(
      derivePilotReadiness(state).checks.find((check) => check.id === 'crew-resources'),
    ).toMatchObject({ status: 'blocked' });

    owner.skills.push('ladder-safety');
    const ladder = configuration.resources.equipment.find(
      (equipment) => equipment.equipmentType === 'ladder',
    )!;
    ladder.inspectionStatus = 'due';
    configuration.resources.equipment.push({
      id: 'inactive-current-ladder',
      name: 'Inactive current ladder',
      equipmentType: 'ladder',
      quantity: 1,
      inspectionStatus: 'current',
      active: false,
    });
    expect(
      derivePilotReadiness(state).checks.find((check) => check.id === 'crew-resources'),
    ).toMatchObject({
      status: 'blocked',
      evidence: expect.stringMatching(/planning personnel and due\/out-of-service/iu),
    });
  });

  it('keeps owner attestations manual and recognizes only current immutable proof bindings', () => {
    const state = createDemoState();
    const configuration = reviewedConfiguration();
    for (const provider of configuration.integrations.providers) {
      provider.requestedMode = 'disabled';
      provider.environmentEnabled = false;
      provider.ownerEnabled = false;
      provider.health = 'not_checked';
    }
    for (const providerName of ['stripe', 'storage'] as const) {
      const provider = configuration.integrations.providers.find(
        (candidate) => candidate.provider === providerName,
      )!;
      provider.requestedMode = 'live';
      provider.environmentEnabled = true;
      provider.ownerEnabled = true;
      provider.health = 'healthy';
    }
    state.dataMode = 'supabase';
    state.online = true;
    state.serverVerifiedAt = NOW;
    state.setupComplete = true;
    state.live = {
      userId: '10000000-0000-4000-8000-000000000101',
      companyId: '22222222-2222-4222-8222-222222222222',
      companyName: 'Pilot Exterior Care',
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-29T12:30:00.000Z',
      invoiceVersions: {},
      leadVersions: {},
      checklistItems: {},
      checklistDefinitions: {},
      incidentVersions: {},
      notificationVersions: {},
      approvalVersions: {},
      materials: [],
      customers: [],
      properties: [],
    };
    state.companyConfiguration = {
      schemaVersion: 'storyops-company-config-record-v1',
      status: 'published',
      revision: 4,
      draft: configuration,
      published: configuration,
      updatedAt: '2026-07-29T12:00:00.000Z',
      publishedAt: '2026-07-29T12:00:00.000Z',
      publicationMode: 'live',
      publicationReceipt: {
        commandId: '11111111-1111-4111-8111-111111111111',
        configurationHash: 'a'.repeat(64),
        reviewReference: 'owner-config-review',
        replayed: false,
      },
    };
    state.operatingBaseline = {
      schemaVersion: 'storyops-operating-baseline-state-v1',
      status: 'active',
      companyId: '22222222-2222-4222-8222-222222222222',
      configurationRevision: 4,
      configurationHash: 'a'.repeat(64),
      baselineId: '33333333-3333-4333-8333-333333333333',
      baselineHash: 'b'.repeat(64),
      priceBookId: '44444444-4444-4444-8444-444444444444',
      serviceTermsId: '55555555-5555-4555-8555-555555555555',
      retentionPolicyId: '66666666-6666-4666-8666-666666666666',
      reviewReference: 'owner-operating-review',
      activatedAt: '2026-07-29T12:05:00.000Z',
      providersActivated: false,
      outboundEnabled: false,
      launchAuthorized: false,
      launchVersion: 0,
      launchStatus: 'not_authorized',
      launchProviderSnapshotHash: null,
      launchProofSnapshotHash: null,
    };
    state.integrations = [
      {
        id: 'stripe',
        name: 'Stripe',
        provider: 'stripe',
        mode: 'Live',
        status: 'Healthy',
        capabilities: ['payments'],
        lastCheck: '2026-07-29T12:20:00.000Z',
        version: 3,
      },
      {
        id: 'signed_storage_targets',
        name: 'Server-signed media targets',
        provider: 'signed_storage_targets',
        mode: 'Live',
        status: 'Healthy',
        capabilities: ['server_signed_targets'],
        lastCheck: '2026-07-29T12:20:00.000Z',
        version: 4,
      },
    ];
    state.providerLaunch = {
      schemaVersion: 'storyops-provider-launch-state-v1',
      companyId: '22222222-2222-4222-8222-222222222222',
      role: 'owner',
      connections: [
        {
          id: 'a0000000-0000-4000-8000-000000000001',
          provider: 'stripe',
          mode: 'live',
          ownerEnabled: true,
          environmentMode: 'live',
          environmentStatus: 'healthy',
          environmentCheckedAt: '2026-07-29T12:20:00.000Z',
          environmentExpiresAt: '2026-07-29T12:35:00.000Z',
          environmentCapabilities: ['payments'],
          capabilities: ['payments'],
          version: 3,
          canActivateLive: true,
          canActivateSandbox: false,
        },
        {
          id: 'a0000000-0000-4000-8000-000000000002',
          provider: 'signed_storage_targets',
          mode: 'live',
          ownerEnabled: true,
          environmentMode: 'live',
          environmentStatus: 'healthy',
          environmentCheckedAt: '2026-07-29T12:20:00.000Z',
          environmentExpiresAt: '2026-07-29T12:35:00.000Z',
          environmentCapabilities: ['server_signed_targets'],
          capabilities: ['server_signed_targets'],
          version: 4,
          canActivateLive: true,
          canActivateSandbox: false,
        },
      ],
      schedulingGate: null,
      launch: {
        version: 0,
        status: 'not_authorized',
        launchAuthorized: false,
      },
      serverTime: NOW,
    };
    state.pilotReleaseEvidence = {
      schemaVersion: 'storyops-pilot-evidence-state-v1',
      companyId: '22222222-2222-4222-8222-222222222222',
      serverTime: '2026-07-29T12:30:00.000Z',
      records: [
        releaseEvidence({
          id: '70000000-0000-4000-8000-000000000001',
          kind: 'provider_canary',
          provider: 'stripe',
          source: 'external_provider_receipt',
          evidenceReference: 'stripe-canary-receipt-2026-07-29',
          observedAt: '2026-07-29T12:00:00.000Z',
          expiresAt: '2026-08-05T12:00:00.000Z',
        }),
        releaseEvidence({
          id: '70000000-0000-4000-8000-000000000002',
          kind: 'provider_canary',
          provider: 'signed_storage_targets',
          source: 'external_provider_receipt',
          evidenceReference: 'storage-provider-receipt-2026-07-29',
          observedAt: '2026-07-29T12:00:00.000Z',
          expiresAt: '2026-08-05T12:00:00.000Z',
        }),
        releaseEvidence({
          id: '70000000-0000-4000-8000-000000000003',
          kind: 'field_media_canary',
          source: 'storage_roundtrip',
          evidenceReference: 'private-media-roundtrip-2026-07-29',
          observedAt: '2026-07-29T12:00:00.000Z',
          expiresAt: '2026-08-28T12:00:00.000Z',
        }),
        releaseEvidence({
          id: '70000000-0000-4000-8000-000000000004',
          kind: 'backup_restore',
          source: 'isolated_restore_drill',
          evidenceReference: 'isolated-restore-drill-2026-07-29',
          observedAt: '2026-07-29T12:00:00.000Z',
          expiresAt: '2026-08-28T12:00:00.000Z',
        }),
      ],
    };

    const attested = derivePilotReadiness(state, { now: NOW });
    expect(attested.verdict).toBe('HOLD_LIVE_PILOT');
    expect(
      attested.providers
        .filter((provider) => provider.mode === 'Live')
        .every((provider) => provider.canary === 'owner_attestation'),
    ).toBe(true);
    expect(attested.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'field-media', status: 'blocked' }),
        expect.objectContaining({ id: 'backup', status: 'blocked' }),
        expect.objectContaining({ id: 'launch-authorization', status: 'manual_gate' }),
      ]),
    );

    for (const record of state.pilotReleaseEvidence.records) {
      record.verificationBasis = 'trusted_system_proof';
      if (record.kind === 'field_media_canary') {
        record.provider = 'signed_storage_targets';
      }
      record.source =
        record.kind === 'provider_canary'
          ? record.provider === 'quickbooks_export'
            ? 'deterministic_local_canary'
            : 'external_provider_read_canary'
          : record.kind === 'field_media_canary'
            ? 'authenticated_field_media_roundtrip'
            : 'signed_isolated_restore_drill';
      record.binding = {
        configurationRevision: 4,
        configurationHash: 'a'.repeat(64),
        baselineId: '33333333-3333-4333-8333-333333333333',
        baselineHash: 'b'.repeat(64),
        verificationRunId: record.id,
        capability:
          record.kind === 'backup_restore'
            ? 'isolated_database_restore'
            : record.kind === 'field_media_canary'
              ? 'private_media_roundtrip'
              : record.provider === 'stripe'
                ? 'payments'
                : 'server_signed_targets',
        ...(record.kind === 'backup_restore'
          ? {}
          : {
              integrationProvider:
                record.kind === 'field_media_canary'
                  ? ('signed_storage_targets' as const)
                  : record.provider!,
              integrationVersion: record.provider === 'stripe' ? 3 : 4,
              ...(record.kind === 'field_media_canary'
                ? {
                    visitId: '88888888-8888-4888-8888-888888888888',
                    mediaAssetId: '99999999-9999-4999-8999-999999999999',
                    fieldWorkerRole: 'technician' as const,
                  }
                : {}),
            }),
      };
    }
    const trusted = derivePilotReadiness(state, { now: NOW });
    expect(trusted.verdict).toBe('HOLD_LIVE_PILOT');
    expect(trusted.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'Stripe',
          capability: 'payments',
          canary: 'passed',
          status: 'ready',
        }),
      ]),
    );
    expect(trusted.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'field-media', status: 'ready' }),
        expect.objectContaining({ id: 'backup', status: 'ready' }),
        expect.objectContaining({ id: 'pilot-capability-communications', status: 'blocked' }),
        expect.objectContaining({ id: 'pilot-capability-scheduling', status: 'blocked' }),
        expect.objectContaining({ id: 'launch-authorization', status: 'manual_gate' }),
      ]),
    );

    state.integrations[0]!.lastCheck = '2026-07-29T11:00:00.000Z';
    const staleHealth = derivePilotReadiness(state, { now: NOW });
    expect(staleHealth.verdict).toBe('HOLD_LIVE_PILOT');
    expect(staleHealth.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'Stripe', canary: 'passed', status: 'blocked' }),
      ]),
    );
    state.integrations[0]!.lastCheck = '2026-07-29T12:20:00.000Z';

    const [stripeHealth] = state.integrations.splice(0, 1);
    const missingHealth = derivePilotReadiness(state, { now: NOW });
    expect(missingHealth.verdict).toBe('HOLD_LIVE_PILOT');
    expect(missingHealth.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'stripe',
          mode: 'Live',
          health: 'Needs setup',
          status: 'blocked',
        }),
      ]),
    );
    state.integrations.unshift(stripeHealth!);

    state.pilotReleaseEvidence.records.unshift(
      releaseEvidence({
        id: '70000000-0000-4000-8000-000000000000',
        kind: 'provider_canary',
        provider: 'stripe',
        outcome: 'failed',
        source: 'external_provider_receipt',
        evidenceReference: 'stripe-failed-canary-2026-07-29',
        observedAt: '2026-07-29T11:59:00.000Z',
        expiresAt: '2026-08-05T12:15:00.000Z',
        recordedAt: '2026-07-29T12:16:00.000Z',
      }),
    );
    const failed = derivePilotReadiness(state, { now: NOW });
    expect(failed.verdict).toBe('HOLD_LIVE_PILOT');
    expect(failed.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'Stripe', canary: 'failed', status: 'blocked' }),
      ]),
    );

    state.online = false;
    state.serverVerifiedAt = undefined;
    const offline = derivePilotReadiness(state, { now: NOW });
    expect(offline.verdict).toBe('HOLD_LIVE_PILOT');
    expect(offline.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'workspace-freshness', status: 'blocked' }),
      ]),
    );
  });
});
