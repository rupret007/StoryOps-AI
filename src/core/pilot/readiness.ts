import type { PilotEvidenceKind, PilotReleaseEvidenceRecord } from '@/core/pilot/releaseEvidence';
import { pilotEvidenceProviderSchema } from '@/core/pilot/releaseEvidence';
import { assessCompanyConfiguration } from '@/domain/companyConfiguration';
import {
  assertAllEnabledServicesArePackBound,
  getIndustryPackServiceRequirements,
} from '@/domain/industryPackRequirements';
import type { DemoIntegration, DemoState } from '@/state/model';

export type PilotReadinessStatus = 'ready' | 'blocked' | 'manual_gate' | 'unknown';
export type PilotEvidenceDisposition =
  | 'passed'
  | 'failed'
  | 'expired'
  | 'not_recorded'
  | 'owner_attestation'
  | 'binding_mismatch'
  | 'future_observation'
  | 'not_applicable';

export interface PilotReadinessCheck {
  id: string;
  group: 'configuration' | 'operations' | 'providers' | 'reviews';
  label: string;
  status: PilotReadinessStatus;
  evidence: string;
  href: string;
}

export interface ProviderReadinessRow {
  id: string;
  providerId: string;
  provider: string;
  capability: string;
  mode: DemoIntegration['mode'];
  health: DemoIntegration['status'];
  canary: PilotEvidenceDisposition;
  status: PilotReadinessStatus;
  evidence: string;
}

export interface PilotReadinessProjection {
  verdict: 'SANDBOX_REHEARSAL' | 'HOLD_LIVE_PILOT' | 'READY_FOR_CONTROLLED_PILOT';
  verdictReason: string;
  checks: PilotReadinessCheck[];
  providers: ProviderReadinessRow[];
  readyCount: number;
  totalCount: number;
}

type PilotReadinessState = Pick<
  DemoState,
  | 'dataMode'
  | 'online'
  | 'serverVerifiedAt'
  | 'setupComplete'
  | 'companyConfiguration'
  | 'operatingBaseline'
  | 'providerLaunch'
  | 'outboundWorkers'
  | 'pilotReleaseEvidence'
  | 'integrations'
  | 'live'
>;

type ReadinessOptions = {
  /** A ticking wall-clock value. Production supplies this from the mounted dashboard. */
  now?: string;
};

type NormalizedIntegration = DemoIntegration & {
  capability: string;
};

const WORKSPACE_FRESHNESS_MS = 5 * 60_000;
const CLOCK_SKEW_BUDGET_MS = 2 * 60_000;
const SCHEDULING_COMPONENTS = ['google_calendar', 'maps', 'nws', 'vroom'] as const;

function parseTime(value: string | undefined): number {
  return Date.parse(value ?? '');
}

function timestampIsFresh(value: string | undefined, now: number): boolean {
  const timestamp = parseTime(value);
  return (
    Number.isFinite(timestamp) &&
    timestamp >= now - WORKSPACE_FRESHNESS_MS &&
    timestamp <= now + CLOCK_SKEW_BUDGET_MS
  );
}

function compareEvidence(
  left: PilotReleaseEvidenceRecord,
  right: PilotReleaseEvidenceRecord,
): number {
  const recordedDelta = parseTime(right.recordedAt) - parseTime(left.recordedAt);
  if (recordedDelta !== 0) return recordedDelta;
  if (left.outcome !== right.outcome) return left.outcome === 'failed' ? -1 : 1;
  const observedDelta = parseTime(right.observedAt) - parseTime(left.observedAt);
  if (observedDelta !== 0) return observedDelta;
  return right.id.localeCompare(left.id);
}

function latestEvidence(
  state: PilotReadinessState,
  kind: PilotEvidenceKind,
  provider?: string,
  capability?: string,
): PilotReleaseEvidenceRecord | undefined {
  return state.pilotReleaseEvidence?.records
    .filter((record) => {
      if (record.kind !== kind) return false;
      if (kind === 'provider_canary' && record.provider !== provider) return false;
      if (
        capability &&
        record.verificationBasis === 'trusted_system_proof' &&
        record.binding?.capability !== capability
      ) {
        return false;
      }
      return true;
    })
    .sort(compareEvidence)[0];
}

