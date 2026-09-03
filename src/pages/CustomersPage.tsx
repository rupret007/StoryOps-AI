import {
  Building2,
  CalendarClock,
  ChevronRight,
  CircleDollarSign,
  Download,
  Home,
  MapPin,
  MapPinned,
  Plus,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Avatar, Badge, Button, Card, PageHeader } from '@/components/ui/Primitives';
import {
  candidateIsConfirmable,
  type PropertyGeocodeCandidatesReceipt,
} from '@/core/properties/contracts';
import { sandboxCustomerRecords, type SandboxCustomerRecord } from '@/data/sandboxCustomers';
import { useSearchParams } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { downloadText, rowsToCsv } from '@/utils/download';

export function CustomersPage() {
  const { state, actions, can } = useStoryOps();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'active' | 'leads' | 'all'>('all');
  const [records, setRecords] = useState<SandboxCustomerRecord[]>(() =>
    sandboxCustomerRecords.map((record) => ({ ...record })),
  );
  const [addOpen, setAddOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const [geocodeBusyId, setGeocodeBusyId] = useState<string>();
  const [geocodeError, setGeocodeError] = useState<{
    propertyId: string;
    message: string;
  }>();
  const [geocodeReceipt, setGeocodeReceipt] = useState<PropertyGeocodeCandidatesReceipt>();
  const [draft, setDraft] = useState({
    name: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    region: 'TX',
    postalCode: '',
  });
  const displayedRecords =
    state.dataMode === 'supabase'
      ? (state.live?.customers ?? []).map((customer) => ({
          ...customer,
          tone:
            customer.status === 'Active'
              ? ('green' as const)
              : customer.status === 'Lead'
                ? ('blue' as const)
                : ('plum' as const),
        }))
      : records;
  const selectedId = searchParams.get('customer') ?? undefined;
  const selected = displayedRecords.find((customer) => customer.id === selectedId);
  const setSelectedId = (customerId?: string) => {
    const next = new URLSearchParams(searchParams);
    if (customerId) next.set('customer', customerId);
    else next.delete('customer');
    setSearchParams(next);
  };
  const selectedProperties =
    state.dataMode === 'supabase' && selected
      ? (state.live?.properties ?? []).filter((property) => property.customerId === selected.id)
      : [];
  const visible = displayedRecords.filter((customer) => {
    const matchesQuery = `${customer.name} ${customer.email} ${customer.address}`
      .toLowerCase()
      .includes(query.toLowerCase());
    const matchesFilter =
      filter === 'all' ||
      (filter === 'active' && customer.status === 'Active') ||
      (filter === 'leads' && customer.status === 'Lead');
    return matchesQuery && matchesFilter;
  });
  const exportCustomers = () => {
    downloadText(
      'storyops-customers.csv',
      rowsToCsv([
        ['Customer', 'Email', 'Phone', 'Property', 'Status', 'Lifetime value'],
        ...displayedRecords.map((customer) => [
          customer.name,
          customer.email,
          customer.phone,
          customer.address,
          customer.status,
          customer.lifetime,
        ]),
      ]),
      'text/csv;charset=utf-8',
    );
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Customers & properties"
        title="A clean record for every place you serve"
        description="Customers own contact and consent. Properties own measurements, access, hazards, service history, and recurring care."
        actions={
          <>
            <Button variant="secondary" onClick={exportCustomers} icon={<Download size={15} />}>
              Export
            </Button>
            <Button
              disabled={!can('customers.write')}
              onClick={() => setAddOpen(true)}
              icon={<Plus size={15} />}
            >
              Add customer
            </Button>
          </>
        }
      />

      {selectedId && !selected && (
        <div role="status">
          <Card className="record-target-notice">
            <div>
              <strong>That customer is not in the current role-visible workspace.</strong>
              <p>The record may have changed or fallen outside this signed-in scope.</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setSelectedId(undefined)}>
              Show role-visible customers
            </Button>
          </Card>
        </div>
      )}

      <section className="customer-summary-grid">
        <Card>
          <UserRound size={18} />
          <div>
            <strong>
              {state.dataMode === 'supabase'
                ? displayedRecords.filter((record) => record.status === 'Active').length
                : 128}
            </strong>
            <span>active customers</span>
          </div>
        </Card>
        <Card>
          <Home size={18} />
          <div>
            <strong>
              {state.dataMode === 'supabase'
                ? displayedRecords.reduce((total, record) => total + record.properties, 0)
                : 146}
            </strong>
            <span>service properties</span>
          </div>
        </Card>
        <Card>
          <CircleDollarSign size={18} />
          <div>
            <strong>
              {state.dataMode === 'supabase'
                ? displayedRecords.length > 0
                  ? new Intl.NumberFormat('en-US', {
                      style: 'currency',
                      currency: 'USD',
                      maximumFractionDigits: 0,
                    }).format(
                      displayedRecords.reduce(
                        (total, record) => total + Number(record.lifetime.replaceAll(/[$,]/gu, '')),
                        0,
                      ) / displayedRecords.length,
                    )
                  : '$0'
                : '$824'}
            </strong>
            <span>recorded average value</span>
          </div>
        </Card>
        <Card>
          <CalendarClock size={18} />
          <div>
            <strong>{state.dataMode === 'supabase' ? '—' : '38'}</strong>
            <span>
              {state.dataMode === 'supabase'
                ? 'plans not in this role projection'
                : 'maintenance plans'}
            </span>
          </div>
        </Card>
      </section>

      <Card className="customer-table-card">
        <div className="list-toolbar">
          <div className="pipeline-search">
            <Search size={14} />
            <input
              aria-label="Search customers"
              placeholder="Search customers or properties…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="segmented">
            <button
              type="button"
              aria-pressed={filter === 'active'}
              onClick={() => setFilter('active')}
            >
              Active
            </button>
            <button
              type="button"
              aria-pressed={filter === 'leads'}
              onClick={() => setFilter('leads')}
            >
              Leads
            </button>
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              All
            </button>
          </div>
        </div>
        <div className="table-wrap customer-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Property</th>
                <th>Last service</th>
                <th>Next action</th>
                <th>Lifetime value</th>
                <th>Status</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {visible.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    <div className="customer-cell">
                      <Avatar name={customer.name} tone={customer.tone} />
                      <div>
                        <p className="customer-cell__name">{customer.name}</p>
                        <p className="customer-cell__meta">{customer.email}</p>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="property-cell">
                      <MapPin size={13} />
                      <span>
                        {customer.address}
                        {customer.properties > 1 && (
                          <small>+{customer.properties - 1} more property</small>
                        )}
                      </span>
                    </div>
                  </td>
                  <td>{customer.lastService}</td>
                  <td>{customer.nextDue}</td>
                  <td>
                    <strong>{customer.lifetime}</strong>
                  </td>
                  <td>
                    <Badge
                      tone={
                        customer.status === 'Active'
                          ? 'positive'
                          : customer.status === 'Lead'
                            ? 'info'
                            : 'warning'
                      }
                      dot
                    >
                      {customer.status}
                    </Badge>
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Open ${customer.name}`}
                      onClick={() => setSelectedId(customer.id)}
                    >
                      <ChevronRight size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="module-note-grid">
        <Card className="module-note">
          <span className="module-note__icon">
            <Building2 size={18} />
          </span>
          <div>
            <h3>Property truth stays separate</h3>
            <p>
              Measurements are versioned by source and confidence. Access instructions and hazards
              belong to the property, not a one-off quote.
            </p>
          </div>
        </Card>
        <Card className="module-note">
          <span className="module-note__icon">
            <ShieldCheck size={18} />
          </span>
          <div>
            <h3>Consent is purpose-specific</h3>
            <p>
              Transactional and marketing consent have separate evidence, disclosures, and
              withdrawal history.
            </p>
          </div>
        </Card>
      </div>

      {selected && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setSelectedId(undefined)}
        >
          <section
            className="record-dialog customer-record-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="customer-record-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button record-dialog__close"
              type="button"
              aria-label="Close customer record"
              onClick={() => setSelectedId(undefined)}
            >
              <X size={15} />
            </button>
            <Badge tone={selected.status === 'Lead' ? 'info' : 'positive'}>{selected.status}</Badge>
            <h2 id="customer-record-title">{selected.name}</h2>
            <div className="detail-grid">
              <div className="detail-item">
                <span className="detail-item__label">Email</span>
                <span>{selected.email}</span>
              </div>
              <div className="detail-item">
                <span className="detail-item__label">Phone</span>
                <span>{selected.phone}</span>
              </div>
              <div className="detail-item">
                <span className="detail-item__label">Property</span>
                <span>{selected.address}</span>
              </div>
              <div className="detail-item">
                <span className="detail-item__label">Next action</span>
                <span>{selected.nextDue}</span>
              </div>
            </div>
            {state.dataMode === 'supabase' && (
              <section
                className="property-geocode-review"
                aria-labelledby="property-geocode-review-title"
              >
                <div className="property-geocode-review__heading">
                  <div>
                    <p className="eyebrow">Scheduling prerequisite</p>
                    <h3 id="property-geocode-review-title">Review service coordinates</h3>
                  </div>
                  <MapPinned aria-hidden="true" size={19} />
                </div>
                <p>
                  StoryOps accepts coordinates only from a fresh live Maps result that an owner or
                  dispatcher explicitly confirms. Typed addresses never become coordinates by
                  inference.
                </p>
                {selectedProperties.length === 0 ? (
                  <div className="property-geocode-review__notice" role="status">
                    No role-visible service property is attached to this customer.
                  </div>
                ) : (
                  <ul className="property-geocode-list" aria-label="Customer service properties">
                    {selectedProperties.map((property) => {
                      const candidates =
                        geocodeReceipt?.propertyId === property.id &&
                        geocodeReceipt.propertyVersion === property.version
                          ? geocodeReceipt.candidates
                          : [];
                      const busy = geocodeBusyId === property.id;
                      return (
                        <li key={property.id}>
                          <div className="property-geocode-row">
                            <div>
                              <strong>{property.name}</strong>
                              <span>{property.address}</span>
                              <small>Record version {property.version}</small>
                            </div>
                            <Badge
                              tone={
                                property.geocodeReviewStatus === 'confirmed'
                                  ? 'positive'
                                  : 'warning'
                              }
                            >
                              {property.geocodeReviewStatus === 'confirmed'
                                ? 'Live coordinates reviewed'
                                : 'Review required'}
                            </Badge>
                          </div>
                          {property.geocodeReviewStatus === 'confirmed' ? (
                            <div className="property-geocode-review__notice" role="status">
                              {property.geocodeProvider?.replaceAll('_', ' ')} ·{' '}
                              {property.geocodePrecision} ·{' '}
                              {Math.round((property.geocodeConfidence ?? 0) * 100)}% provider
                              confidence
                            </div>
                          ) : (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                loading={busy && candidates.length === 0}
                                disabled={
                                  !can('properties.write') ||
                                  !state.online ||
                                  !state.serverVerifiedAt ||
                                  property.version < 1
                                }
                                onClick={async () => {
                                  setGeocodeBusyId(property.id);
                                  setGeocodeError(undefined);
                                  const receipt = await actions.requestPropertyGeocode({
                                    propertyId: property.id,
                                    expectedPropertyVersion: property.version,
                                  });
                                  setGeocodeBusyId(undefined);
                                  if (receipt) {
                                    setGeocodeReceipt(receipt);
                                  } else {
                                    setGeocodeError({
                                      propertyId: property.id,
                                      message:
                                        'No coordinates were accepted. Verify live Maps health, then retry this exact property.',
                                    });
                                  }
                                }}
                              >
                                Request live address candidates
                              </Button>
                              {geocodeError?.propertyId === property.id && (
                                <div className="property-geocode-review__error" role="alert">
                                  {geocodeError.message}
                                </div>
                              )}
                              {candidates.length > 0 && (
                                <div
                                  className="property-geocode-candidates"
                                  aria-label={`Live address candidates for ${property.name}`}
                                >
                                  <p>
                                    Compare the provider result with the customer-supplied service
                                    address. Confirmation changes the property record and unlocks
                                    only the coordinate prerequisite.
                                  </p>
                                  <ul>
                                    {candidates.map((candidate) => {
                                      const confirmable = candidateIsConfirmable(candidate);
                                      return (
                                        <li key={candidate.id}>
                                          <div>
                                            <strong>{candidate.formattedAddress}</strong>
                                            <span>
                                              Google Maps · {candidate.precision} ·{' '}
                                              {Math.round(candidate.confidence * 100)}% confidence
                                            </span>
                                            <small>
                                              Evidence expires{' '}
                                              <time dateTime={candidate.expiresAt}>
                                                {new Date(candidate.expiresAt).toLocaleString()}
                                              </time>
                                            </small>
                                          </div>
                                          <Button
                                            type="button"
                                            size="sm"
                                            loading={busy}
                                            disabled={!confirmable || busy}
                                            aria-label={`Confirm exact address ${candidate.formattedAddress}`}
                                            onClick={async () => {
                                              setGeocodeBusyId(property.id);
                                              setGeocodeError(undefined);
                                              const receipt = await actions.confirmPropertyGeocode({
                                                propertyId: property.id,
                                                expectedPropertyVersion: property.version,
                                                candidateId: candidate.id,
                                              });
                                              setGeocodeBusyId(undefined);
                                              if (receipt) {
                                                setGeocodeReceipt(undefined);
                                              } else {
                                                setGeocodeError({
                                                  propertyId: property.id,
                                                  message:
                                                    'The candidate was not confirmed. Refresh the property and request fresh evidence.',
                                                });
                                              }
                                            }}
                                          >
                                            Confirm exact address
                                          </Button>
                                          {!confirmable && (
                                            <small className="property-geocode-candidate__blocked">
                                              This result is stale, too imprecise, or below the
                                              confirmation threshold.
                                            </small>
                                          )}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}
          </section>
        </div>
      )}

      {addOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setAddOpen(false)}>
          <form
            className="record-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-customer-title"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={async (event) => {
              event.preventDefault();
              const name = draft.name.trim();
              if (!name || !draft.address.trim()) return;
              if (state.dataMode === 'supabase') {
                setCreateBusy(true);
                setCreateError(undefined);
                const receipt = await actions.createCustomerProperty({
                  displayName: name,
                  email: draft.email,
                  phone: draft.phone,
                  acquisitionSource: 'manual',
                  propertyName: 'Primary property',
                  serviceAddress: {
                    line1: draft.address,
                    city: draft.city,
                    region: draft.region,
                    postalCode: draft.postalCode,
                    country: 'US',
                  },
                });
                setCreateBusy(false);
                if (!receipt) {
                  setCreateError(
                    'No creation receipt was accepted. Keep these facts unchanged and retry the same operation, or refresh the authoritative workspace before entering different facts.',
                  );
                  return;
                }
                setDraft({
                  name: '',
                  email: '',
                  phone: '',
                  address: '',
                  city: '',
                  region: 'TX',
                  postalCode: '',
                });
                setAddOpen(false);
                return;
              }
              const record = {
                id: `customer-${Date.now().toString(36)}`,
                name,
                email: draft.email.trim(),
                phone: draft.phone.trim(),
                properties: 1,
                address: draft.address.trim(),
                lifetime: '$0',
                lastService: 'New customer',
                nextDue: 'Create property scope',
                status: 'Lead',
                tone: 'blue' as const,
              };
              setRecords((current) => [record, ...current]);
              setDraft({
                name: '',
                email: '',
                phone: '',
                address: '',
                city: '',
                region: 'TX',
                postalCode: '',
              });
              setAddOpen(false);
              setFilter('all');
              setSelectedId(record.id);
            }}
          >
            <h2 id="add-customer-title">Add a verified customer</h2>
            <p className="section-card__subtitle">
              Enter supplied facts only. Measurements and pricing remain separate.
            </p>
            {createError && (
              <div className="property-geocode-review__error" role="alert">
                {createError}
              </div>
            )}
            <label htmlFor="new-customer-name">Customer name</label>
            <input
              id="new-customer-name"
              className="input"
              required
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
            <label htmlFor="new-customer-city">City</label>
            <input
              id="new-customer-city"
              className="input"
              required={state.dataMode === 'supabase'}
              value={draft.city}
              onChange={(event) =>
                setDraft((current) => ({ ...current, city: event.target.value }))
              }
            />
            <label htmlFor="new-customer-region">State / region</label>
            <input
              id="new-customer-region"
              className="input"
              required={state.dataMode === 'supabase'}
              value={draft.region}
              onChange={(event) =>
                setDraft((current) => ({ ...current, region: event.target.value }))
              }
            />
            <label htmlFor="new-customer-postal">Postal code</label>
            <input
              id="new-customer-postal"
              className="input"
              required={state.dataMode === 'supabase'}
              value={draft.postalCode}
              onChange={(event) =>
                setDraft((current) => ({ ...current, postalCode: event.target.value }))
              }
            />
            <label htmlFor="new-customer-email">Email</label>
            <input
              id="new-customer-email"
              className="input"
              type="email"
              value={draft.email}
              onChange={(event) =>
                setDraft((current) => ({ ...current, email: event.target.value }))
              }
            />
            <label htmlFor="new-customer-phone">Phone</label>
            <input
              id="new-customer-phone"
              className="input"
              value={draft.phone}
              onChange={(event) =>
                setDraft((current) => ({ ...current, phone: event.target.value }))
              }
            />
            <label htmlFor="new-customer-address">Service property</label>
            <input
              id="new-customer-address"
              className="input"
              required
              value={draft.address}
              onChange={(event) =>
                setDraft((current) => ({ ...current, address: event.target.value }))
              }
            />
            <div className="record-dialog__actions">
              <Button
                type="button"
                variant="secondary"
                disabled={createBusy}
                onClick={() => setAddOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={createBusy}>
                Create customer and property
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
