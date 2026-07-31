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
          integrity:
            'Synthetic, resettable browser fixtures only; this is not a database audit-chain or backup export.',
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
        eyebrow="Synthetic audit & observability rehearsal"
        title="Inspect resettable evidence fixtures"
        description="These local browser records rehearse the production audit shape. They are not durable database evidence, an integrity-chain verification, or backup proof."
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
            <strong>Append-only shape</strong>
            <small>Resettable local fixture; database enforcement is tested separately</small>
          </div>
          <Badge tone="neutral">Fixture</Badge>
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
            <strong>Recovery tooling included</strong>
            <small>No backup or restore evidence is loaded in this browser</small>
          </div>
          <Badge tone="warning">Release evidence required</Badge>
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
                        <LockKeyhole size={10} /> fixture append-only
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
                  <th>Policy scenario</th>
                  <th>Configured trigger</th>
                  <th>Last fixture</th>
                  <th>Projected next</th>
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
                      <Badge tone="info">{automation.status.replaceAll('_', ' ')} fixture</Badge>
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
              <p className="section-card__subtitle">
                Release tooling summary; no browser proof is asserted
              </p>
            </div>
            <ArchiveRestore size={18} color="#1f6d5e" />
          </div>
          <ul className="guardrail-list">
            <li>
              <CheckCircle2 size={14} />
              <span>
                <strong>Backup script contract</strong>
                <small>
                  Schema, data, roles, and migration ledger require an executed release artifact
                </small>
              </span>
            </li>
            <li>
              <CheckCircle2 size={14} />
              <span>
                <strong>Private object inventory contract</strong>
                <small>Checksums and retention metadata require an executed release artifact</small>
              </span>
            </li>
            <li>
              <CheckCircle2 size={14} />
              <span>
                <strong>Restore dry-run guard</strong>
                <small>
                  Refuses broad or unresolved destinations; no restore ran from this screen
                </small>
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
  const [query, setQuery] = useState('');
  const feed = state.liveAuditFeed;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleEvents = (feed?.events ?? []).filter((event) =>
    [
      event.actorType,
      event.actorRef,
      event.action,
      event.entityType,
      event.entityId,
      event.requestId,
      event.traceId,
      event.retentionClass,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery),
  );
  const exportProjection = () => {
    downloadText(
      `storyops-redacted-audit-feed-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          notice:
            'Owner-scoped redacted audit metadata only. Raw actors, before/after payloads, integrity verification, and backup evidence are intentionally excluded.',
          workspace: {
            companyId: state.live?.companyId,
            userId: state.live?.userId,
            role: state.role,
            serverTime: feed?.serverTime,
          },
          auditFeed: feed,
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
        title={state.role === 'owner' ? 'Review redacted audit metadata' : 'Owner access required'}
        description={
          state.role === 'owner'
            ? 'This bounded server feed shows decision metadata without exposing raw actors or before/after payloads. It is not a backup or integrity-chain verification.'
            : 'The redacted audit feed is intentionally limited to the active company owner.'
        }
        actions={
          <>
            {state.role === 'owner' && feed && (
              <Button variant="secondary" onClick={exportProjection} icon={<Download size={15} />}>
                Export redacted page
              </Button>
            )}
            <Button variant="secondary" onClick={() => void actions.reloadLiveWorkspace()}>
              Refresh from server
            </Button>
          </>
        }
      />

      {state.role !== 'owner' || !feed ? (
        <Card className="projection-warning">
          <LockKeyhole size={18} />
          <div>
            <strong>No audit rows are disclosed in this role projection</strong>
            <p>
              Refresh as the active company owner. The browser cannot elevate a dispatcher,
              technician, customer, inactive membership, or cross-company session.
            </p>
          </div>
        </Card>
      ) : (
        <>
          <section className="audit-summary-grid">
            <Card>
              <span>
                <LockKeyhole size={18} />
              </span>
              <div>
                <strong>Server-redacted</strong>
                <small>No raw actor ID or before/after payload is projected</small>
              </div>
              <Badge tone="positive">Enforced</Badge>
            </Card>
            <Card>
              <span>
                <FileClock size={18} />
              </span>
              <div>
                <strong>{feed.events.length} loaded events</strong>
                <small>Bounded keyset pages of at most {feed.pageLimit}</small>
              </div>
              <Badge tone={feed.hasMore ? 'info' : 'neutral'}>
                {feed.hasMore ? 'More available' : 'Current end'}
              </Badge>
            </Card>
            <Card>
              <span>
                <DatabaseBackup size={18} />
              </span>
              <div>
                <strong>No backup claim</strong>
                <small>Restore evidence remains a separate release artifact</small>
              </div>
              <Badge tone="warning">Separate proof</Badge>
            </Card>
          </section>

          <div className="audit-tabs">
            <div className="pipeline-search">
              <Search size={14} />
              <input
                aria-label="Search loaded audit metadata"
                placeholder="Actor, action, entity, request…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Badge tone={state.serverVerifiedAt ? 'positive' : 'warning'}>
              {state.serverVerifiedAt ? 'Server page verified' : 'Refresh required'}
            </Badge>
          </div>

          <Card className="audit-table-card">
            <div className="table-wrap">
              <table className="data-table audit-table">
                <thead>
                  <tr>
                    <th>Occurred</th>
                    <th>Redacted actor</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Request / trace</th>
                    <th>Payload evidence</th>
                    <th>Retention</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEvents.map((event) => (
                    <tr key={event.id}>
                      <td>{new Date(event.occurredAt).toLocaleString()}</td>
                      <td>
                        <code>{event.actorRef}</code>
                      </td>
                      <td>
                        <strong>{event.action}</strong>
                      </td>
                      <td>
                        <code>
                          {event.entityType}
                          {event.entityId ? `:${event.entityId.slice(0, 8)}` : ''}
                        </code>
                      </td>
                      <td>
                        <code>{event.requestId ?? event.traceId ?? 'not recorded'}</code>
                      </td>
                      <td>
                        <Badge tone="neutral">
                          {event.hasBefore ? 'before ' : ''}
                          {event.hasAfter ? 'after' : ''}
                          {!event.hasBefore && !event.hasAfter ? 'metadata only' : ' retained'}
                        </Badge>
                      </td>
                      <td>
                        <Badge tone={event.legalHold ? 'warning' : 'info'}>
                          {event.legalHold ? 'legal hold' : event.retentionClass}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {visibleEvents.length === 0 && (
              <div className="incident-empty">
                <FileClock size={22} />
                <div>
                  <h3>No loaded event matches</h3>
                  <p>Clear the search or refresh the owner-scoped page.</p>
                </div>
              </div>
            )}
          </Card>

          {feed.hasMore && (
            <div className="page-footer-actions">
              <Button
                variant="secondary"
                disabled={!state.serverVerifiedAt}
                onClick={() => void actions.loadMoreAuditEvents()}
              >
                Load next verified page
              </Button>
            </div>
          )}

          <Card className="projection-warning">
            <LockKeyhole size={18} />
            <div>
              <strong>This is not a complete evidence packet</strong>
              <p>
                Raw before/after records, direct actor identifiers, database-chain verification,
                retention execution, and backup/restore evidence require separately authorized
                server-side procedures.
              </p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
