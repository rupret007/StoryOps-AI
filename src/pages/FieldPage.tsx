import {
  AlertOctagon,
  Camera,
  Check,
  CheckCircle2,
  ClipboardCheck,
  CloudOff,
  Droplets,
  Download,
  FileSignature,
  MapPin,
  Navigation,
  PackageCheck,
  Pause,
  Play,
  Route,
  ShieldAlert,
  UploadCloud,
  Wind,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Button, Card, PageHeader, Progress } from '@/components/ui/Primitives';
import { captureConsentedDispatchOrigin } from '@/core/scheduling/dispatchOrigin';
import { hasDurableIncidentStopLock } from '@/state/incidentStopQueue';
import { unresolvedIncidentForVisit } from '@/state/incidentScope';
import { selectIncidentEvidenceReplayQueue } from '@/state/offlineFieldQueue';

function openCachedPdf(blob: Blob, productName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `${productName.replaceAll(/[^a-z0-9]+/giu, '-').replaceAll(/^-|-$/gu, '') || 'sds'}.pdf`;
  link.rel = 'noopener';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

export function FieldPage() {
  const { state, actions, can } = useStoryOps();
  const visit = state.visits.find((candidate) => candidate.id === state.selectedVisitId);
  const [clock, setClock] = useState(() => Date.now());
  const [visitForms, setVisitForms] = useState<
    Record<
      string,
      {
        notes?: string;
        signerName?: string;
        materialId?: string;
        materialQuantity?: string;
      }
    >
  >({});
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [incidentKind, setIncidentKind] = useState<
    'near_miss' | 'property_damage' | 'injury_or_exposure'
  >('near_miss');
  const [incidentSummary, setIncidentSummary] = useState('');
  const [incidentSeverity, setIncidentSeverity] = useState<
    'near_miss' | 'minor' | 'serious' | 'critical'
  >('near_miss');
  const [incidentActions, setIncidentActions] = useState('');
  const [incidentClosureNote, setIncidentClosureNote] = useState('');
  const [incidentPending, setIncidentPending] = useState(false);
  const [incidentEvidenceKind, setIncidentEvidenceKind] = useState<
    'incident' | 'safety' | 'damage'
  >('incident');
  const [sdsPending, setSdsPending] = useState(false);
  const [changeReason, setChangeReason] = useState<
    'scope_mismatch' | 'access_blocked' | 'customer_request' | 'site_condition' | 'other'
  >('scope_mismatch');
  const [changeSummary, setChangeSummary] = useState('');
  const [changePending, setChangePending] = useState(false);
  const [publicationPending, setPublicationPending] = useState(false);
  const [dispatchPending, setDispatchPending] = useState(false);
  const [dispatchLocationError, setDispatchLocationError] = useState('');
  const [onMyWayChannel, setOnMyWayChannel] = useState<'sms' | 'email'>('sms');
  const beforeInput = useRef<HTMLInputElement>(null);
  const afterInput = useRef<HTMLInputElement>(null);
  const incidentEvidenceInput = useRef<HTMLInputElement>(null);
  const visitForm = visit ? visitForms[visit.id] : undefined;
  const notes = visitForm?.notes ?? visit?.notes ?? '';
  const signerName = visitForm?.signerName ?? '';
  const materialId = visitForm?.materialId ?? '';
  const materialQuantity = visitForm?.materialQuantity ?? '';
  const updateVisitForm = (patch: Partial<NonNullable<(typeof visitForms)[string]>>) => {
    if (!visit) return;
    setVisitForms((current) => ({
      ...current,
      [visit.id]: { ...current[visit.id], ...patch },
    }));
  };

  useEffect(() => {
    if (visit?.status !== 'on_site') return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visit?.status, visit?.timerStartedAt]);

  useEffect(() => {
    if (!incidentOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIncidentOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [incidentOpen]);

  if (!visit) {
    return (
      <div className="page">
        <PageHeader
          eyebrow="Mobile field mode"
          title="No assigned visit"
          description={
            state.dataMode === 'supabase'
              ? 'The authenticated role projection contains no visit available for field work.'
              : 'There is no visit in the sandbox workspace.'
          }
          actions={
            state.dataMode === 'supabase' ? (
              <Button variant="secondary" onClick={() => void actions.reloadLiveWorkspace()}>
                Refresh workspace
              </Button>
            ) : undefined
          }
        />
        <Card className="section-card">
          <div className="incident-empty">
            <ClipboardCheck size={24} />
            <div>
              <h2>Nothing assigned</h2>
              <p>
                A technician sees only assigned work. Owners and dispatchers see visits returned by
                the company workspace projection.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }
  const completeCount = visit.checklist.filter((item) => item.complete).length;
  const totalCount = visit.checklist.length;
  const fieldAllowed = can('field.execute') || state.role === 'owner';
  const liveVisitReference = state.live?.fieldVisitReferences?.[visit.id];
  const incidentVisitScope = {
    visitId: visit.id,
    jobId:
      liveVisitReference?.jobId ??
      (state.live?.visit?.id === visit.id ? state.live.jobId : undefined),
    propertyId:
      liveVisitReference?.propertyId ??
      (state.live?.visit?.id === visit.id ? state.live.propertyId : undefined),
  };
  const activeIncident = unresolvedIncidentForVisit(state.incidents, incidentVisitScope);
  const incidentStopPending = hasDurableIncidentStopLock(state.offlineQueue, visit.id);
  const stopWorkPending = Boolean(activeIncident) || incidentStopPending;
  const workActive = visit.status === 'on_site' || visit.status === 'paused';
  const canCapture = fieldAllowed && workActive && !stopWorkPending;
  const canStartRoute =
    !stopWorkPending &&
    (state.dataMode === 'sandbox' ||
      (state.online &&
        Boolean(state.serverVerifiedAt) &&
        state.live?.visitStatus === 'confirmed' &&
        state.live.visit?.id === visit.id));
  const selectedMaterial = state.live?.materials.find((item) => item.id === materialId);
  const selectedSds = selectedMaterial?.sdsDocument;
  const selectedSdsAvailable =
    selectedSds?.offlineStatus === 'available' && selectedSds.cachedFile instanceof Blob;
  const hasRouteEvidence = Boolean(visit.route.provider && visit.route.checkedAt);
  const hasWeatherEvidence = Boolean(visit.weather.provider && visit.weather.checkedAt);
  const changeRequestAllowed =
    fieldAllowed &&
    !stopWorkPending &&
    (state.dataMode === 'sandbox' ||
      ['confirmed', 'en_route', 'on_site', 'paused'].includes(state.live?.visitStatus ?? ''));
  const replayableIncidentEvidence = activeIncident
    ? selectIncidentEvidenceReplayQueue(
        state.offlineQueue,
        visit.id,
        new Set(
          state.incidents
            .filter(
              (incident) =>
                incident.status !== 'closed' &&
                unresolvedIncidentForVisit([incident], incidentVisitScope),
            )
            .map((incident) => incident.id),
        ),
      )
    : [];
  const canSyncOffline =
    fieldAllowed &&
    (!stopWorkPending || incidentStopPending || replayableIncidentEvidence.length > 0);
  const unpublishedCompletedEvidence = (visit.fieldEvidence ?? []).filter(
    (evidence) => evidence.syncState === 'synced' && !evidence.customerVisible,
  );
  const publishedCompletedEvidence = (visit.fieldEvidence ?? []).filter(
    (evidence) => evidence.syncState === 'synced' && evidence.customerVisible,
  );
  const completionPending = state.offlineQueue.some(
    (mutation) =>
      mutation.command?.commandType === 'visit.transition' &&
      mutation.scopeVisitId === visit.id &&
      mutation.command.payload.status === 'completed',
  );
  const failedOfflineChanges = state.offlineQueue.filter(
    (mutation) => mutation.status === 'failed',
  ).length;
  const runningSeconds =
    visit.status === 'on_site' && visit.timerStartedAt
      ? Math.max(0, Math.floor((clock - Date.parse(visit.timerStartedAt)) / 1000))
      : 0;
  const elapsedSeconds = (visit.elapsedSeconds ?? visit.elapsedMinutes * 60) + runningSeconds;
  const formattedElapsed = [
    Math.floor(elapsedSeconds / 3600),
    Math.floor((elapsedSeconds % 3600) / 60),
    elapsedSeconds % 60,
  ]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
  const startRoute = async () => {
    if (state.dataMode === 'sandbox') {
      actions.updateVisitStatus('en_route');
      return;
    }
    setDispatchPending(true);
    setDispatchLocationError('');
    try {
      const currentOrigin = await captureConsentedDispatchOrigin();
      await actions.startRouteWithDispatchClearance(currentOrigin);
    } catch (error) {
      setDispatchLocationError(
        error instanceof Error
          ? error.message
          : 'A current accurate device location is required before departure.',
      );
    } finally {
      setDispatchPending(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Mobile field mode"
        title="Selected field visit"
        description={
          state.dataMode === 'supabase'
            ? 'The role-scoped packet is cached locally. Supported offline commands retain their original UUID, request hash, and expected version.'
            : 'The working packet is cached on this device. Every offline mutation has an idempotency key and visible sync state.'
        }
        actions={
          <>
            <Badge
              tone={
                state.dataMode === 'supabase' &&
                state.online &&
                Boolean(state.serverVerifiedAt) &&
                state.offlineQueue.length === 0
                  ? 'positive'
                  : 'warning'
              }
              dot
            >
              {state.dataMode === 'sandbox'
                ? state.online
                  ? `Local sandbox · ${state.offlineQueue.length} queued`
                  : `Browser offline · ${state.offlineQueue.length} queued`
                : !state.online
                  ? `Browser offline · ${state.offlineQueue.length} queued`
                  : !state.serverVerifiedAt
                    ? `Network available · refresh required · ${state.offlineQueue.length} queued`
                    : state.offlineQueue.length === 0
                      ? 'Server verified · 0 queued'
                      : `Server verified · ${state.offlineQueue.length} pending · ${failedOfflineChanges} failed`}
            </Badge>
            {!state.online && state.dataMode === 'sandbox' && (
              <Button variant="secondary" size="sm" onClick={() => actions.setOnline(true)}>
                Simulate reconnect
              </Button>
            )}
          </>
        }
      />

      <div className="field-app">
        {state.visits.length > 1 && (
          <Card className="section-card field-section">
            <label className="input-group" htmlFor="field-visit-selection">
              <span>Role-visible field visit</span>
              <select
                id="field-visit-selection"
                className="input"
                value={visit.id}
                onChange={(event) => void actions.selectVisit(event.target.value)}
              >
                {state.visits.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.date} · {candidate.jobNumber} · {candidate.customerName} ·{' '}
                    {candidate.status.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
              <small>
                The selection is stored inside this user-and-company device scope. Changing it
                atomically swaps one exact cached visit/job/property packet offline or reloads it
                from the role-scoped server projection online before field actions are enabled.
              </small>
            </label>
          </Card>
        )}

        <Card className="field-hero">
          <div className="field-hero__map" aria-label="Stylized route map">
            <div className="field-hero__route" />
            <span className="field-hero__pin">
              <MapPin size={13} />
            </span>
          </div>
          <div className="field-hero__body">
            <Badge tone="accent">{visit.jobNumber}</Badge>
            <h2>{visit.customerName}</h2>
            <p>{visit.address}</p>
            <div className="field-stats">
              <div className="field-stat">
                <span className="field-stat__label">Service</span>
                <span className="field-stat__value">{visit.service}</span>
              </div>
              <div className="field-stat">
                <span className="field-stat__label">Window</span>
                <span className="field-stat__value">
                  {visit.startsAt}–{visit.endsAt.replace(' PM', '')}
                </span>
              </div>
              <div className="field-stat">
                <span className="field-stat__label">Drive</span>
                <span className="field-stat__value">
                  {visit.route.driveMinutes === undefined
                    ? 'Unknown'
                    : `${visit.route.driveMinutes} min`}
                </span>
              </div>
            </div>
          </div>
        </Card>

        {state.dataMode === 'supabase' && (
          <Card className="section-card field-section field-packet-card">
            <div className="section-card__header">
              <div>
                <h2>Accepted scope, exclusions & access</h2>
                <p className="section-card__subtitle">
                  Read-only job packet facts. Submit a change request before doing work that is not
                  listed.
                </p>
              </div>
              <ClipboardCheck size={18} color="#1f6d5e" />
            </div>
            {(visit.scopeLines ?? []).length > 0 ? (
              <ol className="field-scope-list" aria-label="Accepted estimate scope">
                {visit.scopeLines?.map((line) => (
                  <li key={line.id}>
                    <strong>{line.description}</strong>
                    <span>
                      {line.quantity} {line.unit}
                      {line.lineKind === 'add_on' ? ' · add-on' : ''}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="field-safety-warning" role="status">
                Accepted estimate lines are unknown. Stop and ask the office to refresh the
                versioned job packet before starting scope-dependent work.
              </p>
            )}
            <div className="field-packet-grid">
              <div>
                <strong>Exclusions</strong>
                {visit.exclusionsStatus === 'recorded' && (visit.exclusions ?? []).length > 0 ? (
                  <ul>
                    {visit.exclusions?.map((exclusion) => (
                      <li key={exclusion}>{exclusion}</li>
                    ))}
                  </ul>
                ) : (
                  <small>
                    Not recorded in the accepted estimate snapshot. Do not infer that additional
                    work is included.
                  </small>
                )}
              </div>
              <div>
                <strong>Access instructions</strong>
                <small>{visit.access?.instructions ?? 'Not recorded'}</small>
              </div>
              <div>
                <strong>Water source</strong>
                <small>{visit.access?.waterSourceNotes ?? 'Not recorded'}</small>
              </div>
              <div>
                <strong>Drainage</strong>
                <small>{visit.access?.drainageNotes ?? 'Not recorded'}</small>
              </div>
              <div>
                <strong>Known hazards</strong>
                {(visit.access?.knownHazards ?? []).length > 0 ? (
                  <ul>
                    {visit.access?.knownHazards.map((hazard) => (
                      <li key={hazard}>{hazard}</li>
                    ))}
                  </ul>
                ) : (
                  <small>Not recorded; this is not a statement that no hazards exist.</small>
                )}
              </div>
            </div>
          </Card>
        )}

        {state.dataMode === 'sandbox' ? (
          <Card className="field-condition-card">
            <div className="field-condition">
              <span className="field-condition__icon">
                <Droplets size={17} />
              </span>
              <div>
                <strong>
                  {visit.weather.temperature}°F · {visit.weather.precipitation}% rain
                </strong>
                <small>Synthetic fixture · not NWS or provider evidence</small>
              </div>
            </div>
            <div className="field-condition">
              <span className="field-condition__icon">
                <Wind size={17} />
              </span>
              <div>
                <strong>{visit.weather.windMph} mph wind</strong>
                <small>Scenario value · not operational clearance</small>
              </div>
            </div>
            <div className="field-condition">
              <span className="field-condition__icon">
                <Route size={17} />
              </span>
              <div>
                <strong>{visit.route.miles} miles · synthetic route</strong>
                <small>Not provider-confirmed · demo timestamp {visit.route.checkedAt}</small>
              </div>
            </div>
          </Card>
        ) : hasRouteEvidence || hasWeatherEvidence ? (
          <Card className="field-condition-card" aria-label="Provider route and weather evidence">
            <div className="field-condition">
              <span className="field-condition__icon">
                <Route size={17} />
              </span>
              <div>
                <strong>
                  {hasRouteEvidence
                    ? `${visit.route.miles === undefined ? 'Distance unknown' : `${visit.route.miles} miles`} · ${
                        visit.route.driveMinutes === undefined
                          ? 'duration unknown'
                          : `${visit.route.driveMinutes} min`
                      }`
                    : 'Route evidence unavailable'}
                </strong>
                <small>
                  {hasRouteEvidence
                    ? `${visit.route.provider?.toUpperCase()} · ${visit.route.evidenceMode} evidence · ${visit.route.freshness} · checked ${visit.route.checkedAt} · ${
                        visit.route.feasible === true
                          ? 'provider marked feasible'
                          : visit.route.feasible === false
                            ? 'provider marked infeasible'
                            : 'feasibility unknown'
                      }`
                    : 'No route provider record is linked to this visit.'}
                </small>
                {(visit.route.violations ?? []).length > 0 && (
                  <small className="field-safety-warning">
                    Route flags: {visit.route.violations?.join('; ')}
                  </small>
                )}
              </div>
            </div>
            <div className="field-condition">
              <span className="field-condition__icon">
                <Droplets size={17} />
              </span>
              <div>
                <strong>
                  {hasWeatherEvidence
                    ? `${
                        visit.weather.temperature === undefined
                          ? 'Temperature unknown'
                          : `${visit.weather.temperature}°F`
                      } · ${
                        visit.weather.precipitation === undefined
                          ? 'rain probability unknown'
                          : `${visit.weather.precipitation}% rain`
                      }`
                    : 'Weather evidence unavailable'}
                </strong>
                <small>
                  {hasWeatherEvidence
                    ? `${visit.weather.provider?.toUpperCase()} · ${visit.weather.evidenceMode} evidence · ${visit.weather.freshness} · ${visit.weather.policyDisposition} · checked ${visit.weather.checkedAt}`
                    : 'No weather provider record is linked to this visit.'}
                </small>
              </div>
            </div>
            <div className="field-condition">
              <span className="field-condition__icon">
                <Wind size={17} />
              </span>
              <div>
                <strong>
                  {visit.weather.windMph === undefined
                    ? 'Wind unknown'
                    : `${visit.weather.windMph} mph wind`}
                </strong>
                <small>
                  Lightning: {visit.weather.lightningRisk ?? 'unknown'}
                  {(visit.weather.conditionCodes ?? []).length > 0
                    ? ` · ${visit.weather.conditionCodes?.join(', ')}`
                    : ' · condition codes not recorded'}
                </small>
              </div>
            </div>
            {(visit.route.freshness === 'stale' ||
              visit.weather.freshness === 'stale' ||
              visit.route.evidenceMode === 'sandbox' ||
              visit.weather.evidenceMode === 'sandbox') && (
              <p className="field-safety-warning">
                Stale or sandbox evidence is not operational clearance. Refresh the approved
                dispatch/weather workflow before relying on it.
              </p>
            )}
          </Card>
        ) : (
          <Card className="projection-warning">
            <ShieldAlert size={18} />
            <div>
              <strong>Weather and route evidence are unknown</strong>
              <p>
                WashOps will not claim safe conditions or route feasibility. Verify the approved
                dispatch/weather workflow before starting work.
              </p>
            </div>
          </Card>
        )}

        {visit.status === 'ready' && (
          <Card className="arrival-card">
            <Navigation size={21} />
            <div>
              <h2>{state.dataMode === 'sandbox' ? 'Sandbox route scenario' : 'Ready to leave'}</h2>
              <p>
                {state.dataMode === 'sandbox'
                  ? 'Demonstrates a state transition only. Verify live equipment, route, and weather before leaving.'
                  : 'By choosing the departure action, you consent to share this device’s current location for this departure check. WashOps makes the exact latitude/longitude available to the private dispatch workflow in unlogged database storage, deletes it after successful use, or marks it expired after two minutes for the five-second cleanup worker; operations stop if that worker is unhealthy. The durable receipt keeps accuracy, observation time, reading/source and consent metadata, and an opaque binding—but not latitude/longitude or a reusable verifier. Unlogged storage avoids WAL/PITR replication and is cleared by a database crash, but it is not a cryptographic-erasure guarantee for local database pages or host snapshots. The route provider receives the coordinate. Legal and provider-retention review is required before live use.'}
              </p>
              {dispatchLocationError && (
                <p role="alert" className="field-safety-warning">
                  {dispatchLocationError}
                </p>
              )}
              {state.dataMode === 'supabase' && !canStartRoute && (
                <p role="alert">
                  Departure is blocked until this selected visit has a current online server
                  context. En-route intent cannot be queued offline.
                </p>
              )}
            </div>
            <Button
              disabled={!fieldAllowed || !canStartRoute || dispatchPending}
              title={
                !canStartRoute
                  ? 'A current online server session and confirmed selected visit are required. Departure cannot be queued offline.'
                  : undefined
              }
              onClick={() => void startRoute()}
            >
              {dispatchPending
                ? 'Locating + checking…'
                : canStartRoute
                  ? state.dataMode === 'sandbox'
                    ? 'Start demo route'
                    : 'Share location & start'
                  : 'Confirmation required'}
            </Button>
          </Card>
        )}
        {visit.status === 'en_route' && (
          <Card className="arrival-card arrival-card--accent">
            <Navigation size={21} />
            <div>
              <h2>
                {state.dataMode === 'sandbox'
                  ? 'Demo route in progress · scenario ETA 10:27 AM'
                  : 'En route'}
              </h2>
              <p>
                {state.dataMode === 'sandbox'
                  ? 'A synthetic notification receipt was recorded; no customer was contacted.'
                  : state.live?.onMyWayDelivery
                    ? `${state.live.onMyWayDelivery.channel.toUpperCase()} · ${state.live.onMyWayDelivery.status.replaceAll('_', ' ')}${state.live.onMyWayDelivery.externalDeliveryClaimed ? ' · verified delivered' : ' · delivery not asserted'}`
                    : 'No on-my-way provider attempt is recorded. Queueing and verified delivery remain separate.'}
              </p>
              {state.live?.onMyWayDelivery?.manualReconciliationRequired && (
                <p role="alert">
                  Provider submission is ambiguous. The office must reconcile the exact provider
                  message before another attempt.
                </p>
              )}
              {state.dataMode === 'supabase' && (
                <div className="toolbar-group">
                  <label className="input-group" htmlFor="on-my-way-channel">
                    <span>Customer channel</span>
                    <select
                      id="on-my-way-channel"
                      className="select"
                      value={onMyWayChannel}
                      onChange={(event) => setOnMyWayChannel(event.target.value as 'sms' | 'email')}
                    >
                      <option value="sms">SMS</option>
                      <option value="email">Email</option>
                    </select>
                  </label>
                  <Button
                    variant="secondary"
                    disabled={
                      stopWorkPending ||
                      !can('communications.send') ||
                      (state.live?.onMyWayDelivery !== undefined &&
                        !['failed', 'cancelled'].includes(state.live.onMyWayDelivery.status))
                    }
                    onClick={() =>
                      void actions.queueTransactionalDelivery({
                        action: 'visit.on_my_way',
                        channel: onMyWayChannel,
                      })
                    }
                  >
                    {state.live?.onMyWayDelivery
                      ? 'On-my-way attempt recorded'
                      : 'Queue on-my-way message'}
                  </Button>
                </div>
              )}
            </div>
            <Button
              disabled={!fieldAllowed || stopWorkPending}
              onClick={() => actions.updateVisitStatus('on_site')}
            >
              Arrived
            </Button>
          </Card>
        )}
        {(visit.status === 'on_site' || visit.status === 'paused') && (
          <Card className="timer-card">
            <div className="timer-card__status">
              <span className="pulse-dot" />
              <div>
                <strong>
                  {visit.status === 'paused' ? 'Timer paused' : 'On-site timer running'}
                </strong>
                <small>Started {visit.timerStartedAt ? '10:28 AM' : '—'}</small>
              </div>
            </div>
            <strong className="timer-card__time" aria-label={`Elapsed time ${formattedElapsed}`}>
              {formattedElapsed}
            </strong>
            <Button
              variant="secondary"
              size="sm"
              disabled={!fieldAllowed || (visit.status === 'paused' && stopWorkPending)}
              onClick={() =>
                actions.updateVisitStatus(visit.status === 'paused' ? 'on_site' : 'paused')
              }
              icon={visit.status === 'paused' ? <Play size={14} /> : <Pause size={14} />}
            >
              {visit.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
          </Card>
        )}

        <Card className="section-card field-section">
          <div className="section-card__header">
            <div>
              <h2>Job checklist</h2>
              <p className="section-card__subtitle">
                {state.dataMode === 'supabase'
                  ? `${completeCount} of ${totalCount} projected records complete · the server enforces template requirements`
                  : `${completeCount} of ${totalCount} complete · safety-critical items cannot be skipped`}
              </p>
            </div>
            <Badge tone={completeCount === totalCount ? 'positive' : 'neutral'}>
              {Math.round((completeCount / Math.max(totalCount, 1)) * 100)}%
            </Badge>
          </div>
          <Progress
            value={completeCount}
            max={totalCount}
            label="Job checklist completion"
            tone="lime"
          />
          <div className="checklist">
            {visit.checklist.map((item) => (
              <div
                className={`checklist-item ${item.complete ? 'checklist-item--complete' : ''}`}
                key={item.id}
              >
                <button
                  type="button"
                  className="checklist-item__check"
                  aria-label={`${item.complete ? 'Reopen' : 'Complete'} ${item.label}`}
                  aria-pressed={item.complete}
                  disabled={!canCapture}
                  onClick={() => actions.toggleChecklist(item.id)}
                >
                  <Check size={15} />
                </button>
                <div>
                  <p className="checklist-item__title">{item.label}</p>
                  <p className="checklist-item__detail">{item.detail}</p>
                </div>
                {item.safetyCritical && <ShieldAlert size={15} color="#a96e0d" />}
              </div>
            ))}
          </div>
        </Card>

        <Card className="section-card field-section">
          <div className="section-card__header">
            <div>
              <h2>Before & after evidence</h2>
              <p className="section-card__subtitle">
                {state.dataMode === 'supabase'
                  ? 'Private originals · local SHA-256 captured · durable Storage read-back required on sync'
                  : 'Private demo evidence · customer visibility explicit'}
              </p>
            </div>
            <Camera size={18} color="#1f6d5e" />
          </div>
          <div className="photo-grid">
            <input
              ref={beforeInput}
              className="sr-only"
              type="file"
              accept="image/*"
              capture="environment"
              aria-label="Choose before photo"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) actions.addPhoto('before', file);
                event.target.value = '';
              }}
            />
            <input
              ref={afterInput}
              className="sr-only"
              type="file"
              accept="image/*"
              capture="environment"
              aria-label="Choose after photo"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) actions.addPhoto('after', file);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className={visit.beforePhotos > 0 ? 'photo-tile photo-tile--complete' : 'photo-tile'}
              disabled={!canCapture}
              onClick={() =>
                state.dataMode === 'supabase'
                  ? beforeInput.current?.click()
                  : actions.addPhoto('before')
              }
            >
              {visit.beforePhotos > 0 ? (
                <>
                  <CheckCircle2 size={21} />
                  {visit.beforePhotos} before
                </>
              ) : (
                <>
                  <Camera size={21} />
                  Add before
                </>
              )}
            </button>
            <button
              type="button"
              className={visit.afterPhotos > 0 ? 'photo-tile photo-tile--complete' : 'photo-tile'}
              disabled={!canCapture}
              onClick={() =>
                state.dataMode === 'supabase'
                  ? afterInput.current?.click()
                  : actions.addPhoto('after')
              }
            >
              {visit.afterPhotos > 0 ? (
                <>
                  <CheckCircle2 size={21} />
                  {visit.afterPhotos} after
                </>
              ) : (
                <>
                  <Camera size={21} />
                  Add after
                </>
              )}
            </button>
            <button
              type="button"
              className={visit.signature ? 'photo-tile photo-tile--complete' : 'photo-tile'}
              disabled={
                !canCapture || (state.dataMode === 'supabase' && signerName.trim().length < 2)
              }
              onClick={() => actions.captureSignature(signerName)}
            >
              {visit.signature ? (
                <>
                  <CheckCircle2 size={21} />
                  Signed
                </>
              ) : (
                <>
                  <FileSignature size={21} />
                  Signature
                </>
              )}
            </button>
          </div>
          {state.dataMode === 'supabase' && !visit.signature && (
            <div className="live-signature-input">
              <label htmlFor="completion-signer">Customer signer name</label>
              <input
                id="completion-signer"
                className="input"
                value={signerName}
                onChange={(event) => updateVisitForm({ signerName: event.target.value })}
                placeholder="Verified signer name"
                disabled={!canCapture}
              />
              <small>
                Clicking Signature records a typed completion acknowledgement, disclosure version,
                time, checksum, and authenticated visit scope.
              </small>
            </div>
          )}
          {state.dataMode === 'supabase' &&
            visit.status === 'complete' &&
            ['owner', 'dispatcher'].includes(state.role) && (
              <div className="completed-evidence-publication">
                <div>
                  <strong>Customer portal publication</strong>
                  <small>
                    {publishedCompletedEvidence.length} already published ·{' '}
                    {unpublishedCompletedEvidence.length} eligible private image
                    {unpublishedCompletedEvidence.length === 1 ? '' : 's'}
                  </small>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  loading={publicationPending}
                  disabled={
                    unpublishedCompletedEvidence.length === 0 ||
                    !state.online ||
                    !state.serverVerifiedAt
                  }
                  onClick={() => {
                    setPublicationPending(true);
                    void actions
                      .publishCompletedWorkEvidence(
                        visit.id,
                        unpublishedCompletedEvidence.map((evidence) => evidence.id),
                      )
                      .finally(() => setPublicationPending(false));
                  }}
                >
                  Publish {unpublishedCompletedEvidence.length} before/after
                </Button>
              </div>
            )}
        </Card>

        <Card className="section-card field-section">
          <div className="section-card__header">
            <div>
              <h2>Materials & notes</h2>
              <p className="section-card__subtitle">
                Safety metadata stays in this user-and-company-scoped offline packet
              </p>
            </div>
            <PackageCheck size={18} color="#1f6d5e" />
          </div>
          {state.dataMode === 'supabase' ? (
            <div className="live-material-recorder">
              <label htmlFor="live-material">Active catalog material</label>
              <select
                id="live-material"
                className="select"
                value={materialId}
                onChange={(event) => updateVisitForm({ materialId: event.target.value })}
                disabled={!canCapture}
              >
                <option value="">Select a material</option>
                {(state.live?.materials ?? []).map((material) => (
                  <option value={material.id} key={material.id}>
                    {material.name} · {material.unit}
                  </option>
                ))}
              </select>
              <label htmlFor="live-material-quantity">Quantity in catalog unit</label>
              <input
                id="live-material-quantity"
                className="input"
                inputMode="decimal"
                value={materialQuantity}
                onChange={(event) => updateVisitForm({ materialQuantity: event.target.value })}
                disabled={!canCapture}
              />
              <Button
                variant="secondary"
                disabled={
                  !canCapture ||
                  !materialId ||
                  Boolean(selectedMaterial?.requiresSds && !selectedSdsAvailable) ||
                  !Number.isFinite(Number(materialQuantity)) ||
                  Number(materialQuantity) <= 0
                }
                onClick={() => {
                  const material = state.live?.materials.find((item) => item.id === materialId);
                  if (!material) return;
                  actions.recordMaterial(material.name, `${materialQuantity} ${material.unit}`);
                  updateVisitForm({ materialQuantity: '' });
                }}
              >
                Record actual usage
              </Button>
              {selectedMaterial?.sdsDocument ? (
                <>
                  <dl className="sds-metadata">
                    <div>
                      <dt>Product</dt>
                      <dd>{selectedMaterial.sdsDocument.productName}</dd>
                    </div>
                    <div>
                      <dt>Manufacturer</dt>
                      <dd>{selectedMaterial.sdsDocument.manufacturer}</dd>
                    </div>
                    <div>
                      <dt>Revision</dt>
                      <dd>{selectedMaterial.sdsDocument.revisionDate}</dd>
                    </div>
                    <div>
                      <dt>Reviewed</dt>
                      <dd>{selectedMaterial.sdsDocument.reviewedAt ?? 'Not yet recorded'}</dd>
                    </div>
                    <div>
                      <dt>Device availability</dt>
                      <dd>
                        {selectedSdsAvailable
                          ? `Available offline · verified ${selectedMaterial.sdsDocument.cachedAt ?? 'on this device'}`
                          : 'Not cached · metadata only'}
                      </dd>
                    </div>
                    <div>
                      <dt>Checksum</dt>
                      <dd>{selectedMaterial.sdsDocument.checksumSha256}</dd>
                    </div>
                  </dl>
                  <div className="sds-actions">
                    {selectedSdsAvailable && selectedMaterial.sdsDocument.cachedFile ? (
                      <Button
                        type="button"
                        variant="secondary"
                        icon={<Download size={14} />}
                        onClick={() =>
                          openCachedPdf(
                            selectedMaterial.sdsDocument!.cachedFile!,
                            selectedMaterial.sdsDocument!.productName,
                          )
                        }
                      >
                        Open cached SDS
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="secondary"
                        loading={sdsPending}
                        disabled={!state.online || !state.serverVerifiedAt}
                        icon={<Download size={14} />}
                        onClick={() => {
                          setSdsPending(true);
                          void actions
                            .cacheSdsDocument(selectedMaterial.sdsDocument!.id)
                            .finally(() => setSdsPending(false));
                        }}
                      >
                        Make SDS available offline
                      </Button>
                    )}
                    {selectedMaterial.requiresSds && !selectedSdsAvailable && (
                      <small className="field-safety-warning">
                        Usage is blocked until the approved PDF is checksum-verified and durably
                        saved on this device.
                      </small>
                    )}
                  </div>
                </>
              ) : selectedMaterial?.requiresSds ? (
                <small className="field-safety-warning">
                  No SDS is attached. This material is classified as requiring one, so usage is
                  blocked.
                </small>
              ) : selectedMaterial ? (
                <small>
                  No SDS is attached. The active catalog classifies this item as non-chemical.
                </small>
              ) : (
                <small>
                  Select a material to review both SDS metadata and actual device availability.
                </small>
              )}
            </div>
          ) : (
            <>
              <div className="materials-row">
                <span>
                  <strong>Debris disposal bag</strong>
                  <small>No SDS attached · non-chemical demo material</small>
                </span>
                {visit.materials.some((material) => material.name === 'Debris disposal bag') ? (
                  <Badge tone="positive">1 each recorded</Badge>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!canCapture}
                    onClick={() => actions.recordMaterial('Debris disposal bag', '1 each')}
                  >
                    Record 1 bag
                  </Button>
                )}
              </div>
              <div className="materials-row">
                <span>
                  <strong>Fresh-water rinse</strong>
                  <small>No SDS attached · non-chemical demo material</small>
                </span>
                {visit.materials.some((material) => material.name === 'Fresh-water rinse') ? (
                  <Badge tone="positive">10 gal recorded</Badge>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!canCapture}
                    onClick={() => actions.recordMaterial('Fresh-water rinse', '10 gal')}
                  >
                    Record 10 gal
                  </Button>
                )}
              </div>
            </>
          )}
          <textarea
            className="textarea"
            aria-label="Job notes"
            placeholder="Add internal completion notes…"
            value={notes}
            onChange={(event) => updateVisitForm({ notes: event.target.value })}
            onBlur={() => actions.updateVisitNotes(notes)}
            disabled={!canCapture}
          />
          <p className="field-save-hint">
            {state.dataMode === 'supabase'
              ? notes === visit.notes
                ? state.online && state.serverVerifiedAt
                  ? 'Last confirmed as versioned internal job notes'
                  : state.online
                    ? 'Cached copy · refresh required before back-office changes'
                    : 'Saved locally with its exact command for idempotent replay'
                : 'Unsaved changes · leave the field to save'
              : notes === visit.notes
                ? state.online
                  ? 'Saved with the completion packet'
                  : 'Saved locally for idempotent sync'
                : 'Unsaved changes · leave the field to save'}
          </p>
        </Card>

        <Card className="section-card field-section">
          <div className="section-card__header">
            <div>
              <h2>Field change request</h2>
              <p className="section-card__subtitle">
                Record observed differences for office review. This never changes accepted scope,
                price, schedule, or customer communications.
              </p>
            </div>
            <ShieldAlert size={18} color="#a96e0d" />
          </div>
          <form
            className="field-change-form"
            onSubmit={(event) => {
              event.preventDefault();
              setChangePending(true);
              void actions
                .submitFieldChangeRequest({
                  reasonCode: changeReason,
                  summary: changeSummary,
                })
                .then((stored) => {
                  if (stored) setChangeSummary('');
                })
                .finally(() => setChangePending(false));
            }}
          >
            <label htmlFor="field-change-reason">Observed difference</label>
            <select
              id="field-change-reason"
              className="select"
              value={changeReason}
              disabled={!changeRequestAllowed}
              onChange={(event) =>
                setChangeReason(
                  event.target.value as
                    | 'scope_mismatch'
                    | 'access_blocked'
                    | 'customer_request'
                    | 'site_condition'
                    | 'other',
                )
              }
            >
              <option value="scope_mismatch">Scope does not match site</option>
              <option value="access_blocked">Access is blocked</option>
              <option value="customer_request">Customer requested different work</option>
              <option value="site_condition">Site condition changed</option>
              <option value="other">Other observed issue</option>
            </select>
            <label htmlFor="field-change-summary">Directly observed facts</label>
            <textarea
              id="field-change-summary"
              className="textarea"
              value={changeSummary}
              minLength={10}
              maxLength={2_000}
              disabled={!changeRequestAllowed}
              onChange={(event) => setChangeSummary(event.target.value)}
              placeholder="Describe what differs, where it is, and what work has been stopped. Do not guess price or promise additional work."
            />
            <Button
              type="submit"
              variant="secondary"
              loading={changePending}
              disabled={
                !changeRequestAllowed ||
                changeSummary.trim().length < 10 ||
                changeSummary.trim().length > 2_000
              }
            >
              Submit for office review
            </Button>
            {!changeRequestAllowed && (
              <small>
                A confirmed or active assigned visit is required before submitting a field change.
              </small>
            )}
          </form>
          {(visit.changeRequests ?? []).length > 0 && (
            <ul className="field-change-history" aria-label="Recorded field change requests">
              {visit.changeRequests?.map((request) => (
                <li key={request.id}>
                  <Badge tone={request.status === 'resolved' ? 'positive' : 'warning'}>
                    {request.status}
                  </Badge>
                  <div>
                    <strong>{request.reasonCode.replaceAll('_', ' ')}</strong>
                    <p>{request.summary}</p>
                    <small>{request.createdAt}</small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {activeIncident && (
          <div className="incident-open-card" role="status">
            <AlertOctagon size={18} />
            <div>
              <strong>Incident {activeIncident.id} is open</strong>
              <p>
                Affected automation is paused. The owner must review evidence and close the
                incident.
              </p>
            </div>
            {can('incidents.manage') && (
              <div className="incident-closure">
                <label htmlFor="incident-closure-note">Factual owner closure note</label>
                <textarea
                  id="incident-closure-note"
                  className="textarea"
                  value={incidentClosureNote}
                  maxLength={2_000}
                  onChange={(event) => setIncidentClosureNote(event.target.value)}
                  placeholder="Record the verified disposition and completed corrective action. Do not speculate."
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={
                    incidentClosureNote.trim().length < 5 ||
                    incidentClosureNote.trim().length > 2_000
                  }
                  onClick={() => {
                    actions.closeIncident(activeIncident.id, incidentClosureNote);
                    setIncidentClosureNote('');
                  }}
                >
                  Close after owner review
                </Button>
                <small>
                  Internal workflow state only; no external safety or legal message is sent.
                </small>
              </div>
            )}
          </div>
        )}

        {incidentStopPending && !activeIncident && (
          <div className="incident-open-card" role="status">
            <AlertOctagon size={18} />
            <div>
              <strong>Incident stop-work is pending server reconciliation</strong>
              <p>
                The exact atomic packet is stored on this device. Keep work stopped; ordinary field
                controls stay locked until sync returns a durable receipt and authoritative state.
              </p>
            </div>
          </div>
        )}

        {state.dataMode === 'supabase' && stopWorkPending && (
          <Card className="section-card field-section">
            <div className="section-card__header">
              <div>
                <h2>Private incident evidence</h2>
                <p className="section-card__subtitle">
                  Available during stop-work · exact incident and visit · never customer visible
                </p>
              </div>
              <ShieldAlert size={18} color="#a96e0d" />
            </div>
            <input
              ref={incidentEvidenceInput}
              className="sr-only"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              aria-label="Choose private incident evidence photo"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) actions.addIncidentEvidence(incidentEvidenceKind, file);
                event.target.value = '';
              }}
            />
            <label htmlFor="incident-evidence-kind">Evidence type</label>
            <select
              id="incident-evidence-kind"
              className="select"
              value={incidentEvidenceKind}
              onChange={(event) =>
                setIncidentEvidenceKind(event.target.value as 'incident' | 'safety' | 'damage')
              }
            >
              <option value="incident">Incident scene</option>
              <option value="safety">Safety condition</option>
              <option value="damage">Damage evidence</option>
            </select>
            <Button
              variant="secondary"
              disabled={!fieldAllowed}
              onClick={() => incidentEvidenceInput.current?.click()}
              icon={<Camera size={16} />}
            >
              Capture private evidence
            </Button>
            <small>
              WashOps writes the original bytes and exact finalizer command to durable device
              storage first. Ordinary checklist, material, signature, before/after, timer, and
              completion controls remain locked.
            </small>
          </Card>
        )}

        <button
          type="button"
          className="incident-button"
          disabled={!fieldAllowed || stopWorkPending}
          title={
            stopWorkPending
              ? 'This visit already has an open or unconfirmed incident stop-work record.'
              : undefined
          }
          onClick={() => setIncidentOpen(true)}
        >
          <AlertOctagon size={17} />
          {stopWorkPending ? 'Incident stop-work already active' : 'Report incident or damage'}
          <span>
            {stopWorkPending
              ? 'Resolve or reconcile the existing record before another report'
              : 'Pauses affected automations'}
          </span>
        </button>

        {incidentOpen && (
          <div
            className="modal-backdrop"
            role="presentation"
            onMouseDown={() => setIncidentOpen(false)}
          >
            <section
              className="incident-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="incident-dialog-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div>
                <Badge tone="danger">Safety record</Badge>
                <h2 id="incident-dialog-title">Report observed facts</h2>
                <p>
                  This pauses affected automation. It does not contact emergency services,
                  authorities, insurers, or the customer.
                </p>
              </div>
              <label htmlFor="incident-kind">Incident type</label>
              <select
                id="incident-kind"
                className="select"
                value={incidentKind}
                onChange={(event) =>
                  setIncidentKind(
                    event.target.value as 'near_miss' | 'property_damage' | 'injury_or_exposure',
                  )
                }
              >
                <option value="near_miss">Near miss</option>
                <option value="property_damage">Property damage</option>
                <option value="injury_or_exposure">Injury or exposure</option>
              </select>
              <label htmlFor="incident-summary">What did you directly observe?</label>
              <textarea
                id="incident-summary"
                className="textarea"
                autoFocus
                value={incidentSummary}
                onChange={(event) => setIncidentSummary(event.target.value)}
                placeholder="Record facts, location, time, and immediate safe actions. Do not speculate."
              />
              {state.dataMode === 'supabase' && (
                <>
                  <label htmlFor="incident-severity">Observed severity</label>
                  <select
                    id="incident-severity"
                    className="select"
                    value={incidentSeverity}
                    onChange={(event) =>
                      setIncidentSeverity(
                        event.target.value as 'near_miss' | 'minor' | 'serious' | 'critical',
                      )
                    }
                  >
                    <option value="near_miss">Near miss</option>
                    <option value="minor">Minor</option>
                    <option value="serious">Serious</option>
                    <option value="critical">Critical</option>
                  </select>
                  <label htmlFor="incident-actions">Immediate actions actually taken</label>
                  <textarea
                    id="incident-actions"
                    className="textarea"
                    value={incidentActions}
                    onChange={(event) => setIncidentActions(event.target.value)}
                    placeholder="For example: stopped work and isolated the area."
                  />
                </>
              )}
              <div className="incident-dialog__actions">
                <Button variant="secondary" onClick={() => setIncidentOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  disabled={
                    incidentPending ||
                    incidentSummary.trim().length < 10 ||
                    (state.dataMode === 'supabase' && incidentActions.trim().length < 5)
                  }
                  onClick={async () => {
                    setIncidentPending(true);
                    try {
                      const accepted = await actions.reportIncident({
                        kind: incidentKind,
                        summary: incidentSummary,
                        severity: state.dataMode === 'supabase' ? incidentSeverity : undefined,
                        immediateActions:
                          state.dataMode === 'supabase' ? incidentActions : undefined,
                      });
                      if (accepted) {
                        setIncidentSummary('');
                        setIncidentActions('');
                        setIncidentOpen(false);
                      }
                    } finally {
                      setIncidentPending(false);
                    }
                  }}
                >
                  {incidentPending ? 'Stopping work…' : 'Open incident & pause'}
                </Button>
              </div>
            </section>
          </div>
        )}

        <Card className="section-card field-section field-sync-card">
          <div className="section-card__header">
            <div>
              <h2>Device synchronization</h2>
              <p className="section-card__subtitle">
                Every offline mutation keeps its original command UUID, expected version, request
                hash, dependencies, and captured media bytes.
              </p>
            </div>
            {state.online ? <UploadCloud size={18} /> : <CloudOff size={18} />}
          </div>
          {state.offlineQueue.length === 0 ? (
            <p role="status">
              No pending device mutations.
              {state.serverVerifiedAt
                ? ` Last server verification: ${state.serverVerifiedAt}.`
                : ' Server verification is not current.'}
            </p>
          ) : (
            <ul className="field-sync-list" aria-label="Field synchronization items">
              {state.offlineQueue.map((mutation) => (
                <li key={mutation.id}>
                  <Badge
                    tone={
                      mutation.status === 'failed'
                        ? 'danger'
                        : mutation.status === 'synced'
                          ? 'positive'
                          : 'warning'
                    }
                  >
                    {mutation.status}
                  </Badge>
                  <div>
                    <strong>{mutation.action.replaceAll('.', ' ')}</strong>
                    <small>
                      Item {mutation.id} · entity {mutation.entityId} · attempt{' '}
                      {mutation.attemptCount ?? 0}
                    </small>
                    {(mutation.dependsOn ?? []).length > 0 && (
                      <small>Depends on: {mutation.dependsOn?.join(', ')}</small>
                    )}
                    {mutation.lastError && (
                      <small className="field-safety-warning">{mutation.lastError}</small>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {!state.online && (
          <div className="offline-queue-card">
            <CloudOff size={18} />
            <div>
              <strong>{state.offlineQueue.length} changes queued on this device</strong>
              <p>
                {state.dataMode === 'supabase'
                  ? `${failedOfflineChanges > 0 ? `${failedOfflineChanges} conflict${failedOfflineChanges === 1 ? '' : 's'} retained. ` : ''}Replay preserves original media bytes and SHA-256 hashes plus every command UUID, request hash, expected version, and dependency.`
                  : `Local revision ${state.syncRevision}. Replay uses one-time idempotency keys after conflict checks.`}
              </p>
            </div>
          </div>
        )}

        {state.online && state.offlineQueue.length > 0 && (
          <Button
            variant="secondary"
            className="full-width"
            disabled={!canSyncOffline}
            onClick={() => void actions.syncOfflineQueue()}
            icon={<UploadCloud size={16} />}
          >
            {incidentStopPending
              ? 'Sync incident stop-work first'
              : activeIncident
                ? `Sync ${replayableIncidentEvidence.length} private evidence changes`
                : `Sync ${state.offlineQueue.length} offline changes`}
          </Button>
        )}

        <div className="field-actions">
          {visit.status === 'ready' || visit.status === 'en_route' ? (
            <Button
              variant="dark"
              disabled={
                !fieldAllowed ||
                stopWorkPending ||
                dispatchPending ||
                (state.dataMode === 'supabase' && visit.status === 'ready' && !canStartRoute)
              }
              onClick={() => {
                if (visit.status === 'ready') {
                  void startRoute();
                } else {
                  actions.updateVisitStatus('on_site');
                }
              }}
              icon={<Play size={15} />}
            >
              {state.dataMode === 'supabase' && visit.status === 'ready'
                ? dispatchPending
                  ? 'Checking NWS + VROOM…'
                  : canStartRoute
                    ? 'Check & start route'
                    : 'Confirmation required'
                : state.dataMode === 'sandbox'
                  ? 'Start demo job'
                  : 'Start job'}
            </Button>
          ) : visit.status === 'complete' ? (
            <Button variant="dark" disabled>
              <CheckCircle2 size={15} /> Completion locked
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                disabled={!fieldAllowed || (visit.status === 'paused' && stopWorkPending)}
                onClick={() => actions.updateVisitStatus('paused')}
                icon={<Pause size={15} />}
              >
                Pause
              </Button>
              <Button
                variant="dark"
                disabled={!fieldAllowed || stopWorkPending || completionPending}
                onClick={actions.completeVisit}
                icon={<ClipboardCheck size={15} />}
              >
                {completionPending ? 'Completion pending sync' : 'Complete job'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
