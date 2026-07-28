import {
  AlertTriangle,
  ArrowLeft,
  Calculator,
  Camera,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  FileCheck2,
  Info,
  LockKeyhole,
  Ruler,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import {
  confirmedLiveEstimateMatchesDraft,
  reserveLiveEstimateIdempotencyKey,
  type LiveEstimateContext,
  type LiveEstimateIdempotencyReservation,
  type LiveEstimateIntent,
  type LiveEstimateReceipt,
} from '@/state/liveEstimating';
import { Badge, Button, Card, Field, PageHeader } from '@/components/ui/Primitives';

const formatMoney = (amount: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount));

type LiveServiceSelection = {
  enabled: boolean;
  measurementId: string;
  attributes: Record<string, string>;
  addOns: Record<string, { enabled: boolean; measurementId: string }>;
};

const measurementKindForUnit = (unit: string) =>
  unit === 'sq_ft'
    ? 'area_sq_ft'
    : unit === 'linear_ft'
      ? 'length_linear_ft'
      : unit === 'each'
        ? 'count'
        : undefined;

const displayCode = (value: string) =>
  value
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');

export function EstimatePage() {
  const { state, actions, can } = useStoryOps();
  const estimate = state.estimate;
  const [previewOpen, setPreviewOpen] = useState(false);
  const lead = state.leads.find((item) => item.id === estimate.leadId);
  const pending = estimate.status === 'pending_approval';
  const approved = estimate.status === 'approved' || estimate.status === 'quoted';
  const quoted = estimate.status === 'quoted';

  if (state.dataMode === 'supabase') return <LiveEstimatePage />;

  return (
    <div className="page">
      <Link className="back-link" to="/pipeline?lead=lead-morgan">
        <ArrowLeft size={14} /> Back to Morgan Ellis
      </Link>
      <PageHeader
        eyebrow={`${estimate.estimateNumber} · deterministic pricing`}
        title="Build a verified estimate"
        description="Measurements and price-book rules are source facts. AI can organize scope and flag uncertainty; it cannot invent either."
        actions={
          <>
            <Badge tone={pending ? 'warning' : approved ? 'positive' : 'neutral'} dot>
              {pending
                ? 'Owner approval pending'
                : quoted
                  ? 'Quote sent'
                  : approved
                    ? 'Within policy'
                    : 'Draft'}
            </Badge>
            <Button
              variant="secondary"
              onClick={() => setPreviewOpen(true)}
              icon={<FileCheck2 size={15} />}
            >
              Preview quote
            </Button>
          </>
        }
      />

      <div className="estimate-layout">
        <div>
          <Card className="estimate-section">
            <div className="section-card__header">
              <div>
                <h2>Customer & property</h2>
                <p className="section-card__subtitle">Verified source records</p>
              </div>
              <Badge tone="positive" dot>
                Address normalized
              </Badge>
            </div>
            <div className="customer-summary-row">
              <div className="customer-summary-row__avatar">ME</div>
              <div>
                <strong>{lead?.name ?? 'Morgan Ellis'}</strong>
                <span>1842 Cedar Ridge Lane · Flower Mound, TX 75028</span>
              </div>
              <Link className="link-button" to="/customers">
                Open property <ChevronRight size={12} />
              </Link>
            </div>
          </Card>

          <Card className="estimate-section">
            <div className="section-card__header">
              <div>
                <h2>Photo-assisted scope</h2>
                <p className="section-card__subtitle">
                  Evidence is advisory until a human verifies billable measurements
                </p>
              </div>
              <Badge tone="info">
                {Math.round(estimate.photoEvidence.confidence * 100)}% confidence
              </Badge>
            </div>
            <div className="photo-evidence">
              <div className="photo-evidence__image">
                <Camera size={23} />
              </div>
              <div>
                <p className="photo-evidence__title">3 scope photos analyzed</p>
                <p className="photo-evidence__detail">
                  {estimate.photoEvidence.observations.join(' · ')}
                </p>
              </div>
              <Badge tone={estimate.photoEvidence.humanVerified ? 'positive' : 'warning'} dot>
                {estimate.photoEvidence.humanVerified ? 'Human verified' : 'Review required'}
              </Badge>
            </div>
            <div className="evidence-callout">
              <AlertTriangle size={15} />
              <div>
                <strong>Unknown retained: {estimate.photoEvidence.unknowns[0]}</strong>
                <p>
                  The estimate uses the customer-confirmed 188 linear feet, not an AI-derived
                  measurement. Technician must verify access at arrival.
                </p>
              </div>
            </div>
          </Card>

          <Card className="estimate-section">
            <div className="section-card__header">
              <div>
                <h2>Measurements & service rules</h2>
                <p className="section-card__subtitle">{estimate.priceBookVersion}</p>
              </div>
              <Badge tone="dark">
                <LockKeyhole size={11} /> Published
              </Badge>
            </div>
            <div className="service-line">
              <div>
                <strong className="service-line__title">Driveway pressure wash</strong>
                <span className="service-line__detail">
                  $110 base + $0.14 / sq ft after 500 · $185 minimum
                </span>
              </div>
              <Field label="Area" htmlFor="driveway-area">
                <div className="unit-input">
                  <input
                    id="driveway-area"
                    className="input"
                    inputMode="decimal"
                    value={estimate.drivewaySqFt}
                    onChange={(event) => actions.updateEstimate('drivewaySqFt', event.target.value)}
                    disabled={!can('estimates.write')}
                  />
                  <span>sq ft</span>
                </div>
              </Field>
              <Field label="Surface" htmlFor="surface">
                <select
                  id="surface"
                  className="select"
                  value={estimate.surface}
                  onChange={(event) => actions.updateEstimate('surface', event.target.value)}
                  disabled={!can('estimates.write')}
                >
                  <option value="concrete">Concrete</option>
                  <option value="pavers">Pavers</option>
                  <option value="aggregate">Aggregate</option>
                </select>
              </Field>
              <Badge tone="positive">Measured</Badge>
            </div>
            <div className="service-line">
              <div>
                <strong className="service-line__title">Gutter & downspout cleaning</strong>
                <span className="service-line__detail">
                  $155 base + $0.85 / linear ft after 100 · includes 4 flushes
                </span>
              </div>
              <Field label="Length" htmlFor="gutter-length">
                <div className="unit-input">
                  <input
                    id="gutter-length"
                    className="input"
                    inputMode="decimal"
                    value={estimate.gutterLinearFt}
                    onChange={(event) =>
                      actions.updateEstimate('gutterLinearFt', event.target.value)
                    }
                    disabled={!can('estimates.write')}
                  />
                  <span>lin ft</span>
                </div>
              </Field>
              <Field label="Stories" htmlFor="stories">
                <select
                  id="stories"
                  className="select"
                  value={estimate.stories}
                  onChange={(event) => actions.updateEstimate('stories', event.target.value)}
                  disabled={!can('estimates.write')}
                >
                  <option value="1">1 story</option>
                  <option value="2">2 stories</option>
                  <option value="3">3 stories</option>
                </select>
              </Field>
              <Badge tone="positive">Confirmed</Badge>
            </div>
          </Card>

          <Card className="estimate-section">
            <div className="section-card__header">
              <div>
                <h2>Scope attributes</h2>
                <p className="section-card__subtitle">
                  Every multiplier is explicit in the selected price-book version
                </p>
              </div>
              <Ruler size={18} color="#1f6d5e" />
            </div>
            <div className="input-group">
              <Field label="Soil level" htmlFor="soil">
                <select
                  id="soil"
                  className="select"
                  value={estimate.soil}
                  onChange={(event) => actions.updateEstimate('soil', event.target.value)}
                  disabled={!can('estimates.write')}
                >
                  <option value="light">Light · 0.92–0.95×</option>
                  <option value="moderate">Moderate · 1.00×</option>
                  <option value="heavy">Heavy · 1.25–1.28×</option>
                </select>
              </Field>
              <Field label="Access" htmlFor="access">
                <select
                  id="access"
                  className="select"
                  value={estimate.access}
                  onChange={(event) => actions.updateEstimate('access', event.target.value)}
                  disabled={!can('estimates.write')}
                >
                  <option value="clear">Clear · 1.00×</option>
                  <option value="limited">Limited · 1.18–1.20×</option>
                </select>
              </Field>
              <Field label="Risk band" htmlFor="risk">
                <select
                  id="risk"
                  className="select"
                  value={estimate.risk}
                  onChange={(event) => actions.updateEstimate('risk', event.target.value)}
                  disabled={!can('estimates.write')}
                >
                  <option value="standard">Standard · 1.00×</option>
                  <option value="elevated">Elevated · 1.25–1.30×</option>
                </select>
              </Field>
              <Field label="Travel zone" htmlFor="travel-zone">
                <select
                  id="travel-zone"
                  className="select"
                  value={estimate.travelZone}
                  onChange={(event) => actions.updateEstimate('travelZone', event.target.value)}
                  disabled={!can('estimates.write')}
                >
                  <option value="DFW-A">DFW-A · included</option>
                  <option value="DFW-B">DFW-B · $35</option>
                  <option value="DFW-C">DFW-C · $75</option>
                </select>
              </Field>
            </div>
            <div className="discount-row">
              <Field
                label="Discount"
                htmlFor="discount"
                hint="Above 10% creates an exact-payload owner approval."
              >
                <div className="unit-input unit-input--small">
                  <input
                    id="discount"
                    className="input"
                    inputMode="decimal"
                    value={estimate.discountPercent}
                    onChange={(event) =>
                      actions.updateEstimate('discountPercent', event.target.value)
                    }
                    disabled={!can('estimates.write')}
                  />
                  <span>%</span>
                </div>
              </Field>
              {Number(estimate.discountPercent) > 10 && (
                <Badge tone="warning">
                  <ShieldCheck size={11} /> Approval threshold exceeded
                </Badge>
              )}
            </div>
          </Card>
        </div>

        <Card className="price-summary">
          <div className="price-summary__header">
            <h2>Deterministic calculation</h2>
            <p>Decimal arithmetic · half-up currency rounding · no LLM prices</p>
          </div>
          <div className="price-summary__body">
            <div className="price-total">
              <div>
                <span className="price-total__label">Customer total</span>
                <p className="price-total__value">{formatMoney(estimate.total)}</p>
              </div>
              <Badge tone="positive">{estimate.marginPercent}% margin</Badge>
            </div>
            <div className="money-list">
              <div className="money-row">
                <span>Service subtotal</span>
                <strong>{formatMoney(estimate.serviceSubtotal)}</strong>
              </div>
              <div className="money-row">
                <span>Travel</span>
                <strong>{formatMoney(estimate.travelFee)}</strong>
              </div>
              <div className="money-row">
                <span>Discount</span>
                <strong>−{formatMoney(estimate.discount)}</strong>
              </div>
              <div className="money-row">
                <span>Sales tax · 8.25%</span>
                <strong>{formatMoney(estimate.tax)}</strong>
              </div>
            </div>
            <div className="estimate-facts">
              <div>
                <span>Deposit</span>
                <strong>{formatMoney(estimate.deposit)}</strong>
              </div>
              <div>
                <span>Duration</span>
                <strong>
                  {Math.floor(estimate.durationMinutes / 60)}h {estimate.durationMinutes % 60}m
                </strong>
              </div>
              <div>
                <span>Est. cost</span>
                <strong>{formatMoney(estimate.estimatedCost)}</strong>
              </div>
            </div>
            <div className={`policy-check ${pending ? 'policy-check--warning' : ''}`}>
              <div className="policy-check__row">
                {Number(estimate.discountPercent) <= 10 ? (
                  <CheckCircle2 size={14} />
                ) : (
                  <AlertTriangle size={14} />
                )}
                Discount {Number(estimate.discountPercent) <= 10 ? 'within' : 'above'} 10% auto
                limit
              </div>
              <div className="policy-check__row">
                <CheckCircle2 size={14} />
                Margin {estimate.marginPercent}% above 42% floor
              </div>
              <div className="policy-check__row">
                <CheckCircle2 size={14} />
                Published price book and human-verified scope
              </div>
            </div>

            {!approved && (
              <Button
                size="lg"
                className="full-width"
                disabled={!can('estimates.write')}
                onClick={actions.runPolicyCheck}
                icon={<Calculator size={17} />}
              >
                {pending ? 'Re-run policy check' : 'Calculate & check policy'}
              </Button>
            )}
            {approved && !quoted && (
              <Button
                size="lg"
                className="full-width"
                onClick={() => actions.sendQuote()}
                icon={<Send size={17} />}
              >
                Send quote & deposit link
              </Button>
            )}
            {quoted && (
              <Link className="button button--dark button--lg full-width" to="/portal">
                <CircleDollarSign size={17} />
                Open customer portal
              </Link>
            )}

            {pending && (
              <Link className="button button--secondary button--md full-width" to="/approvals">
                <ShieldCheck size={15} />
                Review approval request
              </Link>
            )}
            <p className="formula-note">
              <Info size={11} style={{ verticalAlign: 'middle' }} /> Calculation:{' '}
              {estimate.formulaHash}. Each input, rule, multiplier, rounding step, policy result,
              and approver is retained.
            </p>
          </div>
        </Card>
      </div>

      {previewOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setPreviewOpen(false)}
        >
          <section
            className="record-dialog quote-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quote-preview-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button record-dialog__close"
              type="button"
              aria-label="Close quote preview"
              onClick={() => setPreviewOpen(false)}
            >
              <X size={15} />
            </button>
            <p className="eyebrow">Customer quote preview</p>
            <h2 id="quote-preview-title">{estimate.estimateNumber} · Driveway + gutters</h2>
            <p>{lead?.name} · 1842 Cedar Ridge Lane, Flower Mound, TX 75028</p>
            <div className="money-list">
              <div className="money-row">
                <span>Driveway and gutter service</span>
                <strong>{formatMoney(estimate.serviceSubtotal)}</strong>
              </div>
              <div className="money-row">
                <span>Travel</span>
                <strong>{formatMoney(estimate.travelFee)}</strong>
              </div>
              <div className="money-row">
                <span>Discount</span>
                <strong>−{formatMoney(estimate.discount)}</strong>
              </div>
              <div className="money-row">
                <span>Estimated tax</span>
                <strong>{formatMoney(estimate.tax)}</strong>
              </div>
              <div className="money-row">
                <span>Total</span>
                <strong>{formatMoney(estimate.total)}</strong>
              </div>
            </div>
            <div className="portal-terms">
              <ShieldCheck size={17} />
              <p>
                Service Terms v2026.07. Additional work or pricing requires a separately accepted
                change. Deposit due at acceptance: {formatMoney(estimate.deposit)}.
              </p>
            </div>
            <Button variant="secondary" onClick={() => window.print()}>
              Print / save PDF
            </Button>
          </section>
        </div>
      )}
    </div>
  );
}

