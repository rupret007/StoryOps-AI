import {
  AlertTriangle,
  ArrowLeft,
  Calculator,
  CalendarCheck2,
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
import { ScopePhotoCapturePanel } from '@/components/ScopePhotoCapturePanel';
import { customerFacingQuoteStatus } from '@/utils/quoteStatus';
import type { RecurringDueWorkItem } from '@/core/recurring/dueWork';
import { deriveSandboxPricingPresentation } from '@/data/sandboxPricingPresentation';

const formatMoney = (amount: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount));

type LiveServiceSelection = {
  enabled: boolean;
  measurementId: string;
  attributes: Record<string, string>;
  addOns: Record<string, { enabled: boolean; measurementId: string }>;
};

export function resolveRecurringEstimateWorkItem(
  workItems: readonly RecurringDueWorkItem[] | undefined,
  requestedWorkItemId: string | null,
): RecurringDueWorkItem | undefined {
  if (!requestedWorkItemId) return undefined;
  return workItems?.find((item) => item.id === requestedWorkItemId);
}

export function resolveLiveEstimateIdentity(input: {
  requestedRecurringWorkItemId: string | null;
  recurringWorkItems: readonly RecurringDueWorkItem[] | undefined;
  requestedLeadId: string;
  leads: ReadonlyArray<{ id: string; customerId?: string; propertyId?: string }>;
}): {
  recurringWorkItem?: RecurringDueWorkItem;
  leadId?: string;
  customerId?: string;
  propertyId?: string;
} {
  const recurringWorkItem = resolveRecurringEstimateWorkItem(
    input.recurringWorkItems,
    input.requestedRecurringWorkItemId,
  );
  if (input.requestedRecurringWorkItemId) {
    return recurringWorkItem
      ? {
          recurringWorkItem,
          customerId: recurringWorkItem.customerId,
          propertyId: recurringWorkItem.propertyId,
        }
      : {};
  }
  const lead = input.leads.find((candidate) => candidate.id === input.requestedLeadId);
  return {
    leadId: lead?.id,
    customerId: lead?.customerId,
    propertyId: lead?.propertyId,
  };
}

const measurementKindForUnit = (unit: string) =>
  unit === 'flat'
    ? 'count'
    : unit === 'sq_ft'
      ? 'area_sq_ft'
      : unit === 'linear_ft'
        ? 'length_linear_ft'
        : unit === 'each'
          ? 'count'
          : unit === 'hour'
            ? 'duration_hours'
            : undefined;

const measurementMatchesRule = (
  measurementKind: string,
  pricingUnit: string,
  requiredMeasurementKinds: readonly string[],
) => {
  const unitKind = measurementKindForUnit(pricingUnit);
  return (
    unitKind !== undefined &&
    measurementKind === unitKind &&
    (requiredMeasurementKinds.length === 0 || requiredMeasurementKinds.includes(measurementKind))
  );
};

