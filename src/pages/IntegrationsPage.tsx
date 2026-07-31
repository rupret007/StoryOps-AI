import {
  Bot,
  CalendarDays,
  CheckCircle2,
  CloudSun,
  Database,
  FileSpreadsheet,
  HardDriveUpload,
  HeartPulse,
  Mail,
  MapPinned,
  MessageSquareText,
  RefreshCcw,
  Route,
  Settings2,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';
import { useState } from 'react';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Button, Card, Field, PageHeader } from '@/components/ui/Primitives';
import type { DispatchOriginRetentionProjection } from '@/core/integrations/dispatchOriginRetention';
import type { OutboundWorkerHealthProjection } from '@/core/integrations/outboundWorkerHealth';

const integrationIcons = {
  openai: Bot,
  twilio: MessageSquareText,
  email: Mail,
  stripe: WalletCards,
  calendar: CalendarDays,
  google_calendar: CalendarDays,
  maps: MapPinned,
  nws: CloudSun,
  vroom: Route,
  signed_storage_targets: HardDriveUpload,
  supabase_signed_storage_targets: HardDriveUpload,
  quickbooks: FileSpreadsheet,
  quickbooks_export: FileSpreadsheet,
};

export function DispatchOriginRetentionHealth({
  retention,
}: {
  retention?: DispatchOriginRetentionProjection;
}) {
  return (
    <section
      className="card integration-health-banner"
      role={retention?.p0ReleaseCheck === 'blocked' ? 'alert' : undefined}
    >
      <span className="integration-health-banner__icon">
        <ShieldCheck size={22} />
      </span>
      <div>
        <h2>
          Departure-location retention ·{' '}
          {!retention
            ? 'not checked'
            : retention.p0ReleaseCheck === 'passed'
              ? 'healthy'
              : 'launch blocked'}
        </h2>
        <p>
          {!retention
            ? 'Run Check all providers to verify the five-second purge worker. Launch remains unproven until this P0 check passes.'
            : retention.availability === 'unavailable'
              ? 'The private purge-health RPC is unavailable. No backlog count is assumed, and launch remains blocked.'
              : `Scheduler ${retention.schedulerExecutionVerified ? 'verified' : 'not verified'}; worker ${retention.lastStatus}; ${retention.coordinateStaleCount} expired coordinate rows, ${retention.verifierStaleCount} expired verifier rows, and ${retention.cronHistoryStaleCount} purge-history rows beyond the 24-hour operational window remain. Last scheduled completion ${retention.schedulerLastCompletedAt ?? 'never'}.`}
        </p>
      </div>
      <Badge
        tone={
          !retention ? 'warning' : retention.p0ReleaseCheck === 'passed' ? 'positive' : 'danger'
        }
        dot
      >
        {!retention
          ? 'P0 · verify'
          : retention.p0ReleaseCheck === 'passed'
            ? 'P0 passed'
            : 'P0 blocked'}
      </Badge>
    </section>
  );
}

export function OutboundWorkerHealth({ health }: { health?: OutboundWorkerHealthProjection }) {
  const blocked = health?.status === 'blocked';
  return (
    <section className="card integration-health-banner" role={blocked ? 'alert' : undefined}>
      <span className="integration-health-banner__icon">
        <MessageSquareText size={22} />
      </span>
      <div>
        <h2>
          Private scheduled workers · {!health ? 'not checked' : health.status.replaceAll('_', ' ')}
        </h2>
        <p>
          {!health
            ? 'Run Check all providers to verify four dedicated credentials, release-bound scheduled heartbeats, and durable queue state.'
            : health.workers
                .map((worker) => {
                  if (worker.queue.availability === 'unavailable') {
                    return `${worker.worker.replaceAll('_', ' ')}: ${worker.status}; queue evidence unavailable`;
                  }
                  const oldest =
                    worker.queue.oldestQueuedAgeSeconds === null
                      ? 'no executor backlog'
                      : `oldest ${Math.floor(worker.queue.oldestQueuedAgeSeconds / 60)}m`;
                  const actions =
                    worker.worker === 'transactional_outbound'
                      ? `; ${worker.queue.actionCounts.quoteDelivery} quote / ${worker.queue.actionCounts.onMyWay} on-my-way`
                      : '';
                  const scheduler =
                    worker.activationMode === 'scheduled'
                      ? `; scheduler ${worker.schedulerEvidence}`
                      : '';
                  return `${worker.worker.replaceAll('_', ' ')}: ${worker.activationMode}/${worker.status}${scheduler}; ${worker.queue.backlogCount} backlog, ${worker.queue.dueCount} due, ${worker.queue.submissionUnknownCount} submission unknown, ${oldest}${actions}`;
                })
                .join('. ')}
        </p>
      </div>
      <Badge
        tone={
          !health
            ? 'warning'
            : health.status === 'healthy'
              ? 'positive'
              : health.status === 'degraded'
                ? 'warning'
                : 'danger'
        }
        dot
      >
        {!health ? 'Verify' : health.status}
      </Badge>
    </section>
  );
}

