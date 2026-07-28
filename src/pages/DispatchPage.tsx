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
import { useState } from 'react';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Button, Card, PageHeader, Progress } from '@/components/ui/Primitives';

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
              onClick={actions.bookJob}
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
                onClick={actions.bookJob}
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
  const canBook =
    Boolean(state.live?.job) &&
    !state.live?.visit &&
    ['pending_deposit', 'ready_to_schedule'].includes(state.live?.jobStatus ?? '');

  return (
    <div className="page page--wide">
      <PageHeader
        eyebrow="Authenticated calendar & dispatch"
        title="Role-visible visits"
        description="This screen shows persisted visit windows only. Capacity, routing, weather, and booking are not inferred from missing projection fields."
        actions={
          <>
            <Button variant="secondary" onClick={() => void actions.reloadLiveWorkspace()}>
              Refresh workspace
            </Button>
            {canBook && (
              <Button disabled={!can('dispatch.manage')} onClick={actions.bookJob}>
                Book verified job
              </Button>
            )}
          </>
        }
      />

      <Card className="projection-warning">
        {canBook ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
        <div>
          <strong>
            {canBook ? 'Server verification runs at booking' : 'Only persisted visits are shown'}
          </strong>
          <p>
            Booking requires an accepted deterministic quote, provider-reconciled deposit, current
            job version, active crew skills and inspected equipment, a free time window, and fresh
            eligible route and weather evidence. Any stale or ambiguous condition fails closed.
          </p>
        </div>
      </Card>

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
