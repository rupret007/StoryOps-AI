import {
  Camera,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Filter,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import type { DemoLead, LeadStage } from '@/state/model';
import { Avatar, Badge, Button, PageHeader } from '@/components/ui/Primitives';

const stages: { id: LeadStage; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'qualified', label: 'Qualified' },
  { id: 'estimated', label: 'Estimated' },
  { id: 'quoted', label: 'Quoted' },
  { id: 'booked', label: 'Booked' },
];

const sourceTone: Record<DemoLead['source'], 'info' | 'positive' | 'warning' | 'neutral'> = {
  Web: 'info',
  SMS: 'positive',
  Phone: 'warning',
  Email: 'neutral',
  Chat: 'info',
  Referral: 'positive',
  Manual: 'neutral',
};

const numericLeadValue = (value: string): number => {
  const parsed = Number(value.replace(/[$,]/gu, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

function LeadCard({ lead, onSelect }: { lead: DemoLead; onSelect(lead: DemoLead): void }) {
  return (
    <article
      className="lead-card"
      onClick={() => onSelect(lead)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onSelect(lead);
      }}
      role="button"
      tabIndex={0}
      aria-label={`Open ${lead.name}`}
    >
      <div className="lead-card__top">
        <div>
          <p className="lead-card__name">{lead.name}</p>
          <p className="lead-card__service">{lead.service}</p>
        </div>
        <Badge tone={sourceTone[lead.source]}>{lead.source}</Badge>
      </div>
      <div className="lead-card__address">
        <MapPin size={12} aria-hidden="true" />
        <span>
          {lead.address}
          <br />
          {lead.city}
        </span>
      </div>
      {lead.priority === 'high' && (
        <Badge tone="warning" className="lead-card__priority">
          High intent
        </Badge>
      )}
      <div className="lead-card__footer">
        <span className="lead-card__amount">{lead.value}</span>
        <span className="lead-card__age">
          {lead.age === 'unknown time' ? lead.age : `${lead.age} ago`}
        </span>
      </div>
    </article>
  );
}

function LeadDetail({ lead, onClose }: { lead: DemoLead; onClose(): void }) {
  const { state, actions, can } = useStoryOps();
  const navigate = useNavigate();
  const isNew = lead.stage === 'new';
  const availableProperties = state.live?.properties ?? [];
  const [scopePropertyId, setScopePropertyId] = useState(lead.propertyId ?? '');
  const scopeProperty = availableProperties.find((property) => property.id === scopePropertyId);
  const hasExactScope =
    state.dataMode !== 'supabase' || Boolean(lead.customerId && lead.propertyId);

  return (
    <aside className="lead-detail-drawer" aria-label={`${lead.name} lead details`}>
      <div className="lead-detail-drawer__header">
        <Badge tone={lead.priority === 'high' ? 'warning' : 'neutral'}>
          {lead.priority === 'high' ? 'High intent' : lead.stage}
        </Badge>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close details">
          <X size={16} />
        </button>
      </div>
      <div className="detail-hero">
        <Avatar name={lead.name} size="lg" tone="blue" />
        <div className="detail-hero__content">
          <h2>{lead.name}</h2>
          <p>
            {lead.source} lead · {lead.age === 'unknown time' ? lead.age : `${lead.age} ago`}
          </p>
        </div>
      </div>

      <div className="lead-quick-actions">
        {lead.phone && (
          <>
            <a href={`tel:${lead.phone.replace(/\D/g, '')}`}>
              <Phone size={15} />
              Call
            </a>
            <a href={`sms:${lead.phone.replace(/\D/g, '')}`}>
              <MessageCircle size={15} />
              Text
            </a>
          </>
        )}
        {lead.email && (
          <a href={`mailto:${lead.email}`}>
            <Mail size={15} />
            Email
          </a>
        )}
        {!lead.phone && !lead.email && <Badge tone="warning">No contact channel projected</Badge>}
      </div>

      <section className="drawer-section">
        <h3>Requested scope</h3>
        <div className="requested-scope">
          <span className="requested-scope__icon">
            <Camera size={16} />
          </span>
          <div>
            <strong>{lead.service}</strong>
            <p>{lead.note}</p>
          </div>
        </div>
      </section>

      <section className="drawer-section">
        <h3>Verified facts</h3>
        <div className="detail-grid">
          <div className="detail-item">
            <span className="detail-item__label">Phone</span>
            <span className="detail-item__value">{lead.phone}</span>
          </div>
          <div className="detail-item">
            <span className="detail-item__label">Email</span>
            <span className="detail-item__value">{lead.email}</span>
          </div>
          <div className="detail-item">
            <span className="detail-item__label">Address</span>
            <span className="detail-item__value">{lead.city}</span>
          </div>
          <div className="detail-item">
            <span className="detail-item__label">Consent</span>
            <span className="detail-item__value">
              {lead.consent ? 'Transactional granted' : 'Unknown'}
            </span>
          </div>
        </div>
      </section>

      <section className="drawer-section">
        <h3>AI qualification</h3>
        <div className="qualification-box">
          <span>
            <Sparkles size={15} />
          </span>
          <div>
            <strong>{isNew ? 'Ready to qualify' : 'Qualification complete'}</strong>
            <p>
              {isNew
                ? state.dataMode === 'supabase'
                  ? 'Review only the server-projected facts. Missing consent, property, or scope evidence must remain unknown.'
                  : 'Contact, consent, location, and service intent are present. Measurements still require evidence.'
                : 'No unsupported price, measurement, availability, or safety claim was used.'}
            </p>
          </div>
        </div>
      </section>

      {state.dataMode === 'supabase' && !isNew && (
        <section className="drawer-section">
          <h3>Estimate property</h3>
          {lead.customerId && lead.propertyId ? (
            <div className="qualification-box">
              <span>
                <CheckCircle2 size={15} />
              </span>
              <div>
                <strong>Exact scope linked</strong>
                <p>
                  {availableProperties.find((property) => property.id === lead.propertyId)
                    ?.address ?? 'The server-linked property is ready for estimating.'}
                </p>
              </div>
            </div>
          ) : (
            <>
              <label htmlFor={`lead-property-${lead.id}`}>Verified customer property</label>
              <select
                id={`lead-property-${lead.id}`}
                className="select"
                value={scopePropertyId}
                onChange={(event) => setScopePropertyId(event.target.value)}
              >
                <option value="">Select an exact property…</option>
                {availableProperties.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name} · {property.address}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                disabled={!scopeProperty || !state.online}
                onClick={() => {
                  if (scopeProperty) {
                    actions.linkLeadScope(lead.id, scopeProperty.customerId, scopeProperty.id);
                  }
                }}
                icon={<MapPin size={15} />}
              >
                Link verified property
              </Button>
              <p>
                This audited link prevents a company-global or first-record fallback. Create the
                customer/property first if it is not listed.
              </p>
            </>
          )}
        </section>
      )}

      <div className="drawer-actions">
        {isNew ? (
          <Button
            size="lg"
            disabled={!can('customers.write')}
            onClick={() => actions.qualifyLead(lead.id)}
            icon={<ShieldCheck size={16} />}
          >
            Qualify with policy
          </Button>
        ) : (
          <Button
            size="lg"
            disabled={!can('estimates.write') || !hasExactScope}
            onClick={() =>
              navigate(
                `/estimates/${state.estimate.id || 'workspace'}?lead=${encodeURIComponent(lead.id)}`,
              )
            }
            icon={<CircleDollarSign size={16} />}
          >
            {!hasExactScope
              ? 'Link property before estimate'
              : lead.stage === 'qualified'
                ? 'Build estimate'
                : 'Open estimate'}
          </Button>
        )}
        <p>Actions are permission-checked, idempotent, and appended to the audit trail.</p>
      </div>

      <section className="drawer-section drawer-section--timeline">
        <h3>Timeline</h3>
        <ul className="activity-list">
          <li className="activity-item">
            <span className="activity-item__icon">
              <CheckCircle2 size={13} />
            </span>
            <p className="activity-item__text">
              {state.dataMode === 'supabase'
                ? 'Lead returned by authenticated workspace'
                : 'Intake channel and consent recorded'}
              <span className="activity-item__time">
                {lead.age === 'unknown time' ? lead.age : `${lead.age} ago`}
              </span>
            </p>
          </li>
          <li className="activity-item">
            <span className="activity-item__icon">
              <Clock3 size={13} />
            </span>
            <p className="activity-item__text">
              Awaiting next policy-approved action
              <span className="activity-item__time">current state</span>
            </p>
          </li>
        </ul>
      </section>
    </aside>
  );
}

export function PipelinePage() {
  const { state, actions, can } = useStoryOps();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'board' | 'list'>('board');
  const [highOnly, setHighOnly] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    source: 'Phone' as DemoLead['source'],
    service: '',
    address: '',
    city: '',
    phone: '',
    email: '',
    consent: false,
  });
  const selectedId = searchParams.get('lead');
  const selectedLead = state.leads.find((lead) => lead.id === selectedId);
  const totalValue = state.leads.reduce((sum, lead) => sum + numericLeadValue(lead.value), 0);

  const filteredLeads = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return state.leads.filter((lead) => {
      const matchesQuery =
        !normalized ||
        `${lead.name} ${lead.service} ${lead.address} ${lead.city} ${lead.source}`
          .toLowerCase()
          .includes(normalized);
      return matchesQuery && (!highOnly || lead.priority === 'high');
    });
  }, [highOnly, query, state.leads]);

  const grouped = useMemo(
    () =>
      Object.fromEntries(
        stages.map((stage) => [stage.id, filteredLeads.filter((lead) => lead.stage === stage.id)]),
      ) as Record<LeadStage, DemoLead[]>,
    [filteredLeads],
  );

  const selectLead = (lead: DemoLead) => {
    actions.selectLead(lead.id);
    setSearchParams({ lead: lead.id });
  };

  return (
    <div className="page page--wide">
      <PageHeader
        eyebrow="Revenue pipeline"
        title="From first hello to booked work"
        description={
          state.dataMode === 'supabase'
            ? `${state.leads.length} role-visible leads · missing values remain unscoped · server RBAC controls every write.`
            : `${state.leads.length} active opportunities · $${totalValue.toLocaleString()} verified value · AI only advances grounded records.`
        }
        actions={
          <Button
            disabled={!can('customers.write')}
            onClick={() => setAddOpen(true)}
            icon={<Plus size={16} />}
          >
            Add lead
          </Button>
        }
      />

      <div className="pipeline-toolbar">
        <div className="toolbar-group">
          <div className="segmented" aria-label="Pipeline view">
            <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>
              Board
            </button>
            <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
              List
            </button>
          </div>
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={highOnly}
            onClick={() => setHighOnly((value) => !value)}
            icon={<Filter size={14} />}
          >
            {highOnly ? 'High intent only' : 'All priorities'}
          </Button>
        </div>
        <div className="pipeline-search">
          <Search size={14} />
          <input
            aria-label="Filter pipeline"
            placeholder="Filter this pipeline…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {view === 'board' ? (
        <div className="pipeline-board" aria-label="Lead pipeline">
          {stages.map((stage) => {
            const leads = grouped[stage.id];
            const value = leads.reduce((sum, lead) => sum + numericLeadValue(lead.value), 0);
            return (
              <section className="pipeline-column" key={stage.id}>
                <header className="pipeline-column__header">
                  <div className="pipeline-column__title">
                    {stage.label}
                    <span className="pipeline-column__count">{leads.length}</span>
                  </div>
                  <span className="pipeline-column__value">
                    {value === 0 ? 'Unscoped' : `$${value.toLocaleString()}`}
                  </span>
                </header>
                <div className="pipeline-cards">
                  {leads.map((lead) => (
                    <LeadCard key={lead.id} lead={lead} onSelect={selectLead} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="pipeline-list-view" aria-label="Lead pipeline list">
          {filteredLeads.map((lead) => (
            <LeadCard key={lead.id} lead={lead} onSelect={selectLead} />
          ))}
        </div>
      )}

      {selectedLead && (
        <>
          <button
            className="drawer-backdrop"
            type="button"
            aria-label="Close lead details"
            onClick={() => setSearchParams({})}
          />
          <LeadDetail
            key={selectedLead.id}
            lead={selectedLead}
            onClose={() => setSearchParams({})}
          />
        </>
      )}

      {addOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setAddOpen(false)}>
          <form
            className="record-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-lead-title"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              actions.addLead(draft);
              setDraft({
                name: '',
                source: 'Phone',
                service: '',
                address: '',
                city: '',
                phone: '',
                email: '',
                consent: false,
              });
              setAddOpen(false);
            }}
          >
            <h2 id="add-lead-title">Add an inbound lead</h2>
            <p className="section-card__subtitle">
              Record customer-supplied facts only. Qualification remains a separate guarded step.
            </p>
            <label htmlFor="lead-name">Customer name</label>
            <input
              id="lead-name"
              className="input"
              required
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
            <label htmlFor="lead-source">Source channel</label>
            <select
              id="lead-source"
              className="select"
              value={draft.source}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  source: event.target.value as DemoLead['source'],
                }))
              }
            >
              {['Web', 'SMS', 'Phone', 'Email', 'Chat', 'Referral', 'Manual'].map((source) => (
                <option key={source}>{source}</option>
              ))}
            </select>
            <label htmlFor="lead-service">Requested service</label>
            <input
              id="lead-service"
              className="input"
              value={draft.service}
              onChange={(event) =>
                setDraft((current) => ({ ...current, service: event.target.value }))
              }
            />
            <label htmlFor="lead-address">Service address</label>
            <input
              id="lead-address"
              className="input"
              required
              value={draft.address}
              onChange={(event) =>
                setDraft((current) => ({ ...current, address: event.target.value }))
              }
            />
            <label htmlFor="lead-city">City / ZIP</label>
            <input
              id="lead-city"
              className="input"
              value={draft.city}
              onChange={(event) =>
                setDraft((current) => ({ ...current, city: event.target.value }))
              }
            />
            <label htmlFor="lead-phone">Phone</label>
            <input
              id="lead-phone"
              className="input"
              value={draft.phone}
              onChange={(event) =>
                setDraft((current) => ({ ...current, phone: event.target.value }))
              }
            />
            <label htmlFor="lead-email">Email</label>
            <input
              id="lead-email"
              className="input"
              type="email"
              value={draft.email}
              onChange={(event) =>
                setDraft((current) => ({ ...current, email: event.target.value }))
              }
            />
            <label className="consent-check" htmlFor="lead-consent">
              <input
                id="lead-consent"
                type="checkbox"
                checked={draft.consent}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, consent: event.target.checked }))
                }
              />
              Transactional consent evidence was supplied
            </label>
            <div className="record-dialog__actions">
              <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Create unqualified lead</Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