export function IntegrationsPage() {
  const { state, actions, can } = useStoryOps();
  const [pendingCommand, setPendingCommand] = useState<string>();
  const [launchReviewReference, setLaunchReviewReference] = useState('');
  const authority = state.providerLaunch;
  const dispatchRetention = state.dispatchOriginRetention;
  const outboundWorkers = state.outboundWorkers;
  const ownerMayControl =
    state.dataMode === 'supabase' &&
    state.role === 'owner' &&
    state.online &&
    Boolean(state.serverVerifiedAt) &&
    authority?.role === 'owner';
  const healthy = state.integrations.filter(
    (integration) => integration.status === 'Healthy',
  ).length;

  const changeProvider = async (
    provider: NonNullable<typeof authority>['connections'][number]['provider'],
    targetMode: 'disabled' | 'sandbox' | 'live',
  ) => {
    const key = `${provider}:${targetMode}`;
    setPendingCommand(key);
    try {
      await actions.setProviderActivation({ provider, targetMode });
    } finally {
      setPendingCommand(undefined);
    }
  };

  const changeLaunch = async (action: 'authorize' | 'revoke') => {
    setPendingCommand(`launch:${action}`);
    try {
      const receipt = await actions.setCompanyLaunchAuthorization({
        action,
        reviewReference: launchReviewReference,
      });
      if (receipt) setLaunchReviewReference('');
    } finally {
      setPendingCommand(undefined);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Provider health"
        title={
          state.dataMode === 'supabase'
            ? 'Authenticated provider health'
            : 'Start in sandbox; activate real providers intentionally'
        }
        description="Optional provider adapters report mode, capability, last check, and configuration gaps. Core authenticated data-plane readiness is shown separately."
        actions={
          <Button
            variant="secondary"
            disabled={!can('integrations.manage')}
            onClick={actions.checkIntegrations}
            icon={<RefreshCcw size={15} />}
          >
            Check all providers
          </Button>
        }
      />

      <Card className="integration-health-banner">
        <span className="integration-health-banner__icon">
          <HeartPulse size={22} />
        </span>
        <div>
          <h2>
            {healthy} of {state.integrations.length} optional provider checks healthy
          </h2>
          <p>
            {state.dataMode === 'supabase'
              ? 'Run check all providers to invoke the authenticated, secret-safe Edge health boundary. These cards do not certify the required private field-media data plane.'
              : 'Every listed adapter is available for a local sandbox rehearsal. No live message, charge, calendar event, Storage upload, or route request leaves this environment.'}
          </p>
        </div>
        <Badge tone={state.dataMode === 'supabase' ? 'info' : 'accent'} dot>
          {state.dataMode === 'supabase' ? 'Authenticated data' : 'Sandbox safe'}
        </Badge>
      </Card>

      {state.dataMode === 'supabase' && (
        <DispatchOriginRetentionHealth retention={dispatchRetention} />
      )}

      {state.dataMode === 'supabase' && <OutboundWorkerHealth health={outboundWorkers} />}

      <Card className="integration-health-banner">
        <span className="integration-health-banner__icon">
          <HardDriveUpload size={22} />
        </span>
        <div>
          <h2>Core field-media data plane</h2>
          <p>
            {state.dataMode === 'supabase'
              ? 'Required in authenticated mode: private job-media Storage RLS, immutable content-addressed uploads, byte read-back, and the field-media-finalize Edge boundary. Any upload, checksum, or finalizer failure blocks registration and completion.'
              : 'Local-only in sandbox mode: field evidence stays in the sandbox/IndexedDB workflow and makes zero Supabase Storage requests.'}
          </p>
        </div>
        <Badge tone={state.dataMode === 'supabase' ? 'warning' : 'info'} dot>
          {state.dataMode === 'supabase' ? 'Required · verify' : 'No network'}
        </Badge>
      </Card>

      {state.dataMode === 'supabase' && (
        <Card className="section-card" aria-label="Controlled launch authority">
          <div className="section-card__header">
            <div>
              <h2>Controlled-launch authority</h2>
              <p className="section-card__subtitle">
                Immutable event-backed state; configuration checkboxes cannot authorize launch
              </p>
            </div>
            <ShieldCheck size={19} color="#1f6d5e" />
          </div>
          {authority ? (
            <>
              <div className="template-row">
                <span>
                  <strong>{authority.launch.status.replaceAll('_', ' ')}</strong>
                  <small>
                    Version {authority.launch.version} · server {authority.serverTime}
                  </small>
                </span>
                <Badge
                  tone={
                    authority.launch.launchAuthorized
                      ? 'positive'
                      : authority.launch.status === 'invalidated'
                        ? 'danger'
                        : 'warning'
                  }
                  dot
                >
                  {authority.launch.launchAuthorized ? 'Launch authorized' : 'Starts blocked'}
                </Badge>
              </div>
              {authority.launch.reviewReference && (
                <p className="company-control-note">
                  Review {authority.launch.reviewReference} · provider snapshot{' '}
                  {authority.launch.providerSnapshotHash?.slice(0, 12)}… · proof snapshot{' '}
                  {authority.launch.proofSnapshotHash?.slice(0, 12)}…
                </p>
              )}
              <Field
                label="Audited owner review reference"
                htmlFor="launch-review-reference"
                hint="10–120 characters: letters, numbers, period, underscore, or hyphen. This is a reference ID, never a secret or customer payload."
              >
                <input
                  id="launch-review-reference"
                  className="input"
                  autoComplete="off"
                  minLength={10}
                  maxLength={120}
                  value={launchReviewReference}
                  onChange={(event) => setLaunchReviewReference(event.target.value)}
                  disabled={!ownerMayControl || Boolean(pendingCommand)}
                />
              </Field>
              <div className="page-header__actions">
                <Button
                  size="sm"
                  disabled={
                    !ownerMayControl ||
                    Boolean(pendingCommand) ||
                    authority.launch.launchAuthorized ||
                    launchReviewReference.trim().length < 10
                  }
                  loading={pendingCommand === 'launch:authorize'}
                  onClick={() => void changeLaunch('authorize')}
                >
                  Authorize controlled launch
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={
                    !ownerMayControl ||
                    Boolean(pendingCommand) ||
                    !['authorized', 'invalidated'].includes(authority.launch.status) ||
                    launchReviewReference.trim().length < 10
                  }
                  loading={pendingCommand === 'launch:revoke'}
                  onClick={() => void changeLaunch('revoke')}
                >
                  Revoke launch
                </Button>
              </div>
              <p className="company-control-note">
                Authorization succeeds only when the server verifies the exact live configuration,
                active baseline, owner-enabled providers, deployment proofs, reviews, canaries,
                field-media roundtrip, scheduling gate, and restore drill. Every live start rechecks
                those bindings.
              </p>
            </>
          ) : (
            <p className="company-control-note">
              No authoritative provider/launch projection is available. Refresh the owner workspace;
              do not infer launch state from Studio or health cards.
            </p>
          )}
        </Card>
      )}

      {authority && (
        <section className="integration-grid" aria-label="Authoritative provider controls">
          {authority.connections.map((connection) => {
            const Icon =
              integrationIcons[connection.provider as keyof typeof integrationIcons] ?? Settings2;
            const disabled = connection.mode === 'disabled';
            return (
              <Card className="integration-card" key={connection.id}>
                <div className="integration-card__top">
                  <span className="integration-card__icon">
                    <Icon size={18} />
                  </span>
                  <div>
                    <p className="integration-card__name">
                      {connection.provider.replaceAll('_', ' ')}
                    </p>
                    <p className="integration-card__provider">
                      owner {connection.mode} · version {connection.version}
                    </p>
                  </div>
                  <Badge
                    tone={
                      connection.ownerEnabled
                        ? connection.environmentStatus === 'healthy'
                          ? 'positive'
                          : 'danger'
                        : 'neutral'
                    }
                  >
                    {connection.ownerEnabled ? 'Owner enabled' : 'Owner disabled'}
                  </Badge>
                </div>
                <p className="company-control-note">
                  Deployment: {connection.environmentMode} ·{' '}
                  {connection.environmentStatus.replaceAll('_', ' ')}
                  <br />
                  Checked {connection.environmentCheckedAt ?? 'never'} · expires{' '}
                  {connection.environmentExpiresAt ?? 'not available'}
                </p>
                <ul className="capability-list">
                  {connection.environmentCapabilities.length === 0 ? (
                    <li>No deployment capability proof</li>
                  ) : (
                    connection.environmentCapabilities.map((capability) => (
                      <li key={capability}>
                        <CheckCircle2 size={12} /> {capability}
                      </li>
                    ))
                  )}
                </ul>
                <div className="page-header__actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={
                      !ownerMayControl ||
                      Boolean(pendingCommand) ||
                      !connection.canActivateSandbox ||
                      connection.mode === 'sandbox'
                    }
                    loading={pendingCommand === `${connection.provider}:sandbox`}
                    onClick={() => void changeProvider(connection.provider, 'sandbox')}
                  >
                    Enable sandbox
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      !ownerMayControl ||
                      Boolean(pendingCommand) ||
                      !connection.canActivateLive ||
                      connection.mode === 'live'
                    }
                    loading={pendingCommand === `${connection.provider}:live`}
                    onClick={() => void changeProvider(connection.provider, 'live')}
                  >
                    Enable live
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={!ownerMayControl || Boolean(pendingCommand) || disabled}
                    loading={pendingCommand === `${connection.provider}:disabled`}
                    onClick={() => void changeProvider(connection.provider, 'disabled')}
                  >
                    Disable
                  </Button>
                </div>
              </Card>
            );
          })}
        </section>
      )}

      {!authority && (
        <section className="integration-grid" aria-label="Integration health">
          {state.integrations.map((integration) => {
            const Icon =
              integrationIcons[integration.id as keyof typeof integrationIcons] ?? Settings2;
            return (
              <Card className="integration-card" key={integration.id}>
                <div className="integration-card__top">
                  <span className="integration-card__icon">
                    <Icon size={18} />
                  </span>
                  <div>
                    <p className="integration-card__name">{integration.name}</p>
                    <p className="integration-card__provider">{integration.provider}</p>
                  </div>
                  <Badge tone={integration.mode === 'Sandbox' ? 'info' : 'positive'}>
                    {integration.mode}
                  </Badge>
                </div>
                <ul className="capability-list">
                  {integration.capabilities.map((capability) => (
                    <li key={capability}>
                      <CheckCircle2 size={12} /> {capability}
                    </li>
                  ))}
                </ul>
                <div className="integration-card__health">
                  <span>
                    <i className="health-dot" /> {integration.status}
                  </span>
                  <span>Checked {integration.lastCheck}</span>
                </div>
              </Card>
            );
          })}
        </section>
      )}

      <div className="integration-bottom-grid">
        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Webhook boundary</h2>
              <p className="section-card__subtitle">Inbound events fail closed</p>
            </div>
            <Database size={18} color="#1f6d5e" />
          </div>
          <ul className="guardrail-list">
            <li>
              <CheckCircle2 size={14} />
              <span>
                <strong>Signature before parse</strong>
                <small>Raw body, timestamp tolerance, constant-time comparison</small>
              </span>
            </li>
            <li>
              <CheckCircle2 size={14} />
              <span>
                <strong>Unique provider event ID</strong>
                <small>Duplicate events return the prior durable result</small>
              </span>
            </li>
            <li>
              <CheckCircle2 size={14} />
              <span>
                <strong>Retrieve canonical state</strong>
                <small>Payment and delivery truth is verified with the provider</small>
              </span>
            </li>
          </ul>
        </Card>
        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Activation checklist</h2>
              <p className="section-card__subtitle">Per provider, before live mode</p>
            </div>
            <Settings2 size={18} color="#1f6d5e" />
          </div>
          <ol className="activation-list">
            <li>
              <span>1</span> Add server-side credentials to the deployment secret store
            </li>
            <li>
              <span>2</span> Register and verify callback/webhook URLs
            </li>
            <li>
              <span>3</span> Run provider-specific sandbox contract tests
            </li>
            <li>
              <span>4</span> Confirm consent, rate-limit, retry, and incident ownership
            </li>
            <li>
              <span>5</span> Run one owner-approved, low-risk staging canary and retain evidence
            </li>
            <li>
              <span>6</span> Authorize production separately after operational and legal gates
            </li>
          </ol>
        </Card>
      </div>
    </div>
  );
}
