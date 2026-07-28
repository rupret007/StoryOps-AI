import {
  AlertTriangle,
  ArrowLeft,
  CalendarCheck2,
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
import { useMemo, useState } from 'react';
import { useNavigate } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Button, Card } from '@/components/ui/Primitives';
import { downloadText, escapeIcsText, safeDownloadFilename } from '@/utils/download';
import { calculateDemoPrice, summarizeDemoServiceTotals } from '@/data/priceBook';
import {
  hasPostServiceReconciliationRequired,
  postServiceFollowupLabel,
} from '@/utils/postServiceStatus';

const formatMoney = (amount: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount));

export function PortalPage() {
  const { state, actions } = useStoryOps();
  const navigate = useNavigate();
  const [termsOpen, setTermsOpen] = useState(false);
  const estimate = state.estimate;
  const invoice = state.invoices.find((item) => item.id === 'invoice-morgan');
  const accepted = state.customerQuoteAccepted;
  const companyName = state.setupProfile?.businessName ?? 'StoryOps';
  const quoteReady = estimate.status === 'quoted';
  const serviceTotals = useMemo(
    () => summarizeDemoServiceTotals(calculateDemoPrice(estimate)),
    [estimate],
  );

  if (state.dataMode === 'supabase') return <LivePortalPage />;

  const backToWorkspace = () => {
    if (state.role === 'customer') actions.setRole('owner');
    navigate('/');
  };

  return (
    <div className="portal-shell">
      <header className="portal-header">
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

      <main className="portal-content" id="main-content">
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
              approvals, and delivery are complete.
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
                  <small>{estimate.gutterLinearFt} linear ft · two story · four downspouts</small>
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
            <div className="portal-quote__actions">
              <Button
                variant="secondary"
                icon={<Download size={15} />}
                onClick={() => window.print()}
              >
                Print / save PDF
              </Button>
              <Button size="lg" onClick={actions.acceptQuote} icon={<CheckCircle2 size={17} />}>
                Accept & record {formatMoney(estimate.deposit)} fixture
              </Button>
            </div>
          </Card>
        )}

        {accepted && (
          <div className="portal-grid">
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
                    <small>We’ll text when the technician is on the way.</small>
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
  const reviewStatus = state.live?.postServiceReviewStatus;
  const referralStatus = state.live?.postServiceReferralStatus;
  const hasAcceptedReconciliationExhaustion =
    reviewStatus === 'reconciliation_required' || referralStatus === 'reconciliation_required';
  const hasManualReconciliation = hasPostServiceReconciliationRequired(
    reviewStatus,
    referralStatus,
  );
  const customer = state.live?.customers[0];
  const visit = state.visits[0];
  const invoice = state.invoices[0];
  const accepted = state.customerQuoteAccepted;
  const startsAt = state.live?.visitStartsAt ? icsTimestamp(state.live.visitStartsAt) : undefined;
  const endsAt = state.live?.visitEndsAt ? icsTimestamp(state.live.visitEndsAt) : undefined;

  return (
    <div className="portal-shell">
      <header className="portal-header">
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

      <main className="portal-content" id="main-content">
        <div className="portal-welcome">
          <div>
            <p className="eyebrow">Customer portal</p>
            <h1>Hi, {customer?.name ?? 'customer'}.</h1>
            <p className="page-header__description">
              Only records linked to your authenticated customer mapping are shown.
            </p>
          </div>
          <Badge tone="positive" dot>
            Server connected
          </Badge>
        </div>

        {state.live?.quote && !accepted && (
          <Card className="portal-quote">
            <div className="portal-quote__header">
              <div>
                <Badge tone="accent">{state.live.quoteStatus ?? 'available'}</Badge>
                <h2>{state.estimate.estimateNumber}</h2>
                <p>Versioned quote returned by the authenticated workspace</p>
              </div>
              <div className="portal-quote__total">
                <span>Total</span>
                <strong>{formatMoney(state.estimate.total)}</strong>
                <small>{formatMoney(state.estimate.deposit)} deposit required</small>
              </div>
            </div>
            <div className="portal-terms">
              <ShieldCheck size={17} />
              <p>
                Review the exact server-retained terms snapshot before accepting. Acceptance records
                your authenticated user, signer name, quote total, terms version, time, command ID,
                and optimistic version.
              </p>
            </div>
            <div className="portal-quote__actions">
              <Button variant="secondary" onClick={() => setTermsOpen(true)}>
                Review exact terms
              </Button>
              <Button size="lg" onClick={actions.acceptQuote} icon={<CheckCircle2 size={17} />}>
                Accept quote
              </Button>
            </div>
          </Card>
        )}

        {accepted && (
          <>
            <Card className="portal-invoice-card">
              <div>
                <span className="portal-invoice-card__icon">
                  {state.depositPaid ? <CheckCircle2 size={20} /> : <WalletCards size={20} />}
                </span>
                <div>
                  <Badge tone={state.depositPaid ? 'positive' : 'warning'} dot>
                    {state.depositPaid ? 'Provider verified' : 'Deposit required'}
                  </Badge>
                  <h2>{formatMoney(state.estimate.deposit)} deposit</h2>
                  <p>
                    {state.depositPaid
                      ? 'A signed provider event was reconciled before scheduling readiness.'
                      : 'Opening checkout never marks payment successful. Scheduling stays blocked until signed provider reconciliation.'}
                  </p>
                </div>
              </div>
              {!state.depositPaid && (
                <Button onClick={actions.startDepositCheckout}>Open secure checkout</Button>
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
                    <small>{state.live?.quoteStatus ?? 'status unavailable'}</small>
                  </span>
                  <ChevronRight size={15} />
                </button>
              </Card>
            </div>
          </>
        )}

        {invoice && (
          <Card className="portal-invoice-card">
            <div>
              <span className="portal-invoice-card__icon">
                <CircleDollarSign size={20} />
              </span>
              <div>
                <Badge tone={invoice.status === 'paid' ? 'positive' : 'info'} dot>
                  {invoice.status}
                </Badge>
                <h2>{invoice.number}</h2>
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
            ) : (
              <span className="section-card__subtitle">
                Live checkout opens only through a configured payment-provider flow.
              </span>
            )}
          </Card>
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

        {invoice?.status === 'paid' && invoice.id === state.live?.postServiceInvoice?.id && (
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
