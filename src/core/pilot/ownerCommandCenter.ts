import { assessCompanyConfiguration } from '@/domain/companyConfiguration';
import type { DemoState, DemoVisit } from '@/state/model';

export interface OwnerActionItem {
  id: string;
  priority: 'P0' | 'P1' | 'P2';
  title: string;
  fact: string;
  recommendation: string;
  blockedBy?: string;
  source: string;
  href: string;
}

export interface OwnerCommandCenterProjection {
  mode: 'sandbox' | 'authenticated';
  sourcedAt: string;
  today: {
    localDate?: string;
    timeZone: string;
    visits: DemoState['visits'];
    evidenceFacts: string[];
  };
  actions: OwnerActionItem[];
  unknowns: string[];
}

export interface VisitClearanceBadge {
  key: 'weather' | 'route';
  label: string;
  tone: 'positive' | 'warning' | 'danger' | 'neutral';
  evidence: 'live' | 'sandbox' | 'unknown';
}

type OwnerProjectionState = Pick<
  DemoState,
  | 'dataMode'
  | 'companyConfiguration'
  | 'operatingBaseline'
  | 'approvals'
  | 'leads'
  | 'estimate'
  | 'visits'
  | 'invoices'
  | 'traces'
  | 'integrations'
  | 'customerQuoteAccepted'
  | 'depositPaid'
  | 'reviewRequested'
  | 'recurringPlanActive'
  | 'recurringDueWork'
  | 'customerPortalRequests'
  | 'outboundWorkers'
  | 'dispatchOriginRetention'
  | 'live'
>;

function liveRouteIsCurrent(visit: DemoVisit): boolean {
  return (
    visit.route.provider === 'vroom' &&
    visit.route.evidenceMode === 'live' &&
    visit.route.freshness === 'current' &&
    typeof visit.route.feasible === 'boolean' &&
    Boolean(visit.route.checkedAt)
  );
}

function liveWeatherIsCurrent(visit: DemoVisit): boolean {
  return (
    visit.weather.provider === 'nws' &&
    visit.weather.evidenceMode === 'live' &&
    visit.weather.freshness === 'current' &&
    Boolean(visit.weather.checkedAt) &&
    Boolean(visit.weather.policyDisposition)
  );
}

export function describeVisitClearance(visit: DemoVisit): VisitClearanceBadge[] {
  const weather: VisitClearanceBadge = liveWeatherIsCurrent(visit)
    ? {
        key: 'weather',
        label:
          visit.weather.policyDisposition === 'eligible'
            ? 'weather eligible'
            : visit.weather.policyDisposition === 'requires_approval'
              ? 'weather needs approval'
              : 'weather unavailable',
        tone:
          visit.weather.policyDisposition === 'eligible'
            ? 'positive'
            : visit.weather.policyDisposition === 'requires_approval'
              ? 'warning'
              : 'danger',
        evidence: 'live',
      }
    : visit.weather.disposition ||
        visit.weather.temperature !== undefined ||
        visit.weather.checkedAt
      ? {
          key: 'weather',
          label:
            visit.weather.disposition === 'hold'
              ? 'sandbox weather hold · not dispatch evidence'
              : 'sandbox weather · not dispatch evidence',
          tone: visit.weather.disposition === 'hold' ? 'warning' : 'neutral',
          evidence: 'sandbox',
        }
      : {
          key: 'weather',
          label: 'weather unknown',
          tone: 'warning',
          evidence: 'unknown',
        };

  const route: VisitClearanceBadge = liveRouteIsCurrent(visit)
    ? {
        key: 'route',
        label: visit.route.feasible ? 'route feasible' : 'route not feasible',
        tone: visit.route.feasible ? 'positive' : 'danger',
        evidence: 'live',
      }
    : visit.route.driveMinutes !== undefined ||
        visit.route.miles !== undefined ||
        visit.route.checkedAt
      ? {
          key: 'route',
          label: 'sandbox route · not dispatch evidence',
          tone: 'neutral',
          evidence: 'sandbox',
        }
      : {
          key: 'route',
          label: 'route unknown',
          tone: 'warning',
          evidence: 'unknown',
        };

  return [weather, route];
}

