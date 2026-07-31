import {
  AlertTriangle,
  ArrowLeft,
  CalendarCheck2,
  Camera,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Download,
  FileCheck2,
  Home,
  LogOut,
  MapPin,
  MessageCircle,
  ShieldCheck,
  Sparkles,
  Star,
  UserRoundPlus,
  WalletCards,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from 'react';
import { Decimal } from 'decimal.js';
import { useNavigate } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Button, Card, Field } from '@/components/ui/Primitives';
import { downloadText, escapeIcsText, safeDownloadFilename } from '@/utils/download';
import { calculateDemoPrice, summarizeDemoServiceTotals } from '@/data/priceBook';
import {
  hasPostServiceReconciliationRequired,
  postServiceFollowupLabel,
} from '@/utils/postServiceStatus';
import { customerFacingQuoteStatus } from '@/utils/quoteStatus';
import { ScopePhotoCapturePanel } from '@/components/ScopePhotoCapturePanel';

const formatMoney = (amount: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount));

function usePortalDialog(open: boolean, setOpen: Dispatch<SetStateAction<boolean>>) {
  const dialogRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute('hidden'));
    window.requestAnimationFrame(() => focusable()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const candidates = focusable();
      if (candidates.length === 0) {
        event.preventDefault();
        return;
      }
      const first = candidates[0];
      const last = candidates.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = priorOverflow;
      openerRef.current?.focus();
    };
  }, [open, setOpen]);

  return dialogRef;
}

