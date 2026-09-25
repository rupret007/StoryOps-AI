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
import {
  deriveOwnerCommandCenter,
  explainNextOwnerAction,
  ownerActionGlanceLine,
  ownerActionSurface,
  ownerTodayVisitEmptyCopy,
  ownerTodayVisitGapNote,
  type OwnerActionItem,
  type OwnerCommandCenterProjection,
} from '@/core/pilot/ownerCommandCenter';
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

function ownerActionKindLabel(kind: OwnerActionItem['kind']): string {
  return kind === 'follow_up' ? 'follow-up' : kind;
}

function ownerQueueCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function OwnerActionEntities({ entities }: { entities?: OwnerActionItem['entities'] }) {
  if (!entities || entities.length === 0) return null;
  return (
    <ul className="owner-action-entities" aria-label="Affected records">
      {entities.map((entity) => (
        <li key={`${entity.href}:${entity.label}`}>
          <Link className="owner-action-entity" to={entity.href}>
            {entity.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function OwnerActionKindIcon({ kind }: { kind: OwnerActionItem['kind'] }) {
  if (kind === 'decision') return <CheckCircle2 size={14} />;
  if (kind === 'follow_up') return <ArrowRight size={14} />;
  return <ShieldAlert size={14} />;
}

function OwnerNextActionStrip({ action }: { action: OwnerActionItem }) {
  return (
    <section className="owner-next-action" aria-labelledby="owner-next-action-heading">
      <div className="owner-next-action__header">
        <div>
          <p className="owner-next-action__eyebrow">Next safe action</p>
          <h2 id="owner-next-action-heading">Do this next</h2>
          <p className="owner-next-action__why">{explainNextOwnerAction(action)}</p>
        </div>
        <Badge
          tone={action.priority === 'P0' ? 'danger' : action.kind === 'hold' ? 'warning' : 'info'}
        >
          {action.priority} {ownerActionKindLabel(action.kind)}
        </Badge>
      </div>
      <h3 className="owner-next-action__title">{action.title}</h3>
      <dl className="owner-next-action__facts">
        <div>
          <dt>What is true</dt>
          <dd>{action.fact}</dd>
        </div>
        <div>
          <dt>Do this</dt>
          <dd className="owner-next-action__do">{action.recommendation}</dd>
        </div>
        {action.blockedBy && (
          <div>
            <dt>Still blocked by</dt>
            <dd>{action.blockedBy}</dd>
          </div>
        )}
      </dl>
      <OwnerActionEntities entities={action.entities} />
      <p className="owner-next-action__source">Source: {action.source}</p>
    </section>
  );
}

function OwnerCommandGlance({ projection }: { projection: OwnerCommandCenterProjection }) {
  const { glance, nextAction } = projection;
  const countLabel = (value: number | null) => (value === null ? 'withheld' : String(value));
  const countText = (value: number | null) => (value === null ? '—' : String(value));
  return (
    <section
      className={glance.countsKnown ? 'owner-glance' : 'owner-glance owner-glance--stale'}
      aria-label="Phone glance"
    >
      <p className="owner-glance__eyebrow">Phone glance</p>
      <h2>{glance.headline}</h2>
      <p className="owner-glance__caveat">{glance.caveat}</p>
      {!glance.countsKnown && (
        <p className="owner-glance__alert" role="alert">
          Fail closed. Do not treat this screen as current.
        </p>
      )}
      <dl className="owner-glance__counts">
        <div>
          <dt>Holds</dt>
          <dd aria-label={countLabel(glance.holds)}>{countText(glance.holds)}</dd>
        </div>
        <div>
          <dt>Decisions</dt>
          <dd aria-label={countLabel(glance.decisions)}>{countText(glance.decisions)}</dd>
        </div>
        <div>
          <dt>Follow-ups</dt>
          <dd aria-label={countLabel(glance.followUps)}>{countText(glance.followUps)}</dd>
        </div>
      </dl>
      {nextAction && (
        <>
          <p className="owner-glance__next">{nextAction.title}</p>
          <p className="owner-glance__line">{ownerActionGlanceLine(nextAction)}</p>
          <Link className="button button--dark button--md full-width" to={nextAction.href}>
            Do this: Open {ownerActionSurface(nextAction.href)}{' '}
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </>
      )}
      <p className="owner-glance__clock">{glance.clockLabel}</p>
    </section>
  );
}

const ownerQueueGroups = [
  {
    key: 'holds',
    heading: 'Holds that stop work',
    detail: 'These block completion, automation, or money until you clear them.',
  },
  {
    key: 'decisions',
    heading: 'Decisions',
    detail: 'These wait on your yes or no. They do not stop field work by themselves.',
  },
  {
    key: 'followUps',
    heading: 'Follow-ups',
    detail: 'Do these after holds. A follow-up is not proof that a provider already succeeded.',
  },
] as const;

function OwnerActionGroup({
  heading,
  detail,
  items,
  nextActionId,
  countsKnown,
}: {
  heading: string;
  detail: string;
  items: OwnerActionItem[];
  nextActionId?: string;
  countsKnown: boolean;
}) {
  return (
    <section className="owner-queue-group" aria-label={heading}>
      <h3 className="owner-queue-group__title">
        {heading} <span>{countsKnown ? items.length : '—'}</span>
      </h3>
      <p className="owner-queue-group__detail">{detail}</p>
      {items.length === 0 ? (
        <p className="owner-queue-empty">
          {countsKnown
            ? 'None in this projection. This is not a clearance.'
            : 'Count withheld. Zero would be a guess until the workspace is current.'}
        </p>
      ) : (
        <ul className="owner-queue-list">
          {items.map((item) => {
            const isNext = item.id === nextActionId;
            return (
              <li
                className={isNext ? 'owner-queue-row owner-queue-row--next' : 'owner-queue-row'}
                key={item.id}
              >
                <span className="owner-queue-row__icon" aria-hidden="true">
                  <OwnerActionKindIcon kind={item.kind} />
                </span>
                <div>
                  <div className="owner-queue-row__headline">
                    <Link to={item.href}>{item.title}</Link>
                    {isNext && <Badge tone="danger">Doing this next</Badge>}
                    <Badge tone={item.priority === 'P0' ? 'danger' : 'warning'}>
                      {item.priority}
                    </Badge>
                  </div>
                  <p className="owner-queue-row__glance">{ownerActionGlanceLine(item)}</p>
                  <p className="owner-queue-row__fact">{item.fact}</p>
                  <p className="owner-queue-row__do">
                    <span>Do: </span>
                    {item.recommendation}
                  </p>
                  {item.blockedBy && (
                    <p className="owner-queue-row__block">Blocked by {item.blockedBy}</p>
                  )}
                  <OwnerActionEntities entities={item.entities} />
                  <small className="owner-queue-row__source">Source: {item.source}</small>
                </div>
                <Link className="owner-queue-row__go" to={item.href}>
                  {ownerActionSurface(item.href)}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function OwnerActionQueue({
  projection,
  heading = 'What is waiting',
}: {
  projection: OwnerCommandCenterProjection;
  heading?: string;
}) {
  const stoppingHolds = projection.glance.p0Holds ?? 0;
  const otherHolds = projection.holds.length - stoppingHolds;
  const stoppingLabel =
    stoppingHolds === 1 ? '1 hold stops work' : `${stoppingHolds} holds stop work`;
  const behindLabel =
    otherHolds === 0
      ? ''
      : stoppingHolds === 0
        ? otherHolds === 1
          ? '1 hold still blocks a safe step'
          : `${otherHolds} holds still block a safe step`
        : ` · ${otherHolds} more ${otherHolds === 1 ? 'hold' : 'holds'}`;
  const holdTally = !projection.glance.countsKnown
    ? 'Counts withheld · not a live tally'
    : stoppingHolds === 0
      ? behindLabel || '0 holds stop work'
      : `${stoppingLabel}${behindLabel}`;
  return (
    <Card className="section-card owner-command-center">
      <div className="section-card__header">
        <div>
          <h2>{heading}</h2>
          <p className="owner-queue-tally">
            {projection.glance.countsKnown ? (
              <>
                {holdTally}
                {' · '}
                {ownerQueueCount(projection.decisions.length, 'decision')}
                {' · '}
                {ownerQueueCount(projection.followUps.length, 'follow-up')}
              </>
            ) : (
              holdTally
            )}
          </p>
          <p className="section-card__subtitle">
            {projection.mode} workspace · sourced {projection.sourcedAt}
          </p>
        </div>
        <Badge
          tone={projection.glance.countsKnown && projection.holds.length === 0 ? 'info' : 'danger'}
        >
          {!projection.glance.countsKnown
            ? 'Not current'
            : projection.holds.length === 0
              ? 'None in view'
              : 'Holds first'}
        </Badge>
      </div>
      {projection.nextAction && <OwnerNextActionStrip action={projection.nextAction} />}
      {!projection.glance.countsKnown && (
        <p className="owner-queue-stale">
          These rows are the last projection. They are not a live tally.
        </p>
      )}
      {ownerQueueGroups.map((group) => (
        <OwnerActionGroup
          key={group.key}
          heading={group.heading}
          detail={group.detail}
          items={projection[group.key]}
          nextActionId={projection.nextAction?.id}
          countsKnown={projection.glance.countsKnown}
        />
      ))}
      {projection.actions.length === 0 && projection.glance.countsKnown && (
        <div className="incident-empty">
          <ShieldAlert size={22} />
          <div>
            <h3>No role-visible action is due</h3>
            <p>This does not claim that provider-side or hidden records are clear.</p>
          </div>
        </div>
      )}
      {projection.today.evidenceFacts.length > 0 && (
        <details className="briefing-unknowns">
          <summary>Current visit evidence ({projection.today.evidenceFacts.length})</summary>
          <ul>
            {projection.today.evidenceFacts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </details>
      )}
      <details className="briefing-unknowns">
        <summary>Known unknowns ({projection.unknowns.length})</summary>
        <ul>
          {projection.unknowns.map((unknown) => (
            <li key={unknown}>{unknown}</li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

const leadStages = ['new', 'qualified', 'estimated', 'quoted', 'booked'] as const;

function LeadStageCounts({ leads }: { leads: DemoState['leads'] }) {
  return (
    <Card className="section-card">
      <div className="section-card__header">
        <div>
          <h2>Lead stages</h2>
          <p className="section-card__subtitle">Counts only. No guessed opportunity dollars.</p>
        </div>
        <Link className="link-button" to="/pipeline">
          Open pipeline <ArrowRight size={12} />
        </Link>
      </div>
      {leads.length === 0 ? (
        <div className="incident-empty">
          <Inbox size={22} />
          <div>
            <h3>No leads in this projection</h3>
            <p>This is not an empty pipeline. Hidden or unscoped leads are not counted here.</p>
          </div>
        </div>
      ) : (
        <div className="pipeline-pulse">
          {leadStages.map((stage) => {
            const count = leads.filter((lead) => lead.stage === stage).length;
            return (
              <div className="pulse-row" key={stage}>
                <span>{stage}</span>
                <Progress
                  value={count}
                  max={Math.max(1, leads.length)}
                  label={`${stage} leads`}
                  tone="green"
                />
                <strong>—</strong>
                <small>{count}</small>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

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
  const pastDueInvoices = state.invoices.filter((invoice) => invoice.status === 'past_due').length;

  if (state.dataMode === 'supabase') return <LiveDashboardPage />;

  const rehearsal = deriveSandboxPilotRehearsal(state);
  const ownerProjection = deriveOwnerCommandCenter(state);

  return (
    <div className="page">
      <OwnerCommandGlance projection={ownerProjection} />
      <PageHeader
        eyebrow="Command center"
        title={`Good morning, ${ownerFirstName}.`}
        description="Sandbox records only. Do the next safe action before anything else on this page. Nothing here is live payment, route, weather, or dispatch evidence."
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

      <OwnerActionQueue projection={ownerProjection} />

      <section className="metrics-grid" aria-label="Sandbox record counts">
        <Metric
          label="New leads"
          value={String(newLeads)}
          delta="sandbox records · not a pipeline dollar value"
          icon={<Inbox size={18} />}
        />
        <Metric
          label="Pending approvals"
          value={String(pendingApprovals)}
          delta="exact payloads waiting on you"
          icon={<ShieldAlert size={18} />}
          tone="blue"
        />
        <Metric
          label="Open invoice balances"
          value={money.format(outstanding)}
          delta={`${pastDueInvoices} past due in this sandbox · not a ledger`}
          icon={<CircleDollarSign size={18} />}
          tone="orange"
        />
        <Metric
          label="Visits"
          value={String(state.visits.length)}
          delta="sandbox schedule · not live capacity"
          icon={<CalendarClock size={18} />}
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

          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Sandbox visits</h2>
                <p className="section-card__subtitle">
                  Records in this workspace. Status here is not live dispatch evidence.
                </p>
              </div>
              <Link className="link-button" to="/dispatch">
                Open dispatch <ArrowRight size={12} style={{ verticalAlign: 'middle' }} />
              </Link>
            </div>
            {state.visits.length > 0 ? (
              <ul className="schedule-list">
                {state.visits.map((visit) => (
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
                    <Badge
                      tone={
                        visit.status === 'weather_hold' || visit.status === 'paused'
                          ? 'danger'
                          : visit.status === 'complete'
                            ? 'positive'
                            : 'neutral'
                      }
                      dot
                    >
                      {visit.status.replaceAll('_', ' ')}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="incident-empty">
                <CalendarClock size={22} />
                <div>
                  <h3>No sandbox visits are projected</h3>
                  <p>This list comes from local visit fixtures, not a live calendar.</p>
                </div>
              </div>
            )}
          </Card>

          <LeadStageCounts leads={state.leads} />
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

          <Card className="projection-warning">
            <ShieldAlert size={18} />
            <div>
              <strong>No invented profit or capacity</strong>
              <p>
                This sandbox does not show booked dollars, margin, or crew utilization. Those
                numbers are not in the workspace records. Use the next safe action above.
              </p>
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
        </aside>
      </div>
    </div>
  );
}

function LiveDashboardPage() {
  const { state, actions } = useStoryOps();
  const pendingApprovals = state.approvals.filter((item) => item.status === 'pending').length;
  const newLeads = state.leads.filter((lead) => lead.stage === 'new').length;
  const ownerProjection = deriveOwnerCommandCenter(state);
  const profitabilityKpis = state.live?.profitabilityKpis;
  const visibleDashboardVisits =
    state.role === 'owner' ? ownerProjection.today.visits : state.visits;

  const todayGap =
    state.role === 'owner'
      ? ownerTodayVisitGapNote(ownerProjection.today, ownerProjection.freshness)
      : undefined;
  const todayEmpty =
    state.role === 'owner'
      ? ownerTodayVisitEmptyCopy(ownerProjection.today, ownerProjection.freshness)
      : {
          heading: 'No visits in this projection',
          detail: 'Technicians see assigned visits only; other roles receive company scope.',
        };

  return (
    <div className="page">
      {state.role === 'owner' && <OwnerCommandGlance projection={ownerProjection} />}
      <PageHeader
        eyebrow="Authenticated command center"
        title={state.live?.companyName ?? 'WashOps workspace'}
        description={
          state.role === 'owner'
            ? `Do the next safe action first. Server-derived owner workspace · refreshed ${state.live?.serverTime ?? 'unknown time'}.`
            : `Server-derived ${state.role} membership · workspace refreshed ${state.live?.serverTime ?? 'unknown time'}.`
        }
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

      {state.role === 'owner' && <OwnerActionQueue projection={ownerProjection} />}

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
                    ? ownerProjection.freshness === 'untimed'
                      ? `Today is unknown · ${ownerProjection.today.timeZone}`
                      : `${ownerProjection.today.localDate ?? 'Date unavailable'} · ${ownerProjection.today.timeZone}`
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
                  <h3>{todayEmpty.heading}</h3>
                  <p>{todayEmpty.detail}</p>
                </div>
              </div>
            )}
            {todayGap && <p className="owner-queue-stale">{todayGap}</p>}
          </Card>

          <LeadStageCounts leads={state.leads} />
        </div>

        <aside className="dashboard-stack">
          {profitabilityKpis && (
            <LiveFinancialEvidenceCard
              kpis={profitabilityKpis}
              timeZone={state.live?.companyTimezone ?? 'UTC'}
            />
          )}
          {!profitabilityKpis && (
            <Card className="projection-warning">
              <ShieldAlert size={18} />
              <div>
                <strong>No company financial projection for this role</strong>
                <p>
                  WashOps will not derive profitability, receivables, or payment state from
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