function localDateKey(value: string, timeZone: string): string | undefined {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(parsed));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  return year && month && day ? `${year}-${month}-${day}` : undefined;
}

export function deriveOwnerCommandCenter(
  state: OwnerProjectionState,
): OwnerCommandCenterProjection {
  const actions: OwnerActionItem[] = [];
  const live = state.dataMode === 'supabase';
  const sourcePrefix = live ? 'Authenticated role-scoped workspace' : 'Synthetic local fixture';
  const timeZone =
    state.live?.companyTimezone ??
    state.companyConfiguration?.published?.territory.timezone ??
    'UTC';
  const localDate = state.live?.serverTime
    ? localDateKey(state.live.serverTime, timeZone)
    : undefined;
  const todayVisits = localDate
    ? state.visits.filter((visit) => {
        const exactStart = state.live?.fieldVisitReferences?.[visit.id]?.visitStartsAt;
        return exactStart
          ? localDateKey(exactStart, timeZone) === localDate
          : !live && visit.date === localDate;
      })
    : [];
  const todayEvidenceFacts: string[] = [];
  const visitEvidenceUnknowns: string[] = [];
  for (const visit of todayVisits) {
    const clearance = describeVisitClearance(visit);
    const routeBadge = clearance.find((badge) => badge.key === 'route');
    const weatherBadge = clearance.find((badge) => badge.key === 'weather');
    if (routeBadge?.evidence === 'live') {
      todayEvidenceFacts.push(
        `${visit.jobNumber} route is ${visit.route.feasible ? 'feasible' : 'not feasible'} from current VROOM evidence checked ${visit.route.checkedAt}${
          visit.route.driveMinutes === undefined
            ? '.'
            : `; drive time is ${visit.route.driveMinutes} minutes.`
        }`,
      );
    } else if (routeBadge?.evidence === 'sandbox') {
      visitEvidenceUnknowns.push(
        `${visit.jobNumber} route is a sandbox scenario only; current live VROOM evidence is required before dispatch.`,
      );
    } else {
      visitEvidenceUnknowns.push(
        `${visit.jobNumber} route and travel time are unknown until current live VROOM evidence is bound to the visit.`,
      );
    }

    if (weatherBadge?.evidence === 'live') {
      todayEvidenceFacts.push(
        `${visit.jobNumber} weather is ${visit.weather.policyDisposition?.replaceAll('_', ' ')} under current NWS policy evidence checked ${visit.weather.checkedAt}.`,
      );
    } else if (weatherBadge?.evidence === 'sandbox') {
      visitEvidenceUnknowns.push(
        `${visit.jobNumber} weather is a sandbox scenario only; current live NWS policy evidence is required before dispatch.`,
      );
    } else {
      visitEvidenceUnknowns.push(
        `${visit.jobNumber} service-window weather is unknown until current live NWS policy evidence is bound to the visit.`,
      );
    }
  }
  if (
    live &&
    localDate &&
    state.visits.some((visit) => !state.live?.fieldVisitReferences?.[visit.id]?.visitStartsAt)
  ) {
    visitEvidenceUnknowns.push(
      'At least one role-visible visit lacks an exact server-projected start, so its company-local today status is unknown.',
    );
  }

  if (!state.companyConfiguration) {
    actions.push({
      id: 'configuration-missing',
      priority: 'P0',
      title: 'Complete the owner configuration',
      fact: 'No versioned company configuration record is visible.',
      recommendation:
        'Record identity, territory, hours, people, resources, materials/SDS, payments, policies, engagement, and provider controls.',
      blockedBy: 'No reviewed configuration draft',
      source: `${sourcePrefix} · company configuration projection`,
      href: '/setup',
    });
  } else if (state.companyConfiguration.status !== 'published') {
    const readiness = assessCompanyConfiguration(
      state.companyConfiguration.draft,
      live ? 'live' : 'sandbox',
    );
    actions.push({
      id: 'configuration-unpublished',
      priority: 'P0',
      title: 'Review configuration revision',
      fact: `Revision ${state.companyConfiguration.revision} is ${state.companyConfiguration.status}; readiness is ${readiness.score}%.`,
      recommendation:
        readiness.blockedSections.length > 0
          ? `Resolve blocked sections: ${readiness.blockedSections.join(', ')}.`
          : `Attach review evidence and publish the exact ${live ? 'live' : 'sandbox'} snapshot.`,
      blockedBy:
        readiness.blockedSections.length > 0
          ? `${readiness.issues.filter((issue) => issue.severity === 'blocking').length} blocking validation issue(s)`
          : 'Explicit owner publication',
      source: `${sourcePrefix} · company configuration revision ${state.companyConfiguration.revision}`,
      href: '/setup',
    });
  } else if (
    live &&
    (state.operatingBaseline?.configurationRevision !== state.companyConfiguration.revision ||
      state.operatingBaseline.configurationHash !==
        state.companyConfiguration.publicationReceipt?.configurationHash)
  ) {
    actions.push({
      id: 'operating-baseline-unpublished',
      priority: 'P0',
      title: 'Publish the reviewed operating baseline',
      fact: `Configuration revision ${state.companyConfiguration.revision} is immutable but does not drive the active operating records.`,
      recommendation:
        'Execute the separate owner activation to materialize the exact price book, packages, terms, retention, and resources.',
      blockedBy: 'Explicit owner operating-baseline publication',
      source: `${sourcePrefix} · company configuration and operating-baseline receipts`,
      href: '/setup',
    });
  }

  const pendingApprovals = state.approvals.filter((approval) => approval.status === 'pending');
  if (pendingApprovals.length > 0) {
    actions.push({
      id: 'pending-approvals',
      priority: 'P1',
      title: 'Review held actions',
      fact: `${pendingApprovals.length} exact-payload approval${pendingApprovals.length === 1 ? ' is' : 's are'} pending.`,
      recommendation: 'Approve or reject each exact payload; do not approve from a summary alone.',
      blockedBy: 'Owner decision',
      source: `${sourcePrefix} · approval records`,
      href: '/approvals',
    });
  }

  if (
    ['draft', 'ready'].includes(state.estimate.status) ||
    !state.estimate.photoEvidence.humanVerified
  ) {
    actions.push({
      id: 'estimate-evidence',
      priority: 'P1',
      title: 'Finish estimate evidence',
      fact: `${state.estimate.estimateNumber} is ${state.estimate.status}; photo evidence is ${
        state.estimate.photoEvidence.humanVerified ? 'human verified' : 'not human verified'
      }.`,
      recommendation:
        'Resolve measurement, access, risk, and photo unknowns, then run deterministic policy.',
      blockedBy: state.estimate.photoEvidence.humanVerified
        ? 'Deterministic policy check'
        : 'Human scope verification',
      source: `${sourcePrefix} · estimate and photo-evidence projection`,
      href: `/estimates/${state.estimate.id}`,
    });
  } else if (state.estimate.status === 'approved') {
    actions.push({
      id: 'approved-quote-draft',
      priority: 'P1',
      title: 'Publish the approved quote',
      fact: `${state.estimate.estimateNumber} is within policy but has not entered the quote-awaiting-customer stage.`,
      recommendation:
        'Review the exact customer preview, publish it to the portal, then record each delivery attempt separately.',
      blockedBy: 'Explicit quote publication',
      source: `${sourcePrefix} · estimate and quote projection`,
      href: `/estimates/${state.estimate.id}`,
    });
  } else if (state.estimate.status === 'quoted' && !state.customerQuoteAccepted) {
    actions.push({
      id: 'quote-awaiting-customer',
      priority: 'P2',
      title: 'Quote awaits customer action',
      fact: `${state.estimate.estimateNumber} is published; no authenticated acceptance is projected.`,
      recommendation:
        'Inspect delivery/reconciliation evidence and follow up only through a currently consented channel.',
      source: `${sourcePrefix} · quote acceptance and communication projection`,
      href: '/portal',
    });
  }

  if (state.customerQuoteAccepted && !state.depositPaid) {
    actions.push({
      id: 'deposit-awaiting-reconciliation',
      priority: 'P0',
      title: 'Deposit is not proven',
      fact: 'The quote is accepted, but no reconciled provider payment is projected.',
      recommendation:
        'Reconcile the provider record; do not confirm a visit from a checkout redirect or pending event.',
      blockedBy: 'Signed provider payment evidence',
      source: `${sourcePrefix} · quote acceptance and payment projection`,
      href: '/finance',
    });
  }

  const paymentHolds = (state.live?.paymentAllocationConflicts ?? []).filter(
    (conflict) => conflict.status === 'open',
  );
  if (paymentHolds.length > 0) {
    const first = paymentHolds[0]!;
    actions.push({
      id: 'payment-allocation-holds',
      priority: 'P0',
      title: 'Verified funds are on collection hold',
      fact: `${paymentHolds.length} open allocation conflict${
        paymentHolds.length === 1 ? '' : 's'
      } ${paymentHolds.length === 1 ? 'has' : 'have'} provider-verified funds that are not applied to the ledger.`,
      recommendation: first.nextAction,
      blockedBy: first.canApplyExactCurrentBalance
        ? 'Exact owner current-balance resolver'
        : 'Manual provider or accounting work',
      source: `${sourcePrefix} · payment allocation conflicts`,
      href: '/finance',
    });
  }

  const newLeads = state.leads.filter((lead) => lead.stage === 'new');
  if (newLeads.length > 0) {
    actions.push({
      id: 'new-leads',
      priority: 'P1',
      title: 'Qualify new leads',
      fact: `${newLeads.length} role-visible lead${newLeads.length === 1 ? ' is' : 's are'} still new.`,
      recommendation:
        'Verify contact, consent, property, service scope, and unknowns before estimating.',
      source: `${sourcePrefix} · lead stage projection`,
      href: '/pipeline',
    });
  }

  const quoteChangeRequests =
    state.live?.customerQuoteChangeRequests?.filter((request) =>
      ['submitted', 'reviewing'].includes(request.status),
    ) ?? [];
  if (quoteChangeRequests.length > 0) {
    const first = quoteChangeRequests[0]!;
    actions.push({
      id: 'quote-change-requests',
      priority: 'P1',
      title: 'Customers requested quote changes',
      fact: `${quoteChangeRequests.length} quote-change request${
        quoteChangeRequests.length === 1 ? ' is' : 's are'
      } still ${quoteChangeRequests.length === 1 ? first.status : 'open'}.`,
      recommendation: first.nextAction,
      blockedBy: 'Owner review of the exact requested codes against the current quote version',
      source: `${sourcePrefix} · customer quote-change requests`,
      href: `/estimates/${state.estimate.id}`,
    });
  }

  const portalRequests = state.customerPortalRequests.filter((request) =>
    ['submitted', 'reviewing'].includes(request.status),
  );
  if (portalRequests.length > 0) {
    actions.push({
      id: 'customer-portal-requests',
      priority: 'P1',
      title: 'Customer portal requests need review',
      fact: `${portalRequests.length} reschedule or additional-service request${
        portalRequests.length === 1 ? ' is' : 's are'
      } still open.`,
      recommendation:
        'Review the exact customer request. Do not treat a portal note as booking, payment, or schedule evidence.',
      blockedBy: 'Staff review of the submitted request',
      source: `${sourcePrefix} · customer portal requests`,
      href: '/portal',
    });
  }

  const weatherHolds = state.visits.filter((visit) => visit.status === 'weather_hold');
  if (weatherHolds.length > 0) {
    actions.push({
      id: 'weather-held-visits',
      priority: 'P0',
      title: 'Visits are on weather hold',
      fact: `${weatherHolds.length} role-visible visit${weatherHolds.length === 1 ? ' is' : 's are'} blocked by the current visit state.`,
      recommendation:
        'Review fresh NWS, route, capacity, and customer-reschedule evidence before proposing a new window.',
      blockedBy: 'Fresh service-window evidence and dispatcher decision',
      source: `${sourcePrefix} · visit status projection`,
      href: '/dispatch',
    });
  }

  const pausedFieldVisits = state.visits.filter((visit) => visit.status === 'paused');
  if (pausedFieldVisits.length > 0) {
    actions.push({
      id: 'field-evidence-blocked',
      priority: 'P0',
      title: 'Field work is paused',
      fact: `${pausedFieldVisits.length} visit${pausedFieldVisits.length === 1 ? ' is' : 's are'} paused and cannot be completed.`,
      recommendation:
        'Open the field packet and resolve checklist, media, signature, material/SDS, notes, or incident blockers.',
      blockedBy: 'Durably reconciled completion evidence',
      source: `${sourcePrefix} · visit and field packet projection`,
      href: '/field',
    });
  }

  const pastDue = state.invoices.filter((invoice) => invoice.status === 'past_due');
  if (pastDue.length > 0) {
    actions.push({
      id: 'past-due-invoices',
      priority: 'P1',
      title: 'Review past-due invoices',
      fact: `${pastDue.length} role-visible invoice${pastDue.length === 1 ? ' is' : 's are'} past due.`,
      recommendation:
        'Reconcile payment state before an approved reminder; never infer settlement.',
      source: `${sourcePrefix} · invoice status projection`,
      href: '/finance',
    });
  }

  const reconciliationStates = [
    state.live?.postServiceReviewStatus,
    state.live?.postServiceReferralStatus,
  ].filter((status) => ['submitted_unknown', 'reconciliation_required'].includes(status ?? ''));
  if (reconciliationStates.length > 0) {
    actions.push({
      id: 'provider-reconciliation',
      priority: 'P0',
      title: 'Provider submissions need reconciliation',
      fact: `${reconciliationStates.length} post-service submission${reconciliationStates.length === 1 ? ' has' : 's have'} an unknown or exhausted delivery outcome.`,
      recommendation:
        'Read the authoritative provider state; never resend while the original submission may have succeeded.',
      blockedBy: 'Provider retrieval or signed callback evidence',
      source: `${sourcePrefix} · post-service provider reconciliation projection`,
      href: '/integrations',
    });
  }

  const paidInvoices = state.invoices.filter((invoice) => invoice.status === 'paid');
  if (paidInvoices.length > 0 && !state.reviewRequested) {
    actions.push({
      id: 'review-opportunity',
      priority: 'P2',
      title: 'Review opportunity is eligible',
      fact: `${paidInvoices.length} role-visible invoice${paidInvoices.length === 1 ? ' is' : 's are'} paid; no review request is projected.`,
      recommendation:
        'Verify current consent and job eligibility, then queue one idempotent request without claiming delivery.',
      source: `${sourcePrefix} · paid invoice and follow-up projection`,
      href: '/finance',
    });
  }

  if (paidInvoices.length > 0 && !state.recurringPlanActive) {
    actions.push({
      id: 'maintenance-opportunity',
      priority: 'P2',
      title: 'Maintenance follow-up is available',
      fact: 'Completed paid work exists, but no active source-linked maintenance plan is projected.',
      recommendation:
        'Offer a reviewed cadence; each future visit still requires a fresh estimate and booking evidence.',
      source: `${sourcePrefix} · invoice and recurring-maintenance projection`,
      href: '/finance',
    });
  }

  const duePlans = state.recurringDueWork?.plans.filter((plan) => plan.dueNow) ?? [];
  const estimateTasks =
    state.recurringDueWork?.workItems.filter((item) => item.status === 'fresh_estimate_required') ??
    [];
  if (duePlans.length > 0) {
    actions.push({
      id: 'recurring-due-generation',
      priority: 'P1',
      title: 'Recurring maintenance is due',
      fact: `${duePlans.length} active maintenance plan${duePlans.length === 1 ? ' is' : 's are'} due for a fresh-estimate work item.`,
      recommendation:
        'Create one idempotent due-work item. Do not reuse the historical price or contact the customer yet.',
      blockedBy: 'Current measurements and a new deterministic estimate',
      source: `${sourcePrefix} · recurring due-work projection`,
      href: '/operations',
    });
  }
  if (estimateTasks.length > 0) {
    actions.push({
      id: 'recurring-fresh-estimate-queue',
      priority: 'P1',
      title: 'Fresh maintenance estimates need preparation',
      fact: `${estimateTasks.length} due-work item${estimateTasks.length === 1 ? ' requires' : 's require'} current scope and deterministic pricing.`,
      recommendation:
        'Capture current measurements and create a new estimate; quote acceptance, deposit, scheduling evidence, and job.book remain separate gates.',
      blockedBy: 'Current scope evidence',
      source: `${sourcePrefix} · recurring fresh-estimate work queue`,
      href: '/estimates/new',
    });
  }

  const blockedAiActions = state.traces.filter((trace) => trace.result === 'blocked');
  if (blockedAiActions.length > 0) {
    actions.push({
      id: 'ai-blocked-actions',
      priority: 'P2',
      title: 'Inspect blocked AI actions',
      fact: `${blockedAiActions.length} role-visible trace${blockedAiActions.length === 1 ? ' is' : 's are'} blocked by guardrails or policy.`,
      recommendation:
        'Inspect source facts and policy results; create a clean human action rather than bypassing the guardrail.',
      source: `${sourcePrefix} · AI trace projection`,
      href: '/office',
    });
  }

  const unhealthy = state.integrations.filter((integration) => integration.status !== 'Healthy');
  if (unhealthy.length > 0) {
    actions.push({
      id: 'integration-readiness',
      priority: 'P2',
      title: 'Resolve provider readiness',
      fact: `${unhealthy.length} integration record${unhealthy.length === 1 ? ' is' : 's are'} not healthy.`,
      recommendation:
        'Check secret-safe health evidence, callback validation, environment switch, and owner switch.',
      blockedBy: 'Provider health or activation evidence',
      source: `${sourcePrefix} · integration health projection`,
      href: '/integrations',
    });
  }

  if (state.outboundWorkers?.status === 'blocked') {
    const blockedWorkers = state.outboundWorkers.workers.filter(
      (worker) => worker.status === 'blocked',
    );
    actions.push({
      id: 'private-workers-blocked',
      priority: 'P0',
      title: 'Private scheduled workers are blocked',
      fact:
        blockedWorkers.length > 0
          ? `${blockedWorkers.length} of ${state.outboundWorkers.workers.length} private workers are blocked: ${blockedWorkers
              .map((worker) => worker.worker.replaceAll('_', ' '))
              .join(', ')}.`
          : 'The private-worker readiness projection is blocked.',
      recommendation:
        'Read the exact worker credential, heartbeat, scheduler, and queue evidence. Do not resend while a submission may have succeeded.',
      blockedBy: 'Current private-worker readiness evidence',
      source: `${sourcePrefix} · private scheduled worker projection`,
      href: '/integrations',
    });
  }

  if (state.dispatchOriginRetention?.p0ReleaseCheck === 'blocked') {
    actions.push({
      id: 'dispatch-origin-retention',
      priority: 'P0',
      title: 'Departure-location retention is launch-blocked',
      fact: 'The five-second purge-worker P0 check is blocked; launch and departure remain unproven.',
      recommendation:
        'Verify scheduler-owned purge success, exact ACLs, and stale-row counts on Integrations. Manual cleanup is not health proof.',
      blockedBy: 'Scheduler-owned dispatch-origin retention evidence',
      source: `${sourcePrefix} · dispatch-origin retention projection`,
      href: '/integrations',
    });
  }

  actions.sort(
    (left, right) => left.priority.localeCompare(right.priority) || left.id.localeCompare(right.id),
  );
  return {
    mode: live ? 'authenticated' : 'sandbox',
    sourcedAt: live ? (state.live?.serverTime ?? 'server time unavailable') : 'fixed local fixture',
    today: {
      localDate,
      timeZone,
      visits: todayVisits,
      evidenceFacts: todayEvidenceFacts,
    },
    actions,
    unknowns: [
      ...visitEvidenceUnknowns,
      'Provider-side payment and delivery state are unknown until signed reconciliation succeeds.',
      ...(state.companyConfiguration?.status === 'published'
        ? live && !state.operatingBaseline
          ? [
              'Published configuration is inert until the separate operating-baseline receipt exists.',
            ]
          : []
        : ['Operating-record readiness is unknown until configuration publication completes.']),
      ...(live
        ? [
            'An operating-baseline receipt activates reviewed prices, terms, retention, and resources; it is not live-pilot authorization. The pilot-readiness gates and external reviews still control customer use.',
          ]
        : []),
    ],
  };
}
