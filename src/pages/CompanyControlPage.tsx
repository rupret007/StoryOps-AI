import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  History,
  LogOut,
  Power,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { Badge, Button, Card, Field } from '@/components/ui/Primitives';
import { useStoryOps } from '@/state/StoryOpsProvider';
import type { CompanyControlState, CompanyOperationalStatus } from '@/state/companyControl';
import type { OfflineMutation } from '@/state/model';
import type { AuthoritativeProvider, ProviderLaunchState } from '@/state/providerLaunch';

export interface CompanyControlPacketDiagnostic {
  key: string;
  kind: 'command' | 'media_upload';
  status: 'queued' | 'syncing' | 'failed';
  createdAt: string;
}

export function buildCompanyControlPacketDiagnostics(
  queue: readonly OfflineMutation[],
): CompanyControlPacketDiagnostic[] {
  return queue.flatMap((packet, index) => {
    if (packet.status === 'synced') return [];
    return [
      {
        key: `packet-${index}-${packet.createdAt}`,
        kind: packet.kind === 'media_upload' || packet.mediaUpload ? 'media_upload' : 'command',
        status: packet.status,
        createdAt: packet.createdAt,
      },
    ];
  });
}

interface CompanyControlViewProps {
  controlState: CompanyControlState;
  recoveryMode: boolean;
  online: boolean;
  serverVerified: boolean;
  lastServerVerifiedAt?: string;
  pendingPackets: readonly CompanyControlPacketDiagnostic[];
  busy: boolean;
  error?: string;
  providerLaunch?: ProviderLaunchState;
  onStatusChange(input: {
    expectedStatus: CompanyOperationalStatus;
    targetStatus: CompanyOperationalStatus;
    reason: string;
  }): Promise<boolean>;
  onReload(): Promise<void>;
  onSignOut(): Promise<void>;
  onDisableProvider?(provider: AuthoritativeProvider): Promise<boolean>;
  onRevokeLaunch?(reviewReference: string): Promise<boolean>;
}

function formatLifecycleTime(value: string, timezone: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(parsed);
}

function RecoveryFrame({ children }: { children: ReactNode }) {
  return (
    <div className="company-control-recovery">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="company-control-recovery__header">
        <div className="portal-brand">
          <span className="brand__mark">
            <Sparkles size={17} aria-hidden="true" />
          </span>
          StoryOps AI
        </div>
        <Badge tone="warning">Owner recovery</Badge>
      </header>
      <main className="company-control-page" id="main-content">
        {children}
      </main>
    </div>
  );
}

