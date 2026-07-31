import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudSun,
  MapPinned,
  Plus,
  Route,
  Sparkles,
  Truck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Button, Card, PageHeader, Progress } from '@/components/ui/Primitives';
import { schedulingLocalDateTimeToIso } from '@/core/scheduling/window';
import type { SchedulingSuggestionsResponse } from '@/core/scheduling/suggestions';
import type { LiveSchedulingEvidenceResult } from '@/state/model';

const calendarCells = Array.from({ length: 54 }, (_, index) => index);
const times = ['8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM'];
const days = [
  ['MON', '27'],
  ['TUE', '28'],
  ['WED', '29'],
  ['THU', '30'],
  ['FRI', '31'],
];
const formatMoney = (amount: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount));

interface DispatchProposalState {
  jobId: string;
  proposedStart: string;
  crewId?: string;
  evidence?: LiveSchedulingEvidenceResult;
  verificationError: string;
  verifying: boolean;
}

export function DispatchPage() {
  const { state, actions, can } = useStoryOps();
  const [view, setView] = useState<'week' | 'day' | 'map'>('week');
  const [weekOffset, setWeekOffset] = useState(0);
  const booked = state.leads.find((lead) => lead.id === 'lead-morgan')?.stage === 'booked';
  const weekStart = new Date(2026, 6, 27 + weekOffset * 7);
  const weekEnd = new Date(2026, 6, 31 + weekOffset * 7);
  const dateLabel = `${weekStart.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })} – ${weekEnd.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;

  if (state.dataMode === 'supabase') return <LiveDispatchPage />;

  return (
    <div className="page page--wide">
      <PageHeader
        eyebrow="Calendar & dispatch"
        title="Put the right work in the right window"
        description="Synthetic sandbox schedule: no live booking, route, weather, payment, or availability evidence is shown."
        actions={
          <>
            <Button
              variant="secondary"
              disabled={!can('dispatch.manage')}
              onClick={actions.optimizeRoutes}
              icon={<MapPinned size={15} />}
            >
              Optimize route
            </Button>
            <Button
              disabled={!can('dispatch.manage')}
              onClick={() => actions.bookJob()}
              icon={<Plus size={15} />}
            >
              Book visit
            </Button>
          </>
        }
      />

      <div className="dispatch-status-strip">
        <div>
          <span className="dispatch-status-strip__icon">
            <Truck size={16} />
          </span>
          <div>
            <strong>Owner crew</strong>
            <small>19.5 / 27 available hours booked</small>
          </div>
          <Progress value={72} label="Weekly crew capacity" />
        </div>
        <div>
          <span className="dispatch-status-strip__icon dispatch-status-strip__icon--blue">
            <CloudSun size={16} />
          </span>
          <div>
            <strong>Weather policy</strong>
            <small>Synthetic scenario · live refresh required before dispatch</small>
          </div>
          <Badge tone="warning">1 refresh</Badge>
        </div>
        <div>
          <span className="dispatch-status-strip__icon dispatch-status-strip__icon--orange">
            <Route size={16} />
          </span>
          <div>
            <strong>Route scenario</strong>
            <small>Synthetic route matrix · VROOM workflow demo</small>
          </div>
          <Badge tone="neutral">Scenario</Badge>
        </div>
      </div>

      <div className="dispatch-toolbar">
        <div className="toolbar-group">
          <Button
            variant="secondary"
            size="sm"
            aria-label="Previous week"
            onClick={() => setWeekOffset((offset) => offset - 1)}
          >
            <ChevronLeft size={15} />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setWeekOffset(0)}>
            Today
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Next week"
            onClick={() => setWeekOffset((offset) => offset + 1)}
          >
            <ChevronRight size={15} />
          </Button>
          <strong>{dateLabel}</strong>
        </div>
        <div className="segmented">
          <button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>
            Week
          </button>
          <button type="button" aria-pressed={view === 'day'} onClick={() => setView('day')}>
            Day
          </button>
          <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>
            Map
          </button>
        </div>
      </div>

      <div className="dispatch-grid">
        <Card className="dispatch-backlog">
          <div className="section-card__header">
            <div>
              <h2>Booking queue</h2>
              <p className="section-card__subtitle">Accepted or ready-to-schedule work</p>
            </div>
            <Badge tone="neutral">2</Badge>
          </div>

          {!booked && (
            <article className="backlog-card backlog-card--highlight">
              <div className="backlog-card__top">
                <Badge tone="accent">Recommended</Badge>
                <span>{formatMoney(state.estimate.total)}</span>
              </div>
              <p className="backlog-card__title">Morgan Ellis</p>
              <p className="backlog-card__service">
                Driveway + gutters · {Math.floor(state.estimate.durationMinutes / 60)}h{' '}
                {state.estimate.durationMinutes % 60}m
              </p>
              <div className="booking-facts">
                <span>
                  <CheckCircle2 size={11} /> Skills
                </span>
                <span>
                  <CheckCircle2 size={11} /> Equipment
                </span>
                <span>
                  <AlertTriangle size={11} /> Weather refresh
                </span>
              </div>
              <Button
                size="sm"
                className="full-width"
                disabled={!can('dispatch.manage')}
                onClick={() => actions.bookJob()}
              >
                Book Fri 9:00 AM
              </Button>
            </article>
          )}
          <article className="backlog-card">
            <div className="backlog-card__top">
              <Badge tone="neutral">Sandbox deposit fixture</Badge>
              <span>$472</span>
            </div>
            <p className="backlog-card__title">Sam Rivera</p>
            <p className="backlog-card__service">Patio pressure wash · 2h 10m</p>
            <div className="backlog-card__meta">
              <span>Plano · DFW-B</span>
              <span>After Aug 3</span>
            </div>
          </article>
          <div className="dispatch-hint">
            <Sparkles size={15} />
            <p>
              Scheduling agent may reserve low-risk eligible windows. It cannot invent availability
              or override weather, skills, equipment, or customer constraints.
            </p>
          </div>
        </Card>

        <Card className="dispatch-calendar">
          {view === 'week' && weekOffset === 0 ? (
            <>
              <div className="calendar-header">
                <div />
                {days.map(([day, date]) => (
                  <div key={day}>
                    {day}
                    <strong>{date}</strong>
                  </div>
                ))}
              </div>
              <div className="calendar-grid">
                {calendarCells.map((cell) =>
                  cell % 6 === 0 ? (
                    <div className="calendar-time" key={cell}>
                      {times[cell / 6]}
                    </div>
                  ) : (
                    <div className="calendar-cell" key={cell} />
                  ),
                )}
                <div className="calendar-event" style={{ gridColumn: 3, gridRow: '4 / span 4' }}>
                  <strong>Riley Brooks</strong>
                  <span>10:30–2:30 · JOB-1032</span>
                  <small>Southlake · synthetic route scenario</small>
                </div>
                <div
                  className="calendar-event calendar-event--blue"
                  style={{ gridColumn: 4, gridRow: '2 / span 2' }}
                >
                  <strong>Equipment inspection</strong>
                  <span>9:00–10:00</span>
                </div>
                <div
                  className="calendar-event calendar-event--orange"
                  style={{ gridColumn: 5, gridRow: '6 / span 2' }}
                >
                  <strong>Taylor Nguyen</strong>
                  <span>1:00–3:00 · recurring</span>
                </div>
                {booked && (
                  <div className="calendar-event" style={{ gridColumn: 6, gridRow: '2 / span 4' }}>
                    <strong>Morgan Ellis</strong>
                    <span>9:00–12:35 · JOB-1048</span>
                    <small>Weather refresh before dispatch</small>
                  </div>
                )}
              </div>
            </>
          ) : view === 'day' ? (
            <div className="dispatch-alternate-view">
              <CalendarDays size={24} />
              <h2>Tuesday, July 28</h2>
              <p>10:30 AM · Riley Brooks · JOB-1032 · owner crew · synthetic route scenario</p>
              <p>4:30 PM · Weekly equipment inspection · evidence required</p>
            </div>
          ) : view === 'map' ? (
            <div className="dispatch-alternate-view">
              <MapPinned size={24} />
              <h2>Owner crew route sequence</h2>
              <p>Home base → Southlake (24 min) → equipment inspection → home base</p>
              <p>Synthetic matrix only · no coordinate or provider route evidence</p>
            </div>
          ) : (
            <div className="dispatch-alternate-view">
              <CalendarDays size={24} />
              <h2>No visits in this sandbox week</h2>
              <p>Return to Today to view the loaded DFW dispatch packet.</p>
              <Button variant="secondary" onClick={() => setWeekOffset(0)}>
                Return to today
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function LiveDispatchPage() {
  const { state, actions, can } = useStoryOps();
  const readyJobs = state.live?.readyToScheduleJobs ?? [];
  const dispatchJob = state.live?.dispatchJob;
  const canBook =
    Boolean(dispatchJob) &&
    state.selectedDispatchJobId === dispatchJob?.id &&
    can('dispatch.manage');
  const configuration = state.companyConfiguration?.published;
  const timeZone = state.live?.companyTimezone ?? configuration?.territory.timezone ?? 'UTC';
  const durationMinutes = dispatchJob?.estimatedDurationMinutes ?? 0;
  const [suggestionState, setSuggestionState] = useState<{
    jobId: string;
    loading: boolean;
    result?: SchedulingSuggestionsResponse;
    error?: string;
  }>();
  const activeSuggestions =
    suggestionState?.jobId === dispatchJob?.id ? suggestionState : undefined;
  const loadSuggestions = async () => {
    if (!dispatchJob) return;
    const jobId = dispatchJob.id;
    setSuggestionState({ jobId, loading: true });
    try {
      const result = await actions.loadSchedulingSuggestions();
      setSuggestionState((current) =>
        current?.jobId === jobId
          ? {
              jobId,
              loading: false,
              ...(result ? { result } : { error: 'No current suggestion result was returned.' }),
            }
          : current,
      );
    } catch (error) {
      setSuggestionState((current) =>
        current?.jobId === jobId
          ? {
              jobId,
              loading: false,
              error: error instanceof Error ? error.message : 'Suggestions could not be loaded.',
            }
          : current,
      );
    }
  };
  useEffect(() => {
    if (!canBook || !dispatchJob) {
      return;
    }
    void loadSuggestions();
    // The selected immutable job identity/version is the suggestion query key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canBook, dispatchJob?.id, dispatchJob?.version]);
  const firstSuggestion = activeSuggestions?.result?.candidates[0];
  const suggestedStart = firstSuggestion?.localStart ?? '';
  const [proposal, setProposal] = useState<DispatchProposalState>();
  const activeProposal = proposal?.jobId === dispatchJob?.id ? proposal : undefined;
  const proposedStart = activeProposal?.proposedStart ?? suggestedStart;
  const proposedCrewId = activeProposal?.crewId ?? firstSuggestion?.crewId;
  const evidence = activeProposal?.evidence;
  const verificationError = activeProposal?.verificationError ?? '';
  const verifying = activeProposal?.verifying ?? false;
  const updateProposal = (patch: Partial<Omit<DispatchProposalState, 'jobId'>>) => {
    if (!dispatchJob) return;
    setProposal((current) => ({
      jobId: dispatchJob.id,
      proposedStart: current?.jobId === dispatchJob.id ? current.proposedStart : suggestedStart,
      crewId: current?.jobId === dispatchJob.id ? current.crewId : firstSuggestion?.crewId,
      evidence: current?.jobId === dispatchJob.id ? current.evidence : undefined,
      verificationError: current?.jobId === dispatchJob.id ? current.verificationError : '',
      verifying: current?.jobId === dispatchJob.id ? current.verifying : false,
      ...patch,
    }));
  };

  const verifyWindow = async () => {
    updateProposal({ evidence: undefined, verificationError: '' });
    if (!proposedStart || durationMinutes <= 0) {
      updateProposal({
        verificationError: 'Choose a window after the job has a deterministic duration.',
      });
      return;
    }
    try {
      const startsAt = schedulingLocalDateTimeToIso(proposedStart, timeZone);
      const endsAt = new Date(Date.parse(startsAt) + durationMinutes * 60_000).toISOString();
      updateProposal({ verifying: true });
      const result = await actions.refreshSchedulingEvidence({
        startsAt,
        endsAt,
        ...(proposedCrewId ? { crewId: proposedCrewId } : {}),
      });
      updateProposal({ evidence: result });
    } catch (error) {
      updateProposal({
        verificationError:
          error instanceof Error ? error.message : 'The proposed window is invalid.',
      });
    } finally {
      updateProposal({ verifying: false });
    }
  };
  const promotableReceipt = evidence?.bookable ? evidence.receipt : undefined;

  return (
    <div className="page page--wide">
      <PageHeader
        eyebrow="Authenticated calendar & dispatch"
        title="Booking queue & role-visible visits"
        description="Ready-to-schedule jobs are selected independently from historical field visits. Capacity, routing, weather, and booking are never inferred from missing projection fields."
        actions={
          <>
            <Button variant="secondary" onClick={() => void actions.reloadLiveWorkspace()}>
              Refresh workspace
            </Button>
            {canBook && (
              <Button
                variant={promotableReceipt ? 'primary' : 'secondary'}
                disabled={!can('dispatch.manage') || !promotableReceipt}
                onClick={() => actions.bookJob(promotableReceipt?.receiptId)}
              >
                Finalize reserved window
              </Button>
            )}
          </>
        }
      />

      <Card className="projection-warning">
        {canBook ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
        <div>
          <strong>
            {canBook
              ? 'Exact live verification is required before booking'
              : 'Only persisted visits are shown'}
          </strong>
          <p>
            Booking consumes one unexpired live scheduling receipt bound to the accepted price,
            provider-reconciled deposit, current job and operating baseline, reconciled calendar
            event, crew skills and inspected equipment, VROOM route, and NWS policy result. Missing,
            mock, stale, or ambiguous evidence fails closed.
          </p>
        </div>
      </Card>

      <Card className="section-card live-booking-card">
        <div className="section-card__header">
          <div>
            <h2>Ready-to-schedule job queue</h2>
            <p className="section-card__subtitle">
              Booking one job advances to the next eligible record; completed or selected field
              visits do not suppress this queue.
            </p>
          </div>
          <Badge tone={readyJobs.length > 0 ? 'accent' : 'neutral'}>{readyJobs.length} ready</Badge>
        </div>
        {readyJobs.length > 0 && dispatchJob ? (
          <div className="form-grid form-grid--2">
            <label className="input-group" htmlFor="dispatch-job-selection">
              <span>Booking job</span>
              <select
                id="dispatch-job-selection"
                className="input"
                value={dispatchJob.id}
                disabled={!can('dispatch.manage') || verifying}
                onChange={(event) => actions.selectDispatchJob(event.target.value)}
              >
                {readyJobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.jobNumber} · {job.customerName}
                  </option>
                ))}
              </select>
            </label>
            <div className="live-booking-card__duration">
              <span>Exact selected record</span>
              <strong>{dispatchJob.customerName}</strong>
              <small>
                {dispatchJob.propertyAddress} · {dispatchJob.estimatedDurationMinutes} deterministic
                minutes
              </small>
            </div>
          </div>
        ) : (
          <div className="dispatch-alternate-view">
            <CheckCircle2 size={24} />
            <h2>No jobs are ready to schedule</h2>
            <p>Historical visits remain visible below and do not count as booking eligibility.</p>
          </div>
        )}
      </Card>

      {canBook && (
        <Card className="section-card live-booking-card">
          <div className="section-card__header">
            <div>
              <h2>Ranked capacity-aware candidate windows</h2>
              <p className="section-card__subtitle">
                Current internal business-hours, lead-time, crew, equipment, inspection, visit, and
                buffer facts are ranked first. Calendar, route, and weather remain unknown until
                exact live validation.
              </p>
            </div>
            <Badge tone={promotableReceipt ? 'positive' : 'warning'}>
              {promotableReceipt ? 'Evidence ready' : 'Candidates only'}
            </Badge>
          </div>

          <div className="scheduling-suggestion-toolbar">
            <p>
              Suggestions never claim availability and never book automatically. Generated from
              current server facts at{' '}
              {activeSuggestions?.result
                ? new Intl.DateTimeFormat('en-US', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone,
                  }).format(new Date(activeSuggestions.result.generatedAt))
                : 'an unknown time'}
              .
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={activeSuggestions?.loading}
              onClick={() => void loadSuggestions()}
            >
              {activeSuggestions?.loading ? 'Ranking…' : 'Refresh candidates'}
            </Button>
          </div>

          {activeSuggestions?.result?.candidates.length ? (
            <ol className="scheduling-suggestion-list" aria-label="Ranked scheduling candidates">
              {activeSuggestions.result.candidates.map((candidate) => {
                const selected =
                  proposedStart === candidate.localStart && proposedCrewId === candidate.crewId;
                return (
                  <li key={`${candidate.window.start}:${candidate.crewId}`}>
                    <button
                      type="button"
                      className={`scheduling-suggestion${selected ? ' scheduling-suggestion--selected' : ''}`}
                      aria-pressed={selected}
                      onClick={() =>
                        updateProposal({
                          proposedStart: candidate.localStart,
                          crewId: candidate.crewId,
                          evidence: undefined,
                          verificationError: '',
                        })
                      }
                    >
                      <span className="scheduling-suggestion__rank">#{candidate.rank}</span>
                      <span>
                        <strong>
                          {new Intl.DateTimeFormat('en-US', {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                            timeZone,
                          }).format(new Date(candidate.window.start))}
                        </strong>
                        <small>
                          {candidate.crewName} · {candidate.eligibleCrewCount} internally eligible
                          crew{candidate.eligibleCrewCount === 1 ? '' : 's'} ·{' '}
                          {candidate.appointmentBufferMinutes}m buffer
                        </small>
                        <small>
                          Calendar, route, weather: unknown · exact live validation required
                        </small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : activeSuggestions?.loading ? (
            <p className="setup-note" role="status">
              Ranking bounded windows from current internal capacity facts…
            </p>
          ) : (
            <p className="setup-error" role="status">
              {activeSuggestions?.result?.message ??
                activeSuggestions?.error ??
                'No current internally eligible candidate is available. No availability was inferred.'}
            </p>
          )}

          <div className="form-grid form-grid--2 live-booking-card__form">
            <label className="input-group" htmlFor="live-booking-start">
              <span>Operator-selected start · {timeZone}</span>
              <input
                id="live-booking-start"
                className="input"
                type="datetime-local"
                value={proposedStart}
                disabled={!can('dispatch.manage') || verifying}
                onChange={(event) => {
                  updateProposal({
                    proposedStart: event.target.value,
                    crewId: dispatchJob?.assignedCrewId,
                    evidence: undefined,
                    verificationError: '',
                  });
                }}
              />
            </label>
            <div className="live-booking-card__duration">
              <span>Deterministic job duration</span>
              <strong>
                {durationMinutes > 0
                  ? `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`
                  : 'Unavailable'}
              </strong>
              <small>The end time is derived; it is never guessed by AI.</small>
            </div>
          </div>

          <div className="live-booking-card__actions">
            <Button
              disabled={
                !can('dispatch.manage') || !proposedStart || durationMinutes <= 0 || verifying
              }
              onClick={() => void verifyWindow()}
            >
              {verifying ? 'Checking providers…' : 'Verify & reserve exact window'}
            </Button>
            <p>
              In live mode this creates one deterministic Google Calendar event only after read-back
              reconciliation. It does not book the job; use the separate finalization action after
              reviewing the receipt. Sandbox or disabled mode performs no provider or booking
              mutation.
            </p>
          </div>

          {verificationError && (
            <p className="setup-error" role="alert">
              {verificationError}
            </p>
          )}

          {evidence && (
            <div
              className={`live-booking-card__receipt${evidence.bookable ? ' live-booking-card__receipt--ready' : ''}`}
              role="status"
            >
              {evidence.bookable && evidence.receipt ? (
                <>
                  <CheckCircle2 size={18} />
                  <div>
                    <strong>
                      Live evidence is ready; the job is not booked until you finalize it
                    </strong>
                    <p>
                      Crew {evidence.receipt.crewId.slice(0, 8)} · calendar event{' '}
                      {evidence.receipt.calendarEventId} · expires{' '}
                      {new Intl.DateTimeFormat('en-US', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone,
                      }).format(new Date(evidence.receipt.expiresAt))}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <AlertTriangle size={18} />
                  <div>
                    <strong>{evidence.reasonCode.replaceAll('_', ' ')}</strong>
                    <p>{evidence.message}</p>
                  </div>
                </>
              )}
            </div>
          )}
        </Card>
      )}

      <Card className="section-card">
        <div className="section-card__header">
          <div>
            <h2>Current visit windows</h2>
            <p className="section-card__subtitle">
              {state.visits.length} visit{state.visits.length === 1 ? '' : 's'} returned for{' '}
              {state.role}
            </p>
          </div>
          <Badge tone="positive">Server projection</Badge>
        </div>
        {state.visits.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Window</th>
                  <th>Job</th>
                  <th>Customer</th>
                  <th>Property</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {state.visits.map((visit) => (
                  <tr key={visit.id}>
                    <td>{visit.date}</td>
                    <td>
                      {visit.startsAt}–{visit.endsAt}
                    </td>
                    <td>{visit.jobNumber}</td>
                    <td>{visit.customerName}</td>
                    <td>{visit.address}</td>
                    <td>
                      <Badge tone={visit.status === 'complete' ? 'positive' : 'neutral'} dot>
                        {visit.status.replaceAll('_', ' ')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dispatch-alternate-view">
            <CalendarDays size={24} />
            <h2>No role-visible visits</h2>
            <p>Technician work is assignment-scoped by the server.</p>
          </div>
        )}
      </Card>
    </div>
  );
}
