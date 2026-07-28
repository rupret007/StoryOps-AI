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
import { Link } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Card, Metric, PageHeader, Progress } from '@/components/ui/Primitives';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function DashboardPage() {
  const { state } = useStoryOps();
  const ownerFirstName = state.setupProfile?.ownerName.trim().split(/\s+/u)[0] || 'Owner';
  const pendingApprovals = state.approvals.filter((item) => item.status === 'pending').length;
  const newLeads = state.leads.filter((lead) => lead.stage === 'new').length;
  const outstanding = state.invoices.reduce(
    (sum, invoice) => sum + Number(invoice.balance.replaceAll(',', '')),
    0,
  );

  if (state.dataMode === 'supabase') return <LiveDashboardPage />;

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
  const { state } = useStoryOps();
  const pendingApprovals = state.approvals.filter((item) => item.status === 'pending').length;
  const newLeads = state.leads.filter((lead) => lead.stage === 'new').length;
  const outstanding = state.invoices.reduce(
    (sum, invoice) => sum + Number(invoice.balance.replaceAll(',', '')),
    0,
  );
  const stageOrder = ['new', 'qualified', 'estimated', 'quoted', 'booked'] as const;

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
          label="Open receivables"
          value={money.format(outstanding)}
          delta={`${state.invoices.filter((invoice) => invoice.status === 'past_due').length} past due`}
          icon={<CircleDollarSign size={18} />}
          tone="orange"
        />
        <Metric
          label="Pending approvals"
          value={String(pendingApprovals)}
          delta="exact server payloads"
          icon={<ShieldAlert size={18} />}
          tone="plum"
        />
      </section>

      <div className="dashboard-grid">
        <div className="dashboard-stack">
          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Role-visible visits</h2>
                <p className="section-card__subtitle">
                  No availability, route, or weather state is inferred
                </p>
              </div>
              <Link className="link-button" to="/dispatch">
                Open dispatch <ArrowRight size={12} />
              </Link>
            </div>
            {state.visits.length > 0 ? (
              <ul className="schedule-list">
                {state.visits.slice(0, 6).map((visit) => (
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
                  <h3>No visits in this projection</h3>
                  <p>Technicians see assigned visits only; other roles receive company scope.</p>
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
          <Card className="projection-warning">
            <ShieldAlert size={18} />
            <div>
              <strong>No generated briefing is projected</strong>
              <p>
                StoryOps will not fabricate route, weather, capacity, profitability, or AI activity.
                Those panels require verified read-model fields.
              </p>
            </div>
          </Card>
          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Integration records</h2>
                <p className="section-card__subtitle">Secret-safe connection state</p>
              </div>
              <Bot size={18} color="#1f6d5e" />
            </div>
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