function canonicalConfigurationProvider(provider: string): string {
  return provider === 'signed_storage_targets' ? 'storage' : provider;
}

function evidenceBindingIsCurrent(
  state: PilotReadinessState,
  record: PilotReleaseEvidenceRecord,
): boolean {
  const binding = record.binding;
  const configuration = state.companyConfiguration;
  const baseline = state.operatingBaseline;
  if (
    record.verificationBasis !== 'trusted_system_proof' ||
    !binding ||
    configuration?.status !== 'published' ||
    configuration.publicationMode !== 'live' ||
    configuration.revision !== binding.configurationRevision ||
    configuration.publicationReceipt?.configurationHash !== binding.configurationHash ||
    baseline?.configurationRevision !== binding.configurationRevision ||
    baseline.configurationHash !== binding.configurationHash ||
    baseline.baselineId !== binding.baselineId ||
    baseline.baselineHash !== binding.baselineHash
  ) {
    return false;
  }
  if (!binding.integrationProvider || !binding.integrationVersion) {
    return record.kind === 'backup_restore' && binding.capability === 'isolated_database_restore';
  }
  const integration = state.integrations.find(
    (candidate) =>
      candidate.provider === binding.integrationProvider &&
      candidate.version === binding.integrationVersion,
  );
  const authoritativeConnection = state.providerLaunch?.connections.find(
    (candidate) => candidate.provider === binding.integrationProvider,
  );
  if (
    !integration ||
    !authoritativeConnection ||
    authoritativeConnection.version !== binding.integrationVersion ||
    !authoritativeConnection.ownerEnabled ||
    authoritativeConnection.mode !== 'live'
  ) {
    return false;
  }
  if (record.kind === 'provider_canary') {
    return (
      record.provider === binding.integrationProvider &&
      integration.capabilities.includes(binding.capability)
    );
  }
  return (
    record.kind === 'field_media_canary' &&
    ['storage', 'signed_storage_targets'].includes(binding.integrationProvider) &&
    binding.capability === 'private_media_roundtrip'
  );
}

function evidenceDisposition(
  state: PilotReadinessState,
  record: PilotReleaseEvidenceRecord | undefined,
  now: number,
): Exclude<PilotEvidenceDisposition, 'not_applicable'> {
  if (!record) return 'not_recorded';
  const observedAt = parseTime(record.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > now) return 'future_observation';
  if (parseTime(record.expiresAt) <= now) return 'expired';
  if (record.outcome === 'failed') return 'failed';
  if (record.verificationBasis !== 'trusted_system_proof') return 'owner_attestation';
  return evidenceBindingIsCurrent(state, record) ? 'passed' : 'binding_mismatch';
}

function evidenceSummary(record: PilotReleaseEvidenceRecord | undefined): string {
  if (!record) return 'No reviewed evidence is recorded.';
  const binding = record.binding
    ? ` · ${record.binding.capability} @ config ${record.binding.configurationRevision}`
    : '';
  return `${record.verificationBasis.replaceAll('_', ' ')} · ${record.source.replaceAll('_', ' ')} · ${record.evidenceReference}${binding} · observed ${record.observedAt} · expires ${record.expiresAt} · artifact ${record.artifactSha256.slice(0, 12)}…`;
}

function integrationHealthIsCurrent(
  integration: DemoIntegration | undefined,
  now: number,
): boolean {
  if (!integration || integration.mode !== 'Live' || integration.status !== 'Healthy') return false;
  const checkedAt = parseTime(integration.lastCheck);
  return (
    Number.isFinite(checkedAt) &&
    checkedAt >= now - 15 * 60_000 &&
    checkedAt <= now + CLOCK_SKEW_BUDGET_MS
  );
}

