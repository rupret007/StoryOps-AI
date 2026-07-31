import type { LiveProfitabilityKpis } from '@/core/finance/profitability';

export function makeLiveProfitabilityKpis(
  companyId: string,
  options: { complete?: boolean } = {},
): LiveProfitabilityKpis {
  const complete = options.complete ?? true;
  const asOf = '2026-07-28T12:00:00.000Z';
  return {
    schemaVersion: 'storyops-profitability-kpis-v1',
    companyId,
    currency: 'USD',
    asOf,
    period: {
      kind: 'all_recorded_history',
      startsAt: null,
      endsAt: asOf,
    },
    scope: {
      jobStatuses: ['completed', 'invoiced'],
      recognizedInvoiceStatuses: ['open', 'paid', 'past_due', 'uncollectible'],
      revenueBasis: 'invoice_subtotal_excluding_tax',
      estimatedCostBasis: 'job_estimated_cost_snapshot',
      actualCostBasis: 'explicit_verified_job_actual_cost_snapshot',
      paymentBasis: 'invoice_ledger_and_exact_processed_provider_evidence',
    },
    jobs: {
      eligibleCount: 1,
      completedCount: 0,
      invoicedStatusCount: 1,
      profitabilityCount: 1,
      withoutRecognizedInvoiceCount: 0,
    },
    revenue: {
      invoicedSubtotal: '487.76',
      invoicedTax: '40.24',
      invoicedTotal: '528.00',
    },
    costs: {
      estimatedEligibleJobs: '188.51',
      estimatedInvoicedJobs: '188.51',
      recordedActualMaterial: '50.00',
      recordedActualLabor: complete ? '80.00' : null,
      recordedActualOtherDirect: '5.00',
      actualTotal: complete ? '135.00' : null,
      latestActualCostAsOf: asOf,
    },
    profitability: {
      estimatedGrossProfit: '299.25',
      estimatedGrossMarginPercent: '61.3527',
      actualGrossProfit: complete ? '352.76' : null,
      actualGrossMarginPercent: complete ? '72.3225' : null,
    },
    receivables: {
      recordedPaid: '132.00',
      providerVerifiedPaid: '132.00',
      openBalance: '396.00',
      pastDueBalance: '0.00',
      uncollectibleBalance: '0.00',
      pendingPaymentAmount: '0.00',
      pendingRefundAmount: '0.00',
      openInvoiceCount: 1,
      pastDueInvoiceCount: 0,
      paidInvoiceCount: 0,
      uncollectibleInvoiceCount: 0,
    },
    completeness: {
      complete,
      method: 'exact_server_numeric_aggregates',
      invoiceLedgerComplete: true,
      paymentEvidenceComplete: true,
      paymentEvidenceGapCount: 0,
      sourceIdListComplete: true,
      actualCosts: {
        complete,
        snapshotCount: 1,
        materialAvailableCount: 1,
        materialCompleteCount: 1,
        laborAvailableCount: complete ? 1 : 0,
        laborCompleteCount: complete ? 1 : 0,
        otherDirectAvailableCount: 1,
        otherDirectCompleteCount: 1,
        completeJobCount: complete ? 1 : 0,
        requiredJobCount: 1,
      },
      unknowns: complete
        ? []
        : [
            'Actual labor cost is incomplete for 1 invoiced job(s); no labor cost is inferred from time entries.',
          ],
    },
    evidence: {
      sourceIds: {
        jobIds: ['77777777-7777-4777-8777-777777777777'],
        invoiceIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        costSnapshotIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
        paymentIds: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
        providerEventIds: ['ffffffff-ffff-4fff-8fff-ffffffffffff'],
      },
      sourceCounts: {
        jobs: 1,
        invoices: 1,
        costSnapshots: 1,
        payments: 1,
        providerEvents: 1,
      },
      sourceFingerprint: 'a'.repeat(64),
    },
  };
}