export function PortalPage() {
  const { state, actions } = useStoryOps();
  const navigate = useNavigate();
  const [termsOpen, setTermsOpen] = useState(false);
  const termsDialogRef = usePortalDialog(termsOpen, setTermsOpen);
  const [acceptanceSigner, setAcceptanceSigner] = useState('');
  const [acceptanceAcknowledged, setAcceptanceAcknowledged] = useState(false);
  const [acceptancePending, setAcceptancePending] = useState(false);
  const estimate = state.estimate;
  const invoice = state.invoices.find((item) => item.id === 'invoice-morgan');
  const accepted = state.customerQuoteAccepted;
  const companyName = state.setupProfile?.businessName ?? 'StoryOps';
  const quoteReady = estimate.status === 'quoted';
  const sandboxVisitBooked =
    state.leads.find((lead) => lead.id === estimate.leadId)?.stage === 'booked';
  const serviceTotals = useMemo(
    () =>
      summarizeDemoServiceTotals(
        calculateDemoPrice(estimate, state.companyConfiguration?.published),
      ),
    [estimate, state.companyConfiguration?.published],
  );
  const submitAcceptance = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAcceptancePending(true);
    await actions.acceptQuote({
      signerName: acceptanceSigner,
      acknowledged: acceptanceAcknowledged,
    });
    setAcceptancePending(false);
  };

  if (state.dataMode === 'supabase') {
    return (
      <LivePortalPage
        key={state.live?.selectedPortalCustomerId ?? 'no-selected-customer-account'}
      />
    );
  }

  const backToWorkspace = () => {
    if (state.role === 'customer') actions.setRole('owner');
    navigate('/');
  };

  return (
    <div className="portal-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header
        className="portal-header"
        aria-hidden={termsOpen ? true : undefined}
        inert={termsOpen ? true : undefined}
      >
        <div className="portal-brand">
          <span className="brand__mark">
            <Sparkles size={17} />
          </span>
          {companyName}
        </div>
        <div className="portal-header__actions">
          <button type="button" onClick={backToWorkspace}>
            <ArrowLeft size={13} /> Staff workspace
          </button>
          <Badge tone="neutral">Sandbox portal preview</Badge>
        </div>
      </header>

      <main
        className="portal-content"
        id="main-content"
        aria-hidden={termsOpen ? true : undefined}
        inert={termsOpen ? true : undefined}
      >
        <div className="portal-welcome">
          <div>
            <p className="eyebrow">Customer portal</p>
            <h1>Hi, Morgan.</h1>
            <p className="page-header__description">
              Review your quote, appointment, photos, invoices, and maintenance plan in one place.
            </p>
          </div>
          <a
            className="button button--secondary button--md"
            href="mailto:hello@storyexteriorcare.example?subject=Question%20about%20my%20service"
          >
            <MessageCircle size={15} />
            Message us
          </a>
        </div>

        {!accepted && !quoteReady && (
          <Card className="portal-quote-unavailable">
            <Badge tone="neutral">Not ready</Badge>
            <h2>No approved quote is available</h2>
            <p>
              Drafts and price exceptions remain private until policy checks, required owner
              approvals, and portal publication are complete.
            </p>
          </Card>
        )}

        {!accepted && quoteReady && (
          <Card className="portal-quote">
            <div className="portal-quote__header">
              <div>
                <Badge tone="accent">Ready for you</Badge>
                <h2>Driveway + gutter cleaning</h2>
                <p>Quote {estimate.estimateNumber} · valid through August 11, 2026</p>
              </div>
              <div className="portal-quote__total">
                <span>Total</span>
                <strong>{formatMoney(estimate.total)}</strong>
                <small>{formatMoney(estimate.deposit)} deposit</small>
              </div>
            </div>
            <div className="portal-quote__scope">
              <div>
                <span className="portal-scope-icon">
                  <Home size={17} />
                </span>
                <span>
                  <strong>Driveway pressure wash</strong>
                  <small>{estimate.drivewaySqFt} sq ft · concrete · moderate soil</small>
                </span>
                <strong>{formatMoney(serviceTotals.driveway)}</strong>
              </div>
              <div>
                <span className="portal-scope-icon">
                  <FileCheck2 size={17} />
                </span>
                <span>
                  <strong>Gutter and downspout cleaning</strong>
                  <small>
                    {estimate.gutterLinearFt} linear ft · two story · {estimate.downspoutCount}{' '}
                    downspouts
                  </small>
                </span>
                <strong>{formatMoney(serviceTotals.gutters)}</strong>
              </div>
            </div>
            <div className="portal-quote__breakdown" aria-label="Quote price breakdown">
              <span>Services</span>
              <strong>{formatMoney(estimate.serviceSubtotal)}</strong>
              {estimate.travelFee !== '0.00' && (
                <>
                  <span>Travel</span>
                  <strong>{formatMoney(estimate.travelFee)}</strong>
                </>
              )}
              {estimate.discount !== '0.00' && (
                <>
                  <span>Discount</span>
                  <strong>−{formatMoney(estimate.discount)}</strong>
                </>
              )}
              <span>Tax</span>
              <strong>{formatMoney(estimate.tax)}</strong>
              <span>Total</span>
              <strong>{formatMoney(estimate.total)}</strong>
            </div>
            <div className="portal-terms">
              <ShieldCheck size={17} />
              <p>
                Sandbox preview only: accepting records synthetic terms and deposit fixtures
                locally. No provider is contacted and no funds move.
              </p>
            </div>
            <form
              className="portal-quote-acceptance"
              onSubmit={(event) => void submitAcceptance(event)}
            >
              <Field
                label="Type the signer’s full name"
                htmlFor="sandbox-quote-signer"
                hint="This cannot be inferred from the customer profile."
              >
                <input
                  className="input"
                  id="sandbox-quote-signer"
                  autoComplete="name"
                  maxLength={120}
                  value={acceptanceSigner}
                  onChange={(event) => setAcceptanceSigner(event.target.value)}
                />
              </Field>
              <label className="portal-acceptance-check">
                <input
                  type="checkbox"
                  checked={acceptanceAcknowledged}
                  onChange={(event) => setAcceptanceAcknowledged(event.target.checked)}
                />
                <span>
                  I reviewed quote {estimate.estimateNumber}, Service Terms v2026.07, and the exact{' '}
                  {formatMoney(estimate.total)} total, and I agree to this sandbox acceptance
                  fixture.
                </span>
              </label>
              <div className="portal-quote__actions">
                <Button
                  type="button"
                  variant="secondary"
                  icon={<Download size={15} />}
                  onClick={() => window.print()}
                >
                  Print / save PDF
                </Button>
                <Button
                  type="submit"
                  size="lg"
                  loading={acceptancePending}
                  disabled={acceptanceSigner.trim().length < 2 || !acceptanceAcknowledged}
                  icon={<CheckCircle2 size={17} />}
                >
                  Accept & record {formatMoney(estimate.deposit)} fixture
                </Button>
              </div>
            </form>
          </Card>
        )}

        {accepted && (
          <div className="portal-grid">
            {sandboxVisitBooked ? (
              <Card className="portal-appointment">
                <div className="portal-appointment__top">
                  <Badge tone="neutral">Sandbox appointment</Badge>
                  <h2>Friday, July 31 · 9:00 AM</h2>
                  <p>Driveway + gutter cleaning · estimated 3 hr 35 min</p>
                </div>
                <div className="portal-appointment__body">
                  <div className="portal-detail-row">
                    <MapPin size={17} />
                    <div>
                      <strong>1842 Cedar Ridge Lane</strong>
                      <small>Flower Mound, TX 75028</small>
                    </div>
                  </div>
                  <div className="portal-detail-row">
                    <Clock3 size={17} />
                    <div>
                      <strong>Arrival window: 9:00–9:30 AM</strong>
                      <small>Sandbox notification fixture only; no customer was contacted.</small>
                    </div>
                  </div>
                  <div className="portal-detail-row">
                    <CalendarCheck2 size={17} />
                    <div>
                      <strong>Synthetic deposit fixture</strong>
                      <small>{formatMoney(estimate.deposit)} · no funds moved</small>
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    className="full-width"
                    onClick={() =>
                      downloadText(
                        'story-exterior-care-job-1048.ics',
                        [
                          'BEGIN:VCALENDAR',
                          'VERSION:2.0',
                          `PRODID:-//${escapeIcsText(companyName)}//StoryOps AI//EN`,
                          'BEGIN:VEVENT',
                          'UID:job-1048@storyops.local',
                          'DTSTAMP:20260728T170000Z',
                          'DTSTART:20260731T140000Z',
                          'DTEND:20260731T173500Z',
                          `SUMMARY:${escapeIcsText(companyName)} — driveway and gutter cleaning`,
                          'LOCATION:1842 Cedar Ridge Lane\\, Flower Mound\\, TX 75028',
                          `DESCRIPTION:${escapeIcsText(`Confirmed appointment. Quote ${estimate.estimateNumber}.`)}`,
                          'END:VEVENT',
                          'END:VCALENDAR',
                          '',
                        ].join('\r\n'),
                        'text/calendar;charset=utf-8',
                      )
                    }
                  >
                    Add to calendar
                  </Button>
                </div>
              </Card>
            ) : (
              <Card className="projection-warning">
                <CalendarCheck2 size={18} />
                <div>
                  <strong>Sandbox booking fixture pending</strong>
                  <p>
                    Acceptance recorded local terms and deposit fixtures only. A dispatcher must
                    record the sandbox visit before an appointment window is shown.
                  </p>
                </div>
              </Card>
            )}

            <div className="dashboard-stack">
              <Card className="section-card">
                <h2>Before we arrive</h2>
                <ul className="portal-checklist">
                  <li>
                    <CheckCircle2 size={14} /> Water access is available
                  </li>
                  <li>
                    <CheckCircle2 size={14} /> Vehicles moved from driveway
                  </li>
                  <li>
                    <CheckCircle2 size={14} /> Gate instructions received
                  </li>
                </ul>
              </Card>
              <Card className="section-card">
                <h2>Quote & terms</h2>
                <button
                  className="portal-link-row"
                  type="button"
                  onClick={() => setTermsOpen(true)}
                >
                  <FileCheck2 size={16} />
                  <span>
                    <strong>{estimate.estimateNumber}</strong>
                    <small>Accepted · terms v2026.07</small>
                  </span>
                  <ChevronRight size={15} />
                </button>
              </Card>
            </div>
          </div>
        )}

        <CustomerPortalControls key={state.customerCommunicationPreferences.version} />

        {invoice && (
          <Card className="portal-invoice-card">
            <div>
              <span className="portal-invoice-card__icon">
                <CircleDollarSign size={20} />
              </span>
              <div>
                <Badge tone={invoice.status === 'paid' ? 'positive' : 'info'} dot>
                  {invoice.status === 'paid' ? 'sandbox paid fixture' : invoice.status}
                </Badge>
                <h2>
                  {invoice.number} · {invoice.jobNumber}
                </h2>
                <p>
                  {invoice.status === 'paid'
                    ? `Scenario paid state · ${formatMoney(invoice.total)} · no funds moved`
                    : `${formatMoney(invoice.balance)} remaining after deposit`}
                </p>
              </div>
            </div>
            {invoice.status !== 'paid' ? (
              <Button onClick={actions.recordSandboxPayment}>
                Record {formatMoney(invoice.balance)} sandbox fixture
              </Button>
            ) : (
              <Button
                variant="secondary"
                icon={<Download size={14} />}
                onClick={() =>
                  downloadText(
                    `${invoice.number}-receipt.txt`,
                    [
                      'STORY EXTERIOR CARE — SANDBOX PAYMENT FIXTURE',
                      `Invoice: ${invoice.number}`,
                      `Job: ${invoice.jobNumber}`,
                      `Customer: ${invoice.customerName}`,
                      `Paid: ${formatMoney(invoice.total)}`,
                      'Payment evidence: synthetic local sandbox fixture',
                      'Status: Scenario paid state; no funds moved',
                      '',
                    ].join('\n'),
                  )
                }
              >
                Receipt
              </Button>
            )}
          </Card>
        )}

        {invoice?.status === 'paid' && (
          <div className="portal-grid portal-followup-grid">
            <Card className="section-card portal-review-card">
              <Star size={23} />
              <h2>Review workflow fixture</h2>
              <p>Exercises consent and eligibility locally; no review link is sent.</p>
              <Button
                disabled={state.reviewRequested}
                onClick={actions.requestReview}
                variant="dark"
              >
                {state.reviewRequested ? 'Review fixture queued' : 'Queue review fixture'}
              </Button>
            </Card>
            <Card className="section-card portal-maintenance-card">
              <CalendarCheck2 size={23} />
              <h2>Maintenance workflow fixture</h2>
              <p>
                Records a synthetic semiannual candidate; no customer commitment or booking exists.
              </p>
              <Button disabled={state.recurringPlanActive} onClick={actions.activateRecurringPlan}>
                {state.recurringPlanActive ? 'Plan fixture active' : 'Activate plan fixture'}
              </Button>
            </Card>
            <Card className="section-card portal-maintenance-card">
              <UserRoundPlus size={23} />
              <h2>Referral workflow fixture</h2>
              <p>
                Exercises a consent-aware local state change; no invitation is externally scheduled.
              </p>
              <Button
                disabled={state.referralInvited}
                onClick={actions.inviteReferral}
                variant="secondary"
              >
                {state.referralInvited ? 'Referral fixture queued' : 'Queue referral fixture'}
              </Button>
            </Card>
          </div>
        )}
      </main>

      {termsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setTermsOpen(false)}>
          <section
            ref={termsDialogRef}
            className="record-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="portal-terms-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="icon-button record-dialog__close"
              aria-label="Close quote terms"
              onClick={() => setTermsOpen(false)}
            >
              <X size={16} />
            </button>
            <Badge tone="positive">Accepted terms snapshot</Badge>
            <h2 id="portal-terms-title">{estimate.estimateNumber} · Service Terms v2026.07</h2>
            <p>
              Scope is limited to the driveway pressure wash and gutter/downspout service shown in
              this quote. The accepted total is {formatMoney(estimate.total)}, including the
              recorded {formatMoney(estimate.deposit)} deposit.
            </p>
            <p>
              Additional work, material substitutions, or price changes require a separate
              customer-approved change. Weather, unsafe access, or an incident can pause work. Story
              Exterior Care retains the calculation and acceptance evidence with the job record.
            </p>
            <div className="record-dialog__actions">
              <Button variant="secondary" onClick={() => window.print()}>
                Print / save
              </Button>
              <Button onClick={() => setTermsOpen(false)}>Done</Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function icsTimestamp(value: string): string | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? undefined
    : parsed
        .toISOString()
        .replaceAll(/[-:]/gu, '')
        .replace(/\.\d{3}Z$/u, 'Z');
}

