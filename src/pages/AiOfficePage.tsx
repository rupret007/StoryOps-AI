import {
  BrainCircuit,
  CalendarCheck2,
  CheckCircle2,
  CircleDollarSign,
  FileSearch,
  Headphones,
  Megaphone,
  MessageSquareText,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { useState } from 'react';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Button, Card, PageHeader } from '@/components/ui/Primitives';

const agents = [
  {
    name: 'Intake',
    detail: 'Qualifies inquiries only from verified customer facts and channel consent.',
    icon: Headphones,
    status: 'Active',
  },
  {
    name: 'Estimating',
    detail: 'Calls deterministic pricing tools; never supplies a measurement or price.',
    icon: FileSearch,
    status: 'Active',
  },
  {
    name: 'Scheduling',
    detail: 'Reads capacity, route, equipment, weather, and calendar truth.',
    icon: CalendarCheck2,
    status: 'Active',
  },
  {
    name: 'Follow-up',
    detail: 'Queues consent-checked messages and review requests through provider policy.',
    icon: MessageSquareText,
    status: 'Active',
  },
  {
    name: 'Marketing',
    detail: 'Drafts campaigns; all bulk sends remain approval-gated.',
    icon: Megaphone,
    status: 'Paused',
  },
  {
    name: 'Finance',
    detail: 'Issues matched invoices and reconciles verified provider state.',
    icon: CircleDollarSign,
    status: 'Active',
  },
  {
    name: 'Safety',
    detail: 'Checks evidence and SOP bounds; cannot invent chemical instructions.',
    icon: ShieldCheck,
    status: 'Active',
  },
  {
    name: 'Briefing',
    detail: 'Produces read-only owner facts, risks, deadlines, and KPI context.',
    icon: Sparkles,
    status: 'Active',
  },
];