const supportingMeasurementsForRule = (
  measurements: LiveEstimateContext['measurements'],
  serviceCode: string,
  primaryMeasurementId: string,
  requiredMeasurementKinds: readonly string[],
) => {
  const primary = measurements.find((measurement) => measurement.id === primaryMeasurementId);
  return requiredMeasurementKinds.flatMap((requiredKind) => {
    if (primary?.kind === requiredKind && primary.serviceCodes.includes(serviceCode)) return [];
    const evidence = measurements.find(
      (measurement) =>
        measurement.kind === requiredKind && measurement.serviceCodes.includes(serviceCode),
    );
    return evidence ? [evidence] : [];
  });
};

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
  const pricing = deriveSandboxPricingPresentation(state.companyConfiguration?.published);
  const drivewayRule = pricing.serviceRules.find(
    (rule) => rule.serviceCode === 'pressure-wash-flatwork' && rule.enabled,
  );
  const gutterRule = pricing.serviceRules.find(
    (rule) => rule.serviceCode === 'gutter-cleaning' && rule.enabled,
  );
  const downspoutRule = gutterRule?.addOns.find((addOn) => addOn.code === 'DOWNSPOUT_FLUSH');
  const automaticDiscountLimit = Number(pricing.automaticDiscountLimit.replace('%', ''));
  const marginFloor = Number(pricing.marginFloor.replace('%', ''));
  const selectedZoneIsPublished = pricing.travelZones.some(
    (zone) => zone.code === estimate.travelZone,
  );

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
                  ? 'Published to portal'
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
                  The estimate uses the customer-confirmed {estimate.gutterLinearFt} linear feet,
                  not an AI-derived measurement. Technician must verify access at arrival.
                </p>
              </div>
            </div>
          </Card>

          <Card className="estimate-section">
            <div className="section-card__header">
              <div>
                <h2>Measurements & service rules</h2>
                <p className="section-card__subtitle">
                  {pricing.versionLabel} · {pricing.sourceLabel}
                </p>
              </div>
              <Badge tone={pricing.source === 'published_configuration' ? 'dark' : 'warning'}>
                <LockKeyhole size={11} />{' '}
                {pricing.source === 'published_configuration' ? 'Published' : 'Starter fixture'}
              </Badge>
            </div>
            <div className="service-line">
              <div>
                <strong className="service-line__title">Driveway pressure wash</strong>
                <span className="service-line__detail">
                  {drivewayRule?.summary ?? 'Not authorized by the published sandbox catalog.'}
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
                  {gutterRule
                    ? `${gutterRule.summary}${
                        downspoutRule
                          ? ` · ${downspoutRule.summary} per explicitly measured downspout`
                          : ' · DOWNSPOUT_FLUSH is not configured'
                      }`
                    : 'Not authorized by the published sandbox catalog.'}
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
              <Field label="Downspouts" htmlFor="downspout-count">
                <div className="unit-input">
                  <input
                    id="downspout-count"
                    className="input"
                    inputMode="numeric"
                    value={estimate.downspoutCount}
                    onChange={(event) =>
                      actions.updateEstimate('downspoutCount', event.target.value)
                    }
                    disabled={!can('estimates.write')}
                  />
                  <span>each</span>
                </div>
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
                  {!selectedZoneIsPublished && (
                    <option value={estimate.travelZone} disabled>
                      {estimate.travelZone} · unavailable in current pricing source
                    </option>
                  )}
                  {pricing.travelZones.map((zone) => (
                    <option value={zone.code} key={zone.code}>
                      {zone.code} · {zone.fee} · {zone.boundary}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="discount-row">
              <Field
                label="Discount"
                htmlFor="discount"
                hint={`Above ${pricing.automaticDiscountLimit} creates an exact-payload owner approval.`}
              >
                <div className="unit-input unit-input--small">
                  <input
                    id="discount"
                    className="input"
                    inputMode="decimal"
                    aria-describedby="discount-hint"
                    value={estimate.discountPercent}
                    onChange={(event) =>
                      actions.updateEstimate('discountPercent', event.target.value)
                    }
                    disabled={!can('estimates.write')}
                  />
                  <span>%</span>
                </div>
              </Field>
              {Number(estimate.discountPercent) > automaticDiscountLimit && (
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
                <span>Sales tax · {pricing.taxRule}</span>
                <strong>{formatMoney(estimate.tax)}</strong>
              </div>
            </div>
            <div className="estimate-facts">
              <div>
                <span>Deposit · {pricing.deposit} rule</span>
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
                {Number(estimate.discountPercent) <= automaticDiscountLimit ? (
                  <CheckCircle2 size={14} />
                ) : (
                  <AlertTriangle size={14} />
                )}
                Discount{' '}
                {Number(estimate.discountPercent) <= automaticDiscountLimit ? 'within' : 'above'}{' '}
                {pricing.automaticDiscountLimit} auto limit
              </div>
              <div className="policy-check__row">
                <CheckCircle2 size={14} />
                Margin {estimate.marginPercent}%{' '}
                {Number(estimate.marginPercent) >= marginFloor ? 'above' : 'below'}{' '}
                {pricing.marginFloor} floor
              </div>
              <div className="policy-check__row">
                {pricing.source === 'published_configuration' ? (
                  <CheckCircle2 size={14} />
                ) : (
                  <AlertTriangle size={14} />
                )}
                {pricing.source === 'published_configuration'
                  ? 'Published company configuration and human-verified scope'
                  : 'Starter fixture only; publish the company configuration before rehearsal'}
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
                Publish quote to portal
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
                change. Deposit due at acceptance: {formatMoney(estimate.deposit)} (
                {pricing.deposit} configured rule).
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
  const requestedRecurringWorkItemId = searchParams.get('recurringWorkItem');
  const requestedLeadId = requestedRecurringWorkItemId
    ? ''
    : (searchParams.get('lead') ?? state.selectedLeadId);
  const identity = resolveLiveEstimateIdentity({
    requestedRecurringWorkItemId,
    recurringWorkItems: state.recurringDueWork?.workItems,
    requestedLeadId,
    leads: state.leads,
  });
  const recurringWorkItem = identity.recurringWorkItem;
  const selectedLead = state.leads.find((lead) => lead.id === identity.leadId);
  const requestedCustomerId = identity.customerId;
  const requestedPropertyId = identity.propertyId;
  const scopeMissing =
    (!selectedLead && !recurringWorkItem) || !requestedCustomerId || !requestedPropertyId;
  const contextRequestKey = `${requestedLeadId}:${recurringWorkItem?.id ?? ''}:${requestedCustomerId ?? ''}:${requestedPropertyId ?? ''}`;
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
  const [selectedPackageCode, setSelectedPackageCode] = useState<string>();
  const [discountPercent, setDiscountPercent] = useState('0');
  const [contextRefreshRevision, setContextRefreshRevision] = useState(0);
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({});
  const [deliveryChannel, setDeliveryChannel] = useState<'sms' | 'email'>('email');

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
  }, [actions, contextRefreshRevision, contextRequestKey, requestedPropertyId, scopeMissing]);

  const activeContextLoad = contextLoad.requestKey === contextRequestKey ? contextLoad : undefined;
  const context = activeContextLoad?.context;
  const loading = !scopeMissing && (!activeContextLoad || activeContextLoad.status === 'loading');
  const contextError = scopeMissing
    ? requestedRecurringWorkItemId
      ? 'The requested recurring work item is not present in this current role-scoped workspace.'
      : 'Select a qualified lead with an exact server-linked customer and property before estimating.'
    : (activeContextLoad?.error ?? operationError);
  const property = context?.properties.find((item) => item.id === requestedPropertyId);
  const customer = context?.customers.find(
    (item) => item.id === requestedCustomerId && item.id === property?.customerId,
  );
  const measurements =
    context?.measurements.filter((item) => item.propertyId === property?.id) ?? [];
  const serviceRules = context?.priceBook.serviceRules ?? [];
  const packages = context?.priceBook.packages ?? [];
  const selectedPackage = packages.find(
    (servicePackage) => servicePackage.code === selectedPackageCode,
  );
  const selectedPackageComponents = new Map(
    selectedPackage?.components.map((component) => [component.serviceCode, component]) ?? [],
  );
  const enabledRules = serviceRules.filter((rule) => serviceSelections[rule.serviceCode]?.enabled);
  const enabledScopePolicies = enabledRules.map(
    (rule) =>
      context?.scopeEvidencePolicies.find((item) => item.serviceCode === rule.serviceCode)
        ?.policy ?? 'photo_required',
  );
  const selectedPhotoRequired = enabledScopePolicies.includes('photo_required');
  const selectedPhotoOptional =
    !selectedPhotoRequired && enabledScopePolicies.includes('photo_optional');
  const selectedPhotoNotApplicable =
    enabledScopePolicies.length > 0 &&
    enabledScopePolicies.every((policy) => policy === 'not_applicable');
  const packageSelectionComplete =
    !selectedPackage ||
    selectedPackage.components.every((component) => {
      const selection = serviceSelections[component.serviceCode];
      return (
        (!component.required || selection?.enabled === true) &&
        component.requiredAddOnCodes.every(
          (addOnCode) => selection?.addOns[addOnCode]?.enabled === true,
        )
      );
    });
  const selectionComplete =
    packageSelectionComplete &&
    enabledRules.length > 0 &&
    enabledRules.every((rule) => {
      const selection = serviceSelections[rule.serviceCode];
      if (!selection?.measurementId) return false;
      const selectedMeasurement = measurements.find(
        (measurement) => measurement.id === selection.measurementId,
      );
      if (
        !selectedMeasurement ||
        !measurementMatchesRule(
          selectedMeasurement.kind,
          rule.pricingUnit,
          rule.requiredMeasurementKinds,
        ) ||
        !selectedMeasurement.serviceCodes.includes(rule.serviceCode)
      ) {
        return false;
      }
      const supportingMeasurements = supportingMeasurementsForRule(
        measurements,
        rule.serviceCode,
        selection.measurementId,
        rule.requiredMeasurementKinds,
      );
      if (
        rule.requiredMeasurementKinds.some(
          (kind) =>
            selectedMeasurement.kind !== kind &&
            !supportingMeasurements.some((measurement) => measurement.kind === kind),
        )
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
          supportingMeasurementIds: supportingMeasurementsForRule(
            measurements,
            rule.serviceCode,
            selection.measurementId,
            rule.requiredMeasurementKinds,
          ).map((measurement) => measurement.id),
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
    (selectedLead || recurringWorkItem) &&
    customer &&
    property &&
    context?.derivedTravelZone &&
    selectionComplete
      ? {
          customerId: customer.id,
          propertyId: property.id,
          ...(selectedLead ? { leadId: selectedLead.id } : {}),
          ...(selectedPackage ? { packageCode: selectedPackage.code } : {}),
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
  const canCalculate = Boolean(
    can('estimates.write') && state.online && state.serverVerifiedAt && draftIntent,
  );
  const quoteMatchesReceipt = Boolean(receipt && state.live?.quote?.id === receipt.quoteId);
  const quoteStatus = quoteMatchesReceipt ? state.live?.quoteStatus : undefined;
  const hasEstimate = Boolean(receipt);
  const openQuoteChangeRequests =
    state.live?.customerQuoteChangeRequests?.filter(
      (request) =>
        (!requestedCustomerId || request.customerId === requestedCustomerId) &&
        (!requestedPropertyId || request.propertyId === requestedPropertyId),
    ) ?? [];

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
      if (
        recurringWorkItem &&
        recurringWorkItem.status === 'fresh_estimate_required' &&
        !recurringWorkItem.estimateCreated
      ) {
        const association = await actions.attachRecurringDueEstimate({
          workItemId: recurringWorkItem.id,
          workItemVersion: recurringWorkItem.version,
          estimateId: nextReceipt.estimateId,
        });
        if (!association) {
          setOperationError(
            'The estimate was persisted, but the recurring work-item association still needs retry and server reconciliation.',
          );
        }
      }
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
      <Link className="back-link" to={recurringWorkItem ? '/operations' : '/pipeline'}>
        <ArrowLeft size={14} /> {recurringWorkItem ? 'Back to recurring work' : 'Back to pipeline'}
      </Link>
      <PageHeader
        eyebrow="Authenticated deterministic estimating"
        title={
          recurringWorkItem
            ? `Fresh estimate for ${recurringWorkItem.customerName}`
            : selectedLead
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
            <Button
              variant="secondary"
              onClick={() => {
                void actions.reloadLiveWorkspace();
                setContextRefreshRevision((current) => current + 1);
              }}
            >
              Refresh workspace
            </Button>
          </>
        }
      />

      {recurringWorkItem && (
        <Card className="projection-warning">
          <CalendarCheck2 size={18} />
          <div>
            <strong>
              Recurring due work · {recurringWorkItem.propertyName} · due{' '}
              {recurringWorkItem.planDueDate}
            </strong>
            <p>
              Suggested services: {recurringWorkItem.serviceCodes.join(', ')}. No service is
              auto-selected and no historical price is copied. Use only current verified
              measurements and the published price book.
            </p>
          </div>
        </Card>
      )}

      {openQuoteChangeRequests.map((request) => {
        const replacement =
          state.live?.quote &&
          state.live.quote.id !== request.quoteId &&
          ['sent', 'viewed', 'accepted'].includes(state.live.quoteStatus ?? '')
            ? state.live.quote
            : undefined;
        const resolutionNote = resolutionNotes[request.id] ?? '';
        return (
          <Card className="projection-warning" key={request.id}>
            <AlertTriangle size={18} />
            <div>
              <strong>
                Customer requested changes to {request.quoteNumber} v{request.quoteVersion}
              </strong>
              <p>
                Services: {request.requestedServiceCodes.join(', ') || 'none'} · add-ons:{' '}
                {request.requestedAddOnCodes.join(', ') || 'none'}
              </p>
              {request.requestNotes && <p>Customer note: {request.requestNotes}</p>}
              <p>{request.nextAction}</p>
              <Field label="Resolution note" htmlFor={`quote-change-resolution-${request.id}`}>
                <textarea
                  className="input"
                  id={`quote-change-resolution-${request.id}`}
                  value={resolutionNote}
                  maxLength={2000}
                  onChange={(event) =>
                    setResolutionNotes((current) => ({
                      ...current,
                      [request.id]: event.target.value,
                    }))
                  }
                  placeholder="Record the replacement context or cancellation reason."
                />
              </Field>
              <div className="record-dialog__actions">
                <Button
                  disabled={!replacement}
                  onClick={() => {
                    if (!replacement) return;
                    void actions.resolveQuoteChangeRequest({
                      requestId: request.id,
                      requestVersion: request.version,
                      disposition: 'replacement_published',
                      replacementQuoteId: replacement.id,
                      replacementQuoteVersion: replacement.version,
                      resolutionNote,
                    });
                  }}
                >
                  Link current published replacement
                </Button>
                <Button
                  variant="secondary"
                  disabled={!resolutionNote.trim()}
                  onClick={() =>
                    void actions.resolveQuoteChangeRequest({
                      requestId: request.id,
                      requestVersion: request.version,
                      disposition: 'cancelled',
                      resolutionNote,
                    })
                  }
                >
                  Close with reason
                </Button>
              </div>
            </div>
          </Card>
        );
      })}

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
                  <h2>Good / better / best comparison</h2>
                  <p className="section-card__subtitle">
                    Packages select published scope rules only; every quantity and add-on still
                    needs explicit evidence.
                  </p>
                </div>
                <Badge tone={selectedPackage ? 'accent' : 'neutral'}>
                  {selectedPackage ? selectedPackage.name : 'Custom scope'}
                </Badge>
              </div>
              <div className="package-comparison" aria-label="Published service packages">
                {packages.map((servicePackage) => (
                  <button
                    className={`package-option${
                      selectedPackageCode === servicePackage.code ? ' package-option--selected' : ''
                    }`}
                    key={servicePackage.code}
                    type="button"
                    aria-pressed={selectedPackageCode === servicePackage.code}
                    onClick={() => {
                      setSelectedPackageCode(servicePackage.code);
                      setServiceSelections(
                        Object.fromEntries(
                          servicePackage.components.map((component) => [
                            component.serviceCode,
                            {
                              enabled: component.required,
                              measurementId: '',
                              attributes: {},
                              addOns: Object.fromEntries(
                                component.requiredAddOnCodes.map((addOnCode) => [
                                  addOnCode,
                                  { enabled: true, measurementId: '' },
                                ]),
                              ),
                            },
                          ]),
                        ),
                      );
                    }}
                  >
                    <Badge tone={servicePackage.tier === 'best' ? 'accent' : 'neutral'}>
                      {servicePackage.tier}
                    </Badge>
                    <strong>{servicePackage.name}</strong>
                    <span>{servicePackage.description}</span>
                    <small>
                      {servicePackage.components.filter((component) => component.required).length}{' '}
                      required service
                      {servicePackage.components.filter((component) => component.required)
                        .length === 1
                        ? ''
                        : 's'}
                    </small>
                  </button>
                ))}
              </div>
              <Button variant="secondary" onClick={() => setSelectedPackageCode(undefined)}>
                Use current selections as a custom quote
              </Button>
            </Card>

            <Card className="estimate-section">
              <div className="section-card__header">
                <div>
                  <h2>Customer & property</h2>
                  <p className="section-card__subtitle">
                    {recurringWorkItem
                      ? `Recurring work ${recurringWorkItem.id.slice(0, 8)}`
                      : `Selected lead ${selectedLead?.id.slice(0, 8) ?? 'unavailable'}`}{' '}
                    · exact company-owned chain
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

            {customer && property && (
              <ScopePhotoCapturePanel
                key={property.id}
                propertyId={property.id}
                customerId={customer.id}
                role={state.role}
                serviceCodes={serviceRules.map((rule) => rule.serviceCode)}
                onEvidenceChanged={() => setContextRefreshRevision((current) => current + 1)}
              />
            )}

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
                      measurementMatchesRule(
                        measurement.kind,
                        rule.pricingUnit,
                        rule.requiredMeasurementKinds,
                      ) && measurement.serviceCodes.includes(rule.serviceCode),
                  );
                  const selectedSupportingMeasurements = supportingMeasurementsForRule(
                    measurements,
                    rule.serviceCode,
                    selection.measurementId,
                    rule.requiredMeasurementKinds,
                  );
                  const missingRequiredMeasurementKinds = rule.requiredMeasurementKinds.filter(
                    (kind) =>
                      !measurements.some(
                        (measurement) =>
                          measurement.kind === kind &&
                          measurement.serviceCodes.includes(rule.serviceCode),
                      ),
                  );
                  const packageComponent = selectedPackageComponents.get(rule.serviceCode);
                  const serviceOutsidePackage = Boolean(selectedPackage && !packageComponent);
                  return (
                    <div className="service-line" key={rule.serviceCode}>
                      <div>
                        <label className="check-row" htmlFor={`service-${rule.serviceCode}`}>
                          <input
                            id={`service-${rule.serviceCode}`}
                            type="checkbox"
                            checked={selection.enabled}
                            disabled={
                              !measurementKind ||
                              eligibleMeasurements.length === 0 ||
                              serviceOutsidePackage ||
                              packageComponent?.required === true
                            }
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
                            ? serviceOutsidePackage
                              ? 'Not included in the selected published package'
                              : `${eligibleMeasurements.length} applicable measurement${eligibleMeasurements.length === 1 ? '' : 's'}`
                            : 'No service-tagged evidence; pricing is blocked'}
                        </span>
                      </div>
                      {selection.enabled && rule.requiredMeasurementKinds.length > 1 ? (
                        <p className="section-card__subtitle" role="status">
                          Supporting evidence:{' '}
                          {missingRequiredMeasurementKinds.length > 0
                            ? `missing ${missingRequiredMeasurementKinds.join(', ')}`
                            : selectedSupportingMeasurements.length > 0
                              ? selectedSupportingMeasurements
                                  .map(
                                    (measurement) =>
                                      `${measurement.label} (${measurement.value} ${measurement.unit})`,
                                  )
                                  .join(', ')
                              : 'covered by the priced measurement'}
                        </p>
                      ) : null}
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
                        const requiredByPackage =
                          packageComponent?.requiredAddOnCodes.includes(addOn.code) === true;
                        const allowedByPackage =
                          !selectedPackage ||
                          requiredByPackage ||
                          packageComponent?.optionalAddOnCodes.includes(addOn.code) === true;
                        return (
                          <div key={addOn.code}>
                            <label className="check-row" htmlFor={`addon-${addOn.code}`}>
                              <input
                                id={`addon-${addOn.code}`}
                                type="checkbox"
                                checked={addOnSelection.enabled}
                                disabled={
                                  !selection.enabled ||
                                  addOnMeasurements.length === 0 ||
                                  !allowedByPackage ||
                                  requiredByPackage
                                }
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
                              <strong>
                                {requiredByPackage ? 'Required' : 'Add'} {addOn.name}
                              </strong>
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

            <Card
              className={
                context?.photoEvidence || selectedPhotoNotApplicable || selectedPhotoOptional
                  ? 'estimate-section'
                  : 'projection-warning'
              }
            >
              {context?.photoEvidence ? (
                <Camera size={18} />
              ) : selectedPhotoNotApplicable || selectedPhotoOptional ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
              <div>
                <strong>
                  {context?.photoEvidence
                    ? `Scope photo disposition: ${context.photoEvidence.disposition.replaceAll('_', ' ')}`
                    : selectedPhotoNotApplicable
                      ? 'Photo scope evidence is not required'
                      : selectedPhotoOptional
                        ? 'Optional photo scope evidence was not supplied'
                        : selectedPhotoRequired
                          ? 'Required scope-photo analysis is missing'
                          : 'Select a service to evaluate its scope-evidence policy'}
                </strong>
                <p>
                  {context?.photoEvidence
                    ? `${Math.round(Number(context.photoEvidence.confidence) * 100)}% confidence; unknowns remain explicit.`
                    : selectedPhotoNotApplicable
                      ? 'This industry-pack service uses current human-verified measurements and its own review triggers.'
                      : selectedPhotoOptional
                        ? 'Current human-verified measurements remain eligible; supplied concerning evidence would still require review.'
                        : selectedPhotoRequired
                          ? 'Policy will keep the quote pending until usable photo evidence is reviewed.'
                          : 'The selected service controls whether photo evidence is required, optional, or not applicable.'}
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
                  Publish approved quote to portal
                </Button>
              ) : (
                <div className="policy-check">
                  <div className="policy-check__row">
                    <ShieldCheck size={14} />
                    {quoteStatus
                      ? `Quote is ${customerFacingQuoteStatus(quoteStatus)}`
                      : 'No publishable quote is present'}
                  </div>
                </div>
              )}
              {state.live?.quote && ['sent', 'viewed'].includes(state.live.quoteStatus ?? '') && (
                <div className="policy-check">
                  <div className="policy-check__row">
                    <Send size={14} />
                    Transactional quote delivery
                  </div>
                  <p>
                    {state.live.quoteDelivery
                      ? `${state.live.quoteDelivery.channel.toUpperCase()} · ${state.live.quoteDelivery.status.replaceAll('_', ' ')}${state.live.quoteDelivery.externalDeliveryClaimed ? ' · verified delivered' : ' · delivery not asserted'}`
                      : 'Portal publication is confirmed. No provider delivery attempt has been queued.'}
                  </p>
                  {state.live.quoteDelivery?.manualReconciliationRequired && (
                    <p role="alert">
                      Provider submission is ambiguous. Reconcile the exact provider message before
                      retrying.
                    </p>
                  )}
                  {state.live.quoteDelivery?.lastErrorCode && (
                    <p>Last result: {state.live.quoteDelivery.lastErrorCode}</p>
                  )}
                  <label className="input-group" htmlFor="quote-delivery-channel">
                    <span>Delivery channel</span>
                    <select
                      id="quote-delivery-channel"
                      className="select"
                      value={deliveryChannel}
                      onChange={(event) =>
                        setDeliveryChannel(event.target.value as 'sms' | 'email')
                      }
                    >
                      <option value="email">Email</option>
                      <option value="sms">SMS</option>
                    </select>
                  </label>
                  <Button
                    variant="secondary"
                    className="full-width"
                    disabled={
                      !can('communications.send') ||
                      (state.live.quoteDelivery !== undefined &&
                        !['failed', 'cancelled'].includes(state.live.quoteDelivery.status))
                    }
                    onClick={() =>
                      void actions.queueTransactionalDelivery({
                        action: 'quote.delivery',
                        channel: deliveryChannel,
                      })
                    }
                  >
                    {state.live.quoteDelivery
                      ? 'Quote delivery already recorded'
                      : 'Queue quote delivery'}
                  </Button>
                  <p className="formula-note">
                    Queueing is not sending. Sent and delivered appear only from provider evidence;
                    sandbox remains explicitly sandboxed.
                  </p>
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