function LivePortalPage() {
  const { state, actions } = useStoryOps();
  const [termsOpen, setTermsOpen] = useState(false);
  const termsDialogRef = usePortalDialog(termsOpen, setTermsOpen);
  const [acceptanceSigner, setAcceptanceSigner] = useState('');
  const [acceptanceAcknowledged, setAcceptanceAcknowledged] = useState(false);
  const [acceptancePending, setAcceptancePending] = useState(false);
  const [quoteNotes, setQuoteNotes] = useState('');
  const [selectedQuoteServices, setSelectedQuoteServices] = useState<string[]>([]);
  const [selectedQuoteAddOns, setSelectedQuoteAddOns] = useState<string[]>([]);
  const [quoteDecisionPending, setQuoteDecisionPending] = useState(false);
  const [accountSelectionPending, setAccountSelectionPending] = useState(false);
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({});
  const [evidencePendingId, setEvidencePendingId] = useState<string>();
  const evidenceObjectUrls = useRef(new Set<string>());
  const reviewStatus = state.live?.postServiceReviewStatus;
  const referralStatus = state.live?.postServiceReferralStatus;
  const hasAcceptedReconciliationExhaustion =
    reviewStatus === 'reconciliation_required' || referralStatus === 'reconciliation_required';
  const hasManualReconciliation = hasPostServiceReconciliationRequired(
    reviewStatus,
    referralStatus,
  );
  const portalAccounts = state.live?.portalAccounts ?? [];
  const selectedPortalCustomerId = state.live?.selectedPortalCustomerId;
  const customer = state.live?.customers.find(
    (candidate) => candidate.id === selectedPortalCustomerId,
  );
  const visit = state.visits[0];
  const invoices = state.invoices;
  const accepted = state.customerQuoteAccepted;
  const commercialPortal = state.live?.customerCommercialPortal;
  const completedWork = state.live?.customerCompletedWork ?? [];
  const commercialQuote = commercialPortal?.quote;
  const paymentReconciliationRequired = commercialPortal?.paymentReconciliationRequired ?? false;
  const paymentReconciliationMessage =
    commercialPortal?.paymentReconciliationMessage ??
    'A verified payment needs office reconciliation. Online collection is paused so you are not charged twice.';
  const postServiceInvoice = invoices.find(
    (invoice) => invoice.status === 'paid' && invoice.id === state.live?.postServiceInvoice?.id,
  );
  const serverDate = state.live?.serverTime.slice(0, 10);
  const quoteExpired = Boolean(
    commercialQuote && serverDate && commercialQuote.validUntil < serverDate,
  );
  const commercialMutationReady =
    state.online &&
    Boolean(state.serverVerifiedAt) &&
    Boolean(selectedPortalCustomerId) &&
    state.live?.customerId === selectedPortalCustomerId;
  const depositRequired = commercialQuote?.depositRequired ?? state.estimate.deposit;
  const noDepositRequired = new Decimal(depositRequired).isZero();
  const depositProviderVerified = state.depositPaid && !noDepositRequired;
  const quoteActionEligible =
    !quoteExpired && (commercialQuote?.status === 'sent' || commercialQuote?.status === 'viewed');
  const startsAt = state.live?.visitStartsAt ? icsTimestamp(state.live.visitStartsAt) : undefined;
  const endsAt = state.live?.visitEndsAt ? icsTimestamp(state.live.visitEndsAt) : undefined;

  useEffect(() => {
    if (commercialQuote?.status === 'sent') actions.markQuoteViewed();
  }, [actions, commercialQuote?.id, commercialQuote?.status]);

  useEffect(
    () => () => {
      for (const objectUrl of evidenceObjectUrls.current) URL.revokeObjectURL(objectUrl);
      evidenceObjectUrls.current.clear();
    },
    [],
  );

  const viewCompletedWorkEvidence = async (assetId: string) => {
    if (evidenceUrls[assetId]) return;
    setEvidencePendingId(assetId);
    const blob = await actions.loadCustomerEvidence(assetId);
    if (blob) {
      const objectUrl = URL.createObjectURL(blob);
      evidenceObjectUrls.current.add(objectUrl);
      setEvidenceUrls((current) => ({ ...current, [assetId]: objectUrl }));
    }
    setEvidencePendingId(undefined);
  };

  const toggleQuoteChoice = (code: string, setter: Dispatch<SetStateAction<string[]>>) => {
    setter((current) =>
      current.includes(code)
        ? current.filter((candidate) => candidate !== code)
        : [...current, code],
    );
  };

  const submitQuoteChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuoteDecisionPending(true);
    const stored = await actions.submitQuoteDecision({
      action: 'quote.change_request',
      requestedServiceCodes: selectedQuoteServices,
      requestedAddOnCodes: selectedQuoteAddOns,
      notes: quoteNotes,
    });
    if (stored) {
      setSelectedQuoteServices([]);
      setSelectedQuoteAddOns([]);
      setQuoteNotes('');
    }
    setQuoteDecisionPending(false);
  };
  const submitAcceptance = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAcceptancePending(true);
    await actions.acceptQuote({
      signerName: acceptanceSigner,
      acknowledged: acceptanceAcknowledged,
    });
    setAcceptancePending(false);
  };

  return (
    <div className="portal-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header
        className="portal-header"
        aria-hidden={termsOpen ? true : undefined}
        inert={termsOpen ? true : undefined}
      >
        <div className="portal-brand">
          <span className="brand__mark">
            <Sparkles size={17} />
          </span>
          {state.live?.companyName ?? 'StoryOps customer portal'}
        </div>
        <div className="portal-header__actions">
          <button type="button" onClick={() => void actions.signOut()}>
            <LogOut size={13} /> Sign out
          </button>
          <Badge tone="accent">Authenticated portal</Badge>
        </div>
      </header>

      <main
        className="portal-content"
        id="main-content"
        aria-hidden={termsOpen ? true : undefined}
        inert={termsOpen ? true : undefined}
      >
        <div className="portal-welcome">
          <div>
            <p className="eyebrow">Customer portal</p>
            <h1>Hi, {customer?.name ?? 'customer'}.</h1>
            <p className="page-header__description">
              Only records linked to your authenticated customer mapping are shown.
            </p>
            {portalAccounts.length > 1 && (
              <Field
                label="Customer account"
                htmlFor="portal-customer-account"
                hint="Quotes, appointments, invoices, completed work, and payment actions switch together."
              >
                <select
                  className="input"
                  id="portal-customer-account"
                  value={selectedPortalCustomerId ?? ''}
                  disabled={accountSelectionPending || !commercialMutationReady}
                  onChange={(event) => {
                    const customerId = event.target.value;
                    setAccountSelectionPending(true);
                    void actions
                      .selectCustomerPortalAccount(customerId)
                      .finally(() => setAccountSelectionPending(false));
                  }}
                >
                  {portalAccounts.map((account) => (
                    <option key={account.customerId} value={account.customerId}>
                      {account.displayName}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <Badge tone={commercialMutationReady ? 'positive' : 'warning'} dot>
            {commercialMutationReady
              ? 'Server workspace verified'
              : state.online
                ? 'Network available · refresh required'
                : 'Offline · cached data'}
          </Badge>
        </div>

        {state.live?.propertyId && state.live.customerId && (
          <ScopePhotoCapturePanel
            key={state.live.propertyId}
            propertyId={state.live.propertyId}
            customerId={state.live.customerId}
            role={state.role}
          />
        )}

        {(state.recurringDueWork?.plans.length ?? 0) > 0 && (
          <Card className="section-card portal-maintenance-card">
            <CalendarCheck2 size={23} />
            <h2>Recurring maintenance</h2>
            {state.recurringDueWork?.plans.map((plan) => (
              <div className="template-row" key={plan.planId}>
                <span>
                  <strong>{plan.propertyName}</strong>
                  <small>
                    {plan.serviceCodes.join(', ')} · next review {plan.nextDueDate}
                  </small>
                </span>
                <Badge tone={plan.dueNow ? 'warning' : 'neutral'}>
                  {plan.dueNow ? 'Office review due' : 'Upcoming'}
                </Badge>
              </div>
            ))}
            {(state.recurringDueWork?.workItems.length ?? 0) > 0 && (
              <p>
                The office has a fresh-estimate task for this maintenance cycle. No price,
                availability, booking, visit, payment, or customer contact is implied. You will
                receive a new quote to review before any work can be booked.
              </p>
            )}
          </Card>
        )}

        {commercialQuote && !accepted && (
          <Card className="portal-quote">
            <div className="portal-quote__header">
              <div>
                <Badge tone={quoteActionEligible ? 'accent' : 'neutral'}>
                  {customerFacingQuoteStatus(commercialQuote.status)}
                </Badge>
                <h2>{commercialQuote.quoteNumber}</h2>
                <p>
                  Valid through {commercialQuote.validUntil} · terms {commercialQuote.termsVersion}{' '}
                  · published to this portal; email/SMS delivery is not asserted
                </p>
              </div>
              <div className="portal-quote__total">
                <span>Total</span>
                <strong>{formatMoney(commercialQuote.total)}</strong>
                <small>{formatMoney(commercialQuote.depositRequired)} deposit required</small>
              </div>
            </div>
            <div className="portal-quote__scope">
              {commercialQuote.lines.map((line) => (
                <div key={`${line.sortOrder}-${line.description}`}>
                  <span className="portal-scope-icon">
                    <FileCheck2 size={17} />
                  </span>
                  <span>
                    <strong>{line.description}</strong>
                    <small>
                      {line.quantity} {line.unit}
                    </small>
                  </span>
                  <strong>{formatMoney(line.subtotal)}</strong>
                </div>
              ))}
            </div>
            <div className="portal-terms">
              <ShieldCheck size={17} />
              <p>
                Review the exact server-retained terms snapshot before accepting. Acceptance records
                your authenticated user, signer name, quote total, terms version, time, command ID,
                and optimistic version.
              </p>
            </div>
            {quoteActionEligible ? (
              <>
                <form
                  className="portal-quote-acceptance"
                  onSubmit={(event) => void submitAcceptance(event)}
                >
                  <Field
                    label="Type the signer’s full name"
                    htmlFor="live-quote-signer"
                    hint="The signer is recorded exactly as typed; the customer profile cannot supply it."
                  >
                    <input
                      className="input"
                      id="live-quote-signer"
                      autoComplete="name"
                      maxLength={120}
                      value={acceptanceSigner}
                      onChange={(event) => setAcceptanceSigner(event.target.value)}
                    />
                  </Field>
                  <label className="portal-acceptance-check">
                    <input
                      type="checkbox"
                      checked={acceptanceAcknowledged}
                      onChange={(event) => setAcceptanceAcknowledged(event.target.checked)}
                    />
                    <span>
                      I reviewed quote {commercialQuote.quoteNumber}, terms{' '}
                      {commercialQuote.termsVersion}, and the exact{' '}
                      {formatMoney(commercialQuote.total)} total, and I agree to them.
                    </span>
                  </label>
                  <div className="portal-quote__actions">
                    <Button type="button" variant="secondary" onClick={() => setTermsOpen(true)}>
                      Review exact terms
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={
                        quoteDecisionPending || acceptancePending || !commercialMutationReady
                      }
                      onClick={() => {
                        setQuoteDecisionPending(true);
                        void actions
                          .submitQuoteDecision({
                            action: 'quote.decline',
                            notes: quoteNotes,
                          })
                          .finally(() => setQuoteDecisionPending(false));
                      }}
                    >
                      Decline quote
                    </Button>
                    <Button
                      type="submit"
                      size="lg"
                      loading={acceptancePending}
                      disabled={
                        !commercialMutationReady ||
                        acceptanceSigner.trim().length < 2 ||
                        !acceptanceAcknowledged
                      }
                      icon={<CheckCircle2 size={17} />}
                    >
                      Accept quote & terms
                    </Button>
                  </div>
                </form>
                <form
                  className="portal-quote-change"
                  onSubmit={(event) => void submitQuoteChange(event)}
                >
                  <h3>Request a different scope</h3>
                  <p>
                    This sends a review request only. It cannot change this quote’s lines, price,
                    terms, or acceptance state.
                  </p>
                  <div className="portal-service-options">
                    {state.customerPortalServiceOptions.map((option) => (
                      <label key={option.code}>
                        <input
                          type="checkbox"
                          checked={selectedQuoteServices.includes(option.code)}
                          onChange={() => toggleQuoteChoice(option.code, setSelectedQuoteServices)}
                        />
                        <span>{option.name}</span>
                      </label>
                    ))}
                    {commercialPortal?.addOnOptions.map((option) => (
                      <label key={option.selectionCode}>
                        <input
                          type="checkbox"
                          checked={selectedQuoteAddOns.includes(option.selectionCode)}
                          onChange={() =>
                            toggleQuoteChoice(option.selectionCode, setSelectedQuoteAddOns)
                          }
                        />
                        <span>{option.name} add-on</span>
                      </label>
                    ))}
                  </div>
                  <Field label="Change-request notes" htmlFor="portal-quote-change-notes">
                    <textarea
                      className="input"
                      id="portal-quote-change-notes"
                      value={quoteNotes}
                      maxLength={2000}
                      onChange={(event) => setQuoteNotes(event.target.value)}
                      placeholder="What should the office re-scope?"
                    />
                  </Field>
                  <Button
                    type="submit"
                    disabled={
                      quoteDecisionPending ||
                      !commercialMutationReady ||
                      (selectedQuoteServices.length === 0 &&
                        selectedQuoteAddOns.length === 0 &&
                        quoteNotes.trim().length === 0)
                    }
                  >
                    Submit change request
                  </Button>
                </form>
              </>
            ) : (
              <div className="portal-terms">
                <AlertTriangle size={17} />
                <p>
                  {commercialQuote.status === 'change_requested'
                    ? 'A change request is awaiting office re-estimation and policy review. This quote cannot be accepted.'
                    : commercialQuote.status === 'declined'
                      ? 'This quote was declined and can no longer be accepted.'
                      : quoteExpired
                        ? `This quote expired after ${commercialQuote.validUntil}. Request a current replacement from the office.`
                        : 'This quote is not eligible for acceptance.'}
                </p>
              </div>
            )}
          </Card>
        )}

        {paymentReconciliationRequired && (
          <Card className="projection-warning">
            <AlertTriangle size={18} />
            <div role="status">
              <strong>Online payment is paused</strong>
              <p>{paymentReconciliationMessage}</p>
            </div>
          </Card>
        )}

        {accepted && (
          <>
            <Card className="portal-invoice-card">
              <div>
                <span className="portal-invoice-card__icon">
                  {paymentReconciliationRequired ? (
                    <AlertTriangle size={20} />
                  ) : noDepositRequired || depositProviderVerified ? (
                    <CheckCircle2 size={20} />
                  ) : (
                    <WalletCards size={20} />
                  )}
                </span>
                <div>
                  <Badge
                    tone={
                      paymentReconciliationRequired
                        ? 'warning'
                        : noDepositRequired || depositProviderVerified
                          ? 'positive'
                          : 'warning'
                    }
                    dot
                  >
                    {paymentReconciliationRequired
                      ? 'Collection paused'
                      : noDepositRequired
                        ? 'No deposit required'
                        : depositProviderVerified
                          ? 'Provider verified'
                          : 'Deposit required'}
                  </Badge>
                  <h2>
                    {noDepositRequired
                      ? 'No deposit required'
                      : `${formatMoney(depositRequired)} deposit`}
                  </h2>
                  <p>
                    {paymentReconciliationRequired
                      ? paymentReconciliationMessage
                      : noDepositRequired
                        ? 'This accepted quote requires no deposit. Scheduling readiness does not assert that a payment occurred.'
                        : depositProviderVerified
                          ? 'A signed provider event was reconciled before scheduling readiness.'
                          : 'Opening checkout never marks payment successful. Scheduling stays blocked until signed provider reconciliation.'}
                  </p>
                </div>
              </div>
              {!noDepositRequired && !depositProviderVerified && !paymentReconciliationRequired && (
                <Button disabled={!commercialMutationReady} onClick={actions.startDepositCheckout}>
                  Open secure checkout
                </Button>
              )}
            </Card>

            <div className="portal-grid">
              <Card className="portal-appointment">
                <div className="portal-appointment__top">
                  <Badge tone={visit ? 'accent' : 'neutral'}>
                    {visit ? visit.status.replaceAll('_', ' ') : 'Not scheduled'}
                  </Badge>
                  <h2>{visit ? `${visit.date} · ${visit.startsAt}` : 'No visit is scheduled'}</h2>
                  <p>{visit?.service ?? 'A dispatcher has not created a visit yet.'}</p>
                </div>
                <div className="portal-appointment__body">
                  <div className="portal-detail-row">
                    <MapPin size={17} />
                    <div>
                      <strong>{customer?.address ?? 'Property not projected'}</strong>
                      <small>Authenticated customer property</small>
                    </div>
                  </div>
                  {visit && (
                    <div className="portal-detail-row">
                      <Clock3 size={17} />
                      <div>
                        <strong>
                          {visit.startsAt}–{visit.endsAt}
                        </strong>
                        <small>Current versioned visit window</small>
                      </div>
                    </div>
                  )}
                  {visit && startsAt && endsAt && (
                    <Button
                      variant="secondary"
                      className="full-width"
                      onClick={() =>
                        downloadText(
                          `${safeDownloadFilename(`storyops-${visit.jobNumber}`, 'storyops-job')}.ics`,
                          [
                            'BEGIN:VCALENDAR',
                            'VERSION:2.0',
                            'PRODID:-//StoryOps AI//Customer Portal//EN',
                            'BEGIN:VEVENT',
                            `UID:${escapeIcsText(visit.id)}@storyops.local`,
                            `DTSTAMP:${icsTimestamp(state.live?.serverTime ?? '') ?? startsAt}`,
                            `DTSTART:${startsAt}`,
                            `DTEND:${endsAt}`,
                            `SUMMARY:${escapeIcsText(visit.service)}`,
                            `LOCATION:${escapeIcsText(visit.address)}`,
                            `DESCRIPTION:${escapeIcsText(`StoryOps job ${visit.jobNumber}`)}`,
                            'END:VEVENT',
                            'END:VCALENDAR',
                            '',
                          ].join('\r\n'),
                          'text/calendar;charset=utf-8',
                        )
                      }
                    >
                      Add to calendar
                    </Button>
                  )}
                </div>
              </Card>

              <Card className="section-card">
                <h2>Quote & terms</h2>
                <button
                  className="portal-link-row"
                  type="button"
                  onClick={() => setTermsOpen(true)}
                >
                  <FileCheck2 size={16} />
                  <span>
                    <strong>{state.estimate.estimateNumber}</strong>
                    <small>
                      {state.live?.quoteStatus
                        ? customerFacingQuoteStatus(state.live.quoteStatus)
                        : 'status unavailable'}
                    </small>
                  </span>
                  <ChevronRight size={15} />
                </button>
              </Card>
            </div>
          </>
        )}

        <CustomerPortalControls key={state.customerCommunicationPreferences.version} />

        <Card className="section-card portal-completed-work">
          <div className="section-card__header">
            <div>
              <h2>Completed work evidence</h2>
              <p className="section-card__subtitle">
                Only explicitly published, durable before/after images from your completed visits
                appear here.
              </p>
            </div>
            <Camera size={18} />
          </div>
          {completedWork.length === 0 ? (
            <p role="status">No completed-work evidence has been explicitly published.</p>
          ) : (
            <div className="portal-evidence-jobs">
              {completedWork.map((work) => (
                <section key={work.visitId} aria-labelledby={`completed-work-${work.visitId}`}>
                  <div>
                    <h3 id={`completed-work-${work.visitId}`}>{work.jobNumber}</h3>
                    <p>
                      {work.serviceCodes.join(', ') || 'Service codes not recorded'} · completed{' '}
                      {work.completedAt}
                    </p>
                  </div>
                  <div className="portal-evidence-grid">
                    {work.media.map((media) => (
                      <figure key={media.id}>
                        {evidenceUrls[media.id] ? (
                          <img
                            src={evidenceUrls[media.id]}
                            alt={`${media.purpose} evidence for job ${work.jobNumber}`}
                          />
                        ) : (
                          <Button
                            type="button"
                            variant="secondary"
                            loading={evidencePendingId === media.id}
                            disabled={!commercialMutationReady}
                            icon={<Camera size={15} />}
                            onClick={() => void viewCompletedWorkEvidence(media.id)}
                          >
                            View {media.purpose} photo
                          </Button>
                        )}
                        <figcaption>
                          {media.purpose} · captured {media.capturedAt}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </Card>

        {invoices.length > 0 && (
          <section className="dashboard-stack" aria-labelledby="portal-invoices-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Billing</p>
                <h2 id="portal-invoices-title">Invoices</h2>
              </div>
              <Badge tone="neutral">{invoices.length} in this account</Badge>
            </div>
            {invoices.map((invoice) => {
              const commercialInvoice = commercialPortal?.invoices.find(
                (candidate) => candidate.id === invoice.id,
              );
              const invoicePaymentReconciliationRequired =
                commercialInvoice?.paymentReconciliationRequired ?? false;
              return (
                <Card className="portal-invoice-card" key={invoice.id}>
                  <div>
                    <span className="portal-invoice-card__icon">
                      <CircleDollarSign size={20} />
                    </span>
                    <div>
                      <Badge tone={invoice.status === 'paid' ? 'positive' : 'info'} dot>
                        {invoice.status}
                      </Badge>
                      <h3>{invoice.number}</h3>
                      <p>
                        {formatMoney(invoice.paid)} paid · {formatMoney(invoice.balance)} remaining
                      </p>
                    </div>
                  </div>
                  {invoice.status === 'paid' ? (
                    <Button
                      variant="secondary"
                      icon={<Download size={14} />}
                      onClick={() =>
                        downloadText(
                          `${invoice.number}-receipt.txt`,
                          [
                            `${state.live?.companyName ?? 'StoryOps'} — PAYMENT RECEIPT`,
                            `Invoice: ${invoice.number}`,
                            `Customer: ${customer?.name ?? 'Authenticated customer'}`,
                            `Total: ${formatMoney(invoice.total)}`,
                            `Paid: ${formatMoney(invoice.paid)}`,
                            'Status: Paid',
                            '',
                          ].join('\n'),
                        )
                      }
                    >
                      Receipt
                    </Button>
                  ) : invoicePaymentReconciliationRequired ? (
                    <Badge tone="warning">
                      Payment reconciliation required · collection paused
                    </Badge>
                  ) : Number(invoice.balance) > 0 ? (
                    <Button
                      disabled={!commercialMutationReady}
                      onClick={() => actions.startInvoiceCheckout(invoice.id)}
                    >
                      Pay {formatMoney(invoice.balance)} securely
                    </Button>
                  ) : null}
                </Card>
              );
            })}
          </section>
        )}

        {hasManualReconciliation && (
          <Card className="projection-warning">
            <AlertTriangle size={18} />
            <div role="status">
              <strong>
                {hasAcceptedReconciliationExhaustion
                  ? 'Your SMS was accepted and needs a delivery check'
                  : 'We’re checking your SMS request'}
              </strong>
              <p>
                {hasAcceptedReconciliationExhaustion
                  ? 'The messaging provider accepted the message, but delivery is not confirmed. The office must reconcile the provider record before taking another action.'
                  : 'Delivery cannot be confirmed yet. The office is reconciling the messaging-provider record, and StoryOps has not scheduled an automatic duplicate.'}
              </p>
            </div>
          </Card>
        )}

        {postServiceInvoice && (
          <div className="portal-grid portal-followup-grid">
            <Card className="section-card portal-review-card">
              <Star size={23} />
              <h2>How did we do?</h2>
              <p>
                {reviewStatus === 'submitted_unknown'
                  ? 'The messaging-provider submission outcome is unknown. No automatic resend is scheduled.'
                  : reviewStatus === 'reconciliation_required'
                    ? 'The provider accepted the SMS, but delivery remains unconfirmed and requires office reconciliation.'
                    : 'Your explicit request queues a consent-checked SMS; it does not claim delivery.'}
              </p>
              <Button
                disabled={state.reviewRequested}
                onClick={actions.requestReview}
                variant="dark"
              >
                {postServiceFollowupLabel('Review', reviewStatus, 'Queue my review SMS')}
              </Button>
            </Card>
            <Card className="section-card portal-maintenance-card">
              <CalendarCheck2 size={23} />
              <h2>Keep this property on schedule</h2>
              <p>
                Activate the completed job’s service scope semiannually. Every visit still requires
                a fresh estimate.
              </p>
              <Button disabled={state.recurringPlanActive} onClick={actions.activateRecurringPlan}>
                {state.recurringPlanActive ? 'Plan active' : 'Activate semiannual plan'}
              </Button>
            </Card>
            <Card className="section-card portal-maintenance-card">
              <UserRoundPlus size={23} />
              <h2>Invite a referral</h2>
              <p>
                {referralStatus === 'submitted_unknown'
                  ? 'The messaging-provider submission outcome is unknown. No automatic resend is scheduled.'
                  : 'This creates one source-linked referral and queues a consent-checked SMS without adding a neighbor or claiming delivery.'}
              </p>
              <Button
                disabled={state.referralInvited}
                onClick={actions.inviteReferral}
                variant="secondary"
              >
                {postServiceFollowupLabel('Referral', referralStatus, 'Queue referral SMS')}
              </Button>
            </Card>
          </div>
        )}

        <Card className="projection-warning">
          <ShieldCheck size={18} />
          <div>
            <strong>Live follow-up remains server controlled</strong>
            <p>
              Review, referral, maintenance, and payment actions are not simulated. They appear here
              only after verified server records or an approved provider workflow exists.
            </p>
          </div>
        </Card>
      </main>

      {termsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setTermsOpen(false)}>
          <section
            ref={termsDialogRef}
            className="record-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="live-portal-terms-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="icon-button record-dialog__close"
              aria-label="Close quote terms"
              onClick={() => setTermsOpen(false)}
            >
              <X size={16} />
            </button>
            <Badge tone="neutral">Server-retained snapshot</Badge>
            <h2 id="live-portal-terms-title">{state.estimate.estimateNumber}</h2>
            <pre className="live-terms-snapshot">
              {state.live?.quoteTermsSnapshot ??
                'Terms snapshot is not available in this projection.'}
            </pre>
            <div className="record-dialog__actions">
              <Button variant="secondary" onClick={() => window.print()}>
                Print / save
              </Button>
              <Button onClick={() => setTermsOpen(false)}>Done</Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

const portalConsentDisclosureVersion = 'customer-portal-consent-v1';

function CustomerPortalControls() {
  const { state, actions } = useStoryOps();
  const customer = state.live?.customers[0];
  const customerId = state.live?.customerId ?? 'sandbox-customer-morgan';
  const propertyId = state.live?.propertyId ?? 'sandbox-property-morgan';
  const visitId = state.live?.visit?.id ?? state.visits[0]?.id;
  const hasSmsContact = state.dataMode === 'sandbox' || Boolean(customer?.phone);
  const hasEmailContact = state.dataMode === 'sandbox' || Boolean(customer?.email);
  const [preferredStartDate, setPreferredStartDate] = useState('');
  const [preferredEndDate, setPreferredEndDate] = useState('');
  const [rescheduleNotes, setRescheduleNotes] = useState('');
  const [serviceNotes, setServiceNotes] = useState('');
  const [selectedServiceCodes, setSelectedServiceCodes] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState<
    'reschedule' | 'additional_service' | 'preferences' | undefined
  >();
  const [consentAcknowledged, setConsentAcknowledged] = useState(false);
  const [preferences, setPreferences] = useState(state.customerCommunicationPreferences);

  const submitReschedule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!visitId) return;
    setSubmitting('reschedule');
    const stored = await actions.submitCustomerPortalRequest({
      requestType: 'reschedule',
      customerId,
      propertyId,
      visitId,
      preferredStartDate,
      preferredEndDate,
      requestNotes: rescheduleNotes,
    });
    if (stored) {
      setPreferredStartDate('');
      setPreferredEndDate('');
      setRescheduleNotes('');
    }
    setSubmitting(undefined);
  };

  const submitAdditionalService = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting('additional_service');
    const stored = await actions.submitCustomerPortalRequest({
      requestType: 'additional_service',
      customerId,
      propertyId,
      requestedServiceCodes: selectedServiceCodes,
      requestNotes: serviceNotes,
    });
    if (stored) {
      setSelectedServiceCodes([]);
      setServiceNotes('');
    }
    setSubmitting(undefined);
  };

  const savePreferences = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting('preferences');
    const stored = await actions.updateCustomerCommunicationPreferences({
      customerId,
      transactionalSms: preferences.transactionalSms,
      transactionalEmail: preferences.transactionalEmail,
      marketingSms: preferences.marketingSms,
      marketingEmail: preferences.marketingEmail,
      globalOptOut: preferences.globalOptOut,
      disclosureVersion: portalConsentDisclosureVersion,
    });
    if (stored) setConsentAcknowledged(false);
    setSubmitting(undefined);
  };

  const toggleService = (code: string) => {
    setSelectedServiceCodes((current) =>
      current.includes(code)
        ? current.filter((candidate) => candidate !== code)
        : [...current, code],
    );
  };

  return (
    <section className="portal-self-service" aria-labelledby="portal-self-service-title">
      <div className="section-header">
        <div>
          <p className="eyebrow">Requests & communication</p>
          <h2 id="portal-self-service-title">Tell the office what you need</h2>
          <p className="section-card__subtitle">
            Requests are reviewed by the office. They never change an appointment, price, or payment
            state on submission.
          </p>
        </div>
        <Badge tone={state.dataMode === 'supabase' ? 'positive' : 'neutral'}>
          {state.dataMode === 'supabase' ? 'Authenticated customer' : 'Sandbox fixtures only'}
        </Badge>
      </div>

      <div className="portal-request-grid">
        <Card className="section-card portal-request-card">
          <Badge tone="info">Request only</Badge>
          <h3>Ask to reschedule</h3>
          <p>
            Your current visit remains unchanged until the office confirms a replacement window.
          </p>
          <form onSubmit={(event) => void submitReschedule(event)}>
            <div className="form-grid form-grid--2">
              <Field label="Preferred start date" htmlFor="portal-reschedule-start">
                <input
                  className="input"
                  id="portal-reschedule-start"
                  type="date"
                  value={preferredStartDate}
                  onChange={(event) => setPreferredStartDate(event.target.value)}
                  required
                />
              </Field>
              <Field label="Preferred end date" htmlFor="portal-reschedule-end">
                <input
                  className="input"
                  id="portal-reschedule-end"
                  type="date"
                  min={preferredStartDate || undefined}
                  value={preferredEndDate}
                  onChange={(event) => setPreferredEndDate(event.target.value)}
                  required
                />
              </Field>
            </div>
            <Field
              label="Scheduling notes"
              htmlFor="portal-reschedule-notes"
              hint="Share windows that work or constraints the dispatcher should know."
            >
              <textarea
                className="textarea"
                id="portal-reschedule-notes"
                maxLength={2000}
                value={rescheduleNotes}
                onChange={(event) => setRescheduleNotes(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              disabled={!visitId || !preferredStartDate || !preferredEndDate || Boolean(submitting)}
            >
              {submitting === 'reschedule' ? 'Submitting…' : 'Submit reschedule request'}
            </Button>
            {!visitId && <small>No scheduled visit is available to request a change for.</small>}
          </form>
        </Card>

        <Card className="section-card portal-request-card">
          <Badge tone="accent">New intake</Badge>
          <h3>Request another service</h3>
          <p>
            This creates a new qualification lead linked to your customer and property records. It
            is not a quote or booking.
          </p>
          <form onSubmit={(event) => void submitAdditionalService(event)}>
            <fieldset className="portal-service-options">
              <legend>Services to discuss</legend>
              {state.customerPortalServiceOptions.map((option) => (
                <label key={option.code}>
                  <input
                    type="checkbox"
                    checked={selectedServiceCodes.includes(option.code)}
                    onChange={() => toggleService(option.code)}
                  />
                  <span>{option.name}</span>
                </label>
              ))}
            </fieldset>
            <Field
              label="Scope notes"
              htmlFor="portal-service-notes"
              hint="Describe the areas involved. Measurements and price will still be verified."
            >
              <textarea
                className="textarea"
                id="portal-service-notes"
                maxLength={2000}
                value={serviceNotes}
                onChange={(event) => setServiceNotes(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              disabled={selectedServiceCodes.length === 0 || Boolean(submitting)}
            >
              {submitting === 'additional_service'
                ? 'Submitting…'
                : 'Submit additional-service request'}
            </Button>
          </form>
        </Card>
      </div>

      <Card className="section-card portal-preferences-card">
        <div className="portal-preferences-card__header">
          <div>
            <Badge tone={preferences.globalOptOut ? 'warning' : 'neutral'}>
              {preferences.globalOptOut ? 'Contact suppressed' : 'Purpose-specific choices'}
            </Badge>
            <h3>Communication preferences & consent</h3>
            <p>
              Choose separately for service updates and marketing. Delivery is never assumed, and
              saving a preference does not send a message.
            </p>
          </div>
          <small>
            Evidence version {preferences.version} · disclosure{' '}
            {preferences.disclosureVersion || portalConsentDisclosureVersion}
          </small>
        </div>
        <form onSubmit={(event) => void savePreferences(event)}>
          <div className="portal-preference-grid">
            <fieldset>
              <legend>Service and account updates</legend>
              <label>
                <input
                  type="checkbox"
                  checked={preferences.transactionalSms}
                  disabled={preferences.globalOptOut || !hasSmsContact}
                  onChange={(event) =>
                    setPreferences((current) => ({
                      ...current,
                      transactionalSms: event.target.checked,
                    }))
                  }
                />
                <span>SMS service updates</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferences.transactionalEmail}
                  disabled={preferences.globalOptOut || !hasEmailContact}
                  onChange={(event) =>
                    setPreferences((current) => ({
                      ...current,
                      transactionalEmail: event.target.checked,
                    }))
                  }
                />
                <span>Email service updates</span>
              </label>
            </fieldset>
            <fieldset>
              <legend>Offers and maintenance marketing</legend>
              <label>
                <input
                  type="checkbox"
                  checked={preferences.marketingSms}
                  disabled={preferences.globalOptOut || !hasSmsContact}
                  onChange={(event) =>
                    setPreferences((current) => ({
                      ...current,
                      marketingSms: event.target.checked,
                    }))
                  }
                />
                <span>Marketing SMS</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferences.marketingEmail}
                  disabled={preferences.globalOptOut || !hasEmailContact}
                  onChange={(event) =>
                    setPreferences((current) => ({
                      ...current,
                      marketingEmail: event.target.checked,
                    }))
                  }
                />
                <span>Marketing email</span>
              </label>
            </fieldset>
          </div>
          <label className="portal-global-optout">
            <input
              type="checkbox"
              checked={preferences.globalOptOut}
              onChange={(event) =>
                setPreferences((current) => ({
                  ...current,
                  globalOptOut: event.target.checked,
                }))
              }
            />
            <span>
              <strong>Opt out of all StoryOps SMS and email</strong>
              <small>
                This withdraws every listed purpose and activates contact-level suppression.
              </small>
            </span>
          </label>
          {!preferences.globalOptOut && (
            <label className="portal-consent-acknowledgement">
              <input
                type="checkbox"
                checked={consentAcknowledged}
                onChange={(event) => setConsentAcknowledged(event.target.checked)}
              />
              <span>
                I am choosing these channels for this customer account. Consent can be withdrawn
                here or by replying STOP to SMS. Message and data rates may apply.
              </span>
            </label>
          )}
          <div className="portal-preferences-card__actions">
            <Button
              type="submit"
              disabled={Boolean(submitting) || (!preferences.globalOptOut && !consentAcknowledged)}
            >
              {submitting === 'preferences' ? 'Saving…' : 'Save communication choices'}
            </Button>
            <small>
              {state.dataMode === 'supabase'
                ? 'Stored as authenticated consent evidence; no provider call occurs.'
                : 'Stored only on this device; no live suppression or provider state changes.'}
            </small>
          </div>
        </form>
      </Card>

      {state.customerPortalRequests.length > 0 && (
        <Card className="section-card portal-request-history">
          <h3>Recent requests</h3>
          <ul>
            {state.customerPortalRequests.slice(0, 5).map((request) => (
              <li key={request.id}>
                <span>
                  <strong>
                    {request.requestType === 'reschedule'
                      ? 'Reschedule request'
                      : 'Additional-service request'}
                  </strong>
                  <small>
                    {request.requestType === 'reschedule'
                      ? `${request.preferredStartDate ?? 'No start'} through ${request.preferredEndDate ?? 'No end'}`
                      : request.requestedServiceCodes
                          .map(
                            (code) =>
                              state.customerPortalServiceOptions.find(
                                (option) => option.code === code,
                              )?.name ?? code,
                          )
                          .join(', ')}
                  </small>
                </span>
                <Badge tone={request.status === 'resolved' ? 'positive' : 'info'}>
                  {request.status}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
