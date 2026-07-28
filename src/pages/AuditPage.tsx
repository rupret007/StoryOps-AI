import {
  ArchiveRestore,
  CheckCircle2,
  DatabaseBackup,
  Download,
  FileClock,
  LockKeyhole,
  Search,
} from 'lucide-react';
import { useState } from 'react';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Button, Card, PageHeader } from '@/components/ui/Primitives';
import { downloadText } from '@/utils/download';

export function AuditPage() {
  const { state } = useStoryOps();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'audit' | 'traces' | 'automations' | 'incidents'>('audit');
  const visibleAudit = state.auditEvents.filter((event) =>
    `${event.actor} ${event.action} ${event.entity} ${event.outcome}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const normalizedQuery = query.toLowerCase();
  const visibleTraces = state.traces.filter((trace) =>
    `${trace.agent} ${trace.action} ${trace.result} ${trace.detail}`
      .toLowerCase()
      .includes(normalizedQuery),
  );
  const visibleAutomations = state.automations.filter((automation) =>
    `${automation.name} ${automation.trigger} ${automation.status}`
      .toLowerCase()
      .includes(normalizedQuery),
  );
  const visibleIncidents = state.incidents.filter((incident) =>
    `${incident.jobNumber} ${incident.kind} ${incident.summary} ${incident.status}`
      .toLowerCase()
      .includes(normalizedQuery),
  );
  const exportEvidence = () => {
    downloadText(
      `storyops-evidence-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          integrity: 'append-only application evidence; verify against database audit chain',
          auditEvents: state.auditEvents,
          aiTraces: state.traces,
          automationRuns: state.automations,
          incidents: state.incidents,
        },
        null,
        2,
      ),
      'application/json;charset=utf-8',
    );
  };

  if (state.dataMode === 'supabase') return <LiveAuditPage />;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Audit & observability"
        title="Every consequential change has a durable witness"
        description="Business audit events are append-only and separate from redacted AI traces and runtime logs. Corrections create new events; history is never rewritten."
        actions={
          <Button variant="secondary" onClick={exportEvidence} icon={<Download size={15} />}>
            Export evidence packet
          </Button>
        }
      />

      <section className="audit-summary-grid">
        <Card>
          <span>
            <LockKeyhole size={18} />
          </span>
          <div>
            <strong>Append-only</strong>
            <small>Database trigger and RLS enforced</small>
          </div>
          <Badge tone="positive">Verified</Badge>
        </Card>
        <Card>
          <span>
            <FileClock size={18} />
          </span>
          <div>
            <strong>6 retention classes</strong>
            <small>Legal hold overrides automated expiry</small>
          </div>
          <Badge tone="info">Policy</Badge>
        </Card>
        <Card>
          <span>
            <DatabaseBackup size={18} />
          </span>
          <div>
            <strong>Backup ready</strong>
            <small>Restore drill documented and checksum verified</small>
          </div>
          <Badge tone="positive">Current</Badge>
        </Card>
      </section>

      <div className="audit-tabs">
        <div className="segmented">
          <button type="button" aria-pressed={view === 'audit'} onClick={() => setView('audit')}>
            Audit events
          </button>
          <button type="button" aria-pressed={view === 'traces'} onClick={() => setView('traces')}>
            AI traces
          </button>
          <button
            type="button"
            aria-pressed={view === 'automations'}
            onClick={() => setView('automations')}
          >
            Automation runs
          </button>
          <button
            type="button"
            aria-pressed={view === 'incidents'}
            onClick={() => setView('incidents')}
          >
            Incidents
          </button>
        </div>
        <div className="pipeline-search">
          <Search size={14} />
          <input
            aria-label="Search audit events"
            placeholder="Actor, action, entity…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {view === 'audit' && (
        <Card className="audit-table-card">
          <div className="table-wrap">
            <table className="data-table audit-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Outcome</th>
                  <th>Request</th>
                  <th>Integrity</th>
                </tr>
              </thead>
              <tbody>
                {visibleAudit.map((event) => (
                  <tr key={event.id}>
                    <td>{event.time}</td>
                    <td>
                      <code>{event.actor}</code>
                    </td>
                    <td>
                      <strong>{event.action}</strong>
                    </td>
                    <td>
                      <code>{event.entity}</code>
                    </td>
                    <td>
                      <Badge
                        tone={
                          event.outcome === 'success' ||
                          event.outcome === 'synced' ||
                          event.outcome === 'accepted' ||
                          event.outcome === 'paid'
                            ? 'positive'
                            : event.outcome === 'pending'
                              ? 'warning'
                              : 'info'
                        }
                      >
                        {event.outcome}
                      </Badge>
                    </td>
                    <td>
                      <code>{event.requestId}</code>
                    </td>
                    <td>
                      <Badge tone="neutral">
                        <LockKeyhole size={10} /> immutable
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {view === 'traces' && (
        <Card className="audit-table-card">
          <div className="table-wrap">
            <table className="data-table audit-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Agent</th>
                  <th>Action</th>
                  <th>Result</th>
                  <th>Trace</th>
                  <th>Prompt</th>
                </tr>
              </thead>
              <tbody>
                {visibleTraces.map((trace) => (
                  <tr key={trace.id}>
                    <td>{trace.time}</td>
                    <td>{trace.agent}</td>
                    <td>{trace.action}</td>
                    <td>
                      <Badge tone={trace.result === 'succeeded' ? 'positive' : 'warning'}>
                        {trace.result.replaceAll('_', ' ')}
                      </Badge>
                    </td>
                    <td>
                      <code>{trace.traceId}</code>
                    </td>
                    <td>
                      <code>{trace.promptVersion}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {view === 'automations' && (
        <Card className="audit-table-card">
          <div className="table-wrap">
            <table className="data-table audit-table">
              <thead>
                <tr>
                  <th>Automation</th>
                  <th>Trigger</th>
                  <th>Last run</th>
                  <th>Next run</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleAutomations.map((automation) => (
                  <tr key={automation.id}>
                    <td>
                      <strong>{automation.name}</strong>
                    </td>
                    <td>{automation.trigger}</td>
                    <td>{automation.lastRun}</td>
                    <td>{automation.nextRun}</td>
                    <td>
                      <Badge tone="info">{automation.status.replaceAll('_', ' ')}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {view === 'incidents' && (
        <Card className="audit-table-card">
          <div className="table-wrap">
            <table className="data-table audit-table">
              <thead>
                <tr>
                  <th>Reported</th>
                  <th>Job</th>
                  <th>Type</th>
                  <th>Observed facts</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleIncidents.map((incident) => (
                  <tr key={incident.id}>
                    <td>{new Date(incident.reportedAt).toLocaleString()}</td>
                    <td>
                      <code>{incident.jobNumber}</code>
                    </td>
                    <td>{incident.kind.replaceAll('_', ' ')}</td>
                    <td>{incident.summary}</td>
                    <td>
                      <Badge tone={incident.status === 'open' ? 'danger' : 'positive'}>
                        {incident.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="integration-bottom-grid">
        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Retention policy</h2>
              <p className="section-card__subtitle">Configurable by record class</p>
            </div>
            <FileClock size={18} color="#1f6d5e" />
          </div>
          <div className="retention-list">
            {[
              ['Financial', '7 years', 'Invoices, payments, exports'],
              ['Safety', '7 years', 'Incidents, evidence, CAPA'],
              ['Operational', '3 years', 'Jobs, visits, checklists'],
              ['Communications', '3 years', 'Transactional and consent evidence'],
              ['AI trace', '90 days', 'Redacted model/tool spans'],
              ['Audit', '7 years', 'Append-only business decisions'],
            ].map(([name, period, detail]) => (
              <div key={name}>
                <span>
                  <strong>{name}</strong>
                  <small>{detail}</small>
                </span>
                <Badge tone="neutral">{period}</Badge>
              </div>
            ))}
          </div>
          <p className="legal-review-note">
            Retention periods are launch defaults and require legal, insurance, tax, and privacy
            review before live use.
          </p>
        </Card>
        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Backup & restore</h2>
              <p className="section-card__subtitle">Operational proof, not just configuration</p>
            </div>
            <ArchiveRestore size={18} color="#1f6d5e" />
          </div>
          <ul className="guardrail-list">
            <li>
              <CheckCircle2 size={14} />
              <span>
                <strong>Encrypted database backup</strong>
                <small>Schema, data, roles, and migration ledger</small>
              </span>
            </li>
            <li>
              <CheckCircle2 size={14} />
              <span>
                <strong>Private object inventory</strong>
                <small>Checksums and retention metadata exported separately</small>
              </span>
            </li>
            <li>
              <CheckCircle2 size={14} />
              <span>
                <strong>Explicit restore target</strong>
                <small>Refuses broad or unresolved destinations</small>
              </span>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function LiveAuditPage() {
  const { state, actions } = useStoryOps();
  const exportProjection = () => {
    downloadText(
      `storyops-role-projection-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          notice:
            'This is a role-scoped workspace export, not a complete audit, trace, backup, or integrity packet.',
          workspace: {
            companyId: state.live?.companyId,
            userId: state.live?.userId,
            role: state.role,
            serverTime: state.live?.serverTime,
          },
          incidents: state.incidents,
        },
        null,
        2,
      ),
      'application/json;charset=utf-8',
    );
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Authenticated audit boundary"
        title="Audit records are not in this projection"
        description="The live workspace intentionally does not expose audit events, AI traces, automation runs, backup status, retention runs, or integrity-chain evidence."
        actions={
          <>
            <Button variant="secondary" onClick={exportProjection} icon={<Download size={15} />}>
              Export visible projection
            </Button>
            <Button variant="secondary" onClick={() => void actions.reloadLiveWorkspace()}>
              Refresh
            </Button>
          </>
        }
      />

      <Card className="projection-warning">
        <LockKeyhole size={18} />
        <div>
          <strong>No complete evidence packet can be produced client-side</strong>
          <p>
            Use an owner-authorized server export that verifies the append-only chain, retention
            policy, and database backup independently. This browser will not claim that evidence
            exists merely because the schema supports it.
          </p>
        </div>
      </Card>

      <Card className="section-card">
        <div className="section-card__header">
          <div>
            <h2>Role-visible incident records</h2>
            <p className="section-card__subtitle">
              Included here because incidents are part of the current workspace projection
            </p>
          </div>
          <Badge tone="neutral">{state.incidents.length}</Badge>
        </div>
        {state.incidents.map((incident) => (
          <div className="template-row" key={incident.id}>
            <span>
              <strong>
                {incident.jobNumber} · {incident.kind.replaceAll('_', ' ')}
              </strong>
              <small>{incident.summary}</small>
            </span>
            <Badge tone={incident.status === 'open' ? 'danger' : 'positive'}>
              {incident.status}
            </Badge>
          </div>
        ))}
        {state.incidents.length === 0 && (
          <div className="incident-empty">
            <FileClock size={22} />
            <div>
              <h3>No incident rows returned</h3>
              <p>This says nothing about records outside the current role scope.</p>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