function LiveEstimatePage() {
  const { state, actions, can } = useStoryOps();
  const [searchParams] = useSearchParams();
  const requestedLeadId = searchParams.get('lead') ?? state.selectedLeadId;
  const selectedLead = state.leads.find((lead) => lead.id === requestedLeadId);
  const requestedCustomerId = selectedLead?.customerId;
  const requestedPropertyId = selectedLead?.propertyId;
  const scopeMissing = !selectedLead || !requestedCustomerId || !requestedPropertyId;
  const contextRequestKey = `${requestedLeadId}:${requestedCustomerId ?? ''}:${requestedPropertyId ?? ''}`;
  const [contextLoad, setContextLoad] = useState<{
    requestKey: string;
    status: 'loading' | 'ready' | 'error';
    context?: LiveEstimateContext;
    error?: string;
  }>({ requestKey: contextRequestKey, status: 'loading' });
  const estimateReservation = useRef<LiveEstimateIdempotencyReservation | undefined>(undefined);
  const submissionInFlight = useRef(false);
  const [operationError, setOperationError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [confirmedEstimate, setConfirmedEstimate] = useState<{
    contextRequestKey: string;
    intentFingerprint: string;
    receipt: LiveEstimateReceipt;
  }>();
  const [serviceSelections, setServiceSelections] = useState<Record<string, LiveServiceSelection>>(
    {},
  );
  const [discountPercent, setDiscountPercent] = useState('0');

  useEffect(() => {
    if (scopeMissing) return;
    let active = true;
    void actions
      .loadLiveEstimateContext(requestedPropertyId)
      .then((loaded) => {
        if (active) {
          setContextLoad({
            requestKey: contextRequestKey,
            status: 'ready',
            context: loaded,
          });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setContextLoad({
            requestKey: contextRequestKey,
            status: 'error',
            error:
              error instanceof Error ? error.message : 'Live estimate context could not be loaded.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [actions, contextRequestKey, requestedPropertyId, scopeMissing]);

  const activeContextLoad = contextLoad.requestKey === contextRequestKey ? contextLoad : undefined;
  const context = activeContextLoad?.context;
  const loading = !scopeMissing && (!activeContextLoad || activeContextLoad.status === 'loading');
  const contextError = scopeMissing
    ? 'Select a qualified lead with an exact server-linked customer and property before estimating.'
    : (activeContextLoad?.error ?? operationError);
  const property = context?.properties.find((item) => item.id === requestedPropertyId);
  const customer = context?.customers.find(
    (item) => item.id === requestedCustomerId && item.id === property?.customerId,
  );
  const measurements =
    context?.measurements.filter((item) => item.propertyId === property?.id) ?? [];
  const serviceRules = context?.priceBook.serviceRules ?? [];
  const enabledRules = serviceRules.filter((rule) => serviceSelections[rule.serviceCode]?.enabled);
  const selectionComplete =
    enabledRules.length > 0 &&
    enabledRules.every((rule) => {
      const selection = serviceSelections[rule.serviceCode];
      if (!selection?.measurementId) return false;
      const selectedMeasurement = measurements.find(
        (measurement) => measurement.id === selection.measurementId,
      );
      if (
        !selectedMeasurement ||
        selectedMeasurement.kind !== measurementKindForUnit(rule.pricingUnit) ||
        !selectedMeasurement.serviceCodes.includes(rule.serviceCode)
      ) {
        return false;
      }
      const requiredAttributes = Object.entries(rule.allowedAttributeValues).filter(
        ([attribute]) => attribute !== 'stories',
      );
      if (
        requiredAttributes.some(
          ([attribute, values]) => !values.includes(selection.attributes[attribute] ?? ''),
        )
      ) {
        return false;
      }
      return rule.addOns.every((addOn) => {
        const addOnSelection = selection.addOns[addOn.code];
        if (!addOnSelection?.enabled) return true;
        const addOnMeasurement = measurements.find(
          (measurement) => measurement.id === addOnSelection.measurementId,
        );
        return Boolean(
          addOnMeasurement &&
          addOnMeasurement.kind === measurementKindForUnit(addOn.unit) &&
          addOnMeasurement.addOnCodes.includes(addOn.code),
        );
      });
    });
  const draftServices: LiveEstimateIntent['services'] = selectionComplete
    ? enabledRules.map((rule) => {
        const selection = serviceSelections[rule.serviceCode]!;
        return {
          serviceCode: rule.serviceCode,
          measurementId: selection.measurementId,
          attributes: Object.fromEntries(
            Object.entries(selection.attributes).filter(([, value]) => Boolean(value)),
          ),
          addOns: rule.addOns.flatMap((addOn) => {
            const addOnSelection = selection.addOns[addOn.code];
            return addOnSelection?.enabled && addOnSelection.measurementId
              ? [{ code: addOn.code, measurementId: addOnSelection.measurementId }]
              : [];
          }),
        };
      })
    : [];
  const draftIntent: LiveEstimateIntent | undefined =
    selectedLead && customer && property && context?.derivedTravelZone && selectionComplete
      ? {
          customerId: customer.id,
          propertyId: property.id,
          leadId: selectedLead.id,
          services: draftServices,
          travelZoneCode: context.derivedTravelZone.code,
          discount:
            Number(discountPercent) > 0
              ? {
                  kind: 'percent',
                  value: discountPercent,
                  reason: 'Back-office operator entered discount with estimate calculation.',
                }
              : { kind: 'none' },
        }
      : undefined;
  const draftIntentFingerprint = draftIntent
    ? reserveLiveEstimateIdempotencyKey(undefined, draftIntent, () => 'fingerprint-only')
        .intentFingerprint
    : undefined;
  const receipt = confirmedLiveEstimateMatchesDraft({
    confirmedContextKey: confirmedEstimate?.contextRequestKey,
    confirmedIntentFingerprint: confirmedEstimate?.intentFingerprint,
    currentContextKey: contextRequestKey,
    currentIntentFingerprint: draftIntentFingerprint,
  })
    ? confirmedEstimate?.receipt
    : undefined;
  const canCalculate = Boolean(can('estimates.write') && state.online && draftIntent);
  const quoteMatchesReceipt = Boolean(receipt && state.live?.quote?.id === receipt.quoteId);
  const quoteStatus = quoteMatchesReceipt ? state.live?.quoteStatus : undefined;
  const hasEstimate = Boolean(receipt);

  const address = property?.serviceAddress;
  const formattedAddress = address
    ? [
        typeof address.line1 === 'string' ? address.line1 : '',
        typeof address.city === 'string' ? address.city : '',
        typeof address.region === 'string' ? address.region : '',
        typeof address.postalCode === 'string' ? address.postalCode : '',
      ]
        .filter(Boolean)
        .join(', ')
    : 'No property selected';

  const calculate = async () => {
    if (submissionInFlight.current || !draftIntent) {
      return;
    }
    const reservation = reserveLiveEstimateIdempotencyKey(
      estimateReservation.current,
      draftIntent,
      () => `estimate:${crypto.randomUUID()}`,
    );
    estimateReservation.current = reservation;
    submissionInFlight.current = true;
    setSubmitting(true);
    setOperationError(undefined);
    try {
      const nextReceipt = await actions.calculateLiveEstimate({
        ...draftIntent,
        idempotencyKey: reservation.idempotencyKey,
      });
      setConfirmedEstimate({
        contextRequestKey,
        intentFingerprint: reservation.intentFingerprint,
        receipt: nextReceipt,
      });
      estimateReservation.current = undefined;
    } catch (error) {
      setOperationError(
        error instanceof Error ? error.message : 'The live estimate was not calculated.',
      );
    } finally {
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <Link className="back-link" to="/pipeline">
        <ArrowLeft size={14} /> Back to pipeline
      </Link>
      <PageHeader
        eyebrow="Authenticated deterministic estimating"
        title={
          selectedLead
            ? `Build ${selectedLead.name}'s estimate`
            : 'Build from verified property evidence'
        }
        description="Quantities come from current human-verified measurements. The server derives travel, loads approved terms and the published price book, calculates with Decimal, and persists one atomic snapshot."
        actions={
          <>
            <Badge tone={context?.serviceTerms ? 'positive' : 'warning'} dot>
              {context?.serviceTerms
                ? `Terms ${context.serviceTerms.versionLabel} reviewed`
                : 'Terms gate checking'}
            </Badge>
            <Button variant="secondary" onClick={() => void actions.reloadLiveWorkspace()}>
              Refresh workspace
            </Button>
          </>
        }
      />

      {loading ? (
        <Card className="section-card">
          <div className="incident-empty">
            <Calculator size={24} />
            <div>
              <h2>Loading authoritative pricing context</h2>
              <p>
                Checking role, company status, evidence, catalog, price book, travel, and terms.
              </p>
            </div>
          </div>
        </Card>
      ) : contextError && !context ? (
        <Card className="projection-warning">
          <AlertTriangle size={18} />
          <div>
            <strong>Live estimating is blocked</strong>
            <p>{contextError}</p>
          </div>
        </Card>
      ) : (
        <div className="estimate-layout">
          <div className="dashboard-stack">
            <Card className="estimate-section">
              <div className="section-card__header">
                <div>
                  <h2>Customer & property</h2>
                  <p className="section-card__subtitle">
                    Selected lead {selectedLead?.id.slice(0, 8) ?? 'unavailable'} · exact
                    company-owned chain
                  </p>
                </div>
                <Badge tone="positive">Authenticated</Badge>
              </div>
              <div className="customer-summary-row">
                <div className="customer-summary-row__avatar">
                  {customer?.displayName
                    .split(/\s+/u)
                    .map((part) => part[0])
                    .slice(0, 2)
                    .join('') || '—'}
                </div>
                <div>
                  <strong>{customer?.displayName ?? 'Customer not available'}</strong>
                  <span>
                    {property?.name ?? 'Property'} · {formattedAddress}
                  </span>
                </div>
                <Link className="link-button" to="/customers">
                  Open records <ChevronRight size={12} />
                </Link>
              </div>
            </Card>

            <Card className="estimate-section">
              <div className="section-card__header">
                <div>
                  <h2>Human-verified quantities</h2>
                  <p className="section-card__subtitle">
                    Superseded measurements are excluded server-side
                  </p>
                </div>
                <Badge tone={measurements.length > 0 ? 'positive' : 'warning'}>
                  {measurements.length} current
                </Badge>
              </div>
              <div className="estimate-facts">
                {measurements.map((measurement) => (
                  <div key={measurement.id}>
                    <span>{measurement.label}</span>
                    <strong>
                      {measurement.value} {measurement.unit.replaceAll('_', ' ')}
                    </strong>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="estimate-section">
              <div className="section-card__header">
                <div>
                  <h2>Select services and exact evidence</h2>
                  <p className="section-card__subtitle">
                    Published book {context?.priceBook.versionLabel}; nothing is auto-added
                  </p>
                </div>
                <LockKeyhole size={18} color="#1f6d5e" />
              </div>
              <div className="dashboard-stack">
                {serviceRules.map((rule) => {
                  const selection = serviceSelections[rule.serviceCode] ?? {
                    enabled: false,
                    measurementId: '',
                    attributes: {},
                    addOns: {},
                  };
                  const measurementKind = measurementKindForUnit(rule.pricingUnit);
                  const eligibleMeasurements = measurements.filter(
                    (measurement) =>
                      measurement.kind === measurementKind &&
                      measurement.serviceCodes.includes(rule.serviceCode),
                  );
                  return (
                    <div className="service-line" key={rule.serviceCode}>
                      <div>
                        <label className="check-row" htmlFor={`service-${rule.serviceCode}`}>
                          <input
                            id={`service-${rule.serviceCode}`}
                            type="checkbox"
                            checked={selection.enabled}
                            disabled={!measurementKind || eligibleMeasurements.length === 0}
                            onChange={(event) =>
                              setServiceSelections((current) => ({
                                ...current,
                                [rule.serviceCode]: {
                                  ...selection,
                                  enabled: event.target.checked,
                                },
                              }))
                            }
                          />
                          <strong>{displayCode(rule.serviceCode)}</strong>
                        </label>
                        <span className="service-line__detail">
                          {eligibleMeasurements.length > 0
                            ? `${eligibleMeasurements.length} applicable measurement${eligibleMeasurements.length === 1 ? '' : 's'}`
                            : 'No service-tagged evidence; pricing is blocked'}
                        </span>
                      </div>
                      <Field
                        label="Verified measurement"
                        htmlFor={`measurement-${rule.serviceCode}`}
                      >
                        <select
                          id={`measurement-${rule.serviceCode}`}
                          value={selection.measurementId}
                          disabled={!selection.enabled}
                          onChange={(event) =>
                            setServiceSelections((current) => ({
                              ...current,
                              [rule.serviceCode]: {
                                ...selection,
                                measurementId: event.target.value,
                              },
                            }))
                          }
                        >
                          <option value="">Select labeled evidence…</option>
                          {eligibleMeasurements.map((measurement) => (
                            <option key={measurement.id} value={measurement.id}>
                              {measurement.label} · {measurement.value}{' '}
                              {measurement.unit.replaceAll('_', ' ')}
                            </option>
                          ))}
                        </select>
                      </Field>
                      {Object.entries(rule.allowedAttributeValues)
                        .filter(([attribute]) => attribute !== 'stories')
                        .map(([attribute, values]) => (
                          <Field
                            key={attribute}
                            label={displayCode(attribute)}
                            htmlFor={`${rule.serviceCode}-${attribute}`}
                          >
                            <select
                              id={`${rule.serviceCode}-${attribute}`}
                              value={selection.attributes[attribute] ?? ''}
                              disabled={!selection.enabled}
                              onChange={(event) =>
                                setServiceSelections((current) => ({
                                  ...current,
                                  [rule.serviceCode]: {
                                    ...selection,
                                    attributes: {
                                      ...selection.attributes,
                                      [attribute]: event.target.value,
                                    },
                                  },
                                }))
                              }
                            >
                              <option value="">Select…</option>
                              {values.map((value) => (
                                <option key={value} value={value}>
                                  {displayCode(value)}
                                </option>
                              ))}
                            </select>
                          </Field>
                        ))}
                      {rule.addOns.map((addOn) => {
                        const addOnSelection = selection.addOns[addOn.code] ?? {
                          enabled: false,
                          measurementId: '',
                        };
                        const addOnMeasurements = measurements.filter(
                          (measurement) =>
                            measurement.kind === measurementKindForUnit(addOn.unit) &&
                            measurement.addOnCodes.includes(addOn.code),
                        );
                        return (
                          <div key={addOn.code}>
                            <label className="check-row" htmlFor={`addon-${addOn.code}`}>
                              <input
                                id={`addon-${addOn.code}`}
                                type="checkbox"
                                checked={addOnSelection.enabled}
                                disabled={!selection.enabled || addOnMeasurements.length === 0}
                                onChange={(event) =>
                                  setServiceSelections((current) => ({
                                    ...current,
                                    [rule.serviceCode]: {
                                      ...selection,
                                      addOns: {
                                        ...selection.addOns,
                                        [addOn.code]: {
                                          ...addOnSelection,
                                          enabled: event.target.checked,
                                        },
                                      },
                                    },
                                  }))
                                }
                              />
                              <strong>Add {addOn.name}</strong>
                            </label>
                            {addOnSelection.enabled && (
                              <select
                                aria-label={`${addOn.name} verified measurement`}
                                value={addOnSelection.measurementId}
                                onChange={(event) =>
                                  setServiceSelections((current) => ({
                                    ...current,
                                    [rule.serviceCode]: {
                                      ...selection,
                                      addOns: {
                                        ...selection.addOns,
                                        [addOn.code]: {
                                          ...addOnSelection,
                                          measurementId: event.target.value,
                                        },
                                      },
                                    },
                                  }))
                                }
                              >
                                <option value="">Select add-on evidence…</option>
                                {addOnMeasurements.map((measurement) => (
                                  <option key={measurement.id} value={measurement.id}>
                                    {measurement.label} · {measurement.value}{' '}
                                    {measurement.unit.replaceAll('_', ' ')}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              <div className="form-grid form-grid--2">
                <Field
                  label="Discount percent"
                  htmlFor="live-discount"
                  hint="Above-book limits create an exact owner approval; they never auto-apply."
                >
                  <input
                    id="live-discount"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={discountPercent}
                    onChange={(event) => setDiscountPercent(event.target.value)}
                  />
                </Field>
                <Field
                  label="Travel zone"
                  htmlFor="live-travel"
                  hint="Derived from property postal evidence."
                >
                  <input
                    id="live-travel"
                    value={context?.derivedTravelZone?.code ?? 'Unresolved'}
                    readOnly
                  />
                </Field>
              </div>
            </Card>

            <Card className={context?.photoEvidence ? 'estimate-section' : 'projection-warning'}>
              {context?.photoEvidence ? <Camera size={18} /> : <AlertTriangle size={18} />}
              <div>
                <strong>
                  {context?.photoEvidence
                    ? `Scope photo disposition: ${context.photoEvidence.disposition.replaceAll('_', ' ')}`
                    : 'No current scope-photo analysis'}
                </strong>
                <p>
                  {context?.photoEvidence
                    ? `${Math.round(Number(context.photoEvidence.confidence) * 100)}% confidence; unknowns remain explicit.`
                    : 'Quantities remain human verified, but policy will route this estimate to owner approval for uncertain scope.'}
                </p>
              </div>
            </Card>

            {contextError && (
              <Card className="projection-warning">
                <AlertTriangle size={18} />
                <div>
                  <strong>Estimate not saved</strong>
                  <p>{contextError}</p>
                </div>
              </Card>
            )}
          </div>

          <Card className="price-summary">
            <div className="price-summary__header">
              <h2>{hasEstimate ? 'Latest server snapshot' : 'Ready to calculate'}</h2>
              <p>No client total is accepted by the server</p>
            </div>
            <div className="price-summary__body">
              {hasEstimate && (
                <>
                  <div className="price-total">
                    <div>
                      <span className="price-total__label">Customer total</span>
                      <p className="price-total__value">{formatMoney(receipt?.total ?? '0.00')}</p>
                    </div>
                    <Badge tone="neutral">Server calculated</Badge>
                  </div>
                  <div className="estimate-facts">
                    <div>
                      <span>Deposit</span>
                      <strong>{formatMoney(receipt?.depositRequired ?? '0.00')}</strong>
                    </div>
                    <div>
                      <span>Calculation</span>
                      <strong>{receipt?.calculationVersion ?? '—'}</strong>
                    </div>
                    <div>
                      <span>Snapshot</span>
                      <strong>{receipt?.authoritativeSnapshotHash.slice(0, 12) ?? '—'}…</strong>
                    </div>
                  </div>
                </>
              )}
              {receipt && (
                <div className="policy-check">
                  <div className="policy-check__row">
                    <CheckCircle2 size={14} />
                    {receipt.estimateNumber} · {receipt.estimateStatus.replaceAll('_', ' ')}
                  </div>
                  <p>
                    {receipt.quoteNumber} · deposit {formatMoney(receipt.depositRequired)}
                  </p>
                </div>
              )}
              <Button
                size="lg"
                className="full-width"
                disabled={!canCalculate || submitting}
                onClick={() => void calculate()}
                icon={<Calculator size={17} />}
              >
                {submitting ? 'Calculating on server…' : 'Calculate & create quote'}
              </Button>
              {quoteStatus === 'draft' ? (
                <Button
                  variant="secondary"
                  className="full-width"
                  disabled={!can('estimates.write')}
                  onClick={() => {
                    if (receipt) actions.sendQuote(receipt.quoteId);
                  }}
                  icon={<Send size={17} />}
                >
                  Send approved quote
                </Button>
              ) : (
                <div className="policy-check">
                  <div className="policy-check__row">
                    <ShieldCheck size={14} />
                    {quoteStatus
                      ? `Quote is ${quoteStatus.replaceAll('_', ' ')}`
                      : 'No sendable quote is present'}
                  </div>
                </div>
              )}
              <p className="formula-note">
                Price-book values, tax state, evidence versions, approved terms, and exact
                classifications are revalidated inside the atomic persistence transaction.
              </p>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
