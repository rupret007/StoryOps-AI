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
import { useState, type FormEvent } from 'react';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Button, Card, Field, PageHeader } from '@/components/ui/Primitives';
import {
  AI_OFFICE_MANUAL_INPUT_MAX_CHARACTERS,
  agentLabel,
  aiOfficeRootSubjectsForAgent,
  approvalIdsForRun,
  type AiOfficeRootSubjectType,
  type DurableAiOfficeRun,
} from '@/core/ai/liveOffice';
import type { OfficeAgentName } from '@/core/ai/contracts';

const agents = [
  {
    id: 'intake',
    name: 'Intake',
    detail: 'Qualifies inquiries only from verified customer facts and channel consent.',
    icon: Headphones,
    status: 'Active',
  },
  {
    id: 'estimating',
    name: 'Estimating',
    detail: 'Calls deterministic pricing tools; never supplies a measurement or price.',
    icon: FileSearch,
    status: 'Active',
  },
  {
    id: 'scheduling',
    name: 'Scheduling',
    detail: 'Reads capacity, route, equipment, weather, and calendar truth.',
    icon: CalendarCheck2,
    status: 'Active',
  },
  {
    id: 'follow_up',
    name: 'Follow-up',
    detail: 'Queues consent-checked messages and review requests through provider policy.',
    icon: MessageSquareText,
    status: 'Active',
  },
  {
    id: 'marketing',
    name: 'Marketing',
    detail: 'Drafts campaigns; all bulk sends remain approval-gated.',
    icon: Megaphone,
    status: 'Paused',
  },
  {
    id: 'finance',
    name: 'Finance',
    detail: 'Issues matched invoices and reconciles verified provider state.',
    icon: CircleDollarSign,
    status: 'Active',
  },
  {
    id: 'safety',
    name: 'Safety',
    detail: 'Checks evidence and SOP bounds; cannot invent chemical instructions.',
    icon: ShieldCheck,
    status: 'Active',
  },
  {
    id: 'owner_briefing',
    name: 'Briefing',
    detail: 'Produces read-only owner facts, risks, deadlines, and KPI context.',
    icon: Sparkles,
    status: 'Active',
  },
] satisfies Array<{
  id: OfficeAgentName;
  name: string;
  detail: string;
  icon: typeof Headphones;
  status: string;
}>;

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
                <h2>Policy action modes</h2>
                <p className="section-card__subtitle">
                  Eligibility boundary; unattended execution is not active
                </p>
              </div>
            </div>
            <div className="automation-mode-list">
              <div>
                <Badge tone="positive">A</Badge>
                <span>
                  <strong>Eligible for automatic execution</strong>
                  <small>Low-risk, reversible, allowlisted; not enabled in this release</small>
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
            <h2>Automation records</h2>
            <p className="section-card__subtitle">
              Persisted run, approval, and retry state; no unattended scheduler is active
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
              Rules are versioned in <strong>storyops-policy-v1.0.0</strong>. Policy may mark
              allowlisted, reversible actions as eligible for future automatic execution, but V1.1
              starts AI Office runs only through an owner or dispatcher. Editing or publishing
              policy requires an owner-authenticated live command and immutable audit event.
            </p>
          </div>
        )}
        <div className="table-wrap customer-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Policy scenario</th>
                <th>Configured trigger</th>
                <th>Last fixture</th>
                <th>Projected next</th>
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
                      {automation.status.replace('_', ' ')} fixture
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
  const [agent, setAgent] = useState<OfficeAgentName>('owner_briefing');
  const [rootType, setRootType] = useState<AiOfficeRootSubjectType | ''>('');
  const [rootId, setRootId] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState('');
  const [retryIdentity, setRetryIdentity] = useState<{
    runId: string;
    requestedAt: string;
  }>();
  const [selectedRun, setSelectedRun] = useState<DurableAiOfficeRun>();
  const recent = state.aiOfficeRecent;
  const displayedRun = selectedRun ?? recent?.runs[0];
  const allowedSubjects = aiOfficeRootSubjectsForAgent(agent);
  const mayRun = state.role === 'owner' || state.role === 'dispatcher';

  const resetRetryIdentity = () => setRetryIdentity(undefined);

  const submitRun = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError('');
    if (!mayRun) {
      setFormError('Only an active owner or dispatcher can manually run AI Office.');
      return;
    }
    if (!state.online || !state.serverVerifiedAt) {
      setFormError('Refresh the authenticated workspace before running AI Office.');
      return;
    }
    if (agent !== 'owner_briefing' && (!rootType || !rootId)) {
      setFormError('Choose one root record type and enter its exact UUID.');
      return;
    }
    const identity = retryIdentity ?? {
      runId: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
    };
    setRetryIdentity(identity);
    setRunning(true);
    const run = await actions.runAiOffice({
      ...identity,
      agent,
      manualInput,
      ...(agent === 'owner_briefing'
        ? {}
        : { rootSubject: { type: rootType as AiOfficeRootSubjectType, id: rootId } }),
    });
    setRunning(false);
    if (!run) {
      setFormError(
        'The run did not return a reconciled durable result. The same run ID will be reused if you retry.',
      );
      return;
    }
    setSelectedRun(run);
    if (run.durableStatus === 'failed') {
      setFormError(
        run.errorMessage ??
          'The server recorded this run as failed. Retry will reuse the same run identity.',
      );
      return;
    }
    setRetryIdentity(undefined);
  };

  const runBriefing = async () => {
    setFormError('');
    setRunning(true);
    const run = await actions.runAiOffice({
      runId: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      agent: 'owner_briefing',
      manualInput: '',
    });
    setRunning(false);
    if (run) setSelectedRun(run);
    else setFormError('The owner briefing did not return a reconciled durable result.');
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Authenticated · manually triggered AI office"
        title="Run a grounded specialist and inspect the durable result"
        description="Every run is initiated by an owner or dispatcher, constrained to server-resolved facts, and read back from the durable automation record. No AI Office scheduler is configured."
        actions={
          <>
            <Button
              variant="secondary"
              loading={running}
              disabled={!mayRun || !state.online || !state.serverVerifiedAt}
              onClick={() => void runBriefing()}
              icon={<RefreshCcw size={15} />}
            >
              Run owner briefing
            </Button>
            <Button variant="ghost" onClick={() => void actions.reloadLiveWorkspace()}>
              Refresh readback
            </Button>
          </>
        }
      />

      <Card className="projection-warning">
        <ShieldCheck size={18} />
        <div>
          <strong>Manual trigger only · no scheduler configured</strong>
          <p>
            This page does not imply background automation. Manual notes are bounded untrusted
            context; the browser sends at most one record identity hint and never supplies trusted
            measurements, prices, availability, payment state, regulations, or safety instructions.
          </p>
        </div>
      </Card>

      <div className="ai-office-layout ai-office-content">
        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Manual specialist run</h2>
              <p className="section-card__subtitle">
                Fixed objective · exact root identity · bounded untrusted context
              </p>
            </div>
            <BrainCircuit size={20} />
          </div>
          <form className="ai-office-run-form" onSubmit={(event) => void submitRun(event)}>
            <Field label="Specialist" htmlFor="ai-office-agent">
              <select
                id="ai-office-agent"
                className="select"
                value={agent}
                onChange={(event) => {
                  const nextAgent = event.target.value as OfficeAgentName;
                  setAgent(nextAgent);
                  setRootType('');
                  setRootId('');
                  resetRetryIdentity();
                }}
              >
                {agents.map((candidate) => (
                  <option value={candidate.id} key={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </Field>

            {agent !== 'owner_briefing' && (
              <div className="ai-office-root-fields">
                <Field label="Root record type" htmlFor="ai-office-root-type">
                  <select
                    id="ai-office-root-type"
                    className="select"
                    value={rootType}
                    onChange={(event) => {
                      setRootType(event.target.value as AiOfficeRootSubjectType);
                      resetRetryIdentity();
                    }}
                    required
                  >
                    <option value="">Choose a record type</option>
                    {allowedSubjects.map((subject) => (
                      <option value={subject} key={subject}>
                        {subject.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Exact record UUID"
                  htmlFor="ai-office-root-id"
                  hint="The server verifies company ownership and re-reads this record."
                >
                  <input
                    id="ai-office-root-id"
                    className="input"
                    value={rootId}
                    onChange={(event) => {
                      setRootId(event.target.value);
                      resetRetryIdentity();
                    }}
                    autoComplete="off"
                    inputMode="text"
                    pattern="[0-9a-fA-F-]{36}"
                    required
                  />
                </Field>
              </div>
            )}

            <Field
              label="Manual context (optional)"
              htmlFor="ai-office-manual-input"
              hint={`${manualInput.length}/${AI_OFFICE_MANUAL_INPUT_MAX_CHARACTERS} characters · handled as untrusted data, never instructions`}
            >
              <textarea
                id="ai-office-manual-input"
                className="textarea"
                rows={5}
                maxLength={AI_OFFICE_MANUAL_INPUT_MAX_CHARACTERS}
                value={manualInput}
                onChange={(event) => {
                  setManualInput(event.target.value);
                  resetRetryIdentity();
                }}
                placeholder="Add context the specialist should evaluate against server facts."
              />
            </Field>
            <div className="ai-office-run-form__actions">
              <Button
                type="submit"
                loading={running}
                disabled={!mayRun || !state.online || !state.serverVerifiedAt}
                icon={<Sparkles size={15} />}
              >
                Run {agentLabel(agent)}
              </Button>
              {retryIdentity && (
                <code title="Stable run identity retained for safe retry">
                  retry {retryIdentity.runId}
                </code>
              )}
            </div>
            <div className="ai-office-form-status" aria-live="polite">
              {running && <p>Running against current server facts…</p>}
              {formError && <p role="alert">{formError}</p>}
            </div>
          </form>
        </Card>

        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Durable result</h2>
              <p className="section-card__subtitle">
                Authenticated automation-run readback, not optimistic browser state
              </p>
            </div>
            {displayedRun && (
              <Badge
                tone={
                  displayedRun.durableStatus === 'succeeded'
                    ? 'positive'
                    : displayedRun.durableStatus === 'waiting_approval'
                      ? 'warning'
                      : displayedRun.durableStatus === 'failed'
                        ? 'danger'
                        : 'neutral'
                }
                dot
              >
                {displayedRun.durableStatus.replaceAll('_', ' ')}
              </Badge>
            )}
          </div>
          {!displayedRun ? (
            <div className="empty-state">
              <ShieldCheck size={24} />
              <h3>No durable AI Office runs yet</h3>
              <p>Run a specialist above. Refreshing this page will read recent server records.</p>
            </div>
          ) : (
            <div className="ai-office-result" aria-live="polite">
              <div className="ai-office-result__meta">
                <span>
                  <small>Agent</small>
                  <strong>{agentLabel(displayedRun.agent)}</strong>
                </span>
                <span>
                  <small>Model mode</small>
                  <strong>{displayedRun.modelMode ?? 'not reached'}</strong>
                </span>
                <span>
                  <small>Confidence</small>
                  <strong>
                    {displayedRun.result
                      ? `${Math.round(displayedRun.result.output.confidence * 100)}%`
                      : 'not available'}
                  </strong>
                </span>
              </div>
              {displayedRun.result ? (
                <>
                  <div className="projection-warning" role="note">
                    <ShieldAlert size={18} />
                    <div>
                      <strong>AI prose is advisory, not source-of-truth</strong>
                      <p>
                        Verify the server records referenced below. Draft copy is unsent and cannot
                        trigger customer contact. Only server-resolved facts and deterministic
                        action dispositions are authoritative.
                      </p>
                    </div>
                  </div>
                  <div>
                    <h3>Non-authoritative AI advisory</h3>
                    <p>{displayedRun.result.output.summary}</p>
                  </div>
                  <div>
                    <h3>AI rationale references · not evidence</h3>
                    {displayedRun.result.output.evidence.length ? (
                      <ul className="guardrail-list">
                        {displayedRun.result.output.evidence.map((evidence, index) => (
                          <li key={`${evidence.claim}-${index}`}>
                            <CheckCircle2 size={14} />
                            <span>
                              <strong>
                                {Math.round(evidence.confidence * 100)}% · {evidence.claim}
                              </strong>
                              <small>
                                Referenced server fact IDs: {evidence.sourceFactIds.join(', ')}
                              </small>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>No AI rationale references were returned.</p>
                    )}
                  </div>
                  {displayedRun.result.output.customerDraft && (
                    <div>
                      <h3>Unsent AI draft · human review required</h3>
                      <p>{displayedRun.result.output.customerDraft}</p>
                      <small>
                        Automatic send allowed:{' '}
                        {displayedRun.result.output.narrativePolicy.automaticSendAllowed
                          ? 'yes'
                          : 'no'}
                      </small>
                    </div>
                  )}
                  <div>
                    <h3>AI-reported unknowns · verify source records</h3>
                    {displayedRun.result.output.unknowns.length ? (
                      <ul>
                        {displayedRun.result.output.unknowns.map((unknown) => (
                          <li key={unknown}>{unknown}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>No unknowns were reported.</p>
                    )}
                  </div>
                  <div>
                    <h3>Deterministic action dispositions</h3>
                    {displayedRun.result.actions.length ? (
                      <ul className="guardrail-list">
                        {displayedRun.result.actions.map((action) => (
                          <li key={action.actionId}>
                            <ShieldCheck size={14} />
                            <span>
                              <strong>
                                {action.actionId} · {action.status.replaceAll('_', ' ')}
                              </strong>
                              <small>
                                {action.status === 'approval_required'
                                  ? `Approval ${action.approvalId} · ${action.policyRule}`
                                  : action.policyRule}
                              </small>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>No actions were proposed or executed.</p>
                    )}
                  </div>
                  <div>
                    <h3>Prompt-injection signals</h3>
                    <p>
                      {displayedRun.result.injectionSignals.length
                        ? displayedRun.result.injectionSignals.join(' · ')
                        : 'No injection signals detected.'}
                    </p>
                  </div>
                </>
              ) : (
                <p>{displayedRun.errorMessage ?? 'This run has no completed model result.'}</p>
              )}
              <dl className="ai-office-identities">
                <div>
                  <dt>Run ID</dt>
                  <dd>
                    <code>{displayedRun.automationRunId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Trace ID</dt>
                  <dd>
                    <code>{displayedRun.result?.traceId ?? 'not created'}</code>
                  </dd>
                </div>
                <div>
                  <dt>Model provider</dt>
                  <dd>{displayedRun.result?.modelProvider ?? 'not reached'}</dd>
                </div>
                <div>
                  <dt>Approval IDs</dt>
                  <dd>{approvalIdsForRun(displayedRun).join(', ') || 'none'}</dd>
                </div>
                <div>
                  <dt>Owner briefing row</dt>
                  <dd>{displayedRun.ownerBriefingId ?? 'not applicable'}</dd>
                </div>
                <div>
                  <dt>Completed</dt>
                  <dd>
                    {displayedRun.completedAt
                      ? new Date(displayedRun.completedAt).toLocaleString()
                      : 'not completed'}
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </Card>
      </div>

      <Card className="orchestrator-card">
        <div className="orchestrator-card__icon">
          <BrainCircuit size={25} />
        </div>
        <div>
          <Badge tone="accent">Authenticated durable boundary</Badge>
          <h2>Typed specialists remain bounded by policy</h2>
          <p>
            Provider secrets stay server-side. Price, refund, legal, safety, banking, destructive,
            and other policy exceptions remain denied or paused for exact approval.
          </p>
        </div>
        <div className="orchestrator-stats">
          <div>
            <strong>{recent?.runs.length ?? 0}</strong>
            <span>recent manual runs</span>
          </div>
          <div>
            <strong>
              {recent?.runs.filter((run) => run.durableStatus === 'waiting_approval').length ?? 0}
            </strong>
            <span>approval holds</span>
          </div>
          <div>
            <strong>0</strong>
            <span>scheduled runs</span>
          </div>
        </div>
      </Card>

      <section className="agent-grid" aria-label="Defined AI specialists">
        {agents.map(({ id, name, detail, icon: Icon }) => (
          <Card className="agent-card" key={name}>
            <div className="agent-card__top">
              <span className="agent-card__icon">
                <Icon size={17} />
              </span>
              <Badge tone="neutral">
                {recent?.runs.some((run) => run.agent === id)
                  ? 'Recent durable run'
                  : 'Available manually'}
              </Badge>
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
            ['Authenticated owner/dispatcher', 'Actor identity is checked again by the server'],
            [
              'Server-resolved facts',
              'The client may send one identity selector, never fact truth',
            ],
            ['Prompt-injection defense', 'Manual notes remain bounded untrusted content'],
            ['Stable run identity', 'UUID, request hash, idempotency, and durable retry'],
            ['Approval guardrails', 'Sensitive actions pause against an exact payload hash'],
            [
              'Truthful observability',
              'Result, trace, mode, errors, and briefing ID are read back',
            ],
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
