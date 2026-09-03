import {
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  CheckCircle2,
  CircleDollarSign,
  Download,
  FileText,
  ReceiptText,
  Send,
  UserRoundPlus,
  WalletCards,
} from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link, useSearchParams } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import type { DemoInvoice } from '@/state/model';
import { Badge, Button, Card, Field, Metric, PageHeader } from '@/components/ui/Primitives';
import { downloadText, rowsToCsv } from '@/utils/download';
import {
  hasPostServiceReconciliationRequired,
  postServiceFollowupLabel,
} from '@/utils/postServiceStatus';

const formatMoney = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);

interface InvoiceTarget {
  id?: string;
  exists: boolean;
  rowRef: RefObject<HTMLTableRowElement | null>;
  clear(): void;
}

function useInvoiceTarget(invoices: readonly DemoInvoice[]): InvoiceTarget {
  const [searchParams, setSearchParams] = useSearchParams();
  const rowRef = useRef<HTMLTableRowElement>(null);
  const id = searchParams.get('invoice') ?? undefined;
  const exists = Boolean(id && invoices.some((invoice) => invoice.id === id));

  useEffect(() => {
    if (!exists) return;
    rowRef.current?.focus({ preventScroll: true });
    rowRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [exists, id]);

  return {
    id,
    exists,
    rowRef,
    clear: () => {
      const next = new URLSearchParams(searchParams);
      next.delete('invoice');
      setSearchParams(next);
    },
  };
}

function MissingInvoiceTarget({ onClear }: { onClear(): void }) {
  return (
    <div role="status">
      <Card className="record-target-notice">
        <div>
          <strong>That invoice is not in the current role-visible workspace.</strong>
          <p>It may have changed, been reconciled, or fallen outside this signed-in scope.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={onClear}>
          Show role-visible invoices
        </Button>
      </Card>
    </div>
  );
}

export function FinancePage() {
  const { state, actions, can } = useStoryOps();
  const invoiceTarget = useInvoiceTarget(state.invoices);
  const [filter, setFilter] = useState<'all' | 'open' | 'past_due'>('all');
  const issued = state.invoices.some((invoice) => invoice.id === 'invoice-morgan');
  const paid = state.invoices.some(
    (invoice) => invoice.id === 'invoice-morgan' && invoice.status === 'paid',
  );
  const outstanding = state.invoices.reduce(
    (total, invoice) => total + Number(invoice.balance.replaceAll(',', '')),
    0,
  );
  const visibleInvoices = state.invoices.filter(
    (invoice) =>
      filter === 'all' ||
      (filter === 'open' && invoice.status === 'open') ||
      (filter === 'past_due' && invoice.status === 'past_due'),
  );
  const exportQuickBooks = () => {
    downloadText(
      `storyops-quickbooks-${new Date().toISOString().slice(0, 10)}.csv`,
      rowsToCsv([
        ['TxnType', 'Date', 'RefNumber', 'Customer', 'Amount', 'Paid', 'Balance', 'Status'],
        ...state.invoices.map((invoice) => [
          'INVOICE',
          invoice.issueDate,
          invoice.number,
          invoice.customerName,
          invoice.total,
          invoice.paid,
          invoice.balance,
          invoice.status,
        ]),
      ]),
      'text/csv;charset=utf-8',
    );
  };

  if (state.dataMode === 'supabase') return <LiveFinancePage invoiceTarget={invoiceTarget} />;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Invoices, payments & profitability"
        title="Know what earned money—and what still needs attention"
        description="Synthetic sandbox finance scenario: no invoice delivery, provider payment, funds movement, refund, bank action, or customer contact is asserted."
        actions={
          <>
            <Button variant="secondary" onClick={exportQuickBooks} icon={<Download size={15} />}>
              QuickBooks export
            </Button>
            <Button
              disabled={!can('invoices.write') || issued}
              onClick={actions.issueInvoice}
              icon={<FileText size={15} />}
            >
              {issued ? 'INV-1048 issued' : 'Issue completed job'}
            </Button>
          </>
        }
      />

      {invoiceTarget.id && !invoiceTarget.exists && (
        <MissingInvoiceTarget onClear={invoiceTarget.clear} />
      )}

      <section className="metrics-grid">
        <Metric
          label="Collected in July"
          value="$12,480"
          delta="+22% month to date"
          icon={<Banknote size={18} />}
        />
        <Metric
          label="Open receivables"
          value={formatMoney(outstanding)}
          delta="3 invoices · 1 past due"
          icon={<ReceiptText size={18} />}
          tone="orange"
        />
        <Metric
          label="Average ticket"
          value="$624"
          delta="+$48 vs. June"
          icon={<WalletCards size={18} />}
          tone="blue"
        />
        <Metric
          label="Gross profit"
          value="$7,326"
          delta="58.7% blended margin"
          icon={<CircleDollarSign size={18} />}
          tone="plum"
        />
      </section>

      <div className="finance-grid">
        <Card className="section-card finance-chart-card">
          <div className="section-card__header">
            <div>
              <h2>Revenue & gross profit</h2>
              <p className="section-card__subtitle">Accepted revenue less estimated job cost</p>
            </div>
            <Badge tone="positive">
              <ArrowUpRight size={11} /> 18.2%
            </Badge>
          </div>
          <div className="finance-chart" aria-label="Weekly revenue and profit bar chart">
            {[
              { week: 'Jul 1', revenue: 48, profit: 27 },
              { week: 'Jul 8', revenue: 61, profit: 36 },
              { week: 'Jul 15', revenue: 72, profit: 42 },
              { week: 'Jul 22', revenue: 84, profit: 52 },
              { week: 'Jul 29', revenue: 64, profit: 39 },
            ].map((item) => (
              <div className="finance-chart__group" key={item.week}>
                <div className="finance-chart__bars">
                  <span className="finance-chart__revenue" style={{ height: `${item.revenue}%` }} />
                  <span className="finance-chart__profit" style={{ height: `${item.profit}%` }} />
                </div>
                <small>{item.week}</small>
              </div>
            ))}
          </div>
          <div className="chart-legend">
            <span>
              <i className="legend-revenue" /> Revenue
            </span>
            <span>
              <i className="legend-profit" /> Gross profit
            </span>
          </div>
        </Card>

        <Card className="section-card profitability-card">
          <div className="section-card__header">
            <div>
              <h2>Job profitability</h2>
              <p className="section-card__subtitle">Current month · completed work</p>
            </div>
          </div>
          <div className="profitability-ring">
            <div className="profitability-ring__visual">
              <span>
                <strong>58.7%</strong>
                <small>margin</small>
              </span>
            </div>
            <div className="profitability-breakdown">
              <div>
                <span>Revenue</span>
                <strong>$12,480</strong>
              </div>
              <div>
                <span>Labor</span>
                <strong>$2,745</strong>
              </div>
              <div>
                <span>Materials</span>
                <strong>$1,186</strong>
              </div>
              <div>
                <span>Travel + fees</span>
                <strong>$1,223</strong>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Card className="invoice-card">
        <div className="list-toolbar">
          <div>
            <h2>Invoices</h2>
            <p className="section-card__subtitle">
              Local fixtures only · no Stripe event or customer delivery
            </p>
          </div>
          <div className="segmented">
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              All
            </button>
            <button
              type="button"
              aria-pressed={filter === 'open'}
              onClick={() => setFilter('open')}
            >
              Open
            </button>
            <button
              type="button"
              aria-pressed={filter === 'past_due'}
              onClick={() => setFilter('past_due')}
            >
              Past due
            </button>
          </div>
        </div>
        <div className="table-wrap customer-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Issued</th>
                <th>Due / paid</th>
                <th>Total</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleInvoices.map((invoice) => (
                <tr
                  key={invoice.id}
                  ref={invoice.id === invoiceTarget.id ? invoiceTarget.rowRef : undefined}
                  className={invoice.id === invoiceTarget.id ? 'data-table__target' : undefined}
                  tabIndex={invoice.id === invoiceTarget.id ? -1 : undefined}
                  aria-current={invoice.id === invoiceTarget.id ? 'true' : undefined}
                >
                  <td>
                    <strong>{invoice.number}</strong>
                    <span className="table-subtext">{invoice.jobNumber}</span>
                  </td>
                  <td>{invoice.customerName}</td>
                  <td>{invoice.issueDate}</td>
                  <td>{invoice.dueDate}</td>
                  <td>${invoice.total}</td>
                  <td>
                    <strong>${invoice.balance}</strong>
                  </td>
                  <td>
                    <Badge
                      tone={
                        invoice.status === 'paid'
                          ? 'positive'
                          : invoice.status === 'past_due'
                            ? 'danger'
                            : 'info'
                      }
                      dot
                    >
                      {invoice.status.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td>
                    {invoice.id === 'invoice-morgan' && invoice.status !== 'paid' ? (
                      <Button
                        size="sm"
                        disabled={!can('payments.manage')}
                        onClick={actions.recordSandboxPayment}
                      >
                        Pay sandbox
                      </Button>
                    ) : invoice.status === 'open' || invoice.status === 'past_due' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={
                          !can('communications.send') ||
                          state.remindedInvoiceIds.includes(invoice.id)
                        }
                        onClick={() => actions.sendInvoiceReminder(invoice.id)}
                        icon={<Send size={12} />}
                      >
                        {state.remindedInvoiceIds.includes(invoice.id)
                          ? 'Reminder fixture recorded'
                          : 'Record reminder fixture'}
                      </Button>
                    ) : (
                      <Badge tone="neutral">
                        <CheckCircle2 size={11} /> Reconciled
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {paid && (
        <Card className="post-payment-card">
          <div>
            <CheckCircle2 size={22} />
            <div>
              <h3>INV-1048 has a sandbox paid-state fixture</h3>
              <p>No funds moved. Continue the local review, referral, and maintenance scenario.</p>
            </div>
          </div>
          <div>
            <Button
              variant="secondary"
              disabled={state.reviewRequested}
              onClick={actions.requestReview}
            >
              {state.reviewRequested ? 'Review fixture queued' : 'Queue review fixture'}
            </Button>
            <Button
              variant="dark"
              disabled={state.referralInvited}
              onClick={actions.inviteReferral}
              icon={<UserRoundPlus size={14} />}
            >
              {state.referralInvited ? 'Referral fixture queued' : 'Queue referral fixture'}
            </Button>
            <Button disabled={state.recurringPlanActive} onClick={actions.activateRecurringPlan}>
              {state.recurringPlanActive ? 'Plan fixture active' : 'Activate plan fixture'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function LiveFinancePage({ invoiceTarget }: { invoiceTarget: InvoiceTarget }) {
  const { state, actions, can } = useStoryOps();
  const [filter, setFilter] = useState<'all' | 'open' | 'past_due'>('all');
  const [allocationNotes, setAllocationNotes] = useState<Record<string, string>>({});
  const [resolvingConflictId, setResolvingConflictId] = useState<string>();
  const reviewStatus = state.live?.postServiceReviewStatus;
  const referralStatus = state.live?.postServiceReferralStatus;
  const hasAcceptedReconciliationExhaustion =
    reviewStatus === 'reconciliation_required' || referralStatus === 'reconciliation_required';
  const hasManualReconciliation = hasPostServiceReconciliationRequired(
    reviewStatus,
    referralStatus,
  );
  const postServiceInvoice = state.invoices.find(
    (invoice) => invoice.id === state.live?.postServiceInvoice?.id,
  );
  const paymentAllocationConflicts = state.live?.paymentAllocationConflicts ?? [];
  const visibleInvoices = state.invoices.filter(
    (invoice) =>
      filter === 'all' ||
      (filter === 'open' && invoice.status === 'open') ||
      (filter === 'past_due' && invoice.status === 'past_due'),
  );
  const collected = state.invoices.reduce(
    (total, invoice) => total + Number(invoice.paid.replaceAll(',', '')),
    0,
  );
  const outstanding = state.invoices.reduce(
    (total, invoice) => total + Number(invoice.balance.replaceAll(',', '')),
    0,
  );
  const average =
    state.invoices.length > 0
      ? state.invoices.reduce(
          (total, invoice) => total + Number(invoice.total.replaceAll(',', '')),
          0,
        ) / state.invoices.length
      : 0;
  const exportQuickBooks = () => {
    downloadText(
      `storyops-live-invoices-${new Date().toISOString().slice(0, 10)}.csv`,
      rowsToCsv([
        ['TxnType', 'Date', 'RefNumber', 'Customer', 'Amount', 'Paid', 'Balance', 'Status'],
        ...state.invoices.map((invoice) => [
          'INVOICE',
          invoice.issueDate,
          invoice.number,
          invoice.customerName,
          invoice.total,
          invoice.paid,
          invoice.balance,
          invoice.status,
        ]),
      ]),
      'text/csv;charset=utf-8',
    );
  };
  const resolveExactAllocation = async (conflictId: string) => {
    setResolvingConflictId(conflictId);
    try {
      const resolved = await actions.resolvePaymentAllocation({
        conflictId,
        resolutionNote: allocationNotes[conflictId] ?? '',
      });
      if (resolved) {
        setAllocationNotes((current) => {
          const next = { ...current };
          delete next[conflictId];
          return next;
        });
      }
    } finally {
      setResolvingConflictId(undefined);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Authenticated finance read model"
        title="Invoices and verified payment state"
        description="Amounts come from the role-scoped workspace. Browser controls cannot manufacture invoices, payments, refunds, bank actions, or delivery receipts."
        actions={
          <>
            <Button variant="secondary" onClick={exportQuickBooks} icon={<Download size={15} />}>
              Export projected invoices
            </Button>
            <Button variant="secondary" onClick={() => void actions.reloadLiveWorkspace()}>
              Refresh
            </Button>
            {state.live?.invoice &&
              state.invoices.some((invoice) => invoice.id === state.live?.invoice?.id) &&
              state.invoices.find((invoice) => invoice.id === state.live?.invoice?.id)?.status ===
                'draft' && (
                <Button
                  disabled={!can('invoices.write') || state.live?.jobStatus !== 'completed'}
                  onClick={actions.issueInvoice}
                  icon={<FileText size={15} />}
                >
                  Issue completed job
                </Button>
              )}
          </>
        }
      />

      {invoiceTarget.id && !invoiceTarget.exists && (
        <MissingInvoiceTarget onClear={invoiceTarget.clear} />
      )}

      <section className="metrics-grid">
        <Metric
          label="Recorded payments"
          value={formatMoney(collected)}
          delta="projected amount paid"
          icon={<Banknote size={18} />}
        />
        <Metric
          label="Open receivables"
          value={formatMoney(outstanding)}
          delta={`${state.invoices.filter((invoice) => invoice.status === 'past_due').length} past due`}
          icon={<ReceiptText size={18} />}
          tone="orange"
        />
        <Metric
          label="Average invoice"
          value={formatMoney(average)}
          delta={`${state.invoices.length} role-visible invoices`}
          icon={<WalletCards size={18} />}
          tone="blue"
        />
        <Metric
          label="Paid invoices"
          value={String(state.invoices.filter((invoice) => invoice.status === 'paid').length)}
          delta="provider-reconciled state"
          icon={<CheckCircle2 size={18} />}
          tone="plum"
        />
      </section>

      {paymentAllocationConflicts.length > 0 && (
        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Verified funds awaiting allocation</h2>
              <p className="section-card__subtitle">
                Collection is held until the owner reconciles the exact provider charge and ledger.
              </p>
            </div>
            <Badge tone="warning">{paymentAllocationConflicts.length} open</Badge>
          </div>
          <div className="approval-list">
            {paymentAllocationConflicts.map((conflict) => {
              const approval = conflict.approvalRequestId
                ? state.approvals.find((candidate) => candidate.id === conflict.approvalRequestId)
                : undefined;
              const note = allocationNotes[conflict.id] ?? '';
              const exactResolution =
                conflict.canApplyExactCurrentBalance &&
                conflict.resolutionAction === 'payment.allocation.apply_exact_current_balance';
              const approvedExactResolution =
                exactResolution &&
                approval?.status === 'approved' &&
                approval.actionType === conflict.resolutionAction &&
                !approval.consumedAt;
              const noteError =
                note.length > 0 && note.trim().length < 5
                  ? 'Record at least 5 characters of reconciliation evidence.'
                  : undefined;
              return (
                <div className="payment-allocation-row" key={conflict.id}>
                  <div className="approval-row">
                    <span>
                      <strong>
                        {conflict.invoiceNumber} · {conflict.conflictCode.replaceAll('_', ' ')}
                      </strong>
                      <small>
                        Provider verified ${conflict.verifiedAmount}; intended $
                        {conflict.intendedAmount}; invoice balance at event $
                        {conflict.invoiceBalanceAtEvent}. PaymentIntent {conflict.providerPaymentId}
                        .
                      </small>
                      <small>{conflict.nextAction}</small>
                    </span>
                    <span>
                      <Badge tone="warning">collection hold</Badge>
                      <Badge tone={exactResolution ? 'info' : 'danger'}>
                        {exactResolution ? 'exact resolver available' : 'manual/provider work only'}
                      </Badge>
                      {conflict.approvalRequestId && (
                        <code>{conflict.approvalRequestId.slice(0, 8)}</code>
                      )}
                    </span>
                  </div>
                  {exactResolution && (
                    <div className="payment-allocation-resolution">
                      {approval?.status !== 'approved' ? (
                        <p>
                          {approval?.status === 'rejected'
                            ? 'The exact allocation approval was rejected. The collection hold remains.'
                            : 'Approve the exact current-balance action before applying provider-verified funds.'}
                        </p>
                      ) : (
                        <>
                          <Field
                            label="Owner reconciliation note"
                            htmlFor={`payment-allocation-note-${conflict.id}`}
                            hint="Record what you verified in Stripe and the invoice ledger. This note is retained with the resolution."
                            error={noteError}
                          >
                            <textarea
                              className="textarea"
                              id={`payment-allocation-note-${conflict.id}`}
                              maxLength={2_000}
                              value={note}
                              onChange={(event) =>
                                setAllocationNotes((current) => ({
                                  ...current,
                                  [conflict.id]: event.target.value,
                                }))
                              }
                            />
                          </Field>
                          <Button
                            disabled={
                              !approvedExactResolution ||
                              !can('payments.manage') ||
                              !state.serverVerifiedAt ||
                              note.trim().length < 5
                            }
                            loading={resolvingConflictId === conflict.id}
                            onClick={() => void resolveExactAllocation(conflict.id)}
                          >
                            Apply verified funds to current invoice
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="page-footer-actions">
            <Link className="button button--secondary button--md" to="/approvals">
              Review high-risk approvals
            </Link>
          </div>
        </Card>
      )}

      <Card className="projection-warning">
        <CircleDollarSign size={18} />
        <div>
          <strong>Invoice issuance is completion-backed</strong>
          <p>
            The finite server command opens one quote-backed invoice only after current job and
            visit versions prove completion. It rechecks accepted estimate lines, quote totals,
            provider-backed deposits, and open incidents; payment success still comes only from
            signed provider reconciliation.
          </p>
        </div>
      </Card>

      <Card className="invoice-card">
        <div className="list-toolbar">
          <div>
            <h2>Invoices</h2>
            <p className="section-card__subtitle">Server totals and optimistic versions</p>
          </div>
          <div className="segmented">
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              All
            </button>
            <button
              type="button"
              aria-pressed={filter === 'open'}
              onClick={() => setFilter('open')}
            >
              Open
            </button>
            <button
              type="button"
              aria-pressed={filter === 'past_due'}
              onClick={() => setFilter('past_due')}
            >
              Past due
            </button>
          </div>
        </div>
        <div className="table-wrap customer-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Total</th>
                <th>Paid</th>
                <th>Balance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleInvoices.map((invoice) => (
                <tr
                  key={invoice.id}
                  ref={invoice.id === invoiceTarget.id ? invoiceTarget.rowRef : undefined}
                  className={invoice.id === invoiceTarget.id ? 'data-table__target' : undefined}
                  tabIndex={invoice.id === invoiceTarget.id ? -1 : undefined}
                  aria-current={invoice.id === invoiceTarget.id ? 'true' : undefined}
                >
                  <td>
                    <strong>{invoice.number}</strong>
                  </td>
                  <td>{invoice.customerName}</td>
                  <td>{invoice.issueDate}</td>
                  <td>{invoice.dueDate}</td>
                  <td>${invoice.total}</td>
                  <td>${invoice.paid}</td>
                  <td>${invoice.balance}</td>
                  <td>
                    <Badge
                      tone={
                        invoice.status === 'paid'
                          ? 'positive'
                          : invoice.status === 'past_due'
                            ? 'danger'
                            : 'info'
                      }
                      dot
                    >
                      {invoice.status.replaceAll('_', ' ')}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {hasManualReconciliation && (
        <Card className="projection-warning">
          <AlertTriangle size={18} />
          <div role="status">
            <strong>
              {hasAcceptedReconciliationExhaustion
                ? 'Post-service SMS delivery needs manual reconciliation'
                : 'Post-service SMS submission needs manual reconciliation'}
            </strong>
            <p>
              {hasAcceptedReconciliationExhaustion
                ? 'Twilio accepted the message, but StoryOps exhausted its delivery-status checks. It is not marked failed or delivered. Reconcile the signed callback or exact provider SID before taking another action.'
                : 'StoryOps cannot confirm whether Twilio accepted the request. No automatic resend is scheduled. Reconcile the signed callback or Twilio account and preserve the exact SID before taking another action.'}
            </p>
          </div>
        </Card>
      )}

      {postServiceInvoice?.status === 'paid' && (
        <Card className="post-payment-card">
          <div>
            <CheckCircle2 size={22} />
            <div>
              <h3>{postServiceInvoice.number} is provider-confirmed and paid</h3>
              <p>
                Actions below are scoped to this invoice and recheck completion, consent, pricing,
                version, and duplicates on the server.
              </p>
            </div>
          </div>
          <div>
            <Button
              variant="secondary"
              disabled={!can('communications.send') || state.reviewRequested}
              onClick={actions.requestReview}
            >
              {postServiceFollowupLabel('Review', reviewStatus, 'Queue review SMS')}
            </Button>
            <Button
              variant="dark"
              disabled={!can('communications.send') || state.referralInvited}
              onClick={actions.inviteReferral}
              icon={<UserRoundPlus size={14} />}
            >
              {postServiceFollowupLabel('Referral', referralStatus, 'Queue referral SMS')}
            </Button>
            <Button
              disabled={!can('campaigns.manage') || state.recurringPlanActive}
              onClick={actions.activateRecurringPlan}
            >
              {state.recurringPlanActive ? 'Plan active' : 'Activate semiannual plan'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
