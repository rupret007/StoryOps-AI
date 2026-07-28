import {
  AlertOctagon,
  Camera,
  Check,
  CheckCircle2,
  ClipboardCheck,
  CloudOff,
  Droplets,
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

export function FieldPage() {
  const { state, actions, can } = useStoryOps();
  const visit = state.visits[0];
  const [clock, setClock] = useState(() => Date.now());
  const [notes, setNotes] = useState(() => visit?.notes ?? '');
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
  const [signerName, setSignerName] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [materialQuantity, setMaterialQuantity] = useState('');
  const beforeInput = useRef<HTMLInputElement>(null);
  const afterInput = useRef<HTMLInputElement>(null);

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
  const workActive = visit.status === 'on_site' || visit.status === 'paused';
  const canCapture = fieldAllowed && workActive;
  const canStartRoute = state.dataMode === 'sandbox' || state.live?.visitStatus === 'confirmed';
  const activeIncident = state.incidents.find(
    (incident) => incident.visitId === visit.id && incident.status === 'open',
  );
  const selectedMaterial = state.live?.materials.find((item) => item.id === materialId);
  const completionPending = state.offlineQueue.some(
    (mutation) =>
      mutation.command?.commandType === 'visit.transition' &&
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

  return (
    <div className="page">
      <PageHeader
        eyebrow="Mobile field mode"
        title="Today’s active visit"
        description={
          state.dataMode === 'supabase'
            ? 'The role-scoped packet is cached locally. Supported offline commands retain their original UUID, request hash, and expected version.'
            : 'The working packet is cached on this device. Every offline mutation has an idempotency key and visible sync state.'
        }
        actions={
          <>
            <Badge
              tone={state.online && state.offlineQueue.length === 0 ? 'positive' : 'warning'}
              dot
            >
              {state.online
                ? state.offlineQueue.length === 0
                  ? 'Online & synced'
                  : `Online · ${state.offlineQueue.length} pending`
                : `Offline · ${state.offlineQueue.length} queued`}
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
                <span className="field-stat__value">{visit.route.driveMinutes} min</span>
              </div>
            </div>
          </div>
        </Card>

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
        ) : (
          <Card className="projection-warning">
            <ShieldAlert size={18} />
            <div>
              <strong>Weather and route evidence are not in this workspace projection</strong>
              <p>
                StoryOps will not claim safe conditions or route feasibility. Verify the approved
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
                  : 'Confirm equipment, route, and weather in the approved dispatch workflow.'}
              </p>
            </div>
            <Button
              disabled={!fieldAllowed || !canStartRoute}
              title={
                !canStartRoute
                  ? 'The server visit must be confirmed before en-route work can start.'
                  : undefined
              }
              onClick={() => actions.updateVisitStatus('en_route')}
            >
              {canStartRoute
                ? state.dataMode === 'sandbox'
                  ? 'Start demo route'
                  : 'Start route'
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
                  : 'Notification delivery is not represented in this field projection; verify the communications log.'}
              </p>
            </div>
            <Button disabled={!fieldAllowed} onClick={() => actions.updateVisitStatus('on_site')}>
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
              disabled={!fieldAllowed}
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
                onChange={(event) => setSignerName(event.target.value)}
                placeholder="Verified signer name"
                disabled={!canCapture}
              />
              <small>
                Clicking Signature records a typed completion acknowledgement, disclosure version,
                time, checksum, and authenticated visit scope.
              </small>
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
                onChange={(event) => setMaterialId(event.target.value)}
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
                onChange={(event) => setMaterialQuantity(event.target.value)}
                disabled={!canCapture}
              />
              <Button
                variant="secondary"
                disabled={
                  !canCapture ||
                  !materialId ||
                  Boolean(selectedMaterial?.requiresSds && !selectedMaterial.sdsDocument) ||
                  !Number.isFinite(Number(materialQuantity)) ||
                  Number(materialQuantity) <= 0
                }
                onClick={() => {
                  const material = state.live?.materials.find((item) => item.id === materialId);
                  if (!material) return;
                  actions.recordMaterial(material.name, `${materialQuantity} ${material.unit}`);
                  setMaterialQuantity('');
                }}
              >
                Record actual usage
              </Button>
              {selectedMaterial?.sdsDocument ? (
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
                    <dt>Checksum</dt>
                    <dd>{selectedMaterial.sdsDocument.checksumSha256}</dd>
                  </div>
                  <div>
                    <dt>Private object path</dt>
                    <dd>{selectedMaterial.sdsDocument.storageObjectPath}</dd>
                  </div>
                </dl>
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
                  Select a material to review its SDS attachment status. Metadata is available
                  offline; this screen does not claim that a PDF file was downloaded.
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
            onChange={(event) => setNotes(event.target.value)}
            onBlur={() => actions.updateVisitNotes(notes)}
            disabled={!canCapture}
          />
          <p className="field-save-hint">
            {state.dataMode === 'supabase'
              ? notes === visit.notes
                ? state.online
                  ? 'Saved as versioned internal job notes'
                  : 'Saved locally with its exact command for idempotent replay'
                : 'Unsaved changes · leave the field to save'
              : notes === visit.notes
                ? state.online
                  ? 'Saved with the completion packet'
                  : 'Saved locally for idempotent sync'
                : 'Unsaved changes · leave the field to save'}
          </p>
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

        <button
          type="button"
          className="incident-button"
          disabled={!fieldAllowed}
          onClick={() => setIncidentOpen(true)}
        >
          <AlertOctagon size={17} />
          Report incident or damage
          <span>Pauses affected automations</span>
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
                    incidentSummary.trim().length < 10 ||
                    (state.dataMode === 'supabase' && incidentActions.trim().length < 5)
                  }
                  onClick={() => {
                    actions.reportIncident({
                      kind: incidentKind,
                      summary: incidentSummary,
                      severity: state.dataMode === 'supabase' ? incidentSeverity : undefined,
                      immediateActions: state.dataMode === 'supabase' ? incidentActions : undefined,
                    });
                    setIncidentSummary('');
                    setIncidentActions('');
                    setIncidentOpen(false);
                  }}
                >
                  Open incident & pause
                </Button>
              </div>
            </section>
          </div>
        )}

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
            disabled={!fieldAllowed}
            onClick={() => void actions.syncOfflineQueue()}
            icon={<UploadCloud size={16} />}
          >
            Sync {state.offlineQueue.length} offline changes
          </Button>
        )}

        <div className="field-actions">
          {visit.status === 'ready' || visit.status === 'en_route' ? (
            <Button
              variant="dark"
              disabled={
                !fieldAllowed ||
                (state.dataMode === 'supabase' && visit.status === 'ready' && !canStartRoute)
              }
              onClick={() =>
                actions.updateVisitStatus(
                  state.dataMode === 'supabase' && visit.status === 'ready'
                    ? 'en_route'
                    : 'on_site',
                )
              }
              icon={<Play size={15} />}
            >
              {state.dataMode === 'supabase' && visit.status === 'ready'
                ? canStartRoute
                  ? 'Start route'
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
                disabled={!fieldAllowed}
                onClick={() => actions.updateVisitStatus('paused')}
                icon={<Pause size={15} />}
              >
                Pause
              </Button>
              <Button
                variant="dark"
                disabled={!fieldAllowed || completionPending}
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