function dispositionStatus(disposition: PilotEvidenceDisposition): PilotReadinessStatus {
  if (disposition === 'passed' || disposition === 'not_applicable') return 'ready';
  if (
    disposition === 'failed' ||
    disposition === 'owner_attestation' ||
    disposition === 'binding_mismatch' ||
    disposition === 'future_observation'
  ) {
    return 'blocked';
  }
  return 'manual_gate';
}

function normalizeIntegrations(integrations: DemoIntegration[]): NormalizedIntegration[] {
  const normalized = new Map<string, NormalizedIntegration>();
  for (const integration of integrations) {
    const capabilities =
      integration.capabilities.length > 0
        ? [...new Set(integration.capabilities)].sort()
        : ['provider_connection'];
    for (const capability of capabilities) {
      const key = `${integration.provider}:${capability}`;
      const current = normalized.get(key);
      if (!current) {
        normalized.set(key, { ...integration, id: key, capability, capabilities: [capability] });
        continue;
      }
      const statusRank = { Healthy: 0, Degraded: 1, 'Needs setup': 2 } as const;
      const modeRank = { Disabled: 0, Sandbox: 1, Live: 2 } as const;
      const currentCheck = parseTime(current.lastCheck);
      const candidateCheck = parseTime(integration.lastCheck);
      normalized.set(key, {
        ...current,
        mode: modeRank[integration.mode] > modeRank[current.mode] ? integration.mode : current.mode,
        status:
          statusRank[integration.status] > statusRank[current.status]
            ? integration.status
            : current.status,
        lastCheck:
          Number.isFinite(currentCheck) &&
          Number.isFinite(candidateCheck) &&
          candidateCheck < currentCheck
            ? integration.lastCheck
            : current.lastCheck,
        version: current.version === integration.version ? current.version : undefined,
      });
    }
  }
  return [...normalized.values()].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.capability.localeCompare(right.capability),
  );
}

const reviewCheck = (
  id: string,
  label: string,
  review:
    | {
        status: 'required' | 'in_review' | 'approved';
        reviewer: string;
        reviewedAt: string;
        evidenceReference: string;
      }
    | undefined,
): PilotReadinessCheck => ({
  id,
  group: 'reviews',
  label,
  status: review?.status === 'approved' ? 'ready' : 'manual_gate',
  evidence:
    review?.status === 'approved'
      ? `${review.evidenceReference} · ${review.reviewer} · ${review.reviewedAt}`
      : `Qualified review is ${review?.status ?? 'not configured'}; no approval is inferred.`,
  href: '/setup',
});

