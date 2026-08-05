import {
  ArrowRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  CloudSun,
  Droplets,
  Gauge,
  Inbox,
  MessageSquareText,
  Route,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  UsersRound,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import {
  Badge,
  Button,
  Card,
  Field,
  Metric,
  PageHeader,
  Progress,
} from '@/components/ui/Primitives';
import { deriveSandboxPilotRehearsal } from '@/core/pilot/rehearsal';
import { deriveOwnerCommandCenter } from '@/core/pilot/ownerCommandCenter';
import { derivePilotReadiness, type PilotReadinessStatus } from '@/core/pilot/readiness';
import type { DemoState } from '@/state/model';
import {
  actualCostCoverage,
  formatCurrencyDecimal,
  formatPercentDecimal,
  sourceIdSummary,
  type LiveProfitabilityKpis,
} from '@/core/finance/profitability';
import {
  pilotEvidenceProviderSchema,
  type PilotEvidenceKind,
  type PilotReleaseEvidenceInput,
  type PilotReleaseEvidenceReceipt,
} from '@/core/pilot/releaseEvidence';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const readinessTone = (
  status: PilotReadinessStatus,
): 'positive' | 'danger' | 'warning' | 'neutral' =>
  status === 'ready'
    ? 'positive'
    : status === 'blocked'
      ? 'danger'
      : status === 'manual_gate'
        ? 'warning'
        : 'neutral';

function evidenceExpiry(observedAt: string, kind: PilotEvidenceKind): string {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return '';
  const days = kind === 'provider_canary' ? 7 : 30;
  return new Date(observed + days * 24 * 60 * 60_000).toISOString();
}

function PilotEvidenceRecorder({
  state,
  onRecord,
}: {
  state: DemoState;
  onRecord(input: PilotReleaseEvidenceInput): Promise<PilotReleaseEvidenceReceipt | undefined>;
}) {
  const providers = useMemo(
    () =>
      [
        ...new Set(
          state.integrations
            .map((integration) => integration.provider)
            .filter((provider) => pilotEvidenceProviderSchema.safeParse(provider).success),
        ),
      ].sort(),
    [state.integrations],
  );
  const initialObservedAt = state.live?.serverTime ?? new Date().toISOString();
  const [kind, setKind] = useState<PilotEvidenceKind>('provider_canary');
  const [provider, setProvider] = useState(providers[0] ?? '');
  const [outcome, setOutcome] = useState<'passed' | 'failed'>('failed');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [artifactSha256, setArtifactSha256] = useState('');
  const [observedAt, setObservedAt] = useState(initialObservedAt);
  const [expiresAt, setExpiresAt] = useState(evidenceExpiry(initialObservedAt, 'provider_canary'));
  const [reviewNote, setReviewNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const source =
        kind === 'provider_canary'
          ? 'external_provider_receipt'
          : kind === 'field_media_canary'
            ? 'storage_roundtrip'
            : 'isolated_restore_drill';
      const receipt = await onRecord({
        kind,
        ...(kind === 'provider_canary'
          ? { provider: pilotEvidenceProviderSchema.parse(provider) }
          : {}),
        outcome,
        source,
        evidenceReference,
        artifactSha256: artifactSha256.toLowerCase(),
        observedAt,
        expiresAt,
        reviewNote,
      });
      if (receipt) {
        setEvidenceReference('');
        setArtifactSha256('');
        setReviewNote('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="pilot-evidence-recorder">
      <summary>Record reviewed external release evidence</summary>
      <p>
        This form records an owner attestation only. It does not run a canary, create trusted system
        proof, activate a provider, prove the referenced artifact, or satisfy a release gate. Use
        opaque IDs and SHA-256 only; never paste prose, a secret, signed URL, customer data, or raw
        provider payload.
      </p>
      <div className="pilot-evidence-form">
        <Field label="Evidence kind" htmlFor="pilot-evidence-kind">
          <select
            id="pilot-evidence-kind"
            className="select"
            value={kind}
            onChange={(event) => {
              const next = event.target.value as PilotEvidenceKind;
              setKind(next);
              setExpiresAt(evidenceExpiry(observedAt, next));
            }}
          >
            <option value="provider_canary">Provider canary</option>
            <option value="field_media_canary">Field media roundtrip</option>
            <option value="backup_restore">Isolated restore drill</option>
          </select>
        </Field>
        {kind === 'provider_canary' && (
          <Field label="Provider" htmlFor="pilot-evidence-provider">
            <select
              id="pilot-evidence-provider"
              className="select"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            >
              {providers.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Observed outcome" htmlFor="pilot-evidence-outcome">
          <select
            id="pilot-evidence-outcome"
            className="select"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as 'passed' | 'failed')}
          >
            <option value="failed">Failed / unresolved</option>
            <option value="passed">Owner-attested pass (manual gate)</option>
          </select>
        </Field>
        <Field label="Evidence reference" htmlFor="pilot-evidence-reference">
          <input
            id="pilot-evidence-reference"
            className="input"
            value={evidenceReference}
            maxLength={120}
            pattern="[A-Za-z0-9][A-Za-z0-9._-]{4,119}"
            onChange={(event) => setEvidenceReference(event.target.value)}
          />
        </Field>
        <Field label="Artifact SHA-256" htmlFor="pilot-evidence-sha">
          <input
            id="pilot-evidence-sha"
            className="input"
            value={artifactSha256}
            maxLength={64}
            spellCheck={false}
            onChange={(event) => setArtifactSha256(event.target.value)}
          />
        </Field>
        <Field label="Observed at (ISO 8601)" htmlFor="pilot-evidence-observed">
          <input
            id="pilot-evidence-observed"
            className="input"
            value={observedAt}
            onChange={(event) => {
              setObservedAt(event.target.value);
              setExpiresAt(evidenceExpiry(event.target.value, kind));
            }}
          />
        </Field>
        <Field label="Expires at (ISO 8601)" htmlFor="pilot-evidence-expires">
          <input
            id="pilot-evidence-expires"
            className="input"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
        </Field>
        <Field label="Owner review attestation ID" htmlFor="pilot-evidence-note">
          <input
            id="pilot-evidence-note"
            className="input"
            value={reviewNote}
            maxLength={120}
            pattern="[A-Za-z0-9][A-Za-z0-9._-]{9,119}"
            onChange={(event) => setReviewNote(event.target.value)}
          />
        </Field>
      </div>
      <Button
        type="button"
        size="sm"
        loading={busy}
        disabled={
          !/^[A-Za-z0-9][A-Za-z0-9._-]{4,119}$/u.test(evidenceReference.trim()) ||
          !/^[a-f0-9]{64}$/u.test(artifactSha256.toLowerCase()) ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{9,119}$/u.test(reviewNote.trim()) ||
          !Number.isFinite(Date.parse(observedAt)) ||
          !Number.isFinite(Date.parse(expiresAt)) ||
          (kind === 'provider_canary' && !provider)
        }
        onClick={() => void submit()}
      >
        Record owner attestation
      </Button>
    </details>
  );
}

function PilotReadinessCard({
  state,
  onRecord,
}: {
  state: DemoState;
  onRecord?(input: PilotReleaseEvidenceInput): Promise<PilotReleaseEvidenceReceipt | undefined>;
}) {
  const [currentTime, setCurrentTime] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date().toISOString()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const readiness = derivePilotReadiness(state, { now: currentTime });
  return (
    <Card className="section-card pilot-readiness-card">
      <div className="section-card__header">
        <div>
          <h2>Pilot readiness</h2>
          <p className="section-card__subtitle">{readiness.verdictReason}</p>
        </div>
        <Badge
          tone={
            readiness.verdict === 'READY_FOR_CONTROLLED_PILOT'
              ? 'positive'
              : readiness.verdict === 'HOLD_LIVE_PILOT'
                ? 'danger'
                : 'info'
          }
        >
          {readiness.verdict.replaceAll('_', ' ')}
        </Badge>
      </div>
      <Progress
        value={readiness.readyCount}
        max={readiness.totalCount}
        label="Deterministic and reviewed pilot gates"
        tone="green"
      />
      <div className="pilot-readiness-grid">
        {readiness.checks.map((check) => (
          <Link className="pilot-readiness-item" key={check.id} to={check.href}>
            <span>
              <Badge tone={readinessTone(check.status)}>{check.status.replaceAll('_', ' ')}</Badge>
              <strong>{check.label}</strong>
            </span>
            <small>{check.evidence}</small>
          </Link>
        ))}
      </div>
      <details className="pilot-provider-readiness">
        <summary>Provider mode, health, and canary evidence ({readiness.providers.length})</summary>
        <div className="pilot-provider-table">
          {readiness.providers.map((provider) => (
            <div key={provider.id}>
              <span>
                <strong>{provider.provider}</strong>
                <small>
                  {provider.capability.replaceAll('_', ' ')} · {provider.evidence}
                </small>
              </span>
              <Badge tone={readinessTone(provider.status)}>
                {provider.mode} · {provider.health} · canary {provider.canary.replaceAll('_', ' ')}
              </Badge>
            </div>
          ))}
        </div>
      </details>
      {state.dataMode === 'supabase' && onRecord && (
        <PilotEvidenceRecorder state={state} onRecord={onRecord} />
      )}
    </Card>
  );
}

function financialAsOf(value: string, timeZone: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(parsed);
  } catch {
    return parsed.toISOString();
  }
}

const financialSourceLabels: Record<keyof LiveProfitabilityKpis['evidence']['sourceIds'], string> =
  {
    jobIds: 'Completed/invoiced jobs',
    invoiceIds: 'Recognized invoices',
    costSnapshotIds: 'Verified cost snapshots',
    paymentIds: 'Payment ledger records',
    providerEventIds: 'Processed provider events',
  };

function LiveFinancialEvidenceCard({
  kpis,
  timeZone,
}: {
  kpis: LiveProfitabilityKpis;
  timeZone: string;
}) {
  const actual = kpis.completeness.actualCosts;
  return (
    <Card className="section-card profitability-evidence-card">
      <div className="section-card__header">
        <div>
          <h2>Financial evidence</h2>
          <p className="section-card__subtitle">
            Exact server aggregates as of {financialAsOf(kpis.asOf, timeZone)}
          </p>
        </div>
        <Badge tone={kpis.completeness.complete ? 'positive' : 'warning'}>
          {kpis.completeness.complete ? 'Complete' : 'Known gaps'}
        </Badge>
      </div>

      <div className="profitability-facts" aria-label="Actual cost evidence">
        <div>
          <span>Recorded material</span>
          <strong>{formatCurrencyDecimal(kpis.costs.recordedActualMaterial)}</strong>
          <small>
            {actual.materialCompleteCount}/{actual.requiredJobCount} jobs complete
          </small>
        </div>
        <div>
          <span>Recorded labor</span>
          <strong>{formatCurrencyDecimal(kpis.costs.recordedActualLabor)}</strong>
          <small>
            {actual.laborCompleteCount}/{actual.requiredJobCount} jobs complete
          </small>
        </div>
        <div>
          <span>Other direct cost</span>
          <strong>{formatCurrencyDecimal(kpis.costs.recordedActualOtherDirect)}</strong>
          <small>
            {actual.otherDirectCompleteCount}/{actual.requiredJobCount} jobs complete
          </small>
        </div>
      </div>

      <div className="financial-evidence-list">
        <div className="template-row">
          <span>
            <strong>Revenue source</strong>
            <small>Invoice subtotal; tax excluded from gross profit</small>
          </span>
          <Badge tone="neutral">{kpis.evidence.sourceCounts.invoices} invoices</Badge>
        </div>
        <div className="template-row">
          <span>
            <strong>Estimate source</strong>
            <small>Job estimate snapshots; never presented as actual cost</small>
          </span>
          <Badge tone="info">{kpis.evidence.sourceCounts.jobs} jobs</Badge>
        </div>
        <div className="template-row">
          <span>
            <strong>Payment truth</strong>
            <small>
              {formatCurrencyDecimal(kpis.receivables.recordedPaid)} ledger-recorded ·{' '}
              {formatCurrencyDecimal(kpis.receivables.providerVerifiedPaid)} provider-evidenced
            </small>
          </span>
          <Badge tone={kpis.completeness.paymentEvidenceComplete ? 'positive' : 'warning'}>
            {kpis.completeness.paymentEvidenceComplete ? 'Matched' : 'Reconcile'}
          </Badge>
        </div>
      </div>

      <p className="financial-source-summary">Sources: {sourceIdSummary(kpis)}</p>
      {kpis.completeness.unknowns.length > 0 && (
        <details className="briefing-unknowns" open>
          <summary>Known financial unknowns ({kpis.completeness.unknowns.length})</summary>
          <ul>
            {kpis.completeness.unknowns.map((unknown) => (
              <li key={unknown}>{unknown}</li>
            ))}
          </ul>
        </details>
      )}
      <details className="financial-source-ids">
        <summary>Audit source identifiers</summary>
        {Object.entries(kpis.evidence.sourceIds).map(([source, ids]) => (
          <div key={source}>
            <strong>
              {financialSourceLabels[
                source as keyof LiveProfitabilityKpis['evidence']['sourceIds']
              ] ?? source}
            </strong>
            {ids.length > 0 ? (
              <ul>
                {ids.map((id) => (
                  <li key={id}>
                    <code>{id}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <small>No source records in the recognized scope.</small>
            )}
          </div>
        ))}
        <small>
          Fingerprint <code>{kpis.evidence.sourceFingerprint}</code>
        </small>
      </details>
    </Card>
  );
}

export function DashboardPage() {
  const { state, actions } = useStoryOps();
  const ownerFirstName = state.setupProfile?.ownerName.trim().split(/\s+/u)[0] || 'Owner';
  const pendingApprovals = state.approvals.filter((item) => item.status === 'pending').length;
  const newLeads = state.leads.filter((lead) => lead.stage === 'new').length;
  const outstanding = state.invoices.reduce(
    (sum, invoice) => sum + Number(invoice.balance.replaceAll(',', '')),
    0,
  );

  if (state.dataMode === 'supabase') return <LiveDashboardPage />;

  const rehearsal = deriveSandboxPilotRehearsal(state);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Command center"
        title={`Good morning, ${ownerFirstName}.`}
        description="Synthetic sandbox workspace: no live provider, payment, route, weather, or dispatch truth is shown. Two approval fixtures need review."
        actions={
          <>
            <Link className="button button--secondary button--md" to="/dispatch">
              <CalendarClock size={16} aria-hidden="true" />
              Today’s route
            </Link>
            <Link className="button button--primary button--md" to="/pipeline">
              <Inbox size={16} aria-hidden="true" />
              Open inbox
            </Link>
            <Link className="button button--secondary button--md" to="/showcase">
              <Sparkles size={16} aria-hidden="true" />
              Open showcase
            </Link>
          </>
        }
      />

      <section className="metrics-grid" aria-label="Business metrics">
        <Metric
          label="Booked this week"
          value="$4,862"
          delta="+18% vs. prior week"
          icon={<TrendingUp size={18} />}
        />
        <Metric
          label="Qualified pipeline"
          value="$7,348"
          delta="14 active opportunities"
          icon={<UsersRound size={18} />}
          tone="blue"
        />
        <Metric
          label="Open receivables"
          value={money.format(outstanding)}
          delta="1 invoice past due"
          icon={<CircleDollarSign size={18} />}
          tone="orange"
        />
        <Metric
          label="Gross margin"
          value="58.7%"
          delta="+2.4 points this month"
          icon={<Gauge size={18} />}
          tone="plum"
        />
      </section>

      <div className="dashboard-grid">
        <div className="dashboard-stack">
          <PilotReadinessCard state={state} onRecord={actions.recordPilotReleaseEvidence} />
          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Pilot rehearsal</h2>
                <p className="section-card__subtitle">
                  Local-only golden-path checkpoints. No provider, customer, payment, route, or
                  weather truth is created here.
                </p>
              </div>
              <Badge tone="accent">
                {rehearsal.completeCount}/{rehearsal.checkpoints.length} local fixtures
              </Badge>
            </div>
            <Progress
              value={rehearsal.completeCount}
              max={rehearsal.checkpoints.length}
              label="Pilot rehearsal progress"
              tone="green"
            />
            <ul className="briefing-list">
              {rehearsal.checkpoints.map((item) => (
                <li className="briefing-item" key={item.id}>
                  <span className="briefing-item__icon">
                    {item.status === 'complete' ? (
                      <CheckCircle2 size={14} />
                    ) : (
                      <ShieldAlert size={14} />
                    )}
                  </span>
                  <div>
                    <p className="briefing-item__title">{item.title}</p>
                    <p className="briefing-item__detail">{item.detail}</p>
                  </div>
                  <Badge
                    tone={
                      item.status === 'complete'
                        ? 'positive'
                        : item.status === 'current'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {item.status === 'complete'
                      ? 'Recorded'
                      : item.status === 'current'
                        ? 'Next'
                        : 'Blocked'}
                  </Badge>
                </li>
              ))}
            </ul>
            {rehearsal.next && (
              <Link className="button button--dark button--md full-width" to={rehearsal.next.href}>
                {rehearsal.next.actionLabel}
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
            )}
          </Card>

          <Card className="briefing-card">
            <div className="briefing-card__header">
              <div>
                <h2>Owner briefing</h2>
                <p className="briefing-card__meta">
                  Generated 7:45 AM · 23 synthetic records · no external reads or writes
                </p>
              </div>
              <Badge tone="accent" dot>
                Current
              </Badge>
            </div>
            <ul className="briefing-list">
              <li className="briefing-item">
                <span className="briefing-item__icon">
                  <Route size={14} />
                </span>
                <div>
                  <p className="briefing-item__title">Demo route packet prepared</p>
                  <p className="briefing-item__detail">
                    Synthetic timing and weather scenario only. Verify live route, weather, and
                    equipment evidence before leaving.
                  </p>
                </div>
                <Badge tone="neutral">Fixture</Badge>
              </li>
              <li className="briefing-item">
                <span className="briefing-item__icon">
                  <ShieldAlert size={14} />
                </span>
                <div>
                  <p className="briefing-item__title">
                    {pendingApprovals} exact-payload approvals need you
                  </p>
                  <p className="briefing-item__detail">
                    A negative-review response and a 34-recipient maintenance reminder are paused.
                  </p>
                </div>
                <Badge tone="warning">Review</Badge>
              </li>
              <li className="briefing-item">
                <span className="briefing-item__icon">
                  <MessageSquareText size={14} />
                </span>
                <div>
                  <p className="briefing-item__title">
                    {newLeads} new leads are waiting on qualification
                  </p>
                  <p className="briefing-item__detail">
                    One has full consent and scope. One needs an address and property photos.
                  </p>
                </div>
                <Badge tone="info">Inbox</Badge>
              </li>
            </ul>
          </Card>

          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Today’s work</h2>
                <p className="section-card__subtitle">
                  Synthetic capacity, route, equipment, and weather scenario
                </p>
              </div>
              <Link className="link-button" to="/dispatch">
                Open dispatch <ArrowRight size={12} style={{ verticalAlign: 'middle' }} />
              </Link>
            </div>
            <ul className="schedule-list">
              <li className="schedule-row">
                <span className="schedule-row__time">10:30</span>
                <span className="schedule-row__line" aria-hidden="true" />
                <div>
                  <p className="schedule-row__title">Riley Brooks · Whole-property clean</p>
                  <p className="schedule-row__detail">Southlake · 4 hr · JOB-1032 · owner crew</p>
                </div>
                <Badge tone="neutral">Demo</Badge>
              </li>
              <li className="schedule-row">
                <span className="schedule-row__time">3:00</span>
                <span className="schedule-row__line schedule-row__line--blue" aria-hidden="true" />
                <div>
                  <p className="schedule-row__title">Quote follow-up · Sam Rivera</p>
                  <p className="schedule-row__detail">
                    Sandbox SMS receipt · synthetic consent fixture
                  </p>
                </div>
                <Badge tone="info">Scheduled</Badge>
              </li>
              <li className="schedule-row">
                <span className="schedule-row__time">4:30</span>
                <span
                  className="schedule-row__line schedule-row__line--orange"
                  aria-hidden="true"
                />
                <div>
                  <p className="schedule-row__title">Weekly equipment inspection</p>
                  <p className="schedule-row__detail">
                    Pressure washer, hoses, reels, PPE · evidence required
                  </p>
                </div>
                <Badge tone="neutral">Routine</Badge>
              </li>
            </ul>
          </Card>

          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Pipeline pulse</h2>
                <p className="section-card__subtitle">
                  Verified opportunity value by current stage
                </p>
              </div>
              <Link className="link-button" to="/pipeline">
                View pipeline <ArrowRight size={12} style={{ verticalAlign: 'middle' }} />
              </Link>
            </div>
            <div className="pipeline-pulse">
              {[
                { label: 'New', count: 2, amount: '$0', width: 16 },
                { label: 'Qualified', count: 3, amount: '$1,746', width: 37 },
                { label: 'Estimated', count: 4, amount: '$2,638', width: 55 },
                { label: 'Quoted', count: 3, amount: '$1,780', width: 48 },
                { label: 'Booked', count: 2, amount: '$1,184', width: 31 },
              ].map((stage) => (
                <div className="pulse-row" key={stage.label}>
                  <span>{stage.label}</span>
                  <Progress value={stage.width} label={`${stage.label} pipeline`} tone="green" />
                  <strong>{stage.amount}</strong>
                  <small>{stage.count}</small>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <aside className="dashboard-stack">
          <Card className="mini-weather">
            <div className="section-card__header">
              <div>
                <h2>Field conditions</h2>
                <p className="section-card__subtitle">Southlake · synthetic scenario</p>
              </div>
              <CloudSun size={27} color="#5186c4" aria-hidden="true" />
            </div>
            <div className="mini-weather__main">
              <div>
                <p className="mini-weather__temp">82°</p>
                <p className="mini-weather__detail">Synthetic fixture · not a forecast</p>
              </div>
              <Badge tone="neutral">Not dispatch evidence</Badge>
            </div>
            <div className="weather-stats">
              <span>
                <Droplets size={13} /> 12% scenario rain
              </span>
              <span>
                <Route size={13} /> 7 mph scenario wind
              </span>
            </div>
          </Card>

          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Capacity</h2>
                <p className="section-card__subtitle">Owner crew · this week</p>
              </div>
              <Badge tone="positive">Healthy</Badge>
            </div>
            <div className="capacity-meter">
              <div className="capacity-meter__labels">
                <span>19.5 hr booked</span>
                <strong>72%</strong>
              </div>
              <Progress value={72} label="Weekly capacity booked" />
            </div>
            <div className="capacity-days">
              {[
                ['Tue', 86],
                ['Wed', 64],
                ['Thu', 42],
                ['Fri', 78],
                ['Sat', 24],
              ].map(([day, value]) => (
                <div key={day}>
                  <span>{day}</span>
                  <div className="capacity-day__bar">
                    <i style={{ height: `${String(value)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>AI office activity</h2>
                <p className="section-card__subtitle">Actions are grounded and traced</p>
              </div>
              <Bot size={18} color="#1f6d5e" />
            </div>
            <ul className="activity-list">
              {state.traces.slice(0, 4).map((trace) => (
                <li className="activity-item" key={trace.id}>
                  <span className="activity-item__icon">
                    {trace.result === 'succeeded' ? (
                      <CheckCircle2 size={13} />
                    ) : (
                      <ShieldAlert size={13} />
                    )}
                  </span>
                  <p className="activity-item__text">
                    <strong>{trace.agent}</strong> · {trace.action}
                    <span className="activity-item__time">{trace.time}</span>
                  </p>
                </li>
              ))}
            </ul>
            <Link className="button button--secondary button--sm full-width" to="/office">
              Inspect traces
            </Link>
          </Card>

          <Card className="profit-card">
            <div>
              <span className="profit-card__icon">
                <Sparkles size={16} />
              </span>
              <p>Projected July operating profit</p>
              <strong>$8,420</strong>
              <small>after labor, materials, and provider costs</small>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function LiveDashboardPage() {
  const { state, actions } = useStoryOps();
  const pendingApprovals = state.approvals.filter((item) => item.status === 'pending').length;
  const newLeads = state.leads.filter((lead) => lead.stage === 'new').length;
  const stageOrder = ['new', 'qualified', 'estimated', 'quoted', 'booked'] as const;
  const ownerProjection = deriveOwnerCommandCenter(state);
  const profitabilityKpis = state.live?.profitabilityKpis;
  const visibleDashboardVisits =
    state.role === 'owner' ? ownerProjection.today.visits : state.visits;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Authenticated command center"
        title={state.live?.companyName ?? 'StoryOps workspace'}
        description={`Server-derived ${state.role} membership · workspace refreshed ${state.live?.serverTime ?? 'unknown time'}.`}
        actions={
          <>
            <Link className="button button--secondary button--md" to="/dispatch">
              <CalendarClock size={16} /> Visits
            </Link>
            <Link className="button button--primary button--md" to="/pipeline">
              <Inbox size={16} /> Leads
            </Link>
          </>
        }
      />

      {profitabilityKpis ? (
        <section className="metrics-grid" aria-label="Server-authoritative financial metrics">
          <Metric
            label="Invoiced revenue"
            value={formatCurrencyDecimal(profitabilityKpis.revenue.invoicedSubtotal)}
            delta={`${profitabilityKpis.jobs.profitabilityCount} recognized job invoices · tax excluded`}
            icon={<CircleDollarSign size={18} />}
          />
          <Metric
            label="Estimated gross margin"
            value={formatPercentDecimal(
              profitabilityKpis.profitability.estimatedGrossMarginPercent,
            )}
            delta={`${formatCurrencyDecimal(profitabilityKpis.costs.estimatedInvoicedJobs)} estimated cost · not actual`}
            icon={<TrendingUp size={18} />}
            tone="blue"
          />
          <Metric
            label="Open receivables"
            value={formatCurrencyDecimal(profitabilityKpis.receivables.openBalance)}
            delta={`${profitabilityKpis.receivables.pastDueInvoiceCount} past due · ledger balance`}
            icon={<CircleDollarSign size={18} />}
            tone="orange"
          />
          <Metric
            label="Actual gross margin"
            value={formatPercentDecimal(profitabilityKpis.profitability.actualGrossMarginPercent)}
            delta={actualCostCoverage(profitabilityKpis)}
            icon={<Gauge size={18} />}
            tone="plum"
          />
        </section>
      ) : (
        <section className="metrics-grid" aria-label="Role-visible workspace metrics">
          <Metric
            label="New leads"
            value={String(newLeads)}
            delta="role-visible records"
            icon={<Inbox size={18} />}
          />
          <Metric
            label="Customers"
            value={String(state.live?.customers.length ?? 0)}
            delta="role-scoped projection"
            icon={<UsersRound size={18} />}
            tone="blue"
          />
          <Metric
            label="Visits"
            value={String(state.visits.length)}
            delta="assigned or role-visible only"
            icon={<CalendarClock size={18} />}
            tone="orange"
          />
          <Metric
            label="Pending approvals"
            value={String(pendingApprovals)}
            delta="no company financial projection for this role"
            icon={<ShieldAlert size={18} />}
            tone="plum"
          />
        </section>
      )}

      <div className="dashboard-grid">
        <div className="dashboard-stack">
          {state.role === 'owner' && (
            <PilotReadinessCard state={state} onRecord={actions.recordPilotReleaseEvidence} />
          )}
          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>
                  {state.role === 'owner' ? 'Today’s role-visible visits' : 'Role-visible visits'}
                </h2>
                <p className="section-card__subtitle">
                  {state.role === 'owner'
                    ? `${ownerProjection.today.localDate ?? 'Date unavailable'} · ${ownerProjection.today.timeZone}`
                    : 'No availability, route, or weather state is inferred'}
                </p>
              </div>
              <Link className="link-button" to="/dispatch">
                Open dispatch <ArrowRight size={12} />
              </Link>
            </div>
            {visibleDashboardVisits.length > 0 ? (
              <ul className="schedule-list">
                {visibleDashboardVisits.map((visit) => (
                  <li className="schedule-row" key={visit.id}>
                    <span className="schedule-row__time">{visit.startsAt}</span>
                    <span className="schedule-row__line" aria-hidden="true" />
                    <div>
                      <p className="schedule-row__title">
                        {visit.customerName} · {visit.service}
                      </p>
                      <p className="schedule-row__detail">
                        {visit.date} · {visit.jobNumber} · {visit.address}
                      </p>
                    </div>
                    <Badge tone={visit.status === 'complete' ? 'positive' : 'neutral'} dot>
                      {visit.status.replaceAll('_', ' ')}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="incident-empty">
                <CalendarClock size={22} />
                <div>
                  <h3>
                    {state.role === 'owner'
                      ? 'No company-local visits today'
                      : 'No visits in this projection'}
                  </h3>
                  <p>
                    {state.role === 'owner'
                      ? 'This uses exact server visit starts in the company timezone; it does not claim future capacity.'
                      : 'Technicians see assigned visits only; other roles receive company scope.'}
                  </p>
                </div>
              </div>
            )}
          </Card>

          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Lead stages</h2>
                <p className="section-card__subtitle">Counts only; no guessed opportunity value</p>
              </div>
              <Link className="link-button" to="/pipeline">
                Open pipeline <ArrowRight size={12} />
              </Link>
            </div>
            <div className="pipeline-pulse">
              {stageOrder.map((stage) => {
                const count = state.leads.filter((lead) => lead.stage === stage).length;
                return (
                  <div className="pulse-row" key={stage}>
                    <span>{stage.replaceAll('_', ' ')}</span>
                    <Progress
                      value={count}
                      max={Math.max(1, state.leads.length)}
                      label={`${stage} leads`}
                      tone="green"
                    />
                    <strong>—</strong>
                    <small>{count}</small>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <aside className="dashboard-stack">
          {profitabilityKpis && (
            <LiveFinancialEvidenceCard
              kpis={profitabilityKpis}
              timeZone={state.live?.companyTimezone ?? 'UTC'}
            />
          )}
          {state.role === 'owner' && (
            <Card className="section-card">
              <div className="section-card__header">
                <div>
                  <h2>Owner action queue</h2>
                  <p className="section-card__subtitle">
                    {ownerProjection.mode} mode · sourced {ownerProjection.sourcedAt}
                  </p>
                </div>
                <Badge tone="info">{ownerProjection.actions.length} actions</Badge>
              </div>
              {ownerProjection.actions.length > 0 ? (
                <ul className="briefing-list">
                  {ownerProjection.actions.map((item) => (
                    <li className="briefing-item" key={item.id}>
                      <span className="briefing-item__icon">
                        <ShieldAlert size={14} />
                      </span>
                      <Link className="briefing-item__link" to={item.href}>
                        <p className="briefing-item__title">{item.title}</p>
                        <p className="briefing-item__detail">
                          <strong>Fact:</strong> {item.fact}
                        </p>
                        <p className="briefing-item__detail">
                          <strong>Next safe action:</strong> {item.recommendation}
                        </p>
                        {item.blockedBy && (
                          <p className="briefing-item__detail">
                            <strong>Blocked by:</strong> {item.blockedBy}
                          </p>
                        )}
                        <small className="briefing-item__source">Source: {item.source}</small>
                      </Link>
                      <Badge tone={item.priority === 'P0' ? 'danger' : 'warning'}>
                        {item.priority}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="incident-empty">
                  <CheckCircle2 size={22} />
                  <div>
                    <h3>No role-visible action is due</h3>
                    <p>This does not claim that provider-side or hidden records are clear.</p>
                  </div>
                </div>
              )}
              {ownerProjection.actions[0] && (
                <Link
                  className="button button--dark button--sm full-width"
                  to={ownerProjection.actions[0].href}
                >
                  Open highest-priority action <ArrowRight size={13} />
                </Link>
              )}
              {ownerProjection.today.evidenceFacts.length > 0 && (
                <details className="briefing-unknowns">
                  <summary>
                    Current visit evidence ({ownerProjection.today.evidenceFacts.length})
                  </summary>
                  <ul>
                    {ownerProjection.today.evidenceFacts.map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                </details>
              )}
              <details className="briefing-unknowns">
                <summary>Known unknowns ({ownerProjection.unknowns.length})</summary>
                <ul>
                  {ownerProjection.unknowns.map((unknown) => (
                    <li key={unknown}>{unknown}</li>
                  ))}
                </ul>
              </details>
            </Card>
          )}
          {!profitabilityKpis && (
            <Card className="projection-warning">
              <ShieldAlert size={18} />
              <div>
                <strong>No company financial projection for this role</strong>
                <p>
                  StoryOps will not derive profitability, receivables, or payment state from
                  assignment-visible records. Route, weather, capacity, and AI activity also require
                  their own verified read models.
                </p>
              </div>
            </Card>
          )}
          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Integration records</h2>
                <p className="section-card__subtitle">Secret-safe connection state</p>
              </div>
              <Bot size={18} color="#1f6d5e" />
            </div>
            {state.dataMode === 'supabase' && (
              <div className="template-row">
                <span>
                  <strong>Controlled launch</strong>
                  <small>
                    {state.providerLaunch
                      ? `Authority version ${state.providerLaunch.launch.version}`
                      : 'No authoritative readback'}
                  </small>
                </span>
                <Badge
                  tone={
                    state.providerLaunch?.launch.launchAuthorized
                      ? 'positive'
                      : state.providerLaunch?.launch.status === 'invalidated'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {state.providerLaunch?.launch.status.replaceAll('_', ' ') ??
                    'unknown · starts blocked'}
                </Badge>
              </div>
            )}
            {state.integrations.map((integration) => (
              <div className="template-row" key={integration.id}>
                <span>
                  <strong>{integration.name}</strong>
                  <small>{integration.mode}</small>
                </span>
                <Badge
                  tone={
                    integration.status === 'Healthy'
                      ? 'positive'
                      : integration.status === 'Degraded'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {integration.status}
                </Badge>
              </div>
            ))}
            <Link className="button button--secondary button--sm full-width" to="/integrations">
              Integration health
            </Link>
          </Card>
        </aside>
      </div>
    </div>
  );
}
