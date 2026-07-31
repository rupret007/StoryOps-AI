import Decimal from 'decimal.js';
import { z } from 'zod';

const unsignedDecimalString = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u);
const signedDecimalString = z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u);
const count = z.number().int().nonnegative();
const sourceIds = z.array(z.string().uuid()).max(100);

export const liveProfitabilityKpisSchema = z
  .object({
    schemaVersion: z.literal('storyops-profitability-kpis-v1'),
    companyId: z.string().uuid(),
    currency: z.literal('USD'),
    asOf: z.string().datetime({ offset: true }),
    period: z
      .object({
        kind: z.literal('all_recorded_history'),
        startsAt: z.null(),
        endsAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    scope: z
      .object({
        jobStatuses: z.tuple([z.literal('completed'), z.literal('invoiced')]),
        recognizedInvoiceStatuses: z.tuple([
          z.literal('open'),
          z.literal('paid'),
          z.literal('past_due'),
          z.literal('uncollectible'),
        ]),
        revenueBasis: z.literal('invoice_subtotal_excluding_tax'),
        estimatedCostBasis: z.literal('job_estimated_cost_snapshot'),
        actualCostBasis: z.literal('explicit_verified_job_actual_cost_snapshot'),
        paymentBasis: z.literal('invoice_ledger_and_exact_processed_provider_evidence'),
      })
      .strict(),
    jobs: z
      .object({
        eligibleCount: count,
        completedCount: count,
        invoicedStatusCount: count,
        profitabilityCount: count,
        withoutRecognizedInvoiceCount: count,
      })
      .strict(),
    revenue: z
      .object({
        invoicedSubtotal: unsignedDecimalString,
        invoicedTax: unsignedDecimalString,
        invoicedTotal: unsignedDecimalString,
      })
      .strict(),
    costs: z
      .object({
        estimatedEligibleJobs: unsignedDecimalString,
        estimatedInvoicedJobs: unsignedDecimalString,
        recordedActualMaterial: unsignedDecimalString.nullable(),
        recordedActualLabor: unsignedDecimalString.nullable(),
        recordedActualOtherDirect: unsignedDecimalString.nullable(),
        actualTotal: unsignedDecimalString.nullable(),
        latestActualCostAsOf: z.string().datetime({ offset: true }).nullable(),
      })
      .strict(),
    profitability: z
      .object({
        estimatedGrossProfit: signedDecimalString.nullable(),
        estimatedGrossMarginPercent: signedDecimalString.nullable(),
        actualGrossProfit: signedDecimalString.nullable(),
        actualGrossMarginPercent: signedDecimalString.nullable(),
      })
      .strict(),
    receivables: z
      .object({
        recordedPaid: unsignedDecimalString,
        providerVerifiedPaid: unsignedDecimalString,
        openBalance: unsignedDecimalString,
        pastDueBalance: unsignedDecimalString,
        uncollectibleBalance: unsignedDecimalString,
        pendingPaymentAmount: unsignedDecimalString,
        pendingRefundAmount: unsignedDecimalString,
        openInvoiceCount: count,
        pastDueInvoiceCount: count,
        paidInvoiceCount: count,
        uncollectibleInvoiceCount: count,
      })
      .strict(),
    completeness: z
      .object({
        complete: z.boolean(),
        method: z.literal('exact_server_numeric_aggregates'),
        invoiceLedgerComplete: z.boolean(),
        paymentEvidenceComplete: z.boolean(),
        paymentEvidenceGapCount: count,
        sourceIdListComplete: z.boolean(),
        actualCosts: z
          .object({
            complete: z.boolean(),
            snapshotCount: count,
            materialAvailableCount: count,
            materialCompleteCount: count,
            laborAvailableCount: count,
            laborCompleteCount: count,
            otherDirectAvailableCount: count,
            otherDirectCompleteCount: count,
            completeJobCount: count,
            requiredJobCount: count,
          })
          .strict(),
        unknowns: z.array(z.string().min(1).max(1_000)).max(20),
      })
      .strict(),
    evidence: z
      .object({
        sourceIds: z
          .object({
            jobIds: sourceIds,
            invoiceIds: sourceIds,
            costSnapshotIds: sourceIds,
            paymentIds: sourceIds,
            providerEventIds: sourceIds,
          })
          .strict(),
        sourceCounts: z
          .object({
            jobs: count,
            invoices: count,
            costSnapshots: count,
            payments: count,
            providerEvents: count,
          })
          .strict(),
        sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  })
  .strict();

export type LiveProfitabilityKpis = z.infer<typeof liveProfitabilityKpisSchema>;

export function formatCurrencyDecimal(
  value: string | null,
  currency: LiveProfitabilityKpis['currency'] = 'USD',
): string {
  if (value === null) return 'Unavailable';
  const fixed = new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  const negative = fixed.startsWith('-');
  const [whole = '0', fraction = '00'] = (negative ? fixed.slice(1) : fixed).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const amount = `${grouped}.${fraction}`;
  return currency === 'USD'
    ? `${negative ? '-' : ''}$${amount}`
    : `${negative ? '-' : ''}${currency} ${amount}`;
}

export function formatPercentDecimal(value: string | null): string {
  if (value === null) return 'Unavailable';
  return `${new Decimal(value).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1)}%`;
}

export function actualCostCoverage(kpis: LiveProfitabilityKpis): string {
  const actual = kpis.completeness.actualCosts;
  if (actual.requiredJobCount === 0) return 'No recognized job invoices';
  return `${actual.completeJobCount}/${actual.requiredJobCount} invoiced jobs cost-complete`;
}

export function sourceIdSummary(kpis: LiveProfitabilityKpis): string {
  const counts = kpis.evidence.sourceCounts;
  return `${counts.jobs} jobs · ${counts.invoices} invoices · ${counts.costSnapshots} cost snapshots · ${counts.payments} payment records · ${counts.providerEvents} provider events`;
}