export function derivePilotReadiness(
  state: PilotReadinessState,
  options: ReadinessOptions = {},
): PilotReadinessProjection {
  const currentTime = options.now === undefined ? Date.now() : parseTime(options.now);
  const now = Number.isFinite(currentTime) ? currentTime : Number.NaN;
  const live = state.dataMode === 'supabase';
  const evidenceSnapshotMatchesWorkspace =
    Boolean(state.live?.companyId) &&
    state.pilotReleaseEvidence?.companyId === state.live?.companyId &&
    timestampIsFresh(state.pilotReleaseEvidence?.serverTime, now);
  const providerAuthorityMatchesWorkspace =
    state.providerLaunch?.companyId === state.live?.companyId &&
    timestampIsFresh(state.providerLaunch?.serverTime, now);
  const workspaceFresh =
    live &&
    state.online &&
    Number.isFinite(now) &&
    timestampIsFresh(state.serverVerifiedAt, now) &&
    timestampIsFresh(state.live?.serverTime, now) &&
    evidenceSnapshotMatchesWorkspace &&
    providerAuthorityMatchesWorkspace;
  const configuration = state.companyConfiguration;
  const publishedConfiguration = configuration?.published;
  const expectedPublicationMode = live ? 'live' : 'sandbox';
  const configurationPublished =
    configuration?.status === 'published' &&
    configuration.publicationMode === expectedPublicationMode &&
    publishedConfiguration !== undefined;
  const configurationAssessment = configuration
    ? assessCompanyConfiguration(configuration.draft, expectedPublicationMode)
    : undefined;
  const baselineCurrent =
    live &&
    configurationPublished &&
    state.operatingBaseline?.configurationRevision === configuration.revision &&
    state.operatingBaseline.configurationHash ===
      configuration.publicationReceipt?.configurationHash;
  const enabledServiceCodes = publishedConfiguration?.pricing.enabledServiceCodes ?? [];
  const operationalRequirements = getIndustryPackServiceRequirements(
    enabledServiceCodes,
    undefined,
    publishedConfiguration?.pricing.priceBookTemplateVersion,
  );
  const requirementsKnown =
    enabledServiceCodes.length > 0 &&
    assertAllEnabledServicesArePackBound(
      enabledServiceCodes,
      undefined,
      publishedConfiguration?.pricing.priceBookTemplateVersion,
    );
  const activeOwners =
    publishedConfiguration?.people.crewMembers.filter(
      (member) => member.active && member.role === 'owner',
    ) ?? [];
  const activeOwnerSkills = new Set(activeOwners[0]?.skills ?? []);
  const ownerCapabilitiesReady =
    activeOwners.length === 1 &&
    operationalRequirements.requiredSkills.every((skill) => activeOwnerSkills.has(skill));
  const equipmentCapabilitiesReady = operationalRequirements.requiredEquipmentTypes.every(
    (equipmentType) =>
      publishedConfiguration?.resources.equipment.some(
        (equipment) =>
          equipment.active &&
          equipment.inspectionStatus === 'current' &&
          equipment.equipmentType === equipmentType,
      ) === true,
  );
  const resourceReady = Boolean(
    publishedConfiguration &&
    requirementsKnown &&
    ownerCapabilitiesReady &&
    publishedConfiguration.resources.vehicles.some((vehicle) => vehicle.active) &&
    equipmentCapabilitiesReady,
  );
  const configuredProviderLive = (provider: string): boolean => {
    const authoritativeProvider = provider === 'storage' ? 'signed_storage_targets' : provider;
    const requestedLive = publishedConfiguration?.integrations.providers.some(
      (candidate) =>
        candidate.provider === (provider === 'signed_storage_targets' ? 'storage' : provider) &&
        candidate.requestedMode === 'live',
    );
    const connection = state.providerLaunch?.connections.find(
      (candidate) => candidate.provider === authoritativeProvider,
    );
    return Boolean(
      requestedLive &&
      connection?.ownerEnabled &&
      connection.mode === 'live' &&
      connection.environmentMode === 'live' &&
      connection.environmentStatus === 'healthy' &&
      connection.environmentExpiresAt &&
      parseTime(connection.environmentExpiresAt) > now,
    );
  };
  const normalizedIntegrations = normalizeIntegrations(state.integrations);
  const storageIntegrations = normalizedIntegrations.filter((integration) =>
    ['storage', 'signed_storage_targets'].includes(integration.provider),
  );
  const storageHealthCurrent = storageIntegrations.some((integration) =>
    integrationHealthIsCurrent(integration, now),
  );
  const storageConfiguredLive = configuredProviderLive('storage');
  const fieldMediaEvidence = latestEvidence(state, 'field_media_canary');
  const fieldMediaDisposition = evidenceDisposition(state, fieldMediaEvidence, now);
  const backupEvidence = latestEvidence(state, 'backup_restore');
  const backupDisposition = evidenceDisposition(state, backupEvidence, now);
  const schedulingConfigured = SCHEDULING_COMPONENTS.every(configuredProviderLive);
  const schedulingAuthority = state.providerLaunch?.schedulingGate;
  const schedulingGate = normalizedIntegrations.find(
    (integration) =>
      integration.provider === 'scheduling_evidence_gate' &&
      integration.capability === 'calendar_weather_route_booking_evidence',
  );
  const schedulingGateCurrent = Boolean(
    schedulingConfigured &&
    schedulingAuthority?.current &&
    schedulingAuthority.mode === 'live' &&
    schedulingAuthority.status === 'healthy' &&
    parseTime(schedulingAuthority.expiresAt) > now,
  );
  const communicationConfigured = ['twilio', 'email'].some(configuredProviderLive);
  const paymentConfigured = configuredProviderLive('stripe');
  const privateWorkers = state.providerLaunch?.privateWorkers ?? state.outboundWorkers;
  const privateWorkersCurrent = Boolean(
    privateWorkers &&
    privateWorkers.companyId === state.live?.companyId &&
    privateWorkers.liveReady &&
    privateWorkers.status === 'healthy' &&
    parseTime(privateWorkers.checkedAt) >= now - WORKSPACE_FRESHNESS_MS &&
    parseTime(privateWorkers.checkedAt) <= now + CLOCK_SKEW_BUDGET_MS &&
    parseTime(privateWorkers.expiresAt) > now,
  );
  const privateWorkerBlockers =
    privateWorkers?.workers.flatMap((worker) =>
      worker.blockers.map((blocker) => `${worker.worker.replaceAll('_', ' ')}: ${blocker}`),
    ) ?? [];
  const launchAuthorized = Boolean(
    state.providerLaunch?.launch.launchAuthorized &&
    state.providerLaunch.launch.status === 'authorized' &&
    state.operatingBaseline?.launchAuthorized &&
    state.operatingBaseline.launchStatus === 'authorized' &&
    state.operatingBaseline.launchVersion === state.providerLaunch.launch.version,
  );

  const checks: PilotReadinessCheck[] = [
    {
      id: 'workspace-freshness',
      group: 'operations',
      label: 'Current online workspace proof',
      status: live ? (workspaceFresh ? 'ready' : 'blocked') : 'ready',
      evidence: live
        ? workspaceFresh
          ? `Workspace, server, and evidence projections were independently refreshed within ${WORKSPACE_FRESHNESS_MS / 60_000} minutes.`
          : 'Readiness fails closed while offline or when any server/evidence snapshot is stale, future-dated, missing, or cross-workspace.'
        : 'Sandbox state is local rehearsal data and cannot authorize a live pilot.',
      href: '/integrations',
    },
    {
      id: 'setup',
      group: 'configuration',
      label: 'Company setup',
      status: state.setupComplete ? 'ready' : 'blocked',
      evidence: state.setupComplete
        ? 'The scoped workspace reports setup complete.'
        : 'Owner onboarding is incomplete.',
      href: '/setup',
    },
    {
      id: 'configuration',
      group: 'configuration',
      label: 'Reviewed company configuration',
      status: configurationPublished
        ? 'ready'
        : configurationAssessment?.publishable
          ? 'manual_gate'
          : 'blocked',
      evidence: configurationPublished
        ? `Immutable ${expectedPublicationMode} revision ${configuration.revision} is visible.`
        : configuration
          ? `Revision ${configuration.revision} is not published; readiness ${configurationAssessment?.score ?? 0}%.`
          : 'No configuration revision is visible.',
      href: '/setup',
    },
    {
      id: 'catalog',
      group: 'configuration',
      label: 'Selected service catalog and deterministic rules',
      status: configurationPublished ? 'ready' : 'blocked',
      evidence: publishedConfiguration
        ? `${publishedConfiguration.pricing.enabledServiceCodes.length} selected service(s), ${publishedConfiguration.pricing.serviceRules.length} configured rule(s), and ${publishedConfiguration.pricing.packages.length} package definition(s) are in the immutable snapshot.`
        : 'No immutable catalog snapshot is available.',
      href: '/setup',
    },
    {
      id: 'operating-baseline',
      group: 'configuration',
      label: 'Active price book, terms, and retention',
      status: live ? (baselineCurrent ? 'ready' : 'blocked') : 'ready',
      evidence: live
        ? baselineCurrent
          ? `Operating baseline ${state.operatingBaseline?.baselineId ?? ''} matches configuration revision ${configuration?.revision ?? 0}.`
          : 'A separate owner operating-baseline publication is required; configuration publication alone is inert.'
        : 'Sandbox price, terms, and retention records are synthetic rehearsal fixtures only.',
      href: '/setup',
    },
    {
      id: 'pilot-capability-communications',
      group: 'providers',
      label: 'Pilot transactional communication channel',
      status: live ? (communicationConfigured ? 'ready' : 'blocked') : 'ready',
      evidence: live
        ? communicationConfigured
          ? 'At least one of Twilio or email is selected for live transactional delivery; its health and exact capability proof remain separately gated below.'
          : 'The V1 pilot requires at least one explicitly selected live transactional channel: Twilio or email.'
        : 'Sandbox communication is local-only.',
      href: '/integrations',
    },
    {
      id: 'pilot-capability-payments',
      group: 'providers',
      label: 'Pilot payment provider',
      status: live ? (paymentConfigured ? 'ready' : 'blocked') : 'ready',
      evidence: live
        ? paymentConfigured
          ? 'Stripe is explicitly selected for the controlled pilot; health and exact capability proof remain separately gated below.'
          : 'The V1 controlled pilot requires Stripe to be explicitly selected live.'
        : 'Sandbox payments never prove external payment state.',
      href: '/integrations',
    },
    {
      id: 'pilot-capability-scheduling',
      group: 'providers',
      label: 'Calendar, map, weather, and route evidence gate',
      status: live ? (workspaceFresh && schedulingGateCurrent ? 'ready' : 'blocked') : 'ready',
      evidence: live
        ? schedulingGateCurrent
          ? 'Google Calendar, maps, NWS, and VROOM are all selected live and the aggregate scheduling evidence gate is currently healthy.'
          : 'The V1 controlled pilot requires all four scheduling components plus a current aggregate scheduling-evidence probe.'
        : 'Sandbox scheduling creates no provider-backed availability, weather, route, or calendar truth.',
      href: '/dispatch',
    },
    {
      id: 'crew-resources',
      group: 'operations',
      label: 'Owner/crew, vehicle, and equipment',
      status: resourceReady ? 'ready' : 'blocked',
      evidence: resourceReady
        ? `Exactly one active owner covers all ${operationalRequirements.requiredSkills.length} enabled-service skill requirement(s), with an active vehicle and active/current coverage for all ${operationalRequirements.requiredEquipmentTypes.length} required equipment type(s).`
        : 'Readiness requires exactly one active owner with every enabled-service skill, an active vehicle, and active/current equipment for every enabled-service equipment type; planning personnel and due/out-of-service equipment do not count.',
      href: '/setup',
    },
    {
      id: 'field-media',
      group: 'operations',
      label: 'Private field/scope media',
      status: live
        ? !workspaceFresh || !storageHealthCurrent || !storageConfiguredLive
          ? 'blocked'
          : dispositionStatus(fieldMediaDisposition)
        : 'ready',
      evidence: live
        ? !workspaceFresh
          ? 'A current online workspace and evidence projection is required.'
          : storageHealthCurrent && storageConfiguredLive
            ? `${evidenceSummary(fieldMediaEvidence)} Proof disposition: ${fieldMediaDisposition.replaceAll('_', ' ')}.`
            : 'Live private storage is not healthy and independently enabled.'
        : 'Offline media and recovery can be rehearsed locally; this is not a storage canary.',
      href: '/field',
    },
    {
      id: 'backup',
      group: 'operations',
      label: 'Backup and restore',
      status: live
        ? !workspaceFresh
          ? 'blocked'
          : dispositionStatus(backupDisposition)
        : 'manual_gate',
      evidence: `A current trusted, config-bound isolated restore proof is ${backupDisposition.replaceAll('_', ' ')}. ${evidenceSummary(backupEvidence)}`,
      href: '/audit',
    },
    {
      id: 'private-workers',
      group: 'operations',
      label: 'Private scheduled workers',
      status: live ? (workspaceFresh && privateWorkersCurrent ? 'ready' : 'blocked') : 'ready',
      evidence: live
        ? !workspaceFresh
          ? 'A current online workspace is required before worker evidence can be trusted.'
          : privateWorkersCurrent
            ? `All four required workers have fresh company/deployment/configuration-bound scheduled heartbeats through ${privateWorkers?.expiresAt ?? ''}; evidence v${privateWorkers?.evidenceVersion ?? 0}, ${privateWorkers?.evidenceHash.slice(0, 12) ?? ''}….`
            : privateWorkerBlockers.length > 0
              ? `Live worker readiness is blocked: ${privateWorkerBlockers.join('; ')}.`
              : 'No fresh four-worker readiness snapshot exists. Empty or inactive worker evidence never authorizes live operation.'
        : privateWorkers?.safeDisabled
          ? 'All private workers are safely disabled for sandbox rehearsal and are explicitly not live-ready.'
          : 'Sandbox rehearsal does not claim a scheduled private-worker heartbeat or live readiness.',
      href: '/integrations',
    },
    {
      id: 'launch-authorization',
      group: 'reviews',
      label: 'Explicit controlled-pilot launch authorization',
      status: live && launchAuthorized ? 'ready' : 'manual_gate',
      evidence:
        live && launchAuthorized
          ? `Immutable launch event version ${state.providerLaunch?.launch.version ?? 0} is effective and matches the baseline projection.`
          : `Configuration, health, canaries, and owner attestations do not authorize launch. Event-backed status is ${state.providerLaunch?.launch.status ?? 'unavailable'} and starts fail closed.`,
      href: '/integrations',
    },
  ];

  checks.push(
    reviewCheck('tax-review', 'Tax review', publishedConfiguration?.pricing.taxReview),
    reviewCheck('legal-review', 'Legal/terms review', publishedConfiguration?.policies.legalReview),
    reviewCheck(
      'privacy-review',
      'Privacy/retention review',
      publishedConfiguration?.policies.privacyReview,
    ),
    reviewCheck(
      'safety-review',
      'Safety/SOP review',
      publishedConfiguration?.policies.safetyReview,
    ),
    reviewCheck(
      'insurance-review',
      'Insurance/vehicle review',
      publishedConfiguration?.policies.insuranceReview,
    ),
    reviewCheck(
      'environmental-review',
      'Environmental/runoff review',
      publishedConfiguration?.policies.environmentalReview,
    ),
  );

  for (const configured of publishedConfiguration?.integrations.providers ?? []) {
    if (
      !normalizedIntegrations.some(
        (integration) =>
          canonicalConfigurationProvider(integration.provider) === configured.provider,
      )
    ) {
      normalizedIntegrations.push({
        id: `${configured.provider}:provider_connection`,
        name: configured.provider.replaceAll('_', ' '),
        provider: configured.provider,
        capability: 'provider_connection',
        mode:
          configured.requestedMode === 'live'
            ? 'Live'
            : configured.requestedMode === 'sandbox'
              ? 'Sandbox'
              : 'Disabled',
        status: 'Needs setup',
        capabilities: ['provider_connection'],
        lastCheck: 'Not checked',
      });
    }
  }

  const componentProviders = normalizedIntegrations
    .filter((integration) => integration.provider !== 'scheduling_evidence_gate')
    .map((integration): ProviderReadinessRow => {
      const recognizedProvider = pilotEvidenceProviderSchema.safeParse(
        integration.provider,
      ).success;
      const canaryEvidence = recognizedProvider
        ? latestEvidence(state, 'provider_canary', integration.provider, integration.capability)
        : undefined;
      const canary = evidenceDisposition(state, canaryEvidence, now);
      const healthCurrent = integrationHealthIsCurrent(integration, now);
      const dualEnabled = configuredProviderLive(
        canonicalConfigurationProvider(integration.provider),
      );
      const status =
        integration.mode === 'Disabled'
          ? 'unknown'
          : integration.mode !== 'Live'
            ? 'manual_gate'
            : !workspaceFresh || !healthCurrent || !dualEnabled
              ? 'blocked'
              : dispositionStatus(canary);
      return {
        id: integration.id,
        providerId: integration.provider,
        provider: integration.name,
        capability: integration.capability,
        mode: integration.mode,
        health: integration.status,
        canary,
        status,
        evidence:
          integration.mode === 'Disabled'
            ? 'Disabled; no provider capability is claimed.'
            : integration.mode !== 'Live'
              ? `${integration.mode} mode is not live-provider evidence.`
              : !workspaceFresh
                ? 'The online workspace or server/evidence snapshot is stale.'
                : !healthCurrent
                  ? `Live connection health is ${integration.status.toLowerCase()} but its check is missing or older than 15 minutes.`
                  : !dualEnabled
                    ? 'Published live intent does not match the current deployment proof and owner activation authority.'
                    : `${evidenceSummary(canaryEvidence)} Canary disposition: ${canary.replaceAll('_', ' ')}.`,
      };
    });

  const schedulingGateMode = schedulingGate?.mode ?? (schedulingConfigured ? 'Live' : 'Disabled');
  const schedulingComponentsReady = SCHEDULING_COMPONENTS.every((provider) =>
    componentProviders.some(
      (row) =>
        canonicalConfigurationProvider(row.providerId) === provider && row.status === 'ready',
    ),
  );
  const schedulingGateStatus: PilotReadinessStatus =
    schedulingGateMode === 'Disabled'
      ? 'unknown'
      : schedulingGateMode !== 'Live'
        ? 'manual_gate'
        : !workspaceFresh || !schedulingGateCurrent
          ? 'blocked'
          : schedulingComponentsReady
            ? 'ready'
            : 'manual_gate';
  const providers: ProviderReadinessRow[] = [
    ...componentProviders,
    {
      id: 'scheduling_evidence_gate:calendar_weather_route_booking_evidence',
      providerId: 'scheduling_evidence_gate',
      provider: 'scheduling evidence gate',
      capability: 'calendar_weather_route_booking_evidence',
      mode: schedulingGateMode,
      health: schedulingGate?.status ?? 'Needs setup',
      canary: 'not_applicable',
      status: schedulingGateStatus,
      evidence:
        schedulingGateMode === 'Disabled'
          ? 'Disabled; the aggregate scheduling capability is not claimed.'
          : !schedulingGateCurrent
            ? 'The current aggregate calendar/map/weather/route probe is missing or unhealthy.'
            : schedulingComponentsReady
              ? 'Every scheduling component has current health and trusted capability-bound proof.'
              : 'The aggregate probe is healthy, but one or more component proofs remain open.',
    },
  ];

  const criticalBlocked = checks.some((check) => check.status === 'blocked');
  const manualGates = checks.some((check) => check.status === 'manual_gate');
  const gatedProviders = providers.filter((provider) => provider.mode !== 'Disabled');
  const providerBlocked = gatedProviders.some((provider) => provider.status === 'blocked');
  const providerManualGates = gatedProviders.some((provider) => provider.status === 'manual_gate');
  const verdict = !live
    ? 'SANDBOX_REHEARSAL'
    : criticalBlocked || manualGates || providerBlocked || providerManualGates
      ? 'HOLD_LIVE_PILOT'
      : 'READY_FOR_CONTROLLED_PILOT';
  return {
    verdict,
    verdictReason:
      verdict === 'SANDBOX_REHEARSAL'
        ? 'Local rehearsal is available; it proves no provider, legal, safety, payment, route, or weather state.'
        : verdict === 'HOLD_LIVE_PILOT'
          ? 'One or more deterministic, trusted-system, freshness, capability, or human release gates remain open. Do not contact a pilot customer.'
          : 'Every selected capability has current config-bound system proof and the authoritative operating baseline explicitly authorizes the controlled pilot.',
    checks,
    providers,
    readyCount:
      checks.filter((check) => check.status === 'ready').length +
      gatedProviders.filter((provider) => provider.status === 'ready').length,
    totalCount: checks.length + gatedProviders.length,
  };
}
