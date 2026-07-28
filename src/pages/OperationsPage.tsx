import {
  AlertTriangle,
  Beaker,
  BookOpenCheck,
  CalendarSync,
  CheckCircle2,
  ClipboardCheck,
  Droplets,
  ShieldEllipsis,
  Gauge,
  HardHat,
  PackageOpen,
  Plus,
  ShieldCheck,
  Truck,
  UsersRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, PageHeader, Progress } from '@/components/ui/Primitives';
import { useStoryOps } from '@/state/StoryOpsProvider';
import type { SandboxServiceCode } from '@/state/model';

type OperationsTab = 'services' | 'resources' | 'safety' | 'recurring';

export function OperationsPage() {
  const { state, can } = useStoryOps();
  const [tab, setTab] = useState<OperationsTab>('services');
  const [draftCreated, setDraftCreated] = useState(false);

  if (state.dataMode === 'supabase') return <LiveOperationsPage />;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Service operations"
        title="Price books, resources, safety, and recurring work"
        description="Published versions make every quote reproducible. Field resources and SOP evidence constrain what can be booked and performed."
        actions={
          <Button
            disabled={!can('price_books.manage') || draftCreated}
            icon={<Plus size={15} />}
            onClick={() => {
              setDraftCreated(true);
              setTab('services');
            }}
          >
            {draftCreated ? 'Draft 2026.08-v1 created' : 'Create draft version'}
          </Button>
        }
      />

      <div className="operations-tabs" role="tablist" aria-label="Operations sections">
        {(
          [
            ['services', 'Services & pricing', Droplets],
            ['resources', 'Crews & resources', UsersRound],
            ['safety', 'Safety & incidents', ShieldCheck],
            ['recurring', 'Recurring care', CalendarSync],
          ] as Array<[OperationsTab, string, LucideIcon]>
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      {tab === 'services' && (
        <ServicesPanel
          draftCreated={draftCreated}
          enabledServiceCodes={state.setupProfile?.enabledServiceCodes ?? []}
          onCreateDraft={() => setDraftCreated(true)}
        />
      )}
      {tab === 'resources' && (
        <ResourcesPanel ownerName={state.setupProfile?.ownerName ?? 'Owner'} />
      )}
      {tab === 'safety' && <SafetyPanel />}
      {tab === 'recurring' && <RecurringPanel />}
    </div>
  );
}

function LiveOperationsPage() {
  const { state, actions } = useStoryOps();

  return (
    <div className="page">
      <PageHeader
        eyebrow="Authenticated service operations"
        title="Role-visible operational records"
        description="The field read model exposes active materials, linked SDS metadata, checklist definitions, and incidents. Configuration writes, private SDS file contents, price-book rules, crew capacity, and recurring-plan administration remain outside this screen."
        actions={
          <Button variant="secondary" onClick={() => void actions.reloadLiveWorkspace()}>
            Refresh workspace
          </Button>
        }
      />

      <Card className="projection-warning">
        <ShieldCheck size={18} />
        <div>
          <strong>Configuration writes are intentionally unavailable</strong>
          <p>
            No browser-only draft, price-book, checklist, equipment, or recurring-plan change can
            claim success without a normalized authenticated server command.
          </p>
        </div>
      </Card>

      <div className="operations-two-column">
        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Active materials</h2>
              <p className="section-card__subtitle">Catalog IDs and units used by field commands</p>
            </div>
            <PackageOpen size={18} color="#1f6d5e" />
          </div>
          {(state.live?.materials ?? []).length > 0 ? (
            state.live?.materials.map((material) => (
              <div className="template-row" key={material.id}>
                <span>
                  <strong>{material.name}</strong>
                  <small>
                    Version {material.version} ·{' '}
                    {material.sdsDocument
                      ? `SDS ${material.sdsDocument.revisionDate}`
                      : material.requiresSds
                        ? 'required SDS missing'
                        : 'non-chemical · no SDS attached'}
                  </small>
                </span>
                <Badge tone={material.requiresSds && !material.sdsDocument ? 'danger' : 'neutral'}>
                  {material.unit}
                </Badge>
              </div>
            ))
          ) : (
            <div className="incident-empty">
              <PackageOpen size={22} />
              <div>
                <h3>No active materials projected</h3>
                <p>Material recording remains blocked until a matching catalog row is visible.</p>
              </div>
            </div>
          )}
        </Card>

        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Incidents</h2>
              <p className="section-card__subtitle">Role-visible safety records</p>
            </div>
            <ShieldEllipsis size={18} color="#1f6d5e" />
          </div>
          {state.incidents.length > 0 ? (
            state.incidents.map((incident) => (
              <div className="template-row" key={incident.id}>
                <span>
                  <strong>{incident.kind.replaceAll('_', ' ')}</strong>
                  <small>{incident.summary}</small>
                </span>
                <Badge tone={incident.status === 'open' ? 'danger' : 'positive'}>
                  {incident.status}
                </Badge>
              </div>
            ))
          ) : (
            <div className="incident-empty">
              <ShieldCheck size={22} />
              <div>
                <h3>No incidents in this projection</h3>
                <p>This is not a claim about records hidden from the current role.</p>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

type ServicesSection = 'price-book' | 'catalog' | 'zones' | 'checklists';

function ServicesPanel({
  draftCreated,
  enabledServiceCodes,
  onCreateDraft,
}: {
  draftCreated: boolean;
  enabledServiceCodes: SandboxServiceCode[];
  onCreateDraft(): void;
}) {
  const [section, setSection] = useState<ServicesSection>('price-book');
  const sections: Array<[ServicesSection, string, LucideIcon]> = [
    ['price-book', 'Price book', BookOpenCheck],
    ['catalog', 'Service catalog', Droplets],
    ['zones', 'Travel zones', Gauge],
    ['checklists', 'Checklist templates', ClipboardCheck],
  ];

  return (
    <div className="settings-grid">
      <Card className="settings-nav">
        {sections.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            aria-current={section === id ? 'page' : undefined}
            onClick={() => setSection(id)}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </Card>
      <div>
        {section === 'price-book' && (
          <>
            <Card className="section-card">
              <div className="price-book-banner">
                <div>
                  <Badge tone="positive" dot>
                    Active
                  </Badge>
                  <h3>DFW Residential · 2026.07-v3</h3>
                  <p>Published Jul 1 by owner · effective Jul 1 · immutable after publication</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={draftCreated}
                  onClick={onCreateDraft}
                >
                  {draftCreated ? 'Draft created' : 'Duplicate to draft'}
                </Button>
              </div>
              <div className="price-book-controls">
                <div>
                  <span>Company minimum</span>
                  <strong>$225.00</strong>
                </div>
                <div>
                  <span>Margin floor</span>
                  <strong>42%</strong>
                </div>
                <div>
                  <span>Auto discount</span>
                  <strong>≤ 10%</strong>
                </div>
                <div>
                  <span>Deposit</span>
                  <strong>25%</strong>
                </div>
                <div>
                  <span>Tax rule</span>
                  <strong>8.25%*</strong>
                </div>
              </div>
              <p className="legal-review-note">
                * Demo tax configuration only. Texas taxability and local rate handling require
                professional legal/tax review before launch.
              </p>
            </Card>
            {draftCreated && (
              <Card className="section-card">
                <div className="section-card__header">
                  <div>
                    <h2>DFW Residential · 2026.08-v1</h2>
                    <p className="section-card__subtitle">
                      Editable draft copied from 2026.07-v3 · not available to quoting tools
                    </p>
                  </div>
                  <Badge tone="warning">Draft</Badge>
                </div>
                <p className="legal-review-note">
                  Publishing remains an owner-controlled operation. Existing quotes keep their
                  immutable 2026.07-v3 calculation snapshot.
                </p>
              </Card>
            )}
          </>
        )}

        {section === 'catalog' && (
          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Service rules</h2>
                <p className="section-card__subtitle">
                  Decimal formula inputs and allowed attributes
                </p>
              </div>
              <Badge tone="neutral">
                {enabledServiceCodes.length} of 3 primary services enabled
              </Badge>
            </div>
            {[
              {
                name: 'Driveway pressure wash',
                code: 'DRIVEWAY_WASH',
                serviceCode: 'pressure-wash-flatwork',
                detail: '$110 base + $0.14 / sq ft after 500 · $185 service minimum',
                icon: Droplets,
                unit: 'square foot',
              },
              {
                name: 'House soft wash',
                code: 'HOUSE_SOFT_WASH',
                serviceCode: 'soft-wash-house',
                detail: '$240 base + $0.18 / sq ft · stories, surface, access, risk',
                icon: Beaker,
                unit: 'square foot',
              },
              {
                name: 'Gutter cleaning',
                code: 'GUTTER_CLEAN',
                serviceCode: 'gutter-cleaning',
                detail: '$155 base + $0.85 / linear ft after 100 · $180 minimum',
                icon: HardHat,
                unit: 'linear foot',
              },
              {
                name: 'Downspout flow test & flush',
                code: 'DOWNSPOUT_FLUSH',
                serviceCode: 'gutter-cleaning',
                detail: '$18 / each · available only with approved gutter service',
                icon: Wrench,
                unit: 'each',
              },
            ].map(({ name, code, serviceCode, detail, icon: Icon, unit }) => (
              <div className="catalog-service" key={code}>
                <span className="catalog-service__icon">
                  <Icon size={18} />
                </span>
                <div>
                  <p className="catalog-service__name">{name}</p>
                  <p className="catalog-service__detail">
                    {code} · {detail}
                  </p>
                </div>
                <span>
                  <Badge
                    tone={
                      enabledServiceCodes.includes(serviceCode as SandboxServiceCode)
                        ? 'positive'
                        : 'neutral'
                    }
                  >
                    {enabledServiceCodes.includes(serviceCode as SandboxServiceCode)
                      ? 'Enabled'
                      : 'Not enabled'}
                  </Badge>
                  <small className="catalog-service__unit">{unit}</small>
                </span>
              </div>
            ))}
          </Card>
        )}

        {section === 'zones' && (
          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Travel zones</h2>
                <p className="section-card__subtitle">
                  Deterministic fees from verified geocoding distance
                </p>
              </div>
              <Badge tone="neutral">3 zones</Badge>
            </div>
            {[
              ['DFW-A', '0–15 road miles', '$0.00', 'Default operating area'],
              ['DFW-B', '15.1–25 road miles', '$35.00', 'Owner crew capacity required'],
              ['DFW-C', '25.1–40 road miles', '$75.00', 'Manual scheduling review'],
            ].map(([zone, range, fee, policy]) => (
              <div className="template-row" key={zone}>
                <span>
                  <strong>
                    {zone} · {range}
                  </strong>
                  <small>{policy}</small>
                </span>
                <Badge tone={zone === 'DFW-C' ? 'warning' : 'neutral'}>{fee}</Badge>
              </div>
            ))}
            <p className="legal-review-note">
              Unverified or out-of-area addresses cannot be priced or booked automatically.
            </p>
          </Card>
        )}

        {section === 'checklists' && (
          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Checklist templates</h2>
                <p className="section-card__subtitle">
                  Versioned evidence requirements attached at booking
                </p>
              </div>
              <Badge tone="positive">All published</Badge>
            </div>
            {[
              ['Exterior wash v3', '8 items · before/after photos · signature'],
              ['Gutter service v2', '10 items · ladder and runoff controls'],
              ['Incident evidence v1', '12 items · owner closure required'],
            ].map(([name, detail]) => (
              <div className="template-row" key={name}>
                <span>
                  <strong>{name}</strong>
                  <small>{detail}</small>
                </span>
                <Badge tone="positive">Active</Badge>
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}

function ResourcesPanel({ ownerName }: { ownerName: string }) {
  return (
    <div className="operations-two-column">
      <Card className="section-card">
        <div className="section-card__header">
          <div>
            <h2>Crews & skills</h2>
            <p className="section-card__subtitle">Capacity comes from calendars, not AI guesses</p>
          </div>
          <Badge tone="positive" dot>
            1 active
          </Badge>
        </div>
        <div className="resource-card">
          <span className="resource-card__icon">
            <UsersRound size={20} />
          </span>
          <div>
            <h3>Owner crew</h3>
            <p>{ownerName} · DFW home base · pressure wash, soft wash, gutters</p>
            <div className="resource-tags">
              <Badge tone="positive">Available</Badge>
              <Badge tone="neutral">27 hr/week</Badge>
              <Badge tone="neutral">3 skills</Badge>
            </div>
          </div>
        </div>
        <div className="capacity-meter">
          <div className="capacity-meter__labels">
            <span>Weekly utilization</span>
            <strong>72%</strong>
          </div>
          <Progress value={72} label="Weekly crew utilization" />
        </div>
      </Card>
      <Card className="section-card">
        <div className="section-card__header">
          <div>
            <h2>Equipment</h2>
            <p className="section-card__subtitle">Assignment and inspection state</p>
          </div>
          <Truck size={18} color="#1f6d5e" />
        </div>
        {[
          ['PW-001', '4 GPM pressure washer', 'Available', 'Inspection Aug 4'],
          ['SH-001', '12V soft wash system', 'Available', 'Inspection Aug 4'],
          ['REEL-01', '300 ft hose reel', 'Assigned', 'Inspection Aug 11'],
          ['LAD-01', '24 ft extension ladder', 'Available', 'Inspection today'],
        ].map(([tag, name, status, due]) => (
          <div className="equipment-row" key={tag}>
            <span className="equipment-row__tag">{tag}</span>
            <div>
              <strong>{name}</strong>
              <small>{due}</small>
            </div>
            <Badge tone={status === 'Available' ? 'positive' : 'info'}>{status}</Badge>
          </div>
        ))}
      </Card>
      <Card className="section-card operations-span">
        <div className="section-card__header">
          <div>
            <h2>Materials & SDS</h2>
            <p className="section-card__subtitle">
              Inventory, reorder points, private safety documents
            </p>
          </div>
          <PackageOpen size={18} color="#1f6d5e" />
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Material</th>
                <th>On hand</th>
                <th>Reorder at</th>
                <th>SDS revision</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Debris disposal bag</td>
                <td>40 each</td>
                <td>10 each</td>
                <td>No SDS attached · non-chemical</td>
                <td>
                  <Badge tone="positive">Available</Badge>
                </td>
              </tr>
              <tr>
                <td>Fresh-water rinse</td>
                <td>250 gal</td>
                <td>50 gal</td>
                <td>No SDS attached · non-chemical</td>
                <td>
                  <Badge tone="positive">Available</Badge>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SafetyPanel() {
  const { state, actions, can } = useStoryOps();
  const [closureNotes, setClosureNotes] = useState<Record<string, string>>({});
  const openIncidents = state.incidents.filter((incident) => incident.status === 'open');

  return (
    <div className="operations-two-column">
      <Card className="section-card">
        <div className="section-card__header">
          <div>
            <h2>Checklist templates</h2>
            <p className="section-card__subtitle">Versioned evidence requirements by service</p>
          </div>
          <ClipboardCheck size={18} color="#1f6d5e" />
        </div>
        {[
          ['Exterior wash v3', '8 items · 4 safety-critical', 'Active'],
          ['Gutter service v2', '10 items · 6 safety-critical', 'Active'],
          ['Incident evidence v1', '12 items · owner closure required', 'Active'],
        ].map(([name, detail, status]) => (
          <div className="template-row" key={name}>
            <span>
              <strong>{name}</strong>
              <small>{detail}</small>
            </span>
            <Badge tone="positive">{status}</Badge>
          </div>
        ))}
      </Card>

      <Card className="section-card">
        <div className="section-card__header">
          <div>
            <h2>Incident readiness</h2>
            <p className="section-card__subtitle">
              Universal spine plus scenario-specific playbooks
            </p>
          </div>
          <ShieldEllipsis size={18} color="#1f6d5e" />
        </div>
        <div className="readiness-score">
          <span>
            <strong>92%</strong>
            <small>launch readiness</small>
          </span>
          <Progress value={92} label="Incident readiness" tone="green" />
        </div>
        <ul className="readiness-list">
          <li>
            <CheckCircle2 size={14} /> Injury / exposure workflow loaded
          </li>
          <li>
            <CheckCircle2 size={14} /> Property-damage evidence packet loaded
          </li>
          <li>
            <CheckCircle2 size={14} /> Affected-job automations freeze on report
          </li>
          <li>
            <AlertTriangle size={14} /> Insurance contacts require owner verification
          </li>
        </ul>
      </Card>

      <Card className="section-card operations-span">
        <div className="section-card__header">
          <div>
            <h2>Open incidents</h2>
            <p className="section-card__subtitle">
              Facts, timeline, evidence, CAPA, closure review
            </p>
          </div>
          <Badge tone={openIncidents.length > 0 ? 'danger' : 'positive'}>
            {openIncidents.length > 0 ? `${openIncidents.length} open` : 'None open'}
          </Badge>
        </div>
        {openIncidents.length === 0 ? (
          <div className="incident-empty">
            <ShieldCheck size={25} />
            <div>
              <h3>No open safety or property incidents</h3>
              <p>
                Near misses remain reportable. AI may organize facts and draft an evidence packet,
                but cannot call emergency services, admit fault, contact authorities/insurers, or
                send incident communications.
              </p>
            </div>
          </div>
        ) : (
          <div className="incident-list">
            {openIncidents.map((incident) => (
              <article className="incident-list__item" key={incident.id}>
                <AlertTriangle size={18} />
                <div>
                  <h3>
                    {incident.jobNumber} · {incident.kind.replaceAll('_', ' ')}
                  </h3>
                  <p>{incident.summary}</p>
                  <small>Reported by {incident.reportedBy} · affected automation paused</small>
                </div>
                <div className="incident-closure">
                  <label htmlFor={`operations-incident-closure-${incident.id}`}>
                    Factual closure note
                  </label>
                  <textarea
                    id={`operations-incident-closure-${incident.id}`}
                    className="textarea"
                    maxLength={2_000}
                    value={closureNotes[incident.id] ?? ''}
                    onChange={(event) =>
                      setClosureNotes((current) => ({
                        ...current,
                        [incident.id]: event.target.value,
                      }))
                    }
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={
                      !can('incidents.manage') ||
                      (closureNotes[incident.id]?.trim().length ?? 0) < 5
                    }
                    onClick={() =>
                      actions.closeIncident(incident.id, closureNotes[incident.id] ?? '')
                    }
                  >
                    Close after review
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function RecurringPanel() {
  const { state, actions, can } = useStoryOps();
  const rows = [
    ['Jamie Ortiz', 'Westlake primary', 'Soft wash + gutters', 'Semiannual', 'Jan 14, 2027'],
    ['Taylor Nguyen', 'Stone Creek', 'Gutter service', 'Quarterly', 'Oct 25, 2026'],
    ['Chris Hall', 'Briarwood', 'Driveway wash', 'Annual', 'Aug 8, 2026'],
    ['Alex Kim', 'North Dallas', 'Whole property', 'Semiannual', 'Aug 17, 2026'],
    ...(state.recurringPlanActive
      ? [['Morgan Ellis', 'Cedar Ridge', 'Gutter + exterior care', 'Semiannual', 'Jan 31, 2027']]
      : []),
  ];

  return (
    <div>
      <section className="recurring-metrics">
        <Card>
          <strong>{38 + (state.recurringPlanActive ? 1 : 0)}</strong>
          <span>active plans</span>
        </Card>
        <Card>
          <strong>$3,840</strong>
          <span>forecasted next 90 days</span>
        </Card>
        <Card>
          <strong>86%</strong>
          <span>renewal acceptance</span>
        </Card>
        <Card>
          <strong>4</strong>
          <span>plans due in August</span>
        </Card>
      </section>
      <Card className="section-card">
        <div className="section-card__header">
          <div>
            <h2>Recurring maintenance</h2>
            <p className="section-card__subtitle">
              Cadence is a proposal until customer acceptance; fresh estimates follow policy
            </p>
          </div>
          <Button
            size="sm"
            icon={<Plus size={14} />}
            disabled={!can('campaigns.manage') || state.recurringPlanActive}
            onClick={actions.activateRecurringPlan}
          >
            {state.recurringPlanActive ? 'Morgan plan active' : 'Add Morgan plan'}
          </Button>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Property</th>
                <th>Services</th>
                <th>Cadence</th>
                <th>Next due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row[0]}>
                  {row.map((cell, index) => (
                    <td key={cell}>{index === 5 ? <Badge tone="positive">{cell}</Badge> : cell}</td>
                  ))}
                  <td>
                    <Badge tone="positive">Active</Badge>
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