export function CompanyControlView({
  controlState,
  recoveryMode,
  online,
  serverVerified,
  lastServerVerifiedAt,
  pendingPackets,
  busy,
  error,
  providerLaunch,
  onStatusChange,
  onReload,
  onSignOut,
  onDisableProvider,
  onRevokeLaunch,
}: CompanyControlViewProps) {
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const [authorityReviewReference, setAuthorityReviewReference] = useState('');
  const [authorityCommand, setAuthorityCommand] = useState<string>();
  const paused = controlState.status === 'paused';
  const expectedStatus: CompanyOperationalStatus = paused ? 'paused' : 'active';
  const targetStatus: CompanyOperationalStatus = paused ? 'active' : 'paused';
  const confirmationPhrase = `${paused ? 'REACTIVATE' : 'PAUSE'} ${controlState.companyName}`;
  const pendingMutationCount = pendingPackets.length;
  const normalizedReason = reason.trim();
  const reasonValid =
    normalizedReason.length >= 10 &&
    normalizedReason.length <= 1000 &&
    ![...normalizedReason].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
  const maySubmit =
    online &&
    serverVerified &&
    !busy &&
    controlState.status !== 'setup' &&
    (paused ? controlState.canReactivate : controlState.canPause) &&
    confirmation === confirmationPhrase &&
    reasonValid;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reasonValid) {
      setValidationError('Explain the operational reason in 10–1,000 printable characters.');
      return;
    }
    if (confirmation !== confirmationPhrase) {
      setValidationError(`Type “${confirmationPhrase}” exactly to continue.`);
      return;
    }
    setValidationError(undefined);
    const changed = await onStatusChange({
      expectedStatus,
      targetStatus,
      reason: normalizedReason,
    });
    if (changed) {
      setReason('');
      setConfirmation('');
    } else {
      setValidationError(
        'The server did not confirm the lifecycle change. Refresh before retrying.',
      );
    }
  };

  const title = paused ? 'Company operations are paused.' : 'Company operational control';
  const page = (
    <>
      <header className="company-control-title">
        <div>
          <p className="eyebrow">Owner-only lifecycle control</p>
          <h1>{title}</h1>
          <p>
            {paused
              ? 'Operational writes, provider starts, automation starts, and field evidence finalization remain blocked. Read-only recovery and lifecycle evidence stay available.'
              : 'Use this kill switch only when work must stop across the company. Pausing is a durable server control, not a browser display setting.'}
          </p>
        </div>
        <Badge tone={paused ? 'danger' : 'positive'} dot>
          {controlState.status}
        </Badge>
      </header>

      <div
        className={`company-control-banner company-control-banner--${paused ? 'paused' : 'active'}`}
        role="status"
        aria-live="polite"
      >
        {paused ? (
          <ShieldAlert size={22} aria-hidden="true" />
        ) : (
          <ShieldCheck size={22} aria-hidden="true" />
        )}
        <div>
          <strong>
            {paused ? 'Operational kill switch engaged' : 'Operational writes enabled'}
          </strong>
          <span>
            {serverVerified ? 'Server verified' : 'Last server control readback'}{' '}
            {formatLifecycleTime(controlState.serverTime, controlState.timezone)} ·{' '}
            {pendingMutationCount} queued device mutation
            {pendingMutationCount === 1 ? '' : 's'}
            {!online ? ' · browser offline' : ''}
          </span>
        </div>
      </div>

      {error && (
        <div className="company-control-error" role="alert">
          <strong>Owner recovery needs attention</strong>
          <span>{error}</span>
        </div>
      )}

      {(paused || recoveryMode) && (
        <section
          className="company-control-diagnostics"
          aria-labelledby="company-control-diagnostics-title"
        >
          <div className="company-control-card-heading">
            <ShieldCheck size={20} aria-hidden="true" />
            <div>
              <h2 id="company-control-diagnostics-title">Recovery diagnostics</h2>
              <p>
                Read-only device and server evidence. Customer content, command payloads, photo
                bytes, and signature data are never shown here.
              </p>
            </div>
          </div>
          <dl>
            <div>
              <dt>Last server-verified time</dt>
              <dd>
                {lastServerVerifiedAt
                  ? formatLifecycleTime(lastServerVerifiedAt, controlState.timezone)
                  : 'Not verified in this browser session'}
              </dd>
            </div>
            <div>
              <dt>Current recovery error</dt>
              <dd>{error ?? 'No recovery error reported'}</dd>
            </div>
          </dl>
          <div className="company-control-packets">
            <h3>Pending offline packets ({pendingMutationCount})</h3>
            <p>
              {paused
                ? 'These packets remain on this device and cannot sync while the company is paused.'
                : 'These packets remain on this device and cannot sync from recovery until the full workspace reloads.'}
            </p>
            {pendingPackets.length === 0 ? (
              <p className="company-control-empty">No pending device packets.</p>
            ) : (
              <ul aria-label="Pending offline packet diagnostics">
                {pendingPackets.map((packet) => (
                  <li key={packet.key}>
                    <strong>
                      {packet.kind === 'media_upload' ? 'Media upload packet' : 'Command packet'}
                    </strong>
                    <Badge
                      tone={
                        packet.status === 'failed'
                          ? 'danger'
                          : packet.status === 'syncing'
                            ? 'info'
                            : 'warning'
                      }
                    >
                      {packet.status}
                    </Badge>
                    <time dateTime={packet.createdAt}>
                      {formatLifecycleTime(packet.createdAt, controlState.timezone)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {(paused || recoveryMode) && providerLaunch && (
        <Card className="company-control-action">
          <div className="company-control-card-heading">
            <ShieldAlert size={20} aria-hidden="true" />
            <div>
              <h2>Provider and launch shutdown controls</h2>
              <p>
                Recovery remains read-only except for owner revocation and provider disable
                commands. Environment switches and provider credentials are never editable here.
              </p>
            </div>
          </div>
          <div className="template-row">
            <span>
              <strong>Controlled launch</strong>
              <small>Authority version {providerLaunch.launch.version}</small>
            </span>
            <Badge tone={providerLaunch.launch.launchAuthorized ? 'danger' : 'neutral'}>
              {providerLaunch.launch.status.replaceAll('_', ' ')}
            </Badge>
          </div>
          {['authorized', 'invalidated'].includes(providerLaunch.launch.status) && (
            <div className="company-control-form">
              <Field
                label="Audited revoke reference"
                htmlFor="recovery-launch-revoke-reference"
                hint="10–120 characters: letters, numbers, period, underscore, or hyphen."
              >
                <input
                  id="recovery-launch-revoke-reference"
                  className="input"
                  autoComplete="off"
                  value={authorityReviewReference}
                  onChange={(event) => setAuthorityReviewReference(event.target.value)}
                />
              </Field>
              <Button
                variant="danger"
                size="sm"
                loading={authorityCommand === 'launch:revoke'}
                disabled={
                  !online ||
                  !serverVerified ||
                  Boolean(authorityCommand) ||
                  authorityReviewReference.trim().length < 10
                }
                onClick={() => {
                  setAuthorityCommand('launch:revoke');
                  void (
                    onRevokeLaunch?.(authorityReviewReference) ?? Promise.resolve(false)
                  ).finally(() => setAuthorityCommand(undefined));
                }}
              >
                Revoke launch authority
              </Button>
            </div>
          )}
          <div className="company-control-packets">
            <h3>Owner-enabled providers</h3>
            {providerLaunch.connections.filter((connection) => connection.ownerEnabled).length ===
            0 ? (
              <p className="company-control-empty">Every provider owner switch is disabled.</p>
            ) : (
              <ul aria-label="Owner-enabled provider shutdown controls">
                {providerLaunch.connections
                  .filter((connection) => connection.ownerEnabled)
                  .map((connection) => (
                    <li key={connection.id}>
                      <strong>{connection.provider.replaceAll('_', ' ')}</strong>
                      <Badge tone="warning">{connection.mode}</Badge>
                      <Button
                        variant="danger"
                        size="sm"
                        loading={authorityCommand === `provider:${connection.provider}`}
                        disabled={!online || !serverVerified || Boolean(authorityCommand)}
                        onClick={() => {
                          setAuthorityCommand(`provider:${connection.provider}`);
                          void (
                            onDisableProvider?.(connection.provider) ?? Promise.resolve(false)
                          ).finally(() => setAuthorityCommand(undefined));
                        }}
                      >
                        Disable
                      </Button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      <div className="company-control-layout">
        <Card className="company-control-action">
          <div className="company-control-card-heading">
            <Power size={20} aria-hidden="true" />
            <div>
              <h2>{paused ? 'Reactivate company operations' : 'Pause company operations'}</h2>
              <p>
                {paused
                  ? 'Reactivate only after the cause of the pause has been reviewed. The full workspace must reload before work resumes.'
                  : 'This blocks new operational mutations company-wide. Existing external provider truth can still reconcile.'}
              </p>
            </div>
          </div>

          {controlState.status === 'setup' ? (
            <p className="company-control-note">
              Operational pause is unavailable until the reviewed setup and operating baseline have
              activated the company.
            </p>
          ) : (
            <form className="company-control-form" onSubmit={(event) => void submit(event)}>
              <Field
                label={paused ? 'Reactivation reason' : 'Pause reason'}
                htmlFor="company-control-reason"
                hint="Stored in the owner-visible lifecycle history and immutable audit evidence."
                error={validationError?.startsWith('Explain') ? validationError : undefined}
              >
                <textarea
                  id="company-control-reason"
                  className="textarea"
                  rows={4}
                  minLength={10}
                  maxLength={1000}
                  required
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setValidationError(undefined);
                  }}
                />
              </Field>
              <Field
                label="Typed confirmation"
                htmlFor="company-control-confirmation"
                hint={`Type “${confirmationPhrase}” exactly.`}
                error={validationError?.startsWith('Type “') ? validationError : undefined}
              >
                <input
                  id="company-control-confirmation"
                  className="input"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  value={confirmation}
                  onChange={(event) => {
                    setConfirmation(event.target.value);
                    setValidationError(undefined);
                  }}
                />
              </Field>
              {!paused && pendingMutationCount > 0 && (
                <p className="company-control-inline-alert" role="alert">
                  {pendingMutationCount} queued field mutation
                  {pendingMutationCount === 1 ? ' is' : 's are'} preserved on this device. Pausing
                  remains available, but those packets cannot sync until an owner reactivates the
                  company.
                </p>
              )}
              {validationError &&
                !validationError.startsWith('Explain') &&
                !validationError.startsWith('Type “') && (
                  <p className="company-control-inline-alert" role="alert">
                    {validationError}
                  </p>
                )}
              <Button
                type="submit"
                variant={paused ? 'primary' : 'danger'}
                loading={busy}
                disabled={!maySubmit}
                icon={busy ? undefined : <Power size={16} aria-hidden="true" />}
              >
                {paused ? 'Reactivate operations' : 'Pause operations'}
              </Button>
            </form>
          )}
        </Card>

        <Card className="company-control-history">
          <div className="company-control-card-heading">
            <History size={20} aria-hidden="true" />
            <div>
              <h2>Lifecycle history</h2>
              <p>Latest 20 owner commands from the server. This view is read-only.</p>
            </div>
          </div>
          {controlState.recentEvents.length === 0 ? (
            <p className="company-control-empty">No pause or reactivation commands recorded.</p>
          ) : (
            <ol aria-label="Company lifecycle history">
              {controlState.recentEvents.map((event) => (
                <li key={event.commandId}>
                  <div>
                    <Badge tone={event.status === 'paused' ? 'danger' : 'positive'}>
                      {event.status}
                    </Badge>
                    <time dateTime={event.changedAt}>
                      {formatLifecycleTime(event.changedAt, controlState.timezone)}
                    </time>
                  </div>
                  <p>{event.reason}</p>
                  <small>
                    {event.changedByCurrentOwner ? 'Changed by you' : 'Changed by another owner'} ·
                    Request {event.requestHash.slice(0, 12)}…
                  </small>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <footer className="company-control-footer">
        <Button
          variant="secondary"
          onClick={() => void onReload()}
          disabled={!online || busy}
          icon={<RefreshCw size={15} aria-hidden="true" />}
        >
          {paused ? 'Refresh recovery state' : 'Reload full workspace'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => void onSignOut()}
          disabled={busy}
          icon={<LogOut size={15} aria-hidden="true" />}
        >
          Sign out
        </Button>
      </footer>
    </>
  );

  return recoveryMode ? <RecoveryFrame>{page}</RecoveryFrame> : page;
}

export function CompanyControlPage() {
  const { state, actions } = useStoryOps();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const controlState = state.companyControlState;
  const pendingPackets = useMemo(
    () => buildCompanyControlPacketDiagnostics(state.offlineQueue),
    [state.offlineQueue],
  );

  if (!controlState || state.dataMode !== 'supabase' || state.role !== 'owner') {
    return (
      <Card className="company-control-unavailable">
        <ShieldAlert size={22} aria-hidden="true" />
        <h1>Company control is unavailable.</h1>
        <p>
          This boundary requires an authenticated owner and a current server control-state readback.
          No company status change is available from local or stale state.
        </p>
        <Button
          variant="secondary"
          onClick={() => void actions.reloadLiveWorkspace()}
          icon={<RefreshCw size={15} aria-hidden="true" />}
        >
          Refresh owner state
        </Button>
      </Card>
    );
  }

  return (
    <CompanyControlView
      key={`${controlState.status}:${controlState.serverTime}`}
      controlState={controlState}
      recoveryMode={Boolean(state.companyControlRecovery)}
      online={state.online}
      serverVerified={Boolean(state.serverVerifiedAt)}
      lastServerVerifiedAt={state.serverVerifiedAt}
      pendingPackets={pendingPackets}
      busy={busy}
      error={error ?? state.liveError}
      providerLaunch={state.providerLaunch}
      onReload={actions.reloadLiveWorkspace}
      onSignOut={actions.signOut}
      onDisableProvider={async (provider) =>
        Boolean(
          await actions.setProviderActivation({
            provider,
            targetMode: 'disabled',
          }),
        )
      }
      onRevokeLaunch={async (reviewReference) =>
        Boolean(
          await actions.setCompanyLaunchAuthorization({
            action: 'revoke',
            reviewReference,
          }),
        )
      }
      onStatusChange={async (input) => {
        setBusy(true);
        setError(undefined);
        try {
          return await actions.setCompanyOperationalStatus(input);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Lifecycle command failed.');
          return false;
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