export function AiOfficePage() {
  const { state, actions, can } = useStoryOps();
  const [showRaw, setShowRaw] = useState(false);
  const [showRules, setShowRules] = useState(false);

  if (state.dataMode === 'supabase') return <LiveAiOfficePage />;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Synthetic AI office fixtures"
        title="Exercise the policy boundary without claiming a live agent ran"
        description="These local specialist, run, and trace fixtures demonstrate the guarded architecture. They do not prove an OpenAI call, customer contact, provider action, or production automation."
        actions={
          <>
            <Badge tone="accent" dot>
              7 agent fixtures
            </Badge>
            <Button
              variant="secondary"
              disabled={!can('automations.manage')}
              onClick={actions.runOwnerBriefing}
              icon={<RefreshCcw size={15} />}
            >
              Run briefing
            </Button>
          </>
        }
      />

      <Card className="projection-warning">
        <ShieldAlert size={18} />
        <div>
          <strong>Sandbox evidence only</strong>
          <p>
            Counts and traces below are synthetic local fixtures. Provider and customer truth
            requires authenticated server records and reconciliation.
          </p>
        </div>
      </Card>

      <Card className="orchestrator-card">
        <div className="orchestrator-card__icon">
          <BrainCircuit size={25} />
        </div>
        <div>
          <Badge tone="accent">Sandbox orchestrator fixture</Badge>
          <h2>One policy boundary across every channel</h2>
          <p>
            Web, chat, SMS, phone, and email normalize into the same intake event. The orchestrator
            delegates analysis, but only typed tools can change records or contact people.
          </p>
        </div>
        <div className="orchestrator-stats">
          <div>
            <strong>31</strong>
            <span>synthetic runs</span>
          </div>
          <div>
            <strong>4</strong>
            <span>fixture auto-actions</span>
          </div>
          <div>
            <strong>2</strong>
            <span>fixture approval holds</span>
          </div>
          <div>
            <strong>0</strong>
            <span>fixture tool failures</span>
          </div>
        </div>
      </Card>

      <section className="agent-grid" aria-label="AI specialists">
        {agents.map(({ name, detail, icon: Icon, status }) => (
          <Card className="agent-card" key={name}>
            <div className="agent-card__top">
              <span className="agent-card__icon">
                <Icon size={17} />
              </span>
              <Badge tone={status === 'Active' ? 'positive' : 'warning'} dot>
                {status} fixture
              </Badge>
            </div>
            <p className="agent-card__name">{name}</p>
            <p className="agent-card__detail">{detail}</p>
          </Card>
        ))}
      </section>

      <div className="ai-office-layout ai-office-content">
        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Recent traces</h2>
              <p className="section-card__subtitle">
                Synthetic records · structured outputs · prompt and policy versions
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowRaw((value) => !value)}>
              {showRaw ? 'Hide' : 'Show'} trace IDs
            </Button>
          </div>
          <div>
            {state.traces.map((trace) => (
              <div className="trace-row trace-row--detailed" key={trace.id}>
                <span className="trace-row__time">{trace.time}</span>
                <span className="trace-agent-icon">
                  {trace.result === 'succeeded' ? (
                    <CheckCircle2 size={15} />
                  ) : trace.result === 'blocked' ? (
                    <ShieldAlert size={15} />
                  ) : (
                    <ShieldCheck size={15} />
                  )}
                </span>
                <div>
                  <p className="trace-row__title">
                    {trace.agent} · {trace.action}
                  </p>
                  <p className="trace-row__detail">{trace.detail}</p>
                  {showRaw && (
                    <code>
                      {trace.traceId} · {trace.promptVersion}
                    </code>
                  )}
                </div>
                <Badge tone={trace.result === 'succeeded' ? 'positive' : 'warning'} dot>
                  {trace.result.replace('_', ' ')}
                </Badge>
              </div>
            ))}
          </div>
        </Card>

        <div className="dashboard-stack">
          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Execution guardrails</h2>
                <p className="section-card__subtitle">Fail closed, then explain why</p>
              </div>
              <ShieldCheck size={18} color="#1f6d5e" />
            </div>
            <ul className="guardrail-list">
              {[
                ['Role & least privilege', 'Tool-local permission check'],
                ['Grounded source facts', 'No inferred truth for core records'],
                ['Prompt-injection defense', 'Untrusted content never becomes instruction'],
                ['Policy & exact approval', 'Payload and record state revalidated'],
                ['Idempotent execution', 'Unique key plus request hash'],
                ['Redacted observability', 'PII and secrets excluded from traces'],
              ].map(([title, detail]) => (
                <li key={title}>
                  <CheckCircle2 size={14} />
                  <span>
                    <strong>{title}</strong>
                    <small>{detail}</small>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Automation modes</h2>
                <p className="section-card__subtitle">StoryLand-style operating boundary</p>
              </div>
            </div>
            <div className="automation-mode-list">
              <div>
                <Badge tone="positive">A</Badge>
                <span>
                  <strong>Autonomous</strong>
                  <small>Low-risk, reversible, allowlisted</small>
                </span>
              </div>
              <div>
                <Badge tone="info">AR</Badge>
                <span>
                  <strong>Act then review</strong>
                  <small>Bounded action with owner visibility</small>
                </span>
              </div>
              <div>
                <Badge tone="warning">PR</Badge>
                <span>
                  <strong>Propose then approve</strong>
                  <small>Exact payload paused before execution</small>
                </span>
              </div>
              <div>
                <Badge tone="dark">H</Badge>
                <span>
                  <strong>Human only</strong>
                  <small>Emergency, legal, banking, destructive</small>
                </span>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Card className="automation-table-card">
        <div className="list-toolbar">
          <div>
            <h2>Automation runs</h2>
            <p className="section-card__subtitle">
              Durable schedule, execution, approval, and retry state
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowRules((visible) => !visible)}
            icon={<Workflow size={14} />}
          >
            {showRules ? 'Hide rule details' : 'View rule details'}
          </Button>
        </div>
        {showRules && (
          <div className="automation-rule-summary" role="status">
            <ShieldCheck size={17} />
            <p>
              Rules are versioned in <strong>storyops-policy-v1.0.0</strong>. Autonomous execution
              is limited to allowlisted, reversible actions; editing or publishing policy requires
              an owner-authenticated live command and immutable audit event.
            </p>
          </div>
        )}
        <div className="table-wrap customer-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Automation</th>
                <th>Trigger</th>
                <th>Last run</th>
                <th>Next run</th>
                <th>Reversibility</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {state.automations.map((automation) => (
                <tr key={automation.id}>
                  <td>
                    <strong>{automation.name}</strong>
                  </td>
                  <td>{automation.trigger}</td>
                  <td>{automation.lastRun}</td>
                  <td>{automation.nextRun}</td>
                  <td>{automation.reversibility.replace('_', ' ')}</td>
                  <td>
                    <Badge
                      tone={
                        automation.status === 'succeeded'
                          ? 'positive'
                          : automation.status === 'waiting_approval'
                            ? 'warning'
                            : automation.status === 'failed'
                              ? 'danger'
                              : 'info'
                      }
                      dot
                    >
                      {automation.status.replace('_', ' ')}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function LiveAiOfficePage() {
  const { state, actions } = useStoryOps();
  const pending = state.approvals.filter((approval) => approval.status === 'pending').length;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Authenticated AI office boundary"
        title="Agent status is not inferred"
        description="The current workspace projection does not expose automation runs, AI traces, prompts, or owner briefings. Live controls cannot claim that an agent ran."
        actions={
          <Button variant="secondary" onClick={() => void actions.reloadLiveWorkspace()}>
            Refresh workspace
          </Button>
        }
      />

      <Card className="projection-warning">
        <ShieldAlert size={18} />
        <div>
          <strong>No live agent-run projection is available</strong>
          <p>
            Briefing and automation controls remain unavailable until an authenticated server
            command and role-scoped read model expose their durable run state.
          </p>
        </div>
      </Card>

      <Card className="orchestrator-card">
        <div className="orchestrator-card__icon">
          <BrainCircuit size={25} />
        </div>
        <div>
          <Badge tone="neutral">Policy architecture</Badge>
          <h2>Typed tools remain behind one server boundary</h2>
          <p>
            The implemented live command vocabulary is finite, idempotent, versioned, and membership
            checked. Provider secrets and service-role credentials stay server-side.
          </p>
        </div>
        <div className="orchestrator-stats">
          <div>
            <strong>{pending}</strong>
            <span>projected approvals</span>
          </div>
          <div>
            <strong>{state.offlineQueue.length}</strong>
            <span>queued commands</span>
          </div>
          <div>
            <strong>{state.integrations.length}</strong>
            <span>provider records</span>
          </div>
        </div>
      </Card>

      <section className="agent-grid" aria-label="Defined AI specialists">
        {agents.map(({ name, detail, icon: Icon }) => (
          <Card className="agent-card" key={name}>
            <div className="agent-card__top">
              <span className="agent-card__icon">
                <Icon size={17} />
              </span>
              <Badge tone="neutral">Defined, status unknown</Badge>
            </div>
            <p className="agent-card__name">{name}</p>
            <p className="agent-card__detail">{detail}</p>
          </Card>
        ))}
      </section>

      <Card className="section-card">
        <div className="section-card__header">
          <div>
            <h2>Execution guardrails</h2>
            <p className="section-card__subtitle">Enforced by the live RPC boundary</p>
          </div>
          <ShieldCheck size={18} color="#1f6d5e" />
        </div>
        <ul className="guardrail-list">
          {[
            ['Server-derived role', 'No role preview or payload-selected assignment'],
            ['Normalized commands', 'No generic row overwrite endpoint'],
            ['Optimistic versions', 'Stale state fails closed'],
            ['Stable command identity', 'UUID, request hash, and exact offline replay'],
            ['Provider isolation', 'Secrets remain in Edge/server environments'],
            ['Role-scoped reads', 'Customer and technician projections minimize data'],
          ].map(([title, detail]) => (
            <li key={title}>
              <CheckCircle2 size={14} />
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
